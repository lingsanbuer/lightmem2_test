import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCliContextState } from "../src/context-store.js";
import { dispatchCli } from "../src/dispatch.js";

test("dispatch supports context inspection and use host flow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-dispatch-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const context0 = await dispatchCli(["context"]);
    assert.match(context0.text, /lastActiveHost: \(unset\)/);

    const useHost = await dispatchCli(["use", "openclaw"]);
    assert.equal(useHost.text, "Default host = openclaw");

    const persisted = await readCliContextState(join(dir, ".lightmem2", "state", "cli-context.json"));
    assert.equal(persisted.lastActiveHost, "openclaw");

    const context1 = await dispatchCli(["context"]);
    assert.match(context1.text, /lastActiveHost: openclaw/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
