import type {
  CompactionPlan,
  CompactionStrategy,
  CompactionStrategyContext,
  CompactionStrategyRegistry,
} from "./types.js";
import { resolveCompactionStrategy } from "./strategy-registry.js";

export type BuildCompactionPlanParams = CompactionStrategyContext & {
  strategy: CompactionStrategy;
  strategies?: CompactionStrategyRegistry;
};

export function buildCompactionPlan(params: BuildCompactionPlanParams): CompactionPlan | null {
  const { strategy, strategies, ...context } = params;
  const builder = resolveCompactionStrategy(strategy, strategies);
  return builder(context);
}
