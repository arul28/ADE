/**
 * The one line on Settings › Integrations that says a computer of the account
 * is not getting an integration the rest have. Hidden while every computer is
 * fine, which is nearly always: MCP servers and most sign-ins follow the
 * account, so a problem on one computer is the exception worth a line.
 *
 * Today it reads ADE MCP, whose status already reports each computer (one
 * account-level call through this desktop's brain, no pin, read once when the
 * page opens; the ADE MCP page owns refreshing). A stuck computer there is
 * what ADE-237 looked like from the outside.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RemoteMcpStatus } from "../../../../shared/types/remoteMcp";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { Banner } from "../../ui/notice/Banner";
import { machinesNeedingAttention, type MachineNeedingAttention } from "../adeMcp/adeMcpState";

/** How many computers the line names before it says "and N more". */
const NAMED_MAX = 3;

function machineName(entry: MachineNeedingAttention): string {
  return entry.machine.isThisMachine ? "this computer" : entry.machine.name;
}

export function MachineIntegrationWarning() {
  const navigate = useNavigate();
  const [needing, setNeeding] = useState<MachineNeedingAttention[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const call = window.ade?.remoteMcpCall;
    if (!isAdeAvailable(call)) return;
    let cancelled = false;
    call<RemoteMcpStatus>("getStatus", undefined, null)
      .then((status) => { if (!cancelled) setNeeding(machinesNeedingAttention(status)); })
      // Nothing to warn about when the status can't be read; the ADE MCP page says why.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  if (dismissed || needing.length === 0) return null;

  const [first] = needing;
  const title = needing.length === 1
    ? `ADE MCP isn't working on ${machineName(first)}`
    : `ADE MCP isn't working on ${needing.length} of your computers`;
  const detail = needing.length === 1
    ? `${first.state.label}. ${first.state.detail}`
    : needing.slice(0, NAMED_MAX).map((entry) => `${entry.machine.isThisMachine ? "This computer" : entry.machine.name}: ${entry.state.label}`).join(" · ")
      + (needing.length > NAMED_MAX ? ` · and ${needing.length - NAMED_MAX} more` : "");

  return (
    <Banner
      layout="inline"
      testId="integrations-machine-warning"
      model={{
        id: "integrations-machine-warning",
        tone: needing.some((entry) => entry.state.tone === "crit") ? "error" : "warning",
        title,
        detail,
        // A computer's state, not a failure of this page: no "Report".
        report: false,
        actions: [{ label: "Open ADE MCP", onClick: () => navigate("/settings?tab=ade-mcp") }],
        dismiss: { onDismiss: () => setDismissed(true) },
      }}
    />
  );
}
