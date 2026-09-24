/**
 * One list vocabulary for every place Mac Desktop names a window.
 *
 * Two surfaces list windows — the claim picker (every window on the Mac) and
 * the strip's Windows menu (the ones on this lane's screen) — and they had
 * invented two looks for the same row: a 28px initials tile with a two-line
 * stack in one, an unformatted text run with a bare "Release" word in the
 * other. Neither matched the rest of the app, where a list row is one line of
 * fixed height, a small muted glyph, a truncating name, a right column that
 * does not move, and an action that reads as a word.
 *
 * The geometry is stated here once, on the app's own menu tokens
 * (`ui/paneMenuTokens`), so the two lists cannot drift again and a third one
 * has nothing to reinvent.
 */
import type { ReactNode } from "react";
import { AppWindow } from "@phosphor-icons/react";

import { cn } from "../ui/cn";

/**
 * The app row above a group of windows: the app's name and how many it has.
 *
 * A header row rather than a repeated column: an app's name printed once per
 * row is the thing that made the picker read as a wall of text, and the count
 * is the fact the header can carry for free.
 */
export const MAC_DESKTOP_LIST_HEADER = cn(
  "flex h-[26px] items-center gap-2 px-2",
  "text-[11px] font-medium text-muted-fg/85",
);

/**
 * One window. 32px, one line, never two.
 *
 * `h-8` and not `py-*`: rows that size themselves to their content make a list
 * whose rhythm depends on whether a window happens to have a subtitle.
 */
export const MAC_DESKTOP_LIST_ROW = cn(
  "group flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left",
  "transition-colors duration-[120ms] ease-out",
);

/** The right-hand column: where a window is, at one fixed width. */
export const MAC_DESKTOP_LIST_META = "w-[86px] shrink-0 truncate text-right text-[11px] text-muted-fg/80";

/** The window's name. The only part of the row allowed to take the slack. */
export const MAC_DESKTOP_LIST_TITLE = "min-w-0 flex-1 truncate text-[12px] text-fg/85";

/**
 * The neutral app glyph.
 *
 * Not initials in a tile: at 28px square with two bold letters, the glyph was
 * the loudest thing in a row whose subject is the window's name. Nothing on
 * this side resolves a real app icon — the service hands out a bundle id and
 * no image — so the honest drawing is a small window mark.
 */
export function MacDesktopWindowGlyph({ className }: { className?: string }) {
  return <AppWindow size={13} aria-hidden className={cn("shrink-0 text-muted-fg/70", className)} />;
}

/**
 * "minimized", as a badge on the window's own row.
 *
 * A minimized window is the same window, so it is never a second row; this is
 * the one mark that says which state it is in.
 */
export function MacDesktopMinimizedBadge() {
  return (
    <span
      data-testid="mac-desktop-minimized-badge"
      className="shrink-0 rounded-full bg-white/[0.07] px-1.5 py-px text-[10px] text-muted-fg"
    >
      minimized
    </span>
  );
}

/**
 * The action at the end of a row: a word, not a glyph.
 *
 * Drawn at rest rather than revealed on hover. A list whose only actions appear
 * under the pointer is a list you have to discover by sweeping it, and these
 * two ("Claim", "Release") are the entire point of their lists.
 */
export function MacDesktopRowAction({
  label,
  onClick,
  disabled,
  testId,
  title,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      disabled={disabled}
      title={title ?? label}
      data-testid={testId}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5",
        "text-[11.5px] font-medium text-muted-fg",
        "transition-colors duration-[120ms] ease-out",
        "hover:bg-white/[0.07] hover:text-fg",
        "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
        "group-hover:text-fg/90",
        "disabled:pointer-events-none disabled:opacity-30",
      )}
    >
      {children}
      {label}
    </button>
  );
}

/**
 * The real app icon, at list size.
 *
 * `iconPng` is a base64 PNG the driver renders once per app (see
 * `macDesktopClaimPicker.logic`), so this is an `<img>` and not a font glyph.
 * The neutral window mark stays as the fallback: an older driver sends no
 * icons at all, and a row with a hole in its first column reads as broken.
 */
export function MacDesktopAppIcon({
  iconPng,
  appName,
  className,
}: {
  iconPng?: string | null;
  appName: string;
  className?: string;
}) {
  if (!iconPng) {
    return <MacDesktopWindowGlyph className={cn("size-4", className)} />;
  }
  return (
    <img
      src={`data:image/png;base64,${iconPng}`}
      alt=""
      aria-hidden
      data-testid="mac-desktop-app-icon"
      title={appName}
      width={16}
      height={16}
      className={cn("size-4 shrink-0 rounded-[3px] object-contain", className)}
    />
  );
}
