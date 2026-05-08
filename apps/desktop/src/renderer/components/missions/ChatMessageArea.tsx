/**
 * ChatMessageArea — the main message display area inside MissionChatV2.
 *
 * Renders a channel header bar, notice / blocked banners, and the
 * message list (delegating to MissionThreadMessageList).
 */
import React, { useMemo } from "react";
import {
  Crown,
  UsersThree,
  Wrench,
  Globe,
} from "@phosphor-icons/react";
import type {
  MissionIntervention,
  OrchestratorChatMessage,
} from "../../../shared/types";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";
import { MissionThreadMessageList } from "./MissionThreadMessageList";
import type { Channel } from "./ChatChannelList";
import { getMissionInterventionOwnerLabel } from "./missionHelpers";
import type { MissionStateNarrative } from "./missionFeedPresentation";

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
  threadMessagesLoading: boolean;
  threadMessagesLoadingMore: boolean;
  threadMessagesError: string | null;
  threadMessagesHasMore: boolean;
  onLoadOlderMessages: () => void;
  onRetryMessages: () => void;
  missionNarrative: MissionStateNarrative | null;
  runControls?: React.ReactNode;
  onApproval: (
    sessionId: string,
    itemId: string,
    decision: "accept" | "accept_for_session" | "decline" | "cancel",
    responseText?: string | null,
    answers?: Record<string, string | string[]>,
  ) => void;
};

