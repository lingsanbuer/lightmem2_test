import type { ContextSegment } from "@ecoclaw/kernel";
import type { EvictionBlock, EvictionDecision, EvictionPolicy } from "../types.js";

export type EvictionAnalyzerConfig = {
  enabled?: boolean;
  policy?: EvictionPolicy;
  minBlockChars?: number;
};

const DEFAULT_EVICTION_CONFIG: Required<EvictionAnalyzerConfig> = {
  enabled: false,
  policy: "noop",
  minBlockChars: 256,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function buildBlocksFromSegments(
  segments: ContextSegment[],
  minBlockChars: number,
): EvictionBlock[] {
  const blocks: EvictionBlock[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const chars = segment.text.length;
    if (chars < minBlockChars) continue;
    const metadata = asRecord(segment.metadata);
    const blockType = typeof metadata?.origin === "string" ? metadata.origin : "segment";
    blocks.push({
      id: `segment-block:${segment.id}`,
      messageIds: [segment.id],
      blockType,
      chars,
      approxTokens: Math.max(0, Math.round(chars / 4)),
      recencyRank: Math.max(0, segments.length - i),
      frequency: 1,
      metadata,
    });
  }
  return blocks;
}

export function analyzeEviction(
  segments: ContextSegment[],
  config: EvictionAnalyzerConfig = DEFAULT_EVICTION_CONFIG,
): EvictionDecision {
  const cfg = { ...DEFAULT_EVICTION_CONFIG, ...config };
  if (!cfg.enabled) {
    return {
      enabled: false,
      policy: cfg.policy,
      blocks: [],
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["eviction_disabled"],
    };
  }

  const blocks = buildBlocksFromSegments(segments, cfg.minBlockChars);
  return {
    enabled: true,
    policy: cfg.policy,
    blocks,
    instructions: [],
    estimatedSavedChars: 0,
    notes: [
      "eviction_interface_placeholder",
      `policy=${cfg.policy}`,
      `blocks=${blocks.length}`,
      "instructions=0",
    ],
  };
}
