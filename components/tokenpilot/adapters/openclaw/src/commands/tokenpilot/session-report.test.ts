import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleReport } from "./session-report.js";

test("openclaw handleReport includes recent metrics and recovery aggregates when details are enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenpilot-openclaw-report-"));
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";
  const namespacedDir = join(dir, "tokenpilot");
  try {
    await mkdir(join(namespacedDir, "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(namespacedDir, "ux-effects", "latest.json"),
      `${JSON.stringify({
        sessionId,
        countMode: "chars",
        details: {
          requestSavedCount: 240,
          responseSavedCount: 60,
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(namespacedDir, "ux-effects", "sessions", `${sessionId}.json`),
      `${JSON.stringify({
        sessionId,
        turns: 4,
        latestCountMode: "chars",
        tokenOptimizedTurns: 0,
        tokenSavedCount: 0,
        avgSavedTokensPerOptimizedTurn: 0,
        charOptimizedTurns: 2,
        charSavedCount: 900,
        avgSavedCharsPerOptimizedTurn: 450,
        recoveryObservedSegments: 3,
        recoverySkippedSegments: 3,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(namespacedDir, "ux-effects", "history.jsonl"),
      [
        JSON.stringify({
          sessionId,
          details: {
            routeSavedChars: { search_results: 300, diff_output: 120 },
            routeHitCount: { search_results: 2, diff_output: 1 },
            passSavedChars: { tool_payload_trim: 360 },
            recoveryObservedSegments: 2,
            recoverySkippedSegments: 2,
            skippedReason: "below_trigger_min_chars",
          },
        }),
        JSON.stringify({
          sessionId,
          details: {
            routeSavedChars: { task_doc: 180 },
            routeHitCount: { task_doc: 1 },
            passSavedChars: { read_state_compaction: 80 },
            recoveryObservedSegments: 1,
            recoverySkippedSegments: 1,
            skippedReasons: ["pipeline_no_effect"],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await handleReport(
      { sessionId },
      {
        plugins: {
          entries: {
            tokenpilot: {
              config: {
                stateDir: dir,
                ux: { details: true },
              },
            },
          },
        },
      },
    );

    assert.match(result.text, /saved chars: 900/i);
    assert.match(result.text, /latest request savings: 240 chars/i);
    assert.match(result.text, /latest response savings: 60 chars/i);
    assert.match(result.text, /recent top routes: search_results=300 chars\/2 hits, task_doc=180 chars\/1 hits, diff_output=120 chars\/1 hits/i);
    assert.match(result.text, /recent top passes: tool_payload_trim=360 chars, read_state_compaction=80 chars/i);
    assert.match(result.text, /recent recovery segments: observed=3, exempted=3/i);
    assert.match(result.text, /recent skipped reasons:/i);
    assert.match(result.text, /below_trigger_min_chars=1/i);
    assert.match(result.text, /pipeline_no_effect=1/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
