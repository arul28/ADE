import type { BrainRepair } from "../../hooks/useBrainRepair";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { ReportIssueButton } from "../app/ReportIssueButton";

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
        <>
        <span
          style={{
            color: COLORS.warning,
            fontFamily: SANS_FONT,
            fontSize: 11,
            lineHeight: 1.45,
            minWidth: 0,
          }}
          title={repair.error}
        >
          {/* The main process already phrases restart failures for people
              ("A newer ADE runtime is already running — quit and reopen ADE
              instead."); hiding that behind a generic line and a tooltip
              left users with an instruction and no reason. */}
          {/* Two sentences, not an em dash: the main process hands back its own
              capitalised sentence, and joining it with a dash read as
              "Repair didn't finish — A newer ADE runtime is…". */}
          {`Repair didn't finish. ${repair.error.replace(/\.?\s*$/, ".")}`}
        </span>
        {/* One import, one element: the surrounding surfaces own their own
            layout, so this only ever appends after the failure line. */}
        <ReportIssueButton
          variant="ghost"
          context={{
            surface: "brain_repair",
            headline: "Repair didn't finish",
            technicalDetail: repair.error,
          }}
        />
        </>
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
