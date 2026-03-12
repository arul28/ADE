/**
 * ChatInput — the input bar at the bottom of MissionChatV2.
 *
 * Contains quick-target chips, a contextual helper banner for
 * worker channels, the MentionInput, and a "sending…" indicator.
 */
import React from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import type { AgentChatFileRef } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { MentionInput, type MentionParticipant } from "../shared/MentionInput";
import type { Channel } from "./ChatChannelList";

// ── Design tokens ──
const MONO = MONO_FONT;
const BG_MAIN = COLORS.cardBg;
const BG_ELEVATED = "#130f1c";
const BORDER = "#2a2535";
const TEXT_PRIMARY = COLORS.textPrimary;
const TEXT_SECONDARY = COLORS.textSecondary;
const TEXT_MUTED = COLORS.textMuted;
const STATUS_GREEN = COLORS.success;
const STATUS_GRAY = "#6b7280";
const STATUS_RED = COLORS.danger;
const WARNING = COLORS.warning;

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  fontFamily: SANS_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: TEXT_MUTED,
};

export type QuickTarget = {
  id: string;
  label: string;
  status: "active" | "completed" | "failed";
  helper: string;
};

export type ChatInputProps = {
  selectedChannel: Channel | undefined;
  input: string;
  attachments: AgentChatFileRef[];
  sending: boolean;
  chatBlocked: boolean;
  participants: MentionParticipant[];
  quickTargets: QuickTarget[];
  onInputChange: (value: string) => void;
  onSend: (message: string, mentions: string[]) => void;
  onAppendMentionTarget: (targetId: string) => void;
  onPickAttachments: () => void | Promise<void>;
  onRemoveAttachment: (attachmentPath: string) => void;
};

export const ChatInput = React.memo(function ChatInput({
  selectedChannel,
  input,
  attachments,
  sending,
  chatBlocked,
  participants,
  quickTargets,
  onInputChange,
  onSend,
  onAppendMentionTarget,
  onPickAttachments,
  onRemoveAttachment,
}: ChatInputProps) {
  const surfaceMode = selectedChannel?.kind === "global" ? "mission-feed" : "mission-thread";
  const channelHelper = (() => {
    switch (selectedChannel?.kind) {
      case "global":
        return "Use @orchestrator, @all, or an active worker handle to route notes from the mission feed.";
      case "orchestrator":
        return "Steer the coordinator with constraints, priorities, or recovery directions.";
      case "teammate":
        return `Send a direct note to ${selectedChannel.label} without leaving the mission thread.`;
      case "worker":
        return selectedChannel.status === "active"
          ? `This worker thread is live. ADE will queue the note if the worker is between turns.`
          : "This worker thread is history-only, so new notes will not be delivered.";
      default:
        return "Send guidance into the active mission thread.";
    }
  })();

  const channelStateLabel = (() => {
    if (!selectedChannel) return "Mission chat";
    if (selectedChannel.kind === "global") return "Mission feed";
    if (selectedChannel.kind === "orchestrator") return "Coordinator lane";
    if (selectedChannel.kind === "teammate") return "Direct teammate thread";
    return selectedChannel.status === "active" ? "Live worker thread" : "Worker history";
  })();

  return (
    <div
      className="px-4 pb-4 pt-3"
      style={{
        background: `linear-gradient(180deg, ${BG_MAIN} 0%, ${BG_ELEVATED} 100%)`,
      }}
    >
      <div
        className="mb-3 flex flex-wrap items-start gap-3 px-4 py-3"
        style={{
          border: `1px solid ${BORDER}`,
          background: `${BG_MAIN}CC`,
          boxShadow: "0 18px 48px rgba(4, 2, 10, 0.32)",
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span style={LABEL_STYLE}>Compose</span>
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em]"
              style={{
                border: "1px solid color-mix(in srgb, var(--chat-accent) 18%, rgba(255,255,255,0.08))",
                background: "color-mix(in srgb, var(--chat-accent) 10%, transparent)",
                color: TEXT_PRIMARY,
                fontFamily: MONO,
              }}
            >
              {channelStateLabel}
            </span>
            {chatBlocked ? (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em]"
                style={{
                  border: `1px solid ${WARNING}28`,
                  background: `${WARNING}12`,
                  color: WARNING,
                  fontFamily: MONO,
                }}
              >
                Read only
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[12px] leading-[1.55]" style={{ color: TEXT_SECONDARY }}>
            {channelHelper}
          </div>
        </div>

        {quickTargets.length > 0 ? (
          <div className="flex min-w-0 flex-wrap justify-end gap-1.5">
            {quickTargets.map((target) => (
              <button
                key={target.id}
                type="button"
                onClick={() => onAppendMentionTarget(target.id)}
                disabled={sending || chatBlocked}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{
                  background: "color-mix(in srgb, var(--chat-accent) 9%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--chat-accent) 16%, rgba(255,255,255,0.08))",
                  color: TEXT_PRIMARY,
                  fontFamily: MONO,
                }}
                title={target.helper}
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor:
                      target.status === "failed"
                        ? STATUS_RED
                        : target.status === "completed"
                          ? STATUS_GRAY
                          : STATUS_GREEN,
                  }}
                />
                <span>@{target.id}</span>
                {target.label !== target.id ? (
                  <span style={{ color: TEXT_MUTED }}>{target.label}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <MentionInput
        value={input}
        onChange={onInputChange}
        onSend={onSend}
        participants={participants}
        attachments={attachments}
        onPickAttachments={onPickAttachments}
        onRemoveAttachment={onRemoveAttachment}
        placeholder={(() => {
          switch (selectedChannel?.kind) {
            case "global":
              return "Message global (use @mention to target)...";
            case "orchestrator":
              return "Message the orchestrator...";
            case "teammate":
              return `Message teammate ${selectedChannel?.label ?? ""}...`;
            case "worker":
              return selectedChannel.status === "active"
                ? `Steer worker ${selectedChannel?.label ?? ""}...`
                : `This worker thread is history-only...`;
            default:
              return `Message ${selectedChannel?.fullLabel ?? "worker"}...`;
          }
        })()}
        disabled={sending || chatBlocked}
        autoFocus
        surfaceMode={surfaceMode}
        footerHint={selectedChannel?.kind === "worker" && !chatBlocked
          ? "Worker notes queue automatically if the session is busy."
          : "Press Enter to send. Shift+Enter keeps a newline."}
      />

      {sending && (
        <div
          className="flex items-center gap-1 px-1 pt-2 text-[10px]"
          style={{ color: TEXT_MUTED, fontFamily: MONO }}
        >
          <SpinnerGap size={10} className="animate-spin" />
          Sending...
        </div>
      )}
    </div>
  );
});
