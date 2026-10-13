import path from "node:path";
import { pathsEqual } from "../shared/pathCompare";
import {
  asRecord,
  asString,
  cleanSessionTitle,
  cwdIsInScope,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
  readFilePrefix,
  realishPath,
  resolveHomeDir,
  safeParseJson,
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
  safeLookupId,
  summarizeNeutralRecords,
  type NeutralSessionRecord,
} from "./discoverAcpShared";

/**
 * Meta Muse Code (verified against muse 1.4.7-R6101.1).
 *
 * Layout (`$XDG_DATA_HOME/muse`, default `~/.local/share/muse`):
 *
 * - `sessions/YYYY/MM/DD/<sessionId>/session.jsonl` — the session log. The id
 *   is a UUIDv7, so its first 48 bits are the creation time in ms. The
 *   directory is created when the TUI starts, before any prompt.
 * - `sessions/YYYY/MM/DD/<sessionId>/subagent/<childId>/session.jsonl` —
 *   reminder and subagent runs. Never sessions the user resumes.
 * - `.session.lock` and `cron.db` beside the log stay open while a process
 *   owns the session, which is what handle capture keys on.
 *
 * Each line is either a record `{ record_type, payload_type, payload,
 * recorded_at (µs), stream }` or a frame `{ retained_frame, children: [{
 * record_json }] }` wrapping several records. The records ADE reads:
 *
 * - `runtime.session.metadata` — `record.workspace_root` (a realpath, e.g.
 *   `/private/tmp/…` on macOS).
 * - `session.opened.observed` — `record.client_info_name` is `"ade"` for a
 *   session ADE's chat runtime opened over MSP, and absent for the TUI.
 * - `runtime.user_intent.accepted` — a user turn: `refill_blocks[].text`.
 * - `runtime.session` with `{ kind: "run", event: { kind:
 *   "assistant_message_committed", text } }` — an assistant reply.
 * - `session.name.changed` — `new_name`, `source` (`automatic` names are
 *   random word pairs, not titles).
 */

const MUSE_SESSION_LOG = "session.jsonl";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Header records (metadata, session opened) sit in the first few KB. */
const HEADER_MAX_BYTES = 256 * 1024;

export function museDataHome(args: Pick<ExternalSessionDiscoveryArgs, "homeDir" | "env"> = {}): string {
  const env = args.env ?? process.env;
  const xdgData = env.XDG_DATA_HOME?.trim();
  return xdgData
    ? path.join(xdgData, "muse")
    : path.join(resolveHomeDir(args), ".local", "share", "muse");
}

export function museSessionsRoot(args: Pick<ExternalSessionDiscoveryArgs, "homeDir" | "env"> = {}): string {
  return path.join(museDataHome(args), "sessions");
}

/** Creation time from a UUIDv7 session id, or null for anything else. */
export function museSessionCreatedAtMs(sessionId: string): number | null {
  if (!UUID_V7.test(sessionId)) return null;
  const ms = Number.parseInt(sessionId.replace(/-/g, "").slice(0, 12), 16);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Flatten one log line: a record, or the records a frame wraps. */
export function museRecordsFromLogLine(record: Record<string, unknown>): Record<string, unknown>[] {
  if (typeof record.payload_type === "string") return [record];
  const children = Array.isArray(record.children) ? record.children : [];
  return compact(children.map((child) => {
    const json = asString(asRecord(child)?.record_json);
    return json ? asRecord(safeParseJson(json)) : null;
  }));
}

function flattenMuseRecords(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.flatMap(museRecordsFromLogLine);
}

/** `recorded_at` is in microseconds. */
function museRecordTimeMs(record: Record<string, unknown>): number | null {
  const value = record.recorded_at;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value / 1000);
}

function textFromBlocks(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = compact(value.map((block) => {
    const entry = asRecord(block);
    return entry && (entry.kind === "text" || entry.type === "text") ? asString(entry.text) : null;
  }));
  return parts.length ? parts.join("\n") : null;
}

function neutralMuseRecord(record: Record<string, unknown>): NeutralSessionRecord | null {
  const payload = asRecord(record.payload);
  if (!payload) return null;
  if (record.payload_type === "runtime.user_intent.accepted") {
    // Only the main conversation; reminder and subagent turns live elsewhere.
    if (asString(payload.surface) && payload.surface !== "main") return null;
    const kind = asString(asRecord(payload.semantic_kind)?.kind);
    if (kind && kind !== "chat") return null;
    return neutralRecord("user", textFromBlocks(payload.refill_blocks), museRecordTimeMs(record));
  }
  if (record.payload_type === "runtime.session" && payload.kind === "run") {
    const event = asRecord(payload.event);
    if (event?.kind === "assistant_message_committed") {
      return neutralRecord("assistant", asString(event.text), museRecordTimeMs(record));
    }
  }
  return null;
}

