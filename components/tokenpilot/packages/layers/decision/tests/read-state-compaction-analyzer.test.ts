import test from "node:test";
import assert from "node:assert/strict";

import type { ContextSegment } from "@tokenpilot/kernel";
import { analyzeReadStateCompaction } from "../src/reduction/read-state-compaction-analyzer.js";

function buildSegment(
  id: string,
  toolName: string,
  path: string,
  text: string,
  fieldName?: string,
  readWindow?: { offset?: number; limit?: number },
): ContextSegment {
  return {
    id,
    kind: "volatile",
    priority: 1,
    text,
    metadata: {
      toolName,
      path,
      ...(fieldName ? { fieldName } : {}),
      ...(readWindow ? { readWindow } : {}),
      toolPayload: {
        toolName,
        path,
        ...(readWindow ? { readWindow } : {}),
      },
    },
  };
}

test("decision analyzer emits superseded compaction for reread with changed content", () => {
  const decision = analyzeReadStateCompaction([
    buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;\n".repeat(50), "output"),
    buildSegment("read-2-output", "read", "/repo/a.ts", "const a = 2;\n".repeat(50), "output"),
  ]);

  assert.equal(decision.instructions.length, 1);
  assert.equal(decision.instructions[0]?.strategy, "read_state_compaction");
  assert.deepEqual(decision.instructions[0]?.segmentIds, ["read-1-output"]);
  assert.equal(decision.instructions[0]?.parameters?.state, "superseded");
});

test("decision analyzer emits stale compaction after later mutation", () => {
  const decision = analyzeReadStateCompaction([
    buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;\n".repeat(80), "output"),
    buildSegment("edit-1-arguments", "edit", "/repo/a.ts", "{\"replace\":\"1\",\"with\":\"2\"}", "arguments"),
  ]);

  assert.equal(decision.instructions.length, 1);
  assert.deepEqual(decision.instructions[0]?.segmentIds, ["read-1-output"]);
  assert.equal(decision.instructions[0]?.parameters?.state, "stale");
});

test("decision analyzer does not collapse distinct read windows", () => {
  const decision = analyzeReadStateCompaction([
    buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;", "output", { offset: 1, limit: 200 }),
    buildSegment("read-2-output", "read", "/repo/a.ts", "const z = 26;", "output", { offset: 201, limit: 200 }),
  ]);

  assert.equal(decision.instructions.length, 0);
});
