import React from "react";
import { Warning } from "@phosphor-icons/react";
import { Dialog } from "../ui/dialog";
import {
  formatPushDivergenceMessage,
  formatPushDivergenceTitle,
  type DivergenceWarning,
} from "../../../shared/laneDivergence";
import { COLORS, LABEL_STYLE, MONO_FONT } from "./laneDesignTokens";

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
  if (!warning) return null;

  // Cancel is the safe default: it takes focus, and Escape picks it.
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={formatPushDivergenceTitle(warning)}
      description={formatPushDivergenceMessage(warning)}
      tone="warning"
      icon
      width={520}
      actions={[
        { label: "Cancel", onClick: onCancel, variant: "secondary", autoFocus: true, disabled: busy },
        { label: "Push anyway", onClick: onConfirm, variant: "solid", disabled: busy },
      ]}
    >
      <div className="flex items-center gap-1.5" style={{ ...LABEL_STYLE, color: COLORS.warning }}>
        <Warning size={11} weight="bold" />
        <span>BRANCH ON ANOTHER MACHINE</span>
      </div>
      <div
        className="mt-1.5 truncate"
        style={{
          padding: "8px 10px",
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          fontFamily: MONO_FONT,
          fontSize: 11,
          color: COLORS.textPrimary,
        }}
      >
        {warning.branchRef}
      </div>
    </Dialog>
  );
}
