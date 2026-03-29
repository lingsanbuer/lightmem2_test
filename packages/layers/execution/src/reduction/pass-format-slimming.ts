import type { ReductionPassHandler } from "./types.js";

export const formatSlimmingPass: ReductionPassHandler = {
  afterCall({ currentResult, spec }) {
    const removeCodeFences = spec.options?.removeCodeFences !== false;
    const collapseBlankLines = spec.options?.collapseBlankLines !== false;
    const trimTrailingSpaces = spec.options?.trimTrailingSpaces !== false;

    let content = currentResult.content;

    if (removeCodeFences) {
      content = content.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/\n```/g, "");
    }
    if (collapseBlankLines) {
      content = content.replace(/\n{3,}/g, "\n\n");
    }
    if (trimTrailingSpaces) {
      content = content.replace(/[ \t]+\n/g, "\n");
    }

    if (content === currentResult.content) {
      return {
        changed: false,
        skippedReason: "no_format_savings",
      };
    }

    return {
      changed: true,
      note: "remove_formatting_overhead",
      result: {
        ...currentResult,
        content,
      },
    };
  },
};
