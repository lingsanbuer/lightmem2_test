import { buildSummaryThenForkPlan } from "./strategy-summary-then-fork.js";
import type {
  CompactionPlanBuilder,
  CompactionStrategy,
  CompactionStrategyRegistry,
} from "./types.js";

const BUILTIN_STRATEGIES: Record<CompactionStrategy, CompactionPlanBuilder> = {
  summary_then_fork: buildSummaryThenForkPlan,
};

export function resolveCompactionStrategy(
  strategy: CompactionStrategy,
  overrides?: CompactionStrategyRegistry,
): CompactionPlanBuilder {
  return overrides?.[strategy] ?? BUILTIN_STRATEGIES[strategy];
}

export function listBuiltinCompactionStrategies(): CompactionStrategy[] {
  return Object.keys(BUILTIN_STRATEGIES) as CompactionStrategy[];
}
