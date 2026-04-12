import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Archive directory for persisted tool results.
 *
 * Strategy:
 * - Prefer workspaceDir from context metadata if available (passed from openclaw plugin)
 * - For session IDs like "bench-...-0169-j0021", extract runId and jobId
 * - Store archives in /tmp/{runId}/agent_workspace_{jobId}/.ecoclaw-archives/
 * - This allows the model to read back archived content using the read tool
 */
export function defaultArchiveDir(sessionId: string, workspaceDir?: string): string {
  // Use workspaceDir from metadata if provided (preferred approach)
  if (workspaceDir) {
    return join(workspaceDir, ".ecoclaw-archives");
  }

  // Try to extract runId and jobId from sessionId
  // Format: "bench-xxx-{runId}-j{jobId}" or similar patterns
  const match = sessionId.match(/-(\d+)-j(\d+)$/);

  if (match) {
    const runId = match[1];
    const jobId = match[2];
    // Store in the agent workspace so the model can read it back
    return `/tmp/pinchbench/${runId}/agent_workspace_j${jobId}/.ecoclaw-archives`;
  }

  // Fallback: use home directory with sessionId
  const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
  return join(homeDir, ".openclaw", "ecoclaw-plugin-state", "ecoclaw", "tool-result-archives", sanitizePathPart(sessionId));
}

export function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
