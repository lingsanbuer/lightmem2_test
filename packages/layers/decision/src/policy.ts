import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  resolveApiFamily,
  type RuntimeTurnContext,
  type RuntimeModule,
} from "@ecoclaw/kernel";

export type PolicyModuleConfig = {
  summaryTriggerInputTokens?: number;
  summaryTriggerStableChars?: number;
  compactionEnabled?: boolean;
  compactionTriggerInputTokens?: number;
  compactionTriggerTurnCount?: number;
  compactionMissRateThreshold?: number;
  compactionMissRateWindowTurns?: number;
  compactionMinTurnsForMissRate?: number;
  compactionCooldownTurns?: number;
  cacheJitterWindowTurns?: number;
  cacheMissRateThreshold?: number;
  minTurnsBeforeJitter?: number;
  requestCooldownTurns?: number;
  cacheProbeEnabled?: boolean;
  cacheProbeIntervalSeconds?: number;
  cacheProbeMaxPromptChars?: number;
  cacheProbeHitMinTokens?: number;
  cacheProbeMissesToCold?: number;
  cacheProbeWarmSeconds?: number;
};

export function createPolicyModule(cfg: PolicyModuleConfig = {}): RuntimeModule {
  const summaryTriggerInputTokens = Math.max(0, cfg.summaryTriggerInputTokens ?? 20000);
  const summaryTriggerStableChars = Math.max(0, cfg.summaryTriggerStableChars ?? 0);
  const compactionEnabled = cfg.compactionEnabled ?? true;
  const compactionTriggerInputTokens = Math.max(0, cfg.compactionTriggerInputTokens ?? 120000);
  const compactionTriggerTurnCount = Math.max(1, cfg.compactionTriggerTurnCount ?? 18);
  const compactionMissRateThreshold = Math.min(1, Math.max(0, cfg.compactionMissRateThreshold ?? 0.7));
  const compactionMissRateWindowTurns = Math.max(3, cfg.compactionMissRateWindowTurns ?? 8);
  const compactionMinTurnsForMissRate = Math.max(1, cfg.compactionMinTurnsForMissRate ?? 6);
  const compactionCooldownTurns = Math.max(0, cfg.compactionCooldownTurns ?? 6);
  const cacheJitterWindowTurns = Math.max(3, cfg.cacheJitterWindowTurns ?? 6);
  const cacheMissRateThreshold = Math.min(1, Math.max(0, cfg.cacheMissRateThreshold ?? 0.5));
  const minTurnsBeforeJitter = Math.max(1, cfg.minTurnsBeforeJitter ?? 4);
  const requestCooldownTurns = Math.max(0, cfg.requestCooldownTurns ?? 2);
  const cacheProbeEnabled = cfg.cacheProbeEnabled ?? true;
  const cacheProbeIntervalSeconds = Math.max(30, cfg.cacheProbeIntervalSeconds ?? 1800);
  const cacheProbeMaxPromptChars = Math.max(1, cfg.cacheProbeMaxPromptChars ?? 120);
  const cacheProbeHitMinTokens = Math.max(0, cfg.cacheProbeHitMinTokens ?? 64);
  const cacheProbeMissesToCold = Math.max(1, cfg.cacheProbeMissesToCold ?? 2);
  const cacheProbeWarmSeconds = Math.max(30, cfg.cacheProbeWarmSeconds ?? 7200);
  type ProbeMode = "warm" | "uncertain" | "cold";
  const stateBySession = new Map<
    string,
    {
      turn: number;
      lastSummaryRequestTurn?: number;
      lastCompactionRequestTurn?: number;
      recentCacheReadHit: number[];
      cumulativeInputTokens: number;
      probe: {
        mode: ProbeMode;
        lastProbeAtMs?: number;
        lastProbeHitAtMs?: number;
        lastProbeReadTokens?: number;
        consecutiveProbeMisses: number;
      };
    }
  >();

  const readInputTokens = (usage: any): number => {
    const toNum = (value: unknown): number | undefined => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
      return undefined;
    };
    const direct = toNum(usage?.inputTokens);
    if (direct !== undefined) return direct;
    const raw = usage?.providerRaw as Record<string, unknown> | undefined;
    const rawInput = toNum(raw?.input_tokens ?? raw?.prompt_tokens ?? raw?.inputTokens ?? raw?.promptTokens);
    return rawInput ?? 0;
  };

  return {
    name: "module-policy",
    async beforeBuild(ctx) {
      const apiFamily = resolveApiFamily(ctx);
      const state = stateBySession.get(ctx.sessionId) ?? {
        turn: 0,
        recentCacheReadHit: [],
        cumulativeInputTokens: 0,
        probe: {
          mode: "uncertain" as ProbeMode,
          consecutiveProbeMisses: 0,
        },
      };
      const nowMs = Date.now();
      const stableChars = ctx.segments
        .filter((s) => s.kind === "stable")
        .map((s) => s.text)
        .join("\n").length;
      const stabilizerMeta = (ctx.metadata?.stabilizer as Record<string, unknown> | undefined) ?? {};
      const stabilizerEligible = Boolean(stabilizerMeta.eligible);

      const recent = state.recentCacheReadHit.slice(-Math.max(cacheJitterWindowTurns, compactionMissRateWindowTurns));
      const jitterRecent = recent.slice(-cacheJitterWindowTurns);
      const missCount = recent.filter((v) => v === 0).length;
      const missRate = jitterRecent.length > 0 ? jitterRecent.filter((v) => v === 0).length / jitterRecent.length : 0;
      const jitterTriggered =
        state.turn >= minTurnsBeforeJitter &&
        jitterRecent.length >= Math.min(cacheJitterWindowTurns, minTurnsBeforeJitter) &&
        missRate >= cacheMissRateThreshold;
      const compactionRecent = recent.slice(-compactionMissRateWindowTurns);
      const compactionMissRate =
        compactionRecent.length > 0
          ? compactionRecent.filter((v) => v === 0).length / compactionRecent.length
          : 0;

      const lastProbeAtMs = state.probe.lastProbeAtMs;
      const probeSupported = apiFamily !== "openai-completions";
      const probeDue =
        cacheProbeEnabled &&
        probeSupported &&
        stabilizerEligible &&
        (lastProbeAtMs == null || nowMs - lastProbeAtMs >= cacheProbeIntervalSeconds * 1000);
      const promptChars = String(ctx.prompt ?? "").length;
      const probePlanned = probeDue && promptChars <= cacheProbeMaxPromptChars;
      const hitFresh =
        typeof state.probe.lastProbeHitAtMs === "number" &&
        nowMs - state.probe.lastProbeHitAtMs <= cacheProbeWarmSeconds * 1000;
      let probeMode: ProbeMode = state.probe.mode;
      if (hitFresh) {
        probeMode = "warm";
      } else if (state.probe.consecutiveProbeMisses >= cacheProbeMissesToCold) {
        probeMode = "cold";
      } else {
        probeMode = "uncertain";
      }
      state.probe.mode = probeMode;

      const summaryReasons: string[] = [];
      if (stabilizerEligible && summaryTriggerInputTokens > 0 && state.cumulativeInputTokens >= summaryTriggerInputTokens) {
        summaryReasons.push("input_tokens_threshold");
      }
      if (stabilizerEligible && summaryTriggerStableChars > 0 && stableChars >= summaryTriggerStableChars) {
        summaryReasons.push("stable_chars_threshold");
      }
      if (stabilizerEligible && jitterTriggered) {
        summaryReasons.push("cache_jitter");
      }
      if (stabilizerEligible && probeSupported && probeMode === "cold" && !probePlanned) {
        summaryReasons.push("cache_probe_cold");
      }
      const summaryCooldownActive =
        typeof state.lastSummaryRequestTurn === "number" &&
        state.turn - state.lastSummaryRequestTurn <= requestCooldownTurns;
      const compactionSupported = apiFamily === "openai-responses";
      const compactionReasons: string[] = [];
      if (
        compactionSupported &&
        compactionEnabled &&
        compactionTriggerInputTokens > 0 &&
        state.cumulativeInputTokens >= compactionTriggerInputTokens
      ) {
        compactionReasons.push("input_tokens_threshold");
      }
      if (compactionSupported && compactionEnabled && state.turn >= compactionTriggerTurnCount) {
        compactionReasons.push("turn_count_threshold");
      }
      if (
        compactionSupported &&
        compactionEnabled &&
        state.turn >= compactionMinTurnsForMissRate &&
        compactionRecent.length >= Math.min(compactionMinTurnsForMissRate, compactionMissRateWindowTurns) &&
        compactionMissRate >= compactionMissRateThreshold
      ) {
        compactionReasons.push("cache_miss_rate_threshold");
      }
      const compactionCooldownActive =
        typeof state.lastCompactionRequestTurn === "number" &&
        state.turn - state.lastCompactionRequestTurn <= compactionCooldownTurns;
      const shouldRequestCompaction =
        compactionSupported &&
        compactionEnabled &&
        compactionReasons.length > 0 &&
        !compactionCooldownActive;
      const shouldRequestSummary =
        shouldRequestCompaction || (summaryReasons.length > 0 && !summaryCooldownActive);

      const withMeta = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          policy: {
            apiFamily,
            summaryTriggerInputTokens,
            summaryTriggerStableChars,
            compactionEnabled,
            compactionTriggerInputTokens,
            compactionTriggerTurnCount,
            compactionMissRateThreshold,
            compactionMissRateWindowTurns,
            compactionMinTurnsForMissRate,
            compactionCooldownTurns,
            cacheJitterWindowTurns,
            cacheMissRateThreshold,
            stableChars,
            cumulativeInputTokens: state.cumulativeInputTokens,
            shouldRequestSummary,
            summaryReasons,
            recentCacheMissRate: missRate,
            summaryCooldownActive,
            compaction: {
              supported: compactionSupported,
              enabled: compactionEnabled,
              shouldRequest: shouldRequestCompaction,
              reasons: compactionReasons,
              cooldownActive: compactionCooldownActive,
              missRate: compactionMissRate,
            },
            cacheProbe: {
              enabled: cacheProbeEnabled,
              supported: probeSupported,
              mode: probeMode,
              probeDue,
              probePlanned,
              probeIntervalSeconds: cacheProbeIntervalSeconds,
              probeMaxPromptChars: cacheProbeMaxPromptChars,
              probeHitMinTokens: cacheProbeHitMinTokens,
              probeMissesToCold: cacheProbeMissesToCold,
              probeWarmSeconds: cacheProbeWarmSeconds,
              promptChars,
              lastProbeAtMs: state.probe.lastProbeAtMs,
              lastProbeReadTokens: state.probe.lastProbeReadTokens,
              consecutiveProbeMisses: state.probe.consecutiveProbeMisses,
              hitFresh,
            },
          },
        },
      };
      let nextCtx: RuntimeTurnContext = withMeta;
      if (stabilizerEligible && cacheProbeEnabled && probeSupported) {
        nextCtx = appendContextEvent(nextCtx, {
          type: ECOCLAW_EVENT_TYPES.POLICY_CACHE_PROBE_DECIDED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            mode: probeMode,
            probeDue,
            probePlanned,
            promptChars,
            maxPromptChars: cacheProbeMaxPromptChars,
            intervalSeconds: cacheProbeIntervalSeconds,
            consecutiveProbeMisses: state.probe.consecutiveProbeMisses,
            hitFresh,
            apiFamily,
          },
        });
      }
      if (jitterTriggered) {
        nextCtx = appendContextEvent(nextCtx, {
          type: ECOCLAW_EVENT_TYPES.POLICY_CACHE_JITTER_DETECTED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            missRate,
            missCount,
            recentWindowSize: jitterRecent.length,
            threshold: cacheMissRateThreshold,
            apiFamily,
          },
        });
      }
      if (shouldRequestCompaction) {
        state.lastCompactionRequestTurn = state.turn;
        nextCtx = appendContextEvent(nextCtx, {
          type: ECOCLAW_EVENT_TYPES.POLICY_COMPACTION_REQUESTED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            reasons: compactionReasons,
            cumulativeInputTokens: state.cumulativeInputTokens,
            turn: state.turn,
            missRate: compactionMissRate,
            inputTokensThreshold: compactionTriggerInputTokens,
            turnCountThreshold: compactionTriggerTurnCount,
            missRateThreshold: compactionMissRateThreshold,
            missRateWindowTurns: compactionMissRateWindowTurns,
            apiFamily,
          },
        });
      }
      if (!shouldRequestSummary) {
        stateBySession.set(ctx.sessionId, state);
        return nextCtx;
      }
      state.lastSummaryRequestTurn = state.turn;
      stateBySession.set(ctx.sessionId, state);
      return appendContextEvent(nextCtx, {
        type: ECOCLAW_EVENT_TYPES.POLICY_SUMMARY_REQUESTED,
        source: "module-policy",
        at: new Date().toISOString(),
        payload: {
          cumulativeInputTokens: state.cumulativeInputTokens,
          stableChars,
          reasons: shouldRequestCompaction
            ? [...compactionReasons.map((reason) => `compaction_${reason}`), ...summaryReasons]
            : summaryReasons,
          inputTokensThreshold: summaryTriggerInputTokens,
          threshold: summaryTriggerStableChars,
          missRate,
          apiFamily,
        },
      });
    },
    async afterCall(ctx, result) {
      const apiFamily = resolveApiFamily(ctx);
      const state = stateBySession.get(ctx.sessionId) ?? {
        turn: 0,
        recentCacheReadHit: [],
        cumulativeInputTokens: 0,
        probe: {
          mode: "uncertain" as ProbeMode,
          consecutiveProbeMisses: 0,
        },
      };
      state.turn += 1;
      const rawReadTokens = result.usage?.cacheReadTokens ?? result.usage?.cachedTokens;
      const hasReadSignal = typeof rawReadTokens === "number" && Number.isFinite(rawReadTokens);
      const readTokens = hasReadSignal ? Number(rawReadTokens) : 0;
      state.cumulativeInputTokens += readInputTokens(result.usage);
      if (hasReadSignal) {
        state.recentCacheReadHit.push(readTokens > 0 ? 1 : 0);
        if (state.recentCacheReadHit.length > cacheJitterWindowTurns * 3) {
          state.recentCacheReadHit = state.recentCacheReadHit.slice(-cacheJitterWindowTurns * 3);
        }
      }
      stateBySession.set(ctx.sessionId, state);

      const policyMeta = (ctx.metadata?.policy as Record<string, unknown> | undefined) ?? {};
      const probeMeta = (policyMeta.cacheProbe as Record<string, unknown> | undefined) ?? {};
      const probePlanned = Boolean(probeMeta.probePlanned);
      const probeSupported = Boolean(probeMeta.supported ?? true);
      if (cacheProbeEnabled && probeSupported && probePlanned && hasReadSignal) {
        const nowMs = Date.now();
        const hit = readTokens >= cacheProbeHitMinTokens;
        state.probe.lastProbeAtMs = nowMs;
        state.probe.lastProbeReadTokens = readTokens;
        if (hit) {
          state.probe.lastProbeHitAtMs = nowMs;
          state.probe.consecutiveProbeMisses = 0;
          state.probe.mode = "warm";
        } else {
          state.probe.consecutiveProbeMisses += 1;
          state.probe.mode =
            state.probe.consecutiveProbeMisses >= cacheProbeMissesToCold ? "cold" : "uncertain";
        }
        stateBySession.set(ctx.sessionId, state);
        result = appendResultEvent(result, {
          type: ECOCLAW_EVENT_TYPES.POLICY_CACHE_PROBE_RESULT,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            planned: true,
            hit,
            readTokens,
            hasReadSignal,
            hitMinTokens: cacheProbeHitMinTokens,
            mode: state.probe.mode,
            consecutiveProbeMisses: state.probe.consecutiveProbeMisses,
            apiFamily,
          },
        });
      }

      return result;
    },
  };
}
