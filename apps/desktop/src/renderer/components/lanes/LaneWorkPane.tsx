import { ChatCircleText, Command, Terminal } from "@phosphor-icons/react";
import type { WorkDraftKind } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import { SANS_FONT } from "./laneDesignTokens";
import { WorkViewArea } from "../terminals/WorkViewArea";
import { useLaneWorkSessions } from "./useLaneWorkSessions";

const ENTRY_OPTIONS: Array<{
  kind: WorkDraftKind;
  label: string;
  icon: typeof ChatCircleText;
  color: string;
}> = [
  { kind: "chat", label: "New Chat", icon: ChatCircleText, color: "#8B5CF6" },
  { kind: "cli", label: "CLI Tool", icon: Command, color: "#F97316" },
  { kind: "shell", label: "New Shell", icon: Terminal, color: "#22C55E" },
];

export function LaneWorkPane({
  laneId,
}: {
  laneId: string | null;
}) {
  const work = useLaneWorkSessions(laneId);
  const laneList = work.lane ? [work.lane] : [];

  if (!laneId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6">
        <EmptyState title="No lane selected" description="Select a lane to view active work." />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-bg)", fontFamily: SANS_FONT }}>
      <div className="shrink-0 border-b border-white/[0.04] bg-white/[0.02] px-3 py-2 backdrop-blur-xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {ENTRY_OPTIONS.map((entry) => {
              const Icon = entry.icon;
              const active = work.activeItemId == null && work.draftKind === entry.kind;
              return (
                <button
                  key={entry.kind}
                  type="button"
                  onClick={() => work.showDraftKind(entry.kind)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "5px 10px",
                    border: active ? `1px solid ${entry.color}20` : "1px solid transparent",
                    borderRadius: 8,
                    background: active ? `${entry.color}0C` : "transparent",
                    color: active ? "var(--color-fg)" : "var(--color-muted-fg)",
                    fontFamily: SANS_FONT,
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: "-0.01em",
                    cursor: "pointer",
                    transition: "all 120ms",
                  }}
                  title={entry.label}
                >
                  <Icon size={12} weight="regular" style={{ color: entry.color, opacity: active ? 1 : 0.7 }} />
                  {entry.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-fg">
            {work.lane ? <span className="truncate">{work.lane.name}</span> : null}
            <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-1">
              {work.visibleSessions.length} open
            </span>
            {work.loading ? <span className="text-muted-fg/70">Refreshing…</span> : null}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <WorkViewArea
          lanes={laneList}
          sessions={work.sessions}
          visibleSessions={work.visibleSessions}
          activeItemId={work.activeItemId}
          viewMode={work.viewMode}
          draftKind={work.draftKind}
          setViewMode={work.setViewMode}
          onSelectItem={work.setActiveItemId}
          onCloseItem={work.closeTab}
          onOpenChatSession={work.handleOpenChatSession}
          onLaunchPtySession={work.launchPtySession}
          closingPtyIds={work.closingPtyIds}
        />
      </div>
    </div>
  );
}