/** User and assistant turns from raw log lines, oldest first, for detail tails. */
export function museMessagesFromLogLines(
  lines: readonly unknown[],
): Array<{ role: "user" | "assistant"; text: string; at: number | null }> {
  const records = flattenMuseRecords(compact(lines.map(asRecord)));
  return compact(records.map(neutralMuseRecord)).map((record) => ({
    role: record.type,
    text: record.message.content,
    at: typeof record.timestamp === "number" ? record.timestamp : null,
  }));
}

export type MuseSessionHeader = {
  /** Realpath of the folder the session runs in. */
  workspaceRoot: string | null;
  /** `"ade"` for a session ADE's chat runtime opened over MSP; null for the TUI. */
  clientInfoName: string | null;
  /** A user-chosen session name; Muse's automatic names are left out. */
  name: string | null;
};

function headerFromRecords(records: Record<string, unknown>[]): MuseSessionHeader {
  let workspaceRoot: string | null = null;
  let clientInfoName: string | null = null;
  let name: string | null = null;
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (!payload) continue;
    const inner = asRecord(payload.record);
    if (record.payload_type === "runtime.session.metadata" && !workspaceRoot) {
      workspaceRoot = asString(inner?.workspace_root);
    } else if (record.payload_type === "session.opened.observed" && !clientInfoName) {
      clientInfoName = asString(inner?.client_info_name);
    } else if (record.payload_type === "session.name.changed") {
      const next = asString(payload.new_name);
      name = next && payload.source !== "automatic" ? next : name;
    }
  }
  return { workspaceRoot, clientInfoName, name };
}

/** The header of one session log, read from its first few hundred KB. */
export function readMuseSessionHeader(logPath: string): MuseSessionHeader {
  const text = readFilePrefix(logPath, HEADER_MAX_BYTES) ?? "";
  const lines = compact(text.split(/\r?\n/u).map((line) => (line.trim() ? asRecord(safeParseJson(line)) : null)));
  return headerFromRecords(flattenMuseRecords(lines));
}

export type MuseSessionCandidate = {
  id: string;
  sessionDir: string;
  logPath: string;
  /** From the UUIDv7 id, else the log's birth time. */
  createdAtMs: number;
  mtimeMs: number;
  size: number;
};

/**
 * Every top-level session under `sessions/YYYY/MM/DD/`. Subagent sessions sit
 * one level deeper and are never listed. `lookupId` narrows the walk to one id.
 */
export function listMuseSessionCandidates(
  sessionsRoot: string,
  lookupId: string | null = null,
): MuseSessionCandidate[] {
  const candidates: MuseSessionCandidate[] = [];
  for (const year of safeReadDir(sessionsRoot)) {
    if (!year.isDirectory() || !/^\d{4}$/u.test(year.name)) continue;
    const yearDir = path.join(sessionsRoot, year.name);
    for (const month of safeReadDir(yearDir)) {
      if (!month.isDirectory() || !/^\d{2}$/u.test(month.name)) continue;
      const monthDir = path.join(yearDir, month.name);
      for (const day of safeReadDir(monthDir)) {
        if (!day.isDirectory() || !/^\d{2}$/u.test(day.name)) continue;
        const dayDir = path.join(monthDir, day.name);
        const ids = lookupId
          ? [lookupId]
          : safeReadDir(dayDir).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        for (const id of ids) {
          if (!UUID_V7.test(id)) continue;
          const sessionDir = path.join(dayDir, id);
          const logPath = path.join(sessionDir, MUSE_SESSION_LOG);
          const stat = safeStat(logPath);
          if (!stat?.isFile()) continue;
          candidates.push({
            id: id.toLowerCase(),
            sessionDir,
            logPath,
            createdAtMs: museSessionCreatedAtMs(id) ?? Math.floor(stat.birthtimeMs || stat.mtimeMs),
            mtimeMs: Math.floor(stat.mtimeMs),
            size: stat.size,
          });
        }
      }
    }
  }
  return candidates;
}

