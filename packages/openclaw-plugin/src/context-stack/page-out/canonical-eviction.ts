/* eslint-disable @typescript-eslint/no-explicit-any */
import { join } from "node:path";
import {
  applyCanonicalEviction as applyCanonicalEvictionBase,
  computeClosureDeferredTaskInfo,
  type EvictionHelpers,
} from "@ecoclaw/layer-history";

export { computeClosureDeferredTaskInfo, type EvictionHelpers };

export async function applyCanonicalEviction(
  params: Omit<Parameters<typeof applyCanonicalEvictionBase>[0], "archiveDir" | "persistedBy" | "archiveSourceLabel">,
): ReturnType<typeof applyCanonicalEvictionBase> {
  return applyCanonicalEvictionBase({
    ...params,
    archiveDir: join(params.stateDir, "ecoclaw", "canonical-eviction", "task"),
    persistedBy: "ecoclaw.context_engine.eviction",
    archiveSourceLabel: "canonical_task_eviction",
  });
}
