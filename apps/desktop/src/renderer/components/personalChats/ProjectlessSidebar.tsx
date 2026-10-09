import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Archive, CaretUpDown, Check, Desktop, DotsThree, House, MagnifyingGlass, Plus, PushPin, SpinnerGap } from "@phosphor-icons/react";
import type { AgentChatSessionSummary } from "../../../shared/types";
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
  machineLabel,
  machineId,
  machineOptions,
  onSelectMachine,
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
  machineLabel: string;
  machineId: string;
  machineOptions: Array<{ id: string; name: string }>;
  onSelectMachine: (machineId: string) => void;
  grouped: Array<[string, AgentChatSessionSummary[]]>;
  loading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  /** The chat open in the pane. */
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
  const [machineMenuOpen, setMachineMenuOpen] = useState(false);

  useEffect(() => {
    if (!machineMenuOpen) return;
    const close = () => setMachineMenuOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMachineMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [machineMenuOpen]);

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
                  const active = session.sessionId === selectedId;
                  const picked = multiSelectedIds.has(session.sessionId);
                  const streaming = session.status === "active";
                  const dotColor = providerChatAccent(session.provider) ?? "var(--color-accent)";
                  const status = sessionRowStatus(session);
                  if (renamingId === session.sessionId) {
                    return (
                      <div key={session.sessionId} className="px-1 py-1">
                        <RenameField
                          initial={sessionTitle(session)}
                          onCommit={(title) => onRenameCommit?.(session.sessionId, title)}
                          onCancel={() => onRenameCancel?.()}
                        />
                      </div>
                    );
                  }
                  return (
                    <div
                      key={session.sessionId}
                      className="group relative"
                      data-chat-row-id={session.sessionId}
                      data-selected={picked ? "true" : undefined}
                      onContextMenu={onRowContextMenu
                        ? (event) => {
                            event.preventDefault();
                            onRowContextMenu(session.sessionId, { x: event.clientX, y: event.clientY });
                          }
                        : undefined}
                    >
                      {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" /> : null}
                      <button
                        type="button"
                        // A shift-click extends the selection; without this it
                        // also drags a text selection across the rows.
                        onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }}
                        onClick={(event) => onRowClick(session.sessionId, event)}
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
                            onRowContextMenu(session.sessionId, { x: rect.left, y: rect.bottom + 4 });
                          }}
                          className={cn(
                            "absolute right-2 top-2 h-6 w-6 items-center justify-center rounded-md text-muted-fg/45 hover:bg-fg/[0.08] hover:text-fg group-hover:flex",
                            menuOpenId === session.sessionId ? "flex" : "hidden",
                          )}
                          aria-label={`More actions for ${sessionTitle(session)}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpenId === session.sessionId}
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
        {/* The machine is an explicit choice, not a footnote: chats live on the
            machine named here, so it gets a real control instead of a label. */}
        <div className="relative border-t border-fg/[0.05] px-2 py-2">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={machineMenuOpen}
            aria-label={`Chats run on ${machineLabel}. Choose a machine.`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setMachineMenuOpen((current) => !current)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-fg/[0.05]"
          >
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400/70" />
            <Desktop size={12} aria-hidden className="shrink-0 text-muted-fg/45" />
            <span className="min-w-0 flex-1 truncate font-sans text-[10px] text-muted-fg/60">{machineLabel}</span>
            <CaretUpDown size={11} aria-hidden className="shrink-0 text-muted-fg/40" />
          </button>
          {machineMenuOpen ? (
            <div
              role="menu"
              aria-label="Choose a machine"
              onMouseDown={(event) => event.stopPropagation()}
              className="absolute bottom-[calc(100%-0.25rem)] left-2 right-2 z-30 rounded-lg border border-fg/[0.08] bg-[var(--color-popup-bg)] p-1 shadow-2xl"
            >
              {machineOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitem"
                  onClick={() => { setMachineMenuOpen(false); onSelectMachine(option.id); }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-sans text-[10px] transition-colors",
                    option.id === machineId ? "text-fg" : "text-fg/65 hover:bg-fg/[0.06]",
                  )}
                >
                  <Desktop size={12} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {option.id === machineId ? <Check size={11} weight="bold" aria-hidden /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
