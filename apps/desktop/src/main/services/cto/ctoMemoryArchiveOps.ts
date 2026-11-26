/**
 * The archive side of the CTO's memory (`ctoMemoryService.ts`): what goes in
 * (story facts, drained discoveries, the files from before the archive),
 * search and recall, and what the account copy carries
 * (`ctoAccountCopyService.ts`). The SQL lives in `ctoMemoryArchive.ts`.
 */

import {
  emptyCtoArchivePage,
  type CtoArchivePage,
  type CtoArchiveQuery,
  type CtoNotesScope,
  type CtoRecallArchivedArgs,
} from "../../../shared/types/cto";
import { AdeExpectedError } from "../../../shared/expectedError";
import { nowIso } from "../shared/utils";
import type { CtoStoryRecord } from "./ctoStory";
import {
  ctoNoteKey,
  type CtoArchiveCarriedRow,
  type CtoArchiveRecord,
  type CtoMemoryArchive,
  type CtoNoteHeatRow,
} from "./ctoMemoryArchive";
import type { CtoRememberResult } from "./ctoMemoryService";

/** One fact or decision a story fold pulled out (`ctoStory.ts` `splitCtoStoryAnswer`). */
export type CtoStoryFactRecord = {
  kind: "fact" | "decision";
  text: string;
  sourceAt: string | null;
  sourceLabel: string | null;
  sourceSessionId: string | null;
};

const ARCHIVE_IMPORTED_META = "importedFiles";

/** A discovery line (`- <iso> fact [tags]`) as an archive entry. */
function discoveryRecord(line: string, reason: string): CtoArchiveRecord | null {
  const body = line.trim().replace(/^-\s+/, "");
  if (!body) return null;
  const stamped = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(.+)$/.exec(body);
  return {
    kind: "discovery",
    text: stamped ? stamped[2]! : body,
    reason,
    sourceAt: stamped ? stamped[1]! : null,
    sourceLabel: "Worker discovery",
  };
}

export function discoveryRecords(lines: readonly string[], reason: string): CtoArchiveRecord[] {
  return lines.flatMap((line) => {
    const record = line.trim().startsWith("- ") ? discoveryRecord(line, reason) : null;
    return record ? [record] : [];
  });
}

/** The order pinned notes leave in: never-touched first (oldest line first), then least recently used. */
export function coldestFirst(lines: readonly string[], heat: ReadonlyMap<string, string>, keep: ReadonlySet<number>): number[] {
  return lines
    .map((line, index) => ({ index, at: heat.get(ctoNoteKey(line)) ?? null }))
    .filter((candidate) => !keep.has(candidate.index))
    .sort((a, b) => {
      if (a.at === b.at) return a.index - b.index;
      if (a.at == null) return -1;
      if (b.at == null) return 1;
      return a.at.localeCompare(b.at);
    })
    .map((candidate) => candidate.index);
}

