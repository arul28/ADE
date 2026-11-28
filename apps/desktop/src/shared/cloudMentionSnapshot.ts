import { CHAT_MENTION_KINDS, isChatMentionId, rankChatMentionMenu } from "./chatMentions";
import { rankQuickOpenPaths } from "./quickOpenScore";
import type { FilesQuickOpenItem } from "./types/files";
import type { ChatMentionKind, ChatMentionSuggestion } from "./types/chatMentions";

/**
 * The `@` menu of an ADE Cloud computer, saved when it goes to rest, so the
 * menu of one of its chats reads the same asleep as awake (README, "The @
 * menu while a computer rests").
 *
 * Awake, the computer answers the menu itself: each kind's candidates
 * (`chatMentionService` builders) ranked by `rankChatMentionMenu`, and files
 * from its index ranked by `rankQuickOpenPaths`. Asleep it can't be asked (a
 * read never wakes it), so before it sleeps it saves those same candidates
 * and each lane's file names to the account (`/cloud/mentions`), sealed like
 * its saved chats and Git summaries. A client then answers each query from
 * the saved copy with the same two rankers. Machines are the one kind not
 * saved: they come live from the account, as the computer's own menu reads
 * them.
 */

export const CLOUD_MENTION_SNAPSHOT_VERSION = 1;
/** The saved copy as JSON, before sealing. File names fill what rows leave. */
export const CLOUD_MENTION_SNAPSHOT_MAX_BYTES = 900_000;
/** Rows kept per kind: far past what a menu ranks from, short of a runaway roster. */
export const CLOUD_MENTION_SNAPSHOT_MAX_ROWS_PER_KIND = 500;
const MAX_ID = 300;
const MAX_LABEL = 300;
const MAX_PATH = 1_000;
const MAX_LANES = 20;

export type CloudMentionSnapshotFiles = {
  files: string[];
  directories: string[];
  /** The lane has more files than were saved: the shallowest are kept, as an empty query browses. */
  truncated: boolean;
};

export type CloudMentionSnapshot = {
  version: typeof CLOUD_MENTION_SNAPSHOT_VERSION;
  savedAt: number;
  /** Every kind's candidates but machines, as the computer's menu builds them. */
  rows: ChatMentionSuggestion[];
  /** File and folder names by lane id, as its file index lists them. */
  files: Record<string, CloudMentionSnapshotFiles>;
};

const SAVED_KINDS: ReadonlySet<ChatMentionKind> = new Set(CHAT_MENTION_KINDS.filter((kind) => kind !== "machine"));

const label = (value: unknown, max = MAX_LABEL): string | null =>
  typeof value === "string" && value.trim() ? value.slice(0, max) : null;
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function readRow(value: unknown): ChatMentionSuggestion | null {
  const row = record(value);
  const kind = row?.kind;
  if (!row || typeof kind !== "string" || !SAVED_KINDS.has(kind as ChatMentionKind)) return null;
  const id = label(row.id, MAX_ID);
  const title = label(row.title);
  if (!id || !title || (kind !== "person" && kind !== "mcp" && !isChatMentionId(id))) return null;
  const out: ChatMentionSuggestion = { kind: kind as ChatMentionKind, id, title };
  const subtitle = label(row.subtitle);
  if (subtitle) out.subtitle = subtitle;
  const at = finite(row.lastActivityAt);
  if (at != null) out.lastActivityAt = at;
  const pr = record(row.pr);
  if (kind === "pr" && pr && finite(pr.number) != null && typeof pr.state === "string" && typeof pr.checks === "string") {
    out.pr = { number: pr.number as number, state: pr.state as never, checks: pr.checks as never };
  }
  const person = record(row.person);
  if (kind === "person" && person && (person.source === "linear" || person.source === "github")) {
    out.person = { source: person.source, handle: label(person.handle) };
  }
  const mcp = record(row.mcp);
  if (kind === "mcp" && mcp && typeof mcp.state === "string" && typeof mcp.transport === "string") {
    out.mcp = {
      state: mcp.state,
      transport: mcp.transport,
      toolNames: Array.isArray(mcp.toolNames) ? mcp.toolNames.filter((name): name is string => typeof name === "string").slice(0, 32) : [],
      ...(finite(mcp.toolCount) != null ? { toolCount: mcp.toolCount as number } : {}),
      lastError: label(mcp.lastError),
      ...(finite(mcp.lastErrorAt) != null ? { lastErrorAt: mcp.lastErrorAt as number } : {}),
    };
  }
  return out;
}

const readPaths = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((path): path is string => typeof path === "string" && path.length > 0 && path.length <= MAX_PATH) : [];

