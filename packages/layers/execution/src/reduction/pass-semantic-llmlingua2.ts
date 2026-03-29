import type { ReductionPassHandler } from "./types.js";

export const semanticLlmlingua2Pass: ReductionPassHandler = {
  afterCall({ currentResult }) {
    return {
      changed: false,
      skippedReason:
        currentResult.content.trim().length === 0
          ? "empty_content"
          : "llmlingua2_not_implemented",
    };
  },
};
