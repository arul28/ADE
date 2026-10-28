import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory } from "../../lib/trustedWindowsTools";
import { getErrorMessage } from "../../../../desktop/src/main/services/shared/utils";
import type { RemoteMcpActivityEntry } from "../../../../desktop/src/shared/types/remoteMcp";

/**
 * What connected AI apps ran on this computer, newest last, for Settings and
 * `ade mcp activity`. One JSON line per call. The file is capped: past the
 * limit it rolls to `.1` (one generation kept), so it never grows unbounded.
 */

const MAX_LOG_BYTES = 512 * 1024;
const MAX_DETAIL_CHARS = 300;

export function createRemoteMcpActivityLog(args: {
  filePath: string;
  logger?: { warn?: (event: string, data?: Record<string, unknown>) => void };
}) {
  const rolledPath = `${args.filePath}.1`;

  const readLines = (filePath: string): string[] => {
    try {
      return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  return {
    append(entry: RemoteMcpActivityEntry): void {
      const line = `${JSON.stringify({
        ...entry,
        ...(entry.detail ? { detail: entry.detail.slice(0, MAX_DETAIL_CHARS) } : {}),
      })}\n`;
      try {
        ensurePrivateDirectory(path.dirname(args.filePath));
        let size = 0;
        try {
          size = fs.statSync(args.filePath).size;
        } catch {
          size = 0;
        }
        if (size + line.length > MAX_LOG_BYTES) {
          fs.renameSync(args.filePath, rolledPath);
        }
        fs.appendFileSync(args.filePath, line, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        // The log is a convenience for the person; a full disk must not fail the call.
        args.logger?.warn?.("remote_mcp.activity_write_failed", {
          error: getErrorMessage(error),
        });
      }
    },

    /** Newest first. */
    recent(limit = 100): RemoteMcpActivityEntry[] {
      const bounded = Math.max(1, Math.min(500, Math.trunc(limit) || 100));
      const lines = readLines(args.filePath);
      if (lines.length < bounded) lines.unshift(...readLines(rolledPath));
      const out: RemoteMcpActivityEntry[] = [];
      for (let index = lines.length - 1; index >= 0 && out.length < bounded; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index]!) as RemoteMcpActivityEntry;
          if (parsed && typeof parsed.at === "string" && typeof parsed.command === "string") out.push(parsed);
        } catch {
          // skip a torn line
        }
      }
      return out;
    },
  };
}
