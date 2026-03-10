/**
 * ChatInput — the input bar at the bottom of MissionChatV2.
 *
 * Contains quick-target chips, a contextual helper banner for
 * worker channels, the MentionInput, and a "sending…" indicator.
 */
import React from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { MentionInput, type MentionParticipant } from "../shared/MentionInput";
import type { Channel } from "./ChatChannelList";

// ── Design tokens ──
const MONO = MONO_FONT;
const BG_MAIN = COLORS.cardBg;
const ACCENT = COLORS.accent;
const BORDER = "#2a2535";
const TEXT_PRIMARY = COLORS.textPrimary;
const TEXT_MUTED = COLORS.textMuted;
const STATUS_GREEN = COLORS.success;
const STATUS_GRAY = "#6b7280";
const STATUS_RED = COLORS.danger;

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
  sending: boolean;
  chatBlocked: boolean;
  participants: MentionParticipant[];
  quickTargets: QuickTarget[];
  onInputChange: (value: string) => void;
  onSend: (message: string, mentions: string[]) => void;
  onAppendMentionTarget: (targetId: string) => void;
};

export const ChatInput = React.memo(function ChatInput({
  selectedChannel,
  input,
  sending,
  chatBlocked,
  participants,
  quickTargets,
  onInputChange,
  onSend,
  onAppendMentionTarget,
}: ChatInputProps) {
  return (
    <div style={{ borderTop: `1px solid ${BORDER}` }}>
      {quickTargets.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1 px-3 py-1.5"
          style={{ borderBottom: `1px solid ${BORDER}`, background: BG_MAIN }}
        >
          <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Targets</span>
          {quickTargets.map((target) => (
            <button
              key={target.id}
              type="button"
              onClick={() => onAppendMentionTarget(target.id)}
              disabled={sending || chatBlocked}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{
                background: `${ACCENT}10`,
                border: `1px solid ${ACCENT}18`,
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
              {target.label !== target.id && (
                <span style={{ color: TEXT_MUTED }}>{target.label}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {selectedChannel?.kind === "worker" && !chatBlocked && (
        <div
          className="px-3 py-1.5 text-[10px]"
          style={{
            borderBottom: `1px solid ${BORDER}`,
            background: BG_MAIN,
            color: TEXT_MUTED,
            fontFamily: MONO,
          }}
        >
          Messages here steer the active worker. If it is between turns, ADE keeps the note queued
          on this worker thread until the worker can pick it up.
        </div>
      )}

      <MentionInput
        value={input}
        onChange={onInputChange}
        onSend={onSend}
        participants={participants}
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
      />

      {sending && (
        <div
          className="flex items-center gap-1 px-3 pb-1 text-[10px]"
          style={{ color: TEXT_MUTED }}
        >
          <SpinnerGap size={10} className="animate-spin" />
          Sending...
        </div>
      )}
    </div>
  );
});
