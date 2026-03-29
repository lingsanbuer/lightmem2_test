import type { RuntimeModule } from "@ecoclaw/kernel";
import {
  readReductionMetadata,
  resolveReductionPasses,
  runReductionAfterCall,
  runReductionBeforeCall,
} from "./pipeline.js";
import type { ReductionMetadata, ReductionModuleConfig } from "./types.js";

export * from "./types.js";
export * from "./registry.js";
export * from "./pipeline.js";
export * from "./pass-tool-payload-trim.js";
export * from "./pass-format-slimming.js";
export * from "./pass-semantic-llmlingua2.js";

export function createReductionModule(cfg: ReductionModuleConfig = {}): RuntimeModule {
  const passes = resolveReductionPasses(cfg);

  return {
    name: "module-reduction",
    async beforeCall(ctx) {
      const { turnCtx: reducedCtx, report } = await runReductionBeforeCall({
        turnCtx: ctx,
        passes,
        registry: cfg.registry,
      });
      const prior = readReductionMetadata(reducedCtx.metadata);
      const metadata: ReductionMetadata = {
        beforeCall: report,
        afterCall: prior.afterCall,
      };
      return {
        ...reducedCtx,
        metadata: {
          ...(reducedCtx.metadata ?? {}),
          reduction: metadata,
        },
      };
    },
    async afterCall(ctx, result) {
      const { result: reducedResult, report } = await runReductionAfterCall({
        turnCtx: ctx,
        result,
        passes,
        registry: cfg.registry,
      });
      const prior = readReductionMetadata(ctx.metadata);
      const metadata: ReductionMetadata = {
        beforeCall: prior.beforeCall,
        afterCall: report,
      };

      return {
        ...reducedResult,
        metadata: {
          ...(reducedResult.metadata ?? {}),
          reduction: metadata,
        },
      };
    },
  };
}
