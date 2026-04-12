import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContextSegment, RuntimeStateStore, RuntimeTurnContext } from "@ecoclaw/kernel";
import type { ReductionPassHandler } from "../../composer/reduction/types.js";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_HEAD_PREVIEW_SIZE = 600;
const DEFAULT_TAIL_PREVIEW_SIZE = 400;

type RepeatedReadDedupConfig = {
  headPreviewSize: number;
  tailPreviewSize: number;
  noteLabel: string;
  archiveDir?: string;
  enabled: boolean;
  keepFirstRead: boolean; // If true, keep first read; if false, keep last read
};

// ============================================================================
// Utility Functions
// ============================================================================

const parsePositiveInt = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const parseBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const resolveConfig = (options?: Record<string, unknown>): RepeatedReadDedupConfig => ({
  headPreviewSize: parsePositiveInt(options?.headPreviewSize, DEFAULT_HEAD_PREVIEW_SIZE),
  tailPreviewSize: parsePositiveInt(options?.tailPreviewSize, DEFAULT_TAIL_PREVIEW_SIZE),
  noteLabel:
    typeof options?.noteLabel === "string" && options.noteLabel.trim().length > 0
      ? options.noteLabel.trim()
      : "repeated_read_dedup",
  archiveDir: typeof options?.archiveDir === "string" ? options.archiveDir : undefined,
  enabled: parseBool(options?.enabled, true),
  keepFirstRead: parseBool(options?.keepFirstRead, true),
});

const clipText = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;

const sanitizePathPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "_");

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  !value || typeof value !== "object" || Array.isArray(value) ? undefined : value as Record<string, unknown>;

