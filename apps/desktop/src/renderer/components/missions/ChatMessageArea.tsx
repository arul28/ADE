/**
 * ChatMessageArea — the main message display area inside MissionChatV2.
 *
 * Renders a channel header bar, notice / blocked banners, and the
 * message list (delegating to MissionThreadMessageList).
 */
import React, { useMemo } from "react";
import {
  Crown,
  Database,
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
import { relativeWhen } from "../../lib/format";
import { MissionThreadMessageList } from "./MissionThreadMessageList";
import type { Channel } from "./ChatChannelList";
import { getMissionInterventionOwnerLabel } from "./missionHelpers";
import type { MissionStateNarrative } from "./missionFeedPresentation";
import type { ChatMcpSummary } from "../chat/useChatMcpSummary";

// ── Design tokens ──
const MONO = MONO_FONT;
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
  missionNarrative: MissionStateNarrative | null;
  runtimeSummary: { title: string; detail: string } | null;
  agentRuntimeConfig: MissionAgentRuntimeConfig | null;
  mcpSummary: ChatMcpSummary | null;
  onOpenMcpSettings: () => void;
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
  missionNarrative,
  runtimeSummary,
  agentRuntimeConfig,
  mcpSummary,
  onOpenMcpSettings,
  onApproval,
}: ChatMessageAreaProps) {
  const threadInterventionOwnerLabel = useMemo(
    () => getMissionInterventionOwnerLabel(threadIntervention),
    [threadIntervention],
  );
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
  const channelSummary = (() => {
    if (!selectedChannel) return "Mission chat";
    switch (selectedChannel.kind) {
      case "global":
        return "Signal and raw mission traffic stay visible here, including routed user notes and coordinator updates.";
      case "orchestrator":
        return "Message the coordinator directly for planning changes, recovery guidance, and run-level direction.";
      case "teammate":
        return "Direct teammate thread for specialist collaboration without leaving the mission surface.";
      case "worker":
        return selectedChannel.status === "active"
          ? "Live worker thread. Notes here stay pinned to this execution lane."
          : "Worker history thread. Review the transcript even after the worker has finished.";
      default:
        return "Mission chat";
    }
  })();
  const headerIcon = (() => {
    switch (selectedChannel?.kind) {
      case "global":
        return <Globe size={16} weight="fill" />;
      case "orchestrator":
        return <Crown size={16} weight="fill" />;
      case "teammate":
        return <UsersThree size={16} weight="fill" />;
      case "worker":
        return <Wrench size={16} weight="fill" />;
      default:
        return <Globe size={16} weight="fill" />;
    }
  })();
  const headerStatusColor =
    selectedChannel?.kind === "orchestrator"
      ? STATUS_DOT[selectedChannel.status] ?? STATUS_GRAY
      : workerStatusDot(selectedChannel?.attemptId ?? null);

  return (
    <>
      {/* Header */}
      <div
        className="border-b px-4 py-4"
        style={{
          borderBottomColor: BORDER,
          background: "linear-gradient(180deg, rgba(20,16,29,0.96) 0%, rgba(13,10,20,0.92) 100%)",
        }}
      >
        <div className="flex flex-wrap items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center border"
            style={{
              borderColor: "color-mix(in srgb, var(--chat-accent) 18%, rgba(255,255,255,0.08))",
              background: "color-mix(in srgb, var(--chat-accent) 10%, transparent)",
              color: TEXT_PRIMARY,
            }}
          >
            {headerIcon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="truncate text-[13px] font-semibold"
                style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
              >
                {channelHeaderName}
              </span>
              {selectedChannel && selectedChannel.kind !== "global" ? (
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: headerStatusColor }}
                />
              ) : null}
              <ChannelKindBadge channel={selectedChannel} />
              {runtimeSummary && selectedChannel?.kind === "global" ? (
                <HeaderMetaPill label={runtimeSummary.title} detail={runtimeSummary.detail} />
              ) : null}
            </div>
            <div className="mt-1 text-[12px] leading-[1.55]" style={{ color: TEXT_SECONDARY }}>
              {channelSummary}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {mcpSummary ? (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] transition-opacity hover:opacity-90"
                style={{
                  background: "color-mix(in srgb, var(--chat-accent) 10%, transparent)",
                  color: TEXT_SECONDARY,
                  border: "1px solid color-mix(in srgb, var(--chat-accent) 18%, rgba(255,255,255,0.08))",
                  fontFamily: MONO,
                }}
                onClick={onOpenMcpSettings}
                title="Open External MCP settings"
              >
                <Database size={10} weight="bold" />
                {mcpSummary.connectedCount > 0
                  ? `MCP ${mcpSummary.connectedCount}/${mcpSummary.configuredCount}`
                  : mcpSummary.configuredCount > 0
                    ? `MCP ${mcpSummary.configuredCount} configured`
                    : "MCP setup"}
              </button>
            ) : null}
            {agentRuntimeConfig && selectedChannel?.kind !== "worker" ? (
              <>
                <RuntimeFlagPill label="Parallel" enabled={agentRuntimeConfig.allowParallelAgents} />
                <RuntimeFlagPill label="Sub-agents" enabled={agentRuntimeConfig.allowSubAgents} />
                <RuntimeFlagPill label="Claude teams" enabled={agentRuntimeConfig.allowClaudeAgentTeams} />
              </>
            ) : null}
          </div>
        </div>
      </div>

      {missionNarrative && selectedChannel?.kind === "global" && (
        <div
          className="flex items-start gap-3 px-3 py-2"
          style={{
            borderBottom: `1px solid ${BORDER}`,
            background: `${severityColorForNarrative(missionNarrative.severity)}10`,
          }}
        >
          <span
            className="mt-1 inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: severityColorForNarrative(missionNarrative.severity) }}
          />
          <div className="min-w-0 flex-1">
            <div
              className="text-[10px] font-bold uppercase tracking-[0.12em]"
              style={{ color: TEXT_MUTED, fontFamily: MONO }}
            >
              Mission state
            </div>
            <div className="mt-0.5 text-[11px] font-semibold" style={{ color: TEXT_PRIMARY }}>
              {missionNarrative.title}
            </div>
            <div className="mt-0.5 text-[11px] leading-[1.45]" style={{ color: TEXT_SECONDARY }}>
              {missionNarrative.detail}
            </div>
          </div>
          {missionNarrative.at ? (
            <span className="shrink-0 text-[10px]" style={{ color: TEXT_MUTED }}>
              {relativeWhen(missionNarrative.at)}
            </span>
          ) : null}
        </div>
      )}

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
              {threadInterventionOwnerLabel
                ? `${threadInterventionOwnerLabel} needs attention`
                : "This conversation needs attention"}
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

