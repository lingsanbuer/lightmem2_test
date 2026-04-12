export * from "./types.js";
export * from "./archive.js";
export * from "./detection.js";
export * from "./stub.js";

import type { RuntimeTurnContext } from "@ecoclaw/kernel";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TurnLocalCandidate } from "./types.js";
import { defaultArchiveDir, hashText, sanitizePathPart } from "./archive.js";
import { pickTurnLocalCandidates } from "./detection.js";
import { buildCompactedStub } from "./stub.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export type TurnLocalCompactionConfig = {
  enabled?: boolean;
  archiveDir?: string;
};

const SUPPORTED_COMPACTION_STRATEGIES = new Set([
  "turn_local_evidence_compaction",
  "tool_result_handle",
  "subtask_seed",
  "error_path_record",
]);

function countSenderMetadataBlocks(content: unknown): number {
  if (typeof content !== "object" || content === null) return 0;
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "sender_metadata",
  ).length;
}

async function archiveCandidate(
  candidate: TurnLocalCandidate,
  archiveDir: string,
  timestamp: number,
  idx: number,
): Promise<{ stub: string; archivePath: string }> {
  const fileName = `${timestamp}-${String(idx + 1).padStart(3, "0")}-${sanitizePathPart(candidate.sourceSegmentId)}.json`;
  const archivePath = join(archiveDir, fileName);

  const writePreview = candidate.writeText.slice(0, 320);

  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(
    archivePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "turn_local_tool_result_archive",
        sessionId: "unknown", // filled by caller
        sourceSegmentId: candidate.sourceSegmentId,
        sourceToolName: candidate.sourceToolName,
        sourceDataKey: candidate.sourceDataKey,
        sourceText: candidate.sourceText,
        sourceTextHash: hashText(candidate.sourceText),
        consumedBy: {
          writeSegmentId: candidate.writeSegmentId,
          writeToolName: candidate.writeToolName,
          writeTextPreview: writePreview,
        },
        archivedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const stub = buildCompactedStub(candidate, archivePath);
  return { stub, archivePath };
}

export async function runTurnLocalEvidenceCompaction(
  ctx: RuntimeTurnContext,
  cfg: TurnLocalCompactionConfig,
): Promise<{
  turnCtx: RuntimeTurnContext;
  changed: boolean;
  compactedCount: number;
  archives: string[];
}> {
  const enabled = cfg.enabled ?? false;
  if (!enabled) {
    return { turnCtx: ctx, changed: false, compactedCount: 0, archives: [] };
  }

  const debugLog = (msg: string) => {
    console.log(`[compaction:turn-local] ${msg}`);
  };

  debugLog(`Checking turn-local compaction. segments.length=${ctx.segments.length}`);

  const policyObj = asObject(ctx.metadata?.policy);
  const policyDecision = asObject(policyObj?.decisions);
  const policyCompaction = asObject(policyDecision?.compaction);
  const compactionInstructions = Array.isArray(policyCompaction?.instructions)
    ? (policyCompaction.instructions as Array<{
        strategy: string;
        segmentIds: string[];
        parameters?: Record<string, unknown>;
      }>)
    : [];

  const turnLocalInstructions = compactionInstructions.filter(
    (instr) => SUPPORTED_COMPACTION_STRATEGIES.has(String(instr.strategy ?? "").trim()),
  );

  const policyLocality = asObject(policyDecision?.locality);
  const policyDelayTurns =
    typeof policyLocality?.turnLocalDelayTurns === "number" ? policyLocality.turnLocalDelayTurns : 0;

  if (policyDelayTurns > 0) {
    const policyState = asObject(policyObj?.state);
    const completedTurns =
      typeof policyState?.completedTurns === "number" ? policyState.completedTurns : undefined;
    if (completedTurns === undefined || completedTurns < policyDelayTurns) {
      return { turnCtx: ctx, changed: false, compactedCount: 0, archives: [] };
    }
  }

  if (turnLocalInstructions.length === 0) {
    debugLog(`No compaction instructions from policy`);
    return { turnCtx: ctx, changed: false, compactedCount: 0, archives: [] };
  }

  const segmentIdsToCompact = new Set<string>();
  for (const instr of turnLocalInstructions) {
    for (const id of instr.segmentIds) {
      segmentIdsToCompact.add(id);
    }
  }

  debugLog(`Found ${segmentIdsToCompact.size} segments to compact from policy instructions`);

  const workspaceDir =
    typeof ctx.metadata?.workspaceDir === "string" ? ctx.metadata.workspaceDir : undefined;
  const archiveDir = cfg.archiveDir ?? defaultArchiveDir(ctx.sessionId, workspaceDir);
  const timestamp = Date.now();
  const archives: string[] = [];
  const segmentReplacements = new Map<string, { replacement: string; segmentId: string }>();

  for (const [idx, instr] of turnLocalInstructions.entries()) {
    const segmentId = instr.segmentIds[0];
    if (!segmentId) continue;

    const segment = ctx.segments.find((s) => s.id === segmentId);
    if (!segment) continue;

    const meta = asObject(segment.metadata);
    const toolName = normalizeToolName(meta) ?? "read";
    const dataKey = extractDataKey(meta) ?? "unknown";

    const consumedBy = asObject(instr.parameters?.consumedBy);
    const writeToolName = (consumedBy?.toolName as string) ?? "write";
    const writePreview = ((consumedBy?.writePreview as string) ?? "").slice(0, 320);

    const candidate: TurnLocalCandidate = {
      sourceIndex: ctx.segments.findIndex((s) => s.id === segmentId),
      sourceSegmentId: segmentId,
      sourceToolName: toolName,
      sourceDataKey: dataKey,
      sourceText: segment.text,
      writeIndex: ctx.segments.findIndex((s) => s.id === consumedBy?.segmentId),
      writeSegmentId: (consumedBy?.segmentId as string) ?? "unknown",
      writeToolName,
      writeText: writePreview,
    };

    const fileName = `${timestamp}-${String(idx + 1).padStart(3, "0")}-${sanitizePathPart(segmentId)}.json`;
    const archivePath = join(archiveDir, fileName);

    debugLog(`Archiving ${toolName}(${dataKey}) -> ${writeToolName}`);
    debugLog(`  Archive path: ${archivePath}`);

    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(
      archivePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "turn_local_tool_result_archive",
          sessionId: ctx.sessionId,
          sourceSegmentId: segmentId,
          sourceToolName: toolName,
          sourceDataKey: dataKey,
          sourceText: segment.text,
          sourceTextHash: hashText(segment.text),
          consumedBy: {
            writeSegmentId: consumedBy?.segmentId as string ?? "unknown",
            writeToolName,
            writeTextPreview: writePreview,
          },
          archivedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const stub = buildCompactedStub(candidate, archivePath);
    segmentReplacements.set(segmentId, { replacement: stub, segmentId });
    archives.push(archivePath);
  }

  const nextSegments = ctx.segments.map((segment) => {
    const entry = segmentReplacements.get(segment.id);
    if (!entry) return segment;

    const metadata = asObject(segment.metadata) ?? {};
    return {
      ...segment,
      text: entry.replacement,
      metadata: {
        ...metadata,
        compaction: {
          ...(asObject(metadata.compaction) ?? {}),
          kind: "event_driven_compaction",
          archived: true,
        },
      },
    };
  });

  return {
    turnCtx: {
      ...ctx,
      segments: nextSegments,
      metadata: {
        ...(ctx.metadata ?? {}),
        compaction: {
          ...(asObject(ctx.metadata?.compaction) ?? {}),
          turnLocal: {
            compactedCount: segmentReplacements.size,
            archivePaths: archives,
          },
        },
      },
    },
    changed: true,
    compactedCount: segmentReplacements.size,
    archives,
  };
}

function normalizeToolName(metadata: Record<string, unknown> | undefined): string | undefined {
  const toolPayload = asObject(metadata?.toolPayload);
  const directToolName = typeof metadata?.toolName === "string" ? metadata.toolName : undefined;
  const payloadToolName =
    typeof toolPayload?.toolName === "string" ? (toolPayload.toolName as string) : undefined;
  const raw = directToolName ?? payloadToolName;
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function extractDataKey(metadata: Record<string, unknown> | undefined): string | undefined {
  const toolPayload = asObject(metadata?.toolPayload);
  const candidates = [
    metadata?.path,
    metadata?.file_path,
    metadata?.filePath,
    toolPayload?.path,
    toolPayload?.file_path,
    toolPayload?.filePath,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}
