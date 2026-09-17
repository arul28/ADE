import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowClockwise,
  CircleNotch,
  Lock,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";

import type { MacDesktopWindow } from "../../../shared/types/macDesktop";
import { cn } from "../ui/cn";
import { getFocusableElements } from "../ui/dialogFocus";
import { macDesktopErrorText } from "./macDesktopErrorText";
import {
  macDesktopClaimFlatRows,
  macDesktopClaimGroups,
  macDesktopClaimNextIndex,
  type MacDesktopClaimRow,
} from "./macDesktopClaimPicker.logic";
import {
  MAC_DESKTOP_LIST_HEADER,
  MAC_DESKTOP_LIST_META,
  MAC_DESKTOP_LIST_ROW,
  MAC_DESKTOP_LIST_TITLE,
  MacDesktopMinimizedBadge,
  MacDesktopRowAction,
  MacDesktopWindowGlyph,
} from "./macDesktopWindowList";

/**
 * "Claim a window" — the whole Mac's windows, one click from this lane's screen.
 *
 * What it replaces: a footer that read `No windows yet · ade mac-desktop open
 * <app> · Claim…`, which asked a person to retype a CLI command under a live
 * video of their own screen. A window is a thing you point at, so this is a
 * list of the things.
 *
 * Kept deliberately thin: every judgement about a row — where it is, whether
 * this lane may take it, whether the lane already leases it — is in
 * `macDesktopClaimPicker.logic`, and this file is the dialog, the keyboard, and
 * one spinner.
 */
export type MacDesktopClaimPickerProps = {
  laneId: string;
  displayId: number | null | undefined;
  /** Lane id → human name, so a parked window names its lane, not a uuid. */
  laneNames?: Readonly<Record<string, string>>;
  windows: readonly MacDesktopWindow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClaim: (windowId: number) => Promise<void>;
  onClose: () => void;
};

