import path from "node:path";
import { grokConfigHome } from "../shared/providerConfigHomes";
import { isGrokContextBlock } from "./events/grok";
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
  type ExternalSessionConfigHome,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";
import { adeHarnessConfigHomes, uniqueByPath } from "./adeConfigHomes";
import {
  acpDiscoveryRecord,
  collectNewestSessions,
  compact,
  neutralRecord,
  readJsonlWindow,
  safeLookupId,
  readSmallJson,
  startsWithAdeGuidance,
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
 * Three kinds of session are not the user's own TUI work and are left out:
 * `session_kind: "subagent"` children; `session_kind: "headless"` one-shot
 * runs (`grok --single`, which is how ADE runs its naming and metadata
 * tasks); and sessions whose first prompt opens with ADE's guidance block
 * (ADE's own Grok chats, as for Qwen and Kimi). A live ADE chat is also
 * hidden by its chat ref (`acpSessionId`).
 *
 * `updates.jsonl` used to mark an ACP client, but Grok 1.0.46 writes it from
 * its own terminal UI too (verified on a session ADE launched in a terminal,
 * 2026-11-13), so it no longer tells ADE's chats apart from the user's work.
 */
function grokSessionsDir(args: ExternalSessionDiscoveryArgs): string {
  return path.join(grokConfigHome({ env: args.env ?? process.env, homeDir: resolveHomeDir(args) }), "sessions");
}

/**
 * The default `sessions` folder, then the one in each preset and route home
 * ADE runs Grok on (`GROK_HOME` names the config folder itself).
 */
function grokSessionStores(
  args: ExternalSessionDiscoveryArgs,
): Array<{ sessionsDir: string; configHome: ExternalSessionConfigHome | null }> {
  const stores: Array<{ sessionsDir: string; configHome: ExternalSessionConfigHome | null }> = [
    { sessionsDir: grokSessionsDir(args), configHome: null },
    ...adeHarnessConfigHomes("grok", args).map((configHome) => ({
      sessionsDir: path.join(configHome.dir, "sessions"),
      configHome,
    })),
  ];
  return uniqueByPath(stores, (store) => store.sessionsDir);
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
  configHome: ExternalSessionConfigHome | null;
};

function listGrokCandidates(args: ExternalSessionDiscoveryArgs, lookupId: string | null): GrokCandidate[] {
  const candidates: GrokCandidate[] = [];
  for (const { sessionsDir, configHome } of grokSessionStores(args)) {
    candidates.push(...listGrokStoreCandidates(args, sessionsDir, configHome, lookupId));
  }
  return candidates;
}

function listGrokStoreCandidates(
  args: ExternalSessionDiscoveryArgs,
  sessionsDir: string,
  configHome: ExternalSessionConfigHome | null,
  lookupId: string | null,
): GrokCandidate[] {
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
      candidates.push({
        id,
        sessionDir,
        folderCwd,
        historyPath,
        mtimeMs: Math.floor(stat.mtimeMs),
        size: stat.size,
        configHome,
      });
    }
  }
  return candidates;
}

function grokRecordFromCandidate(
  candidate: GrokCandidate,
  scopeRoots: readonly string[] | null | undefined,
  includeAdeOwned = false,
): ExternalSessionDiscoveryRecord | null {
  const summaryJson = readSmallJson(path.join(candidate.sessionDir, "summary.json"));
  const sessionKind = asString(summaryJson?.session_kind);
  if (sessionKind === "subagent" || sessionKind === "headless") return null;
  const info = asRecord(summaryJson?.info);
  const cwd = normalizeProviderCwd(asString(info?.cwd) ?? candidate.folderCwd);
  if (!cwdIsInScope(cwd, scopeRoots)) return null;

  const window = readJsonlWindow(candidate.historyPath, candidate.size);
  const head = compact(window.head.map(neutralGrokRecord));
  const firstUser = head.find((record) => record.type === "user");
  if (!includeAdeOwned && startsWithAdeGuidance(firstUser?.message.content)) return null;
  const summary = summarizeNeutralRecords("grok", {
    head,
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

  const record = acpDiscoveryRecord({
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
  // The ADE home the session lives in, so an import resumes it there.
  if (candidate.configHome) record.configHome = candidate.configHome;
  return record;
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
    read: (candidate) => grokRecordFromCandidate(candidate, args.scopeRoots, args.includeAdeOwned === true),
  });
}
