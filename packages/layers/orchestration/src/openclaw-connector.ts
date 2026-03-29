import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ECOCLAW_EVENT_TYPES,
  appendRuntimeEvent,
  createObservationSegment,
  findRuntimeEventsByType,
  RuntimePipeline,
  resolveApiFamily,
  type ContextSegment,
  type ObservationPayloadKind,
  type ObservationRole,
  type RuntimeEvent,
  type RuntimeModule,
  type RuntimeStateStore,
  type RuntimeTurnContext,
  type RuntimeTurnTrace,
  type RuntimeTurnResult,
} from "@ecoclaw/kernel";
import { createFileRuntimeStateStore } from "@ecoclaw/storage-fs";

export type OpenClawConnectorConfig = {
  modules: RuntimeModule[];
  adapters: Record<string, any>;
  stateDir?: string;
  stateStore?: RuntimeStateStore;
  routing?: {
    autoForkOnPolicy?: boolean;
    physicalSessionPrefix?: string;
  };
  observability?: {
    eventTracePath?: string;
  };
};

export function createOpenClawConnector(cfg: OpenClawConnectorConfig) {
  const pipeline = new RuntimePipeline({ modules: cfg.modules, adapters: cfg.adapters });
  const stateStore =
    cfg.stateStore ??
    (cfg.stateDir ? createFileRuntimeStateStore({ stateDir: cfg.stateDir }) : undefined);
  const autoForkOnPolicy = cfg.routing?.autoForkOnPolicy ?? true;
  const physicalSessionPrefix = cfg.routing?.physicalSessionPrefix ?? "phy";
  const logicalToPhysical = new Map<string, string>();
  let forkCounter = 0;

  const toSerializable = <T>(value: T): T | undefined => {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return undefined;
    }
  };

  const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");

  const normalizePayloadKind = (value: unknown): ObservationPayloadKind | undefined => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "stdout" ||
      normalized === "stderr" ||
      normalized === "json" ||
      normalized === "blob"
    ) {
      return normalized;
    }
    return undefined;
  };

  const normalizeObservationRole = (value: unknown): ObservationRole | undefined => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === "tool" || normalized === "observation") return normalized;
    return undefined;
  };

  const normalizeObservationStability = (
    value: unknown,
  ): ContextSegment["kind"] | undefined => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "stable" ||
      normalized === "semi_stable" ||
      normalized === "volatile"
    ) {
      return normalized;
    }
    return undefined;
  };

  const buildObservationSegments = (ctx: RuntimeTurnContext): ContextSegment[] => {
    const metadata =
      ctx.metadata && typeof ctx.metadata === "object"
        ? (ctx.metadata as Record<string, unknown>)
        : undefined;
    if (!metadata) return [];

    const out: ContextSegment[] = [];
    const turnObservations = Array.isArray(metadata.turnObservations)
      ? metadata.turnObservations
      : [];
    for (let i = 0; i < turnObservations.length; i += 1) {
      const item = turnObservations[i];
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) continue;
        out.push(
          createObservationSegment({
            id: `turn-observation-${i + 1}`,
            text,
            source: "metadata.turnObservations",
            role: "observation",
          }),
        );
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      if (!text) continue;
      out.push(
        createObservationSegment({
          id:
            typeof obj.id === "string" && obj.id.trim().length > 0
              ? obj.id.trim()
              : `turn-observation-${i + 1}`,
          text,
          priority:
            typeof obj.priority === "number" && Number.isFinite(obj.priority)
              ? obj.priority
              : undefined,
          stability: normalizeObservationStability(obj.stability),
          source:
            typeof obj.source === "string" && obj.source.trim().length > 0
              ? obj.source.trim()
              : "metadata.turnObservations",
          role: normalizeObservationRole(obj.role),
          payloadKind: normalizePayloadKind(obj.payloadKind),
          toolName:
            typeof obj.toolName === "string" && obj.toolName.trim().length > 0
              ? obj.toolName.trim()
              : undefined,
          origin:
            typeof obj.origin === "string" && obj.origin.trim().length > 0
              ? obj.origin.trim()
              : undefined,
          mimeType:
            typeof obj.mimeType === "string" && obj.mimeType.trim().length > 0
              ? obj.mimeType.trim()
              : undefined,
          truncated:
            typeof obj.truncated === "boolean" ? obj.truncated : undefined,
          metadata:
            obj.metadata && typeof obj.metadata === "object"
              ? (obj.metadata as Record<string, unknown>)
              : undefined,
        }),
      );
    }

    const turnTools = Array.isArray(metadata.turnTools) ? metadata.turnTools : [];
    for (let i = 0; i < turnTools.length; i += 1) {
      const item = turnTools[i];
      if (typeof item !== "string") continue;
      const text = item.trim();
      if (!text) continue;
      out.push(
        createObservationSegment({
          id: `turn-tool-${i + 1}`,
          text,
          source: "metadata.turnTools",
          role: "tool",
        }),
      );
    }

    return out;
  };

  const appendEventTrace = async (
    logicalSessionId: string,
    physicalSessionId: string,
    turnCtx: RuntimeTurnContext,
    result: RuntimeTurnResult,
  ) => {
    const eventTracePath = cfg.observability?.eventTracePath;
    if (!eventTracePath) return;
    const trace = (result.metadata as Record<string, any> | undefined)?.ecoclawTrace;
    const finalMetadata = trace?.finalContext?.metadata as Record<string, unknown> | undefined;
    const finalCtxEvents = Array.isArray(finalMetadata?.ecoclawEvents)
      ? (finalMetadata?.ecoclawEvents as RuntimeEvent[])
      : [];
    const resultEvents = Array.isArray((result.metadata as Record<string, unknown> | undefined)?.ecoclawEvents)
      ? (((result.metadata as Record<string, unknown> | undefined)?.ecoclawEvents ?? []) as RuntimeEvent[])
      : [];
    const payload = {
      at: new Date().toISOString(),
      logicalSessionId,
      physicalSessionId,
      provider: turnCtx.provider,
      model: turnCtx.model,
      apiFamily: turnCtx.apiFamily ?? resolveApiFamily(turnCtx),
      prompt: turnCtx.prompt,
      responsePreview: result.content,
      usage: result.usage,
      contextDetail: {
        openclawPromptRoot:
          (turnCtx.metadata as Record<string, unknown> | undefined)?.openclawPromptRoot ?? undefined,
        turnTools:
          (turnCtx.metadata as Record<string, unknown> | undefined)?.turnTools ?? undefined,
        requestDetail: toSerializable(trace?.requestDetail) ?? {
          renderedPromptText: "",
          segments: [],
          metadata: {},
        },
        initialContext: {
          sessionId: trace?.initialContext?.sessionId ?? turnCtx.sessionId,
          provider: trace?.initialContext?.provider ?? turnCtx.provider,
          model: trace?.initialContext?.model ?? turnCtx.model,
          prompt: trace?.initialContext?.prompt ?? turnCtx.prompt,
          segments: toSerializable(trace?.initialContext?.segments ?? turnCtx.segments) ?? [],
          metadata: toSerializable(trace?.initialContext?.metadata ?? turnCtx.metadata) ?? {},
        },
        finalContext: {
          sessionId: trace?.finalContext?.sessionId ?? turnCtx.sessionId,
          provider: trace?.finalContext?.provider ?? turnCtx.provider,
          model: trace?.finalContext?.model ?? turnCtx.model,
          prompt: trace?.finalContext?.prompt ?? turnCtx.prompt,
          segments: toSerializable(trace?.finalContext?.segments ?? turnCtx.segments) ?? [],
          metadata: toSerializable(trace?.finalContext?.metadata ?? turnCtx.metadata) ?? {},
        },
        moduleSteps: toSerializable(trace?.moduleSteps) ?? [],
      },
      eventTypes: [...finalCtxEvents, ...resultEvents].map((e) => e.type),
      finalContextEvents: finalCtxEvents,
      resultEvents,
    };
    await mkdir(dirname(eventTracePath), { recursive: true });
    await appendFile(eventTracePath, `${JSON.stringify(payload)}\n`, "utf8");
  };

  const resolveRouting = (ctx: RuntimeTurnContext) => {
    const logicalSessionId =
      (ctx.metadata as Record<string, unknown> | undefined)?.logicalSessionId?.toString() ?? ctx.sessionId;
    const existingPhysical = logicalToPhysical.get(logicalSessionId);
    const physicalSessionId = existingPhysical ?? ctx.sessionId;
    logicalToPhysical.set(logicalSessionId, physicalSessionId);
    return { logicalSessionId, physicalSessionId };
  };

  const maybeApplyCompactionPlan = async (
    logicalSessionId: string,
    physicalSessionId: string,
    ctx: RuntimeTurnContext,
    result: RuntimeTurnResult,
    invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>,
  ) => {
    if (!autoForkOnPolicy) return { applied: false, reason: "auto_fork_disabled" } as const;
    const resultMeta = (result.metadata ?? {}) as Record<string, unknown>;
    const planEvents = findRuntimeEventsByType(resultMeta, ECOCLAW_EVENT_TYPES.COMPACTION_PLAN_GENERATED);
    if (planEvents.length === 0) {
      return { applied: false, reason: "no_compaction_plan" } as const;
    }

    const latestPlan = planEvents[planEvents.length - 1];
    const planPayload = (latestPlan.payload ?? {}) as Record<string, unknown>;
    const seedSummary = String(planPayload.seedSummary ?? "").trim();
    if (!seedSummary) return { applied: false, reason: "empty_seed_summary" } as const;
    const summaryChars =
      typeof planPayload.summaryChars === "number" && Number.isFinite(planPayload.summaryChars)
        ? planPayload.summaryChars
        : seedSummary.length;

    forkCounter += 1;
    const newPhysical = `${physicalSessionPrefix}-${safeName(logicalSessionId)}-f${forkCounter.toString().padStart(4, "0")}`;
    logicalToPhysical.set(logicalSessionId, newPhysical);
    await stateStore?.writeSummary(newPhysical, seedSummary, "compaction-seed");

    const seedCtx: RuntimeTurnContext = {
      ...ctx,
      sessionId: newPhysical,
      prompt: "[seed] Continue with compacted context summary.",
      metadata: {
        ...(ctx.metadata ?? {}),
        logicalSessionId,
        physicalSessionId: newPhysical,
        forkedFromSessionId: physicalSessionId,
        forkSeedSummaryChars: summaryChars,
        policyBypass: true,
      },
      segments: [
        ...ctx.segments.filter((s) => s.kind === "stable"),
        {
          id: "fork-seed-summary",
          kind: "stable",
          text: `SEED_SUMMARY\n${seedSummary}`,
          priority: 2,
          source: "policy-fork",
        },
      ],
    };
    // Seed the new physical session for subsequent user turns.
    const seedResult = await pipeline.run(seedCtx, invokeModel);
    return {
      applied: true,
      newPhysical,
      fromPhysical: physicalSessionId,
      summaryChars,
      seedUsage: seedResult.usage,
      planId:
        typeof planPayload.planId === "string" && planPayload.planId.trim().length > 0
          ? planPayload.planId
          : undefined,
      strategy:
        typeof planPayload.strategy === "string" && planPayload.strategy.trim().length > 0
          ? planPayload.strategy
          : "summary_then_fork",
    } as const;
  };

  return {
    // Placeholder: wire these to OpenClaw plugin hooks.
    async onBeforePromptBuild(ctx: any) {
      return ctx;
    },
    async onLlmCall(turnCtx: RuntimeTurnContext, invokeModel: (ctx: RuntimeTurnContext) => Promise<RuntimeTurnResult>) {
      const startedAt = new Date().toISOString();
      const observationSegments = buildObservationSegments(turnCtx);
      const { logicalSessionId, physicalSessionId } = resolveRouting(turnCtx);
      const routedCtx: RuntimeTurnContext = {
        ...turnCtx,
        sessionId: physicalSessionId,
        segments:
          observationSegments.length > 0
            ? [...turnCtx.segments, ...observationSegments]
            : turnCtx.segments,
        metadata: {
          ...(turnCtx.metadata ?? {}),
          logicalSessionId,
          physicalSessionId,
          observationSegmentCount: observationSegments.length,
        },
      };
      try {
        const result = await pipeline.run(routedCtx, invokeModel);
        const forkOutcome = await maybeApplyCompactionPlan(
          logicalSessionId,
          physicalSessionId,
          routedCtx,
          result,
          invokeModel,
        );
        if (forkOutcome.applied) {
          const usage = result.usage ?? {};
          const payload = {
            strategy: forkOutcome.strategy,
            logicalSessionId,
            fromPhysicalSessionId: forkOutcome.fromPhysical,
            toPhysicalSessionId: forkOutcome.newPhysical,
            summaryChars: forkOutcome.summaryChars,
            planId: forkOutcome.planId,
            compactionTurn: {
              promptTokens:
                typeof usage.inputTokens === "number"
                  ? usage.inputTokens
                  : undefined,
              completionTokens:
                typeof usage.outputTokens === "number"
                  ? usage.outputTokens
                  : undefined,
              cacheReadTokens:
                typeof usage.cacheReadTokens === "number"
                  ? usage.cacheReadTokens
                  : typeof usage.cachedTokens === "number"
                    ? usage.cachedTokens
                    : undefined,
            },
            seedUsage: forkOutcome.seedUsage,
          };
          result.metadata = appendRuntimeEvent(
            (result.metadata ?? {}) as Record<string, unknown>,
            {
              type: ECOCLAW_EVENT_TYPES.COMPACTION_APPLY_EXECUTED,
              source: "connector-openclaw",
              at: new Date().toISOString(),
              payload,
            },
          );
          result.metadata = {
            ...(result.metadata ?? {}),
            compactionApply: payload,
          };
        }
        const endedAt = new Date().toISOString();
        await appendEventTrace(logicalSessionId, physicalSessionId, routedCtx, result);
        await stateStore?.appendTurn({
          turnId: randomUUID(),
          sessionId: routedCtx.sessionId,
          provider: routedCtx.provider,
          model: routedCtx.model,
          apiFamily: routedCtx.apiFamily ?? resolveApiFamily(routedCtx),
          prompt: routedCtx.prompt,
          segments: routedCtx.segments,
          usage: result.usage,
          responsePreview: result.content,
          response: result.content,
          trace: toSerializable<RuntimeTurnTrace | undefined>(
            (result.metadata as Record<string, unknown> | undefined)?.ecoclawTrace as
              | RuntimeTurnTrace
              | undefined,
          ),
          resultMetadata: toSerializable(result.metadata),
          startedAt,
          endedAt,
          status: "ok",
        });
        return result;
      } catch (err) {
        const endedAt = new Date().toISOString();
        await stateStore?.appendTurn({
          turnId: randomUUID(),
          sessionId: routedCtx.sessionId,
          provider: routedCtx.provider,
          model: routedCtx.model,
          apiFamily: routedCtx.apiFamily ?? resolveApiFamily(routedCtx),
          prompt: routedCtx.prompt,
          segments: routedCtx.segments,
          responsePreview: "",
          trace: toSerializable<RuntimeTurnTrace>({
            initialContext: routedCtx,
            finalContext: routedCtx,
            moduleSteps: [],
            responsePreview: "",
          }),
          startedAt,
          endedAt,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    async writeSessionSummary(sessionId: string, summary: string, source = "manual") {
      await stateStore?.writeSummary(sessionId, summary, source);
    },
    getStateRootDir() {
      return cfg.stateDir ? `${cfg.stateDir}/ecoclaw` : undefined;
    },
    getPhysicalSessionId(logicalSessionId: string) {
      return logicalToPhysical.get(logicalSessionId);
    },
  };
}
