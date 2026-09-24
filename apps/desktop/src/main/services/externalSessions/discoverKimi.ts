import path from "node:path";
import { kimiCodeConfigHome } from "../shared/providerConfigHomes";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  cwdIsInScope,
  extractText,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
  readJsonlRecordsFromSuffix,
  resolveHomeDir,
  safeReadDir,
  safeStat,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";
import {
  acpDiscoveryRecord,
  collectNewestSessions,
  compact,
  neutralRecord,
  readJsonlWindow,
  readSmallJson,
  safeLookupId,
  startsWithAdeGuidance,
  summarizeNeutralRecords,
  type NeutralSessionRecord,
} from "./discoverAcpShared";

/**
 * Kimi Code (0.39.1).
 *
 * UNVERIFIED AGAINST REAL SESSIONS: no Kimi session existed on the machine this
 * was written on, so the layout and record shapes below come from reading the
 * shipped `kimi` bundle, not from real files. Every read is defensive — any
 * missing or unexpected piece yields a thinner row or no row, never a throw.
 *
 * Layout (`KIMI_CODE_HOME`, default `~/.kimi-code`):
 *
 * - `workspaces.json` — `{ workspaces: { "wd_<slug>_<sha256(root)[:12]>":
 *   { root, name, created_at, last_opened_at } } }`
 * - `session_index.jsonl` — `{ sessionId, sessionDir, workDir }` rows, and
 *   `{ sessionId, deleted: true }` tombstones.
 * - `sessions/<workspaceId>/<sessionId>/state.json` — `{ title, customTitle,
 *   isCustomTitle, lastPrompt, workDir, archived, custom }`.
 * - `sessions/<workspaceId>/<sessionId>/agents/main/wire.jsonl` — agent
 *   records: `context.append_message` (`message: { role, content, origin }`),
 *   `turn_begin` (`userInput`, `time`), `turn.prompt`, loop events. Sessions
 *   migrated from the legacy CLI keep `context.jsonl` (`{ role, content }`) at
 *   the session root instead.
 */
function kimiHome(args: ExternalSessionDiscoveryArgs): string {
  return kimiCodeConfigHome({ env: args.env ?? process.env, homeDir: resolveHomeDir(args) });
}

function readWorkspaceRoots(home: string): Map<string, string> {
  const roots = new Map<string, string>();
  const workspaces = asRecord(readSmallJson(path.join(home, "workspaces.json"), 1024 * 1024)?.workspaces);
  for (const [id, value] of Object.entries(workspaces ?? {})) {
    const root = asString(asRecord(value)?.root);
    if (root) roots.set(id, root);
  }
  return roots;
}

/** `sessionId -> workDir` from the global index, minus deleted sessions. */
function readSessionIndex(home: string): { workDirs: Map<string, string>; deleted: Set<string> } {
  const workDirs = new Map<string, string>();
  const deleted = new Set<string>();
  for (const row of readJsonlRecordsFromSuffix(path.join(home, "session_index.jsonl"))) {
    const record = asRecord(row);
    const sessionId = asString(record?.sessionId);
    if (!record || !sessionId) continue;
    if (record.deleted === true) {
      deleted.add(sessionId);
      workDirs.delete(sessionId);
      continue;
    }
    deleted.delete(sessionId);
    const workDir = asString(record.workDir);
    if (workDir) workDirs.set(sessionId, workDir);
  }
  return { workDirs, deleted };
}

/** Kimi's own `titleFromState`. */
function kimiTitle(state: Record<string, unknown> | null): string | null {
  if (!state) return null;
  if (typeof state.isCustomTitle === "boolean" && typeof state.title === "string") return state.title;
  return asString(state.customTitle) ?? asString(state.title);
}

function recordTime(record: Record<string, unknown>): number | string | null {
  const time = record.time ?? record.created_at ?? record.timestamp;
  return typeof time === "number" || typeof time === "string" ? time : null;
}

/** User turns Kimi counts as typed by the person (mirrors `isUserVisibleTurnRecord`). */
export function isKimiUserOrigin(message: Record<string, unknown>): boolean {
  const origin = asRecord(message.origin);
  const kind = asString(origin?.kind);
  if (kind == null || kind === "user") return true;
  if (kind === "skill_activation" || kind === "plugin_command") return origin?.trigger === "user-slash";
  if (kind === "shell_command") return origin?.phase === "input";
  return false;
}

function neutralKimiRecord(record: Record<string, unknown>): NeutralSessionRecord | null {
  if (record.type === "context.append_message") {
    const message = asRecord(record.message);
    const role = asString(message?.role);
    if (!message || (role !== "user" && role !== "assistant")) return null;
    if (role === "user" && !isKimiUserOrigin(message)) return null;
    return neutralRecord(role, extractText(message.content), recordTime(record));
  }
  if (record.type === "turn_begin") return neutralRecord("user", asString(record.userInput), recordTime(record));
  // Legacy `context.jsonl` rows are bare `{ role, content }` messages; the
  // `_system_prompt` / `_checkpoint` / `_usage` roles are bookkeeping.
  const role = asString(record.role);
  if (record.type == null && (role === "user" || role === "assistant")) {
    return neutralRecord(role, extractText(record.content), recordTime(record));
  }
  return null;
}

/**
 * A wire log can carry both `turn_begin` and `context.append_message` for the
 * same prompt. Keep `turn_begin` only when the log has no user messages of the
 * newer form, so one prompt is never counted twice.
 */