export function createCtoMemoryArchiveOps(args: {
  archive: CtoMemoryArchive | null;
  /** The discovery files and the story as they are on disk, for the one-time import. */
  readFilesBeforeArchive: () => { evictedDiscoveries: string; discoveries: string; story: CtoStoryRecord | null };
  readNoteLines: (scope: CtoNotesScope) => string[];
  remember: (input: { note: string; scope?: CtoNotesScope }) => CtoRememberResult;
}) {
  const { archive } = args;

  /**
   * Once per archive: the discovery files and the story written before it
   * existed. Lazy, so no boot pays for it. Marked done only when the rows are
   * in, so a failed import runs again.
   */
  const ensureImported = (): void => {
    if (!archive?.available() || archive.readMeta(ARCHIVE_IMPORTED_META)) return;
    const files = args.readFilesBeforeArchive();
    const records: CtoArchiveRecord[] = [
      ...discoveryRecords(files.evictedDiscoveries.split(/\r?\n/), "evicted"),
      ...discoveryRecords(files.discoveries.split(/\r?\n/), "imported"),
    ];
    if (files.story?.summary.trim()) {
      records.push({ kind: "story", text: files.story.summary, sourceAt: files.story.coveredThrough, sourceLabel: files.story.model });
    }
    if (archive.addMany(records) == null) return;
    archive.writeMeta(ARCHIVE_IMPORTED_META, nowIso());
  };

  const searchArchive = (query: CtoArchiveQuery = {}): CtoArchivePage => {
    if (!archive?.available()) return emptyCtoArchivePage();
    ensureImported();
    return archive.search(query);
  };

  /**
   * Pins an archived note, fact or discovery again, as a note. It goes through
   * `remember`, so a full notes file moves its coldest notes out to make room.
   * The entry leaves the archive only when the notes now hold its full text:
   * a note `remember` clipped, or a different note it took for the same one,
   * leaves the entry where it is.
   */
  const recallArchived = (input: CtoRecallArchivedArgs): CtoRememberResult => {
    if (!archive?.available()) return { ok: false, error: "The archive is not available on this machine." };
    const entry = archive.get(input.id);
    if (!entry) return { ok: false, error: `No archived entry has id ${input.id}.` };
    if (entry.kind === "story") {
      return { ok: false, error: "A story version can't be pinned. Put the part you need in a note with remember." };
    }
    const result = args.remember({ note: entry.text, scope: input.scope ?? entry.scope ?? "project" });
    if (result.ok && ctoNoteKey(result.saved ? result.note : result.duplicateOf) === ctoNoteKey(entry.text)) {
      archive.markPinned(entry.id);
    }
    return result;
  };

  /** The person's recall from Settings › Memory: a refusal is an error. */
  const recallArchivedForUser = (input: CtoRecallArchivedArgs): void => {
    const result = recallArchived(input);
    if (!result.ok) throw new AdeExpectedError(result.error, "user");
  };

  /**
   * Facts and decisions a story fold pulled out, with their source turns.
   * How many were new; 0 with no archive on this machine; null when the
   * archive couldn't store them (the fold then waits and runs again).
   */
  const recordStoryFacts = (facts: readonly CtoStoryFactRecord[]): number | null =>
    archive?.available() && facts.length ? archive.addMany(facts) : 0;

  /** Cheap: changes whenever `exportArchiveForCopy` could. Null with no archive. */
  const archiveStamp = (): string | null => {
    if (!archive?.available()) return null;
    ensureImported();
    return archive.changeStamp();
  };

  /**
   * What the account copy carries of the archive: every entry not pinned, and
   * the heat of the notes in the files now (so the coldest notes stay the
   * coldest on the next home). Null with no archive.
   */
  const exportArchiveForCopy = (): { rows: CtoArchiveCarriedRow[]; heat: CtoNoteHeatRow[] } | null => {
    if (!archive?.available()) return null;
    ensureImported();
    const rows = archive.exportRows();
    if (!rows) return null;
    const heat = (["project", "user"] as const).flatMap((scope) =>
      archive.exportHeat(scope, new Set(args.readNoteLines(scope).map(ctoNoteKey))));
    return { rows, heat };
  };

  /**
   * Takes in the archive another home carried, after its notes were restored.
   * Additive: an entry this machine already holds stays one entry. An entry
   * whose text is a note in the files now (recalled on the other home) leaves
   * the archive here too. False when there is no archive here or the write
   * failed.
   */
  const importArchiveFromCopy = (records: readonly CtoArchiveRecord[], heat: readonly CtoNoteHeatRow[]): boolean => {
    if (!archive?.available()) return false;
    ensureImported();
    if (records.length && archive.addMany(records) == null) return false;
    archive.markPinnedMatching(new Set((["project", "user"] as const).flatMap((scope) => args.readNoteLines(scope).map(ctoNoteKey))));
    archive.importHeat(heat);
    return true;
  };

  return {
    ensureImported,
    searchArchive,
    recallArchived,
    recallArchivedForUser,
    recordStoryFacts,
    archiveStamp,
    exportArchiveForCopy,
    importArchiveFromCopy,
    readArchiveMeta: (key: string): string | null => (archive?.available() ? archive.readMeta(key) : null),
    writeArchiveMeta: (key: string, value: string): void => {
      if (archive?.available()) archive.writeMeta(key, value);
    },
  };
}
