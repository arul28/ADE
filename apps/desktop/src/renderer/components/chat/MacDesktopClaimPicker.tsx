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
import { INPUT_CLASS_NAME } from "../lanes/laneDialogTokens";
import {
  USAGE_DIVIDER_COLOR_CLASS,
  USAGE_HAIRLINE_CLASS,
  USAGE_HOVER_ROW_CLASS,
  USAGE_TEXT,
} from "../usage/usageDesign";
import { macDesktopErrorText } from "./macDesktopErrorText";
import {
  macDesktopClaimNextIndex,
  macDesktopClaimRows,
  type MacDesktopClaimRow,
} from "./macDesktopClaimPicker.logic";
import {
  MacDesktopAppIcon,
  MacDesktopMinimizedBadge,
  MacDesktopRowAction,
} from "./macDesktopWindowList";

/**
 * "Claim a window" — the whole Mac's windows, one click from this lane's screen.
 *
 * It is a TABLE, and specifically the table the rest of ADE already uses:
 * `settings/AdeUsageSection`'s model breakdown and `settings/StorageSection`'s
 * lane table are both a plain `<table>` with a muted `micro` header row,
 * `py-2` cells at the `detail` step, a hairline under every row, and a hover
 * wash — all of it from `usage/usageDesign`, which is where those classes are
 * defined. This file reuses them rather than restating them, so the picker
 * cannot drift away from the tables it is supposed to look like.
 *
 * What it replaced, twice: a translucent blurred sheet with the chat showing
 * through it, app-name group headers each carrying a lonely count, a mono
 * glyph per row, and rows that said "Untitled window". An app is now a column
 * with its real icon, a window with no name of its own simply prints its app's
 * name, and the surface is opaque.
 *
 * Kept deliberately thin: every judgement about a row — where it is, whether
 * this lane may take it, whether the lane already leases it, which app icon it
 * joins to — is in `macDesktopClaimPicker.logic`, and this file is the dialog,
 * the keyboard, and one spinner.
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
  /**
   * Overlay stacking. Full screen sits at 1000; a picker opened from inside
   * that overlay has to be one step above or it is behind the picture.
   */
  zIndex?: number;
};

