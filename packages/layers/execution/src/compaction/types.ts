import type { SummaryArtifact } from "../summary/index.js";

export type RecentMessage = {
  index?: number;
  at?: string;
  user?: string;
  assistant?: string;
};

export type CompactionStrategy = "summary_then_fork";

export type CompactionSeedMode = "summary";

export type CompactionPlan = {
  schemaVersion: 1;
  planId: string;
  createdAt: string;
  strategy: CompactionStrategy;
  targetBranch: string;
  seedMode: CompactionSeedMode;
  summaryId?: string;
  summaryText: string;
  summaryChars: number;
  resumePrefixPrompt: string;
  recentMessages: RecentMessage[];
  seedSummary: string;
  triggerReasons: string[];
};

export type CompactionModuleConfig = {
  strategy?: CompactionStrategy;
  strategies?: CompactionStrategyRegistry;
};

export type CompactionStrategyContext = {
  artifact: Partial<SummaryArtifact>;
  triggerReasons: unknown;
  createdAt?: string;
  idFactory?: () => number;
};

export type CompactionPlanBuilder = (
  params: CompactionStrategyContext,
) => CompactionPlan | null;

export type CompactionStrategyRegistry = Partial<
  Record<CompactionStrategy, CompactionPlanBuilder>
>;
