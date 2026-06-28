import {
  readLatestUxEffect,
  readUxSessionAggregate,
  recordUxEffect,
  type TokenPilotUxCountMode,
  type TokenPilotUxEffectRecord,
  type TokenPilotUxSessionAggregate,
} from "@tokenpilot/host-adapter";

export type CodexUxCountMode = TokenPilotUxCountMode;

export type CodexUxEffectRecord = TokenPilotUxEffectRecord;

export type CodexUxSessionAggregate = TokenPilotUxSessionAggregate;

export async function recordCodexUxEffect(
  stateDir: string,
  record: CodexUxEffectRecord,
): Promise<void> {
  await recordUxEffect(stateDir, record);
}

export async function readLatestCodexUxEffect(stateDir: string): Promise<CodexUxEffectRecord | null> {
  return readLatestUxEffect(stateDir);
}

export async function readCodexUxSessionAggregate(
  stateDir: string,
  sessionId: string,
): Promise<CodexUxSessionAggregate | null> {
  return readUxSessionAggregate(stateDir, sessionId);
}
