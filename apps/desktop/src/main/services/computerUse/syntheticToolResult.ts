/**
 * Synthetic tool_result generation for the Claude V2 SDK streaming path.
 *
 * The Claude V2 SDK executes tools internally and only surfaces `assistant`
 * messages in the stream — tool results are opaque. The proof observer relies
 * on `tool_result` events to auto-ingest screenshots and other artifacts into
 * the proof drawer.
 *
 * This module scans tool call *args* for artifact-indicating file paths and
 * builds a synthetic `tool_result` event that the proof observer can process.
 */

import type { AgentChatEvent } from "../../../shared/types/chat";

// Matches absolute file paths ending with known artifact extensions.
// The leading group catches a boundary char (or start) before the path.
const ARTIFACT_PATH_RE =
  /(?:^|[\s"'=:,])(\/?(?:[\w.~-]+\/)*[\w.~-]+\.(?:png|jpe?g|webp|gif|bmp|tiff|svg|mp4|webm|mov|avi|mkv|zip|trace|log|txt|ndjson|jsonl))\b/gi;

/**
 * Extract file paths that look like artifacts from an arbitrary args value.
 * Returns an array of unique absolute paths found.
 */
export function extractArtifactPathsFromArgs(args: unknown): string[] {
  const paths = new Set<string>();

  function scan(value: unknown, depth: number): void {
    if (depth > 8) return;
    if (typeof value === "string") {
      ARTIFACT_PATH_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ARTIFACT_PATH_RE.exec(value)) !== null) {
        const p = match[1].trim();
        if (p.startsWith("/")) paths.add(p);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item, depth + 1);
      return;
    }
    if (value != null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) {
        scan(v, depth + 1);
      }
    }
  }

  scan(args, 0);
  return Array.from(paths);
}

/**
 * Build a synthetic `tool_result` AgentChatEvent from tool call args.
 * Returns null if no artifact paths are found in the args.
 */
export function maybeSyntheticToolResult(
  toolName: string,
  args: unknown,
  itemId: string,
  turnId: string | undefined,
): AgentChatEvent | null {
  const artifactPaths = extractArtifactPathsFromArgs(args);
  if (artifactPaths.length === 0) return null;

  // Build a result object that the proof observer's scanners will pick up.
  // Use a structure with named fields so the observer can infer kind from
  // both the field name and the file extension.
  const result: Record<string, string> = {};
  for (let i = 0; i < artifactPaths.length; i++) {
    result[`artifactPath${i}`] = artifactPaths[i];
  }

  return {
    type: "tool_result",
    tool: toolName,
    result,
    itemId: `${itemId}:synthetic`,
    turnId,
    status: "completed",
  };
}
