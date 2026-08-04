import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveOpenCodeBinaryPath } from "../opencode/openCodeBinaryManager";
import { resolveCliSpawnInvocation } from "../shared/processExecution";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  clipExternalSessionText,
  cwdIsInScope,
  MAX_EXTERNAL_SESSION_LIMIT,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
  recordWithFile,
  resolveHomeDir,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

const execFileAsync = promisify(execFile);

export async function discoverOpenCodeSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const lookupId = args.sessionId?.trim() || null;
  const executable = resolveOpenCodeBinaryPath();
  // Returning [] here is indistinguishable from "no sessions yet", which is why
  // a machine without OpenCode installed used to show an empty list and no
  // explanation. The service surfaces this to the caller that asked only for
  // OpenCode and logs it for a mixed-provider scan.
  if (!executable) {
    throw new Error("OpenCode CLI not found: install `opencode` to import its sessions.");
  }
  const requestedCwd = args.cwd?.trim() || args.projectRoot?.trim() || null;
  const cwd = requestedCwd ?? resolveHomeDir(args);
  // OpenCode may omit the directory from `session list` rows. When discovery
  // is intentionally scoped, the command's requested cwd is the only safe
  // project association available; unscoped discovery must leave it unknown.
  const scopedCwdFallback = args.scopeRoots?.length && requestedCwd ? path.resolve(requestedCwd) : null;
  // OpenCode exposes list, not a metadata-by-id command. Exact lookup still
  // bypasses ADE's broad list decoration/sort, while asking OpenCode for its
  // full supported window so older valid ids are not silently hidden.
  const requestedLimit = lookupId
    ? MAX_EXTERNAL_SESSION_LIMIT
    : args.scopeRoots?.length ? Math.max(limit, 1000) : limit;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(args.env ?? {}), NO_COLOR: "1" };
  delete env.FORCE_COLOR;

  // `npm i -g opencode-ai` installs `%APPDATA%\npm\opencode.cmd` on Windows, and
  // Node refuses to spawn a `.cmd`/`.bat` without a shell (it fails with a bare
  // `spawn EINVAL`). The same install is a directly executable script on macOS,
  // so this path only breaks on Windows. Route through the shared invocation
  // helper, which shims those targets through cmd.exe and leaves a real `.exe`
  // untouched.
  const invocation = resolveCliSpawnInvocation(
    executable,
    ["session", "list", "--pure", "--format", "json", "--max-count", String(requestedLimit)],
    env,
  );

  let stdout: string;
  try {
    const result = await execFileAsync(
      invocation.command,
      invocation.args,
      {
        cwd: path.resolve(cwd),
        encoding: "utf8",
        timeout: 4000,
        killSignal: "SIGTERM",
        maxBuffer: 2 * 1024 * 1024,
        env,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
    );
    stdout = String(result.stdout ?? "");
  } catch (error) {
    throw new Error(`OpenCode session discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const jsonStart = stdout.indexOf("[");
  if (jsonStart < 0) {
    // `opencode session list --format json` prints nothing at all when there are
    // no sessions rather than an empty array, so a user who has simply never run
    // the OpenCode CLI is not an error -- it is an empty result. Only treat
    // non-empty output with no array in it as a genuine protocol failure.
    if (stdout.trim().length === 0) return [];
    throw new Error("OpenCode session discovery returned no JSON session list.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch (error) {
    throw new Error(`OpenCode session discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("OpenCode session discovery returned an invalid session list.");
  }

  const records: ExternalSessionDiscoveryRecord[] = [];
  for (const row of parsed) {
    const record = asRecord(row);
    const id = asString(record?.id) ?? asString(record?.sessionID) ?? asString(record?.sessionId);
    if (!record || !id || (lookupId && id !== lookupId)) continue;
    const rowCwd = normalizeProviderCwd(asString(record.directory) ?? asString(record.cwd)) ?? scopedCwdFallback;
    if (!cwdIsInScope(rowCwd, args.scopeRoots)) continue;
    const title = cleanSessionTitle(asString(record.title)) ?? cleanSessionTitle(asString(record.name));
    const preview = clipExternalSessionText(
      asString(record.summary) ?? asString(record.preview) ?? asString(record.snippet),
    );
    const updatedAt = asEpochMs(record.updated) ?? asEpochMs(record.updatedAt);
    records.push(recordWithFile({
      provider: "opencode",
      id,
      cwd: rowCwd,
      title,
      preview,
      createdAt: asEpochMs(record.created) ?? asEpochMs(record.createdAt),
      updatedAt,
      messageCount: typeof record.messageCount === "number" ? record.messageCount : null,
      filePath: null,
      sourceMtimeMs: updatedAt,
    }));
  }

  return sortDiscoveryRecords(records, limit);
}
