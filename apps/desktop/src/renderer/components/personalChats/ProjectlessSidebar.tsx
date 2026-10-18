import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Archive, Desktop, DotsThree, House, MagnifyingGlass, Plus, PushPin, SpinnerGap } from "@phosphor-icons/react";
import type { PersonalChatRow } from "./personalChatMachines";
import { cn } from "../ui/cn";
import { ToolLogo } from "../terminals/ToolLogos";
import { providerChatAccent } from "../chat/chatSurfaceTheme";
import { providerToolType, relativeTime, sessionRowDetail, sessionRowStatus, sessionTitle } from "./sessionHelpers";
import type { SessionStatusTone } from "../../../shared/sessionStatusPresentation";

/** Status word colours: blue is work, amber is your move, red is broken. */
const STATUS_TONE_CLASS: Record<SessionStatusTone, string> = {
  blue: "text-sky-300/80",
  violet: "text-violet-300/80",
  amber: "text-amber-300/90",
  emerald: "text-emerald-300/80",
  red: "text-rose-300/85",
  neutral: "text-muted-fg/55",
};

const EMPTY_IDS: ReadonlySet<string> = new Set();

/** A machine whose chats the rail lists, and how its last read went. */
export type ProjectlessSidebarMachine = {
  id: string;
  name: string;
  status: "ok" | "loading" | "error";
  message: string | null;
};

/** The in-place rename field: Enter or blur saves, Escape cancels. */
function RenameField({ initial, onCommit, onCancel }: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  // Enter and the blur it causes must not both save.
  const doneRef = useRef(false);
  const finish = (save: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const title = value.trim();
    if (save && title) onCommit(title);
    else onCancel();
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") finish(false);
      }}
      aria-label="Chat name"
      className="h-9 w-full rounded-lg border border-accent/30 bg-fg/[0.04] px-2.5 font-sans text-[12px] text-fg outline-none"
    />
  );
}