export function MacDesktopClaimPicker({
  laneId,
  displayId,
  laneNames,
  windows,
  loading,
  error,
  onRefresh,
  onClaim,
  onClose,
}: MacDesktopClaimPickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [claiming, setClaiming] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo(
    () => macDesktopClaimGroups(windows, { laneId, displayId, laneNames, query }),
    [displayId, laneId, laneNames, query, windows],
  );
  const rows = useMemo(() => macDesktopClaimFlatRows(groups), [groups]);

  // The cursor is an index into a list that a refresh or a keystroke can
  // shorten, so it is clamped on every change rather than trusted.
  useEffect(() => {
    setActive((current) => (current < rows.length ? current : 0));
  }, [rows.length]);

  const claim = useCallback(async (row: MacDesktopClaimRow) => {
    if (row.disabled || claiming != null) return;
    setClaiming(row.window.id);
    try {
      await onClaim(row.window.id);
      onClose();
    } catch {
      // Swallowed HERE and nowhere else: `onClaim` reports the failure into
      // this dialog's own `error` prop before it rethrows, so the person is
      // already being told. Letting it out of a `void claim(row)` click
      // handler only produced an unhandled rejection in the console.
    } finally {
      setClaiming(null);
    }
  }, [claiming, onClaim, onClose]);

  /*
    Escape and the arrows are bound at the window, capturing.

    The pane underneath this dialog forwards every key it sees to the lane's
    Mac while the user holds the input lease, so a key that only a panel-level
    handler saw would be typed into whatever app is focused over there. Capture
    at the window is the only place this dialog reliably wins.
  */
  const stateRef = useRef({ rows, active, claim, onClose });
  stateRef.current = { rows, active, claim, onClose };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = stateRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        // Immediate: the panel binds its own capturing Escape to leave full
        // screen, on the same node, and one Escape should close one thing.
        event.stopImmediatePropagation();
        state.onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) => {
          const next = macDesktopClaimNextIndex(state.rows, current, step);
          return next < 0 ? current : next;
        });
        return;
      }
      if (event.key === "Enter" && !event.isComposing) {
        const row = state.rows[state.active];
        if (!row || row.disabled) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void state.claim(row);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    // Optional call: `scrollIntoView` is absent in jsdom, and a keyboard
    // convenience must not be the thing that throws out of an effect.
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const body = (
    <div
      className="fixed inset-0 z-[220] flex items-start justify-center bg-black/55 p-4 pt-[12vh] backdrop-blur-sm"
      role="presentation"
      data-testid="mac-desktop-claim-picker"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Claim a window"
        className={cn(
          "grid max-h-[min(520px,calc(100vh-24vh))] w-[min(520px,calc(100vw-32px))]",
          "grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl",
          "border border-border/70 bg-surface-overlay text-fg shadow-float",
        )}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const nodes = getFocusableElements(event.currentTarget);
          if (!nodes.length) return;
          const first = nodes[0]!;
          const last = nodes[nodes.length - 1]!;
          const activeElement = document.activeElement as HTMLElement | null;
          if (event.shiftKey && activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
          <MagnifyingGlass size={14} className="shrink-0 text-muted-fg" />
          <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            placeholder="Search open windows…"
            aria-label="Search open windows"
            data-testid="mac-desktop-claim-search"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-muted-fg/70"
          />
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh window list"
            title="Refresh window list"
            data-testid="mac-desktop-claim-refresh"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-[7px] text-muted-fg transition-colors duration-[120ms] hover:bg-white/[0.06] hover:text-fg"
          >
            <ArrowClockwise size={14} className={loading ? "animate-spin" : undefined} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-[7px] text-muted-fg transition-colors duration-[120ms] hover:bg-white/[0.06] hover:text-fg"
          >
            <X size={14} />
          </button>
        </header>

        <div ref={listRef} className="min-h-0 overflow-auto p-1.5" role="listbox" aria-label="Open windows">
          {/* One clean line. `macDesktopErrorText` here too, and not only at the
              caller: a picker that is handed a raw rejection anywhere — a
              claim this dialog made itself, a refresh that failed — must not be
              the surface that prints "Error invoking remote method…". */}
          {error ? (
            <p className="px-2 py-3 text-[12px] text-amber-300" data-testid="mac-desktop-claim-error">
              {macDesktopErrorText(error)}
            </p>
          ) : null}
          {!error && !rows.length ? (
            <p className="px-2 py-6 text-center text-[12px] text-muted-fg" data-testid="mac-desktop-claim-empty">
              {loading
                ? "Looking at this Mac's windows…"
                : query.trim()
                  ? `No open window matches “${query.trim()}”.`
                  : "Nothing else is open on this Mac."}
            </p>
          ) : null}
          {/*
            App name as a header row with a count, one line per window under it.

            The row is a `div` and the action a real `<button>` inside it: the
            previous row WAS the button, so "Claim" could only ever be an icon
            (a button cannot contain a button) and the whole row was one target
            whatever you were pointing at.
          */}
          {groups.map((group, groupIndex) => (
            <section
              key={group.key}
              className={cn("pb-0.5", groupIndex > 0 && "mt-0.5 border-t border-white/[0.06] pt-0.5")}
            >
              <p className={MAC_DESKTOP_LIST_HEADER} data-testid="mac-desktop-claim-group">
                <span className="min-w-0 flex-1 truncate">{group.appName}</span>
                <span className="shrink-0 tabular-nums text-muted-fg/60">{group.rows.length}</span>
              </p>
              {group.rows.map((row) => {
                const index = rows.indexOf(row);
                const isActive = index === active;
                const spinning = claiming === row.window.id;
                return (
                  <div
                    key={row.window.id}
                    role="option"
                    aria-selected={isActive}
                    aria-disabled={row.disabled || undefined}
                    data-active={isActive ? "true" : undefined}
                    data-testid="mac-desktop-claim-row"
                    title={row.disabledReason ?? `Move “${row.title}” onto this lane's screen`}
                    onMouseEnter={() => { if (!row.disabled) setActive(index); }}
                    onClick={() => void claim(row)}
                    className={cn(
                      MAC_DESKTOP_LIST_ROW,
                      isActive && !row.disabled ? "bg-white/[0.07]" : "bg-transparent",
                      row.disabled ? "opacity-45" : "cursor-pointer hover:bg-white/[0.05]",
                    )}
                  >
                    <MacDesktopWindowGlyph />
                    <span className={MAC_DESKTOP_LIST_TITLE}>
                      {row.untitled ? "Untitled window" : row.title}
                    </span>
                    {row.minimized ? <MacDesktopMinimizedBadge /> : null}
                    {row.hasLease ? <MacDesktopLeaseChip /> : null}
                    <span className={MAC_DESKTOP_LIST_META}>
                      {row.disabled && row.disabledReason ? (
                        <span className="inline-flex items-center gap-1">
                          {row.disabledReason.startsWith("held by") ? <Lock size={10} className="shrink-0" /> : null}
                          {row.disabledReason}
                        </span>
                      ) : row.location.label}
                    </span>
                    {spinning ? (
                      <CircleNotch
                        size={13}
                        className="mx-1.5 shrink-0 animate-spin text-muted-fg"
                        data-testid="mac-desktop-claim-spinner"
                      />
                    ) : (
                      <MacDesktopRowAction
                        label="Claim"
                        testId="mac-desktop-claim-action"
                        title={row.disabledReason ?? `Move “${row.title}” onto this lane's screen`}
                        disabled={row.disabled || claiming != null}
                        onClick={() => void claim(row)}
                      />
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        <footer className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-fg">
          Claiming moves the window onto this lane's screen and gives ADE a lease on it.
        </footer>
      </div>
    </div>
  );

  return typeof document === "undefined" ? body : createPortal(body, document.body);
}

/** The lane's ownership, stated wherever a window it holds is listed. */
export function MacDesktopLeaseChip({ className }: { className?: string }) {
  return (
    <span
      data-testid="mac-desktop-lease-chip"
      title="This lane holds a lease on this window"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px",
        "bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)]",
        "text-[10px] font-medium text-fg/75",
        className,
      )}
    >
      ADE lease
    </span>
  );
}
