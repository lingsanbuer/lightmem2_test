import type { ContextSegment, RuntimeTurnContext } from "@ecoclaw/kernel";
import type { ReductionPassHandler } from "./types.js";

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_HEAD_LINES = 8;
const DEFAULT_TAIL_LINES = 8;

type PayloadKind = "stdout" | "stderr" | "json" | "blob";

type PayloadBlockConfig = {
  enabled: boolean;
  maxChars: number;
  keepHeadLines: number;
  keepTailLines: number;
  maxPreviewChars: number;
  maxItems: number;
  maxDepth: number;
};

type ToolPayloadTrimConfig = {
  maxChars: number;
  noteLabel: string;
  onlyLikelyToolSegments: boolean;
  requireExplicitSegmentMetadata: boolean;
  stdout: PayloadBlockConfig;
  stderr: PayloadBlockConfig;
  json: PayloadBlockConfig;
  blob: PayloadBlockConfig;
};

type ExplicitPayloadDirective = {
  enabled: boolean;
  kind?: PayloadKind;
};

type ParsedSection = {
  kind: PayloadKind | "other";
  headerLine?: string;
  body: string;
};

const parsePositiveInt = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const parseBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const buildBlockConfig = (
  raw: unknown,
  defaults: Partial<PayloadBlockConfig> & { maxChars: number },
): PayloadBlockConfig => {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: parseBool(obj.enabled, true),
    maxChars: parsePositiveInt(obj.maxChars, defaults.maxChars),
    keepHeadLines: parsePositiveInt(obj.keepHeadLines, defaults.keepHeadLines ?? DEFAULT_HEAD_LINES),
    keepTailLines: parsePositiveInt(obj.keepTailLines, defaults.keepTailLines ?? DEFAULT_TAIL_LINES),
    maxPreviewChars: parsePositiveInt(obj.maxPreviewChars, defaults.maxPreviewChars ?? 160),
    maxItems: parsePositiveInt(obj.maxItems, defaults.maxItems ?? 8),
    maxDepth: parsePositiveInt(obj.maxDepth, defaults.maxDepth ?? 2),
  };
};

const resolveConfig = (options?: Record<string, unknown>): ToolPayloadTrimConfig => {
  const maxChars = parsePositiveInt(options?.maxChars, DEFAULT_MAX_CHARS);
  const noteLabel =
    typeof options?.noteLabel === "string" && options.noteLabel.trim().length > 0
      ? options.noteLabel.trim()
      : "tool_payload_trim";

  return {
    maxChars,
    noteLabel,
    onlyLikelyToolSegments: parseBool(options?.onlyLikelyToolSegments, true),
    requireExplicitSegmentMetadata: parseBool(options?.requireExplicitSegmentMetadata, false),
    stdout: buildBlockConfig(options?.stdout, {
      maxChars,
      keepHeadLines: 10,
      keepTailLines: 10,
      maxPreviewChars: 120,
      maxItems: 8,
      maxDepth: 1,
    }),
    stderr: buildBlockConfig(options?.stderr, {
      maxChars: Math.max(600, Math.floor(maxChars * 0.75)),
      keepHeadLines: 8,
      keepTailLines: 16,
      maxPreviewChars: 160,
      maxItems: 8,
      maxDepth: 1,
    }),
    json: buildBlockConfig(options?.json, {
      maxChars: Math.max(700, Math.floor(maxChars * 0.8)),
      keepHeadLines: 6,
      keepTailLines: 6,
      maxPreviewChars: 220,
      maxItems: 8,
      maxDepth: 2,
    }),
    blob: buildBlockConfig(options?.blob, {
      maxChars: Math.max(256, Math.floor(maxChars * 0.25)),
      keepHeadLines: 1,
      keepTailLines: 1,
      maxPreviewChars: 96,
      maxItems: 4,
      maxDepth: 1,
    }),
  };
};

const normalizePayloadKind = (value: unknown): PayloadKind | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "stdout" ||
    normalized === "stderr" ||
    normalized === "json" ||
    normalized === "blob"
  ) {
    return normalized;
  }
  return undefined;
};

