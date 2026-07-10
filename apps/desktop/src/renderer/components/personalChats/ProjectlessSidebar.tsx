import { Archive, DotsThree, House, MagnifyingGlass, Plus, SpinnerGap, Trash } from "@phosphor-icons/react";
import type { AgentChatSessionSummary } from "../../../shared/types";
import { cn } from "../ui/cn";
import { ToolLogo } from "../terminals/ToolLogos";
import { providerChatAccent } from "../chat/chatSurfaceTheme";
import { providerToolType, relativeTime, sessionPreview, sessionTitle } from "./sessionHelpers";

export function ProjectlessSidebar({
  standalone,
  machineLabel,
  grouped,
  loading,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  onNewChat,
  onBack,
  mobileListOpen,
  menuId,
  onToggleMenu,
  onRemove,
}: {
  standalone: boolean;
  machineLabel: string;
  grouped: Array<[string, AgentChatSessionSummary[]]>;
  loading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onBack: () => void;
  mobileListOpen: boolean;
  menuId: string | null;
  onToggleMenu: (id: string | null) => void;
  onRemove: (id: string, action: "archive" | "delete") => void;
}) {
  return (
    <aside className={cn(
      "relative w-[286px] shrink-0 border-r border-white/[0.06] bg-black/[0.12]",
      "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[min(88vw,320px)] max-md:shadow-2xl",
      !mobileListOpen && "max-md:hidden",
    )}>
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden max-md:block" style={{ background: "var(--color-bg)" }} />
      <div className="relative z-10 flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          {standalone ? (
            <button type="button" onClick={onBack} className="flex h-8 w-8 items-center justify-center rounded-lg text-fg/55 hover:bg-white/[0.06] hover:text-fg" aria-label="Back to home">
              <House size={16} />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[15px] font-semibold tracking-tight">Chats</div>
          </div>
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
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search chats" aria-label="Search chats" className="h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.025] pl-8 pr-2 font-sans text-[11px] text-fg outline-none placeholder:text-muted-fg/35 focus:border-accent/30" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {loading ? <div className="flex justify-center py-10 text-muted-fg/35"><SpinnerGap size={17} className="animate-spin" /></div> : null}
          {!loading && grouped.length === 0 ? <div className="px-4 py-10 text-center font-sans text-[11px] leading-5 text-muted-fg/40">No chats yet.<br />Start with anything on your mind.</div> : null}
          {grouped.map(([label, rows]) => (
            <div key={label} className="mb-3">
              <div className="px-2 pb-1 pt-2 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg/40">{label}</div>
              <div className="space-y-0.5">
                {rows.map((session) => {
                  const active = session.sessionId === selectedId;
                  const streaming = session.status === "active";
                  const dotColor = providerChatAccent(session.provider) ?? "var(--color-accent)";
                  return (
                    <div key={session.sessionId} className="group relative">
                      {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" /> : null}
                      <button type="button" onClick={() => onSelect(session.sessionId)} className={cn("flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors", active ? "bg-white/[0.075]" : "hover:bg-white/[0.04]")}>
                        <span className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-black/20">
                          <ToolLogo toolType={providerToolType(session.provider)} size={15} />
                          {streaming ? (
                            <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-bg" style={{ background: dotColor, boxShadow: `0 0 6px ${dotColor}` }} />
                          ) : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-sans text-[12px] font-medium text-fg/82">{sessionTitle(session)}</span>
                          <span className="mt-0.5 block truncate font-sans text-[10px] text-muted-fg/42">{sessionPreview(session)}</span>
                        </span>
                        <span className="mt-0.5 shrink-0 font-sans text-[9px] tabular-nums text-muted-fg/35 group-hover:hidden">{relativeTime(session.lastActivityAt)}</span>
                      </button>
                      <button type="button" onClick={(event) => { event.stopPropagation(); onToggleMenu(menuId === session.sessionId ? null : session.sessionId); }} className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded-md text-muted-fg/45 hover:bg-white/[0.08] hover:text-fg group-hover:flex" aria-label={`More actions for ${sessionTitle(session)}`}><DotsThree size={15} weight="bold" /></button>
                      {menuId === session.sessionId ? (
                        <div className="absolute right-2 top-9 z-30 w-32 rounded-lg border border-white/[0.08] bg-[var(--color-popup-bg)] p-1 shadow-2xl">
                          <button type="button" onClick={() => onRemove(session.sessionId, "archive")} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] text-fg/65 hover:bg-white/[0.06]"><Archive size={12} />Archive</button>
                          <button type="button" onClick={() => onRemove(session.sessionId, "delete")} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] text-rose-300/75 hover:bg-rose-500/10"><Trash size={12} />Delete</button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-white/[0.05] px-4 py-2.5">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400/70" />
          <span className="truncate font-sans text-[10px] text-muted-fg/45">{machineLabel}</span>
        </div>
      </div>
    </aside>
  );
}
