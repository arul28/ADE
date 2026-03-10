/**
 * ChatMessageArea — the main message display area inside MissionChatV2.
 *
 * Renders a channel header bar, notice / blocked banners, and the
 * message list (delegating to MissionThreadMessageList).
 */
import React, { useMemo } from "react";
import {
  Hash,
  Crown,
  UsersThree,
  Wrench,
  Globe,
} from "@phosphor-icons/react";
import type {
  MissionAgentRuntimeConfig,
  MissionIntervention,
  OrchestratorChatMessage,
} from "../../../shared/types";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import { MissionThreadMessageList } from "./MissionThreadMessageList";
import type { Channel } from "./ChatChannelList";

// ── Design tokens ──
const MONO = MONO_FONT;
const ACCENT = COLORS.accent;
const BORDER = "#2a2535";
const TEXT_PRIMARY = COLORS.textPrimary;
const TEXT_SECONDARY = COLORS.textSecondary;
const TEXT_MUTED = COLORS.textMuted;
const STATUS_GREEN = COLORS.success;
const STATUS_GRAY = "#6b7280";
const STATUS_RED = COLORS.danger;
const WARNING = COLORS.warning;

const STATUS_DOT: Record<string, string> = {
  active: STATUS_GREEN,
  closed: STATUS_GRAY,
  failed: STATUS_RED,
};

type ChatNotice = { reason: string; action: string } | null;

export type ChatMessageAreaProps = {
  selectedChannel: Channel | undefined;
  workerStatusDot: (attemptId: string | null) => string;
  displayMessages: OrchestratorChatMessage[];
  attemptNameMap: Map<string, string>;
  jumpNotice: string | null;
  chatNotice: ChatNotice;
  chatBlocked: ChatNotice;
  threadIntervention: MissionIntervention | null;
  onOpenIntervention: (interventionId: string) => void;
  showStreamingIndicator: boolean;
  runtimeSummary: { title: string; detail: string } | null;
  agentRuntimeConfig: MissionAgentRuntimeConfig | null;
  onApproval: (
    sessionId: string,
    itemId: string,
    decision: "accept" | "accept_for_session" | "decline" | "cancel",
    responseText?: string | null,
  ) => void;
};

