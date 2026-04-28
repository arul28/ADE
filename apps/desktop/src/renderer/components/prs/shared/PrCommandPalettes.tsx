import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { MagnifyingGlass } from "@phosphor-icons/react";

import { COLORS, MONO_FONT } from "../../lanes/laneDesignTokens";

export type PaletteKind = "commit" | "thread" | "file";

export type PaletteCommit = { sha: string; subject: string; author: string };
export type PaletteThread = {
  id: string;
  path: string | null;
  line: number | null;
  resolved: boolean;
  firstCommentAuthor: string | null;
};
export type PaletteFile = { path: string; additions: number; deletions: number };

export type PrCommandPalettesProps = {
  open: PaletteKind | null;
  onClose: () => void;
  commits: PaletteCommit[];
  threads: PaletteThread[];
  files: PaletteFile[];
  onPickCommit: (sha: string) => void;
  onPickThread: (id: string) => void;
  onPickFile: (path: string) => void;
};

type PaletteItem = { id: string; primary: string; secondary: string };

function fuzzyMatch(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let hi = 0;
  for (let ni = 0; ni < n.length; ni += 1) {
    const ch = n[ni]!;
    while (hi < h.length && h[hi] !== ch) hi += 1;
    if (hi >= h.length) return false;
    hi += 1;
  }
  return true;
}

function paletteTitle(kind: PaletteKind): string {
  if (kind === "commit") return "Jump to commit";
  if (kind === "thread") return "Jump to review thread";
  return "Jump to file";
}

function placeholder(kind: PaletteKind): string {
  if (kind === "commit") return "Search commits by SHA, subject, author…";
  if (kind === "thread") return "Search review threads by path, author, excerpt…";
  return "Search files in this PR…";
}

function buildItems(
  kind: PaletteKind,
  commits: PaletteCommit[],
  threads: PaletteThread[],
  files: PaletteFile[],
): PaletteItem[] {
  if (kind === "commit") {
    return commits.map((c) => ({
      id: c.sha,
      primary: c.subject,
      secondary: `${c.sha.slice(0, 7)} · ${c.author}`,
    }));
  }
  if (kind === "thread") {
    return threads.map((t) => ({
      id: t.id,
      primary:
        (t.path ?? "(no file)") +
        (t.line != null ? `:${t.line}` : "") +
        (t.resolved ? " · resolved" : ""),
      secondary: t.firstCommentAuthor ?? "unknown",
    }));
  }
  return files.map((f) => ({
    id: f.path,
    primary: f.path,
    secondary: `+${f.additions} −${f.deletions}`,
  }));
}

export const PrCommandPalettes = memo(function PrCommandPalettes({
  open,
  onClose,
  commits,
  threads,
  files,
  onPickCommit,
  onPickThread,
  onPickFile,
}: PrCommandPalettesProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    setQuery("");
    setSelectedIdx(0);
  }, [open]);

  const items = useMemo(() => {
    if (!open) return [];
    return buildItems(open, commits, threads, files);
  }, [open, commits, threads, files]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return items;
    return items.filter(
      (item) => fuzzyMatch(item.primary, q) || fuzzyMatch(item.secondary, q),
    );
  }, [items, query]);

  useEffect(() => {
    if (selectedIdx >= filtered.length) {
      setSelectedIdx(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIdx]);

  const pick = useCallback(
    (id: string) => {
      if (!open) return;
      if (open === "commit") onPickCommit(id);
      else if (open === "thread") onPickThread(id);
      else onPickFile(id);
      onClose();
    },
    [open, onClose, onPickCommit, onPickThread, onPickFile],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIdx((prev) => (filtered.length === 0 ? 0 : (prev + 1) % filtered.length));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIdx((prev) =>
          filtered.length === 0 ? 0 : (prev - 1 + filtered.length) % filtered.length,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        const item = filtered[selectedIdx];
        if (item) pick(item.id);
      }
    },
    [filtered, selectedIdx, pick],
  );

  useEffect(() => {
    if (!listRef.current) return;
    const rows = listRef.current.querySelectorAll<HTMLLIElement>("[data-palette-row]");
    const row = rows[selectedIdx];
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx]);

  return (
    <Dialog.Root
      open={open !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0"
          style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" }}
        />
        <Dialog.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="fixed left-1/2 top-[16%] flex w-[520px] max-w-[90vw] -translate-x-1/2 flex-col outline-none"
          style={{
            background: COLORS.cardBgSolid,
            border: `1px solid ${COLORS.border}`,
            boxShadow: "0 24px 48px -12px rgba(0,0,0,0.6)",
          }}
          aria-label={open ? paletteTitle(open) : undefined}
        >
          <Dialog.Title className="sr-only">
            {open ? paletteTitle(open) : "Command palette"}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Type to fuzzy-search. Press Enter to select, Esc to dismiss.
          </Dialog.Description>

          <div
            className="flex items-center gap-2 px-3"
            style={{
              borderBottom: `1px solid ${COLORS.border}`,
              background: COLORS.recessedBg,
            }}
          >
            <MagnifyingGlass size={14} weight="regular" style={{ color: COLORS.textMuted }} />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIdx(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={open ? placeholder(open) : ""}
              className="h-10 w-full bg-transparent text-[13px] outline-none"
              style={{
                color: COLORS.textPrimary,
                fontFamily: MONO_FONT,
              }}
              data-testid="pr-command-palette-input"
            />
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div
                className="px-3 py-6 text-[12px]"
                style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
              >
                No matches.
              </div>
            ) : (
              <ul ref={listRef} data-testid="pr-command-palette-list">
                {filtered.map((item, idx) => {
                  const selected = idx === selectedIdx;
                  return (
                    <li key={item.id} data-palette-row data-palette-id={item.id}>
                      <button
                        type="button"
                        onClick={() => pick(item.id)}
                        onMouseEnter={() => setSelectedIdx(idx)}
                        className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors"
                        style={
                          selected
                            ? {
                                background: COLORS.accentSubtle,
                                borderLeft: `3px solid ${COLORS.accent}`,
                                paddingLeft: 9,
                              }
                            : {
                                borderLeft: "3px solid transparent",
                                paddingLeft: 9,
                              }
                        }
                        aria-current={selected ? "true" : undefined}
                      >
                        <span
                          className="max-w-full truncate text-[12px]"
                          style={{ color: COLORS.textPrimary }}
                        >
                          {item.primary}
                        </span>
                        <span
                          className="max-w-full truncate text-[10px]"
                          style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}
                        >
                          {item.secondary}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
});

export default PrCommandPalettes;
