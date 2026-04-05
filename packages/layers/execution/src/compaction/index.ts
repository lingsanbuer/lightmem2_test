import {
  ECOCLAW_EVENT_TYPES,
  appendResultEvent,
  findRuntimeEventsByType,
  type RuntimeModule,
  type RuntimeModuleRuntime,
  type RuntimeTurnContext,
} from "@ecoclaw/kernel";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  clipText,
  contextToConversationBlocks,
  countRoles,
  generateSemanticText,
  latestBlockByRole,
  totalBlockChars,
  uniqueNonEmpty,
  type ConversationBlock,
  type SemanticGenerationMode,
} from "../semantic/index.js";
import { buildCompactionPlan } from "./plan-builder.js";
import {
  resolveCompactionPrompt,
  resolveResumePrefixPrompt,
} from "./prompt-loader.js";
import type {
  CompactionArtifact,
  CompactionModuleConfig,
  RecentMessage,
} from "./types.js";

export * from "./types.js";
export * from "./plan-builder.js";
export * from "./strategy-registry.js";
export * from "./strategy-summary-then-fork.js";

type TurnLocalCandidate = {
  sourceIndex: number;
  sourceSegmentId: string;
  sourceToolName: string;
  sourceDataKey: string;
  sourceText: string;
  writeIndex: number;
  writeSegmentId: string;
  writeToolName: string;
  writeText: string;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeToolName(metadata: Record<string, unknown> | undefined): string | undefined {
  const toolPayload = asObject(metadata?.toolPayload);
  const directToolName = typeof metadata?.toolName === "string" ? metadata.toolName : undefined;
  const payloadToolName =
    typeof toolPayload?.toolName === "string" ? (toolPayload.toolName as string) : undefined;
  const raw = directToolName ?? payloadToolName;
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function extractDataKey(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const toolPayload = asObject(metadata?.toolPayload);
  const candidates = [
    metadata?.path,
    metadata?.file_path,
    metadata?.filePath,
    toolPayload?.path,
    toolPayload?.file_path,
    toolPayload?.filePath,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function isSuccessfulWriteLike(text: string): boolean {
  const lowered = text.toLowerCase();
  if (/successfully (wrote|updated|edited|applied)/i.test(text)) return true;
  if (lowered.includes('"status":"success"') || lowered.includes('"status": "success"')) return true;
  if (lowered.includes("'status': 'success'")) return true;
  return false;
}

/**
 * Detects read operations that have been "consumed" by subsequent write operations.
 *
 * Strategy (方案 4 - simple heuristic):
 * - When a write is detected, compact ALL read results that appeared before it
 * - This assumes writes "consume" the context from prior reads
 * - Window is unlimited: compact ALL reads before a write (not just recent N turns)
 * - No "first read protection" - if a write happened, all prior reads are assumed consumed
 *
 * Note: This is a simple starting point. Future iterations may add:
 * - Content-based matching (check if write content references read content)
 * - Locality signals (protect reads that are re-read frequently)
 */
function detectConsumedReads(
  ctx: RuntimeTurnContext,
  policyCandidateMessageIds?: string[],
): TurnLocalCandidate[] {
  const candidates: TurnLocalCandidate[] = [];
  const processedReads = new Set<number>();

  // Window is unlimited: compact all reads before a write
  // No need to count turns - just find reads that came before writes

  // Build a set of segment IDs that policy has marked as candidates
  const policyCandidateSet = policyCandidateMessageIds
    ? new Set(policyCandidateMessageIds)
    : null;

  // Find all reads in the context
  const readIndices: number[] = [];
  for (let i = 0; i < ctx.segments.length; i += 1) {
    const segment = ctx.segments[i];
    const meta = asObject(segment.metadata);
    const tool = normalizeToolName(meta);
    if (tool !== "read" && tool !== "exec") continue;
    const dataKey = extractDataKey(meta);
    if (!dataKey) continue;
    readIndices.push(i);
  }

  // Find all writes in the context
  const writeIndices: number[] = [];
  for (let i = 0; i < ctx.segments.length; i += 1) {
    const segment = ctx.segments[i];
    const meta = asObject(segment.metadata);
    const tool = normalizeToolName(meta);
    if (tool !== "write" && tool !== "edit") continue;
    if (!isSuccessfulWriteLike(segment.text)) continue;
    writeIndices.push(i);
  }

  if (writeIndices.length === 0 || readIndices.length === 0) {
    return []; // No writes or no reads found, nothing to compact
  }

  // For each write, compact all reads that came before it
  for (const writeIndex of writeIndices) {
    // Find all reads before this write
    for (let i = 0; i < writeIndex; i += 1) {
      if (processedReads.has(i)) continue;

      const segment = ctx.segments[i];
      const meta = asObject(segment.metadata);
      const tool = normalizeToolName(meta);
      if (tool !== "read" && tool !== "exec") continue;

      const dataKey = extractDataKey(meta);
      if (!dataKey) continue;

      // If policy provided candidate IDs, check if this segment is a candidate
      if (policyCandidateSet && !policyCandidateSet.has(segment.id)) {
        continue;
      }

      const writeSegment = ctx.segments[writeIndex];
      const writeMeta = asObject(writeSegment.metadata);

      candidates.push({
        sourceIndex: i,
        sourceSegmentId: segment.id,
        sourceToolName: tool,
        sourceDataKey: dataKey,
        sourceText: segment.text,
        writeIndex: writeIndex,
        writeSegmentId: writeSegment.id,
        writeToolName: normalizeToolName(writeMeta) ?? "write_or_edit",
        writeText: writeSegment.text,
      });

      processedReads.add(i);
    }
  }

  return candidates;
}

function pickTurnLocalCandidates(
  ctx: RuntimeTurnContext,
  policyCandidateMessageIds?: string[],
): TurnLocalCandidate[] {
  // Use the new consumption-based detection (方案 4)
  const consumedReadCandidates = detectConsumedReads(ctx, policyCandidateMessageIds);

  // Also include the original repeated-read detection for cases where
  // model re-reads the same content (locality signal)
  const repeatedReadCandidates = pickRepeatedReadCandidates(ctx, policyCandidateMessageIds);

  // Combine both strategies, avoiding duplicates
  const seenIndices = new Set<number>();
  const allCandidates: TurnLocalCandidate[] = [];

  for (const c of consumedReadCandidates) {
    if (!seenIndices.has(c.sourceIndex)) {
      allCandidates.push(c);
      seenIndices.add(c.sourceIndex);
    }
  }

  for (const c of repeatedReadCandidates) {
    if (!seenIndices.has(c.sourceIndex)) {
      allCandidates.push(c);
      seenIndices.add(c.sourceIndex);
    }
  }

  return allCandidates;
}

/**
 * Original repeated-read detection logic - detects when model reads same content multiple times.
 * This is a locality-based signal: if model re-reads same content, it hasn't "consumed" it yet.
 */
function pickRepeatedReadCandidates(
  ctx: RuntimeTurnContext,
  policyCandidateMessageIds?: string[],
): TurnLocalCandidate[] {
  const candidates: TurnLocalCandidate[] = [];
  const processedReads = new Set<number>();

  // Build a set of segment IDs that policy has marked as candidates
  const policyCandidateSet = policyCandidateMessageIds
    ? new Set(policyCandidateMessageIds)
    : null;

  // Strategy: For repeated reads of the SAME CONTENT, keep only the FIRST read.
  // All subsequent reads with identical content can be compacted.
  // We group by content hash, not just file path, to handle cases where
  // the file was modified between reads.

  // Group reads by content hash (not just path)
  const readsByContentHash = new Map<string, { index: number; dataKey: string; segmentId: string }[]>();

  for (let i = 0; i < ctx.segments.length; i += 1) {
    const segment = ctx.segments[i];
    const meta = asObject(segment.metadata);
    const tool = normalizeToolName(meta);
    if (tool !== "read" && tool !== "exec") continue;
    const dataKey = extractDataKey(meta);
    if (!dataKey) continue;

    // Use content hash as the grouping key
    const contentHash = hashText(segment.text);
    const hashKey = `${dataKey}:${contentHash}`; // Include path in key to avoid false positives

    const existing = readsByContentHash.get(hashKey) ?? [];
    existing.push({ index: i, dataKey, segmentId: segment.id });
    readsByContentHash.set(hashKey, existing);
  }

  // For each group of reads with identical content, compact all except the first
  for (const [hashKey, readInfos] of readsByContentHash.entries()) {
    if (readInfos.length <= 1) continue; // No repeated reads of same content

    const dataKey = readInfos[0].dataKey;
    const readIndices = readInfos.map(r => r.index);

    // If policy provided candidate IDs, filter to only those
    if (policyCandidateSet) {
      const hasPolicyCandidate = readInfos.some(r => policyCandidateSet.has(r.segmentId));
      if (!hasPolicyCandidate) continue;
    }

    // Check if there's a write that consumed these reads
    // Find the first write after the last read of this content
    const lastReadIndex = readIndices[readIndices.length - 1];
    let firstWriteAfterLastRead = -1;

    for (let j = lastReadIndex + 1; j < ctx.segments.length; j += 1) {
      const writeSeg = ctx.segments[j];
      const writeMeta = asObject(writeSeg.metadata);
      const writeTool = normalizeToolName(writeMeta);
      if (writeTool !== "write" && writeTool !== "edit") continue;
      if (!isSuccessfulWriteLike(writeSeg.text)) continue;
      firstWriteAfterLastRead = j;
      break;
    }

    if (firstWriteAfterLastRead < 0) continue; // No write found after reads

    // Check if there's a re-read of the same content after the write
    let rereadAfterWrite = false;
    for (let k = firstWriteAfterLastRead + 1; k < ctx.segments.length; k += 1) {
      const check = ctx.segments[k];
      const checkMeta = asObject(check.metadata);
      const checkTool = normalizeToolName(checkMeta);
      if (checkTool !== "read" && checkTool !== "exec") continue;
      const checkDataKey = extractDataKey(checkMeta);
      if (checkDataKey === dataKey && check.text === ctx.segments[lastReadIndex].text) {
        rereadAfterWrite = true;
        break;
      }
    }

    if (rereadAfterWrite) continue; // Don't compact if same content is re-read after write

    // Compact all reads except the first one
    for (let idx = 1; idx < readIndices.length; idx += 1) {
      const readIdx = readIndices[idx];
      if (processedReads.has(readIdx)) continue;

      const readSegment = ctx.segments[readIdx];
      const readMeta = asObject(readSegment.metadata);

      candidates.push({
        sourceIndex: readIdx,
        sourceSegmentId: readSegment.id,
        sourceToolName: normalizeToolName(readMeta) ?? "read_or_exec",
        sourceDataKey: dataKey,
        sourceText: readSegment.text,
        writeIndex: firstWriteAfterLastRead,
        writeSegmentId: ctx.segments[firstWriteAfterLastRead].id,
        writeToolName: normalizeToolName(asObject(ctx.segments[firstWriteAfterLastRead].metadata)) ?? "write_or_edit",
        writeText: ctx.segments[firstWriteAfterLastRead].text,
      });

      processedReads.add(readIdx);
    }
  }

  return candidates;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function defaultArchiveDir(sessionId: string): string {
  // Use absolute path based on user's home directory
  const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
  return join(homeDir, ".openclaw", "ecoclaw-plugin-state", "ecoclaw", "context-store", sanitizePathPart(sessionId));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildCompactedStub(candidate: TurnLocalCandidate, archivePath: string): string {
  const writePreview = clipText(candidate.writeText, 220);
  return (
    `[Archived ${candidate.sourceToolName} result for \`${candidate.sourceDataKey}\`] ` +
    `This content was consumed by a subsequent ${candidate.writeToolName} operation. ` +
    `The ${candidate.writeToolName} produced: "${writePreview}". ` +
    `Full archive: ${archivePath}`
  );
}

async function runTurnLocalEvidenceCompaction(
  ctx: RuntimeTurnContext,
  cfg: CompactionModuleConfig,
): Promise<{ turnCtx: RuntimeTurnContext; changed: boolean; compactedCount: number; archives: string[] }> {
  const enabled = cfg.turnLocalCompaction?.enabled ?? false;
  if (!enabled) {
    return { turnCtx: ctx, changed: false, compactedCount: 0, archives: [] };
  }

  // Debug logging
  const debugLog = (msg: string) => {
    console.log(`[compaction:turn-local] ${msg}`);
  };

  debugLog(`Checking turn-local compaction. segments.length=${ctx.segments.length}`);

  // Check policy decision for turn-local compaction
  const policyLocality = ctx.metadata?.policy?.decisions?.locality as Record<string, unknown> | undefined;
  const turnLocalCandidateIds = Array.isArray(policyLocality?.turnLocalCandidateMessageIds)
    ? policyLocality.turnLocalCandidateMessageIds as string[]
    : [];
  const policyDelayTurns = typeof policyLocality?.turnLocalDelayTurns === "number"
    ? policyLocality.turnLocalDelayTurns
    : 0;

  // If policy specifies a delay, check if enough turns have passed
  if (policyDelayTurns > 0) {
    const completedTurns = ctx.metadata?.policy?.state?.completedTurns as number | undefined;
    if (completedTurns === undefined || completedTurns < policyDelayTurns) {
      // Not enough turns have passed yet, skip compaction this turn
      return { turnCtx: ctx, changed: false, compactedCount: 0, archives: [] };
    }
  }

  const candidates = pickTurnLocalCandidates(ctx, turnLocalCandidateIds.length > 0 ? turnLocalCandidateIds : undefined);
  if (candidates.length === 0) {
    debugLog(`No candidates found. reads/writes may not match pattern.`);
    return { turnCtx: ctx, changed: false, compactedCount: 0, archives: [] };
  }

  debugLog(`Found ${candidates.length} candidates for turn-local compaction`);

  const archiveDir = cfg.turnLocalCompaction?.archiveDir ?? defaultArchiveDir(ctx.sessionId);
  const timestamp = Date.now();
  const archives: string[] = [];
  const replacements = new Map<number, string>();

  for (let idx = 0; idx < candidates.length; idx += 1) {
    const candidate = candidates[idx];
    const fileName = `${timestamp}-${String(idx + 1).padStart(3, "0")}-${sanitizePathPart(candidate.sourceSegmentId)}.json`;
    const archivePath = join(archiveDir, fileName);
    debugLog(`Archiving candidate ${idx + 1}/${candidates.length}: ${candidate.sourceToolName}(${candidate.sourceDataKey}) -> ${candidate.writeToolName}`);
    debugLog(`  Archive path: ${archivePath}`);
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(
      archivePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "turn_local_tool_result_archive",
          sessionId: ctx.sessionId,
          sourceSegmentId: candidate.sourceSegmentId,
          sourceToolName: candidate.sourceToolName,
          sourceDataKey: candidate.sourceDataKey,
          sourceText: candidate.sourceText,
          sourceTextHash: hashText(candidate.sourceText),
          consumedBy: {
            writeSegmentId: candidate.writeSegmentId,
            writeToolName: candidate.writeToolName,
            writeTextPreview: clipText(candidate.writeText, 320),
          },
          archivedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    replacements.set(candidate.sourceIndex, buildCompactedStub(candidate, archivePath));
    archives.push(archivePath);
  }

  const nextSegments = ctx.segments.map((segment, index) => {
    const replacement = replacements.get(index);
    if (!replacement) return segment;
    const metadata = asObject(segment.metadata) ?? {};
    return {
      ...segment,
      text: replacement,
      metadata: {
        ...metadata,
        compaction: {
          ...(asObject(metadata.compaction) ?? {}),
          kind: "turn_local_evidence_compaction",
          archived: true,
        },
      },
    };
  });

  return {
    turnCtx: {
      ...ctx,
      segments: nextSegments,
      metadata: {
        ...(ctx.metadata ?? {}),
        compaction: {
          ...(asObject(ctx.metadata?.compaction) ?? {}),
          turnLocal: {
            compactedCount: candidates.length,
            archivePaths: archives,
          },
        },
      },
    },
    changed: true,
    compactedCount: candidates.length,
    archives,
  };
}

function buildRecentMessages(blocks: ConversationBlock[]): RecentMessage[] {
  const userAssistant = blocks.filter(
    (block) => block.role === "user" || block.role === "assistant",
  );
  const recent = userAssistant.slice(-6);
  return recent.map((block, index) => ({
    index: index + 1,
    at: block.at,
    user: block.role === "user" ? clipText(block.text, 240) : undefined,
    assistant: block.role === "assistant" ? clipText(block.text, 240) : undefined,
  }));
}

export function buildHeuristicCompactionText(blocks: ConversationBlock[]): string {
  const latestUser = clipText(latestBlockByRole(blocks, "user")?.text, 260) || "(none)";
  const latestAssistant =
    clipText(latestBlockByRole(blocks, "assistant")?.text, 260) || "(none)";
  const systemHighlights = uniqueNonEmpty(
    blocks
      .filter((block) => block.role === "system" || block.role === "context")
      .slice(-4)
      .map((block) => clipText(block.text, 220)),
    4,
  );
  const toolHighlights = uniqueNonEmpty(
    blocks
      .filter((block) => block.role === "tool")
      .slice(-3)
      .map((block) => clipText(block.text, 220)),
    3,
  );

  return [
    "## Current Progress",
    `- Latest user intent: ${latestUser}`,
    `- Latest assistant state: ${latestAssistant}`,
    "",
    "## Important Context",
    ...(systemHighlights.length > 0
      ? systemHighlights.map((item) => `- ${item}`)
      : ["- (none)"]),
    "",
    "## Tool Findings",
    ...(toolHighlights.length > 0 ? toolHighlights.map((item) => `- ${item}`) : ["- (none)"]),
    "",
    "## Next Steps",
    `- Continue from the latest user intent: ${latestUser}`,
    latestAssistant !== "(none)"
      ? `- Preserve the latest assistant progress: ${latestAssistant}`
      : "- Re-establish the current task state before proceeding.",
  ].join("\n");
}

function resolveCompactionGenerationMode(
  ctx: RuntimeTurnContext,
  fallback: "llm_full_context" | "heuristic",
): "llm_full_context" | "heuristic" {
  const policy =
    ctx.metadata?.policy && typeof ctx.metadata.policy === "object"
      ? (ctx.metadata.policy as Record<string, unknown>)
      : undefined;
  const decisions =
    policy?.decisions && typeof policy.decisions === "object"
      ? (policy.decisions as Record<string, unknown>)
      : undefined;
  const compaction =
    decisions?.compaction && typeof decisions.compaction === "object"
      ? (decisions.compaction as Record<string, unknown>)
      : undefined;
  const mode = compaction?.generationMode;
  return mode === "heuristic" || mode === "llm_full_context" ? mode : fallback;
}

function normalizeCompactionGenerationMode(
  mode: SemanticGenerationMode | undefined,
): "llm_full_context" | "heuristic" {
  return mode === "llm_full_context" ? "llm_full_context" : "heuristic";
}

function buildCompactionInstruction(promptText: string, blocks: ConversationBlock[], triggerSources: string[]): string {
  const triggerLine = triggerSources.length > 0 ? triggerSources.join(", ") : "manual";
  return [
    promptText,
    "",
    `Selected block count: ${blocks.length}`,
    `Selected character count: ${totalBlockChars(blocks)}`,
    `Trigger sources: ${triggerLine}`,
    "Return a self-contained checkpoint summary for later continuation.",
  ].join("\n");
}

export async function generateCompactionArtifact(params: {
  blocks: ConversationBlock[];
  requestedByPolicy?: boolean;
  triggerSources?: string[];
  cfg?: CompactionModuleConfig;
  runtime?: RuntimeModuleRuntime;
  runtimeContext?: RuntimeTurnContext;
}): Promise<CompactionArtifact> {
  const {
    blocks,
    requestedByPolicy = false,
    triggerSources = [],
    cfg = {},
    runtime,
    runtimeContext,
  } = params;
  const resolvedCompactionPrompt = await resolveCompactionPrompt({
    inline: cfg.compactionPrompt,
    path: cfg.compactionPromptPath,
  });
  const resolvedResumePrefixPrompt = await resolveResumePrefixPrompt({
    inline: cfg.resumePrefixPrompt,
    path: cfg.resumePrefixPromptPath,
  });
  const heuristicText = buildHeuristicCompactionText(blocks);
  const semantic = await generateSemanticText({
    purpose: "compaction-checkpoint",
    blocks,
    instruction: buildCompactionInstruction(resolvedCompactionPrompt.text, blocks, triggerSources),
    heuristicText,
    mode: cfg.generationMode ?? "heuristic",
    fallbackToHeuristic: cfg.fallbackToHeuristic ?? true,
    runtime,
    runtimeContext,
    provider: cfg.compactionProvider,
    model: cfg.compactionModel,
    maxOutputTokens: Math.max(128, cfg.compactionMaxOutputTokens ?? 1200),
    sessionTag: "compaction-sidecar",
  });
  const summaryText = semantic.text;
  const resumePrefixPrompt = resolvedResumePrefixPrompt.text;
  const seedSummary = [resumePrefixPrompt, summaryText].filter(Boolean).join("\n\n");

  return {
    schemaVersion: 1,
    compactionId: `compaction-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    kind: "checkpoint_seed",
    requestedByPolicy,
    triggerSources,
    strategy: "summary_then_fork",
    sourceBlockIds: blocks.map((block) => block.id),
    stats: {
      sourceBlockCount: blocks.length,
      sourceChars: totalBlockChars(blocks),
      roleCounts: countRoles(blocks),
    },
    recentMessages: buildRecentMessages(blocks),
    summaryText,
    resumePrefixPrompt,
    seedSummary,
    promptConfig: {
      compactionPromptSource: resolvedCompactionPrompt.source,
      compactionPromptPath: resolvedCompactionPrompt.path,
      compactionPromptError: resolvedCompactionPrompt.error,
      resumePrefixPromptSource: resolvedResumePrefixPrompt.source,
      resumePrefixPromptPath: resolvedResumePrefixPrompt.path,
      resumePrefixPromptError: resolvedResumePrefixPrompt.error,
    },
    generation: semantic.generation,
  };
}

function readTriggerSources(ctx: RuntimeTurnContext): string[] {
  const requests = findRuntimeEventsByType(
    ctx.metadata,
    ECOCLAW_EVENT_TYPES.POLICY_COMPACTION_REQUESTED,
  );
  return uniqueNonEmpty(
    requests.flatMap((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const reasons = Array.isArray(payload.reasons)
        ? payload.reasons.map((item) => String(item ?? ""))
        : [];
      return [event.source, ...reasons];
    }),
    8,
  );
}

export function createCompactionModule(cfg: CompactionModuleConfig = {}): RuntimeModule {
  const strategy = cfg.strategy ?? "summary_then_fork";

  return {
    name: "module-compaction",
    async beforeCall(ctx) {
      const turnLocal = await runTurnLocalEvidenceCompaction(ctx, cfg);
      return turnLocal.turnCtx;
    },
    async afterCall(ctx, result, runtime) {
      // First, run turn-local compaction on the completed turn
      // This handles the case where read and write happen in the same turn
      const turnLocal = await runTurnLocalEvidenceCompaction(ctx, cfg);
      const finalResult = turnLocal.changed
        ? {
            ...result,
            metadata: {
              ...(result.metadata ?? {}),
              compaction: {
                ...(result.metadata?.compaction as Record<string, unknown> ?? {}),
                turnLocal: {
                  compactedCount: turnLocal.compactedCount,
                  archivePaths: turnLocal.archives,
                },
              },
            },
          }
        : result;

      // Then, handle policy-triggered compaction (existing logic)
      const policyEvents = findRuntimeEventsByType(
        ctx.metadata,
        ECOCLAW_EVENT_TYPES.POLICY_COMPACTION_REQUESTED,
      );
      if (policyEvents.length === 0) return finalResult;

      const triggerSources = readTriggerSources(ctx);
      const generationMode = resolveCompactionGenerationMode(
        ctx,
        normalizeCompactionGenerationMode(cfg.generationMode),
      );
      const blocks = contextToConversationBlocks({
        ctx,
        result,
        includeAssistantReply: cfg.includeAssistantReply ?? true,
      });
      const artifact = await generateCompactionArtifact({
        blocks,
        requestedByPolicy: true,
        triggerSources,
        cfg: {
          ...cfg,
          generationMode,
        },
        runtime,
        runtimeContext: ctx,
      });
      const createdAt = new Date().toISOString();
      const latestPolicyEvent = policyEvents[policyEvents.length - 1];
      const triggerPayload = (latestPolicyEvent?.payload ?? {}) as Record<string, unknown>;
      const plan = buildCompactionPlan({
        strategy,
        strategies: cfg.strategies,
        artifact,
        triggerReasons: triggerPayload.reasons,
        createdAt,
      });
      if (!plan) return result;

      return appendResultEvent(
        {
          ...finalResult,
          metadata: {
            ...(finalResult.metadata ?? {}),
            compaction: {
              requestedByPolicy: true,
              triggerSources,
              artifact,
              plan,
            },
            compactionPlan: plan,
          },
        },
        {
          type: ECOCLAW_EVENT_TYPES.COMPACTION_PLAN_GENERATED,
          source: "module-compaction",
          at: createdAt,
          payload: plan,
        },
      );
    },
  };
}
