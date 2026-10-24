import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, writePrivateFile } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import { captureError } from "../../../shared/sentry/capture";

/**
 * Moves the Agent SDK's inline `--mcp-config <json>` off the Claude command
 * line and into a private file.
 *
 * The SDK passes every process MCP server — with its env values and HTTP
 * headers, which hold API keys and sign-in tokens — as one JSON argument.
 * A command line is readable by every process on the machine (`ps`), and the
 * subprocess reaper writes the arguments to its registry file. The Claude CLI
 * takes the same flag as a file path (`--mcp-config <configs...>`: "JSON files
 * or strings") and reads it the same way, `${NAME}` expansion included, so the
 * JSON goes into a file only this user can read (`ensurePrivateDirectory` and
 * `writePrivateFile`: mode 0700/0600 on POSIX, an owner-only ACL on Windows,
 * as the tracked Claude terminals do) and the path takes its place.
 *
 * Only a value that is inline JSON moves; a path is left as it is. The caller
 * deletes the files when the process exits.
 */
export function moveClaudeMcpConfigOffArgv(
  args: readonly string[],
  dir: string,
): { args: string[]; files: string[] } {
  const files: string[] = [];
  const toFile = (json: string): string => {
    ensurePrivateDirectory(dir);
    const file = path.join(dir, `${randomUUID()}.json`);
    writePrivateFile(file, json);
    files.push(file);
    return file;
  };
  const isInlineJson = (value: string): boolean => value.trimStart().startsWith("{");
  const out: string[] = [];
  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--mcp-config") {
        out.push(arg);
        // A variadic flag: its values run until the next flag.
        while (index + 1 < args.length && !args[index + 1]!.startsWith("--")) {
          index += 1;
          const value = args[index]!;
          out.push(isInlineJson(value) ? toFile(value) : value);
        }
        continue;
      }
      if (arg.startsWith("--mcp-config=")) {
        const value = arg.slice("--mcp-config=".length);
        out.push(isInlineJson(value) ? `--mcp-config=${toFile(value)}` : arg);
        continue;
      }
      out.push(arg);
    }
  } catch (error) {
    // A later write failed: the files already written hold secrets too.
    removeClaudeMcpConfigFiles(files);
    throw error;
  }
  return { args: out, files };
}

/**
 * Delete the files of processes that are gone. `force` makes a file that is
 * already gone a no-op, so anything thrown here is a secret-bearing file left
 * on disk: reported, then left to the startup sweep.
 */
export function removeClaudeMcpConfigFiles(files: readonly string[]): void {
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      captureError(error, { fingerprint: ["claude", "mcp_config_file_remove_failed"] });
    }
  }
}

/**
 * Delete the files no running Claude process uses. A brain that was killed
 * never ran its exit handlers, so its processes' files stay behind with their
 * secrets. Run once when the reaper starts.
 *
 * `liveCommandLines` is every process's command line on this machine (one
 * `ps` read), or null where it could not be read (Windows, or `ps` failed);
 * then only files older than `maxAgeMs` go. A file younger than a minute is
 * always kept: another brain may be starting its process right now.
 */
export function pruneStaleClaudeMcpConfigFiles(
  dir: string,
  maxAgeMs: number,
  liveCommandLines: string | null,
  now = Date.now(),
): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const age = now - fs.statSync(file).mtimeMs;
      if (age < 60_000) continue;
      const unused = liveCommandLines != null ? !liveCommandLines.includes(name) : age > maxAgeMs;
      if (unused) fs.rmSync(file, { force: true });
    } catch {
      // Another brain removed it first.
    }
  }
}
