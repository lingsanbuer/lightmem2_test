import {
  ECOCLAW_EVENT_TYPES,
  appendResultEvent,
  findRuntimeEventsByType,
  type RuntimeModule,
  type RuntimeModuleRuntime,
  type RuntimeTurnContext,
  type RuntimeTurnResult,
  type UsageSnapshot,
} from "@ecoclaw/kernel";
import {
  resolveResumePrefixPrompt,
  resolveSummaryPrompt,
} from "./prompt-loader.js";

export type SummaryModuleConfig = {
  idleTriggerMinutes?: number;
  recentTurns?: number;
  stableHighlightCount?: number;
  volatileHighlightCount?: number;
  progressHighlightCount?: number;
  generationMode?: "llm_full_context" | "heuristic";
  fallbackToHeuristic?: boolean;
  summaryProvider?: string;
  summaryModel?: string;
  summaryMaxOutputTokens?: number;
  includeAssistantReply?: boolean;
  summaryPrompt?: string;
  summaryPromptPath?: string;
  resumePrefixPrompt?: string;
  resumePrefixPromptPath?: string;
};

type TurnSnapshot = {
  at: string;
  user: string;
  assistant: string;
  provider: string;
  model: string;
};

export type SummaryArtifact = {
  schemaVersion: 2;
  summaryId: string;
  generatedAt: string;
  kind: "checkpoint_handoff";
  requestedByPolicy: boolean;
  triggerSources: string[];
  provider: string;
  model: string;
  objective: string;
  latestUserIntent: string;
  stats: {
    capturedTurnCount: number;
    recentTurnCount: number;
    stableChars: number;
    volatileChars: number;
    assistantReplyChars: number;
    sourceSegmentCount: number;
  };
  stableHighlights: string[];
  volatileHighlights: string[];
  progressHighlights: string[];
  nextStepHints: string[];
  recentMessages: Array<{
    index: number;
    at: string;
    user: string;
    assistant: string;
  }>;
  summaryText: string;
  summaryPrompt: string;
  resumePrefixPrompt: string;
  promptConfig: {
    summaryPromptSource: "default" | "inline" | "file";
    summaryPromptPath?: string;
    summaryPromptError?: string;
    resumePrefixPromptSource: "default" | "inline" | "file";
    resumePrefixPromptPath?: string;
    resumePrefixPromptError?: string;
  };
  generation: {
    mode: "llm_full_context_tail_prompt" | "heuristic";
    provider: string;
    model: string;
    requestedAt: string;
    completedAt: string;
    usage?: UsageSnapshot;
    request: {
      includeFullContext: boolean;
      instructionPlacement: "tail";
      sourcePromptChars: number;
      sourceContextChars: number;
      sourceSegmentCount: number;
      assistantReplyChars: number;
      requestPromptChars: number;
      requestSegmentCount: number;
      instructionChars: number;
      maxOutputTokens: number;
      sidecarSessionId: string;
    };
    error?: string;
  };
};