function workspaceMatches(workspaceRoot: string | null, cwd: string): boolean {
  if (!workspaceRoot) return false;
  return pathsEqual(realishPath(workspaceRoot), realishPath(cwd));
}

/**
 * The Muse TUI session a tracked terminal started, for resume capture.
 *
 * Muse takes no session id at launch, so ownership is proven, never guessed:
 * the session must run in this terminal's folder, be a TUI session (an ADE
 * chat's MSP session records `client_info_name: "ade"`), start within the
 * window after this PTY started, and not already belong to another terminal.
 * Of what is left, the one born closest to the PTY's start wins.
 */
export function findMuseSessionForCwd(args: {
  cwd: string;
  startedAt: string | number | null;
  maxStartDeltaMs: number;
  excludedIds?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): { id: string; logPath: string } | null {
  const startedAtMs = typeof args.startedAt === "number" ? args.startedAt : Date.parse(String(args.startedAt ?? ""));
  if (!Number.isFinite(startedAtMs)) return null;
  const eligible = listMuseSessionCandidates(museSessionsRoot(args)).filter((candidate) => {
    if (args.excludedIds?.has(candidate.id)) return false;
    // A session born before this PTY started belongs to an earlier run.
    if (candidate.createdAtMs < startedAtMs - 1_000) return false;
    return candidate.createdAtMs - startedAtMs <= args.maxStartDeltaMs;
  });
  let best: { candidate: MuseSessionCandidate; delta: number } | null = null;
  for (const candidate of eligible) {
    const header = readMuseSessionHeader(candidate.logPath);
    if (header.clientInfoName) continue;
    if (!workspaceMatches(header.workspaceRoot, args.cwd)) continue;
    const delta = Math.abs(candidate.createdAtMs - startedAtMs);
    if (!best || delta < best.delta) best = { candidate, delta };
  }
  return best ? { id: best.candidate.id, logPath: best.candidate.logPath } : null;
}

function museRecordFromCandidate(
  candidate: MuseSessionCandidate,
  scopeRoots: readonly string[] | null | undefined,
): ExternalSessionDiscoveryRecord | null {
  const window = readJsonlWindow(candidate.logPath, candidate.size);
  const headRecords = flattenMuseRecords(window.head);
  const header = headerFromRecords(window.all ? flattenMuseRecords(window.all) : headRecords);
  // ADE's own Muse chats are listed as chats already; importing one would
  // fork ownership of a session the chat runtime is driving.
  if (header.clientInfoName === "ade") return null;
  const cwd = normalizeProviderCwd(header.workspaceRoot);
  if (!cwdIsInScope(cwd, scopeRoots)) return null;

  const head = compact(headRecords.map(neutralMuseRecord));
  const tailRecords = flattenMuseRecords(window.tail);
  // A tracked ADE terminal opens with ADE's guidance block; the shared text
  // cleaner reduces it to the user's own prompt, as it does for Codex.
  const summary = summarizeNeutralRecords("muse", {
    head,
    tail: compact(tailRecords.map(neutralMuseRecord)),
    all: window.all ? compact(flattenMuseRecords(window.all).map(neutralMuseRecord)) : null,
  });
  if (!summary.hasPrompt) return null;

  const tailTimes = compact(tailRecords.map(museRecordTimeMs));
  return acpDiscoveryRecord({
    provider: "muse",
    id: candidate.id,
    cwd,
    title: cleanSessionTitle(header.name),
    preview: summary.preview,
    messages: summary.messages,
    createdAt: candidate.createdAtMs,
    updatedAt: Math.max(candidate.mtimeMs, tailTimes.length ? Math.max(...tailTimes) : 0) || null,
    messageCount: summary.messageCount,
    launch: null,
    filePath: candidate.logPath,
    sourceMtimeMs: candidate.mtimeMs,
    sizeBytes: candidate.size,
  });
}

/** Lists Muse TUI sessions from Muse's own on-disk store. */
export async function discoverMuseSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const lookupId = safeLookupId(args.sessionId);
  if (lookupId === false) return [];
  const root = museSessionsRoot(args);
  if (!safeStat(root)?.isDirectory()) return [];
  return collectNewestSessions({
    candidates: listMuseSessionCandidates(root, lookupId ? lookupId.toLowerCase() : null),
    limit: normalizeExternalSessionLimit(args.limit),
    lookupId: lookupId ? lookupId.toLowerCase() : null,
    read: (candidate) => museRecordFromCandidate(candidate, args.scopeRoots),
  });
}
