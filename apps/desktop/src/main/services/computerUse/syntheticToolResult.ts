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

import path from "node:path";
import type { AgentChatEvent } from "../../../shared/types/chat";

const ARTIFACT_EXT =
  "png|jpe?g|webp|gif|bmp|tiff|svg|mp4|webm|mov|avi|mkv|zip|trace|log|txt|ndjson|jsonl";

/** Broad match for POSIX, Windows, and quoted paths ending with known artifact extensions. */
const ARTIFACT_PATH_RE = new RegExp(
  [
    "(?:^|[\\s\"'=:,])(",
    "(?:\"(?:[^\"\\\\]|\\\\.)+\"|'(?:[^'\\\\]|\\\\.)+'|",
    "(?:[a-zA-Z]:[\\\\/]|\\\\\\\\|/)[^\\n\\r\"'<>|*?]+|",
    "(?:/[\\w.~\\-\\[\\] ]+/)+[\\w.~-]+)",
    `\\.(?:${ARTIFACT_EXT})`,
    ")(?:\\b|$)",
  ].join(""),
  "gi",
);

function stripQuotes(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return t;
}

function isAbsoluteArtifactPath(candidate: string): boolean {
  const p = stripQuotes(candidate).trim();
  if (!p.length) return false;
  if (path.posix.isAbsolute(p)) return true;
  if (path.win32.isAbsolute(p)) return true;
  return /^\\\\/.test(p);
}

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
        const raw = match[1]?.trim();
        if (!raw) continue;
        const p = stripQuotes(raw);
        if (isAbsoluteArtifactPath(p)) paths.add(p);
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
