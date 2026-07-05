import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendReductionVisualSnapshot,
  readVisualSessionData,
  readVisualSessionList,
} from "../src/visual/session-visual-data.js";

test("readVisualSessionData returns reduction snapshot route and ux aggregate", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-product-surface-visual-"));
  try {
    const stateDir = root;
    const sessionId = "session-1";

    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:00:00.000Z",
      sessionId,
      requestId: "req-1",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-1",
      itemIndex: 0,
      field: "output",
      toolName: "read",
      dataPath: "/repo/README.md",
      savedChars: 320,
      route: "readme_doc",
      routeReason: "readme_path_hint",
      passSavedChars: {
        tool_payload_trim: 300,
        read_state_compaction: 20,
      },
      beforeText: "before",
      afterText: "after",
      report: [],
    });
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:00:01.000Z",
      sessionId,
      requestId: "req-1",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-1",
      itemIndex: 0,
      field: "output",
      toolName: "read",
      dataPath: "/repo/README.md",
      savedChars: 320,
      route: "readme_doc",
      routeReason: "readme_path_hint",
      passSavedChars: {
        tool_payload_trim: 300,
        read_state_compaction: 20,
      },
      beforeText: "before",
      afterText: "after",
      report: [],
    });
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:00:02.000Z",
      sessionId,
      requestId: "req-1",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-2",
      itemIndex: 1,
      field: "output",
      toolName: "read",
      dataPath: "/repo/src/app.ts",
      savedChars: 180,
      route: "code_like",
      routeReason: "code_fence",
      passSavedChars: {
        tool_payload_trim: 180,
      },
      beforeText: "before-2",
      afterText: "after-2",
      report: [],
    });
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:00:03.000Z",
      sessionId,
      requestId: "req-2",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-3",
      itemIndex: 0,
      field: "output",
      toolName: "grep",
      dataPath: "/repo/log.txt",
      savedChars: 90,
      route: "logs",
      routeReason: "stderr_log",
      passSavedChars: {
        tool_payload_trim: 90,
      },
      beforeText: "before-3",
      afterText: "after-3",
      report: [],
    });

    const aggregatePath = join(stateDir, "tokenpilot", "ux-effects", "sessions", `${sessionId}.json`);
    await mkdir(join(stateDir, "tokenpilot", "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(stateDir, "tokenpilot", "ux-effects", "history.jsonl"),
      `${JSON.stringify({
        sessionId,
        details: {
          routeSavedChars: { readme_doc: 320 },
          routeHitCount: { readme_doc: 1 },
          passSavedChars: { tool_payload_trim: 300, read_state_compaction: 20 },
        },
      })}\n`,
    );
    await writeFile(aggregatePath, JSON.stringify({
      sessionId,
      turns: 3,
      latestCountMode: "chars",
      charOptimizedTurns: 2,
      charSavedCount: 640,
      avgSavedCharsPerOptimizedTurn: 320,
      passSavedChars: { tool_payload_trim: 500 },
      routeSavedChars: { readme_doc: 640 },
      routeHitCount: { readme_doc: 2 },
    }, null, 2));
    await writeFile(
      join(stateDir, "cache-audit.jsonl"),
      [
        JSON.stringify({
          at: "2026-07-02T12:00:00.000Z",
          sessionId,
          model: "gpt-5.4",
          stream: false,
          stablePrefixFingerprint: "fp-1",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "path" }],
          driftReasons: [{ kind: "segment_text_changed", key: "instructions", detail: "changed" }],
          requestPromptCacheKey: "pk-1",
          responsePromptCacheKey: "pk-1",
          cachedInputTokens: 0,
          usage: { input_tokens: 100 },
          status: 200,
        }),
        JSON.stringify({
          at: "2026-07-02T12:01:00.000Z",
          sessionId,
          model: "gpt-5.4",
          stream: false,
          stablePrefixFingerprint: "fp-1",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "path" }],
          driftReasons: [{ kind: "segment_text_changed", key: "instructions", detail: "changed" }],
          requestPromptCacheKey: "pk-1",
          responsePromptCacheKey: "pk-2",
          cachedInputTokens: 64,
          usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 } },
          status: 200,
        }),
      ].join("\n"),
    );

    const data = await readVisualSessionData(stateDir, sessionId);
    assert.equal(data.reduction.length, 3);
    assert.equal(data.reduction[0]?.route, "logs");
    assert.equal(data.reduction[1]?.route, "code_like");
    assert.equal(data.reduction[2]?.routeReason, "readme_path_hint");
    assert.equal(data.reductionCalls?.length, 2);
    assert.equal(data.reductionCalls?.[0]?.requestId, "req-2");
    assert.equal(data.reductionCalls?.[0]?.segmentCount, 1);
    assert.equal(data.reductionCalls?.[0]?.totalSavedChars, 90);
    assert.equal(data.reductionCalls?.[1]?.requestId, "req-1");
    assert.equal(data.reductionCalls?.[1]?.segmentCount, 2);
    assert.equal(data.reductionCalls?.[1]?.totalSavedChars, 500);
    assert.equal(data.reductionCalls?.[1]?.toolNames.join(","), "read");
    assert.equal(data.reductionCalls?.[1]?.routes.join(","), "code_like,readme_doc");
    assert.equal(data.uxAggregate?.charSavedCount, 640);
    assert.equal(data.uxAggregate?.routeSavedChars?.readme_doc, 640);
    assert.equal(data.recentReduction?.totalSavedChars, 320);
    assert.equal(data.recentReduction?.dominantRoute?.key, "readme_doc");
    assert.equal(data.recentReduction?.dominantPass?.key, "tool_payload_trim");
    assert.equal(data.cacheAuditSummary?.warmCandidates, 1);
    assert.equal(data.cacheAuditSummary?.warmHits, 1);
    assert.equal(data.cacheAuditSummary?.responsePromptCacheKeyRewriteCount, 1);
    assert.equal(data.cacheAuditSummary?.promptCacheKeyMismatchCount, 1);
    assert.equal(data.recentCacheAudit?.length, 2);
    assert.equal(data.recentCacheAudit?.[0]?.cachedInputTokens, 64);
    assert.equal(data.recentCacheAudit?.[0]?.requestPromptCacheKey, "pk-1");
    assert.equal(data.recentCacheAudit?.[0]?.responsePromptCacheKey, "pk-2");
    assert.equal(data.recentCacheAudit?.[0]?.entropyKinds[0], "abs_path");
    assert.equal(data.recentCacheAudit?.[0]?.driftKeys[0], "instructions");
    assert.equal(data.recentCacheAuditGroups?.length, 1);
    assert.equal(data.recentCacheAuditGroups?.[0]?.requestCount, 2);
    assert.equal(data.recentCacheAuditGroups?.[0]?.warmHitCount, 1);
    assert.equal(data.recentCacheAuditGroups?.[0]?.rewriteCount, 1);
    assert.equal(data.recentCacheAuditGroups?.[0]?.stablePrefixFingerprint, "fp-1");
    const sessions = await readVisualSessionList(stateDir);
    assert.equal(sessions[0]?.latestCountMode, "chars");
    assert.equal(sessions[0]?.charSavedCount, 640);
    assert.equal(sessions[0]?.reductionCount, 2);
    assert.equal(sessions[0]?.cacheAuditSummary?.warmHits, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readVisualSessionData and readVisualSessionList keep session cache-audit summaries when other sessions are newer", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-product-surface-visual-cache-session-"));
  try {
    const stateDir = root;
    const targetSessionId = "session-target";
    const noisySessionId = "session-noisy";
    await writeFile(
      join(stateDir, "cache-audit.jsonl"),
      [
        JSON.stringify({
          at: "2026-07-02T12:00:00.000Z",
          sessionId: targetSessionId,
          model: "gpt-5.4",
          stream: false,
          stablePrefixFingerprint: "fp-target",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [],
          driftReasons: [],
          requestPromptCacheKey: "pk-target",
          responsePromptCacheKey: "pk-target",
          cachedInputTokens: 0,
          usage: { input_tokens: 100 },
          status: 200,
        }),
        JSON.stringify({
          at: "2026-07-02T12:01:00.000Z",
          sessionId: targetSessionId,
          model: "gpt-5.4",
          stream: false,
          stablePrefixFingerprint: "fp-target",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [],
          driftReasons: [],
          requestPromptCacheKey: "pk-target",
          responsePromptCacheKey: "pk-target",
          cachedInputTokens: 64,
          usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 } },
          status: 200,
        }),
        ...Array.from({ length: 80 }, (_item, index) => JSON.stringify({
          at: `2026-07-02T12:${String(index + 2).padStart(2, "0")}:00.000Z`,
          sessionId: noisySessionId,
          model: "gpt-5.4",
          stream: false,
          stablePrefixFingerprint: `fp-noisy-${index}`,
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [],
          driftReasons: [],
          requestPromptCacheKey: `pk-noisy-${index}`,
          responsePromptCacheKey: `pk-noisy-${index}`,
          cachedInputTokens: 0,
          usage: { input_tokens: 100 },
          status: 200,
        })),
      ].join("\n"),
    );
    await mkdir(join(stateDir, "tokenpilot", "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(stateDir, "tokenpilot", "ux-effects", "sessions", `${targetSessionId}.json`),
      JSON.stringify({ sessionId: targetSessionId, latestAt: "2026-07-02T12:01:00.000Z" }),
    );
    await writeFile(
      join(stateDir, "tokenpilot", "ux-effects", "sessions", `${noisySessionId}.json`),
      JSON.stringify({ sessionId: noisySessionId, latestAt: "2026-07-02T13:59:00.000Z" }),
    );
    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:01:00.000Z",
      sessionId: targetSessionId,
      requestId: "req-target",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-target",
      itemIndex: 0,
      field: "output",
      savedChars: 10,
      beforeText: "before",
      afterText: "after",
      report: [],
    });

    const data = await readVisualSessionData(stateDir, targetSessionId);
    assert.equal(data.cacheAuditSummary?.warmCandidates, 1);
    assert.equal(data.cacheAuditSummary?.warmHits, 1);
    assert.equal(data.recentCacheAudit?.length, 2);

    const sessions = await readVisualSessionList(stateDir);
    const target = sessions.find((session) => session.sessionId === targetSessionId);
    assert.equal(target?.cacheAuditSummary?.warmCandidates, 1);
    assert.equal(target?.cacheAuditSummary?.warmHits, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
