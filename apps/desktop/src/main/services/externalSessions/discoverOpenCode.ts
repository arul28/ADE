import path from "node:path";
import { resolveOpenCodeBinaryPath } from "../opencode/openCodeBinaryManager";
import { runOpenCodeToFile } from "./openCodeCliOutput";
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

/**
 * ADE runs its own background prompts (terminal summaries, commit messages,
 * chat titles…) through OpenCode, titled `ADE <task>` by
 * `providerTaskRunner.runOpenCodeTask`. They land in the user's OpenCode store
 * and are never the user's work: on 2026-09-23 they were 155 of 271 listed
 * rows. Matched by the exact task names, so a user session titled
 * "ADE router …" still lists.
 */
const ADE_BACKGROUND_TASK_TITLES = new Set([
  // Current `AiFeatureKey` values.
  "narratives",
  "conflict_proposals",
  "commit_messages",
  "pr_descriptions",
  "terminal_summaries",
  "initial_context",
  "api_credentials",
  // Names older builds used.
  "session summary",
  "initial chat title",
]);

export function isAdeBackgroundTaskTitle(title: string | null | undefined): boolean {
  const match = /^ADE (.+)$/u.exec(title?.trim() ?? "");
  return Boolean(match && ADE_BACKGROUND_TASK_TITLES.has(match[1]!.trim().toLowerCase()));
}

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

  // Through the shared helper: it shims a Windows `opencode.cmd` through
  // cmd.exe, and it reads stdout from a file because OpenCode cuts a piped
  // stdout short (a real 81 KB list arrived as 64 KB of broken JSON).
  const result = await runOpenCodeToFile({
    executable,
    argv: ["session", "list", "--pure", "--format", "json", "--max-count", String(requestedLimit)],
    cwd: path.resolve(cwd),
    env,
    timeoutMs: 4000,
    maxBytes: 16 * 1024 * 1024,
  });
  if (!result.ok) {
    throw new Error(`OpenCode session discovery failed: ${result.detail}`);
  }
  const stdout = result.stdout;
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
    const rawTitle = asString(record.title) ?? asString(record.name);
    if (isAdeBackgroundTaskTitle(rawTitle)) continue;
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

  // `session list` only shows sessions of the folder it runs in, so an exact
  // lookup from anywhere else (the preview has no folder to offer) found
  // nothing and the preview stayed empty. `export` resolves an id from any
  // folder; its `info` block is the record.
  if (lookupId && records.length === 0) {
    const exported = await openCodeRecordFromExport(executable, lookupId, env);
    if (exported && cwdIsInScope(exported.cwd, args.scopeRoots)) records.push(exported);
  }

  return sortDiscoveryRecords(records, limit);
}

async function openCodeRecordFromExport(
  executable: string,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<ExternalSessionDiscoveryRecord | null> {
  let parsed: unknown;
  try {
    const result = await runOpenCodeToFile({
      executable,
      argv: ["export", "--pure", sessionId],
      env,
      timeoutMs: 15_000,
      maxBytes: 96 * 1024 * 1024,
    });
    if (!result.ok) return null;
    const start = result.stdout.indexOf("{");
    if (start < 0) return null;
    parsed = JSON.parse(result.stdout.slice(start));
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  const info = asRecord(root?.info);
  if (!info || asString(info.id) !== sessionId) return null;
  const time = asRecord(info.time);
  const messages = Array.isArray(root?.messages) ? root.messages : [];
  const userCount = messages.filter((message) => asString(asRecord(asRecord(message)?.info)?.role) === "user").length;
  const updatedAt = asEpochMs(time?.updated) ?? asEpochMs(time?.created);
  return recordWithFile({
    provider: "opencode",
    id: sessionId,
    cwd: normalizeProviderCwd(asString(info.directory)),
    title: cleanSessionTitle(asString(info.title)),
    preview: null,
    createdAt: asEpochMs(time?.created),
    updatedAt,
    messageCount: userCount,
    filePath: null,
    sourceMtimeMs: updatedAt,
  });
}
