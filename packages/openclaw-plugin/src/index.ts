/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { readFile, mkdir, appendFile, writeFile } from "node:fs/promises";
import {
  resolveReductionPasses as resolveLayerReductionPasses,
  runReductionBeforeCall as runLayerReductionBeforeCall,
  runReductionAfterCall as runLayerReductionAfterCall,
} from "../../layers/execution/src/composer/reduction/pipeline.ts";
import type { ContextSegment, RuntimeTurnContext, RuntimeTurnResult } from "../../kernel/src/types.ts";
import {
  prependTextToContent,
  type RootPromptRewrite,
  rewriteRootPromptForStablePrefix,
} from "./root-prompt-stabilizer.js";

type EcoClawPluginConfig = {
  enabled?: boolean;
  logLevel?: "info" | "debug";
  proxyBaseUrl?: string;
  proxyApiKey?: string;
  stateDir?: string;
  debugTapProviderTraffic?: boolean;
  debugTapPath?: string;
  proxyAutostart?: boolean;
  proxyPort?: number;
  modules?: {
    stabilizer?: boolean;
    policy?: boolean;
    reduction?: boolean;
    compaction?: boolean;
    eviction?: boolean;
    decisionLedger?: boolean;
  };
  compaction?: {
    enabled?: boolean;
    autoForkOnPolicy?: boolean;
    summaryGenerationMode?: "llm_full_context" | "heuristic";
    summaryFallbackToHeuristic?: boolean;
    summaryMaxOutputTokens?: number;
    includeAssistantReply?: boolean;
    summaryPrompt?: string;
    summaryPromptPath?: string;
    resumePrefixPrompt?: string;
    resumePrefixPromptPath?: string;
    compactionCooldownTurns?: number;
    turnLocalCompaction?: {
      enabled?: boolean;
      archiveDir?: string;
    };
  };
  handoff?: {
    enabled?: boolean;
    handoffGenerationMode?: "llm_full_context" | "heuristic";
    handoffFallbackToHeuristic?: boolean;
    handoffMaxOutputTokens?: number;
    includeAssistantReply?: boolean;
    handoffPrompt?: string;
    handoffPromptPath?: string;
    handoffCooldownTurns?: number;
  };
  eviction?: {
    enabled?: boolean;
    policy?: "noop" | "lru" | "lfu" | "gdsf" | "model_scored";
    maxCandidateBlocks?: number;
    minBlockChars?: number;
  };
  semanticReduction?: {
    enabled?: boolean;
    pythonBin?: string;
    timeoutMs?: number;
    llmlinguaModelPath?: string;
    targetRatio?: number;
    minInputChars?: number;
    minSavedChars?: number;
    preselectRatio?: number;
    maxChunkChars?: number;
    embedding?: {
      provider?: "local" | "api" | "none";
      modelPath?: string;
      apiBaseUrl?: string;
      apiKey?: string;
      apiModel?: string;
      requestTimeoutMs?: number;
    };
  };
  reduction?: {
    engine?: "layered";
    triggerMinChars?: number;
    maxToolChars?: number;
  };
};

type PluginLogger = {
  info?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type SessionTaskBinding = {
  taskId: string;
  sessionSeq: number;
};

type SessionTopologyManager = {
  getLogicalSessionId(sessionKey: string, upstreamSessionId?: string): string;
  getStatus(sessionKey: string): string;
  listTaskCaches(sessionKey: string): string;
  newTaskCache(sessionKey: string, taskId?: string): string;
  newSession(sessionKey: string): string;
  bindUpstreamSession(sessionKey: string, upstreamSessionId?: string): void;
  getUpstreamSessionId(sessionKey: string): string | null;
  deleteTaskCache(sessionKey: string, taskId?: string): {
    removedTaskId: string;
    removedBindings: number;
    switchedToLogical: string;
  } | null;
};

type RecentTurnBinding = {
  userMessage: string;
  matchKey: string;
  sessionKey: string;
  upstreamSessionId?: string;
  at: number;
};

function safeId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const norm = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return norm || "main";
}

function buildLogicalSessionId(taskId: string, sessionSeq: number): string {
  return `ecoclaw-task-${safeId(taskId)}-s${Math.max(1, sessionSeq)}`;
}

function createSessionTopologyManager(): SessionTopologyManager {
  const bindingBySessionKey = new Map<string, SessionTaskBinding>();
  const countersByTaskId = new Map<string, number>();
  const upstreamSessionIdBySessionKey = new Map<string, string>();
  let globalDefaultTaskId: string | null = null;

  function scopedFamilyPrefix(sessionKey: string): string | null {
    const key = (sessionKey || "").trim();
    if (!key.startsWith("scoped:")) return null;
    const parts = key.split(":");
    if (parts.length < 3) return null;
    return `${parts[0]}:${parts[1]}:${parts[2]}`;
  }

  function ensure(sessionKey: string, preferredTaskId?: string): SessionTaskBinding {
    const key = sessionKey || "unknown";
    const existing = bindingBySessionKey.get(key);
    if (existing) return existing;
    const defaultTaskId = safeId(preferredTaskId ?? globalDefaultTaskId ?? `default-${safeId(key)}`);
    const initialSeq = 1;
    const init: SessionTaskBinding = { taskId: defaultTaskId, sessionSeq: initialSeq };
    bindingBySessionKey.set(key, init);
    countersByTaskId.set(defaultTaskId, Math.max(countersByTaskId.get(defaultTaskId) ?? 0, initialSeq));
    return init;
  }

  return {
    getLogicalSessionId(sessionKey: string, upstreamSessionId?: string): string {
      const b = ensure(sessionKey);
      const base = buildLogicalSessionId(b.taskId, b.sessionSeq);
      const upstream = String(
        upstreamSessionId ?? upstreamSessionIdBySessionKey.get(sessionKey) ?? "",
      ).trim();
      if (!upstream) return base;
      return `${base}__oc_${safeId(upstream)}`;
    },
    getStatus(sessionKey: string): string {
      const b = ensure(sessionKey);
      const base = buildLogicalSessionId(b.taskId, b.sessionSeq);
      const upstream = upstreamSessionIdBySessionKey.get(sessionKey) ?? "-";
      return `sessionKey=${sessionKey} task=${b.taskId} logical=${base} seq=${b.sessionSeq} openclawSessionId=${upstream}`;
    },
    listTaskCaches(sessionKey: string): string {
      const current = ensure(sessionKey);
      const taskIds = new Set<string>();
      for (const binding of bindingBySessionKey.values()) taskIds.add(binding.taskId);
      for (const taskId of countersByTaskId.keys()) taskIds.add(taskId);
      const sorted = Array.from(taskIds).sort((a, b) => a.localeCompare(b));
      if (sorted.length === 0) {
        return `No task-cache found.\n${this.getStatus(sessionKey)}`;
      }
      const lines = ["Task-caches:"];
      for (const taskId of sorted) {
        const seqMax = Math.max(1, countersByTaskId.get(taskId) ?? 1);
        const activeBindings = Array.from(bindingBySessionKey.values()).filter((b) => b.taskId === taskId).length;
        const mark = taskId === current.taskId ? "*" : " ";
        lines.push(`${mark} ${taskId} (sessions<=${seqMax}, bindings=${activeBindings})`);
      }
      lines.push("", `current: ${current.taskId} -> ${buildLogicalSessionId(current.taskId, current.sessionSeq)}`);
      return lines.join("\n");
    },
    newTaskCache(sessionKey: string, taskId?: string): string {
      const chosenTaskId = safeId(taskId ?? `task-${Date.now()}`);
      const seq = 1;
      countersByTaskId.set(chosenTaskId, Math.max(countersByTaskId.get(chosenTaskId) ?? 0, seq));
      globalDefaultTaskId = chosenTaskId;
      bindingBySessionKey.set(sessionKey, { taskId: chosenTaskId, sessionSeq: seq });
      const family = scopedFamilyPrefix(sessionKey);
      if (family) {
        for (const [key] of bindingBySessionKey.entries()) {
          if (key === sessionKey) continue;
          if (key === family || key.startsWith(`${family}:`)) {
            bindingBySessionKey.set(key, { taskId: chosenTaskId, sessionSeq: seq });
          }
        }
      }
      return buildLogicalSessionId(chosenTaskId, seq);
    },
    newSession(sessionKey: string): string {
      const current = ensure(sessionKey);
      const next = (countersByTaskId.get(current.taskId) ?? current.sessionSeq) + 1;
      countersByTaskId.set(current.taskId, next);
      const updated: SessionTaskBinding = { taskId: current.taskId, sessionSeq: next };
      bindingBySessionKey.set(sessionKey, updated);
      const family = scopedFamilyPrefix(sessionKey);
      if (family) {
        for (const [key, binding] of bindingBySessionKey.entries()) {
          if (key === sessionKey) continue;
          if (binding.taskId !== current.taskId) continue;
          if (key === family || key.startsWith(`${family}:`)) {
            bindingBySessionKey.set(key, { taskId: current.taskId, sessionSeq: next });
          }
        }
      }
      return buildLogicalSessionId(updated.taskId, updated.sessionSeq);
    },
    bindUpstreamSession(sessionKey: string, upstreamSessionId?: string): void {
      const upstream = String(upstreamSessionId ?? "").trim();
      if (!upstream) return;
      upstreamSessionIdBySessionKey.set(sessionKey, upstream);
    },
    getUpstreamSessionId(sessionKey: string): string | null {
      return upstreamSessionIdBySessionKey.get(sessionKey) ?? null;
    },
    deleteTaskCache(sessionKey: string, taskId?: string) {
      const current = ensure(sessionKey);
      const targetTaskId = safeId(taskId ?? current.taskId);
      let removedBindings = 0;
      for (const [key, binding] of bindingBySessionKey.entries()) {
        if (binding.taskId === targetTaskId) {
          bindingBySessionKey.delete(key);
          removedBindings += 1;
        }
      }
      countersByTaskId.delete(targetTaskId);
      if (globalDefaultTaskId === targetTaskId) {
        globalDefaultTaskId = null;
      }
      if (removedBindings === 0) return null;
      const baseDefaultTaskId = `default-${safeId(sessionKey || "unknown")}`;
      const fallbackTaskId =
        targetTaskId === baseDefaultTaskId
          ? `${baseDefaultTaskId}-r${Date.now().toString(36)}`
          : baseDefaultTaskId;
      const fallback = ensure(sessionKey, fallbackTaskId);
      return {
        removedTaskId: targetTaskId,
        removedBindings,
        switchedToLogical: buildLogicalSessionId(fallback.taskId, fallback.sessionSeq),
      };
    },
  };
}

type EcoClawCmd = {
  kind:
    | "none"
    | "status"
    | "cache_new"
    | "cache_delete"
    | "cache_list"
    | "session_new"
    | "openclaw_session_new"
    | "help";
  taskId?: string;
};

function parseEcoClawCommand(raw: string): EcoClawCmd {
  const text = raw.trim();
  if (!text) return { kind: "none" };
  const bareSlash = text.startsWith("/") ? text.slice(1).trim().toLowerCase() : "";
  if (bareSlash === "new") {
    return { kind: "openclaw_session_new" };
  }
  const normalized = text.startsWith("/") ? text.slice(1).trim() : text;
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "none" };
  if (parts[0].toLowerCase() !== "ecoclaw") return { kind: "none" };
  if (parts.length === 1) return { kind: "help" };

  const scope = parts[1]?.toLowerCase();
  if (scope === "help" || scope === "h" || scope === "--help") return { kind: "help" };
  const action = parts[2]?.toLowerCase();
  if (scope === "status") return { kind: "status" };
  if (scope === "cache" && action === "new") {
    return { kind: "cache_new", taskId: parts[3] };
  }
  if (scope === "cache" && (action === "list" || action === "ls")) {
    return { kind: "cache_list" };
  }
  if (scope === "cache" && (action === "delete" || action === "del" || action === "rm")) {
    return { kind: "cache_delete", taskId: parts[3] };
  }
  if (scope === "session" && action === "new") {
    return { kind: "session_new" };
  }
  return { kind: "help" };
}

