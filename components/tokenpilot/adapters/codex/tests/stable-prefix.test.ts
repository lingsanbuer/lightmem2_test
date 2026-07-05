import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import { prepareCodexStablePrefix } from "../src/stable-prefix.js";

test("prepareCodexStablePrefix stabilizes instructions and developer prompt while isolating dynamic developer context", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const envelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=agent-123 | mode=interactive",
    ].join("\n"),
    messages: [
      {
        role: "system" as const,
        content: [
          "You are the coding agent.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 | mode=interactive",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  };

  const prepared = prepareCodexStablePrefix(envelope, config);

  assert.notEqual(prepared, envelope);
  assert.match(String(prepared.instructions ?? ""), /Your working directory is: \/repo\/demo/);
  assert.doesNotMatch(String(prepared.instructions ?? ""), /WORKDIR: \/repo\/demo/);
  assert.match(String(prepared.messages[0]?.content ?? ""), /Your working directory is: \/repo\/demo/);
  assert.doesNotMatch(String(prepared.messages[0]?.content ?? ""), /WORKDIR: \/repo\/demo/);
  assert.equal(prepared.messages.length, 3);
  assert.equal(prepared.messages[1]?.role, "system");
  assert.equal((prepared.messages[1] as any)?.metadata?.__codexOriginalRole, "developer");
  assert.match(String(prepared.messages[1]?.content ?? ""), /WORKDIR: \/repo\/demo/);
  assert.match(String(prepared.messages[1]?.content ?? ""), /AGENT_ID: agent-123/);
  assert.match(String(prepared.metadata?.promptCacheKey ?? ""), /^lightmem2-codex-/);
  assert.equal(prepared.metadata?.promptCacheRetention, "24h");
});

test("prepareCodexStablePrefix derives different cache keys for different stable prefixes", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "user",
    },
  });

  const baseEnvelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: "You are the coding agent.\nYour working directory is: /repo/demo",
    messages: [
      {
        role: "system" as const,
        content: "Project A rules.\nYour working directory is: /repo/demo",
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  };

  const preparedA = prepareCodexStablePrefix(baseEnvelope, config);
  const preparedB = prepareCodexStablePrefix({
    ...baseEnvelope,
    messages: [
      {
        ...baseEnvelope.messages[0],
        content: "Project B rules.\nYour working directory is: /repo/demo",
      },
      baseEnvelope.messages[1],
    ],
  }, config);

  assert.notEqual(preparedA.metadata?.promptCacheKey, preparedB.metadata?.promptCacheKey);
});
