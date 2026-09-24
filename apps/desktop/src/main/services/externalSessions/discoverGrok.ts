import path from "node:path";
import { grokConfigHome } from "../shared/providerConfigHomes";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  cwdIsInScope,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
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
  safeLookupId,
  readSmallJson,
  summarizeNeutralRecords,
  type NeutralSessionRecord,
} from "./discoverAcpShared";

/**
 * Grok CLI (verified against 1.0.40) keeps each session in
 * `$GROK_HOME/sessions/<percent-encoded cwd>/<sessionId>/` (`GROK_HOME`
 * defaults to `~/.grok`):
 *
 * - `summary.json` — `{ info: { id, cwd }, generated_title, session_summary,
 *   created_at, updated_at, last_active_at, current_model_id, session_kind? }`
 * - `chat_history.jsonl` — `{ type: "user", content: [{ type: "text", text }],
 *   synthetic_reason?, prompt_index? }`, `{ type: "assistant", content,
 *   tool_calls }`, `{ type: "tool_result", tool_call_id, content }`, plus
 *   `system` and `reasoning` rows.
 *
 * Unlike most providers the folder name is reversible: it is the cwd,
 * percent-encoded.
 *
 * Two kinds of session are not the user's own TUI work and are left out:
 * `session_kind: "subagent"` children, and sessions with `updates.jsonl` —
 * only an ACP client (ADE's Grok chats) produces that file.
 */
function grokSessionsDir(args: ExternalSessionDiscoveryArgs): string {
  return path.join(grokConfigHome({ env: args.env ?? process.env, homeDir: resolveHomeDir(args) }), "sessions");
}

function decodeGrokProjectDir(name: string): string | null {
  try {
    const decoded = decodeURIComponent(name);
    return path.isAbsolute(decoded) || path.win32.isAbsolute(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function grokContentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map(asRecord)
    .map((part) => (part && (part.type == null || part.type === "text") && typeof part.text === "string" ? part.text : ""))
    .filter((value) => value.trim().length > 0)
    .join("\n");
  return text || null;
}

/**
 * Grok opens every conversation with a `<user_info>` workspace-context block
 * written as an ordinary user row. It is not something the user typed; the
 * real prompt follows with a `prompt_index` and a `<user_query>` wrapper.
 */
function isGrokContextBlock(text: string): boolean {
  return /^\s*<user_info>/u.test(text) && !/<user_query>/u.test(text);
}

function neutralGrokRecord(record: Record<string, unknown>): NeutralSessionRecord | null {
  if (record.type === "user") {
    if (asString(record.synthetic_reason)) return null;
    const text = grokContentText(record.content);
    if (!text || isGrokContextBlock(text)) return null;
    return neutralRecord("user", text, null);
  }
  if (record.type === "assistant") return neutralRecord("assistant", grokContentText(record.content), null);
  return null;
}

type GrokCandidate = {
  id: string;
  sessionDir: string;
  folderCwd: string | null;
  historyPath: string;
  mtimeMs: number;
  size: number;
};

function listGrokCandidates(args: ExternalSessionDiscoveryArgs, lookupId: string | null): GrokCandidate[] {
  const sessionsDir = grokSessionsDir(args);
  const candidates: GrokCandidate[] = [];
  for (const projectEntry of safeReadDir(sessionsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const folderCwd = decodeGrokProjectDir(projectEntry.name);
    // The folder name is the cwd itself, so an out-of-scope folder is skipped
    // before any session in it is opened.
    if (folderCwd && !cwdIsInScope(folderCwd, args.scopeRoots)) continue;
    const projectDir = path.join(sessionsDir, projectEntry.name);
    const ids = lookupId
      ? [lookupId]
      : safeReadDir(projectDir).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const id of ids) {
      const sessionDir = path.join(projectDir, id);
      const historyPath = path.join(sessionDir, "chat_history.jsonl");
      const stat = safeStat(historyPath);
      if (!stat?.isFile()) continue;
      // ADE's ACP chats are the only writer of `updates.jsonl`.
      if (safeStat(path.join(sessionDir, "updates.jsonl"))) continue;
      candidates.push({
        id,
        sessionDir,
        folderCwd,
        historyPath,
        mtimeMs: Math.floor(stat.mtimeMs),
        size: stat.size,
      });
    }
  }
  return candidates;
}

function grokRecordFromCandidate(
  candidate: GrokCandidate,
  scopeRoots: readonly string[] | null | undefined,
): ExternalSessionDiscoveryRecord | null {
  const summaryJson = readSmallJson(path.join(candidate.sessionDir, "summary.json"));
  if (asString(summaryJson?.session_kind) === "subagent") return null;
  const info = asRecord(summaryJson?.info);
  const cwd = normalizeProviderCwd(asString(info?.cwd) ?? candidate.folderCwd);
  if (!cwdIsInScope(cwd, scopeRoots)) return null;

  const window = readJsonlWindow(candidate.historyPath, candidate.size);
  const summary = summarizeNeutralRecords("grok", {
    head: compact(window.head.map(neutralGrokRecord)),
    tail: compact(window.tail.map(neutralGrokRecord)),
    all: window.all ? compact(window.all.map(neutralGrokRecord)) : null,
  });
  // A session opened and closed without a prompt is not worth importing.
  if (!summary.hasPrompt) return null;

  // `signals.json` keeps Grok's own prompt tally; it stands in when the
  // history was too large to count.
  const signalsCount = summary.messageCount == null
    ? readSmallJson(path.join(candidate.sessionDir, "signals.json"))?.userMessageCount
    : null;
  const model = asString(summaryJson?.current_model_id);
  const updatedAt = asEpochMs(summaryJson?.last_active_at) ?? asEpochMs(summaryJson?.updated_at);

  return acpDiscoveryRecord({
    provider: "grok",
    id: asString(info?.id) ?? candidate.id,
    cwd,
    title: cleanSessionTitle(asString(summaryJson?.generated_title))
      ?? cleanSessionTitle(asString(summaryJson?.session_summary)),
    preview: summary.preview,
    messages: summary.messages,
    createdAt: asEpochMs(summaryJson?.created_at),
    updatedAt: Math.max(updatedAt ?? 0, candidate.mtimeMs) || null,
    messageCount: summary.messageCount ?? (typeof signalsCount === "number" ? signalsCount : null),
    launch: model ? { model } : null,
    filePath: candidate.historyPath,
    sourceMtimeMs: candidate.mtimeMs,
    sizeBytes: candidate.size,
  });
}

/** Lists Grok sessions from the provider's own on-disk store. */
export async function discoverGrokSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const lookupId = safeLookupId(args.sessionId);
  if (lookupId === false) return [];
  return collectNewestSessions({
    candidates: listGrokCandidates(args, lookupId),
    limit: normalizeExternalSessionLimit(args.limit),
    lookupId,
    read: (candidate) => grokRecordFromCandidate(candidate, args.scopeRoots),
  });
}
