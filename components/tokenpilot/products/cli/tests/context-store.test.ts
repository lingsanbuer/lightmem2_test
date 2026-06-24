import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readCliContextState,
  updateCliContextState,
  writeCliContextState,
} from "../src/context-store.js";

test("context store reads empty state by default and persists updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-context-"));
  const file = join(dir, "cli-context.json");
  try {
    const empty = await readCliContextState(file);
    assert.deepEqual(empty, { lastSessionByHost: {} });

    await updateCliContextState({ host: "openclaw" }, file);
    const withHost = await readCliContextState(file);
    assert.equal(withHost.lastActiveHost, "openclaw");
    assert.deepEqual(withHost.lastSessionByHost, {});

    await updateCliContextState({ host: "openclaw", sessionId: "sess-1" }, file);
    const withSession = await readCliContextState(file);
    assert.equal(withSession.lastActiveHost, "openclaw");
    assert.equal(withSession.lastSessionByHost?.openclaw, "sess-1");
    assert.ok(withSession.lastUpdatedAt);

    await writeCliContextState({
      lastActiveHost: "codex",
      lastSessionByHost: { codex: "sess-2" },
      lastUpdatedAt: "2026-06-24T00:00:00.000Z",
    }, file);
    const replaced = await readCliContextState(file);
    assert.equal(replaced.lastActiveHost, "codex");
    assert.equal(replaced.lastSessionByHost?.codex, "sess-2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
