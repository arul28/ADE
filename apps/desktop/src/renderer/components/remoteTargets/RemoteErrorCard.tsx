import { useState, type CSSProperties } from "react";
import { ArrowClockwise, CaretDown, CaretRight, Warning } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import type { MachineErrorCard } from "./remoteMachineModel";

const detailBoxStyle: CSSProperties = {
  maxHeight: 168,
  overflow: "auto",
  padding: "8px 10px",
  borderRadius: 6,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(0,0,0,0.28)",
  color: COLORS.textSecondary,
  fontFamily: MONO_FONT,
  fontSize: 11,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  userSelect: "text",
};

type RemoteErrorCardProps = {
  card: MachineErrorCard;
  onRetry?: () => void;
  retrying?: boolean;
};

/**
 * Human-first failure surface. The plain-language message leads; the raw,
 * capped technical detail hides behind a "Show technical details" expander
 * (the only place monospace is warranted). A Try again button re-runs connect.
 */
export function RemoteErrorCard({ card, onRetry, retrying }: RemoteErrorCardProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  // Writes through the main process rather than `navigator.clipboard`, which
  // the remote pane cannot rely on. Clipboard may be unavailable; on failure
  // the detail stays visible to copy manually.
  const { copy, copied } = useCopyToClipboard({
    write: async (text) => {
      const writeText = window.ade?.app?.writeClipboardText;
      if (!writeText) return false;
      await writeText(text);
      return true;
    },
  });

  return (
    <div
      style={{
        display: "grid",
        gap: 10,
        borderRadius: 8,
        border: `1px solid color-mix(in srgb, ${COLORS.danger} 32%, transparent)`,
        background: `color-mix(in srgb, ${COLORS.danger} 8%, transparent)`,
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          color: COLORS.danger,
          fontFamily: SANS_FONT,
          fontSize: 12.5,
          lineHeight: 1.45,
          fontWeight: 600,
        }}
      >
        <Warning size={15} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} />
        <span>{card.message}</span>
      </div>

      {card.detail ? (
        <div style={{ display: "grid", gap: 8 }}>
          <button
            type="button"
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((open) => !open)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              justifySelf: "start",
              padding: 0,
              border: "none",
              background: "transparent",
              color: COLORS.textMuted,
              fontFamily: SANS_FONT,
              fontSize: 11.5,
              cursor: "pointer",
            }}
          >
            {detailOpen ? (
              <CaretDown size={12} weight="bold" />
            ) : (
              <CaretRight size={12} weight="bold" />
            )}
            Show technical details
          </button>
          {detailOpen ? (
            <div style={{ display: "grid", gap: 6 }}>
              <div style={detailBoxStyle}>{card.detail}</div>
              <button
                type="button"
                onClick={() => void copy(card.detail ?? "")}
                style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11, justifySelf: "start" })}
              >
                {copied ? "Copied" : "Copy details"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {onRetry ? (
        <button
          type="button"
          disabled={retrying}
          onClick={onRetry}
          style={{
            ...outlineButton({ height: 30, padding: "0 12px", fontSize: 11, justifySelf: "start" }),
            opacity: retrying ? 0.6 : 1,
          }}
        >
          <ArrowClockwise size={13} weight="bold" />
          {retrying ? "Retrying…" : "Try again"}
        </button>
      ) : null}
    </div>
  );
}
