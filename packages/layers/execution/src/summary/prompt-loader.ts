import { readFile } from "node:fs/promises";

export type PromptSource = "default" | "inline" | "file";

export type ResolvedPrompt = {
  text: string;
  source: PromptSource;
  path?: string;
  error?: string;
};

export const DEFAULT_SUMMARY_PROMPT_FALLBACK = `You are performing a CONTEXT CHECKPOINT COMPACTION.
Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM
seamlessly continue the work.`;

export const DEFAULT_RESUME_PREFIX_PROMPT_FALLBACK = `Another language model started to solve this problem and produced
a summary of its thinking process. You also have access to the
state of the tools that were used by that language model. Use this
to build on the work that has already been done and avoid
duplicating work. Here is the summary produced by the other
language model, use the information in this summary to assist
with your own analysis:`;

const trimPrompt = (value?: string): string => {
  const text = typeof value === "string" ? value.trim() : "";
  return text;
};

async function loadPromptFile(path: string): Promise<ResolvedPrompt> {
  const raw = await readFile(path, "utf8");
  const text = raw.trim();
  if (!text) {
    throw new Error(`prompt file is empty: ${path}`);
  }
  return { text, source: "file", path };
}

const defaultPromptCache = new Map<string, Promise<ResolvedPrompt>>();

async function loadDefaultPrompt(
  fallback: string,
  preferredError?: string,
): Promise<ResolvedPrompt> {
  const cacheKey = `default::${fallback}::${preferredError ?? ""}`;
  const cached = defaultPromptCache.get(cacheKey);
  if (cached) return cached;

  const pending = Promise.resolve({
    text: fallback,
    source: "default" as const,
    error: preferredError,
  });

  defaultPromptCache.set(cacheKey, pending);
  return pending;
}

async function resolvePromptText(params: {
  inline?: string;
  path?: string;
  defaultFileName: string;
  fallback: string;
}): Promise<ResolvedPrompt> {
  const inline = trimPrompt(params.inline);
  if (inline) {
    return { text: inline, source: "inline" };
  }

  const path = trimPrompt(params.path);
  if (path) {
    try {
      return await loadPromptFile(path);
    } catch (err) {
      return loadDefaultPrompt(
        params.fallback,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return loadDefaultPrompt(params.fallback);
}

export async function resolveSummaryPrompt(params: {
  inline?: string;
  path?: string;
}): Promise<ResolvedPrompt> {
  return resolvePromptText({
    inline: params.inline,
    path: params.path,
    defaultFileName: "default-summary.md",
    fallback: DEFAULT_SUMMARY_PROMPT_FALLBACK,
  });
}

export async function resolveResumePrefixPrompt(params: {
  inline?: string;
  path?: string;
}): Promise<ResolvedPrompt> {
  return resolvePromptText({
    inline: params.inline,
    path: params.path,
    defaultFileName: "default-resume-prefix.md",
    fallback: DEFAULT_RESUME_PREFIX_PROMPT_FALLBACK,
  });
}
