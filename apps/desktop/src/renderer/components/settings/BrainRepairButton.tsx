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
}: {
  repair: BrainRepair;
  height: number;
}) {
  return (
    <>
      <button
        type="button"
        disabled={repair.pending}
        onClick={repair.run}
        style={{
          ...outlineButton({ height, padding: "0 9px", fontSize: 11, flexShrink: 0 }),
          opacity: repair.pending ? 0.6 : 1,
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
      ) : null}
    </>
  );
}
