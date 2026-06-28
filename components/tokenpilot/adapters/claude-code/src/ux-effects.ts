import {
  readLatestUxEffect,
  readUxSessionAggregate,
  recordUxEffect,
  type TokenPilotUxCountMode,
  type TokenPilotUxEffectRecord,
  type TokenPilotUxSessionAggregate,
} from "@tokenpilot/host-adapter";

export type ClaudeCodeUxCountMode = TokenPilotUxCountMode;

export type ClaudeCodeUxEffectRecord = TokenPilotUxEffectRecord;

export type ClaudeCodeUxSessionAggregate = TokenPilotUxSessionAggregate;

export async function recordClaudeCodeUxEffect(
  stateDir: string,
  record: ClaudeCodeUxEffectRecord,
): Promise<void> {
  await recordUxEffect(stateDir, record);
}

export async function readLatestClaudeCodeUxEffect(stateDir: string): Promise<ClaudeCodeUxEffectRecord | null> {
  return readLatestUxEffect(stateDir);
}

export async function readClaudeCodeUxSessionAggregate(
  stateDir: string,
  sessionId: string,
): Promise<ClaudeCodeUxSessionAggregate | null> {
  return readUxSessionAggregate(stateDir, sessionId);
}