const readExplicitPayloadDirective = (segment: ContextSegment): ExplicitPayloadDirective => {
  const metadata =
    segment.metadata && typeof segment.metadata === "object"
      ? (segment.metadata as Record<string, unknown>)
      : undefined;
  if (!metadata) return { enabled: false };

  const reduction =
    metadata.reduction && typeof metadata.reduction === "object"
      ? (metadata.reduction as Record<string, unknown>)
      : undefined;
  const toolPayload =
    metadata.toolPayload && typeof metadata.toolPayload === "object"
      ? (metadata.toolPayload as Record<string, unknown>)
      : undefined;

  const reductionDirective =
    reduction?.toolPayloadTrim && typeof reduction.toolPayloadTrim === "object"
      ? (reduction.toolPayloadTrim as Record<string, unknown>)
      : undefined;

  const enabled =
    parseBool(reductionDirective?.enabled, false) ||
    parseBool(toolPayload?.enabled, false) ||
    parseBool(metadata.isToolPayload, false) ||
    typeof reduction?.target === "string" && reduction.target === "tool_payload" ||
    typeof metadata.role === "string" && /tool|observation/i.test(metadata.role);

  const kind =
    normalizePayloadKind(reductionDirective?.kind) ??
    normalizePayloadKind(toolPayload?.kind) ??
    normalizePayloadKind(reduction?.payloadKind) ??
    normalizePayloadKind(metadata.payloadKind);

  return {
    enabled,
    kind,
  };
};

