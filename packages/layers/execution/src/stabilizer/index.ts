import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  type RuntimeModule,
} from "@ecoclaw/kernel";
import { createHash } from "node:crypto";

export type StabilizerModuleConfig = {
  minPrefixChars?: number;
  profileVersionTag?: string;
};

export function createStabilizerModule(cfg: StabilizerModuleConfig = {}): RuntimeModule {
  const minPrefixChars = cfg.minPrefixChars ?? 500;
  const profileVersionTag = cfg.profileVersionTag ?? "v1";

  function signature(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  function normalizeStableText(text: string): string {
    return text
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<UUID>")
      .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:\.\+\-Z]{6,}\b/g, "<TIMESTAMP>")
      .replace(/\b\d{10,}\b/g, "<LONGNUM>");
  }

  return {
    name: "module-stabilizer",
    async beforeBuild(ctx) {
      const stable = ctx.segments.filter((s) => s.kind === "stable").map((s) => s.text).join("\n");
      const stabilizerEligible = stable.length >= minPrefixChars;
      const stablePrefixSignature = signature(stable);
      const stablePrefixNormalizedSignature = signature(normalizeStableText(stable));
      const nextCtx = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          stabilizer: {
            eligible: stabilizerEligible,
            profileVersionTag,
            prefixChars: stable.length,
            prefixSignature: stablePrefixSignature,
            prefixSignatureNormalized: stablePrefixNormalizedSignature,
          },
        },
      };
      return appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.STABILIZER_BEFORE_BUILD_EVALUATED,
        source: "module-stabilizer",
        at: new Date().toISOString(),
        payload: {
          eligible: stabilizerEligible,
          prefixChars: stable.length,
          prefixSignature: stablePrefixSignature,
          prefixSignatureNormalized: stablePrefixNormalizedSignature,
        },
      });
    },
    async afterCall(ctx, result) {
      const stabilizerMeta = (ctx.metadata?.stabilizer ?? {}) as Record<string, unknown>;
      const eligible = Boolean(stabilizerMeta.eligible);
      if (!eligible) {
        return appendResultEvent(result, {
          type: ECOCLAW_EVENT_TYPES.STABILIZER_AFTER_CALL_SKIPPED,
          source: "module-stabilizer",
          at: new Date().toISOString(),
          payload: { reason: "not-eligible" },
        });
      }
      const readTokens = result.usage?.cacheReadTokens ?? result.usage?.cachedTokens;
      const nextResult = {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          stabilizer: {
            ...(result.metadata?.stabilizer ?? {}),
            observedInputTokens: result.usage?.inputTokens,
            observedOutputTokens: result.usage?.outputTokens,
            observedCacheReadTokens: readTokens,
            observedCacheWriteTokens: result.usage?.cacheWriteTokens,
          },
        },
      };
      return appendResultEvent(nextResult, {
        type: ECOCLAW_EVENT_TYPES.STABILIZER_AFTER_CALL_RECORDED,
        source: "module-stabilizer",
        at: new Date().toISOString(),
        payload: {
          eligible: true,
          prefixSignature: String(stabilizerMeta.prefixSignature ?? ""),
          prefixSignatureNormalized: String(stabilizerMeta.prefixSignatureNormalized ?? ""),
          readTokens: typeof readTokens === "number" ? readTokens : undefined,
        },
      });
    },
  };
}
