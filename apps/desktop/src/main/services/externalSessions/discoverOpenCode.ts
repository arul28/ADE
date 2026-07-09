import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveOpenCodeBinaryPath } from "../opencode/openCodeBinaryManager";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  clipExternalSessionText,
  cwdIsInScope,
  normalizeExternalSessionLimit,
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
  const executable = resolveOpenCodeBinaryPath();
  if (!executable) return [];
  const requestedCwd = args.cwd?.trim() || args.projectRoot?.trim() || null;
  const cwd = requestedCwd ?? resolveHomeDir(args);
  // OpenCode may omit the directory from `session list` rows. When discovery
  // is intentionally scoped, the command's requested cwd is the only safe
  // project association available; unscoped discovery must leave it unknown.
  const scopedCwdFallback = args.scopeRoots?.length && requestedCwd ? path.resolve(requestedCwd) : null;
  const requestedLimit = args.scopeRoots?.length ? Math.max(limit, 1000) : limit;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(args.env ?? {}), NO_COLOR: "1" };
  delete env.FORCE_COLOR;

  let stdout: string;
  try {
    const result = await execFileAsync(
      executable,
      ["session", "list", "--pure", "--format", "json", "--max-count", String(requestedLimit)],
      {
        cwd: path.resolve(cwd),
        encoding: "utf8",
        timeout: 4000,
        killSignal: "SIGTERM",
        maxBuffer: 2 * 1024 * 1024,
        env,
      },
    );
    stdout = String(result.stdout ?? "");
  } catch (error) {
    throw new Error(`OpenCode session discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const jsonStart = stdout.indexOf("[");
  if (jsonStart < 0) {
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
    if (!record || !id) continue;
    const rowCwd = asString(record.directory) ?? asString(record.cwd) ?? scopedCwdFallback;
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
