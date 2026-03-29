import {
  ECOCLAW_EVENT_TYPES,
  appendResultEvent,
  findRuntimeEventsByType,
  type RuntimeModule,
} from "@ecoclaw/kernel";
import type { SummaryArtifact } from "../summary/index.js";
import { buildCompactionPlan } from "./plan-builder.js";
import type { CompactionModuleConfig } from "./types.js";

export * from "./types.js";
export * from "./plan-builder.js";
export * from "./strategy-registry.js";
export * from "./strategy-summary-then-fork.js";

export function createCompactionModule(cfg: CompactionModuleConfig = {}): RuntimeModule {
  const strategy = cfg.strategy ?? "summary_then_fork";

  return {
    name: "module-compaction",
    async afterCall(ctx, result) {
      const policyEvents = findRuntimeEventsByType(
        ctx.metadata,
        ECOCLAW_EVENT_TYPES.POLICY_COMPACTION_REQUESTED,
      );
      if (policyEvents.length === 0) return result;

      const summaryEvents = findRuntimeEventsByType(
        result.metadata,
        ECOCLAW_EVENT_TYPES.SUMMARY_GENERATED,
      );
      if (summaryEvents.length === 0) return result;

      const latestPolicyEvent = policyEvents[policyEvents.length - 1];
      const latestSummary = summaryEvents[summaryEvents.length - 1];
      const triggerPayload = (latestPolicyEvent.payload ?? {}) as Record<string, unknown>;
      const summaryPayload = (latestSummary.payload ?? {}) as Record<string, unknown>;
      const artifact = (summaryPayload.artifact ?? {}) as Partial<SummaryArtifact>;
      const createdAt = new Date().toISOString();
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
          ...result,
          metadata: {
            ...(result.metadata ?? {}),
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
