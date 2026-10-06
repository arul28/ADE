import { ArrowsOutSimple, SidebarSimple } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

/** White header glyph shared by the tools toggle and the marks beside it. */
export const WORK_HEADER_ICON_BUTTON_CLASS =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.85)] transition-opacity hover:opacity-80";

/** Far-left session-list expander — lives next to the session-list search. */
export function WorkHeaderSidebarToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? "Show sessions" : "Hide sessions";
  return (
    <button
      type="button"
      className="ade-shell-control inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-fg/55 transition-colors hover:text-fg/85"
      data-variant="ghost"
      title={label}
      aria-label={label}
      aria-pressed={!collapsed}
      onClick={onToggle}
    >
      <SidebarSimple size={13} weight="regular" />
    </button>
  );
}

/**
 * Far-right Tools-pane toggle — mirrored sidebar glyph (rail on the right).
 *
 * While the pane is open the glyph sits on an accent fill, so it is plain which
 * chat the pane belongs to when a grid shows several chats, each with its own
 * toggle. The glyph stays white: the header is drawn over the chat gradient.
 */
export function WorkHeaderToolsToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        WORK_HEADER_ICON_BUTTON_CLASS,
        open && "bg-[color-mix(in_srgb,var(--color-accent)_55%,transparent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_70%,transparent)] hover:opacity-90",
      )}
      onClick={onToggle}
      title={open ? "Close Tools pane" : "Open Tools pane"}
      aria-label={open ? "Close Tools pane" : "Open Tools pane"}
      aria-pressed={open}
      data-open={open ? "true" : undefined}
    >
      <SidebarSimple size={16} weight="bold" className="-scale-x-100" />
    </button>
  );
}

/**
 * Focus grid only, in place of the Tools toggle: leave the grid and open this
 * chat in the normal view, where the Tools pane is available.
 */
export function WorkHeaderOpenFullViewButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className={WORK_HEADER_ICON_BUTTON_CLASS}
      onClick={onOpen}
      title="Open in full view, with the Tools pane"
      aria-label="Open in full view"
      data-testid="work-header-open-full-view"
    >
      <ArrowsOutSimple size={15} weight="bold" />
    </button>
  );
}