function commandHelpText(): string {
  return [
    "EcoClaw commands:",
    "  /ecoclaw help",
    "    作用: 显示这份帮助与示例。",
    "  /ecoclaw status",
    "    作用: 查看当前会话绑定到哪个 task-cache / logical session。",
    "  /ecoclaw cache new [task-id]",
    "    作用: 新建并切换到一个 task-cache（工作区）。",
    "  /ecoclaw cache list",
    "    作用: 列出当前所有 task-cache，并标记当前所在工作区。",
    "  /ecoclaw cache delete [task-id]",
    "    作用: 删除指定（或当前）task-cache，并回退到默认绑定。",
    "  /ecoclaw session new",
    "    作用: 在当前 task-cache 内开启下一条 logical session 分支。",
    "",
    "示例:",
    "  /ecoclaw cache new demo-task",
    "  /ecoclaw cache list",
    "  /ecoclaw session new",
    "  /ecoclaw status",
    "",
    "说明:",
    "  - 请在 TUI 里优先使用 slash 命令: /ecoclaw ...",
    "  - 1 个 task-cache 可以包含多个 session。",
  ].join("\n");
}

function normalizeConfig(raw: unknown): Required<Omit<EcoClawPluginConfig, "proxyBaseUrl" | "proxyApiKey">> &
  Pick<EcoClawPluginConfig, "proxyBaseUrl" | "proxyApiKey"> {
  const cfg = (raw ?? {}) as EcoClawPluginConfig;
  const defaultStateDir = join(homedir(), ".openclaw", "ecoclaw-plugin-state");
  const stateDir = cfg.stateDir ?? defaultStateDir;
  const modules = cfg.modules ?? {};
  const compaction = cfg.compaction ?? {};
  const handoff = cfg.handoff ?? {};
  const eviction = cfg.eviction ?? {};
  const semantic = cfg.semanticReduction ?? {};
  const semanticEmbedding = semantic.embedding ?? {};
  const reduction = cfg.reduction ?? {};
  return {
    enabled: cfg.enabled ?? true,
    logLevel: cfg.logLevel ?? "info",
    proxyBaseUrl: cfg.proxyBaseUrl,
    proxyApiKey: cfg.proxyApiKey,
    stateDir,
    debugTapProviderTraffic: cfg.debugTapProviderTraffic ?? false,
    debugTapPath: cfg.debugTapPath ?? join(stateDir, "ecoclaw", "provider-traffic.jsonl"),
    proxyAutostart: cfg.proxyAutostart ?? true,
    proxyPort: Math.max(1025, Math.min(65535, cfg.proxyPort ?? 17667)),
    modules: {
      stabilizer: modules.stabilizer ?? true,
      policy: modules.policy ?? true,
      reduction: modules.reduction ?? true,
      compaction: modules.compaction ?? true,
      eviction: modules.eviction ?? false,
      decisionLedger: modules.decisionLedger ?? true,
    },
    compaction: {
      enabled: compaction.enabled ?? true,
      autoForkOnPolicy: compaction.autoForkOnPolicy ?? true,
      summaryGenerationMode:
        compaction.summaryGenerationMode === "llm_full_context" ? "llm_full_context" : "heuristic",
      summaryFallbackToHeuristic: compaction.summaryFallbackToHeuristic ?? true,
      summaryMaxOutputTokens: Math.max(128, Math.min(8192, compaction.summaryMaxOutputTokens ?? 1200)),
      includeAssistantReply: compaction.includeAssistantReply ?? true,
      summaryPrompt: typeof compaction.summaryPrompt === "string" ? compaction.summaryPrompt : undefined,
      summaryPromptPath: typeof compaction.summaryPromptPath === "string" ? compaction.summaryPromptPath : undefined,
      resumePrefixPrompt:
        typeof compaction.resumePrefixPrompt === "string" ? compaction.resumePrefixPrompt : undefined,
      resumePrefixPromptPath:
        typeof compaction.resumePrefixPromptPath === "string" ? compaction.resumePrefixPromptPath : undefined,
      compactionCooldownTurns: Math.max(0, compaction.compactionCooldownTurns ?? 6),
      turnLocalCompaction: {
        enabled: compaction.turnLocalCompaction?.enabled ?? false,
        archiveDir: typeof compaction.turnLocalCompaction?.archiveDir === "string"
          ? compaction.turnLocalCompaction.archiveDir
          : undefined,
      },
    },
    handoff: {
      enabled: handoff.enabled ?? false,
      handoffGenerationMode:
        handoff.handoffGenerationMode === "llm_full_context" ? "llm_full_context" : "heuristic",
      handoffFallbackToHeuristic: handoff.handoffFallbackToHeuristic ?? true,
      handoffMaxOutputTokens: Math.max(128, Math.min(8192, handoff.handoffMaxOutputTokens ?? 900)),
      includeAssistantReply: handoff.includeAssistantReply ?? true,
      handoffPrompt: typeof handoff.handoffPrompt === "string" ? handoff.handoffPrompt : undefined,
      handoffPromptPath: typeof handoff.handoffPromptPath === "string" ? handoff.handoffPromptPath : undefined,
      handoffCooldownTurns: Math.max(0, handoff.handoffCooldownTurns ?? 4),
    },
    eviction: {
      enabled: eviction.enabled ?? false,
      policy:
        eviction.policy === "lru" ||
        eviction.policy === "lfu" ||
        eviction.policy === "gdsf" ||
        eviction.policy === "model_scored" ||
        eviction.policy === "noop"
          ? eviction.policy
          : "noop",
      maxCandidateBlocks: Math.max(1, eviction.maxCandidateBlocks ?? 128),
      minBlockChars: Math.max(16, eviction.minBlockChars ?? 256),
    },
    semanticReduction: {
      enabled: semantic.enabled ?? false,
      pythonBin: semantic.pythonBin ?? "python",
      timeoutMs: Math.max(1000, Math.min(300000, semantic.timeoutMs ?? 120000)),
      llmlinguaModelPath: semantic.llmlinguaModelPath,
      targetRatio:
        typeof semantic.targetRatio === "number"
          ? Math.min(0.95, Math.max(0.05, semantic.targetRatio))
          : 0.55,
      minInputChars: Math.max(256, semantic.minInputChars ?? 4000),
      minSavedChars: Math.max(32, semantic.minSavedChars ?? 200),
      preselectRatio:
        typeof semantic.preselectRatio === "number"
          ? Math.min(1, Math.max(0.05, semantic.preselectRatio))
          : 0.8,
      maxChunkChars: Math.max(256, semantic.maxChunkChars ?? 1400),
      embedding: {
        provider:
          semanticEmbedding.provider === "local" ||
          semanticEmbedding.provider === "api" ||
          semanticEmbedding.provider === "none"
            ? semanticEmbedding.provider
            : "none",
        modelPath: semanticEmbedding.modelPath,
        apiBaseUrl: semanticEmbedding.apiBaseUrl,
        apiKey: semanticEmbedding.apiKey,
        apiModel: semanticEmbedding.apiModel,
        requestTimeoutMs: Math.max(1000, Math.min(120000, semanticEmbedding.requestTimeoutMs ?? 30000)),
      },
    },
    reduction: {
      engine: "layered",
      triggerMinChars: Math.max(256, reduction.triggerMinChars ?? 2200),
      maxToolChars: Math.max(256, reduction.maxToolChars ?? 1200),
    },
  };
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

const OPENCLAW_SENDER_METADATA_BLOCK_RE =
  /(?:^|\n{1,2})Sender\s+\(untrusted metadata\):\s*```json\s*[\s\S]*?```(?:\n{1,2}|$)/gi;
const OPENCLAW_SENDER_METADATA_DETECT_RE =
  /Sender\s+\(untrusted metadata\):\s*```json/gi;

function stripUntrustedSenderMetadata(text: string): string {
  const raw = String(text ?? "");
  const withoutMetadata = raw.replace(OPENCLAW_SENDER_METADATA_BLOCK_RE, "\n\n");
  return withoutMetadata.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeUserMessageText(text: string): string {
  return stripUntrustedSenderMetadata(String(text ?? ""));
}

function normalizeTurnBindingMessage(text: string): string {
  return normalizeUserMessageText(String(text ?? "").trim()).trim();
}

function countSenderMetadataBlocks(value: any): number {
  const matches = String(extractInputText(value) ?? "").match(OPENCLAW_SENDER_METADATA_DETECT_RE);
  return matches ? matches.length : 0;
}

function normalizeContentNode(value: any): { value: any; changed: boolean } {
  if (typeof value === "string") {
    const next = normalizeUserMessageText(value);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const normalized = normalizeContentNode(item);
      if (normalized.changed) changed = true;
      return normalized.value;
    });
    return { value: next, changed };
  }
  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }
  let changed = false;
  const next: Record<string, any> = Array.isArray(value) ? [] : { ...value };
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeContentNode(child);
    if (normalized.changed) {
      changed = true;
      next[key] = normalized.value;
    }
  }
  return { value: changed ? next : value, changed };
}

function normalizeContentValue(value: any): { value: any; changed: boolean } {
  return normalizeContentNode(value);
}

function summarizeToolsFingerprint(tools: any): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return "unknown";
    const name = String((tool as any).name ?? (tool as any).type ?? "unknown");
    const type = String((tool as any).type ?? "unknown");
    const params = JSON.stringify((tool as any).parameters ?? {});
    return `${type}:${name}:${params.length}`;
  });
}

function findDeveloperPromptText(input: any): string {
  if (!Array.isArray(input)) return "";
  const developer = input.find((item) => item && typeof item === "object" && String(item.role) === "developer");
  if (!developer) return "";
  return extractInputText([developer]);
}

function normalizeStableText(input: string): string {
  return input
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<UUID>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:.+\-Z]{6,}\b/g, "<TIMESTAMP>")
    .replace(/\b\d{10,}\b/g, "<LONGNUM>")
    .replace(/\s+/g, " ")
    .trim();
}

function computeStablePromptCacheKey(
  model: string,
  instructions: string,
  developerText: string,
  tools: any,
): string {
  const seed = JSON.stringify({
    v: 3,
    model: normalizeProxyModelId(model),
    instructions: normalizeStableText(instructions),
    developer: normalizeStableText(developerText),
    tools: summarizeToolsFingerprint(tools),
  });
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return `ecoclaw-pfx-${digest}`;
}

function replaceContentWithText(content: any, nextText: string): any {
  if (typeof content === "string") return nextText;
  if (Array.isArray(content)) {
    const next = content.map((entry) => (entry && typeof entry === "object" ? { ...entry } : entry));
    for (let i = 0; i < next.length; i += 1) {
      const entry = next[i];
      if (!entry || typeof entry !== "object") continue;
      if (typeof (entry as any).text === "string") {
        (entry as any).text = nextText;
        return next;
      }
      if (typeof (entry as any).content === "string") {
        (entry as any).content = nextText;
        return next;
      }
    }
    next.unshift({ type: "input_text", text: nextText });
    return next;
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return { ...content, text: nextText };
    if (typeof content.content === "string") return { ...content, content: nextText };
  }
  return nextText;
}

function rewritePayloadForStablePrefix(payload: any, model: string): {
  promptCacheKey: string;
  userContentRewrites: number;
  senderMetadataBlocksBefore: number;
  senderMetadataBlocksAfter: number;
  developerTextForKey: string;
} {
  let userContentRewrites = 0;
  let senderMetadataBlocksBefore = 0;
  let senderMetadataBlocksAfter = 0;
  let dynamicContextText = "";
  if (Array.isArray(payload?.input)) {
    payload.input = payload.input.map((item: any) => {
      if (!item || typeof item !== "object") return item;
      const role = String(item.role ?? "");
      if (role !== "user" && role !== "system") return item;
      if (item.__ecoclaw_replay_raw === true) return item;

      if (role === "system") {
        // Normalize system content: workspace paths, agent IDs, timestamps
        const contentText =
          typeof item.content === "string"
            ? String(item.content)
            : extractInputText([item]);
        const rewrite = rewriteRootPromptForStablePrefix(contentText);
        if (!rewrite.changed) return item;
        if (!dynamicContextText && rewrite.dynamicContextText) {
          dynamicContextText = rewrite.dynamicContextText;
        }
        senderMetadataBlocksBefore += countSenderMetadataBlocks(item.content);
        userContentRewrites += 1;
        // Replace content with normalized text (handles both string and array content)
        const newContent = replaceContentWithText(item.content, rewrite.forwardedPromptText);
        const nextItem = {
          ...item,
          content: newContent,
        };
        senderMetadataBlocksAfter += countSenderMetadataBlocks(nextItem.content);
        return nextItem;
      }

      // User content: normalize sender metadata blocks
      senderMetadataBlocksBefore += countSenderMetadataBlocks(item.content);
      const normalized = normalizeContentValue(item.content);
      if (!normalized.changed) {
        senderMetadataBlocksAfter += countSenderMetadataBlocks(item.content);
        return item;
      }
      userContentRewrites += 1;
      const nextItem = {
        ...item,
        content: normalized.value,
      };
      senderMetadataBlocksAfter += countSenderMetadataBlocks(nextItem.content);
      return nextItem;
    });

    if (dynamicContextText) {
      const userIndex = payload.input.findIndex((item: any) => item && typeof item === "object" && String(item.role) === "user");
      if (userIndex >= 0) {
        const userItem = payload.input[userIndex];
        const currentText = extractInputText([userItem]);
        if (!currentText.includes(dynamicContextText)) {
          payload.input[userIndex] = {
            ...userItem,
            role: "user",
            content: prependTextToContent(userItem?.content, dynamicContextText),
          };
          userContentRewrites += 1;
        }
      }
    }
  }

  const developerTextForKey = findDeveloperPromptText(payload?.input);
  const stablePromptCacheKey = computeStablePromptCacheKey(
    model,
    String(payload?.instructions ?? ""),
    developerTextForKey,
    payload?.tools,
  );
  payload.prompt_cache_key = stablePromptCacheKey;
  return {
    promptCacheKey: stablePromptCacheKey,
    userContentRewrites,
    senderMetadataBlocksBefore,
    senderMetadataBlocksAfter,
    developerTextForKey,
  };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLikelyToolLikeInputItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  const role = String(item.role ?? "").toLowerCase();
  const type = String(item.type ?? "").toLowerCase();
  if (role === "tool" || role === "observation" || role === "toolresult") return true;
  if (
    type === "function_call"
    || type === "function_call_output"
    || type === "tool_result"
    || type === "tool_call_output"
  ) return true;
  if (typeof item.name === "string" && item.name.trim().length > 0) return true;
  if (typeof item.tool_name === "string" && item.tool_name.trim().length > 0) return true;
  if (typeof item.toolName === "string" && item.toolName.trim().length > 0) return true;
  if (typeof item.tool_call_id === "string" && item.tool_call_id.trim().length > 0) return true;
  if (typeof item.toolCallId === "string" && item.toolCallId.trim().length > 0) return true;
  return false;
}

type ProxyReductionBinding =
  | { segmentId: string; itemIndex: number; field: "arguments" | "output" | "result"; beforeLen: number }
  | {
    segmentId: string;
    itemIndex: number;
    field: "content";
    blockIndex?: number;
    blockKey?: "text" | "content";
    beforeLen: number;
  };

function detectToolPayloadKind(text: string): "stdout" | "stderr" | "json" | "blob" | undefined {
  return inferObservationPayloadKind(text);
}

function parseFunctionCallArgsMapFromInput(input: any[]): Map<string, { toolName?: string; path?: string }> {
  const map = new Map<string, { toolName?: string; path?: string }>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    if (type !== "function_call") continue;
    const callId = String(item.call_id ?? item.id ?? "").trim();
    if (!callId) continue;
    const toolName = typeof item.name === "string" && item.name.trim().length > 0
      ? item.name.trim()
      : undefined;
    let path: string | undefined;
    try {
      const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
      const candidate = args?.path ?? args?.file_path ?? args?.filePath;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        path = candidate.trim();
      }
    } catch {
      // Ignore malformed tool arguments.
    }
    map.set(callId, { toolName, path });
  }
  return map;
}

function buildLayeredReductionContext(
  payload: any,
  triggerMinChars: number,
): {
  turnCtx: RuntimeTurnContext;
  bindings: ProxyReductionBinding[];
  stats: {
    inputItems: number;
    toolLikeItems: number;
    candidateBlocks: number;
    overThresholdBlocks: number;
    instructionCount: number;
  };
} {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const callArgsMap = parseFunctionCallArgsMapFromInput(input);
  const segments: ContextSegment[] = [];
  const bindings: ProxyReductionBinding[] = [];
  const reductionInstructions: Array<{
    strategy: string;
    segmentIds: string[];
    parameters?: Record<string, unknown>;
  }> = [];

  const addSegment = (
    segmentId: string,
    text: string,
    metadata: Record<string, unknown>,
    binding: ProxyReductionBinding,
  ): void => {
    segments.push({
      id: segmentId,
      kind: "volatile",
      text,
      priority: 100,
      source: "proxy.input",
      metadata,
    });
    bindings.push(binding);
  };

  const readByPath = new Map<string, string[]>();
  const enableRepeatedReadDedup = true;
  let toolLikeItems = 0;
  let candidateBlocks = 0;
  let overThresholdBlocks = 0;

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    if (!isLikelyToolLikeInputItem(item)) continue;
    toolLikeItems += 1;

    const itemType = String(item.type ?? "").toLowerCase();
    const itemRole = String(item.role ?? "").toLowerCase();
    const callId = String(item.call_id ?? item.tool_call_id ?? item.id ?? "").trim();
    const callMeta = callId ? callArgsMap.get(callId) : undefined;
    const toolName = String(
      item.name
      ?? item.tool_name
      ?? item.toolName
      ?? callMeta?.toolName
      ?? "",
    ).trim();
    const dataPath = String(callMeta?.path ?? "").trim();

    const addReductionInstructions = (segmentId: string, text: string): void => {
      candidateBlocks += 1;
      const overThreshold = text.length >= triggerMinChars;
      if (overThreshold) {
        overThresholdBlocks += 1;
      }
      const payloadKind = detectToolPayloadKind(text) ?? "stdout";
      reductionInstructions.push({
        strategy: "tool_payload_trim",
        segmentIds: [segmentId],
        parameters: { payloadKind },
      });
      reductionInstructions.push({
        strategy: "html_slimming",
        segmentIds: [segmentId],
      });
      if (overThreshold) {
        reductionInstructions.push({
          strategy: "exec_output_truncation",
          segmentIds: [segmentId],
        });
      }
    };

    const pushBindingForField = (
      fieldName: "arguments" | "output" | "result",
      applyReduction: boolean,
    ): void => {
      const text = item[fieldName];
      if (typeof text !== "string" || text.length === 0) return;
      const segmentId = `proxy-${index}-${fieldName}`;
      addSegment(
        segmentId,
        text,
        {
          toolName,
          path: dataPath,
          itemType,
          itemRole,
          fieldName,
          toolPayload: {
            toolName,
            path: dataPath,
            payloadKind: detectToolPayloadKind(text) ?? "stdout",
          },
        },
        { segmentId, itemIndex: index, field: fieldName, beforeLen: text.length },
      );
      if (applyReduction) {
        addReductionInstructions(segmentId, text);
      }
      if (toolName === "read" && dataPath) {
        const bucket = readByPath.get(dataPath) ?? [];
        bucket.push(segmentId);
        readByPath.set(dataPath, bucket);
      }
    };

    // Keep tool arguments untouched to avoid changing executable intent.
    pushBindingForField("arguments", false);
    pushBindingForField("output", true);
    pushBindingForField("result", true);

    if (typeof item.content === "string" && item.content.length > 0) {
      const segmentId = `proxy-${index}-content`;
      addSegment(
        segmentId,
        item.content,
        {
          toolName,
          path: dataPath,
          itemType,
          itemRole,
          fieldName: "content",
          toolPayload: {
            toolName,
            path: dataPath,
            payloadKind: detectToolPayloadKind(item.content) ?? "stdout",
          },
        },
        { segmentId, itemIndex: index, field: "content", beforeLen: item.content.length },
      );
      addReductionInstructions(segmentId, item.content);
      if (toolName === "read" && dataPath) {
        const bucket = readByPath.get(dataPath) ?? [];
        bucket.push(segmentId);
        readByPath.set(dataPath, bucket);
      }
    }
    if (Array.isArray(item.content)) {
      item.content.forEach((block: any, blockIndex: number) => {
        if (!block || typeof block !== "object") return;
        const blockKey: "text" | "content" | undefined =
          typeof block.text === "string"
            ? "text"
            : typeof block.content === "string"
              ? "content"
              : undefined;
        if (!blockKey) return;
        const text = String(block[blockKey] ?? "");
        if (!text) return;
        const segmentId = `proxy-${index}-content-${blockIndex}-${blockKey}`;
        addSegment(
          segmentId,
          text,
          {
            toolName,
            path: dataPath,
            itemType,
            itemRole,
            fieldName: "content",
            blockIndex,
            blockKey,
            toolPayload: {
              toolName,
              path: dataPath,
              payloadKind: detectToolPayloadKind(text) ?? "stdout",
            },
          },
          {
            segmentId,
            itemIndex: index,
            field: "content",
            blockIndex,
            blockKey,
            beforeLen: text.length,
          },
        );
        addReductionInstructions(segmentId, text);
        if (toolName === "read" && dataPath) {
          const bucket = readByPath.get(dataPath) ?? [];
          bucket.push(segmentId);
          readByPath.set(dataPath, bucket);
        }
      });
    }
  }

  if (enableRepeatedReadDedup) {
    for (const segmentIds of readByPath.values()) {
      if (segmentIds.length < 2) continue;
      const [firstId, ...rest] = segmentIds;
      for (const segmentId of rest) {
        reductionInstructions.push({
          strategy: "repeated_read_dedup",
          segmentIds: [segmentId],
          parameters: { firstReadSegmentId: firstId },
        });
      }
    }
  }

  const turnCtx: RuntimeTurnContext = {
    sessionId: "proxy-session",
    sessionMode: "single",
    provider: "openai",
    model: String(payload?.model ?? "unknown"),
    apiFamily: "openai-responses",
    prompt: "",
    segments,
    budget: {
      maxInputTokens: 1_000_000,
      reserveOutputTokens: 16_384,
    },
    metadata: {
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: [
              "repeated_read_dedup",
              "tool_payload_trim",
              "html_slimming",
              "exec_output_truncation",
            ],
            instructions: reductionInstructions,
          },
        },
      },
    },
  };

  return {
    turnCtx,
    bindings,
    stats: {
      inputItems: input.length,
      toolLikeItems,
      candidateBlocks,
      overThresholdBlocks,
      instructionCount: reductionInstructions.length,
    },
  };
}

type ProxyReductionResult = {
  changedItems: number;
  changedBlocks: number;
  savedChars: number;
  diagnostics?: {
    engine: "layered";
    inputItems: number;
    toolLikeItems: number;
    candidateBlocks: number;
    overThresholdBlocks: number;
    triggerMinChars: number;
    maxToolChars: number;
    instructionCount: number;
    passCount: number;
    skippedReason?: string;
  };
};

type ProxyAfterCallReductionResult = {
  changed: boolean;
  savedChars: number;
  passCount: number;
  skippedReason?: string;
  mode?: "json" | "sse";
  patchedEvents?: number;
};

function applyLayeredReductionToInput(
  payload: any,
  maxToolChars: number,
  triggerMinChars: number,
): Promise<ProxyReductionResult> | ProxyReductionResult {
  if (!Array.isArray(payload?.input)) {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      diagnostics: {
        engine: "layered",
        inputItems: 0,
        toolLikeItems: 0,
        candidateBlocks: 0,
        overThresholdBlocks: 0,
        triggerMinChars,
        maxToolChars,
        instructionCount: 0,
        passCount: 0,
        skippedReason: "no_input_array",
      },
    };
  }
  const { turnCtx, bindings, stats } = buildLayeredReductionContext(payload, triggerMinChars);
  if (turnCtx.segments.length === 0 || bindings.length === 0) {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      diagnostics: {
        engine: "layered",
        inputItems: stats.inputItems,
        toolLikeItems: stats.toolLikeItems,
        candidateBlocks: stats.candidateBlocks,
        overThresholdBlocks: stats.overThresholdBlocks,
        triggerMinChars,
        maxToolChars,
        instructionCount: stats.instructionCount,
        passCount: 0,
        skippedReason: stats.candidateBlocks === 0 ? "no_candidate_blocks" : "below_trigger_min_chars",
      },
    };
  }
  const passes = resolveLayerReductionPasses({ maxToolChars }).filter((p) => p.phase === "before_call");
  return runLayerReductionBeforeCall({
    turnCtx,
    passes,
  }).then(({ turnCtx: reducedCtx, report }) => {
    const changedIds = new Set<string>();
    for (const entry of report) {
      if (!entry.changed) continue;
      for (const id of entry.touchedSegmentIds ?? []) changedIds.add(id);
    }
    if (changedIds.size === 0) {
      return {
        changedItems: 0,
        changedBlocks: 0,
        savedChars: 0,
        diagnostics: {
          engine: "layered",
          inputItems: stats.inputItems,
          toolLikeItems: stats.toolLikeItems,
          candidateBlocks: stats.candidateBlocks,
          overThresholdBlocks: stats.overThresholdBlocks,
          triggerMinChars,
          maxToolChars,
          instructionCount: stats.instructionCount,
          passCount: passes.length,
          skippedReason: "pipeline_no_effect",
        },
      };
    }
    const segmentMap = new Map<string, ContextSegment>();
    for (const segment of reducedCtx.segments) segmentMap.set(segment.id, segment);

    let changedBlocks = 0;
    let savedChars = 0;
    const changedItems = new Set<number>();

    for (const binding of bindings) {
      if (!changedIds.has(binding.segmentId)) continue;
      const reduced = segmentMap.get(binding.segmentId);
      if (!reduced) continue;
      const nextText = reduced.text;
      if (binding.field === "arguments" || binding.field === "output" || binding.field === "result") {
        const item = payload.input[binding.itemIndex];
        if (!item || typeof item !== "object") continue;
        if (typeof item[binding.field] !== "string") continue;
        if (item[binding.field] === nextText) continue;
        item[binding.field] = nextText;
      } else if (binding.field === "content") {
        const item = payload.input[binding.itemIndex];
        if (!item || typeof item !== "object") continue;
        if (binding.blockIndex === undefined) {
          if (typeof item.content !== "string") continue;
          if (item.content === nextText) continue;
          item.content = nextText;
        } else {
          if (!Array.isArray(item.content)) continue;
          const block = item.content[binding.blockIndex];
          if (!block || typeof block !== "object" || !binding.blockKey) continue;
          if (typeof block[binding.blockKey] !== "string") continue;
          if (block[binding.blockKey] === nextText) continue;
          block[binding.blockKey] = nextText;
        }
      }
      changedItems.add(binding.itemIndex);
      changedBlocks += 1;
      savedChars += Math.max(0, binding.beforeLen - nextText.length);
    }
    return {
      changedItems: changedItems.size,
      changedBlocks,
      savedChars,
      diagnostics: {
        engine: "layered",
        inputItems: stats.inputItems,
        toolLikeItems: stats.toolLikeItems,
        candidateBlocks: stats.candidateBlocks,
        overThresholdBlocks: stats.overThresholdBlocks,
        triggerMinChars,
        maxToolChars,
        instructionCount: stats.instructionCount,
        passCount: passes.length,
      },
    };
  }).catch(() => {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      diagnostics: {
        engine: "layered",
        inputItems: stats.inputItems,
        toolLikeItems: stats.toolLikeItems,
        candidateBlocks: stats.candidateBlocks,
        overThresholdBlocks: stats.overThresholdBlocks,
        triggerMinChars,
        maxToolChars,
        instructionCount: stats.instructionCount,
        passCount: passes.length,
        skippedReason: "pipeline_error",
      },
    };
  });
}

function applyProxyReductionToInput(
  payload: any,
  options?: {
    engine?: "layered";
    triggerMinChars?: number;
    maxToolChars?: number;
  },
): Promise<ProxyReductionResult> | ProxyReductionResult {
  const triggerMinChars = Math.max(256, options?.triggerMinChars ?? 2200);
  const maxToolChars = Math.max(256, options?.maxToolChars ?? 1200);
  return applyLayeredReductionToInput(payload, maxToolChars, triggerMinChars);
}

function extractProxyResponseText(parsedResponse: any): string {
  if (!parsedResponse || typeof parsedResponse !== "object") return "";
  if (typeof parsedResponse.output_text === "string" && parsedResponse.output_text.trim().length > 0) {
    return parsedResponse.output_text;
  }
  return extractProviderResponseText("", parsedResponse);
}

function patchProxyResponseText(parsedResponse: any, nextText: string): boolean {
  if (!parsedResponse || typeof parsedResponse !== "object") return false;
  let changed = false;

  if (typeof parsedResponse.output_text === "string" && parsedResponse.output_text !== nextText) {
    parsedResponse.output_text = nextText;
    changed = true;
  }

  const output = Array.isArray(parsedResponse.output) ? parsedResponse.output : [];
  let replacedNested = false;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const type = String((item as any).type ?? "").toLowerCase();
    if (type === "output_text" && typeof (item as any).text === "string") {
      if ((item as any).text !== nextText) {
        (item as any).text = nextText;
        changed = true;
      }
      replacedNested = true;
      break;
    }
    if (type === "message" && Array.isArray((item as any).content)) {
      for (const block of (item as any).content) {
        if (!block || typeof block !== "object") continue;
        if (String((block as any).type ?? "").toLowerCase() !== "output_text") continue;
        if (typeof (block as any).text !== "string") continue;
        if ((block as any).text !== nextText) {
          (block as any).text = nextText;
          changed = true;
        }
        replacedNested = true;
        break;
      }
      if (replacedNested) break;
    }
  }

  return changed;
}

function isSseContentType(contentType: string | null | undefined): boolean {
  return String(contentType ?? "").toLowerCase().includes("text/event-stream");
}

function rewriteSseJsonEvents(
  rawSse: string,
  mutator: (event: any) => boolean,
): { text: string; parsedEvents: number; changedEvents: number } {
  const normalized = String(rawSse ?? "");
  if (!normalized.trim()) return { text: normalized, parsedEvents: 0, changedEvents: 0 };
  const blocks = normalized.split(/\r?\n\r?\n/u);
  let parsedEvents = 0;
  let changedEvents = 0;
  const rewrittenBlocks = blocks.map((block) => {
    const lines = block.split(/\r?\n/u);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return block;
    const payloadText = dataLines
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!payloadText || payloadText === "[DONE]") return block;
    let parsed: any = null;
    try {
      parsed = JSON.parse(payloadText);
      parsedEvents += 1;
    } catch {
      return block;
    }
    if (!mutator(parsed)) return block;
    changedEvents += 1;
    const nonData = lines.filter((line) => !line.startsWith("data:"));
    return [...nonData, `data: ${JSON.stringify(parsed)}`].join("\n");
  });
  const text = rewrittenBlocks.join("\n\n");
  return { text, parsedEvents, changedEvents };
}

function collectSseOutputText(rawSse: string): string {
  const normalized = String(rawSse ?? "");
  if (!normalized.trim()) return "";
  const blocks = normalized.split(/\r?\n\r?\n/u);
  const doneTexts: string[] = [];
  let deltaText = "";
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) continue;
    const payloadText = dataLines
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!payloadText || payloadText === "[DONE]") continue;
    try {
      const event = JSON.parse(payloadText) as any;
      const type = String(event?.type ?? "").toLowerCase();
      if (type === "response.output_text.done" && typeof event?.text === "string" && event.text.trim().length > 0) {
        doneTexts.push(event.text);
        continue;
      }
      if (type === "response.content_part.done") {
        const partType = String(event?.part?.type ?? "").toLowerCase();
        if (partType === "output_text" && typeof event?.part?.text === "string" && event.part.text.trim().length > 0) {
          doneTexts.push(event.part.text);
          continue;
        }
      }
      if (type === "response.output_text.delta" && typeof event?.delta === "string") {
        deltaText += event.delta;
      }
    } catch {
      // ignore malformed stream fragments
    }
  }
  if (doneTexts.length > 0) return doneTexts.join("\n").trim();
  return deltaText.trim();
}

function patchSseEventForReducedText(event: any, nextText: string): boolean {
  if (!event || typeof event !== "object") return false;
  const type = String(event.type ?? "").toLowerCase();
  let changed = false;
  if (type === "response.output_text.done" && typeof event.text === "string" && event.text !== nextText) {
    event.text = nextText;
    changed = true;
  }
  if (type === "response.content_part.done" && event.part && typeof event.part === "object") {
    const partType = String(event.part.type ?? "").toLowerCase();
    if (partType === "output_text" && typeof event.part.text === "string" && event.part.text !== nextText) {
      event.part.text = nextText;
      changed = true;
    }
  }
  if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
    changed = patchProxyResponseText(event.item, nextText) || changed;
  }
  if (type === "response.completed" && event.response && typeof event.response === "object") {
    changed = patchProxyResponseText(event.response, nextText) || changed;
  }
  return changed;
}

async function applyLayeredReductionAfterCallToSse(
  requestPayload: any,
  rawSse: string,
  maxToolChars: number,
  triggerMinChars: number,
): Promise<{ text: string; reduction: ProxyAfterCallReductionResult }> {
  let completedResponse: any = null;
  const probe = rewriteSseJsonEvents(rawSse, (event) => {
    if (!event || typeof event !== "object") return false;
    const type = String(event.type ?? "").toLowerCase();
    if (type !== "response.completed" || !event.response || typeof event.response !== "object") return false;
    completedResponse = event.response;
    return false;
  });
  if (!completedResponse) {
    return {
      text: rawSse,
      reduction: {
        changed: false,
        savedChars: 0,
        passCount: 0,
        skippedReason: "sse_missing_response_completed",
        mode: "sse",
        patchedEvents: probe.changedEvents,
      },
    };
  }

  const reconstructedText = collectSseOutputText(rawSse);
  if (!extractProxyResponseText(completedResponse) && reconstructedText) {
    if (typeof completedResponse.output_text === "string" || completedResponse.output_text === undefined) {
      completedResponse.output_text = reconstructedText;
    }
  }

  const afterCallReduction = await applyLayeredReductionAfterCall(
    requestPayload,
    completedResponse,
    maxToolChars,
    triggerMinChars,
  );
  if (!afterCallReduction.changed) {
    return { text: rawSse, reduction: { ...afterCallReduction, mode: "sse" } };
  }
  const nextText = extractProxyResponseText(completedResponse);
  if (!nextText) {
    return {
      text: rawSse,
      reduction: {
        ...afterCallReduction,
        changed: false,
        skippedReason: "sse_reduced_text_empty",
        mode: "sse",
      },
    };
  }

  const rewritten = rewriteSseJsonEvents(rawSse, (event) => patchSseEventForReducedText(event, nextText));
  if (rewritten.changedEvents <= 0) {
    return {
      text: rawSse,
      reduction: {
        ...afterCallReduction,
        changed: false,
        skippedReason: "sse_patch_no_effect",
        mode: "sse",
        patchedEvents: 0,
      },
    };
  }
  return {
    text: rewritten.text,
    reduction: { ...afterCallReduction, mode: "sse", patchedEvents: rewritten.changedEvents },
  };
}

async function applyLayeredReductionAfterCall(
  requestPayload: any,
  parsedResponse: any,
  maxToolChars: number,
  triggerMinChars: number,
): Promise<ProxyAfterCallReductionResult> {
  const responseText = extractProxyResponseText(parsedResponse);
  if (!responseText) {
    return { changed: false, savedChars: 0, passCount: 0, skippedReason: "empty_response_text" };
  }

  const { turnCtx } = buildLayeredReductionContext(requestPayload, triggerMinChars);
  const passes = resolveLayerReductionPasses({ maxToolChars }).filter((p) => p.phase === "after_call");
  if (passes.length === 0) {
    return { changed: false, savedChars: 0, passCount: 0, skippedReason: "no_after_call_passes" };
  }

  const result: RuntimeTurnResult = {
    content: responseText,
    metadata: {},
  };
  const { result: reducedResult } = await runLayerReductionAfterCall({
    turnCtx,
    result,
    passes,
  });

  const nextText = String(reducedResult?.content ?? "");
  if (!nextText || nextText === responseText) {
    return { changed: false, savedChars: 0, passCount: passes.length, skippedReason: "pipeline_no_effect" };
  }

  const patched = patchProxyResponseText(parsedResponse, nextText);
  if (!patched) {
    return { changed: false, savedChars: 0, passCount: passes.length, skippedReason: "response_patch_no_effect" };
  }
  return {
    changed: true,
    savedChars: Math.max(0, responseText.length - nextText.length),
    passCount: passes.length,
  };
}

function stripInternalPayloadMarkers(payload: any): void {
  if (!payload || typeof payload !== "object") return;
  if (Object.prototype.hasOwnProperty.call(payload, "__ecoclaw_reduction_applied")) {
    delete payload.__ecoclaw_reduction_applied;
  }
  if (!Array.isArray(payload.input)) return;
  payload.input = payload.input.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    let changed = false;
    const clone: Record<string, unknown> = { ...item };
    if (Object.prototype.hasOwnProperty.call(clone, "__ecoclaw_replay_raw")) {
      delete clone.__ecoclaw_replay_raw;
      changed = true;
    }
    return changed ? clone : item;
  });
}

function extractInputText(input: any): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const content = (entry as any).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .map((c: any) => {
              if (!c || typeof c !== "object") return "";
              if (typeof c.text === "string") return c.text;
              if (typeof c.content === "string") return c.content;
              return "";
            })
            .join("\n");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function findDeveloperAndPrimaryUser(input: any): {
  developerText: string;
  developerIndex: number;
  developerItem: any;
  userIndex: number;
  userItem: any | null;
} | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  let developerIndex = -1;
  let developerItem: any = null;
  let developerText = "";
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object" || String((item as any).role) !== "developer") continue;
    const text =
      typeof (item as any).content === "string"
        ? String((item as any).content)
        : extractInputText([item]);
    if (!text.trim()) continue;
    developerIndex = i;
    developerItem = item;
    developerText = text;
    break;
  }
  if (developerIndex < 0 || !developerItem) return null;

  let userIndex = -1;
  for (let i = developerIndex + 1; i < input.length; i += 1) {
    const item = input[i];
    if (item && typeof item === "object" && String((item as any).role) === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) {
    userIndex = input.findIndex((item) => item && typeof item === "object" && String((item as any).role) === "user");
  }
  const userItem = userIndex >= 0 ? input[userIndex] : null;
  return { developerText, developerIndex, developerItem, userIndex, userItem };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function extractItemText(item: any): string {
  if (!item || typeof item !== "object") return "";
  return extractInputText([item]).trim();
}

function findLastUserItem(input: any): { userIndex: number; userItem: any | null } | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (String((item as any).role) === "user") {
      return { userIndex: i, userItem: item };
    }
  }
  return null;
}

function stripReplyTag(text: string): string {
  return String(text ?? "").replace(/^\s*\[\[[^\]]+\]\]\s*/u, "").trim();
}

function recentTurnBindingsPath(stateDir: string): string {
  return join(stateDir, "ecoclaw", "controls", "recent-turn-bindings.json");
}

function loadRecentTurnBindingsFromState(stateDir: string): RecentTurnBinding[] {
  try {
    const parsed = JSON.parse(readFileSync(recentTurnBindingsPath(stateDir), "utf8"));
    if (!Array.isArray(parsed)) return [];
    const out: RecentTurnBinding[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const userMessage = String((entry as any).userMessage ?? "").trim();
      const matchKey =
        String((entry as any).matchKey ?? "").trim() || normalizeTurnBindingMessage(userMessage);
      const sessionKey = String((entry as any).sessionKey ?? "").trim();
      const upstreamSessionId = String((entry as any).upstreamSessionId ?? "").trim() || undefined;
      const atRaw = Number((entry as any).at ?? 0);
      const at = Number.isFinite(atRaw) ? atRaw : 0;
      if (!userMessage || !matchKey || !sessionKey || !at) continue;
      out.push({ userMessage, matchKey, sessionKey, upstreamSessionId, at });
    }
    return out;
  } catch {
    return [];
  }
}

function persistRecentTurnBindingsToState(stateDir: string, bindings: RecentTurnBinding[]): void {
  try {
    mkdirSync(dirname(recentTurnBindingsPath(stateDir)), { recursive: true });
    writeFileSync(recentTurnBindingsPath(stateDir), JSON.stringify(bindings.slice(-128), null, 2), "utf8");
  } catch {
    // Best-effort only: provider-side lookup can still rely on in-memory bindings if persistence fails.
  }
}

function normalizeProxyModelId(model: string): string {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("ecoclaw/")) {
    return trimmed.slice("ecoclaw/".length).trim();
  }
  return trimmed;
}

type UpstreamModelDef = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

type UpstreamConfig = {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  models: UpstreamModelDef[];
};

async function detectUpstreamConfig(logger: Required<PluginLogger>): Promise<UpstreamConfig | null> {
  const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as any;
    const providers = parsed?.models?.providers ?? {};
    // tuzi/dica before gmn: gmn is openclaw's internal provider and may not support all model IDs
    const preferred = ["tuzi", "dica", "openai", "qwen-portal", "bailian", "gmn"];
    const selectedProvider = preferred.find((id) => providers?.[id]?.baseUrl && providers?.[id]?.apiKey)
      ?? Object.keys(providers).find((id) => id !== "ecoclaw" && providers[id]?.baseUrl && providers[id]?.apiKey)
      ?? Object.keys(providers)[0];
    if (!selectedProvider) return null;
    const p = providers[selectedProvider];
    const models = Array.isArray(p?.models) ? p.models : [];
    const normalized: UpstreamModelDef[] = models
      .filter((m: any) => typeof m?.id === "string" && m.id.trim())
      .map((m: any) => ({
        id: String(m.id),
        name: String(m.name ?? m.id),
        reasoning: Boolean(m.reasoning ?? false),
        input: Array.isArray(m.input) ? m.input.filter((x: any) => x === "text" || x === "image") : ["text"],
        contextWindow: Number(m.contextWindow ?? 128000),
        maxTokens: Number(m.maxTokens ?? 8192),
      }));
    if (!p?.baseUrl || !p?.apiKey) return null;
    return {
      providerId: selectedProvider,
      baseUrl: String(p.baseUrl).replace(/\/+$/, ""),
      apiKey: String(p.apiKey),
      models: normalized.length > 0 ? normalized : [{
        id: "gpt-5.4",
        name: "gpt-5.4",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 8192,
      }],
    };
  } catch (err) {
    logger.warn(`[ecoclaw] detect upstream config failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function ensureExplicitProxyModelsInConfig(
  proxyBaseUrl: string,
  upstream: UpstreamConfig,
  logger: Required<PluginLogger>,
): Promise<void> {
  const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(cfgPath, "utf8");
    const doc = JSON.parse(raw) as any;
    doc.models = doc.models ?? {};
    doc.models.providers = doc.models.providers ?? {};
    doc.agents = doc.agents ?? {};
    doc.agents.defaults = doc.agents.defaults ?? {};
    doc.agents.defaults.models = doc.agents.defaults.models ?? {};

    const existingProvider = doc.models.providers.ecoclaw ?? {};
    const desiredModels = upstream.models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    const nextProvider = {
      ...existingProvider,
      baseUrl: proxyBaseUrl,
      apiKey: "ecoclaw-local",
      api: "openai-responses",
      authHeader: false,
      models: desiredModels,
    };
    doc.models.providers.ecoclaw = nextProvider;

    for (const model of upstream.models) {
      const key = `ecoclaw/${model.id}`;
      if (!doc.agents.defaults.models[key]) {
        doc.agents.defaults.models[key] = {};
      }
    }

    const nextRaw = JSON.stringify(doc, null, 2);
    if (nextRaw !== raw) {
      await writeFile(cfgPath, nextRaw, "utf8");
      logger.info(
        `[ecoclaw] synced explicit model keys into openclaw.json (${upstream.models.length} models).`,
      );
    }
  } catch (err) {
    logger.warn(
      `[ecoclaw] sync explicit proxy models failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function startEmbeddedResponsesProxy(
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
): Promise<{ baseUrl: string; upstream: UpstreamConfig; close: () => Promise<void> } | null> {
  if (!cfg.proxyAutostart) return null;
  let upstream: UpstreamConfig | null = null;
  if (cfg.proxyBaseUrl && cfg.proxyApiKey) {
    // Explicit config takes precedence over auto-detection
    const detected = await detectUpstreamConfig(logger);
    upstream = {
      providerId: detected?.providerId ?? "configured",
      baseUrl: cfg.proxyBaseUrl.replace(/\/+$/, ""),
      apiKey: cfg.proxyApiKey,
      models: detected?.models ?? [],
    };
    logger.info(`[ecoclaw] proxy using configured upstream: ${upstream.baseUrl}`);
  } else {
    upstream = await detectUpstreamConfig(logger);
  }
  if (!upstream) {
    logger.warn("[ecoclaw] no upstream provider discovered; proxy disabled.");
    return null;
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body);
      const model = String(payload?.model ?? "");
      const upstreamModel = normalizeProxyModelId(model);
      if (upstreamModel && upstreamModel !== model) {
        payload.model = upstreamModel;
      }
      const instructions = normalizeText(String(payload?.instructions ?? ""));
      const devAndUser = findDeveloperAndPrimaryUser(payload?.input);
      const firstTurnCandidate = Boolean(devAndUser);
      const rootPromptRewrite = devAndUser
        ? rewriteRootPromptForStablePrefix(devAndUser.developerText)
        : null;
      const developerCanonicalText = normalizeText(
        rootPromptRewrite?.canonicalPromptText ?? devAndUser?.developerText ?? "",
      );
      const developerForwardedText = normalizeText(
        rootPromptRewrite?.forwardedPromptText ?? devAndUser?.developerText ?? "",
      );
      const originalPromptCacheKey =
        typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0
          ? String(payload.prompt_cache_key)
          : "";
      if (devAndUser && rootPromptRewrite && Array.isArray(payload?.input) && devAndUser.developerIndex >= 0) {
        payload.input[devAndUser.developerIndex] = {
          ...(devAndUser.developerItem ?? payload.input[devAndUser.developerIndex]),
          role: "developer",
          content: rootPromptRewrite.forwardedPromptText,
        };
        if (rootPromptRewrite.dynamicContextText && devAndUser.userIndex >= 0) {
          payload.input[devAndUser.userIndex] = {
            ...(devAndUser.userItem ?? payload.input[devAndUser.userIndex]),
            role: "user",
            content: prependTextToContent(
              (devAndUser.userItem ?? payload.input[devAndUser.userIndex])?.content,
              rootPromptRewrite.dynamicContextText,
            ),
          };
        }
      }
      const stableRewrite = rewritePayloadForStablePrefix(payload, model);
      const reductionApplied = cfg.modules.reduction
        ? await applyProxyReductionToInput(payload, {
          engine: cfg.reduction.engine,
          triggerMinChars: cfg.reduction.triggerMinChars,
          maxToolChars: cfg.reduction.maxToolChars,
        })
        : { changedItems: 0, changedBlocks: 0, savedChars: 0 };
      if (cfg.modules.reduction) {
        payload.__ecoclaw_reduction_applied = true;
      }
      stripInternalPayloadMarkers(payload);
      logger.info(
        `[ecoclaw] proxy request model=${model || "unknown"} upstreamModel=${upstreamModel || "unknown"} instrChars=${instructions.length} cacheKey=${stableRewrite.promptCacheKey} userContentRewrites=${stableRewrite.userContentRewrites} senderBlocks=${stableRewrite.senderMetadataBlocksBefore}->${stableRewrite.senderMetadataBlocksAfter} reductionEngine=${cfg.reduction.engine} reductionItems=${reductionApplied.changedItems} reductionBlocks=${reductionApplied.changedBlocks} reductionSavedChars=${reductionApplied.savedChars} reductionCandidates=${(reductionApplied as ProxyReductionResult).diagnostics?.candidateBlocks ?? 0} reductionOverThreshold=${(reductionApplied as ProxyReductionResult).diagnostics?.overThresholdBlocks ?? 0} reductionSkipped=${(reductionApplied as ProxyReductionResult).diagnostics?.skippedReason ?? "none"}`,
      );
      // Always log all proxy requests to a dedicated file for debugging
      {
        const proxyLogPath = join(cfg.stateDir, "ecoclaw", "proxy-requests.jsonl");
        const logRecord = {
          at: new Date().toISOString(),
          stage: "proxy_inbound",
          model,
          upstreamModel,
          upstreamBaseUrl: upstream.baseUrl,
          instructionsLength: instructions.length,
          instructions: String(payload?.instructions ?? ""),
          inputItemCount: Array.isArray(payload?.input) ? payload.input.length : -1,
          input: payload?.input,
          tools: payload?.tools,
          promptCacheKey: stableRewrite.promptCacheKey,
          developerRewritten: Boolean(rootPromptRewrite?.changed),
          developerRewriteWorkdir: rootPromptRewrite?.workdir ?? "",
          developerRewriteAgentId: rootPromptRewrite?.agentId ?? "",
          reductionChangedItems: reductionApplied.changedItems,
          reductionChangedBlocks: reductionApplied.changedBlocks,
          reductionSavedChars: reductionApplied.savedChars,
          reductionDiagnostics: (reductionApplied as ProxyReductionResult).diagnostics,
          reductionEngine: cfg.reduction.engine,
        };
        await mkdir(dirname(proxyLogPath), { recursive: true });
        await appendFile(proxyLogPath, `${JSON.stringify(logRecord)}\n`, "utf8");
      }
      if (cfg.debugTapProviderTraffic) {
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_inbound",
          model,
          upstreamModel,
          instructionsChars: instructions.length,
          inputChars: normalizeText(extractInputText(payload?.input)).length,
          devUserDetected: Boolean(devAndUser),
          firstTurnCandidate,
          developerChars: developerForwardedText.length,
          developerCanonicalChars: developerCanonicalText.length,
          developerRewritten: Boolean(rootPromptRewrite?.changed),
          developerRewriteWorkdir: rootPromptRewrite?.workdir ?? "",
          developerRewriteAgentId: rootPromptRewrite?.agentId ?? "",
          originalPromptCacheKey,
          rewrittenPromptCacheKey: stableRewrite.promptCacheKey,
          userContentRewrites: stableRewrite.userContentRewrites,
          senderMetadataBlocksBefore: stableRewrite.senderMetadataBlocksBefore,
          senderMetadataBlocksAfter: stableRewrite.senderMetadataBlocksAfter,
          reductionChangedItems: reductionApplied.changedItems,
          reductionChangedBlocks: reductionApplied.changedBlocks,
          reductionSavedChars: reductionApplied.savedChars,
          reductionDiagnostics: (reductionApplied as ProxyReductionResult).diagnostics,
          payload,
        };
        await mkdir(dirname(cfg.debugTapPath), { recursive: true });
        await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
      }
      payload.prompt_cache_retention = "24h";
      const upstreamResp = await fetch(`${upstream.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${upstream.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      let txt = await upstreamResp.text();
      let parsedResponseForMirror: any = null;
      const responseContentType = upstreamResp.headers.get("content-type") ?? "";
      const reductionMaxToolChars = Math.max(256, cfg.reduction.maxToolChars ?? 1200);
      const reductionTriggerMinChars = Math.max(256, cfg.reduction.triggerMinChars ?? 2200);
      try {
        parsedResponseForMirror = JSON.parse(txt);
      } catch {
        parsedResponseForMirror = null;
      }
      let afterCallReduction: ProxyAfterCallReductionResult | null = null;
      if (cfg.modules.reduction && cfg.reduction.engine === "layered") {
        if (parsedResponseForMirror) {
          try {
            afterCallReduction = await applyLayeredReductionAfterCall(
              payload,
              parsedResponseForMirror,
              reductionMaxToolChars,
              reductionTriggerMinChars,
            );
            if (afterCallReduction.changed) {
              txt = JSON.stringify(parsedResponseForMirror);
            }
            afterCallReduction = { ...afterCallReduction, mode: "json" };
          } catch {
            afterCallReduction = {
              changed: false,
              savedChars: 0,
              passCount: 0,
              skippedReason: "after_call_error",
              mode: "json",
            };
          }
        } else if (isSseContentType(responseContentType)) {
          try {
            const sseResult = await applyLayeredReductionAfterCallToSse(
              payload,
              txt,
              reductionMaxToolChars,
              reductionTriggerMinChars,
            );
            txt = sseResult.text;
            afterCallReduction = sseResult.reduction;
          } catch {
            afterCallReduction = {
              changed: false,
              savedChars: 0,
              passCount: 0,
              skippedReason: "after_call_sse_error",
              mode: "sse",
            };
          }
        } else {
          afterCallReduction = {
            changed: false,
            savedChars: 0,
            passCount: 0,
            skippedReason: "unsupported_response_shape",
          };
        }
      }
      {
        const proxyRespLogPath = join(cfg.stateDir, "ecoclaw", "proxy-responses.jsonl");
        const parsedResponse = parsedResponseForMirror;
        const respRecord = {
          at: new Date().toISOString(),
          stage: "proxy_response",
          model,
          upstreamModel,
          status: upstreamResp.status,
          promptCacheKey: payload?.prompt_cache_key,
          promptCacheRetention: payload?.prompt_cache_retention,
          responseId: parsedResponse?.id ?? null,
          previousResponseId: parsedResponse?.previous_response_id ?? null,
          responsePromptCacheKey: parsedResponse?.prompt_cache_key ?? null,
          responsePromptCacheRetention: parsedResponse?.prompt_cache_retention ?? null,
          usage: parsedResponse?.usage ?? null,
          afterCallReduction,
        };
        await mkdir(dirname(proxyRespLogPath), { recursive: true });
        await appendFile(proxyRespLogPath, `${JSON.stringify(respRecord)}\n`, "utf8");
      }
      {
        const forwardedRecord = {
          at: new Date().toISOString(),
          stage: "proxy_forwarded",
          model,
          upstreamModel,
          forwardedHasPrev: typeof payload?.previous_response_id === "string" && payload.previous_response_id.length > 0,
          forwardedPromptCacheKey:
            typeof payload?.prompt_cache_key === "string" ? payload.prompt_cache_key : null,
          forwardedPromptCacheRetention:
            typeof payload?.prompt_cache_retention === "string" ? payload.prompt_cache_retention : null,
          forwardedInputCount: Array.isArray(payload?.input) ? payload.input.length : -1,
          forwardedInputRoles: Array.isArray(payload?.input)
            ? payload.input.map((x: any) => String(x?.role ?? ""))
            : [],
          forwardedReductionChangedItems: reductionApplied.changedItems,
          forwardedReductionChangedBlocks: reductionApplied.changedBlocks,
          forwardedReductionSavedChars: reductionApplied.savedChars,
          afterCallReduction,
          forwardedDeveloperChars:
            Array.isArray(payload?.input) &&
            payload.input.length > 0 &&
            String(payload.input[0]?.role) === "developer" &&
            typeof payload.input[0]?.content === "string"
              ? String(payload.input[0].content).length
              : 0,
          payload,
        };
        await appendJsonl(cfg.debugTapPath, forwardedRecord);
      }
      if (cfg.debugTapProviderTraffic) {
        let parsedResponse: any = null;
        try {
          parsedResponse = JSON.parse(txt);
        } catch {}
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_outbound",
          model,
          upstreamModel,
          status: upstreamResp.status,
          responseId:
            typeof parsedResponse?.id === "string"
              ? parsedResponse.id
              : typeof parsedResponse?.response?.id === "string"
                ? parsedResponse.response.id
                : null,
          previousResponseId:
            typeof parsedResponse?.previous_response_id === "string"
              ? parsedResponse.previous_response_id
              : typeof parsedResponse?.response?.previous_response_id === "string"
                ? parsedResponse.response.previous_response_id
                : null,
          promptCacheKey:
            typeof parsedResponse?.prompt_cache_key === "string"
              ? parsedResponse.prompt_cache_key
              : typeof parsedResponse?.response?.prompt_cache_key === "string"
                ? parsedResponse.response.prompt_cache_key
                : null,
          promptCacheRetention:
            typeof parsedResponse?.prompt_cache_retention === "string"
              ? parsedResponse.prompt_cache_retention
              : typeof parsedResponse?.response?.prompt_cache_retention === "string"
                ? parsedResponse.response.prompt_cache_retention
                : null,
          usage:
            parsedResponse?.usage ??
            parsedResponse?.response?.usage ??
            null,
          afterCallReduction,
          responseText: txt,
        };
        await mkdir(dirname(cfg.debugTapPath), { recursive: true });
        await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
      }
      res.statusCode = upstreamResp.status;
      res.setHeader("content-type", upstreamResp.headers.get("content-type") ?? "application/json");
      res.end(txt);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.proxyPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const baseUrl = `http://127.0.0.1:${cfg.proxyPort}/v1`;
  logger.info(`[ecoclaw] embedded responses proxy listening at ${baseUrl}`);
  return {
    baseUrl,
    upstream,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = toJsonSafe(v, seen);
    }
    seen.delete(obj);
    return out;
  }
  return String(value);
}

async function appendJsonl(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(toJsonSafe(payload))}\n`, "utf8");
}

function resolveLlmHookTapPath(debugTapPath: string): string {
  if (debugTapPath.endsWith(".jsonl")) {
    return debugTapPath.slice(0, -".jsonl".length) + ".llm-hooks.jsonl";
  }
  return `${debugTapPath}.llm-hooks.jsonl`;
}

function installLlmHookTap(
  api: any,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
): void {
  if (!cfg.debugTapProviderTraffic) return;
  const llmHookTapPath = resolveLlmHookTapPath(cfg.debugTapPath);
  const hookNames = [
    "before_prompt_build",
    "before_agent_start",
    "llm_input",
    "llm_output",
    "session_start",
    "session_end",
    "before_reset",
    "agent_end",
  ];
  for (const hookName of hookNames) {
    hookOn(api, hookName, async (event: any) => {
      try {
        const turnObservations = extractTurnObservations(event);
        const rec = {
          at: new Date().toISOString(),
          hook: hookName,
          sessionKey: extractSessionKey(event),
          derived: {
            lastUserMessage: extractLastUserMessage(event),
            turnObservationCount: turnObservations.length,
            turnObservations,
          },
          event,
        };
        await appendJsonl(llmHookTapPath, rec);
      } catch (err) {
        logger.warn(
          `[ecoclaw] llm-hook tap write failed(${hookName}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
  logger.info(`[ecoclaw] LLM hook tap enabled. path=${llmHookTapPath}`);
}

async function purgeTaskCacheWorkspace(stateDir: string, taskId: string): Promise<{ purged: string[] }> {
  const sessionsDir = join(stateDir, "ecoclaw", "sessions");
  const targetPrefix = `ecoclaw-task-${safeId(taskId)}-s`;
  let entries: Array<{ isDirectory: () => boolean; name: string }>;
  try {
    entries = (await readdir(sessionsDir, { withFileTypes: true, encoding: "utf8" })) as Array<{
      isDirectory: () => boolean;
      name: string;
    }>;
  } catch {
    return { purged: [] };
  }

  const purged: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(targetPrefix)) continue;
    const fullPath = join(sessionsDir, entry.name);
    await rm(fullPath, { recursive: true, force: true });
    purged.push(fullPath);
  }
  return { purged };
}

