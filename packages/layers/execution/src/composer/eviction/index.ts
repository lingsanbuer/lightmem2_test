import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  type RuntimeModule,
} from "@ecoclaw/kernel";

type EvictionPolicy = "noop" | "lru" | "lfu" | "gdsf" | "model_scored" | (string & {});
type EvictionDecision = {
  enabled: boolean;
  policy: EvictionPolicy;
  blocks: Array<Record<string, unknown>>;
  instructions: Array<Record<string, unknown>>;
  estimatedSavedChars: number;
  notes?: string[];
};

export type EvictionModuleConfig = {
  enabled?: boolean;
  policy?: EvictionPolicy;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readPolicyEvictionDecision(metadata: Record<string, unknown> | undefined): EvictionDecision | undefined {
  const policy = asRecord(metadata?.policy);
  const decisions = asRecord(policy?.decisions);
  const eviction = asRecord(decisions?.eviction);
  if (!eviction) return undefined;
  const policyName = typeof eviction.policy === "string" ? eviction.policy : "noop";
  const blocks = Array.isArray(eviction.blocks) ? eviction.blocks : [];
  const instructions = Array.isArray(eviction.instructions) ? eviction.instructions : [];
  const estimatedSavedChars =
    typeof eviction.estimatedSavedChars === "number" ? eviction.estimatedSavedChars : 0;
  const notes = Array.isArray(eviction.notes)
    ? eviction.notes.map((item) => String(item))
    : undefined;
  return {
    enabled: eviction.enabled === true,
    policy: policyName,
    blocks: blocks as EvictionDecision["blocks"],
    instructions: instructions as EvictionDecision["instructions"],
    estimatedSavedChars,
    notes,
  };
}

export function createEvictionModule(cfg: EvictionModuleConfig = {}): RuntimeModule {
  const enabled = cfg.enabled ?? false;
  const fallbackPolicy: EvictionPolicy = cfg.policy ?? "noop";
  return {
    name: "module-eviction",
    async beforeCall(ctx) {
      if (!enabled) return ctx;

      const decision = readPolicyEvictionDecision(ctx.metadata) ?? {
        enabled: true,
        policy: fallbackPolicy,
        blocks: [],
        instructions: [],
        estimatedSavedChars: 0,
        notes: ["eviction_policy_decision_unavailable"],
      };

      const nextCtx = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          eviction: {
            policy: decision.policy,
            blockCount: decision.blocks.length,
            instructionCount: decision.instructions.length,
            estimatedSavedChars: decision.estimatedSavedChars,
            notes: decision.notes ?? ["eviction_noop_placeholder"],
          },
        },
      };

      return appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.EVICTION_PLAN_EVALUATED,
        source: "module-eviction",
        at: new Date().toISOString(),
        payload: {
          policy: decision.policy,
          blockCount: decision.blocks.length,
          instructionCount: decision.instructions.length,
          estimatedSavedChars: decision.estimatedSavedChars,
          notes: decision.notes,
        },
      });
    },
  };
}
