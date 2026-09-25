import React, { useState } from "react";
import { relativeTimeCompact } from "../../../lib/format";
import { SessionStatusLabel } from "../../terminals/SessionStatusLabel";
import { ToolLogo } from "../../terminals/ToolLogos";
import { cn } from "../../ui/cn";
import { capRows, type LaneChatRow } from "./laneOverviewModel";
import { COLORS } from "../laneDesignTokens";
import { OVERVIEW_ROW, OVERVIEW_ROW_HOVER, OverviewSection, ShowAllButton } from "./sectionUi";

const ChatRow = React.memo(function ChatRow({ row, onOpen }: { row: LaneChatRow; onOpen: (sessionId: string) => void }) {
  const done = row.rank === 3;
  // A chat waiting on you sorts first and gets an amber dot; its preview
  // line says what it is waiting for.
  const needsYou = row.rank === 0;
  return (
    <button
      type="button"
      className={cn(OVERVIEW_ROW, OVERVIEW_ROW_HOVER, "min-h-8 items-start py-[7px]")}
      onClick={() => onOpen(row.sessionId)}
      title={row.title}
      data-testid="lane-chat-row"
      data-session-id={row.sessionId}
      data-needs-you={needsYou ? "" : undefined}
    >
      <span className={cn("flex h-[18px] w-4 shrink-0 items-center justify-center", done && "opacity-55")}>
        <ToolLogo toolType={row.toolType} size={14} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          {needsYou ? (
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: COLORS.warning }} />
          ) : null}
          <span className={cn("min-w-0 flex-1 truncate text-[13px] leading-[18px]", done ? "text-fg/60" : "text-fg/90")}>
            {row.title}
          </span>
          <span className="flex shrink-0 items-center">
            <SessionStatusLabel
              presentation={row.presentation}
              elapsedSince={row.elapsedSince}
              timestampLabel={relativeTimeCompact(row.activityAt)}
              compact={false}
            />
          </span>
        </span>
        {row.preview ? (
          <span className={cn("truncate text-[12px]", needsYou ? "text-fg/75" : done ? "text-muted-fg/50" : "text-muted-fg/70")}>{row.preview}</span>
        ) : null}
      </span>
    </button>
  );
});

/**
 * The lane's chats and agent CLIs, read like the Work tab's session list:
 * the provider, the title, what it is doing, and the same status word.
 * Clicking a row opens it in the Work tab.
 */
export function LaneChatsSection({ rows, onOpenChat }: { rows: LaneChatRow[]; onOpenChat: (sessionId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { visible, hidden } = capRows(rows, expanded);
  return (
    <OverviewSection title="Chats" count={rows.length} testId="lane-chats-section" collapseKey="chats">
      {visible.map((row) => <ChatRow key={row.sessionId} row={row} onOpen={onOpenChat} />)}
      <ShowAllButton hidden={hidden} onClick={() => setExpanded(true)} label={`Show all ${rows.length}`} testId="lane-chats-show-all" />
    </OverviewSection>
  );
}
