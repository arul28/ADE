import {
  BookmarkSimple,
  Check,
  SpinnerGap,
  Trash,
} from "@phosphor-icons/react";
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MAX_PROMPT_STASHES,
  type PromptStashEntry,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";

const STASH_SNIPPET_MAX_CHARS = 110;

export type ComposerPromptStashHandle = {
  activate: () => void;
  handleMenuKeyDown: (event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
  }) => boolean;
};

function promptSnippet(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= STASH_SNIPPET_MAX_CHARS) return normalized;
  return `${normalized.slice(0, STASH_SNIPPET_MAX_CHARS)}…`;
}

function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function providerLabel(entry: PromptStashEntry): string | null {
  const provider = entry.provider?.trim();
  if (!provider) return null;
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export const ComposerPromptStash = forwardRef<ComposerPromptStashHandle, {
  draft: string;
  provider?: string | null;
  modelId?: string | null;
  active: boolean;
  buttonVisible: boolean;
  shortcutLabel: string;
  disabled?: boolean;
  onDraftChange: (value: string) => void;
}>(function ComposerPromptStash({
  draft,
  provider,
  modelId,
  active,
  buttonVisible,
  shortcutLabel,
  disabled = false,
  onDraftChange,
}, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const operationInFlightRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const latestDraftRef = useRef(draft);
  latestDraftRef.current = draft;
  const [entries, setEntries] = useState<PromptStashEntry[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveReceiptKey, setSaveReceiptKey] = useState(0);
  const [saveReceiptVisible, setSaveReceiptVisible] = useState(false);

  const highlightedEntry = useMemo(
    () => entries.find((entry) => entry.id === highlightedId) ?? entries[0] ?? null,
    [entries, highlightedId],
  );

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const next = await window.ade.agentChat.promptStashes.list();
      if (sequence !== refreshSequenceRef.current) return;
      setEntries(next);
      setHighlightedId((current) => (
        current && next.some((entry) => entry.id === current)
          ? current
          : next[0]?.id ?? null
      ));
      setError(null);
    } catch (refreshError) {
      if (sequence !== refreshSequenceRef.current) return;
      setError(refreshError instanceof Error ? refreshError.message : "Could not load stashed prompts.");
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (!saveReceiptVisible) return;
    const timer = window.setTimeout(() => setSaveReceiptVisible(false), 900);
    return () => window.clearTimeout(timer);
  }, [saveReceiptKey, saveReceiptVisible]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [menuOpen]);

  useEffect(() => {
    if (menuOpen && draft.trim()) {
      setMenuOpen(false);
    }
  }, [draft, menuOpen]);

  useEffect(() => {
    const handleFocus = () => {
      if ((active || menuOpen) && document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [active, menuOpen, refresh]);

  const save = useCallback(async () => {
    if (disabled || operationInFlightRef.current) return;
    const savedText = latestDraftRef.current;
    if (!savedText.trim()) {
      setMenuOpen(true);
      await refresh();
      return;
    }

    operationInFlightRef.current = true;
    refreshSequenceRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      const created = await window.ade.agentChat.promptStashes.create({
        text: savedText,
        provider,
        modelId,
      });
      setEntries((current) => [
        created,
        ...current.filter((entry) => entry.id !== created.id),
      ].slice(0, MAX_PROMPT_STASHES));
      setHighlightedId(created.id);
      setSaveReceiptKey((current) => current + 1);
      setSaveReceiptVisible(true);
      setMenuOpen(false);
      // The runtime has durably accepted the stash. Only now is it safe to
      // clear the exact text that was saved. Input typed while a remote
      // runtime acknowledged the write belongs to a newer draft and stays.
      if (latestDraftRef.current === savedText) {
        onDraftChange("");
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not stash this prompt.");
      setMenuOpen(true);
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }, [disabled, modelId, onDraftChange, provider, refresh]);

  const restore = useCallback(async (entry: PromptStashEntry) => {
    if (operationInFlightRef.current) return;
    if (latestDraftRef.current.trim()) {
      setMenuOpen(false);
      return;
    }
    operationInFlightRef.current = true;
    refreshSequenceRef.current += 1;
    setBusy(true);
    setError(null);
    setEntries((current) => current.filter((candidate) => candidate.id !== entry.id));
    setHighlightedId(null);
    setMenuOpen(false);
    // Put the saved text into the composer before waiting on a remote delete.
    // The user can continue editing immediately, and the acknowledgement can
    // never overwrite those edits. A failed delete leaves a harmless duplicate
    // stash rather than losing either the stash or the in-progress prompt.
    onDraftChange(entry.text);
    try {
      const deleted = await window.ade.agentChat.promptStashes.delete({ id: entry.id });
      if (!deleted) {
        await refresh();
        setError("That stash was already restored or deleted on another desktop.");
        return;
      }
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "Could not restore this prompt.");
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }, [onDraftChange, refresh]);

  const remove = useCallback(async (entry: PromptStashEntry) => {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    refreshSequenceRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      await window.ade.agentChat.promptStashes.delete({ id: entry.id });
      setEntries((current) => current.filter((candidate) => candidate.id !== entry.id));
      setHighlightedId((current) => current === entry.id ? null : current);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete this prompt.");
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }, []);

  const handleMenuKeyDown = useCallback((event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
  }): boolean => {
    if (!menuOpen) return false;
    if (event.key === "Escape") {
      setMenuOpen(false);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!entries.length) return true;
      const currentIndex = entries.findIndex((entry) => entry.id === highlightedEntry?.id);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const base = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
      const nextIndex = (base + direction + entries.length) % entries.length;
      setHighlightedId(entries[nextIndex]?.id ?? null);
      return true;
    }
    if (event.key === "Enter" && highlightedEntry) {
      void restore(highlightedEntry);
      return true;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && highlightedEntry) {
      void remove(highlightedEntry);
      return true;
    }
    return false;
  }, [entries, highlightedEntry, menuOpen, remove, restore]);

  useImperativeHandle(ref, () => ({
    activate: () => {
      void save();
    },
    handleMenuKeyDown,
  }), [handleMenuKeyDown, save]);

  return (
    <div ref={rootRef} className={cn("relative shrink-0", buttonVisible ? "w-7" : "w-0")}>
      {buttonVisible ? (
        <SmartTooltip
          forceEnabled
          content={{
            label: draft.trim() ? "Stash prompt" : "Open stashed prompts",
            description: draft.trim()
              ? "Save this prompt across connected desktops and clear only its text."
              : `Restore a saved prompt. Press ${shortcutLabel} with text to create one.`,
            shortcut: shortcutLabel,
          }}
        >
          <button
            type="button"
            aria-label={draft.trim()
              ? "Stash prompt"
              : `Open ${entries.length} stashed prompt${entries.length === 1 ? "" : "s"}`}
            aria-expanded={menuOpen}
            disabled={disabled || busy}
            className={cn(
              "relative inline-flex h-7 w-7 items-center justify-center rounded-lg transition-[color,background-color,transform] duration-150",
              "text-muted-fg/38 hover:bg-violet-500/[0.07] hover:text-violet-200/75",
              menuOpen && "bg-violet-500/[0.09] text-violet-100/80",
              saveReceiptVisible && "text-emerald-200/80",
              "disabled:cursor-not-allowed disabled:opacity-35",
            )}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void save()}
          >
            {busy ? (
              <SpinnerGap size={14} className="animate-spin" aria-hidden />
            ) : saveReceiptVisible && !menuOpen ? (
              <Check key={saveReceiptKey} size={14} weight="bold" className="animate-in zoom-in-75 fade-in duration-150" aria-hidden />
            ) : (
              <BookmarkSimple size={14} weight={entries.length ? "fill" : "regular"} aria-hidden />
            )}
            {entries.length > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-3.5 items-center justify-center rounded-full border border-[color:var(--chat-panel-border)] bg-[var(--chat-panel-bg)] px-1 font-mono text-[8px] font-bold leading-3.5 tabular-nums text-fg/68">
                {entries.length}
              </span>
            ) : null}
          </button>
        </SmartTooltip>
      ) : null}

      {menuOpen ? (
        <div
          data-prompt-stash-menu=""
          role="dialog"
          aria-label="Stashed prompts"
          className="absolute bottom-[calc(100%+10px)] right-0 z-[80] w-[min(380px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-white/[0.09] bg-[#111116]/96 shadow-[0_24px_72px_-28px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-3.5 py-2.5">
            <div className="min-w-0">
              <div className="font-sans text-[11px] font-semibold text-fg/82">Stashed prompts</div>
              <div className="mt-0.5 font-sans text-[9.5px] text-muted-fg/42">Shared through this project’s ADE runtime</div>
            </div>
            <button
              type="button"
              className="rounded-md px-1.5 py-1 font-sans text-[10px] text-muted-fg/45 transition-colors hover:bg-white/[0.05] hover:text-fg/70"
              onClick={() => setMenuOpen(false)}
            >
              Close
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto p-1.5">
            {entries.length ? entries.map((entry) => {
              const highlighted = highlightedEntry?.id === entry.id;
              const source = providerLabel(entry);
              return (
                <div
                  key={entry.id}
                  className={cn(
                    "group flex cursor-default items-center gap-2 rounded-xl px-2.5 py-2 transition-colors",
                    highlighted ? "bg-white/[0.075]" : "hover:bg-white/[0.04]",
                  )}
                  onMouseMove={() => setHighlightedId(entry.id)}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => void restore(entry)}
                  >
                    <div className="truncate font-sans text-[11.5px] leading-5 text-fg/78">
                      {promptSnippet(entry.text)}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] text-muted-fg/38">
                      {source ? <span>{source}</span> : null}
                      {source ? <span aria-hidden>·</span> : null}
                      <span>{relativeTime(entry.createdAt)}</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete stashed prompt"
                    disabled={busy}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-fg/28 opacity-0 transition-[opacity,color,background-color] hover:bg-red-500/10 hover:text-red-300/75 focus:opacity-100 group-hover:opacity-100 disabled:opacity-30"
                    onClick={() => void remove(entry)}
                  >
                    <Trash size={12} aria-hidden />
                  </button>
                </div>
              );
            }) : (
              <div className="px-3 py-6 text-center">
                <BookmarkSimple size={18} className="mx-auto text-muted-fg/24" aria-hidden />
                <div className="mt-2 font-sans text-[11px] text-fg/55">Nothing stashed yet</div>
                <div className="mt-1 font-sans text-[10px] leading-4 text-muted-fg/38">Type a prompt and press {shortcutLabel}.</div>
              </div>
            )}
          </div>

          {error ? (
            <div className="border-t border-red-300/[0.08] bg-red-500/[0.04] px-3.5 py-2 font-sans text-[10px] leading-4 text-red-200/72" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

ComposerPromptStash.displayName = "ComposerPromptStash";
