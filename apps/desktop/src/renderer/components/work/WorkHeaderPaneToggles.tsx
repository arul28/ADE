import { SidebarSimple } from "@phosphor-icons/react";

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

/** Far-right Tools-pane toggle — mirrored sidebar glyph (rail on the right). */
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
      className="ade-shell-control inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-fg/55 transition-colors hover:text-fg/85"
      data-variant="ghost"
      style={{ opacity: open ? 1 : 0.7 }}
      onClick={onToggle}
      title={open ? "Close Tools pane" : "Open Tools pane"}
      aria-label={open ? "Close Tools pane" : "Open Tools pane"}
      aria-pressed={open}
    >
      <SidebarSimple size={16} weight="regular" className="-scale-x-100" />
    </button>
  );
}
