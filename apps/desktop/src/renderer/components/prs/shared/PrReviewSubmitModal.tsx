import { ChatText, CheckCircle, Warning, X } from "@phosphor-icons/react";

import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";

export type PrReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type PrReviewSubmitModalProps = {
  open: boolean;
  actionBusy: boolean;
  reviewBody: string;
  setReviewBody: (value: string) => void;
  reviewEvent: PrReviewEvent;
  setReviewEvent: (value: PrReviewEvent) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

export function PrReviewSubmitModal({
  open,
  actionBusy,
  reviewBody,
  setReviewBody,
  reviewEvent,
  setReviewEvent,
  onCancel,
  onSubmit,
}: PrReviewSubmitModalProps) {
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 16, padding: 24, width: 500, maxHeight: "80vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 15, fontWeight: 600, color: COLORS.textPrimary }}>Submit Review</span>
          <button type="button" onClick={onCancel} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: 4 }}><X size={16} /></button>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          {(["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const).map((event) => {
            const isSelected = reviewEvent === event;
            const eventColor = event === "APPROVE" ? COLORS.success : event === "REQUEST_CHANGES" ? COLORS.warning : COLORS.info;
            return (
              <button key={event} type="button" onClick={() => setReviewEvent(event)} style={{
                ...outlineButton(),
                flex: 1,
                height: 36,
                background: isSelected ? `${eventColor}18` : "transparent",
                borderColor: isSelected ? `${eventColor}60` : COLORS.border,
                color: isSelected ? eventColor : COLORS.textSecondary,
                boxShadow: isSelected ? `0 0 12px ${eventColor}15` : "none",
              }}>
                {event === "APPROVE" && <CheckCircle size={14} weight={isSelected ? "fill" : "regular"} />}
                {event === "REQUEST_CHANGES" && <Warning size={14} weight={isSelected ? "fill" : "regular"} />}
                {event === "COMMENT" && <ChatText size={14} weight={isSelected ? "fill" : "regular"} />}
                {event === "APPROVE" ? "Approve" : event === "REQUEST_CHANGES" ? "Request Changes" : "Comment"}
              </button>
            );
          })}
        </div>
        <textarea
          value={reviewBody}
          onChange={(event) => setReviewBody(event.target.value)}
          placeholder="Leave a review comment (optional for approve)..."
          style={{
            width: "100%",
            minHeight: 120,
            resize: "vertical",
            padding: 14,
            fontFamily: SANS_FONT,
            fontSize: 13,
            color: COLORS.textPrimary,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            outline: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14, gap: 8 }}>
          <button type="button" onClick={onCancel} style={outlineButton({ height: 36 })}>Cancel</button>
          <button type="button" onClick={onSubmit} disabled={actionBusy} style={{
            ...primaryButton({
              background: reviewEvent === "APPROVE" ? `linear-gradient(135deg, ${COLORS.success} 0%, #16a34a 100%)` : reviewEvent === "REQUEST_CHANGES" ? `linear-gradient(135deg, ${COLORS.warning} 0%, #d97706 100%)` : `linear-gradient(135deg, ${COLORS.accent} 0%, #7c3aed 100%)`,
              height: 36,
              boxShadow:
                reviewEvent === "APPROVE"
                  ? "0 2px 12px color-mix(in srgb, var(--color-success) 19%, transparent)"
                  : reviewEvent === "REQUEST_CHANGES"
                    ? "0 2px 12px color-mix(in srgb, var(--color-warning) 19%, transparent)"
                    : "0 2px 12px color-mix(in srgb, var(--color-accent) 19%, transparent)",
            }),
            color: "#fff",
          }}>
            {actionBusy ? "Submitting..." : `Submit ${reviewEvent === "APPROVE" ? "Approval" : reviewEvent === "REQUEST_CHANGES" ? "Changes Request" : "Comment"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