export const ChatMessageArea = React.memo(function ChatMessageArea({
  selectedChannel,
  workerStatusDot,
  displayMessages,
  attemptNameMap,
  jumpNotice,
  chatNotice,
  chatBlocked,
  threadIntervention,
  onOpenIntervention,
  showStreamingIndicator,
  runtimeSummary,
  agentRuntimeConfig,
  onApproval,
}: ChatMessageAreaProps) {
  const channelHeaderName = (() => {
    if (!selectedChannel) return "...";
    switch (selectedChannel.kind) {
      case "global":
        return "Mission Feed";
      case "orchestrator":
        return "Orchestrator";
      default:
        return selectedChannel.fullLabel;
    }
  })();

  return (
    <>
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-1"
        style={{ borderBottom: `1px solid ${BORDER}` }}
      >
        <Hash size={14} weight="regular" style={{ color: TEXT_MUTED }} />
        <span
          className="min-w-0 truncate text-[11px] font-semibold"
          style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
        >
          {channelHeaderName}
        </span>
        {selectedChannel && selectedChannel.kind !== "global" && (
          <span
            className="ml-1 inline-block h-2 w-2 rounded-full"
            style={{
              backgroundColor:
                selectedChannel.kind === "orchestrator"
                  ? STATUS_DOT[selectedChannel.status] ?? STATUS_GRAY
                  : workerStatusDot(selectedChannel.attemptId),
            }}
          />
        )}
        <ChannelKindBadge channel={selectedChannel} />
        <div className="ml-auto flex items-center gap-1">
          {runtimeSummary && selectedChannel?.kind === "global" && (
            <span
              className="hidden items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px] lg:inline-flex"
              style={{
                background: `${ACCENT}10`,
                color: TEXT_SECONDARY,
                border: `1px solid ${ACCENT}18`,
                fontFamily: MONO,
              }}
              title={runtimeSummary.detail}
            >
              <Globe size={10} weight="fill" />
              {runtimeSummary.title}
            </span>
          )}
          {agentRuntimeConfig && selectedChannel?.kind !== "worker" && (
            <>
              <RuntimeFlagPill label="Parallel" enabled={agentRuntimeConfig.allowParallelAgents} />
              <RuntimeFlagPill label="Sub-agents" enabled={agentRuntimeConfig.allowSubAgents} />
              <RuntimeFlagPill label="Claude teams" enabled={agentRuntimeConfig.allowClaudeAgentTeams} />
            </>
          )}
        </div>
      </div>

      {jumpNotice && (
        <div
          className="px-3 py-1.5 text-[10px]"
          style={{ borderBottom: `1px solid ${WARNING}30`, background: `${WARNING}12`, color: WARNING }}
        >
          {jumpNotice}
        </div>
      )}

      {threadIntervention && (
        <div
          className="flex items-start justify-between gap-3 px-3 py-2"
          style={{ borderBottom: `1px solid ${WARNING}30`, background: `${WARNING}10` }}
        >
          <div className="min-w-0">
            <div
              className="text-[10px] font-bold uppercase tracking-[0.12em]"
              style={{ color: WARNING, fontFamily: MONO }}
            >
              This conversation needs attention
            </div>
            <div className="mt-1 text-[11px] font-semibold" style={{ color: TEXT_PRIMARY }}>
              {threadIntervention.title}
            </div>
            <div className="mt-1 text-[11px] leading-[1.45]" style={{ color: TEXT_SECONDARY }}>
              {threadIntervention.requestedAction?.trim() || threadIntervention.body}
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.12em]"
            style={{ color: WARNING, borderColor: `${WARNING}35`, background: `${WARNING}10` }}
            onClick={() => onOpenIntervention(threadIntervention.id)}
          >
            Open
          </button>
        </div>
      )}

      {/* Runtime availability banner */}
      {(chatNotice || chatBlocked) && (
        <div
          style={{
            background: `${WARNING}12`,
            borderBottom: `1px solid ${WARNING}30`,
            padding: "6px 12px",
            fontFamily: MONO,
            fontSize: "10px",
            color: WARNING,
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={{ fontSize: "14px" }}>{"\u26A0"}</span>
          <span>
            {(chatBlocked ?? chatNotice)?.reason} {(chatBlocked ?? chatNotice)?.action}
          </span>
        </div>
      )}

      {/* Message list */}
      <MissionThreadMessageList
        messages={displayMessages}
        sessionId={selectedChannel?.sessionId ?? null}
        showStreamingIndicator={
          selectedChannel?.kind === "global" ? false : showStreamingIndicator
        }
        transcriptPollingEnabled={selectedChannel?.kind !== "global" && selectedChannel?.status === "active"}
        className="flex-1"
        onApproval={onApproval}
      />
    </>
  );
});

// ── Small helper components ──

function ChannelKindBadge({ channel }: { channel: Channel | undefined }) {
  if (!channel) return null;
  if (channel.kind === "orchestrator") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
        style={{ background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" }}
      >
        <Crown size={10} weight="fill" />
        Orchestrator
      </span>
    );
  }
  if (channel.kind === "teammate") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
        style={{ background: "#06B6D418", color: "#06B6D4", border: "1px solid #06B6D430" }}
      >
        <UsersThree size={10} weight="fill" />
        Teammate
      </span>
    );
  }
  if (channel.kind === "worker") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
        style={{ background: "#8B5CF618", color: "#8B5CF6", border: "1px solid #8B5CF630" }}
      >
        <Wrench size={10} weight="fill" />
        {channel.status === "active"
          ? channel.phaseLabel
            ? `${channel.phaseLabel} worker`
            : "Active worker"
          : channel.phaseLabel
            ? `${channel.phaseLabel} history`
            : "Worker history"}
      </span>
    );
  }
  return null;
}

function RuntimeFlagPill({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
      style={{
        background: enabled ? "#22C55E18" : "#6B728018",
        color: enabled ? "#22C55E" : TEXT_MUTED,
        border: `1px solid ${enabled ? "#22C55E30" : "#6B728030"}`,
      }}
    >
      {label}
      <span>{enabled ? "on" : "off"}</span>
    </span>
  );
}
