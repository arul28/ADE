import { formatBytes } from "./formatting";
import { ARCHIVE_ITEM_KINDS, type ArchiveItemKind, type ArchiveSummary } from "./types/archive";

/**
 * Archive rules and words shared by every surface — the archive service, the
 * Settings page, the weekly reminder, ADE Code and `ade archive` — so "stale"
 * and "3 lanes" mean the same thing everywhere.
 */

const DAY_MS = 86_400_000;

/** Ask at most this often per project, whatever the answer was. */
export const ARCHIVE_REMINDER_INTERVAL_MS = 7 * DAY_MS;

const KIND_WORDS: Record<ArchiveItemKind, [string, string]> = {
  lane: ["lane", "lanes"],
  chat: ["chat", "chats"],
  shell: ["shell", "shells"],
};

export function emptyArchiveCounts(): Record<ArchiveItemKind, number> {
  return { lane: 0, chat: 0, shell: 0 };
}

/** "1 lane", "3 chats". */
export function archiveCountLabel(kind: ArchiveItemKind, count: number): string {
  return `${count} ${KIND_WORDS[kind][count === 1 ? 0 : 1]}`;
}

/** The plural noun alone ("lanes"), for headings like "No archived lanes". */
export function archiveKindPlural(kind: ArchiveItemKind): string {
  return KIND_WORDS[kind][1];
}

/** ["2 lanes", "1 chat"] — kinds with none left out, in canonical order. */
export function archiveKindCountParts(counts: Record<ArchiveItemKind, number>): string[] {
  return ARCHIVE_ITEM_KINDS.filter((kind) => counts[kind] > 0).map((kind) => archiveCountLabel(kind, counts[kind]));
}

/** Archived at least `days` days before `nowMs`. An unparseable date is never stale. */
export function isArchiveStale(archivedAt: string, days: number, nowMs: number = Date.now()): boolean {
  const archivedMs = Date.parse(archivedAt);
  return Number.isFinite(archivedMs) && archivedMs <= nowMs - days * DAY_MS;
}

/** "3 lanes and 12 chats (2.1 GB) archived for over 14 days — clean up?" */
export function archiveReminderTitle(summary: ArchiveSummary): string {
  const parts = archiveKindCountParts(summary.staleByKind);
  const what = parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : parts[0] ?? "Nothing";
  const size = summary.staleBytes && summary.staleBytes > 0 ? ` (${formatBytes(summary.staleBytes)})` : "";
  return `${what}${size} archived for over ${summary.olderThanDays} days — clean up?`;
}
