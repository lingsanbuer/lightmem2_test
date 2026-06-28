import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ClaudeCodeSessionSnapshot = {
  sessionId: string;
  latestResponseId?: string;
  previousResponseId?: string;
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
  updatedAt: string;
};

export type ClaudeCodeRecentTurnBinding = {
  sessionId: string;
  responseId?: string;
  previousResponseId?: string;
  model?: string;
  requestChars?: number;
  responseChars?: number;
  assistantChars?: number;
  reductionSavedChars?: number;
  stablePrefixApplied?: boolean;
  reductionApplied?: boolean;
  stream?: boolean;
  updatedAt: string;
};

type LatestClaudeCodeSessionRef = {
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
  } satisfies LatestClaudeCodeSessionRef);
}

export async function loadClaudeCodeSessionSnapshot(
  stateDir: string,
  sessionId: string,
): Promise<ClaudeCodeSessionSnapshot | null> {
  return readJsonFile<ClaudeCodeSessionSnapshot>(sessionSnapshotPath(stateDir, sessionId));
}

export async function upsertClaudeCodeSessionSnapshot(
  stateDir: string,
  sessionId: string,
  patch: Partial<ClaudeCodeSessionSnapshot>,
): Promise<ClaudeCodeSessionSnapshot> {
  const current = await loadClaudeCodeSessionSnapshot(stateDir, sessionId);
  const updatedAt = new Date().toISOString();
  const next: ClaudeCodeSessionSnapshot = {
    sessionId,
    latestResponseId: patch.latestResponseId ?? current?.latestResponseId,
    previousResponseId: patch.previousResponseId ?? current?.previousResponseId,
    latestModel: patch.latestModel ?? current?.latestModel,
    workspaceHint: patch.workspaceHint ?? current?.workspaceHint,
    lastHookEvent: patch.lastHookEvent ?? current?.lastHookEvent,
    lastToolName: patch.lastToolName ?? current?.lastToolName,
    lastToolInputChars: patch.lastToolInputChars ?? current?.lastToolInputChars,
    lastToolOutputChars: patch.lastToolOutputChars ?? current?.lastToolOutputChars,
    requestChars: patch.requestChars ?? current?.requestChars,
    responseChars: patch.responseChars ?? current?.responseChars,
    assistantChars: patch.assistantChars ?? current?.assistantChars,
    reductionSavedChars: patch.reductionSavedChars ?? current?.reductionSavedChars,
    updatedAt,
  };
  await writeJsonFileAtomic(sessionSnapshotPath(stateDir, sessionId), next);
  await markLatestSession(stateDir, sessionId, updatedAt);
  return next;
}

export async function appendClaudeCodeRecentTurnBinding(
  stateDir: string,
  binding: ClaudeCodeRecentTurnBinding,
): Promise<void> {
  await appendJsonl(recentTurnBindingsPath(stateDir, binding.sessionId), binding);
  await markLatestSession(stateDir, binding.sessionId, binding.updatedAt);
}

export async function loadClaudeCodeRecentTurnBindings(
  stateDir: string,
  sessionId: string,
  limit = 8,
): Promise<ClaudeCodeRecentTurnBinding[]> {
  try {
    const raw = await readFile(recentTurnBindingsPath(stateDir, sessionId), "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines
      .slice(-Math.max(1, limit))
      .reverse()
      .map((line) => JSON.parse(line) as ClaudeCodeRecentTurnBinding)
      .filter((entry) => typeof entry.sessionId === "string" && entry.sessionId.length > 0);
  } catch {
    return [];
  }
}

export async function resolveLatestClaudeCodeSessionId(stateDir: string): Promise<string | undefined> {
  const latest = await readJsonFile<LatestClaudeCodeSessionRef>(latestSessionPath(stateDir));
  const sessionId = typeof latest?.sessionId === "string" ? latest.sessionId.trim() : "";
  return sessionId || undefined;
}
