/**
 * ChatChannelList — the sidebar channel list inside MissionChatV2.
 *
 * Renders global feed, orchestrator, teammate and worker channels
 * with status dots, unread badges and phase labels.
 */
import React from "react";
import {
  Globe,
  Crown,
  UsersThree,
  Wrench,
  CaretRight,
} from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";

// ── Design tokens ──
const BG_SIDEBAR = "#1a1625";
const ACCENT = COLORS.accent;
const BORDER = "#2a2535";
const TEXT_PRIMARY = COLORS.textPrimary;
const TEXT_MUTED = COLORS.textMuted;
const TEXT_DIM = COLORS.textDim;
const STATUS_GREEN = COLORS.success;
const STATUS_GRAY = "#6b7280";
const BG_PAGE = COLORS.pageBg;

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  fontFamily: SANS_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: TEXT_MUTED,
};

export type ChannelKind = "global" | "orchestrator" | "teammate" | "worker";

export type Channel = {
  id: string;
  kind: ChannelKind;
  label: string;
  fullLabel: string;
  threadId: string | null;
  sessionId: string | null;
  status: "active" | "closed";
  stepKey: string | null;
  attemptId: string | null;
  unreadCount: number;
  phaseLabel: string | null;
};

type ChatChannelListProps = {
  channels: Channel[];
  orchestratorChannel: Channel | null;
  teammateChannels: Channel[];
  activeWorkerChannels: Channel[];
  completedWorkerChannels: Channel[];
  selectedChannelId: string;
  completedCollapsed: boolean;
  workerStatusDot: (attemptId: string | null) => string;
  onSelectChannel: (id: string) => void;
  onToggleCompletedCollapsed: () => void;
};

export const ChatChannelList = React.memo(function ChatChannelList({
  channels,
  orchestratorChannel,
  teammateChannels,
  activeWorkerChannels,
  completedWorkerChannels,
  selectedChannelId,
  completedCollapsed,
  workerStatusDot,
  onSelectChannel,
  onToggleCompletedCollapsed,
}: ChatChannelListProps) {
  return (
    <aside
      className="flex w-[188px] shrink-0 flex-col"
      style={{ background: BG_SIDEBAR, borderRight: `1px solid ${BORDER}` }}
    >
      <div className="px-2.5 py-2" style={{ borderBottom: `1px solid ${BORDER}` }}>
        <div style={{ ...LABEL_STYLE, color: TEXT_PRIMARY }}>Conversations</div>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {/* Global channel */}
        <ChannelButton
          icon={<Globe size={12} weight="regular" />}
          label="Mission Feed"
          statusColor={STATUS_GREEN}
          isSelected={selectedChannelId === "global"}
          onClick={() => onSelectChannel("global")}
          unreadCount={0}
        />

        {/* Orchestrator section */}
        {orchestratorChannel && (
          <>
            <SectionLabel>ORCHESTRATOR</SectionLabel>
            <ChannelButton
              icon={<Crown size={12} weight="fill" />}
              label="Orchestrator"
              statusColor={statusDotColor(orchestratorChannel.status)}
              isSelected={selectedChannelId === orchestratorChannel.id}
              onClick={() => onSelectChannel(orchestratorChannel.id)}
              unreadCount={orchestratorChannel.unreadCount}
              badge="orchestrator"
              badgeColor="#3B82F6"
            />
          </>
        )}

        {/* Teammates */}
        {teammateChannels.length > 0 && (
          <>
            <SectionLabel>TEAMMATES</SectionLabel>
            {teammateChannels.map((ch) => (
              <ChannelButton
                key={ch.id}
                icon={<UsersThree size={12} weight="fill" />}
                label={ch.label}
                statusColor={statusDotColor(ch.status)}
                isSelected={selectedChannelId === ch.id}
                onClick={() => onSelectChannel(ch.id)}
                unreadCount={ch.unreadCount}
                badge="teammate"
                badgeColor="#06B6D4"
              />
            ))}
          </>
        )}

        {/* Active workers */}
        {activeWorkerChannels.length > 0 && (
          <>
            <SectionLabel>ACTIVE</SectionLabel>
            {activeWorkerChannels.map((ch) => (
              <ChannelButton
                key={ch.id}
                icon={<Wrench size={12} weight="fill" />}
                label={ch.label}
                statusColor={workerStatusDot(ch.attemptId)}
                isSelected={selectedChannelId === ch.id}
                onClick={() => onSelectChannel(ch.id)}
                unreadCount={ch.unreadCount}
                badge={ch.phaseLabel ?? undefined}
              />
            ))}
          </>
        )}

        {/* Completed workers */}
        {completedWorkerChannels.length > 0 && (
          <>
            <button
              className="flex w-full items-center gap-1 px-2 pt-2 pb-0.5"
              style={{ ...LABEL_STYLE }}
              onClick={onToggleCompletedCollapsed}
            >
              <CaretRight
                size={10}
                weight="bold"
                style={{
                  transform: completedCollapsed ? "rotate(0deg)" : "rotate(90deg)",
                  transition: "transform 100ms",
                }}
              />
              COMPLETED ({completedWorkerChannels.length})
            </button>
            {!completedCollapsed &&
              completedWorkerChannels.map((ch) => (
                <ChannelButton
                  key={ch.id}
                  icon={<Wrench size={12} weight="regular" />}
                  label={ch.label}
                  statusColor={STATUS_GRAY}
                  isSelected={selectedChannelId === ch.id}
                  onClick={() => onSelectChannel(ch.id)}
                  unreadCount={ch.unreadCount}
                  badge={ch.phaseLabel ?? undefined}
                />
              ))}
          </>
        )}

        {channels.length <= 1 && (
          <div className="px-2 py-4 text-center text-[10px]" style={{ color: TEXT_MUTED }}>
            No worker channels yet
          </div>
        )}
      </div>
    </aside>
  );
});

