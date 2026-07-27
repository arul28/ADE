import React, { useEffect, useRef } from "react";
import { Warning } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import {
  formatPushDivergenceMessage,
  formatPushDivergenceTitle,
  type DivergenceWarning,
} from "../../../shared/laneDivergence";
import { COLORS, LABEL_STYLE, MONO_FONT, outlineButton } from "./laneDesignTokens";

/**
 * The one interruption in the cross-machine design: another machine holds this
 * branch at a commit that this push would strand. Warning-toned, not an error —
 * pushing is still allowed, it just stops being silent.
 */
export function PushDivergenceDialog({
  warning,
  busy = false,
  onCancel,
  onConfirm,
}: {
  warning: DivergenceWarning;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = warning != null;

  // Cancel is the safe default: it takes focus, and Escape picks it.
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!warning) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      role="dialog"
      aria-modal="true"
      aria-label={formatPushDivergenceTitle(warning)}
    >
      <div
        style={{
          width: "min(520px, 100%)",
          background: COLORS.cardBgSolid,
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          border: "1px solid color-mix(in srgb, var(--color-warning) 32%, transparent)",
          borderRadius: 16,
          padding: 20,
        }}
      >
        <div className="flex items-center gap-1.5" style={{ ...LABEL_STYLE, color: COLORS.warning }}>
          <Warning size={11} weight="bold" />
          <span>BRANCH ON ANOTHER MACHINE</span>
        </div>
        <div style={{ marginTop: 10, fontSize: 13, color: COLORS.textPrimary }}>
          {formatPushDivergenceTitle(warning)}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5 }}>
          {formatPushDivergenceMessage(warning)}
        </div>
        <div
          className="mt-2.5 truncate"
          style={{
            padding: "8px 10px",
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 12,
            fontFamily: MONO_FONT,
            fontSize: 11,
            color: COLORS.textPrimary,
          }}
        >
          {warning.branchRef}
        </div>
        <div className="flex justify-end gap-2" style={{ marginTop: 12 }}>
          <button
            ref={cancelRef}
            type="button"
            className={cn(busy && "pointer-events-none opacity-50")}
            style={outlineButton({ height: 30, padding: "0 10px", fontSize: 11 })}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            style={{
              ...outlineButton({ height: 30, padding: "0 10px", fontSize: 11 }),
              color: COLORS.warning,
              background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-warning) 38%, transparent)",
            }}
            onClick={onConfirm}
          >
            Push anyway
          </button>
        </div>
      </div>
    </div>
  );
}
