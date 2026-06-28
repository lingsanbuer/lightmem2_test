import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile, appendFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

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

type LatestCodexSessionRef = {
  sessionId: string;
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

function encodeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

function sessionSnapshotPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "session-state", "sessions", `${encodeSessionId(sessionId)}.json`);
}

function recentTurnBindingsPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "session-state", "bindings", `${encodeSessionId(sessionId)}.jsonl`);
}

function latestSessionPath(stateDir: string): string {
  return join(stateDir, "session-state", "latest.json");
}

function responseSessionPath(stateDir: string, responseId: string): string {
  return join(stateDir, "session-state", "responses", `${encodeURIComponent(responseId)}.json`);
}

function promptCacheKeySessionPath(stateDir: string, promptCacheKey: string): string {
  return join(stateDir, "session-state", "prompt-cache-keys", `${encodeURIComponent(promptCacheKey)}.json`);
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonFileAtomic(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function appendJsonl(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(payload)}\n`, "utf8");
}

async function markLatestSession(stateDir: string, sessionId: string, updatedAt: string): Promise<void> {
  await writeJsonFileAtomic(latestSessionPath(stateDir), {
    sessionId,
    updatedAt,
  } satisfies LatestCodexSessionRef);
}

export async function loadCodexSessionSnapshot(
  stateDir: string,
  sessionId: string,
): Promise<CodexSessionSnapshot | null> {
  return readJsonFile<CodexSessionSnapshot>(sessionSnapshotPath(stateDir, sessionId));
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
  await writeJsonFileAtomic(sessionSnapshotPath(stateDir, sessionId), next);
  await markLatestSession(stateDir, sessionId, updatedAt);
  return next;
}

export async function appendCodexRecentTurnBinding(
  stateDir: string,
  binding: CodexRecentTurnBinding,
): Promise<void> {
  await appendJsonl(recentTurnBindingsPath(stateDir, binding.sessionId), binding);
  await markLatestSession(stateDir, binding.sessionId, binding.updatedAt);
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
  try {
    const raw = await readFile(recentTurnBindingsPath(stateDir, sessionId), "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines
      .slice(-Math.max(1, limit))
      .reverse()
      .map((line) => JSON.parse(line) as CodexRecentTurnBinding)
      .filter((entry) => typeof entry.sessionId === "string" && entry.sessionId.length > 0);
  } catch {
    return [];
  }
}

export async function resolveLatestCodexSessionId(stateDir: string): Promise<string | undefined> {
  const latest = await readJsonFile<LatestCodexSessionRef>(latestSessionPath(stateDir));
  const sessionId = typeof latest?.sessionId === "string" ? latest.sessionId.trim() : "";
  return sessionId || undefined;
}