// ── Private helpers ──

const STATUS_DOT: Record<string, string> = {
  active: STATUS_GREEN,
  closed: STATUS_GRAY,
};

function statusDotColor(status: string): string {
  return STATUS_DOT[status] ?? STATUS_GRAY;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="px-2 pt-2 pb-0.5"
      style={{
        fontSize: 10,
        fontWeight: 700,
        fontFamily: "'Space Grotesk', sans-serif",
        textTransform: "uppercase",
        letterSpacing: "1px",
        color: TEXT_DIM,
      }}
    >
      {children}
    </div>
  );
}

function ChannelButton({
  icon,
  label,
  statusColor,
  isSelected,
  onClick,
  unreadCount,
  badge,
  badgeColor,
}: {
  icon: React.ReactNode;
  label: string;
  statusColor: string;
  isSelected: boolean;
  onClick: () => void;
  unreadCount: number;
  badge?: string;
  badgeColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left transition-colors"
      style={
        isSelected
          ? { background: `${ACCENT}12`, borderLeft: `3px solid ${ACCENT}`, color: TEXT_PRIMARY }
          : { color: TEXT_MUTED }
      }
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "#1A1720";
      }}
      onMouseLeave={(e) => {
        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <div className="flex w-full items-center gap-1.5">
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: statusColor }}
        />
        <span className="shrink-0" style={{ color: isSelected ? ACCENT : TEXT_MUTED }}>
          {icon}
        </span>
        <span className="truncate text-[11px]">{label}</span>
        {unreadCount > 0 && (
          <span
            className="ml-auto shrink-0 px-1 py-0.5 text-[9px] font-semibold"
            style={{ background: ACCENT, color: BG_PAGE }}
          >
            {unreadCount}
          </span>
        )}
      </div>
      {badge && (
        <div className="flex items-center gap-1 pl-5">
          {badgeColor ? (
            <span
              className="inline-flex items-center gap-0.5 px-1 py-0 text-[8px] font-bold uppercase tracking-[0.5px]"
              style={{ background: `${badgeColor}18`, color: badgeColor, border: `1px solid ${badgeColor}30` }}
            >
              {badge}
            </span>
          ) : (
            <span
              className="inline-flex items-center px-1 py-0 text-[8px] font-bold uppercase tracking-[0.5px]"
              style={{ background: `${ACCENT}12`, color: ACCENT, border: `1px solid ${ACCENT}25` }}
            >
              {badge}
            </span>
          )}
        </div>
      )}
    </button>
  );
}
