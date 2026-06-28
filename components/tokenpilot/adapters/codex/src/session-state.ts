import {
  appendRecentTurnBinding,
  loadRecentTurnBindings,
  loadSessionSnapshot,
  readJsonFile,
  resolveLatestSessionId,
  sessionStateRoot,
  sessionSnapshotPath,
  writeJsonFileAtomic,
  writeLatestSessionRef,
  writeSessionSnapshot,
} from "@tokenpilot/host-adapter";
import { join } from "node:path";

export type CodexSessionSnapshot = {
  sessionId: string;
  latestResponseId?: string;
  previousResponseId?: string;
  latestModel?: string;
  workspaceHint?: string;
  lastHookEvent?: string;
  lastToolName?: string;
  lastToolInputChars?: number;
  lastToolOutputChars?: number;
  updatedAt: string;
};

export type CodexRecentTurnBinding = {
  sessionId: string;
  responseId?: string;
  previousResponseId?: string;
  model?: string;
  requestChars?: number;
  responseChars?: number;
  assistantChars?: number;
  toolCallCount?: number;
  stream?: boolean;
  updatedAt: string;
};

type CodexResponseSessionRef = {
  responseId: string;
  sessionId: string;
  updatedAt: string;
};

type CodexPromptCacheKeySessionRef = {
  promptCacheKey: string;
  sessionId: string;
  updatedAt: string;
};

function responseSessionPath(stateDir: string, responseId: string): string {
  return join(sessionStateRoot(stateDir), "responses", `${encodeURIComponent(responseId)}.json`);
}

function promptCacheKeySessionPath(stateDir: string, promptCacheKey: string): string {
  return join(sessionStateRoot(stateDir), "prompt-cache-keys", `${encodeURIComponent(promptCacheKey)}.json`);
}

async function markLatestSession(stateDir: string, sessionId: string, updatedAt: string): Promise<void> {
  await writeLatestSessionRef(stateDir, sessionId, updatedAt);
}

export async function loadCodexSessionSnapshot(
  stateDir: string,
  sessionId: string,
): Promise<CodexSessionSnapshot | null> {
  return loadSessionSnapshot<CodexSessionSnapshot>(stateDir, sessionId);
}

export async function upsertCodexSessionSnapshot(
  stateDir: string,
  sessionId: string,
  patch: Partial<CodexSessionSnapshot>,
): Promise<CodexSessionSnapshot> {
  const current = await loadCodexSessionSnapshot(stateDir, sessionId);
  const updatedAt = new Date().toISOString();
  const next: CodexSessionSnapshot = {
    sessionId,
    latestResponseId: patch.latestResponseId ?? current?.latestResponseId,
    previousResponseId: patch.previousResponseId ?? current?.previousResponseId,
    latestModel: patch.latestModel ?? current?.latestModel,
    workspaceHint: patch.workspaceHint ?? current?.workspaceHint,
    lastHookEvent: patch.lastHookEvent ?? current?.lastHookEvent,
    lastToolName: patch.lastToolName ?? current?.lastToolName,
    lastToolInputChars: patch.lastToolInputChars ?? current?.lastToolInputChars,
    lastToolOutputChars: patch.lastToolOutputChars ?? current?.lastToolOutputChars,
    updatedAt,
  };
  await writeSessionSnapshot(stateDir, sessionId, next);
  await markLatestSession(stateDir, sessionId, updatedAt);
  return next;
}

export async function appendCodexRecentTurnBinding(
  stateDir: string,
  binding: CodexRecentTurnBinding,
): Promise<void> {
  await appendRecentTurnBinding(stateDir, binding);
}

export async function indexCodexResponseSession(
  stateDir: string,
  responseId: string,
  sessionId: string,
): Promise<void> {
  const normalizedResponseId = responseId.trim();
  const normalizedSessionId = sessionId.trim();
  if (!normalizedResponseId || !normalizedSessionId) return;
  await writeJsonFileAtomic(responseSessionPath(stateDir, normalizedResponseId), {
    responseId: normalizedResponseId,
    sessionId: normalizedSessionId,
    updatedAt: new Date().toISOString(),
  } satisfies CodexResponseSessionRef);
}

export async function resolveCodexSessionIdByResponseId(
  stateDir: string,
  responseId: string,
): Promise<string | undefined> {
  const normalizedResponseId = responseId.trim();
  if (!normalizedResponseId) return undefined;
  const record = await readJsonFile<CodexResponseSessionRef>(responseSessionPath(stateDir, normalizedResponseId));
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId.trim() : "";
  return sessionId || undefined;
}

export async function indexCodexPromptCacheKeySession(
  stateDir: string,
  promptCacheKey: string,
  sessionId: string,
): Promise<void> {
  const normalizedPromptCacheKey = promptCacheKey.trim();
  const normalizedSessionId = sessionId.trim();
  if (!normalizedPromptCacheKey || !normalizedSessionId) return;
  await writeJsonFileAtomic(promptCacheKeySessionPath(stateDir, normalizedPromptCacheKey), {
    promptCacheKey: normalizedPromptCacheKey,
    sessionId: normalizedSessionId,
    updatedAt: new Date().toISOString(),
  } satisfies CodexPromptCacheKeySessionRef);
}

export async function resolveCodexSessionIdByPromptCacheKey(
  stateDir: string,
  promptCacheKey: string,
): Promise<string | undefined> {
  const normalizedPromptCacheKey = promptCacheKey.trim();
  if (!normalizedPromptCacheKey) return undefined;
  const record = await readJsonFile<CodexPromptCacheKeySessionRef>(
    promptCacheKeySessionPath(stateDir, normalizedPromptCacheKey),
  );
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId.trim() : "";
  return sessionId || undefined;
}

export async function loadCodexRecentTurnBindings(
  stateDir: string,
  sessionId: string,
  limit = 8,
): Promise<CodexRecentTurnBinding[]> {
  return loadRecentTurnBindings<CodexRecentTurnBinding>(
    stateDir,
    sessionId,
    limit,
    (entry): entry is CodexRecentTurnBinding =>
      Boolean(entry && typeof entry === "object" && typeof (entry as { sessionId?: unknown }).sessionId === "string"),
  );
}

export async function resolveLatestCodexSessionId(stateDir: string): Promise<string | undefined> {
  return resolveLatestSessionId(stateDir);
}
