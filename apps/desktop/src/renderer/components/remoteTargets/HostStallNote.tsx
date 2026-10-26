import { Snowflake } from "@phosphor-icons/react";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { describeHostStall } from "../../../shared/connectionDiagnosis";
import type { RemoteRuntimeHostStall } from "../../../shared/types";

/** A freeze older than this no longer explains anything the user sees. */
export const HOST_STALL_NOTE_WINDOW_MS = 10 * 60_000;

/**
 * "Studio froze for 12s 2 min ago. Its CPU is overloaded (load 21 on 8 cores)."
 *
 * The machine says so itself when it is reached again; from here a frozen
 * machine and a dropped network both looked like silence. Shown under the
 * machine's row, in the row's own warning style.
 */
export function HostStallNote({
  stall,
  machineName,
  now = Date.now(),
}: {
  stall: RemoteRuntimeHostStall | null | undefined;
  machineName: string | null | undefined;
  now?: number;
}) {
  if (!stall) return null;
  const agoMs = Math.max(0, now - stall.endedAt);
  if (agoMs > HOST_STALL_NOTE_WINDOW_MS) return null;
  const summary = describeHostStall({ ...stall, agoMs }, machineName);
  return (
    <div
      role="status"
      style={{ display: "flex", gap: 6, fontFamily: SANS_FONT, fontSize: 12 }}
    >
      <Snowflake size={14} weight="bold" color={COLORS.warning} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ color: COLORS.warning }}>{summary.title}.</span>{" "}
        <span style={{ color: COLORS.textMuted }}>{summary.detail}</span>
      </span>
    </div>
  );
}
