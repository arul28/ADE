/**
 * ValidationFindings — rolls up the structured findings emitted by the
 * validation panel (recordValidationRun's `findings`) into a single
 * severity-ranked table (Blocker / High / Medium / Low). Each Blocker/High
 * either shows its named regression-test target or a "needs a test" nudge,
 * tying the /quality dual-review to the /test regression-pinning step.
 *
 * Pure presentation over `manifest.validationStrategy.checklist[].runs[].findings`.
 */

import { useMemo } from "react";
import { ListChecks, TestTube } from "@phosphor-icons/react";
import type {
  OrchestrationManifest,
  ValidationFinding,
  ValidationFindingSeverity,
} from "../../../shared/types/orchestration";
import { SectionHeader } from "./PanelChrome";

const SEVERITY_ORDER: ValidationFindingSeverity[] = ["blocker", "high", "medium", "low"];

const SEVERITY_STYLE: Record<ValidationFindingSeverity, { bg: string; fg: string; label: string }> = {
  blocker: { bg: "rgba(239, 68, 68, 0.14)", fg: "rgb(252, 165, 165)", label: "Blocker" },
  high: { bg: "rgba(251, 146, 60, 0.14)", fg: "rgb(253, 186, 116)", label: "High" },
  medium: { bg: "rgba(250, 204, 21, 0.12)", fg: "rgb(254, 240, 138)", label: "Medium" },
  low: { bg: "rgba(255,255,255,0.06)", fg: "rgba(255,255,255,0.6)", label: "Low" },
};

function collectFindings(manifest: OrchestrationManifest | null): ValidationFinding[] {
  if (!manifest) return [];
  const out: ValidationFinding[] = [];
  const seen = new Set<string>();
  for (const item of manifest.validationStrategy.checklist) {
    const latest = item.runs.find((r) => r.id === item.latestRunId) ?? item.runs[item.runs.length - 1];
    for (const finding of latest?.findings ?? []) {
      if (seen.has(finding.id)) continue;
      seen.add(finding.id);
      out.push(finding);
    }
  }
  return out.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

function SeverityPill({ severity }: { severity: ValidationFindingSeverity }) {
  const style = SEVERITY_STYLE[severity];
  return (
    <span
      className="inline-flex shrink-0 items-center rounded px-1.5 py-[1px] font-mono text-[9px] font-semibold uppercase tracking-wide"
      style={{ background: style.bg, color: style.fg }}
    >
      {style.label}
    </span>
  );
}

export function ValidationFindings({ manifest }: { manifest: OrchestrationManifest | null }) {
  const findings = useMemo(() => collectFindings(manifest), [manifest]);
  if (!findings.length) return null;

  const counts = findings.reduce<Record<ValidationFindingSeverity, number>>(
    (acc, f) => {
      acc[f.severity] += 1;
      return acc;
    },
    { blocker: 0, high: 0, medium: 0, low: 0 },
  );

  return (
    <div
      data-testid="orchestration-validation-findings"
      className="mt-4 border-t border-white/[0.05] px-3 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <SectionHeader icon={<ListChecks size={11} weight="duotone" />}>Findings</SectionHeader>
        <span className="font-mono text-[10px] tabular-nums text-muted-fg/55">
          {SEVERITY_ORDER.filter((s) => counts[s] > 0)
            .map((s) => `${counts[s]} ${SEVERITY_STYLE[s].label.toLowerCase()}`)
            .join(" · ")}
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {findings.map((f) => {
          const needsTest = f.severity === "blocker" || f.severity === "high";
          return (
            <li
              key={f.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-white/[0.05] bg-white/[0.015] px-2 py-1.5"
            >
              <SeverityPill severity={f.severity} />
              <span className="min-w-0 flex-1 font-sans text-[11.5px] leading-snug text-fg/80">
                {f.title}
              </span>
              {f.locus ? (
                <span className="font-mono text-[10px] text-fg/50" title={f.locus}>
                  {f.locus}
                </span>
              ) : null}
              {f.regressionTestTarget ? (
                <span
                  className="inline-flex items-center gap-1 rounded border border-emerald-300/25 bg-emerald-300/10 px-1.5 py-[1px] font-mono text-[9px] text-emerald-100/85"
                  title="Pinned regression test"
                >
                  <TestTube size={10} weight="duotone" />
                  {f.regressionTestTarget}
                </span>
              ) : needsTest ? (
                <span className="inline-flex items-center rounded border border-amber-300/25 bg-amber-300/[0.08] px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-wide text-amber-100/80">
                  needs a test
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
