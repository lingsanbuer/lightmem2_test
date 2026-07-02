import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginStateSubdirCandidates } from "@tokenpilot/runtime-core";

export type RecentReductionMetrics = {
  sampledTurns: number;
  routeSavedChars: Record<string, number>;
  routeHitCount: Record<string, number>;
  passSavedChars: Record<string, number>;
  recoveryObservedSegments: number;
  recoverySkippedSegments: number;
  skippedReasons: Record<string, number>;
};

type HistoryEntry = {
  sessionId?: string;
  details?: {
    routeSavedChars?: Record<string, number>;
    routeHitCount?: Record<string, number>;
    passSavedChars?: Record<string, number>;
    recoveryObservedSegments?: number;
    recoverySkippedSegments?: number;
    skippedReason?: string;
    skippedReasons?: string[];
  };
};

function historyPaths(stateDir: string): string[] {
  return [
    join(stateDir, "ux-effects", "history.jsonl"),
    ...pluginStateSubdirCandidates(stateDir, "ux-effects", "history.jsonl"),
  ];
}

export async function readRecentReductionMetrics(
  stateDir: string,
  sessionId: string,
  limit = 12,
): Promise<RecentReductionMetrics | null> {
  for (const historyPath of historyPaths(stateDir)) {
    try {
      const raw = await readFile(historyPath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean).reverse();
      const routeSavedChars: Record<string, number> = {};
      const routeHitCount: Record<string, number> = {};
      const passSavedChars: Record<string, number> = {};
      const skippedReasons: Record<string, number> = {};
      let recoveryObservedSegments = 0;
      let recoverySkippedSegments = 0;
      let sampledTurns = 0;

      for (const line of lines) {
        if (sampledTurns >= limit) break;
        let parsed: HistoryEntry;
        try {
          parsed = JSON.parse(line) as HistoryEntry;
        } catch {
          continue;
        }
        if (parsed.sessionId !== sessionId) continue;
        const details = parsed.details;
        const hasMetrics =
          details?.routeSavedChars ||
          details?.routeHitCount ||
          details?.passSavedChars ||
          details?.recoveryObservedSegments ||
          details?.recoverySkippedSegments ||
          details?.skippedReason ||
          details?.skippedReasons;
        if (!hasMetrics) continue;
        sampledTurns += 1;
        for (const [key, value] of Object.entries(details?.routeSavedChars ?? {})) {
          routeSavedChars[key] = (routeSavedChars[key] ?? 0) + Number(value || 0);
        }
        for (const [key, value] of Object.entries(details?.routeHitCount ?? {})) {
          routeHitCount[key] = (routeHitCount[key] ?? 0) + Number(value || 0);
        }
        for (const [key, value] of Object.entries(details?.passSavedChars ?? {})) {
          passSavedChars[key] = (passSavedChars[key] ?? 0) + Number(value || 0);
        }
        recoveryObservedSegments += Number(details?.recoveryObservedSegments ?? 0);
        recoverySkippedSegments += Number(details?.recoverySkippedSegments ?? 0);
        const reasons = [
          ...(typeof details?.skippedReason === "string" && details.skippedReason.trim()
            ? [details.skippedReason.trim()]
            : []),
          ...((details?.skippedReasons ?? [])
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .map((value) => value.trim())),
        ];
        for (const reason of reasons) {
          skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
        }
      }

      if (sampledTurns === 0) continue;
      return {
        sampledTurns,
        routeSavedChars,
        routeHitCount,
        passSavedChars,
        recoveryObservedSegments,
        recoverySkippedSegments,
        skippedReasons,
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}
