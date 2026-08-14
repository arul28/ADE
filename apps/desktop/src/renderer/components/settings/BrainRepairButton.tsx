import type { BrainRepair } from "../../hooks/useBrainRepair";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";

/**
 * The Repair control, shared by every surface that renders a brain-side
 * account-session failure. Height is the only thing call sites vary; the
 * horizontal padding is unified here rather than drifting per surface.
 */
export function BrainRepairButton({
  repair,
  height,
  disabled = false,
}: {
  repair: BrainRepair;
  height: number;
  /** Extra disable, e.g. while a sibling Reconnect is in flight. */
  disabled?: boolean;
}) {
  const blocked = repair.pending || disabled;
  return (
    <>
      <button
        type="button"
        disabled={blocked}
        onClick={repair.run}
        style={{
          ...outlineButton({ height, padding: "0 9px", fontSize: 11, flexShrink: 0 }),
          opacity: blocked ? 0.6 : 1,
        }}
      >
        {repair.pending ? "Repairing…" : "Repair"}
      </button>
      {repair.error ? (
        <span
          style={{ color: COLORS.warning, fontFamily: SANS_FONT, fontSize: 11 }}
          title={repair.error}
        >
          Repair failed — quit and reopen ADE.
        </span>
      ) : repair.notice ? (
        <span
          style={{
            color: repair.notice.tone === "ok" ? COLORS.textSecondary : COLORS.warning,
            fontFamily: SANS_FONT,
            fontSize: 11,
          }}
        >
          {repair.notice.text}
        </span>
      ) : null}
    </>
  );
}