const normalizeHeader = (line: string): { kind: PayloadKind; remainder: string } | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/^[#>*\-\s`]+/, "")
    .replace(/[*`]+$/g, "")
    .trim();
  const match = normalized.match(/^(stdout|stderr|json|blob)\s*[:=-]?\s*(.*)$/i);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() as PayloadKind,
    remainder: match[2] ?? "",
  };
};

const splitIntoSections = (text: string): ParsedSection[] => {
  const lines = text.split("\n");
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  const pushCurrent = () => {
    if (!current) return;
    current.body = current.body.replace(/\n+$/, "");
    sections.push(current);
    current = null;
  };

  for (const line of lines) {
    const header = normalizeHeader(line);
    if (header) {
      pushCurrent();
      current = {
        kind: header.kind,
        headerLine: line,
        body: header.remainder ? `${header.remainder}\n` : "",
      };
      continue;
    }

    if (!current) {
      current = { kind: "other", body: `${line}\n` };
      continue;
    }

    current.body += `${line}\n`;
  }
  pushCurrent();
  return sections;
};

const clipText = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;

const summarizeLineBlock = (
  text: string,
  label: PayloadKind,
  cfg: PayloadBlockConfig,
): string => {
  if (text.length <= cfg.maxChars) return text;

  const lines = text.split("\n");
  const head = lines.slice(0, cfg.keepHeadLines);
  const tail = lines.slice(-cfg.keepTailLines);
  const omittedLineCount = Math.max(0, lines.length - head.length - tail.length);
  const summaryLine = `...[${label} reduced lines=${omittedLineCount} chars=${text.length}]`;
  const nextLines = [...head];
  if (omittedLineCount > 0 || text.length > cfg.maxChars) nextLines.push(summaryLine);
  if (tail.length > 0) nextLines.push(...tail);
  return nextLines.join("\n").trim();
};

const summarizeJsonValue = (
  value: unknown,
  depth: number,
  maxDepth: number,
  maxItems: number,
  maxPreviewChars: number,
): unknown => {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clipText(value, maxPreviewChars);
  if (depth >= maxDepth) {
    if (Array.isArray(value)) return `[array:${value.length}]`;
    return "[object]";
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value
        .slice(0, maxItems)
        .map((item) => summarizeJsonValue(item, depth + 1, maxDepth, maxItems, maxPreviewChars)),
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: "object",
      keyCount: entries.length,
      preview: Object.fromEntries(
        entries
          .slice(0, maxItems)
          .map(([key, item]) => [
            key,
            summarizeJsonValue(item, depth + 1, maxDepth, maxItems, maxPreviewChars),
          ]),
      ),
    };
  }
  return String(value);
};

const summarizeJsonText = (text: string, cfg: PayloadBlockConfig): string => {
  try {
    const parsed = JSON.parse(text);
    const minified = JSON.stringify(parsed);
    if (minified.length <= cfg.maxChars) {
      return minified;
    }
    const summary = {
      reduced: "json",
      originalChars: text.length,
      summary: summarizeJsonValue(parsed, 0, cfg.maxDepth, cfg.maxItems, cfg.maxPreviewChars),
    };
    return JSON.stringify(summary, null, 2);
  } catch {
    return summarizeLineBlock(text, "json", cfg);
  }
};

const isLikelyBlob = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^data:[^;]+;base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) return true;
  if (/^[A-Za-z0-9+/=\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return true;
  if (/^[A-Fa-f0-9\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return true;
  return false;
};

const summarizeBlobText = (text: string, cfg: PayloadBlockConfig): string => {
  const trimmed = text.trim();
  const preview = clipText(trimmed.replace(/\s+/g, ""), cfg.maxPreviewChars);
  let blobKind = "blob";
  if (trimmed.startsWith("data:")) blobKind = "data_url";
  else if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) blobKind = "base64";
  else if (/^[A-Fa-f0-9\s]+$/.test(trimmed)) blobKind = "hex";

  return `[${blobKind} reduced chars=${trimmed.length} preview=${preview}]`;
};

const getBlockConfig = (cfg: ToolPayloadTrimConfig, kind: PayloadKind): PayloadBlockConfig => {
  if (kind === "stdout") return cfg.stdout;
  if (kind === "stderr") return cfg.stderr;
  if (kind === "json") return cfg.json;
  return cfg.blob;
};

const reduceStandalonePayload = (
  text: string,
  cfg: ToolPayloadTrimConfig,
): { text: string; changed: boolean; kind?: PayloadKind } => {
  const trimmed = text.trim();
  if (!trimmed) return { text, changed: false };

  try {
    JSON.parse(trimmed);
    const next = cfg.json.enabled ? summarizeJsonText(trimmed, cfg.json) : text;
    return { text: next, changed: next !== text, kind: next !== text ? "json" : undefined };
  } catch {
    // ignore
  }

  if (isLikelyBlob(trimmed) && cfg.blob.enabled) {
    const next = summarizeBlobText(trimmed, cfg.blob);
    return { text: next, changed: next !== text, kind: next !== text ? "blob" : undefined };
  }

  return { text, changed: false };
};

const reduceSection = (
  section: ParsedSection,
  cfg: ToolPayloadTrimConfig,
): { text: string; changed: boolean } => {
  const body = section.body.trim();
  if (!body) {
    return {
      text: section.headerLine ?? "",
      changed: false,
    };
  }

  let nextBody = body;
  if (section.kind === "stdout" && cfg.stdout.enabled) {
    nextBody = summarizeLineBlock(body, "stdout", cfg.stdout);
  } else if (section.kind === "stderr" && cfg.stderr.enabled) {
    nextBody = summarizeLineBlock(body, "stderr", cfg.stderr);
  } else if (section.kind === "json" && cfg.json.enabled) {
    nextBody = summarizeJsonText(body, cfg.json);
  } else if (section.kind === "blob" && cfg.blob.enabled) {
    nextBody = summarizeBlobText(body, cfg.blob);
  }

  const header = section.headerLine ? `${section.headerLine.trim()}\n` : "";
  return {
    text: `${header}${nextBody}`.trim(),
    changed: nextBody !== body,
  };
};

const reduceTextByExplicitKind = (
  text: string,
  kind: PayloadKind,
  cfg: ToolPayloadTrimConfig,
): { text: string; changed: boolean; reducedKinds: PayloadKind[] } => {
  const blockCfg = getBlockConfig(cfg, kind);
  if (!blockCfg.enabled) return { text, changed: false, reducedKinds: [] };

  const nextText =
    kind === "json"
      ? summarizeJsonText(text, blockCfg)
      : kind === "blob"
        ? summarizeBlobText(text, blockCfg)
        : summarizeLineBlock(text, kind, blockCfg);

  return {
    text: nextText,
    changed: nextText !== text,
    reducedKinds: nextText !== text ? [kind] : [],
  };
};

const isLikelyToolPayloadSegment = (segment: ContextSegment): boolean => {
  const explicit = readExplicitPayloadDirective(segment);
  if (explicit.enabled) return true;
  const haystack = [segment.id, segment.source, segment.text.slice(0, 600)]
    .filter(Boolean)
    .join("\n");
  if (/(tool|observation|artifact|payload|stdout|stderr|blob)/i.test(haystack)) return true;
  const sections = splitIntoSections(segment.text);
  if (sections.some((section) => section.kind !== "other")) return true;
  const standalone = reduceStandalonePayload(segment.text, resolveConfig({}));
  return standalone.changed;
};

const reduceSegmentText = (
  segment: ContextSegment,
  cfg: ToolPayloadTrimConfig,
): { text: string; changed: boolean; reducedKinds: PayloadKind[] } => {
  const explicit = readExplicitPayloadDirective(segment);
  if (explicit.kind) {
    return reduceTextByExplicitKind(segment.text, explicit.kind, cfg);
  }

  const text = segment.text;
  const sections = splitIntoSections(text);
  const reducedKinds = new Set<PayloadKind>();

  if (sections.some((section) => section.kind !== "other")) {
    const nextSections = sections.map((section) => {
      if (section.kind === "other") return section.body.trim();
      const reduced = reduceSection(section, cfg);
      if (reduced.changed) reducedKinds.add(section.kind);
      return reduced.text;
    });
    const nextText = nextSections.filter(Boolean).join("\n\n").trim();
    return {
      text: nextText || text,
      changed: nextText !== text,
      reducedKinds: [...reducedKinds],
    };
  }

  const standalone = reduceStandalonePayload(text, cfg);
  if (standalone.changed && standalone.kind) reducedKinds.add(standalone.kind);
  return {
    text: standalone.text,
    changed: standalone.changed,
    reducedKinds: [...reducedKinds],
  };
};

const updateSegments = (
  turnCtx: RuntimeTurnContext,
  cfg: ToolPayloadTrimConfig,
): { turnCtx: RuntimeTurnContext; touchedSegmentIds: string[]; reducedKinds: PayloadKind[] } => {
  const touchedSegmentIds: string[] = [];
  const reducedKinds = new Set<PayloadKind>();
  const nextSegments = turnCtx.segments.map((segment) => {
    const explicit = readExplicitPayloadDirective(segment);
    if (cfg.requireExplicitSegmentMetadata && !explicit.enabled && !explicit.kind) {
      return segment;
    }

    if (!explicit.enabled && !explicit.kind && cfg.onlyLikelyToolSegments && !isLikelyToolPayloadSegment(segment)) {
      return segment;
    }

    const reduced = reduceSegmentText(segment, cfg);
    if (!reduced.changed) return segment;
    touchedSegmentIds.push(segment.id);
    for (const kind of reduced.reducedKinds) reducedKinds.add(kind);
    return {
      ...segment,
      text: reduced.text,
    };
  });

  return {
    turnCtx:
      touchedSegmentIds.length === 0
        ? turnCtx
        : {
            ...turnCtx,
            segments: nextSegments,
          },
    touchedSegmentIds,
    reducedKinds: [...reducedKinds],
  };
};

export const toolPayloadTrimPass: ReductionPassHandler = {
  beforeCall({ turnCtx, spec }) {
    const cfg = resolveConfig(spec.options);
    const { turnCtx: nextCtx, touchedSegmentIds, reducedKinds } = updateSegments(turnCtx, cfg);
    if (touchedSegmentIds.length === 0) {
      return {
        changed: false,
        skippedReason: "no_tool_payload_segments_matched",
      };
    }

    return {
      changed: true,
      turnCtx: nextCtx,
      note: `${cfg.noteLabel}:${reducedKinds.join(",") || "mixed"}`,
      touchedSegmentIds,
    };
  },
};
