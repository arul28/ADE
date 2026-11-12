import path from "node:path";
import {
  antigravityConversationsDir,
  readAntigravityConversationMeta,
  readAntigravityMessageWindow,
} from "../chat/acpHost/acpDialects/antigravitySessionLog";
import {
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
  safeLookupId,
  startsWithAdeGuidance,
  summarizeNeutralRecords,
} from "./discoverAcpShared";

/**
 * Antigravity's agy CLI (verified 1.5.6) keeps every conversation, from its
 * TUI or from an ACP client, in one SQLite file:
 * `~/.gemini/antigravity-cli/conversations/<conversationId>.db`, with its
 * write-ahead log beside it while agy has it open. `antigravitySessionLog.ts`
 * reads the format.
 *
 * Left out: a subagent's conversation (it opens with its parent's message),
 * and a conversation ADE's own chat opened (its system prompt is ADE's
 * guidance). A live ADE chat is also matched by its session id.
 */
function antigravityCliDirFor(args: ExternalSessionDiscoveryArgs): string {
  return path.join(resolveHomeDir(args), ".gemini", "antigravity-cli");
}

type AntigravityCandidate = {
  id: string;
  file: string;
  mtimeMs: number;
  size: number;
};

function listAntigravityCandidates(args: ExternalSessionDiscoveryArgs, lookupId: string | null): AntigravityCandidate[] {
  const dir = antigravityConversationsDir(antigravityCliDirFor(args));
  const names = lookupId ? [`${lookupId}.db`] : safeReadDir(dir).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const candidates: AntigravityCandidate[] = [];
  for (const name of names) {
    const match = /^([\w-]+)\.db$/u.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    const stat = safeStat(file);
    if (!stat?.isFile()) continue;
    // While agy has a conversation open, its newest steps are in the WAL.
    const wal = safeStat(`${file}-wal`);
    candidates.push({
      id: match[1]!,
      file,
      mtimeMs: Math.floor(Math.max(stat.mtimeMs, wal?.mtimeMs ?? 0)),
      size: stat.size + (wal?.size ?? 0),
    });
  }
  return candidates;
}

function antigravityRecordFromCandidate(
  candidate: AntigravityCandidate,
  scopeRoots: readonly string[] | null | undefined,
  includeAdeOwned: boolean,
): ExternalSessionDiscoveryRecord | null {
  const meta = readAntigravityConversationMeta(candidate.file);
  if (!meta || meta.isSubagent) return null;
  if (!includeAdeOwned && startsWithAdeGuidance(meta.systemPrompt)) return null;
  const cwd = normalizeProviderCwd(meta.workspace);
  if (!cwdIsInScope(cwd, scopeRoots)) return null;

  const window = readAntigravityMessageWindow(candidate.file);
  if (!window) return null;
  const toNeutral = (steps: typeof window.head) => compact(steps.map((step) => (step.kind === "user"
    ? neutralRecord("user", step.text, null)
    : neutralRecord("assistant", step.text, null))));
  const head = toNeutral(window.head);
  // The whole conversation fit in the window: every count below is exact.
  const complete = window.userMessageCount <= window.head.filter((step) => step.kind === "user").length;
  const summary = summarizeNeutralRecords("antigravity", {
    head,
    tail: toNeutral(window.tail),
    all: complete ? head : null,
  });
  if (!summary.hasPrompt) return null;

  return acpDiscoveryRecord({
    provider: "antigravity",
    id: candidate.id,
    cwd,
    title: null,
    preview: summary.preview,
    messages: summary.messages,
    createdAt: meta.createdAtMs,
    updatedAt: candidate.mtimeMs || null,
    messageCount: window.userMessageCount,
    launch: null,
    filePath: candidate.file,
    sourceMtimeMs: candidate.mtimeMs,
    sizeBytes: candidate.size,
  });
}

/** Lists agy conversations from the CLI's own on-disk store. */
export async function discoverAntigravitySessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const lookupId = safeLookupId(args.sessionId);
  if (lookupId === false) return [];
  return collectNewestSessions({
    candidates: listAntigravityCandidates(args, lookupId),
    limit: normalizeExternalSessionLimit(args.limit),
    lookupId,
    read: (candidate) => antigravityRecordFromCandidate(candidate, args.scopeRoots, args.includeAdeOwned === true),
  });
}
