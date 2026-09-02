/**
 * The text behind "Copy diagnostics" on a provider page.
 *
 * One paste has to answer "what does this machine think about this provider",
 * so it carries the status word and message, the version, every left-rail fact
 * (binary path, config home, credential source), the last auth probe error, and
 * — where the vendor ships one — the output of its own `doctor`.
 *
 * Absent facts are named rather than omitted: a missing line reads as "not
 * checked", which is a different claim from "not found".
 */

import type { AcpProviderDiagnostics } from "../../../../shared/types/config";
import type { ProviderFact, ProviderStatusView } from "./types";

export function formatProviderDiagnosticsReport(args: {
  label: string;
  status: ProviderStatusView;
  version: string | null;
  facts: ProviderFact[];
  acp: AcpProviderDiagnostics | null;
}): string {
  const lines = [
    `provider: ${args.label}`,
    `status: ${args.status.label} — ${args.status.message}`,
    `version: ${args.version ?? args.acp?.versionError ?? "unknown"}`,
  ];
  for (const fact of args.facts) {
    lines.push(`${fact.label.toLowerCase()}: ${fact.value}`);
  }
  const probeError = args.acp?.lastProbe && args.acp.lastProbe.state !== "ready"
    ? `${args.acp.lastProbe.state} — ${args.acp.lastProbe.message ?? "no detail"}`
    : args.status.errorLine ?? null;
  lines.push(`last error: ${probeError ?? "none"}`);
  if (args.acp) {
    lines.push(`binary source: ${args.acp.binarySource}`);
    lines.push(`checked at: ${args.acp.checkedAt}`);
  }
  if (args.acp?.doctor) {
    lines.push(
      "",
      `$ ${args.acp.doctor.command}  (exit ${args.acp.doctor.exitCode ?? "none"})`,
      args.acp.doctor.output,
    );
  }
  return lines.join("\n");
}
