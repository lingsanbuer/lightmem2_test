/**
 * Compaction module - event-driven single executor:
 *
 * - Policy/trigger layer decides WHAT to compact and WHEN.
 * - Execution layer applies compaction instructions with one executor.
 *
 * This intentionally avoids coupling compaction execution to session-global
 * summarization/fork behavior.
 */

// Shared types & config
export * from "./types.js";

// Compaction executor layer
export * from "./turn-local/index.js";

// Legacy session-global exports kept for compatibility with existing tests/tools.
// Runtime path is no longer wired through session-global compaction.
export {
  buildCompactionPlan,
} from "./session-global/plan-builder.js";
export {
  generateCompactionArtifact,
} from "./session-global/index.js";

import type { RuntimeModule } from "@ecoclaw/kernel";
import type { CompactionModuleConfig } from "./types.js";
import { runTurnLocalEvidenceCompaction } from "./turn-local/index.js";

export function createCompactionModule(cfg: CompactionModuleConfig = {}): RuntimeModule {
  return {
    name: "module-compaction",
    async beforeCall(ctx) {
      const turnLocal = await runTurnLocalEvidenceCompaction(ctx, {
        enabled: cfg.turnLocalCompaction?.enabled ?? false,
        archiveDir: cfg.turnLocalCompaction?.archiveDir,
      });
      return turnLocal.turnCtx;
    },
    async afterCall(_ctx, result) {
      return result;
    },
  };
}