function workerBadgeLabel(status: string, phaseLabel: string | null): string {
  const suffix = status === "active" ? "worker" : "history";
  const fallback = status === "active" ? "Active worker" : "Worker history";
  return phaseLabel ? `${phaseLabel} ${suffix}` : fallback;
}

function ChannelKindBadge({ channel }: { channel: Channel | undefined }) {
  if (!channel) return null;
  if (channel.kind === "orchestrator") {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
        style={{ background: "#3B82F618", color: "#60A5FA", border: "1px solid #3B82F630" }}
      >
        <Crown size={10} weight="fill" />
        Orchestrator
      </span>
    );
  }
  if (channel.kind === "teammate") {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
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
        className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
        style={{ background: "#8B5CF618", color: "#8B5CF6", border: "1px solid #8B5CF630" }}
      >
        <Wrench size={10} weight="fill" />
        {workerBadgeLabel(channel.status, channel.phaseLabel)}
      </span>
    );
  }
  return null;
}

function HeaderMetaPill({ label, detail }: { label: string; detail: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
      style={{
        background: "color-mix(in srgb, var(--chat-accent) 10%, transparent)",
        color: TEXT_SECONDARY,
        border: "1px solid color-mix(in srgb, var(--chat-accent) 16%, rgba(255,255,255,0.08))",
        fontFamily: MONO,
      }}
      title={detail}
    >
      <Globe size={10} weight="fill" />
      {label}
    </span>
  );
}

function RuntimeFlagPill({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
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

function severityColorForNarrative(severity: MissionStateNarrative["severity"]): string {
  switch (severity) {
    case "success":
      return COLORS.success;
    case "warning":
      return COLORS.warning;
    case "error":
      return COLORS.danger;
    default:
      return COLORS.accent;
  }
}
