import React, { useCallback, useEffect, useRef, useState } from "react";
import { Archive, MagnifyingGlass, PushPin } from "@phosphor-icons/react";
import type {
  CtoArchiveEntry,
  CtoArchiveKind,
  CtoArchivePage,
  CtoRecallArchivedArgs,
  OpenProjectBinding,
} from "../../../shared/types";
import { formatDate, ipcErrorMessage } from "../../lib/format";
import { cn } from "../ui/cn";
import { CtoEmptyLine } from "./ctoSettingsUi";

type Filter = "all" | "note" | "fact" | "discovery" | "story";

const FILTERS: Array<{ id: Filter; label: string; kinds: CtoArchiveKind[] }> = [
  { id: "all", label: "All", kinds: [] },
  { id: "note", label: "Notes", kinds: ["note"] },
  { id: "fact", label: "Facts", kinds: ["fact", "decision"] },
  { id: "discovery", label: "Discoveries", kinds: ["discovery"] },
  { id: "story", label: "Story", kinds: ["story"] },
];

const KIND_LABEL: Record<CtoArchiveKind, string> = {
  note: "Note",
  fact: "Fact",
  decision: "Decision",
  discovery: "Discovery",
  story: "Story version",
};

const REASON_LABEL: Record<string, string> = {
  cold: "Moved out when notes filled up",
  replaced: "Replaced",
  forgotten: "Forgotten",
  drained: "Read by the CTO",
  evicted: "Older than the queue keeps",
  imported: "From the queue",
};

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;

function metaLine(entry: CtoArchiveEntry): string {
  const parts: string[] = [];
  if (entry.kind === "note") {
    parts.push(entry.scope === "user" ? "About you" : "Project");
    if (entry.reason) parts.push(REASON_LABEL[entry.reason] ?? entry.reason);
  } else if (entry.sourceLabel) {
    parts.push(entry.sourceLabel);
  }
  const when = entry.sourceAt ?? entry.archivedAt;
  if (when) parts.push(formatDate(when, ""));
  return parts.filter(Boolean).join(" · ");
}

/**
 * Settings › Memory › Archive: what left the pinned notes, the facts story
 * folds pulled from past turns, drained discoveries and every story version,
 * read from the CTO's home machine. A note, fact or discovery can be pinned
 * again; a story version opens in full.
 *
 * `refreshKey` changes when the notes do (a CTO turn, a recall), so the list
 * re-reads what moved.
 */
