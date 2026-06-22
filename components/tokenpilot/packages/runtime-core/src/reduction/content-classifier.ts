export type ToolPayloadContentType =
  | "json_array"
  | "json_object"
  | "search_results"
  | "log_output"
  | "diff_output"
  | "code_like"
  | "blob"
  | "plain_text";

export type ToolPayloadClassification = {
  contentType: ToolPayloadContentType;
  reason: string;
};

export type ToolPayloadHint = {
  toolName?: string;
  fieldName?: string;
  path?: string;
  payloadKind?: "stdout" | "stderr" | "json" | "blob";
  readState?: "fresh" | "superseded" | "stale";
};

const SEARCH_LINE_RE = /^(.+?):(\d+)(?::|-)(.*)$/;
const STACK_TRACE_RE = /^\s*(at\s+\S+\s+\(|Traceback \(most recent call last\):|Caused by:|File ".*", line \d+)/;
const LOG_SIGNAL_RE = /\b(error|warn(?:ing)?|failed|exception|traceback|panic|fatal)\b/i;
const LOG_LINE_RE = /(\b(INFO|DEBUG|TRACE|WARN|WARNING|ERROR|FAIL|FAILED|FATAL|CRITICAL)\b|^\s*\d{4}-\d{2}-\d{2}|^\s*\[\d{2}:\d{2}:\d{2}\]|^\s*PASSED\b|^\s*FAILED\b|^npm ERR!|^yarn error|^cargo error)/i;
const CODE_FENCE_RE = /```[\s\S]*?```/;
const CODE_KEYWORD_RE = /\b(function|class|def|import|from|const|let|var|return|if|else|for|while|async|await|interface|type)\b/;
const DIFF_HEADER_RE = /^(diff --git|diff --combined |diff --cc |--- a\/|\+\+\+ b\/|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|@@@+\s+-\d+(?:,\d+)?\s+(?:-\d+(?:,\d+)?\s+)+\+\d+(?:,\d+)?\s+@@@+)/;
const DIFF_CHANGE_RE = /^[+-][^+-]/;

const CODE_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
]);

