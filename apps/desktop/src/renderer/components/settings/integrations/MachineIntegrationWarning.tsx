/**
 * The one line on Settings › Integrations that says a computer of the account
 * is not getting an integration the rest have. Hidden while every computer is
 * fine, which is nearly always: MCP servers and most sign-ins follow the
 * account, so a problem on one computer is the exception worth a line.
 *
 * Today it reads ADE MCP, whose status already reports each computer (one
 * account-level call through this desktop's brain, no pin, read once when the
 * page opens; the ADE MCP page owns refreshing). A failed read shows nothing:
 * the web client and a brain still starting refuse it by design, and the ADE
 * MCP page explains its own errors.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RemoteMcpStatus } from "../../../../shared/types/remoteMcp";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { useBannerDismissals } from "../../../lib/bannerDismiss";
import { Banner } from "../../ui/notice/Banner";
import { machinesNeedingAttention, type MachineNeedingAttention } from "../adeMcp/adeMcpState";

/** How many computers the line names before it says "and N more". */
const NAMED_MAX = 3;

const DISMISS_KEY = "integrations-machine-warning";

function machineName(entry: MachineNeedingAttention, startOfSentence = false): string {
  if (!entry.machine.isThisMachine) return entry.machine.name;
  return startOfSentence ? "This computer" : "this computer";
}

export function MachineIntegrationWarning() {
  const navigate = useNavigate();
  const dismissals = useBannerDismissals();
  const [needing, setNeeding] = useState<MachineNeedingAttention[]>([]);

  const { clear: clearDismissal } = dismissals;
  useEffect(() => {
    const call = window.ade?.remoteMcpCall;
    if (!isAdeAvailable(call)) return;
    let cancelled = false;
    call<RemoteMcpStatus>("getStatus", undefined, null)
      .then((status) => {
        if (cancelled) return;
        const next = machinesNeedingAttention(status);
        setNeeding(next);
        // Every computer recovered: forget the dismissal, so the same trouble
        // coming back later is shown again. A failed read keeps it.
        if (next.length === 0) clearDismissal(DISMISS_KEY);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [clearDismissal]);

  // Dismissed until a different computer, or a different trouble, shows up.
  const fingerprint = needing.map((entry) => `${entry.machine.machineKey}:${entry.state.label}`).sort().join("|");
  if (needing.length === 0 || dismissals.isDismissed(DISMISS_KEY, fingerprint)) return null;

  const [first] = needing;
  const title = needing.length === 1
    ? `ADE MCP isn't working on ${machineName(first)}`
    : `ADE MCP isn't working on ${needing.length} of your computers`;
  const detail = needing.length === 1
    ? `${first.state.label}. ${first.state.detail}`
    : needing.slice(0, NAMED_MAX).map((entry) => `${machineName(entry, true)}: ${entry.state.label}`).join(" · ")
      + (needing.length > NAMED_MAX ? ` · and ${needing.length - NAMED_MAX} more` : "");

  return (
    // Hidden during a Settings search, which is looking for something else.
    <div className="ade-ix-machine-warning">
      <Banner
        layout="inline"
        testId="integrations-machine-warning"
        onDurableDismiss={({ key, fingerprint: shown }) => dismissals.dismiss(key, shown)}
        model={{
          id: DISMISS_KEY,
          tone: needing.some((entry) => entry.state.tone === "crit") ? "error" : "warning",
          title,
          detail,
          // A computer's state, not a failure of this page: no "Report".
          report: false,
          actions: [{ label: "Open ADE MCP", onClick: () => navigate("/settings?tab=ade-mcp") }],
          dismiss: { key: DISMISS_KEY, fingerprint },
        }}
      />
    </div>
  );
}
