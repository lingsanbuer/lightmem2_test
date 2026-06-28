import {
  loadCodexRecentTurnBindings,
  loadCodexSessionSnapshot,
  resolveCanonicalCodexSessionId,
  type CodexRecentTurnBinding,
} from "./session-state.js";

export type CodexSessionTopology = {
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
  updatedAt?: string;
  turnCount: number;
};

function normalizeSessionId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function buildResponseChain(bindings: CodexRecentTurnBinding[]): string[] {
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

export async function resolveCodexSessionTopology(
  stateDir: string,
  sessionRef?: string,
): Promise<CodexSessionTopology | undefined> {
  const sessionId = await resolveCanonicalCodexSessionId(stateDir, normalizeSessionId(sessionRef));
  if (!sessionId) return undefined;

  const [snapshot, bindings] = await Promise.all([
    loadCodexSessionSnapshot(stateDir, sessionId),
    loadCodexRecentTurnBindings(stateDir, sessionId, 12),
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
    updatedAt: normalizeSessionId(snapshot?.updatedAt) ?? normalizeSessionId(bindings[0]?.updatedAt),
    turnCount: bindings.length,
  };
}
