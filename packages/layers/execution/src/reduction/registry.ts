import { formatSlimmingPass } from "./pass-format-slimming.js";
import { semanticLlmlingua2Pass } from "./pass-semantic-llmlingua2.js";
import { toolPayloadTrimPass } from "./pass-tool-payload-trim.js";
import type {
  BuiltinReductionPassId,
  ReductionPassId,
  ReductionPassRegistry,
  ReductionPassHandler,
} from "./types.js";

const BUILTIN_PASSES: Record<BuiltinReductionPassId, ReductionPassHandler> = {
  tool_payload_trim: toolPayloadTrimPass,
  format_slimming: formatSlimmingPass,
  semantic_llmlingua2: semanticLlmlingua2Pass,
};

export function resolveReductionPass(
  id: ReductionPassId,
  overrides?: ReductionPassRegistry,
): ReductionPassHandler | undefined {
  return overrides?.[id] ?? BUILTIN_PASSES[id as BuiltinReductionPassId];
}

export function listBuiltinReductionPasses(): BuiltinReductionPassId[] {
  return Object.keys(BUILTIN_PASSES) as BuiltinReductionPassId[];
}