/** A saved copy as stored or received, or null when it isn't one. Unknown fields and bad rows are dropped. */
export function readCloudMentionSnapshot(value: unknown): CloudMentionSnapshot | null {
  const input = record(value);
  if (!input || input.version !== CLOUD_MENTION_SNAPSHOT_VERSION) return null;
  const savedAt = finite(input.savedAt);
  if (savedAt == null || !Array.isArray(input.rows)) return null;
  const perKind = new Map<string, number>();
  const rows: ChatMentionSuggestion[] = [];
  for (const raw of input.rows) {
    const row = readRow(raw);
    if (!row) continue;
    const seen = perKind.get(row.kind) ?? 0;
    if (seen >= CLOUD_MENTION_SNAPSHOT_MAX_ROWS_PER_KIND) continue;
    perKind.set(row.kind, seen + 1);
    rows.push(row);
  }
  const files: Record<string, CloudMentionSnapshotFiles> = {};
  for (const [laneId, entry] of Object.entries(record(input.files) ?? {}).slice(0, MAX_LANES)) {
    const lane = record(entry);
    if (!lane || !isChatMentionId(laneId)) continue;
    files[laneId] = { files: readPaths(lane.files), directories: readPaths(lane.directories), truncated: lane.truncated === true };
  }
  return { version: CLOUD_MENTION_SNAPSHOT_VERSION, savedAt, rows, files };
}

/**
 * The copy a computer saves: its rows (capped per kind) and each lane's file
 * names in browse order (shallowest first, folders with them), cut to fit
 * `CLOUD_MENTION_SNAPSHOT_MAX_BYTES`.
 */
export function buildCloudMentionSnapshot(args: {
  savedAt: number;
  rows: ChatMentionSuggestion[];
  /** By lane id; each list already in browse order (`quickOpen` with an empty query). */
  files: Record<string, FilesQuickOpenItem[]>;
}): CloudMentionSnapshot {
  const base = readCloudMentionSnapshot({ version: CLOUD_MENTION_SNAPSHOT_VERSION, savedAt: args.savedAt, rows: args.rows, files: {} });
  const snapshot: CloudMentionSnapshot = base ?? { version: CLOUD_MENTION_SNAPSHOT_VERSION, savedAt: args.savedAt, rows: [], files: {} };
  let budget = CLOUD_MENTION_SNAPSHOT_MAX_BYTES - JSON.stringify(snapshot).length;
  const lanes = Object.entries(args.files).filter(([laneId]) => isChatMentionId(laneId)).slice(0, MAX_LANES);
  // An even share per lane first, so one huge lane can't leave the others empty.
  const share = lanes.length ? Math.floor(budget / lanes.length) : 0;
  for (const [laneId, items] of lanes) {
    const entry: CloudMentionSnapshotFiles = { files: [], directories: [], truncated: false };
    let used = 64;
    for (const item of items) {
      if (!item.path || item.path.length > MAX_PATH) continue;
      const cost = item.path.length + 4;
      if (used + cost > share) {
        entry.truncated = true;
        break;
      }
      used += cost;
      (item.isDirectory ? entry.directories : entry.files).push(item.path);
    }
    snapshot.files[laneId] = entry;
    budget -= used;
  }
  return snapshot;
}

/**
 * The menu's entity rows for one query from a saved copy: the copy's rows
 * (the chat itself left out) and the account's machines, ranked as the
 * computer ranks its own menu.
 */
export function cloudMentionSnapshotRows(
  snapshot: Pick<CloudMentionSnapshot, "rows">,
  args: { query: string; excludeSessionId: string | null; machines: ChatMentionSuggestion[] },
): ChatMentionSuggestion[] {
  const byKind = new Map<ChatMentionKind, ChatMentionSuggestion[]>();
  for (const row of snapshot.rows) {
    if (row.kind === "machine" || (row.kind === "chat" && row.id === args.excludeSessionId)) continue;
    const list = byKind.get(row.kind) ?? [];
    list.push(row);
    byKind.set(row.kind, list);
  }
  if (args.machines.length) byKind.set("machine", args.machines.filter((row) => row.kind === "machine"));
  return rankChatMentionMenu([...byKind.values()], args.query.trim());
}

/** One lane's files for a composer `@` query from a saved copy, as `quickOpen` ranks them. */
export function cloudMentionSnapshotFiles(
  snapshot: Pick<CloudMentionSnapshot, "files">,
  args: { laneId: string; query: string; limit: number; includeDirectories?: boolean },
): FilesQuickOpenItem[] {
  const lane = snapshot.files[args.laneId];
  if (!lane) return [];
  return rankQuickOpenPaths({
    files: lane.files,
    directories: lane.directories,
    query: args.query,
    limit: args.limit,
    allowComposerPrefixFallback: true,
    includeDirectories: args.includeDirectories,
  });
}
