import { formatAgo } from "../../../lib/format";
import type { DashMac } from "./cloudDashboardModel";

/**
 * The line under a Mac row in the DAEX Cloud table: the server's sentence for
 * where the Mac is (nothing while it runs) and its drive as the last stop
 * saved it. What a stop keeps is said once, in `CloudMacExplainer`.
 * Reads only the row it is given; no load of its own.
 */
export function CloudMacRowNote({ mac, now }: { mac: DashMac; now: number }) {
  const failed = mac.phase === "start_failed" || mac.phase === "drive_lost";
  const drive = mac.phase === "stopped" && mac.drive
    ? `Drive ${mac.drive}${mac.savedAt != null ? `, saved ${formatAgo(mac.savedAt, now)}` : ""}.`
    : null;
  const parts = [mac.phase === "running" ? null : mac.sentence, drive].filter(Boolean);
  if (!parts.length) return null;
  return (
    <div className="adecd-row-note" data-tone={failed ? "warn" : undefined} role="presentation">
      {parts.join(" ")}
    </div>
  );
}
