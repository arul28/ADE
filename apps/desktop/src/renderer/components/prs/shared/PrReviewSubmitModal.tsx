import { ChatText, CheckCircle, Warning, X, type Icon } from "@phosphor-icons/react";

import { COLORS, SANS_FONT, floatingPane, outlineButton } from "../../lanes/laneDesignTokens";
import { PrMarkdownEditor } from "./PrMarkdownEditor";

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
  repoOwner: string;
  repoName: string;
};

const MODES: Array<{ event: PrReviewEvent; label: string; description: string; icon: Icon; color: string }> = [
  { event: "COMMENT", label: "Comment", description: "Submit general feedback without approval.", icon: ChatText, color: COLORS.info },
  { event: "APPROVE", label: "Approve", description: "Approve merging these changes.", icon: CheckCircle, color: COLORS.checkPass },
  { event: "REQUEST_CHANGES", label: "Request changes", description: "Request changes before this can merge.", icon: Warning, color: COLORS.warning },
];

export function PrReviewSubmitModal({
  open,
  actionBusy,
  reviewBody,
  setReviewBody,
  reviewEvent,
  setReviewEvent,
  onCancel,
  onSubmit,
  repoOwner,
  repoName,
}: PrReviewSubmitModalProps) {
  if (!open) return null;
  const active = MODES.find((m) => m.event === reviewEvent) ?? MODES[0]!;
  // Changes/Comment want a written rationale; Approve may be empty.
  const bodyRequired = reviewEvent !== "APPROVE";
  const canSubmit = !actionBusy && (!bodyRequired || reviewBody.trim().length > 0);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 16, padding: 24, width: 520, maxHeight: "84vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 15, fontWeight: 600, color: COLORS.textPrimary }}>Submit review</span>
          <button type="button" onClick={onCancel} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: 4 }} aria-label="Close"><X size={16} /></button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          {MODES.map((mode) => {
            const isSelected = reviewEvent === mode.event;
            const ModeIcon = mode.icon;
            return (
              <button
                key={mode.event}
                type="button"
                onClick={() => setReviewEvent(mode.event)}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 10, textAlign: "left",
                  padding: "10px 12px", borderRadius: 10, cursor: "pointer",
                  background: isSelected ? `color-mix(in srgb, ${mode.color} 12%, transparent)` : COLORS.recessedBg,
                  border: `1px solid ${isSelected ? `color-mix(in srgb, ${mode.color} 50%, transparent)` : COLORS.border}`,
                }}
                aria-pressed={isSelected}
              >
                <span style={{ display: "inline-flex", marginTop: 1, color: isSelected ? mode.color : COLORS.textMuted }}>
                  <ModeIcon size={16} weight={isSelected ? "fill" : "regular"} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: isSelected ? COLORS.textPrimary : COLORS.textSecondary }}>{mode.label}</span>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.4 }}>{mode.description}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div style={floatingPane({ padding: 0, overflow: "hidden", marginBottom: 6 })}>
          <PrMarkdownEditor
            value={reviewBody}
            onChange={setReviewBody}
            repoOwner={repoOwner}
            repoName={repoName}
            placeholder={reviewEvent === "APPROVE" ? "Add an optional note…" : "Explain your feedback…"}
            disabled={actionBusy}
            minHeight={120}
            maxHeight={320}
            ariaLabel="Review body"
          />
        </div>
        {bodyRequired && reviewBody.trim().length === 0 ? (
          <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>
            A comment is required for “{active.label}”.
          </span>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16, gap: 8 }}>
          <button type="button" onClick={onCancel} style={outlineButton({ height: 36 })}>Cancel</button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
              height: 36, padding: "0 16px", borderRadius: 8, border: "none",
              fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600,
              color: "#fff", background: active.color,
              cursor: canSubmit ? "pointer" : "not-allowed", opacity: canSubmit ? 1 : 0.5,
            }}
          >
            {actionBusy ? "Submitting…" : `Submit ${active.label.toLowerCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}
