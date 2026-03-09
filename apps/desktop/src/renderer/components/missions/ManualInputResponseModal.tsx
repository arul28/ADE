import React, { useCallback, useMemo, useState } from "react";
import { ChatCircle, Warning, X } from "@phosphor-icons/react";
import type { MissionIntervention } from "../../../shared/types";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

export type ManualInputResponseModalProps = {
  intervention: MissionIntervention;
  onClose: () => void;
  onSubmit: (answer: string) => Promise<void>;
};

export function ManualInputResponseModal({
  intervention,
  onClose,
  onSubmit,
}: ManualInputResponseModalProps) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const metadata = intervention.metadata ?? null;
  const canProceedWithoutAnswer = metadata?.canProceedWithoutAnswer === true;
  const workerDeliveryFailure = metadata?.workerDeliveryFailure === true;
  const phaseLabel = typeof metadata?.phaseName === "string" && metadata.phaseName.trim().length > 0
    ? metadata.phaseName.trim()
    : typeof metadata?.phase === "string" && metadata.phase.trim().length > 0
      ? metadata.phase.trim()
      : null;
  const urgencyLabel = typeof metadata?.urgency === "string" && metadata.urgency.trim().length > 0
    ? metadata.urgency.trim().toUpperCase()
    : null;

  const statusTone = useMemo(() => {
    if (workerDeliveryFailure) {
      return {
        border: `${COLORS.warning}35`,
        background: `${COLORS.warning}12`,
        color: COLORS.warning,
        copy: "A worker message could not be delivered live. ADE kept the note on the worker thread and is asking how you want the mission to recover.",
      };
    }
    if (canProceedWithoutAnswer) {
      return {
        border: `${COLORS.accent}35`,
        background: `${COLORS.accent}12`,
        color: COLORS.accent,
        copy: "Optional question. The mission can continue, but your answer will tighten the result.",
      };
    }
    return {
      border: `${COLORS.warning}35`,
      background: `${COLORS.warning}12`,
      color: COLORS.warning,
      copy: "Coordinator is waiting on this answer before it should keep going.",
    };
  }, [canProceedWithoutAnswer, workerDeliveryFailure]);

  const handleSubmit = useCallback(async () => {
    const trimmed = answer.trim();
    if (!trimmed.length) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } finally {
      setSubmitting(false);
    }
  }, [answer, onSubmit]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.7)",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: COLORS.pageBg,
          border: `1px solid ${COLORS.border}`,
          width: "100%",
          maxWidth: 640,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: `1px solid ${COLORS.border}`,
            background: COLORS.cardBg,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ChatCircle weight="bold" style={{ color: COLORS.accent, width: 16, height: 16 }} />
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "1px",
                color: COLORS.accent,
              }}
            >
              {workerDeliveryFailure ? "Worker Message Recovery" : "Coordinator Input"}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{ color: COLORS.textMuted, background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <div style={{ padding: 16, overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {phaseLabel ? (
              <span style={{ ...LABEL_STYLE, color: COLORS.textDim }}>
                PHASE: {phaseLabel.toUpperCase()}
              </span>
            ) : null}
            {urgencyLabel ? (
              <span style={{ ...LABEL_STYLE, color: COLORS.textDim }}>
                URGENCY: {urgencyLabel}
              </span>
            ) : null}
          </div>

          <div
            style={{
              border: `1px solid ${statusTone.border}`,
              background: statusTone.background,
              color: statusTone.color,
              padding: "10px 12px",
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
            }}
          >
            <Warning weight="fill" style={{ width: 14, height: 14, marginTop: 1, flexShrink: 0 }} />
            <div style={{ fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5 }}>
              {statusTone.copy}
            </div>
          </div>

          <div>
            <div style={{ ...LABEL_STYLE, color: COLORS.textMuted, marginBottom: 6 }}>
              REQUEST
            </div>
            <div style={{ fontFamily: SANS_FONT, fontSize: 14, color: COLORS.textPrimary, lineHeight: 1.6 }}>
              {intervention.title}
            </div>
          </div>

          <div>
            <div style={{ ...LABEL_STYLE, color: COLORS.textMuted, marginBottom: 6 }}>
              DETAILS
            </div>
            <div
              style={{
                fontFamily: MONO_FONT,
                fontSize: 12,
                color: COLORS.textSecondary,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.border}`,
                padding: "12px 14px",
                lineHeight: 1.6,
              }}
            >
              {intervention.body}
            </div>
          </div>

          {intervention.requestedAction ? (
            <div>
              <div style={{ ...LABEL_STYLE, color: COLORS.textMuted, marginBottom: 6 }}>
                {workerDeliveryFailure ? "RECOVERY GUIDANCE" : "WHAT TO DO"}
              </div>
              <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                {intervention.requestedAction}
              </div>
            </div>
          ) : null}

          <div>
            <div style={{ ...LABEL_STYLE, color: COLORS.textMuted, marginBottom: 6 }}>
              {workerDeliveryFailure ? "HOW ADE SHOULD RECOVER" : "YOUR ANSWER"}
            </div>
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder={workerDeliveryFailure
                ? "Tell ADE how to recover: reroute through the coordinator, leave the note queued, or retry when the worker is active again."
                : "Type the answer you want the mission to follow..."}
              style={{
                width: "100%",
                minHeight: 140,
                resize: "vertical",
                padding: "12px 14px",
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                color: COLORS.textPrimary,
                fontFamily: MONO_FONT,
                fontSize: 12,
                lineHeight: 1.6,
                outline: "none",
              }}
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 16px",
            borderTop: `1px solid ${COLORS.border}`,
            background: COLORS.cardBg,
          }}
        >
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
            {workerDeliveryFailure
              ? "Send recovery guidance only if you want ADE to retry or redirect the stale worker message."
              : canProceedWithoutAnswer
                ? "You can close this if you want the mission to keep its current assumptions."
                : "Send an answer to unblock the mission cleanly."}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button style={outlineButton()} onClick={onClose} disabled={submitting}>
              CLOSE
            </button>
            <button
              style={primaryButton()}
              onClick={() => void handleSubmit()}
              disabled={submitting || !answer.trim()}
            >
              {submitting ? "SENDING..." : "SEND ANSWER"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
