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
  const cwd = args.cwd?.trim() || args.projectRoot?.trim() || resolveHomeDir(args);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(args.env ?? {}), NO_COLOR: "1" };
  delete env.FORCE_COLOR;

  let stdout: string;
  try {
    const result = await execFileAsync(
      executable,
      ["session", "list", "--format", "json", "--max-count", String(limit)],
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
  } catch {
    return [];
  }
  const jsonStart = stdout.indexOf("[");
  if (jsonStart < 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const records: ExternalSessionDiscoveryRecord[] = [];
  for (const row of parsed) {
    const record = asRecord(row);
    const id = asString(record?.id) ?? asString(record?.sessionID) ?? asString(record?.sessionId);
    if (!record || !id) continue;
    const rowCwd = asString(record.directory) ?? asString(record.cwd) ?? cwd;
    const title = cleanSessionTitle(asString(record.title)) ?? cleanSessionTitle(asString(record.name));
    const preview = clipExternalSessionText(
      asString(record.summary) ?? asString(record.preview) ?? asString(record.snippet),
    );
    records.push(recordWithFile({
      provider: "opencode",
      id,
      cwd: rowCwd,
      title,
      preview,
      createdAt: asEpochMs(record.created) ?? asEpochMs(record.createdAt),
      updatedAt: asEpochMs(record.updated) ?? asEpochMs(record.updatedAt),
      messageCount: typeof record.messageCount === "number" ? record.messageCount : null,
      filePath: null,
    }));
  }

  return sortDiscoveryRecords(records, limit);
}