function makeLogger(input?: PluginLogger): Required<PluginLogger> {
  return {
    info: input?.info ?? ((...args) => console.log(...args)),
    debug: input?.debug ?? (() => {}),
    warn: input?.warn ?? ((...args) => console.warn(...args)),
    error: input?.error ?? ((...args) => console.error(...args)),
  };
}

function hookOn(api: any, event: string, handler: (...args: any[]) => any): void {
  if (typeof api.on === "function") {
    api.on(event, handler);
    return;
  }
  if (typeof api.registerHook === "function") {
    api.registerHook(event, handler);
  }
}

function maybeRegisterProxyProvider(
  api: any,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
  baseUrl: string,
  upstream: UpstreamConfig,
) {
  if (typeof api.registerProvider !== "function") {
    logger.warn("[ecoclaw] registerProvider not supported by this OpenClaw version.");
    return;
  }

  try {
    const modelIds = upstream.models.map((m) => m.id);
    const modelDefs = upstream.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: "openai-responses",
      reasoning: m.reasoning,
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    api.registerProvider({
      id: "ecoclaw",
      name: "EcoClaw Router",
      label: "EcoClaw Router",
      api: "openai-responses",
      baseUrl,
      apiKey: cfg.proxyApiKey ?? "ecoclaw-local",
      authHeader: false,
      models: modelIds.length > 0 ? modelDefs : ["gpt-5.4"],
    });
    logger.info(
      `[ecoclaw] Registered provider ecoclaw/* via embedded proxy. mirrored=${modelIds.slice(0, 6).join(",")}${modelIds.length > 6 ? "..." : ""}`,
    );
  } catch (err: unknown) {
    logger.error(`[ecoclaw] Failed to register provider: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function extractSessionKey(event: any): string {
  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta;
  const direct =
    event?.sessionKey ??
    event?.SessionKey ??
    event?.result?.sessionKey ??
    event?.result?.SessionKey ??
    event?.meta?.sessionKey ??
    event?.meta?.SessionKey ??
    event?.ctx?.SessionKey ??
    event?.ctx?.CommandTargetSessionKey ??
    event?.session?.key ??
    event?.sessionId ??
    event?.result?.sessionId ??
    agentMeta?.sessionKey ??
    agentMeta?.sessionId ??
    "";
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();

  const channel = String(event?.channel ?? event?.from?.channel ?? "unknown").trim();
  const channelId = String(event?.channelId ?? event?.to?.id ?? event?.conversationId ?? "").trim();
  const threadId = String(event?.messageThreadId ?? event?.threadId ?? "").trim();
  const senderId = String(event?.senderId ?? event?.from?.id ?? "").trim();
  const scoped = [channel, channelId, threadId, senderId].filter((x) => x.length > 0);
  if (scoped.length > 0) return `scoped:${scoped.join(":")}`;

  return "unknown";
}

function extractOpenClawSessionId(event: any): string {
  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta;
  const direct =
    event?.sessionId ??
    event?.SessionId ??
    event?.ctx?.SessionId ??
    event?.result?.sessionId ??
    event?.result?.SessionId ??
    event?.meta?.sessionId ??
    event?.meta?.SessionId ??
    event?.session?.id ??
    agentMeta?.sessionId ??
    "";
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  return "";
}

function contentToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => contentToText(item))
      .filter((s) => s.trim().length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "thinking" || obj.type === "reasoning") {
      return "";
    }
    if (obj.type === "output_text" && typeof obj.text === "string") {
      return obj.text;
    }
    const preferred = obj.text ?? obj.content ?? obj.value ?? obj.message;
    if (preferred !== undefined) {
      const nested = contentToText(preferred);
      if (nested.trim().length > 0) return nested;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  }
  return String(value);
}

function extractResponseTextFromProviderNode(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return contentToText(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractResponseTextFromProviderNode(item))
      .filter((s) => s.trim().length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const type = String(obj.type ?? "").toLowerCase();
    const role = String(obj.role ?? "").toLowerCase();
    if (type === "output_text" && typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.delta === "string" && obj.delta.trim().length > 0) {
      return obj.delta;
    }
    if (type === "message" || role === "assistant") {
      return extractResponseTextFromProviderNode(obj.content ?? obj.output ?? obj.text);
    }
    return extractResponseTextFromProviderNode(
      obj.response ?? obj.output ?? obj.item ?? obj.content ?? obj.text ?? obj.message,
    );
  }
  return "";
}

function extractProviderResponseText(rawText: string, parsed?: unknown): string {
  const parsedRecord = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const parsedType = String(parsedRecord?.type ?? "").toLowerCase();
  const fromParsed =
    parsedType === "response.created"
      ? ""
      : extractResponseTextFromProviderNode(parsed);
  if (fromParsed.trim().length > 0) return fromParsed.trim();

  let deltaText = "";
  const lines = String(rawText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    try {
      const record = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      const type = String(record.type ?? "").toLowerCase();
      if (type === "response.created") continue;
      const fromRecord = extractResponseTextFromProviderNode(
        record.response ?? record.output ?? record.item ?? record,
      );
      if (fromRecord.trim().length > 0) return fromRecord.trim();
      if (typeof record.delta === "string") {
        deltaText += record.delta;
      }
    } catch {
      // ignore malformed stream fragments
    }
  }
  return deltaText.trim();
}

function extractLastUserMessage(event: any): string {
  const promptText = typeof event?.prompt === "string" ? event.prompt.trim() : "";
  if (promptText) return promptText;
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
  return contentToText(lastUser?.content ?? event?.message?.content ?? event?.message ?? "");
}

function extractLastAssistant(event: any): any {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const fromMessages = [...messages].reverse().find((m: any) => m?.role === "assistant");
  if (fromMessages) return fromMessages;

  const payloads = Array.isArray(event?.result?.payloads) ? event.result.payloads : [];
  if (payloads.length === 0) return null;
  const payloadText = payloads
    .map((payload: any) => contentToText(payload?.text ?? payload?.content ?? payload))
    .filter((s: string) => s.trim().length > 0)
    .join("\n");
  const lastPayload = payloads[payloads.length - 1];

  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta ?? {};
  const usage = agentMeta?.lastCallUsage ?? agentMeta?.usage ?? event?.usage ?? {};
  return {
    role: "assistant",
    content: payloadText || contentToText(lastPayload?.text ?? lastPayload?.content ?? ""),
    provider: agentMeta?.provider ?? event?.provider,
    model: agentMeta?.model ?? event?.model,
    usage,
  };
}

type StructuredTurnObservation = {
  id: string;
  role: "tool" | "observation";
  text: string;
  payloadKind?: "stdout" | "stderr" | "json" | "blob";
  toolName?: string;
  source: string;
  messageIndex?: number;
  mimeType?: string;
  textChars: number;
  textPreview: string;
  metadata?: Record<string, unknown>;
};

function inferObservationPayloadKind(
  text: string,
  fallback?: unknown,
): StructuredTurnObservation["payloadKind"] | undefined {
  if (typeof fallback === "string") {
    const normalized = fallback.trim().toLowerCase();
    if (
      normalized === "stdout" ||
      normalized === "stderr" ||
      normalized === "json" ||
      normalized === "blob"
    ) {
      return normalized;
    }
  }

  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (/^stderr\s*[:=-]/i.test(trimmed)) return "stderr";
  if (/^stdout\s*[:=-]/i.test(trimmed)) return "stdout";
  if (/^blob\s*[:=-]/i.test(trimmed)) return "blob";
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    // fall through
  }
  if (/^data:[^;]+;base64,/i.test(trimmed)) return "blob";
  if (/^[A-Za-z0-9+/=\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return "blob";
  return undefined;
}

function buildToolCallArgsMap(messages: any[]): Map<string, { toolName?: string; path?: string }> {
  const map = new Map<string, { toolName?: string; path?: string }>();
  for (const msg of messages) {
    const role = String(msg?.role ?? "").toLowerCase();
    if (role !== "assistant") continue;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "toolCall" && item.type !== "tool_call") continue;
      const callId =
        typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : undefined;
      if (!callId) continue;
      const toolName =
        typeof item.name === "string" && item.name.trim().length > 0
          ? item.name.trim()
          : undefined;
      const args =
        item.arguments && typeof item.arguments === "object"
          ? (item.arguments as Record<string, unknown>)
          : undefined;
      const path =
        typeof args?.path === "string" && args.path.trim().length > 0
          ? args.path.trim()
          : typeof args?.file_path === "string" && args.file_path.trim().length > 0
            ? args.file_path.trim()
            : typeof args?.filePath === "string" && args.filePath.trim().length > 0
              ? args.filePath.trim()
              : undefined;
      map.set(callId, { toolName, path });
    }
  }
  return map;
}

function extractTurnObservations(event: any): StructuredTurnObservation[] {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const toolCallArgsMap = buildToolCallArgsMap(messages);
  const out: StructuredTurnObservation[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const role = String(msg?.role ?? "").toLowerCase();
    if (role !== "tool" && role !== "observation" && role !== "toolresult") continue;
    const text = contentToText(msg?.content ?? msg?.text ?? "").trim();
    if (!text) continue;
    const payloadKind = inferObservationPayloadKind(
      text,
      msg?.payloadKind ?? msg?.kind ?? msg?.type,
    );
    const toolName =
      typeof msg?.name === "string" && msg.name.trim().length > 0
        ? msg.name.trim()
        : typeof msg?.toolName === "string" && msg.toolName.trim().length > 0
          ? msg.toolName.trim()
          : typeof msg?.tool_name === "string" && msg.tool_name.trim().length > 0
            ? msg.tool_name.trim()
            : undefined;
    const callId =
      typeof msg?.tool_call_id === "string" && msg.tool_call_id.trim().length > 0
        ? msg.tool_call_id.trim()
        : typeof msg?.toolCallId === "string" && msg.toolCallId.trim().length > 0
          ? msg.toolCallId.trim()
          : undefined;
    const toolCallArgs = callId ? toolCallArgsMap.get(callId) : undefined;
    const resolvedPath = toolCallArgs?.path;
    const metadata: Record<string, unknown> | undefined = resolvedPath
      ? { path: resolvedPath, file_path: resolvedPath }
      : undefined;
    out.push({
      id: callId ?? `msg-${i + 1}`,
      role: role === "tool" || role === "toolresult" ? "tool" : "observation",
      text,
      payloadKind,
      toolName: toolName ?? toolCallArgs?.toolName,
      source: "event.messages",
      messageIndex: i,
      mimeType:
        typeof msg?.mime_type === "string" && msg.mime_type.trim().length > 0
          ? msg.mime_type.trim()
          : typeof msg?.mimeType === "string" && msg.mimeType.trim().length > 0
            ? msg.mimeType.trim()
            : undefined,
      textChars: text.length,
      textPreview: text.length > 240 ? `${text.slice(0, 240)}...` : text,
      ...(metadata ? { metadata } : {}),
    });
  }
  return out;
}

function registerEcoClawCommand(
  api: any,
  logger: Required<PluginLogger>,
  topology: SessionTopologyManager,
  cfg: ReturnType<typeof normalizeConfig>,
): void {
  if (typeof api.registerCommand !== "function") {
    logger.debug("[ecoclaw] registerCommand unavailable, fallback to inline command parsing.");
    return;
  }

  const handler = async (ctxOrRaw?: any, legacyContext?: any) => {
    const args =
      typeof ctxOrRaw === "string"
        ? ctxOrRaw
        : typeof ctxOrRaw?.args === "string"
          ? ctxOrRaw.args
          : "";
    const context = legacyContext ?? ctxOrRaw ?? {};
    const cmd = parseEcoClawCommand(`ecoclaw ${String(args).trim()}`.trim());
    const sessionKey = extractSessionKey(context) || "unknown";
    logger.info(
      `[ecoclaw] command invoked kind=${cmd.kind} args="${String(args ?? "").trim()}" session=${sessionKey}`,
    );
    if (cmd.kind === "status") {
      return { text: topology.getStatus(sessionKey) };
    }
    if (cmd.kind === "cache_new") {
      const logical = topology.newTaskCache(sessionKey, cmd.taskId);
      return {
        text:
          `Created task-cache and switched current binding.\n${topology.getStatus(sessionKey)}\nlogical=${logical}\n\n` +
          `Reminder: this switches EcoClaw task-cache only.\n` +
          `If you want a truly clean upstream OpenClaw context, run /new now.`,
      };
    }
    if (cmd.kind === "cache_list") {
      return { text: topology.listTaskCaches(sessionKey) };
    }
    if (cmd.kind === "cache_delete") {
      const removed = topology.deleteTaskCache(sessionKey, cmd.taskId);
      if (!removed) {
        return { text: `No matching task-cache found for ${cmd.taskId ? `"${safeId(cmd.taskId)}"` : "current binding"}.` };
      }
      const purge = await purgeTaskCacheWorkspace(cfg.stateDir, removed.removedTaskId);
      return {
        text: `Deleted task-cache "${removed.removedTaskId}" (bindings=${removed.removedBindings}, purged=${purge.purged.length}).\n${topology.getStatus(sessionKey)}\nlogical=${removed.switchedToLogical}`,
      };
    }
    if (cmd.kind === "session_new") {
      const logical = topology.newSession(sessionKey);
      return { text: `Created new session in current task-cache.\n${topology.getStatus(sessionKey)}\nlogical=${logical}` };
    }
    return { text: commandHelpText() };
  };

  api.registerCommand({
    name: "ecoclaw",
    description: "EcoClaw task-cache/session controls (try: /ecoclaw help)",
    acceptsArgs: true,
    handler,
    execute: handler,
  });
  logger.debug("[ecoclaw] Registered /ecoclaw command.");
}

const __testHooks = {
  rewritePayloadForStablePrefix,
  applyProxyReductionToInput,
  stripInternalPayloadMarkers,
};

module.exports = {
  id: "ecoclaw",
  name: "EcoClaw Runtime Optimizer",
  __testHooks,

  register(api: any) {
    const logger = makeLogger(api?.logger);
    const cfg = normalizeConfig(api?.pluginConfig);
    const debugEnabled = cfg.logLevel === "debug";

    if (!cfg.enabled) {
      logger.info("[ecoclaw] Plugin disabled by config.");
      return;
    }

    const topology = createSessionTopologyManager();
    const recentTurnBindings: Array<{
      userMessage: string;
      matchKey: string;
      sessionKey: string;
      upstreamSessionId?: string;
      at: number;
    }> = [];
    const rememberTurnBinding = (userMessage: string, sessionKey: string, upstreamSessionId?: string) => {
      const normalizedMessage = String(userMessage ?? "").trim();
      const matchKey = normalizeTurnBindingMessage(normalizedMessage);
      const normalizedSessionKey = String(sessionKey ?? "").trim();
      if (!normalizedMessage || !matchKey || !normalizedSessionKey) return;
      recentTurnBindings.push({
        userMessage: normalizedMessage,
        matchKey,
        sessionKey: normalizedSessionKey,
        upstreamSessionId: String(upstreamSessionId ?? "").trim() || undefined,
        at: Date.now(),
      });
      while (recentTurnBindings.length > 128) recentTurnBindings.shift();
      if (cfg.stateDir) {
        persistRecentTurnBindingsToState(cfg.stateDir, recentTurnBindings);
      }
    };
    const resolveTurnBinding = (userMessage: string) => {
      const normalizedMessage = normalizeTurnBindingMessage(String(userMessage ?? "").trim());
      if (!normalizedMessage) return null;
      const persistedCandidates = cfg.stateDir ? loadRecentTurnBindingsFromState(cfg.stateDir) : [];
      const candidates = [...recentTurnBindings, ...persistedCandidates];
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const candidate = candidates[i];
        if (candidate.matchKey !== normalizedMessage) continue;
        if (Date.now() - candidate.at > 30 * 60 * 1000) continue;
        return candidate;
      }
      return null;
    };
    let proxyRuntime: Awaited<ReturnType<typeof startEmbeddedResponsesProxy>> | null = null;
    let proxyInitDone = false;
    let proxyInitPromise: Promise<void> | null = null;

    const ensureProxyReady = async (): Promise<void> => {
      if (proxyInitDone) return;
      if (proxyInitPromise) return proxyInitPromise;
      proxyInitPromise = (async () => {
        const g = globalThis as any;
        const existing = g.__ecoclaw_embedded_proxy_runtime__;
        if (existing && existing.baseUrl && existing.upstream) {
          proxyRuntime = existing;
          proxyInitDone = true;
          return;
        }
        proxyRuntime = await startEmbeddedResponsesProxy(
          cfg,
          logger,
        );
        if (!proxyRuntime) return;
        g.__ecoclaw_embedded_proxy_runtime__ = proxyRuntime;
        maybeRegisterProxyProvider(api, cfg, logger, proxyRuntime.baseUrl, proxyRuntime.upstream);
        await ensureExplicitProxyModelsInConfig(proxyRuntime.baseUrl, proxyRuntime.upstream, logger);
        proxyInitDone = true;
      })().catch((err) => {
        logger.warn(`[ecoclaw] embedded proxy init failed: ${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => {
        proxyInitPromise = null;
      });
      return proxyInitPromise;
    };

    installLlmHookTap(api, cfg, logger);
    registerEcoClawCommand(api, logger, topology, cfg);
    hookOn(api, "session_start", (event: any) => {
      const sessionKey = extractSessionKey(event);
      const upstreamSessionId = extractOpenClawSessionId(event);
      if (!sessionKey || !upstreamSessionId) return;
      topology.bindUpstreamSession(sessionKey, upstreamSessionId);
      if (debugEnabled) {
        logger.debug(
          `[ecoclaw] session_start synced sessionKey=${sessionKey} openclawSessionId=${upstreamSessionId} ${topology.getStatus(sessionKey)}`,
        );
      }
    });
    hookOn(api, "message_received", (event: any) => {
      const sessionKey = extractSessionKey(event);
      const upstreamSessionId =
        extractOpenClawSessionId(event) || topology.getUpstreamSessionId(sessionKey) || undefined;
      const userMessage = extractLastUserMessage(event);
      if (userMessage.trim()) {
        rememberTurnBinding(userMessage, sessionKey, upstreamSessionId);
      }
      const cmd = parseEcoClawCommand(userMessage);
      if (cmd.kind !== "none") {
        if (cmd.kind === "status") {
          logger.info(`[ecoclaw] ${topology.getStatus(sessionKey)}`);
        } else if (cmd.kind === "cache_new") {
          const logical = topology.newTaskCache(sessionKey, cmd.taskId);
          logger.info(`[ecoclaw] cache new -> ${topology.getStatus(sessionKey)} logical=${logical}`);
        } else if (cmd.kind === "cache_delete") {
          const removed = topology.deleteTaskCache(sessionKey, cmd.taskId);
          if (!removed) {
            logger.info(
              `[ecoclaw] cache delete -> no matching task-cache for ${cmd.taskId ? safeId(cmd.taskId) : "current"}`,
            );
          } else {
            void purgeTaskCacheWorkspace(cfg.stateDir, removed.removedTaskId)
              .then((purge) => {
                logger.info(
                  `[ecoclaw] cache delete -> removed=${removed.removedTaskId} bindings=${removed.removedBindings} purged=${purge.purged.length} now=${topology.getStatus(sessionKey)} logical=${removed.switchedToLogical}`,
                );
              })
              .catch((err) => {
                logger.warn(
                  `[ecoclaw] cache delete purge failed for ${removed.removedTaskId}: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
          }
        } else if (cmd.kind === "session_new") {
          const logical = topology.newSession(sessionKey);
          logger.info(
            `[ecoclaw] session new -> ${topology.getStatus(sessionKey)} logical=${logical}`,
          );
        } else if (cmd.kind === "openclaw_session_new") {
          logger.info(
            `[ecoclaw] observed native /new on ${sessionKey}; waiting for OpenClaw session_start to publish the new sessionId`,
          );
        } else {
          logger.info(`[ecoclaw] ${commandHelpText().replace(/\n/g, " | ")}`);
        }
      }
      if (!debugEnabled) return;
      logger.debug(`[ecoclaw] message_received session=${sessionKey}`);
    });
    hookOn(api, "llm_input", (event: any) => {
      const userMessage = extractLastUserMessage(event);
      const upstreamSessionId = extractOpenClawSessionId(event);
      const sessionKey = upstreamSessionId || extractSessionKey(event);
      if (userMessage.trim() && sessionKey.trim()) {
        rememberTurnBinding(userMessage, sessionKey, upstreamSessionId || undefined);
        if (upstreamSessionId) {
          topology.bindUpstreamSession(sessionKey, upstreamSessionId);
        }
      }
      if (!debugEnabled) return;
      logger.debug(
        `[ecoclaw] llm_input prompt-bound session=${sessionKey || "unknown"} openclawSessionId=${upstreamSessionId || "-"}`,
      );
    });

    if (typeof api.registerService === "function") {
      api.registerService({
        id: "ecoclaw-runtime",
        start: () => {
          void ensureProxyReady();
          logger.info("[ecoclaw] Plugin active.");
          if (proxyRuntime?.baseUrl) {
            logger.info(`[ecoclaw] Embedded proxy active at ${proxyRuntime.baseUrl}`);
          } else {
            logger.info("[ecoclaw] Embedded proxy unavailable; ecoclaw provider was not registered.");
          }
          logger.info("[ecoclaw] Use explicit model key: ecoclaw/<model> (example: ecoclaw/gpt-5.4).");
          logger.info(`[ecoclaw] State dir=${cfg.stateDir} debugTap=${cfg.debugTapProviderTraffic ? "on" : "off"}`);
        },
        stop: () => {
          if (proxyRuntime) {
            void proxyRuntime.close().catch((err) => {
              logger.warn(
                `[ecoclaw] embedded proxy stop failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
            const g = globalThis as any;
            if (g.__ecoclaw_embedded_proxy_runtime__ === proxyRuntime) {
              delete g.__ecoclaw_embedded_proxy_runtime__;
            }
            proxyRuntime = null;
            proxyInitDone = false;
          }
          logger.info("[ecoclaw] Plugin stopped.");
        },
      });
    }
  },
};
