import type { SummaryArtifact } from "../summary/index.js";
import type {
  CompactionPlan,
  CompactionStrategyContext,
  RecentMessage,
} from "./types.js";

const clipText = (value: unknown): string => String(value ?? "").trim();

const normalizeRecentMessages = (value: unknown): RecentMessage[] =>
  Array.isArray(value) ? (value as RecentMessage[]) : [];

const normalizeTriggerReasons = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => clipText(item)).filter(Boolean)
    : [];

export function buildSummaryThenForkPlan(
  params: CompactionStrategyContext,
): CompactionPlan | null {
  const {
    artifact,
    createdAt = new Date().toISOString(),
    idFactory = () => Date.now(),
    triggerReasons,
  } = params;

  const summaryArtifact = artifact as Partial<SummaryArtifact>;
  const summaryText = clipText(summaryArtifact.summaryText);
  if (!summaryText) return null;

  const resumePrefixPrompt = clipText(summaryArtifact.resumePrefixPrompt);
  const seedSummary = [resumePrefixPrompt, summaryText].filter(Boolean).join("\n\n");
  if (!seedSummary) return null;

  const stamp = idFactory();
  return {
    schemaVersion: 1,
    planId: `compact-plan-${stamp}`,
    createdAt,
    strategy: "summary_then_fork",
    targetBranch: `compact-${stamp}`,
    seedMode: "summary",
    summaryId: clipText(summaryArtifact.summaryId) || undefined,
    summaryText,
    summaryChars: summaryText.length,
    resumePrefixPrompt,
    recentMessages: normalizeRecentMessages(summaryArtifact.recentMessages),
    seedSummary,
    triggerReasons: normalizeTriggerReasons(triggerReasons),
  };
}