const clip = (value: unknown, maxChars: number): string => {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}...` : raw;
};

const uniqueNonEmpty = (items: string[], maxItems: number): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = clip(item, 240);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
};

const renderContextBlock = (ctx: RuntimeTurnContext): string =>
  ctx.segments
    .map((segment, idx) => {
      const label = segment.source ?? segment.id ?? `segment-${idx + 1}`;
      return `[[SEGMENT ${idx + 1} | ${segment.kind} | ${label}]]\n${segment.text}`;
    })
    .join("\n\n");

type SummaryDraft = {
  objective: string;
  latestUserIntent: string;
  triggerSources: string[];
  stableText: string;
  volatileText: string;
  stableHighlights: string[];
  volatileHighlights: string[];
  progressHighlights: string[];
  nextStepHints: string[];
  recentMessages: Array<{
    index: number;
    at: string;
    user: string;
    assistant: string;
  }>;
  heuristicSummaryText: string;
};

function buildSummaryDraft(params: {
  ctx: RuntimeTurnContext;
  turns: TurnSnapshot[];
  recentTurns: number;
  stableHighlightCount: number;
  volatileHighlightCount: number;
  progressHighlightCount: number;
  triggerSources: string[];
}): SummaryDraft {
  const {
    ctx,
    turns,
    recentTurns,
    stableHighlightCount,
    volatileHighlightCount,
    progressHighlightCount,
    triggerSources,
  } = params;
  const stableSegments = ctx.segments.filter((segment) => segment.kind === "stable");
  const volatileSegments = ctx.segments.filter((segment) => segment.kind !== "stable");
  const stableText = stableSegments.map((segment) => segment.text).join("\n");
  const volatileText = volatileSegments.map((segment) => segment.text).join("\n");
  const stableHighlights = uniqueNonEmpty(
    stableSegments
      .slice()
      .sort((a, b) => b.priority - a.priority)
      .map((segment) => {
        const source = clip(segment.source ?? segment.id, 40);
        const text = clip(segment.text, 220);
        return source ? `[${source}] ${text}` : text;
      }),
    stableHighlightCount,
  );
  const volatileHighlights = uniqueNonEmpty(
    volatileSegments
      .slice()
      .sort((a, b) => b.priority - a.priority)
      .map((segment) => {
        const source = clip(segment.source ?? segment.id, 40);
        const text = clip(segment.text, 220);
        return source ? `[${source}] ${text}` : text;
      }),
    volatileHighlightCount,
  );

  const recent = turns.slice(-recentTurns);
  const recentMessages = recent.map((turn, idx) => ({
    index: idx + 1,
    at: turn.at,
    user: clip(turn.user, 400),
    assistant: clip(turn.assistant, 400),
  }));
  const progressHighlights = uniqueNonEmpty(
    recent
      .slice(-progressHighlightCount)
      .map((turn) => clip(turn.assistant, 220)),
    progressHighlightCount,
  );

  const objective =
    clip(recent.find((turn) => turn.user.trim().length > 0)?.user ?? ctx.prompt, 280) ||
    "Continue the active user task.";
  const latestUserIntent =
    clip(recent[recent.length - 1]?.user ?? ctx.prompt, 280) ||
    "Continue from the latest visible user turn.";
  const nextStepHints = uniqueNonEmpty(
    [
      `Continue from latest user intent: ${latestUserIntent}`,
      progressHighlights[progressHighlights.length - 1]
        ? `Preserve the latest completed progress: ${progressHighlights[progressHighlights.length - 1]}`
        : "",
      stableHighlights[0] ? `Keep stable context intact: ${stableHighlights[0]}` : "",
    ],
    3,
  );

  const heuristicSummaryText = [
    "## Task Objective",
    objective,
    "",
    "## Current State",
    `- Runtime provider/model: ${ctx.provider}/${ctx.model}`,
    `- Captured turns: ${turns.length}`,
    `- Stable context chars: ${stableText.length}`,
    `- Volatile context chars: ${volatileText.length}`,
    triggerSources.length > 0
      ? `- Trigger sources: ${triggerSources.join(", ")}`
      : "- Trigger sources: manual_or_background_capture",
    "",
    "## Stable Context Highlights",
    ...(stableHighlights.length > 0 ? stableHighlights.map((item) => `- ${item}`) : ["- (none)"]),
    "",
    "## Volatile Context Highlights",
    ...(volatileHighlights.length > 0 ? volatileHighlights.map((item) => `- ${item}`) : ["- (none)"]),
    "",
    "## Recent Progress",
    ...(progressHighlights.length > 0
      ? progressHighlights.map((item) => `- ${item}`)
      : ["- No assistant progress captured yet."]),
    "",
    "## Next Step Hints",
    ...(nextStepHints.length > 0
      ? nextStepHints.map((item) => `- ${item}`)
      : ["- Continue from the latest user turn."]),
    "",
    "## Recent Raw Messages",
    recentMessages.length > 0
      ? recentMessages
          .map(
            (turn) =>
              `[${turn.index}] at=${turn.at}\nUSER: ${turn.user}\nASSISTANT: ${turn.assistant}`,
          )
          .join("\n\n")
      : "(none)",
  ].join("\n");

  return {
    objective,
    latestUserIntent,
    triggerSources,
    stableText,
    volatileText,
    stableHighlights,
    volatileHighlights,
    progressHighlights,
    nextStepHints,
    recentMessages,
    heuristicSummaryText,
  };
}

function buildTailSummaryInstruction(params: {
  summaryPrompt: string;
  triggerSources: string[];
  objective: string;
  latestUserIntent: string;
}): string {
  const { summaryPrompt, triggerSources, objective, latestUserIntent } = params;
  const triggerLine =
    triggerSources.length > 0 ? triggerSources.join(", ") : "manual_or_background_capture";
  return [
    "[[SUMMARY REQUEST]]",
    summaryPrompt,
    "",
    "Use the full context above as authoritative source material.",
    "This summary will be used as a compaction seed for a later continuation.",
    `Trigger sources: ${triggerLine}`,
    `Task objective: ${objective}`,
    `Latest user intent: ${latestUserIntent}`,
    "",
    "Return requirements:",
    "- Preserve durable constraints, current state, key decisions, critical references, and next actions.",
    "- Prefer compact bullets and structured sections over long prose.",
    "- Avoid copying long raw transcript blocks unless they are essential to continue the task.",
    "- Make the result self-contained enough to restart work in a forked context.",
    "- If a detail is uncertain or absent, mark it explicitly instead of inventing it.",
  ].join("\n");
}

function buildSummaryRequestContext(params: {
  ctx: RuntimeTurnContext;
  result: RuntimeTurnResult;
  draft: SummaryDraft;
  summaryPrompt: string;
  includeAssistantReply: boolean;
  summaryProvider?: string;
  summaryModel?: string;
  summaryMaxOutputTokens: number;
}): RuntimeTurnContext {
  const {
    ctx,
    result,
    draft,
    summaryPrompt,
    includeAssistantReply,
    summaryProvider,
    summaryModel,
    summaryMaxOutputTokens,
  } = params;
  const tailInstruction = buildTailSummaryInstruction({
    summaryPrompt,
    triggerSources: draft.triggerSources,
    objective: draft.objective,
    latestUserIntent: draft.latestUserIntent,
  });
  const assistantReply = includeAssistantReply ? String(result.content ?? "").trim() : "";
  const sourceContextText = renderContextBlock(ctx);
  const requestPrompt = [
    sourceContextText,
    assistantReply ? `[[LATEST ASSISTANT REPLY]]\n${assistantReply}` : "",
    tailInstruction,
  ]
    .filter(Boolean)
    .join("\n\n");
  const maxPriority = ctx.segments.reduce((acc, segment) => Math.max(acc, segment.priority), 0);
  const requestSegments = [
    ...ctx.segments.map((segment) => ({ ...segment })),
    ...(assistantReply
      ? [
          {
            id: "summary-source-assistant",
            kind: "semi_stable" as const,
            text: `LATEST_ASSISTANT_REPLY\n${assistantReply}`,
            priority: maxPriority + 1,
            source: "module-summary",
          },
        ]
      : []),
    {
      id: "summary-request-tail",
      kind: "volatile" as const,
      text: tailInstruction,
      priority: maxPriority + 2,
      source: "module-summary",
    },
  ];

  return {
    ...ctx,
    sessionId: `${ctx.sessionId}::summary-sidecar`,
    provider: summaryProvider ?? ctx.provider,
    model: summaryModel ?? ctx.model,
    prompt: requestPrompt,
    segments: requestSegments,
    budget: {
      maxInputTokens: ctx.budget.maxInputTokens,
      reserveOutputTokens: Math.max(128, summaryMaxOutputTokens),
    },
    metadata: {
      ...(ctx.metadata ?? {}),
      summaryRequest: {
        mode: "llm_full_context_tail_prompt",
        sourceSessionId: ctx.sessionId,
        includeFullContext: true,
        includeAssistantReply: assistantReply.length > 0,
        instructionPlacement: "tail",
      },
    },
  };
}

export function createSummaryModule(cfg: SummaryModuleConfig = {}): RuntimeModule {
  const idleTriggerMinutes = cfg.idleTriggerMinutes ?? 50;
  const recentTurns = Math.max(1, cfg.recentTurns ?? 6);
  const stableHighlightCount = Math.max(1, cfg.stableHighlightCount ?? 4);
  const volatileHighlightCount = Math.max(1, cfg.volatileHighlightCount ?? 3);
  const progressHighlightCount = Math.max(1, cfg.progressHighlightCount ?? 3);
  const generationMode = cfg.generationMode ?? "llm_full_context";
  const fallbackToHeuristic = cfg.fallbackToHeuristic ?? true;
  const summaryMaxOutputTokens = Math.max(128, cfg.summaryMaxOutputTokens ?? 1200);
  const includeAssistantReply = cfg.includeAssistantReply ?? true;
  const turnState = new Map<string, TurnSnapshot[]>();

  return {
    name: "module-summary",
    async afterCall(ctx, result, runtime: RuntimeModuleRuntime) {
      const resolvedSummaryPrompt = await resolveSummaryPrompt({
        inline: cfg.summaryPrompt,
        path: cfg.summaryPromptPath,
      });
      const resolvedResumePrefixPrompt = await resolveResumePrefixPrompt({
        inline: cfg.resumePrefixPrompt,
        path: cfg.resumePrefixPromptPath,
      });
      const summaryPrompt = resolvedSummaryPrompt.text;
      const resumePrefixPrompt = resolvedResumePrefixPrompt.text;

      const turns = turnState.get(ctx.sessionId) ?? [];
      turns.push({
        at: new Date().toISOString(),
        user: ctx.prompt,
        assistant: result.content,
        provider: ctx.provider,
        model: ctx.model,
      });
      const clippedTurns = turns.slice(-Math.max(2, recentTurns * 3));
      turnState.set(ctx.sessionId, clippedTurns);

      const summaryRequests = findRuntimeEventsByType(
        ctx.metadata,
        ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
      );
      const requested = summaryRequests.length > 0;
      const triggerSources = uniqueNonEmpty(
        summaryRequests.flatMap((event) => {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          const reasons = Array.isArray(payload.reasons)
            ? payload.reasons.map((item) => String(item ?? ""))
            : [];
          return [event.source, ...reasons];
        }),
        8,
      );

      const draft = buildSummaryDraft({
        ctx,
        turns: clippedTurns,
        recentTurns,
        stableHighlightCount,
        volatileHighlightCount,
        progressHighlightCount,
        triggerSources,
      });

      const idleResult = {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          summary: {
            idleTriggerMinutes,
            recentTurns,
            requestedByPolicy: false,
            generationMode,
            triggerSources,
          },
        },
      };
      if (!requested) {
        return idleResult;
      }

      const summaryRequestedAt = new Date().toISOString();
      let summaryText = draft.heuristicSummaryText;
      let generation: SummaryArtifact["generation"];

      if (generationMode === "heuristic") {
        generation = {
          mode: "heuristic",
          provider: cfg.summaryProvider ?? ctx.provider,
          model: cfg.summaryModel ?? ctx.model,
          requestedAt: summaryRequestedAt,
          completedAt: new Date().toISOString(),
          request: {
            includeFullContext: true,
            instructionPlacement: "tail",
            sourcePromptChars: ctx.prompt.length,
            sourceContextChars: renderContextBlock(ctx).length,
            sourceSegmentCount: ctx.segments.length,
            assistantReplyChars: includeAssistantReply ? String(result.content ?? "").length : 0,
            requestPromptChars: draft.heuristicSummaryText.length,
            requestSegmentCount: ctx.segments.length,
            instructionChars: summaryPrompt.length,
            maxOutputTokens: summaryMaxOutputTokens,
            sidecarSessionId: `${ctx.sessionId}::summary-sidecar`,
          },
        };
      } else {
        const summaryRequestCtx = buildSummaryRequestContext({
          ctx,
          result,
          draft,
          summaryPrompt,
          includeAssistantReply,
          summaryProvider: cfg.summaryProvider,
          summaryModel: cfg.summaryModel,
          summaryMaxOutputTokens,
        });

        try {
          const summaryResult = await runtime.callModel(summaryRequestCtx);
          const candidate = String(summaryResult.content ?? "").trim();
          if (!candidate) {
            throw new Error("summary model returned empty content");
          }
          summaryText = candidate;
          generation = {
            mode: "llm_full_context_tail_prompt",
            provider: summaryRequestCtx.provider,
            model: summaryRequestCtx.model,
            requestedAt: summaryRequestedAt,
            completedAt: new Date().toISOString(),
            usage: summaryResult.usage,
            request: {
              includeFullContext: true,
              instructionPlacement: "tail",
              sourcePromptChars: ctx.prompt.length,
              sourceContextChars: renderContextBlock(ctx).length,
              sourceSegmentCount: ctx.segments.length,
              assistantReplyChars: includeAssistantReply ? String(result.content ?? "").length : 0,
              requestPromptChars: summaryRequestCtx.prompt.length,
              requestSegmentCount: summaryRequestCtx.segments.length,
              instructionChars: summaryPrompt.length,
              maxOutputTokens: summaryMaxOutputTokens,
              sidecarSessionId: summaryRequestCtx.sessionId,
            },
          };
        } catch (err) {
          if (!fallbackToHeuristic) throw err;
          generation = {
            mode: "heuristic",
            provider: cfg.summaryProvider ?? ctx.provider,
            model: cfg.summaryModel ?? ctx.model,
            requestedAt: summaryRequestedAt,
            completedAt: new Date().toISOString(),
            request: {
              includeFullContext: true,
              instructionPlacement: "tail",
              sourcePromptChars: ctx.prompt.length,
              sourceContextChars: renderContextBlock(ctx).length,
              sourceSegmentCount: ctx.segments.length,
              assistantReplyChars: includeAssistantReply ? String(result.content ?? "").length : 0,
              requestPromptChars: draft.heuristicSummaryText.length,
              requestSegmentCount: ctx.segments.length,
              instructionChars: summaryPrompt.length,
              maxOutputTokens: summaryMaxOutputTokens,
              sidecarSessionId: `${ctx.sessionId}::summary-sidecar`,
            },
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      const generatedAt = new Date().toISOString();
      const artifact: SummaryArtifact = {
        schemaVersion: 2,
        summaryId: `summary-${Date.now()}`,
        generatedAt,
        kind: "checkpoint_handoff",
        requestedByPolicy: requested,
        triggerSources: draft.triggerSources,
        provider: ctx.provider,
        model: ctx.model,
        objective: draft.objective,
        latestUserIntent: draft.latestUserIntent,
        stats: {
          capturedTurnCount: clippedTurns.length,
          recentTurnCount: draft.recentMessages.length,
          stableChars: draft.stableText.length,
          volatileChars: draft.volatileText.length,
          assistantReplyChars: includeAssistantReply ? String(result.content ?? "").length : 0,
          sourceSegmentCount: ctx.segments.length,
        },
        stableHighlights: draft.stableHighlights,
        volatileHighlights: draft.volatileHighlights,
        progressHighlights: draft.progressHighlights,
        nextStepHints: draft.nextStepHints,
        recentMessages: draft.recentMessages,
        summaryText,
        summaryPrompt,
        resumePrefixPrompt,
        promptConfig: {
          summaryPromptSource: resolvedSummaryPrompt.source,
          summaryPromptPath: resolvedSummaryPrompt.path,
          summaryPromptError: resolvedSummaryPrompt.error,
          resumePrefixPromptSource: resolvedResumePrefixPrompt.source,
          resumePrefixPromptPath: resolvedResumePrefixPrompt.path,
          resumePrefixPromptError: resolvedResumePrefixPrompt.error,
        },
        generation,
      };

      const nextResult = {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          summary: {
            idleTriggerMinutes,
            recentTurns,
            requestedByPolicy: requested,
            triggerSources,
            generationMode: generation.mode,
            artifact,
          },
        },
      };

      return appendResultEvent(nextResult, {
        type: ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED,
        source: "module-summary",
        at: generatedAt,
        payload: {
          artifact,
        },
      });
    },
  };
}