function neutralKimiRecords(records: Record<string, unknown>[]): NeutralSessionRecord[] {
  const hasAppendUser = records.some((record) => (
    record.type === "context.append_message" && asString(asRecord(record.message)?.role) === "user"
  ));
  return compact(records
    .filter((record) => !(hasAppendUser && record.type === "turn_begin"))
    .map(neutralKimiRecord));
}

type KimiCandidate = {
  id: string;
  sessionDir: string;
  workspaceRoot: string | null;
  historyPath: string;
  mtimeMs: number;
  size: number;
};

function kimiHistoryFile(sessionDir: string): { filePath: string; stat: NonNullable<ReturnType<typeof safeStat>> } | null {
  for (const filePath of [
    path.join(sessionDir, "agents", "main", "wire.jsonl"),
    path.join(sessionDir, "context.jsonl"),
  ]) {
    const stat = safeStat(filePath);
    if (stat?.isFile()) return { filePath, stat };
  }
  return null;
}

function listKimiCandidates(
  args: ExternalSessionDiscoveryArgs,
  home: string,
  lookupId: string | null,
  deleted: Set<string>,
): KimiCandidate[] {
  const sessionsDir = path.join(home, "sessions");
  const workspaceRoots = readWorkspaceRoots(home);
  const candidates: KimiCandidate[] = [];
  for (const workspaceEntry of safeReadDir(sessionsDir)) {
    if (!workspaceEntry.isDirectory()) continue;
    const workspaceRoot = workspaceRoots.get(workspaceEntry.name) ?? null;
    // A bucket is one workspace root; its sessions run there or below it.
    if (workspaceRoot && !cwdIsInScope(workspaceRoot, args.scopeRoots)) continue;
    const workspaceDir = path.join(sessionsDir, workspaceEntry.name);
    const ids = lookupId
      ? [lookupId]
      : safeReadDir(workspaceDir).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const id of ids) {
      if (deleted.has(id)) continue;
      const sessionDir = path.join(workspaceDir, id);
      const history = kimiHistoryFile(sessionDir);
      if (!history) continue;
      candidates.push({
        id,
        sessionDir,
        workspaceRoot,
        historyPath: history.filePath,
        mtimeMs: Math.floor(history.stat.mtimeMs),
        size: history.stat.size,
      });
    }
  }
  return candidates;
}

function kimiRecordFromCandidate(
  candidate: KimiCandidate,
  indexWorkDirs: Map<string, string>,
  scopeRoots: readonly string[] | null | undefined,
): ExternalSessionDiscoveryRecord | null {
  const state = readSmallJson(path.join(candidate.sessionDir, "state.json"));
  if (state?.archived === true) return null;
  const custom = asRecord(state?.custom);
  // Child sessions are subagent runs, not something the user resumes.
  if (asString(custom?.child_session_kind) === "child" || asString(custom?.parent_session_id)) return null;
  const cwd = normalizeProviderCwd(
    asString(state?.workDir)
      ?? asString(state?.cwd)
      ?? asString(custom?.cwd)
      ?? indexWorkDirs.get(candidate.id)
      ?? candidate.workspaceRoot,
  );
  if (!cwdIsInScope(cwd, scopeRoots)) return null;

  const window = readJsonlWindow(candidate.historyPath, candidate.size);
  const head = neutralKimiRecords(window.head);
  // Kimi's ACP server cannot be told apart by any file marker, so ADE's own
  // chats are recognised the same way as Qwen's: by the ADE guidance block
  // that opens their first prompt.
  const firstUser = head.find((record) => record.type === "user");
  if (startsWithAdeGuidance(firstUser?.message.content)) return null;

  const summary = summarizeNeutralRecords("kimi", {
    head,
    tail: neutralKimiRecords(window.tail),
    all: window.all ? neutralKimiRecords(window.all) : null,
  });
  if (!summary.hasPrompt) return null;

  const times = [...window.head, ...window.tail]
    .map((record) => asEpochMs(recordTime(record)))
    .filter((value): value is number => value != null);
  const model = asString(state?.model) ?? asString(custom?.model);

  return acpDiscoveryRecord({
    provider: "kimi",
    id: candidate.id,
    cwd,
    title: cleanSessionTitle(kimiTitle(state)),
    preview: summary.preview,
    messages: summary.messages,
    createdAt: asEpochMs(state?.createdAt) ?? (times.length ? Math.min(...times) : null),
    updatedAt: Math.max(asEpochMs(state?.updatedAt) ?? 0, times.length ? Math.max(...times) : 0, candidate.mtimeMs) || null,
    messageCount: summary.messageCount,
    launch: model ? { model } : null,
    filePath: candidate.historyPath,
    sourceMtimeMs: candidate.mtimeMs,
    sizeBytes: candidate.size,
  });
}

/** Lists Kimi sessions from the provider's own on-disk store. */
export async function discoverKimiSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const lookupId = safeLookupId(args.sessionId);
  if (lookupId === false) return [];
  const home = kimiHome(args);
  if (!safeStat(path.join(home, "sessions"))?.isDirectory()) return [];
  const index = readSessionIndex(home);
  return collectNewestSessions({
    candidates: listKimiCandidates(args, home, lookupId, index.deleted),
    limit: normalizeExternalSessionLimit(args.limit),
    lookupId,
    read: (candidate) => kimiRecordFromCandidate(candidate, index.workDirs, args.scopeRoots),
  });
}