function looksLikeCodePath(path: string | undefined): boolean {
  if (!path) return false;
  const normalized = path.trim().toLowerCase();
  if (!normalized) return false;
  for (const ext of CODE_EXTENSIONS) {
    if (normalized.endsWith(ext)) return true;
  }
  return false;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isLikelyBlob(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^data:[^;]+;base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) return true;
  if (/^[A-Za-z0-9+/=\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return true;
  if (/^[A-Fa-f0-9\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return true;
  return false;
}

function countMatchingLines(lines: string[], re: RegExp): number {
  let count = 0;
  for (const line of lines) {
    if (re.test(line)) count += 1;
  }
  return count;
}

function looksLikeSearchResults(lines: string[]): boolean {
  if (lines.length < 3) return false;
  let matched = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!SEARCH_LINE_RE.test(trimmed)) continue;
    if (STACK_TRACE_RE.test(trimmed)) continue;
    if (/^\s*Error:/i.test(trimmed)) continue;
    matched += 1;
  }
  return matched >= Math.min(3, Math.ceil(lines.length * 0.4));
}

function looksLikeLogs(lines: string[]): boolean {
  if (lines.length < 4) return false;
  const signalCount = countMatchingLines(lines, LOG_SIGNAL_RE);
  const stackCount = countMatchingLines(lines, STACK_TRACE_RE);
  const logLineCount = countMatchingLines(lines, LOG_LINE_RE);
  return signalCount >= 2 || stackCount >= 2 || logLineCount >= Math.min(4, Math.ceil(lines.length * 0.4));
}

function looksLikeDiff(lines: string[]): boolean {
  if (lines.length < 3) return false;
  const headerCount = countMatchingLines(lines, DIFF_HEADER_RE);
  const changeCount = countMatchingLines(lines, DIFF_CHANGE_RE);
  return headerCount >= 1 && changeCount >= 2;
}

function looksLikeCode(text: string, lines: string[]): boolean {
  if (CODE_FENCE_RE.test(text)) return true;
  if (CODE_KEYWORD_RE.test(text) && lines.length >= 4) return true;
  const indentedLines = lines.filter((line) => /^\s{2,}\S/.test(line)).length;
  return indentedLines >= Math.min(6, Math.ceil(lines.length * 0.5));
}

export function classifyToolPayloadContent(text: string): ToolPayloadClassification {
  return classifyToolPayloadContentWithHint(text);
}

export function classifyToolPayloadContentWithHint(
  text: string,
  hint?: ToolPayloadHint,
): ToolPayloadClassification {
  const trimmed = text.trim();
  if (!trimmed) {
    return { contentType: "plain_text", reason: "empty" };
  }

  const toolName = hint?.toolName?.trim().toLowerCase();
  const fieldName = hint?.fieldName?.trim().toLowerCase();
  const payloadKind = hint?.payloadKind;

  if (payloadKind === "blob") {
    return { contentType: "blob", reason: "payload_kind_blob" };
  }
  if (payloadKind === "stderr") {
    const lines = trimmed.split("\n").filter((line) => line.length > 0);
    if (looksLikeLogs(lines)) {
      return { contentType: "log_output", reason: "stderr_log_hint" };
    }
  }
  if (toolName === "read" || toolName === "file_read") {
    const lines = trimmed.split("\n").filter((line) => line.length > 0);
    if (looksLikeCodePath(hint?.path)) {
      return { contentType: "code_like", reason: "read_path_code_hint" };
    }
    if (looksLikeCode(trimmed, lines)) {
      return { contentType: "code_like", reason: "read_code_hint" };
    }
  }
  if (toolName === "git_diff" || toolName === "diff") {
    return { contentType: "diff_output", reason: "tool_name_diff_hint" };
  }
  if (toolName === "grep" || toolName === "rg" || toolName === "search") {
    return { contentType: "search_results", reason: "tool_name_search_hint" };
  }
  if (
    toolName === "web_fetch" ||
    toolName === "web_search" ||
    toolName === "tavily_search" ||
    fieldName === "output" ||
    fieldName === "result"
  ) {
    const parsed = tryParseJson(trimmed);
    if (Array.isArray(parsed)) {
      return { contentType: "json_array", reason: "tool_json_hint_array" };
    }
    if (parsed && typeof parsed === "object") {
      return { contentType: "json_object", reason: "tool_json_hint_object" };
    }
  }

  if (isLikelyBlob(trimmed)) {
    return { contentType: "blob", reason: "blob_signature" };
  }

  const parsed = tryParseJson(trimmed);
  if (Array.isArray(parsed)) {
    return { contentType: "json_array", reason: "json_parse_array" };
  }
  if (parsed && typeof parsed === "object") {
    return { contentType: "json_object", reason: "json_parse_object" };
  }

  const lines = trimmed.split("\n").filter((line) => line.length > 0);
  const searchLike = looksLikeSearchResults(lines);
  const logLike = looksLikeLogs(lines);
  const diffLike = looksLikeDiff(lines);

  if (diffLike) {
    return { contentType: "diff_output", reason: "diff_pattern" };
  }
  if (searchLike && !countMatchingLines(lines, STACK_TRACE_RE)) {
    return { contentType: "search_results", reason: "search_line_pattern" };
  }
  if (logLike) {
    return { contentType: "log_output", reason: "log_signal_pattern" };
  }
  if (searchLike) {
    return { contentType: "search_results", reason: "search_line_pattern" };
  }
  if (looksLikeCode(trimmed, lines)) {
    return { contentType: "code_like", reason: "code_structure_pattern" };
  }

  return { contentType: "plain_text", reason: "fallback_plain_text" };
}
