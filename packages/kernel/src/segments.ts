import type { ContextSegment } from "./types.js";

export type ObservationPayloadKind = "stdout" | "stderr" | "json" | "blob";
export type ObservationRole = "tool" | "observation";

export type ObservationSegmentInput = {
  id: string;
  text: string;
  priority?: number;
  stability?: ContextSegment["kind"];
  source?: string;
  role?: ObservationRole;
  payloadKind?: ObservationPayloadKind;
  toolName?: string;
  origin?: string;
  mimeType?: string;
  truncated?: boolean;
  metadata?: Record<string, unknown>;
};

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};

export function attachObservationMetadata(
  segment: ContextSegment,
  input: Omit<ObservationSegmentInput, "id" | "text" | "priority" | "stability" | "source">,
): ContextSegment {
  const role = input.role ?? "observation";
  const existingMetadata = asObject(segment.metadata);
  const existingReduction = asObject(existingMetadata.reduction);
  const existingTrim = asObject(existingReduction.toolPayloadTrim);
  const existingToolPayload = asObject(existingMetadata.toolPayload);

  const nextMetadata: Record<string, unknown> = {
    ...existingMetadata,
    ...(input.metadata ?? {}),
    role,
    isToolPayload: true,
    ...(input.payloadKind ? { payloadKind: input.payloadKind } : {}),
    toolPayload: {
      ...existingToolPayload,
      enabled: true,
      ...(input.payloadKind ? { kind: input.payloadKind } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(typeof input.truncated === "boolean" ? { truncated: input.truncated } : {}),
    },
    reduction: {
      ...existingReduction,
      target: "tool_payload",
      ...(input.payloadKind ? { payloadKind: input.payloadKind } : {}),
      toolPayloadTrim: {
        ...existingTrim,
        enabled: true,
        ...(input.payloadKind ? { kind: input.payloadKind } : {}),
      },
    },
  };

  return {
    ...segment,
    metadata: nextMetadata,
  };
}

export function createObservationSegment(input: ObservationSegmentInput): ContextSegment {
  const base: ContextSegment = {
    id: input.id,
    kind: input.stability ?? "semi_stable",
    text: input.text,
    priority: input.priority ?? 6,
    ...(input.source ? { source: input.source } : {}),
  };

  return attachObservationMetadata(base, {
    role: input.role,
    payloadKind: input.payloadKind,
    toolName: input.toolName,
    origin: input.origin,
    mimeType: input.mimeType,
    truncated: input.truncated,
    metadata: input.metadata,
  });
}