/** Header cell: the muted, normal-weight `micro` step the settings tables use. */
const HEAD_CELL = "py-2 font-normal";

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
  zIndex,
}: MacDesktopClaimPickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [claiming, setClaiming] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(
    () => macDesktopClaimRows(windows, { laneId, displayId, laneNames, query }),
    [displayId, laneId, laneNames, query, windows],
  );

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
      className="fixed inset-0 flex items-start justify-center bg-black/55 p-4 pt-[10vh]"
      style={{ zIndex: zIndex ?? 220 }}
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
          "grid max-h-[min(560px,calc(100vh-20vh))] w-[min(720px,calc(100vw-32px))]",
          "grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border",
          // Opaque on purpose: `bg-surface-overlay` is translucent by
          // construction, which is how the chat ended up showing through this
          // dialog. `bg-surface-raised` is the settings cards' own surface.
          USAGE_HAIRLINE_CLASS,
          "bg-surface-raised text-fg shadow-float",
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
        <header className={cn("flex items-start gap-3 border-b px-4 py-3", USAGE_DIVIDER_COLOR_CLASS)}>
          <div className="min-w-0 flex-1">
            <h2 className={cn(USAGE_TEXT.body, "m-0 font-medium text-fg")}>Claim a window</h2>
            <p className={cn(USAGE_TEXT.micro, "m-0 mt-0.5 text-muted-fg")}>
              Move a window onto this lane&rsquo;s screen. ADE keeps a lease on it until you release it.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh window list"
            title="Refresh window list"
            data-testid="mac-desktop-claim-refresh"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-fg transition-colors duration-150 hover:bg-muted hover:text-fg"
          >
            <ArrowClockwise size={14} className={loading ? "animate-spin" : undefined} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-fg transition-colors duration-150 hover:bg-muted hover:text-fg"
          >
            <X size={14} />
          </button>
        </header>

        <div className={cn("relative border-b px-4 py-2.5", USAGE_DIVIDER_COLOR_CLASS)}>
          <MagnifyingGlass
            size={13}
            aria-hidden
            className="pointer-events-none absolute left-[26px] top-1/2 -translate-y-1/2 text-muted-fg"
          />
          <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            placeholder="Search by app, window or bundle id…"
            aria-label="Search open windows"
            data-testid="mac-desktop-claim-search"
            className={cn(INPUT_CLASS_NAME, "mt-0 h-8 pl-8 text-[12px]")}
          />
        </div>

        <div ref={listRef} className="min-h-0 overflow-auto px-4">
          {/* One clean line. `macDesktopErrorText` here too, and not only at the
              caller: a picker that is handed a raw rejection anywhere — a
              claim this dialog made itself, a refresh that failed — must not be
              the surface that prints "Error invoking remote method…". */}
          {error ? (
            <p className={cn(USAGE_TEXT.detail, "py-3 text-amber-300")} data-testid="mac-desktop-claim-error">
              {macDesktopErrorText(error)}
            </p>
          ) : null}
          {!error && !rows.length ? (
            <p className={cn(USAGE_TEXT.detail, "py-8 text-center text-muted-fg")} data-testid="mac-desktop-claim-empty">
              {loading
                ? "Looking at this Mac's windows…"
                : query.trim()
                  ? `No open window matches “${query.trim()}”.`
                  : "Nothing else is open on this Mac."}
            </p>
          ) : null}
          {rows.length ? (
            <table className={cn(USAGE_TEXT.detail, "w-full")}>
              <thead>
                <tr className={cn(USAGE_TEXT.micro, "border-b text-left text-muted-fg", USAGE_HAIRLINE_CLASS)}>
                  <th className={HEAD_CELL}>App</th>
                  <th className={HEAD_CELL}>Window</th>
                  <th className={HEAD_CELL}>Where</th>
                  <th className={HEAD_CELL}>State</th>
                  <th className={cn(HEAD_CELL, "text-right")}>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const isActive = index === active;
                  const spinning = claiming === row.window.id;
                  const held = row.disabled && row.disabledReason?.startsWith("Held by");
                  return (
                    <tr
                      key={row.window.id}
                      aria-disabled={row.disabled || undefined}
                      data-active={isActive ? "true" : undefined}
                      data-testid="mac-desktop-claim-row"
                      title={row.disabledReason ?? `Move “${row.title}” onto this lane's screen`}
                      onMouseEnter={() => { if (!row.disabled) setActive(index); }}
                      onClick={() => void claim(row)}
                      className={cn(
                        "border-b last:border-b-0",
                        USAGE_DIVIDER_COLOR_CLASS,
                        USAGE_HOVER_ROW_CLASS,
                        isActive && !row.disabled ? "bg-muted" : undefined,
                        row.disabled ? "opacity-55" : "cursor-pointer hover:bg-muted",
                      )}
                    >
                      <td className="max-w-[180px] py-2 pr-3 text-fg">
                        <span className="flex items-center gap-2">
                          <MacDesktopAppIcon iconPng={row.iconPng} appName={row.appName} />
                          <span className="truncate">{row.appName}</span>
                        </span>
                      </td>
                      {/* A window with no name of its own prints its app's name
                          in normal text. "Untitled window" is a label for a
                          thing nobody has, and it was on half the rows. */}
                      <td className="max-w-[260px] truncate py-2 pr-3 text-fg">{row.title}</td>
                      <td className="whitespace-nowrap py-2 pr-3 text-muted-fg">
                        {held ? (
                          <span className="inline-flex items-center gap-1">
                            <Lock size={11} className="shrink-0" />
                            {row.disabledReason}
                          </span>
                        ) : (
                          row.location.label
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {row.minimized ? <MacDesktopMinimizedBadge /> : null}
                      </td>
                      <td className="py-2 text-right">
                        {spinning ? (
                          <CircleNotch
                            size={13}
                            className="ml-auto animate-spin text-muted-fg"
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </div>

        <footer className={cn(USAGE_TEXT.micro, "border-t px-4 py-2 text-muted-fg", USAGE_DIVIDER_COLOR_CLASS)}>
          Claiming moves the window onto this lane&rsquo;s screen and gives ADE a lease on it.
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