const normalizeToolName = (metadata: Record<string, unknown> | undefined): string | undefined => {
  const toolPayload = asObject(metadata?.toolPayload);
  const directToolName = typeof metadata?.toolName === "string" ? metadata.toolName : undefined;
  const payloadToolName =
    typeof toolPayload?.toolName === "string" ? (toolPayload.toolName as string) : undefined;
  const raw = directToolName ?? payloadToolName;
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

const extractDataKey = (metadata: Record<string, unknown> | undefined): string | undefined => {
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
};

// ============================================================================
// Archive Directory Resolution
// ============================================================================

const defaultArchiveDir = (sessionId: string, workspaceDir?: string): string => {
  if (workspaceDir) {
    return join(workspaceDir, ".ecoclaw-archives");
  }

  const match = sessionId.match(/-(\d+)-j(\d+)$/);
  if (match) {
    const runId = match[1];
    const jobId = match[2];
    return `/tmp/pinchbench/${runId}/agent_workspace_j${jobId}/.ecoclaw-archives`;
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
  return join(homeDir, ".openclaw", "ecoclaw-plugin-state", "ecoclaw", "tool-result-archives", sanitizePathPart(sessionId));
};

// ============================================================================
// Deduplication Logic
// ============================================================================

const buildDedupStub = (
  toolName: string,
  dataKey: string,
  originalSize: number,
  archivePath: string,
  keptReadIndex: number,
): string => {
  return (
    `[Repeated ${toolName} deduplicated] First read of \`${dataKey}\` is preserved (${originalSize.toLocaleString()} chars). ` +
    `This repeated read has been removed to save context. ` +
    `Full archive: ${archivePath}`
  );
};

type DedupResult = {
  text: string;
  changed: boolean;
  archivePath?: string;
  originalSize?: number;
};

const deduplicateRead = async (
  segment: ContextSegment,
  sessionId: string,
  firstReadSegment: ContextSegment,
  config: RepeatedReadDedupConfig,
  workspaceDir?: string,
): Promise<DedupResult> => {
  const meta = asObject(segment.metadata);
  const toolName = normalizeToolName(meta) ?? "read";
  const dataKey = extractDataKey(meta) ?? "unknown";

  const archiveDir = config.archiveDir ?? defaultArchiveDir(sessionId, workspaceDir);
  const timestamp = Date.now();
  const fileName = `${timestamp}-${sanitizePathPart(segment.id)}.json`;
  const archivePath = join(archiveDir, fileName);

  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(
    archivePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "repeated_read_dedup_archive",
        sessionId,
        segmentId: segment.id,
        toolName,
        dataKey,
        originalText: segment.text,
        originalSize: segment.text.length,
        firstReadSegmentId: firstReadSegment.id,
        archivedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const truncatedStub = buildDedupStub(
    toolName,
    dataKey,
    firstReadSegment.text.length,
    archivePath,
    0,
  );

  return {
    text: truncatedStub,
    changed: true,
    archivePath,
    originalSize: segment.text.length,
  };
};

// ============================================================================
// Pass Handler
// ============================================================================

async function resolveFirstReadSegment(
  firstReadId: string,
  turnCtx: RuntimeTurnContext,
  stateStore?: RuntimeStateStore,
): Promise<ContextSegment | undefined> {
  // Priority 1: Try stateStore first - firstReadSegmentId typically points to a historical turn
  if (stateStore) {
    try {
      // Read turns.jsonl to find the segment
      const turns = await stateStore.listTurns(turnCtx.sessionId);

      // Search all turns for the matching segment
      for (const turn of turns) {
        const found = turn.segments.find((s) => s.id === firstReadId);
        if (found) {
          return {
            id: found.id,
            kind: found.kind,
            text: found.text,
            priority: found.priority,
            source: found.source ?? "stateStore",
            metadata: found.metadata,
          };
        }
      }
    } catch {
      // Fall through to current context as fallback
    }
  }

  // Priority 2: Fallback to current turn context
  const inContext = turnCtx.segments.find((s) => s.id === firstReadId);
  if (inContext) {
    return inContext;
  }

  return undefined;
}

export const repeatedReadDedupPass: ReductionPassHandler = {
  beforeCall: async ({ turnCtx, spec, stateStore }) => {
    const config = resolveConfig(spec.options);

    if (!config.enabled) {
      return {
        changed: false,
        skippedReason: "pass_disabled",
      };
    }

    // Check if policy provided instructions for this strategy
    const policy = asObject(turnCtx.metadata?.policy);
    const decisions = asObject(policy?.decisions);
    const reduction = asObject(decisions?.reduction);
    const instructions = Array.isArray(reduction?.instructions)
      ? (reduction.instructions as Array<{ strategy: string; segmentIds: string[]; parameters?: Record<string, unknown> }>)
      : [];

    // Find instructions for repeated_read_dedup strategy
    const repeatedReadInstructions = instructions.filter(
      (instr) => instr.strategy === "repeated_read_dedup",
    );

    if (repeatedReadInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }

    // Build a set of segment IDs to deduplicate
    const dedupSegmentIds = new Set<string>();
    for (const instr of repeatedReadInstructions) {
      for (const id of instr.segmentIds) {
        dedupSegmentIds.add(id);
      }
    }

    // Build a map of first read segment for each group
    const firstReadMap = new Map<string, ContextSegment>();
    for (const instr of repeatedReadInstructions) {
      const firstReadId = instr.parameters?.firstReadSegmentId as string | undefined;
      if (firstReadId) {
        const firstReadSegment = await resolveFirstReadSegment(firstReadId, turnCtx, stateStore);
        if (firstReadSegment) {
          for (const id of instr.segmentIds) {
            firstReadMap.set(id, firstReadSegment);
          }
        }
      }
    }

    // Perform deduplication
    const touchedSegmentIds: string[] = [];
    let totalSavedChars = 0;
    const archivePaths: string[] = [];

    const workspaceDir =
      typeof turnCtx.metadata?.workspaceDir === "string"
        ? turnCtx.metadata.workspaceDir
        : undefined;

    const nextSegments: ContextSegment[] = [];
    for (const segment of turnCtx.segments) {
      if (!dedupSegmentIds.has(segment.id)) {
        nextSegments.push(segment);
        continue;
      }

      const firstReadSegment = firstReadMap.get(segment.id);
      if (!firstReadSegment) {
        nextSegments.push(segment);
        continue;
      }

      const dedupResult = await deduplicateRead(
        segment,
        turnCtx.sessionId,
        firstReadSegment,
        config,
        workspaceDir,
      );
      if (!dedupResult.changed) {
        nextSegments.push(segment);
        continue;
      }

      const meta = asObject(segment.metadata) ?? {};
      if (dedupResult.archivePath) {
        archivePaths.push(dedupResult.archivePath);
      }
      touchedSegmentIds.push(segment.id);
      totalSavedChars += segment.text.length;

      nextSegments.push({
        ...segment,
        text: dedupResult.text,
        metadata: {
          ...meta,
          reduction: {
            ...(meta?.reduction as Record<string, unknown> ?? {}),
            repeatedReadDedup: {
              deduplicated: true,
              originalSize: segment.text.length,
              firstReadSegmentId: firstReadSegment.id,
              archivePath: dedupResult.archivePath,
            },
          },
        },
      });
    }

    if (touchedSegmentIds.length === 0) {
      return {
        changed: false,
        skippedReason: "no_segments_to_dedup",
      };
    }

    return {
      changed: true,
      turnCtx: {
        ...turnCtx,
        segments: nextSegments,
      },
      note: `${config.noteLabel}:deduplicated=${touchedSegmentIds.length},saved=${totalSavedChars.toLocaleString()}chars`,
      touchedSegmentIds,
      metadata: {
        archivePaths,
        totalSavedChars,
      },
    };
  },
};