export function ProjectlessSidebar({
  standalone,
  machines,
  grouped,
  loading,
  query,
  onQueryChange,
  selectedId,
  multiSelectedIds = EMPTY_IDS,
  onRowClick,
  onRowContextMenu,
  menuOpenId = null,
  renamingId = null,
  onRenameCommit,
  onRenameCancel,
  showArchived = false,
  onToggleArchived,
  selectionToolbar,
  onListKeyDown,
  onNewChat,
  onBack,
  mobileListOpen,
}: {
  standalone: boolean;
  /** Every machine whose chats are listed. */
  machines: ProjectlessSidebarMachine[];
  grouped: Array<[string, PersonalChatRow[]]>;
  loading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  /** The row open in the pane. */
  selectedId: string | null;
  /** Rows picked with shift / cmd / ctrl-click, for the bulk actions. */
  multiSelectedIds?: ReadonlySet<string>;
  /** Every row click, with its modifier keys: the page decides open vs. select. */
  onRowClick: (id: string, event: ReactMouseEvent) => void;
  /** Right-click, or the row's ⋯ button; the position is where the menu opens. */
  onRowContextMenu?: (id: string, position: { x: number; y: number }) => void;
  /** The row whose menu is open, for the ⋯ button's expanded state. */
  menuOpenId?: string | null;
  /** The row being renamed in place. */
  renamingId?: string | null;
  /** Save a new title; an empty one cancels. */
  onRenameCommit?: (id: string, title: string) => void;
  onRenameCancel?: () => void;
  /** The rail lists archived chats instead of live ones. */
  showArchived?: boolean;
  onToggleArchived?: () => void;
  /** The bulk-action bar, shown while rows are multi-selected. */
  selectionToolbar?: ReactNode;
  /** Keys pressed while focus is on a row (arrows, Delete, Escape, select all). */
  onListKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onNewChat: () => void;
  onBack: () => void;
  mobileListOpen: boolean;
}) {
  return (
    <aside className={cn(
      "ade-chat-scene-plane relative w-[286px] shrink-0 border-r border-fg/[0.06] bg-black/[0.12]",
      "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[min(88vw,320px)] max-md:shadow-2xl",
      !mobileListOpen && "max-md:hidden",
    )}>
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden max-md:block" style={{ background: "var(--color-bg)" }} />
      <div className="relative z-10 flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          {standalone ? (
            <button type="button" onClick={onBack} className="flex h-8 w-8 items-center justify-center rounded-lg text-fg/55 hover:bg-fg/[0.06] hover:text-fg" aria-label="Back to home">
              <House size={16} />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[15px] font-semibold tracking-tight">{showArchived ? "Archived" : "Chats"}</div>
          </div>
          {onToggleArchived ? (
            <button
              type="button"
              onClick={onToggleArchived}
              aria-pressed={showArchived}
              aria-label={showArchived ? "Back to chats" : "Show archived chats"}
              title={showArchived ? "Back to chats" : "Archived chats"}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
                showArchived ? "bg-fg/[0.08] text-fg" : "text-muted-fg/50 hover:bg-fg/[0.06] hover:text-fg",
              )}
            >
              <Archive size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/10 px-2.5 font-sans text-[11px] font-medium text-accent hover:bg-accent/15"
            onClick={onNewChat}
          >
            <Plus size={13} weight="bold" /> New
          </button>
        </div>
        <div className="sticky top-0 z-10 mx-3 mb-2">
          <MagnifyingGlass size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg/40" />
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={showArchived ? "Search archived chats" : "Search chats"} aria-label="Search chats" className="h-8 w-full rounded-lg border border-fg/[0.06] bg-fg/[0.025] pl-8 pr-2 font-sans text-[11px] text-fg outline-none placeholder:text-muted-fg/35 focus:border-accent/30" />
        </div>
        {selectionToolbar}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" onKeyDown={onListKeyDown}>
          {loading ? <div className="flex justify-center py-10 text-muted-fg/35"><SpinnerGap size={17} className="animate-spin" /></div> : null}
          {!loading && grouped.length === 0 ? (
            <div className="px-4 py-10 text-center font-sans text-[11px] leading-5 text-muted-fg/40">
              {query.trim()
                ? "No chats match."
                : showArchived
                  ? "No archived chats."
                  : <>No chats yet.<br />Start with anything on your mind.</>}
            </div>
          ) : null}
          {grouped.map(([label, rows]) => (
            <div key={label} className="mb-3">
              <div className="px-2 pb-1 pt-2 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg/40">{label}</div>
              <div className="space-y-0.5">
                {rows.map((session) => {
                  const active = session.rowId === selectedId;
                  const picked = multiSelectedIds.has(session.rowId);
                  const streaming = session.status === "active";
                  const dotColor = providerChatAccent(session.provider) ?? "var(--color-accent)";
                  const status = sessionRowStatus(session);
                  if (renamingId === session.rowId) {
                    return (
                      <div key={session.rowId} className="px-1 py-1">
                        <RenameField
                          initial={sessionTitle(session)}
                          onCommit={(title) => onRenameCommit?.(session.rowId, title)}
                          onCancel={() => onRenameCancel?.()}
                        />
                      </div>
                    );
                  }
                  return (
                    <div
                      key={session.rowId}
                      className="group relative"
                      data-chat-row-id={session.rowId}
                      data-selected={picked ? "true" : undefined}
                      onContextMenu={onRowContextMenu
                        ? (event) => {
                            event.preventDefault();
                            onRowContextMenu(session.rowId, { x: event.clientX, y: event.clientY });
                          }
                        : undefined}
                    >
                      {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" /> : null}
                      <button
                        type="button"
                        // A shift-click extends the selection; without this it
                        // also drags a text selection across the rows.
                        onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }}
                        onClick={(event) => onRowClick(session.rowId, event)}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors",
                          picked
                            ? "bg-accent/[0.11] ring-1 ring-inset ring-accent/25"
                            : active ? "bg-fg/[0.075]" : "hover:bg-fg/[0.04]",
                        )}
                      >
                        <span className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-fg/[0.06] bg-black/20">
                          <ToolLogo toolType={providerToolType(session.provider)} size={15} />
                          {streaming ? (
                            <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-bg" style={{ background: dotColor, boxShadow: `0 0 6px ${dotColor}` }} />
                          ) : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1">
                            {session.pinned ? <PushPin size={10} weight="fill" aria-label="Pinned" className="shrink-0 text-muted-fg/50" /> : null}
                            <span className="block truncate font-sans text-[12px] font-medium text-fg/82">{sessionTitle(session)}</span>
                          </span>
                          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 font-sans text-[10px] text-muted-fg/42">
                            {status ? (
                              <span className={cn("shrink-0 font-medium", STATUS_TONE_CLASS[status.tone])}>{status.label}</span>
                            ) : null}
                            {session.machineName ? (
                              <span className="flex shrink-0 items-center gap-0.5 text-muted-fg/55" title={`On ${session.machineName}`}>
                                <Desktop size={9} aria-hidden />
                                <span className="max-w-[88px] truncate">{session.machineName}</span>
                              </span>
                            ) : null}
                            <span className="min-w-0 truncate">{sessionRowDetail(session)}</span>
                          </span>
                        </span>
                        <span className="mt-0.5 shrink-0 font-sans text-[9px] tabular-nums text-muted-fg/35 group-hover:hidden">{relativeTime(session.lastActivityAt)}</span>
                      </button>
                      {onRowContextMenu ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            const rect = event.currentTarget.getBoundingClientRect();
                            onRowContextMenu(session.rowId, { x: rect.left, y: rect.bottom + 4 });
                          }}
                          className={cn(
                            "absolute right-2 top-2 h-6 w-6 items-center justify-center rounded-md text-muted-fg/45 hover:bg-fg/[0.08] hover:text-fg group-hover:flex",
                            menuOpenId === session.rowId ? "flex" : "hidden",
                          )}
                          aria-label={`More actions for ${sessionTitle(session)}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpenId === session.rowId}
                        >
                          <DotsThree size={15} weight="bold" />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {/* Chats from every machine listed here are in the rail. A machine that
            did not answer is named, so a short list is never a silent one. */}
        <div className="border-t border-fg/[0.05] px-3 py-2" aria-label="Machines listed">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {machines.map((machine) => (
              <span
                key={machine.id}
                className="flex min-w-0 max-w-full items-center gap-1.5"
                title={machine.status === "error"
                  ? `${machine.name}: ${machine.message ?? "its chats could not be read"}`
                  : machine.status === "loading" ? `Reading chats on ${machine.name}` : `Chats on ${machine.name}`}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    machine.status === "error" ? "bg-amber-400/80" : machine.status === "loading" ? "bg-fg/25" : "bg-emerald-400/70",
                  )}
                />
                <Desktop size={12} aria-hidden className="shrink-0 text-muted-fg/45" />
                <span className={cn("min-w-0 truncate font-sans text-[10px]", machine.status === "error" ? "text-amber-200/70" : "text-muted-fg/60")}>
                  {machine.name}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
