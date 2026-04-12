import type { TurnLocalCandidate } from "./types.js";

function clipText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 3) + "...";
}

export function buildCompactedStub(candidate: TurnLocalCandidate, archivePath: string): string {
  const writePreview = clipText(candidate.writeText, 220);
  return (
    `[Archived ${candidate.sourceToolName} result for \`${candidate.sourceDataKey}\`] ` +
    `This content was consumed by a subsequent ${candidate.writeToolName} operation. ` +
    `The ${candidate.writeToolName} produced: "${writePreview}". ` +
    `Full archive: ${archivePath}`
  );
}