export function shouldPollRawMissionTranscript(channel: Channel | undefined): boolean {
  if (!channel || channel.status !== "active") return false;
  return channel.kind === "worker" || channel.kind === "teammate";
}

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
  threadMessagesLoading,
  threadMessagesLoadingMore,
  threadMessagesError,
  threadMessagesHasMore,
  onLoadOlderMessages,
  onRetryMessages,
  missionNarrative,
  runControls,
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
        return "Read-only status updates from ADE, the coordinator, workers, and recovery flow.";
      case "orchestrator":
        return "Messages here go to the mission coordinator. Worker threads stay separate.";
      case "teammate":
        return "Messages here go to this teammate thread only.";
      case "worker":
        return selectedChannel.status === "active"
          ? "Messages here go to this worker while it is running in the mission lane."
          : "Read-only worker transcript. Send new direction to the coordinator or rerun.";
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
  const channelRoute = (() => {
    if (!selectedChannel || selectedChannel.kind === "global") {
      return {
        label: "Read-only feed",
        detail: "Mission Feed summarizes events; it does not send messages to an agent.",
        tone: "muted" as const,
      };
    }
    if (chatBlocked || selectedChannel.status !== "active") {
      return {
        label: "Transcript only",
        detail: chatBlocked ? `${chatBlocked.reason} ${chatBlocked.action}` : "This thread is no longer live.",
        tone: "muted" as const,
      };
    }
    if (selectedChannel.kind === "orchestrator") {
      return {
        label: "Sends to coordinator",
        detail: "Messages in this thread are sent to the mission coordinator.",
        tone: "active" as const,
      };
    }
    if (selectedChannel.kind === "teammate") {
      return {
        label: "Sends to teammate",
        detail: "Messages in this thread are sent to this teammate only.",
        tone: "active" as const,
      };
    }
    return {
      label: "Sends to worker",
      detail: "Messages in this thread are sent to this worker only.",
      tone: "active" as const,
    };
  })();

  return (
    <>
      {/* Header */}
      <div
        className="min-w-0 max-w-full overflow-hidden border-b px-4 py-4"
        style={{
          borderBottomColor: BORDER,
          background: "linear-gradient(180deg, rgba(20,16,29,0.96) 0%, rgba(13,10,20,0.92) 100%)",
        }}
      >
        <div className="grid grid-cols-[auto,minmax(0,1fr)] items-start gap-x-3 gap-y-2">
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
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className="min-w-0 max-w-full truncate text-[13px] font-semibold"
                style={{ color: TEXT_PRIMARY, fontFamily: MONO }}
                title={channelHeaderName}
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
              <ChannelRouteBadge route={channelRoute} />
            </div>
            <div className="mt-1 text-[12px] leading-[1.55]" style={{ color: TEXT_SECONDARY }}>
              {channelSummary}
            </div>
          </div>
          <div className="col-start-2 flex min-w-0 flex-wrap gap-1.5">
            {runControls}
          </div>
        </div>
      </div>

      {missionNarrative && selectedChannel?.kind === "global" && (
        <div
          className="flex min-w-0 max-w-full items-start gap-3 overflow-hidden px-3 py-2"
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
          className="min-w-0 max-w-full overflow-hidden px-3 py-1.5 text-[10px]"
          style={{ borderBottom: `1px solid ${WARNING}30`, background: `${WARNING}12`, color: WARNING }}
        >
          {jumpNotice}
        </div>
      )}

      {threadIntervention && (
        <div
          className="flex min-w-0 max-w-full items-start justify-between gap-3 overflow-hidden px-3 py-2"
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
            minWidth: 0,
            maxWidth: "100%",
            overflow: "hidden",
          }}
        >
          <span style={{ fontSize: "14px" }}>{"\u26A0"}</span>
          <span className="min-w-0 break-words">
            {(chatBlocked ?? chatNotice)?.reason} {(chatBlocked ?? chatNotice)?.action}
          </span>
        </div>
      )}

      {selectedChannel && selectedChannel.kind !== "global" && (threadMessagesLoading || threadMessagesError || threadMessagesHasMore) ? (
        <div
          className="flex min-w-0 max-w-full items-center justify-between gap-3 overflow-hidden px-3 py-1.5 text-[10px]"
          style={{
            borderBottom: `1px solid ${BORDER}`,
            background: "rgba(9, 7, 14, 0.62)",
            color: TEXT_MUTED,
            fontFamily: MONO,
          }}
        >
          <span className="min-w-0 truncate">
            {threadStatusLabel(threadMessagesLoading, threadMessagesError, threadMessagesHasMore)}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {threadMessagesError ? (
              <button
                type="button"
                className="border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]"
                style={{ borderColor: `${WARNING}45`, color: WARNING }}
                onClick={onRetryMessages}
              >
                Retry
              </button>
            ) : null}
            {threadMessagesHasMore ? (
              <button
                type="button"
                className="border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] disabled:opacity-55"
                style={{ borderColor: "color-mix(in srgb, var(--chat-accent) 30%, transparent)", color: "var(--chat-accent)" }}
                onClick={onLoadOlderMessages}
                disabled={threadMessagesLoadingMore}
                aria-label={threadMessagesLoadingMore ? "Loading older mission thread messages" : "Load older mission thread messages"}
              >
                {threadMessagesLoadingMore ? "Loading..." : "Load older"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Message list */}
      <MissionThreadMessageList
        messages={displayMessages}
        sessionId={selectedChannel?.sessionId ?? null}
        showStreamingIndicator={
          selectedChannel?.kind === "global" ? false : showStreamingIndicator
        }
        transcriptPollingEnabled={shouldPollRawMissionTranscript(selectedChannel)}
        className="flex-1"
        onApproval={onApproval}
      />
    </>
  );
});

// ── Small helper components ──

function threadStatusLabel(loading: boolean, error: string | null, hasMore: boolean): string {
  if (loading) return "Loading thread messages...";
  if (error) return error;
  if (hasMore) return "Older messages available.";
  return "";
}

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

function ChannelRouteBadge({
  route,
}: {
  route: { label: string; detail: string; tone: "active" | "muted" };
}) {
  const active = route.tone === "active";
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
      style={{
        background: active ? "#22C55E18" : "#6B728018",
        color: active ? "#22C55E" : TEXT_MUTED,
        border: `1px solid ${active ? "#22C55E30" : "#6B728030"}`,
        fontFamily: MONO,
      }}
      title={route.detail}
    >
      {route.label}
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