export function CtoArchiveList({
  pin,
  refreshKey,
  onRecall,
}: {
  pin: OpenProjectBinding | null;
  refreshKey: string;
  onRecall: (args: CtoRecallArchivedArgs) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState<CtoArchivePage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<number, string>>({});
  const pinRef = useRef(pin);
  pinRef.current = pin;
  /** Drops an answer to an older query, filter or machine. */
  const generationRef = useRef(0);

  const kinds = FILTERS.find((entry) => entry.id === filter)?.kinds ?? [];
  const kindsKey = kinds.join(",");

  const load = useCallback(async (before?: number) => {
    const target = pinRef.current;
    const bridge = window.ade?.cto;
    if (!target || !bridge?.searchMemoryArchive) return;
    const generation = before ? generationRef.current : ++generationRef.current;
    try {
      const next = await bridge.searchMemoryArchive({
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(kindsKey ? { kinds: kindsKey.split(",") as CtoArchiveKind[] } : {}),
        limit: PAGE_SIZE,
        ...(before ? { before } : {}),
      }, target);
      if (generation !== generationRef.current) return;
      setPage((current) => (before && current ? { ...next, entries: [...current.entries, ...next.entries] } : next));
      setError(null);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(ipcErrorMessage(err) || "Couldn't read the archive.");
    }
  }, [query, kindsKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // Keyed on the pin's key: a rebuilt pin for the same machine reloads nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, pin?.key, refreshKey]);

  const recall = async (entry: CtoArchiveEntry) => {
    setBusyId(entry.id);
    setError(null);
    try {
      await onRecall({ id: entry.id });
    } catch (err) {
      setError(ipcErrorMessage(err) || "Couldn't pin it.");
    } finally {
      setBusyId(null);
    }
  };

  const openStory = async (entry: CtoArchiveEntry) => {
    if (expanded[entry.id] != null) {
      setExpanded(({ [entry.id]: _closed, ...rest }) => rest);
      return;
    }
    const target = pinRef.current;
    if (!target || !entry.truncated) {
      setExpanded((current) => ({ ...current, [entry.id]: entry.text }));
      return;
    }
    try {
      const full = await window.ade.cto!.searchMemoryArchive({ id: entry.id }, target);
      setExpanded((current) => ({ ...current, [entry.id]: full.entries[0]?.text ?? entry.text }));
    } catch (err) {
      setError(ipcErrorMessage(err) || "Couldn't open that version.");
    }
  };

  if (page && !page.available) {
    return <CtoEmptyLine icon={<Archive size={14} />}>No archive on this machine</CtoEmptyLine>;
  }

  const counts = page?.counts;
  const countFor = (entry: (typeof FILTERS)[number]): number | null => {
    if (!counts) return null;
    const list = entry.kinds.length ? entry.kinds : (Object.keys(counts) as CtoArchiveKind[]);
    return list.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" style={{ padding: 8 }}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="relative flex min-w-[180px] flex-1 items-center">
          <MagnifyingGlass size={13} className="pointer-events-none absolute left-2 text-[var(--kit-text-3)]" aria-hidden />
          <input
            className="kit-input w-full"
            data-size="sm"
            style={{ paddingLeft: 26 }}
            value={query}
            placeholder="Search the archive"
            aria-label="Search the archive"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="kit-seg max-w-full overflow-x-auto" data-case="sentence" role="group" aria-label="Show">
          {FILTERS.map((entry) => {
            const count = countFor(entry);
            return (
              <button key={entry.id} type="button" aria-pressed={filter === entry.id} onClick={() => setFilter(entry.id)}>
                {entry.label}
                {count ? <span className="kit-num ml-1 text-[var(--kit-text-3)]">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {error ? <CtoEmptyLine tone="crit">{error}</CtoEmptyLine> : null}

      {!page ? (
        <CtoEmptyLine icon={<Archive size={14} />}>Loading…</CtoEmptyLine>
      ) : page.entries.length === 0 ? (
        <CtoEmptyLine
          icon={<Archive size={14} />}
          hint="Notes move here when the notes fill up. Facts from past turns, read discoveries and every story version land here too."
        >
          {query.trim() ? "No matches" : "Nothing archived yet"}
        </CtoEmptyLine>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {page.entries.map((entry) => {
            const full = expanded[entry.id];
            const isStory = entry.kind === "story";
            return (
              <li
                key={entry.id}
                className={cn(
                  "group flex min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--kit-hover)]",
                  busyId === entry.id && "opacity-60",
                )}
              >
                <span className="kit-tag mt-px shrink-0" data-tone={entry.kind === "decision" ? "accent" : undefined}>
                  {KIND_LABEL[entry.kind]}
                </span>
                <div className="min-w-0 flex-1">
                  {isStory ? (
                    <button
                      type="button"
                      className="block w-full text-left"
                      aria-expanded={full != null}
                      onClick={() => void openStory(entry)}
                    >
                      <span className={cn("block whitespace-pre-wrap text-[12.5px] leading-[18px] text-fg", full == null && "line-clamp-2")}>
                        {full ?? entry.text}
                      </span>
                    </button>
                  ) : (
                    <span className="block text-[12.5px] leading-[18px] text-fg line-clamp-3" title={entry.text}>
                      {entry.text}
                    </span>
                  )}
                  <span className="block truncate text-[11px] leading-[16px] text-[var(--kit-text-3)]">{metaLine(entry)}</span>
                </div>
                {!isStory ? (
                  <button
                    type="button"
                    className="kit-btn kit-btn-ghost shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    data-size="xs"
                    disabled={busyId != null}
                    aria-label={`Pin "${entry.text}" to the notes`}
                    title="Pin to the notes"
                    onClick={() => void recall(entry)}
                  >
                    <PushPin size={11} />
                    Pin
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {page?.nextBefore ? (
        <button
          type="button"
          className="kit-btn kit-btn-ghost self-start"
          data-size="sm"
          disabled={loadingMore}
          onClick={async () => {
            setLoadingMore(true);
            await load(page.nextBefore ?? undefined);
            setLoadingMore(false);
          }}
        >
          {loadingMore ? "Loading…" : "Show older"}
        </button>
      ) : null}
    </div>
  );
}
