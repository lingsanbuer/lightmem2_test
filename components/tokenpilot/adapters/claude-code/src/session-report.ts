import {
  readLatestUxEffect,
  readUxSessionAggregate,
} from "@tokenpilot/host-adapter";
import {
  buildSessionReportText,
  readRecentReductionMetrics,
  type ProductSurfaceSessionOverviewItem,
} from "@tokenpilot/product-surface";
import {
  loadClaudeCodeRecentTurnBindings,
  loadClaudeCodeSessionSnapshot,
  resolveLatestClaudeCodeSessionId,
  type ClaudeCodeRecentTurnBinding,
} from "./session-state.js";

export type ClaudeCodeSessionTopology = {
  sessionId: string;
  latestResponseId?: string;
  previousResponseId?: string;
  responseChain: string[];
  latestModel?: string;
  workspaceHint?: string;
  lastHookEvent?: string;
  lastToolName?: string;
  lastToolInputChars?: number;
  lastToolOutputChars?: number;
  requestChars?: number;
  responseChars?: number;
  assistantChars?: number;
  reductionSavedChars?: number;
  updatedAt?: string;
  turnCount: number;
};

function normalizeSessionId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function buildResponseChain(bindings: ClaudeCodeRecentTurnBinding[]): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const binding of bindings) {
    const responseId = normalizeSessionId(binding.responseId);
    if (!responseId || seen.has(responseId)) continue;
    seen.add(responseId);
    chain.push(responseId);
  }
  return chain;
}

export async function resolveClaudeCodeSessionTopology(
  stateDir: string,
  sessionRef?: string,
): Promise<ClaudeCodeSessionTopology | undefined> {
  const sessionId = normalizeSessionId(sessionRef) ?? await resolveLatestClaudeCodeSessionId(stateDir);
  if (!sessionId) return undefined;

  const [snapshot, bindings] = await Promise.all([
    loadClaudeCodeSessionSnapshot(stateDir, sessionId),
    loadClaudeCodeRecentTurnBindings(stateDir, sessionId, 12),
  ]);
  if (!snapshot && bindings.length === 0) return undefined;

  return {
    sessionId,
    latestResponseId: normalizeSessionId(snapshot?.latestResponseId) ?? normalizeSessionId(bindings[0]?.responseId),
    previousResponseId: normalizeSessionId(snapshot?.previousResponseId) ?? normalizeSessionId(bindings[0]?.previousResponseId),
    responseChain: buildResponseChain(bindings),
    latestModel: normalizeSessionId(snapshot?.latestModel) ?? normalizeSessionId(bindings[0]?.model),
    workspaceHint: normalizeSessionId(snapshot?.workspaceHint),
    lastHookEvent: normalizeSessionId(snapshot?.lastHookEvent),
    lastToolName: normalizeSessionId(snapshot?.lastToolName),
    lastToolInputChars: snapshot?.lastToolInputChars,
    lastToolOutputChars: snapshot?.lastToolOutputChars,
    requestChars: snapshot?.requestChars ?? bindings[0]?.requestChars,
    responseChars: snapshot?.responseChars ?? bindings[0]?.responseChars,
    assistantChars: snapshot?.assistantChars ?? bindings[0]?.assistantChars,
    reductionSavedChars: snapshot?.reductionSavedChars ?? bindings[0]?.reductionSavedChars,
    updatedAt: normalizeSessionId(snapshot?.updatedAt) ?? normalizeSessionId(bindings[0]?.updatedAt),
    turnCount: bindings.length,
  };
}

export async function renderClaudeCodeSessionReport(stateDir: string, sessionRef?: string): Promise<string> {
  const topology = await resolveClaudeCodeSessionTopology(stateDir, sessionRef);
  if (!topology) return "No Claude Code TokenPilot session data found.";

  const [aggregate, latestEffect, recentMetrics] = await Promise.all([
    readUxSessionAggregate(stateDir, topology.sessionId),
    readLatestUxEffect(stateDir),
    readRecentReductionMetrics(stateDir, topology.sessionId),
  ]);

  const overview: ProductSurfaceSessionOverviewItem[] = [
    { label: "Session", value: topology.sessionId },
    { label: "Turns", value: topology.turnCount },
    { label: "Model", value: topology.latestModel ?? "unknown" },
    { label: "Workspace", value: topology.workspaceHint ?? "unknown" },
    { label: "Latest response", value: topology.latestResponseId ?? "unknown" },
    { label: "Previous response", value: topology.previousResponseId ?? "unknown" },
    { label: "Latest request chars", value: topology.requestChars ?? 0 },
    { label: "Latest response chars", value: topology.responseChars ?? 0 },
    { label: "Latest assistant chars", value: topology.assistantChars ?? 0 },
    { label: "Latest reduction savings", value: topology.reductionSavedChars ?? 0 },
  ];

  if (topology.lastToolName) {
    overview.push({ label: "Last tool", value: topology.lastToolName });
  }
  if (topology.responseChain.length > 0) {
    overview.push({ label: "Response chain", value: topology.responseChain.join(" -> ") });
  }

  return buildSessionReportText({
    title: "TokenPilot Claude Code report:",
    sessionId: topology.sessionId,
    aggregate,
    latest: latestEffect?.sessionId === topology.sessionId ? latestEffect : null,
    detailsEnabled: true,
    recentMetrics,
    overview,
  });
}
