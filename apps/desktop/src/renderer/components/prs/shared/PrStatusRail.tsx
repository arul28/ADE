import { memo, useMemo } from "react";
import { ArrowSquareOut, GitMerge, Warning, CheckCircle, Clock } from "@phosphor-icons/react";

import type { PrCheck, PrDeployment } from "../../../../shared/types/prs";
import { COLORS, MONO_FONT, healthColor } from "../../lanes/laneDesignTokens";
import { formatDurationMs } from "../../../lib/format";
import { PrDeploymentCard } from "./PrDeploymentCard";

export type PrStatusRailMergeState = {
  mergeable: "clean" | "dirty" | "unknown";
  hasConflicts: boolean;
  approvals: number;
  requiredApprovals: number | null;
  failingChecks: number;
  pendingChecks: number;
  githubUrl: string | null;
};

type CheckGroup = "ci" | "security" | "bots" | "other";

export type PrStatusRailProps = {
  checks: PrCheck[];
  deployments: PrDeployment[];
  mergeState: PrStatusRailMergeState;
  onOpenLog: (check: PrCheck) => void;
  onOpenExternal: (url: string) => void;
};

const SECURITY_KEYWORDS = ["codeql", "snyk", "dependabot", "trivy", "security", "sast"];
const BOT_KEYWORDS = ["bot", "greptile", "coderabbit", "sonarcloud", "sonarqube", "codecov"];

function groupCheck(check: PrCheck): CheckGroup {
  const name = check.name.toLowerCase();
  if (SECURITY_KEYWORDS.some((k) => name.includes(k))) return "security";
  if (BOT_KEYWORDS.some((k) => name.includes(k))) return "bots";
  if (name.includes("ci") || name.includes("build") || name.includes("test") || name.includes("lint")) {
    return "ci";
  }
  return "other";
}

function checkDotColor(check: PrCheck): string {
  if (check.status !== "completed") return COLORS.warning;
  switch (check.conclusion) {
    case "success":
      return healthColor("healthy");
    case "failure":
    case "cancelled":
      return healthColor("unhealthy");
    case "neutral":
    case "skipped":
      return COLORS.textDim;
    default:
      return COLORS.textMuted;
  }
}

function durationMs(check: PrCheck): number | null {
  if (!check.startedAt) return null;
  const end = check.completedAt ? Date.parse(check.completedAt) : Date.now();
  const start = Date.parse(check.startedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

export const PrStatusRail = memo(function PrStatusRail({
  checks,
  deployments,
  mergeState,
  onOpenLog,
  onOpenExternal,
}: PrStatusRailProps) {
  const grouped = useMemo(() => {
    const groups: Record<CheckGroup, PrCheck[]> = { ci: [], security: [], bots: [], other: [] };
    for (const check of checks) {
      groups[groupCheck(check)].push(check);
    }
    return groups;
  }, [checks]);

  return (
    <div
      data-testid="pr-status-rail"
      className="relative flex h-full w-full flex-col overflow-y-auto"
      style={{ background: COLORS.cardBg, borderLeft: `1px solid ${COLORS.border}` }}
    >
      <RailSection title="Checks">
        {checks.length === 0 ? (
          <EmptyRow>No checks have reported yet.</EmptyRow>
        ) : (
          <>
            <CheckGroupBlock
              label="CI"
              checks={grouped.ci}
              onOpenLog={onOpenLog}
              onOpenExternal={onOpenExternal}
            />
            <CheckGroupBlock
              label="Bots"
              checks={grouped.bots}
              onOpenLog={onOpenLog}
              onOpenExternal={onOpenExternal}
            />
            <CheckGroupBlock
              label="Security"
              checks={grouped.security}
              onOpenLog={onOpenLog}
              onOpenExternal={onOpenExternal}
            />
            <CheckGroupBlock
              label="Other"
              checks={grouped.other}
              onOpenLog={onOpenLog}
              onOpenExternal={onOpenExternal}
            />
          </>
        )}
      </RailSection>

      <RailSection title="Deployments">
        {deployments.length === 0 ? (
          <EmptyRow>No active deployments.</EmptyRow>
        ) : (
          <div className="flex flex-col gap-1.5 px-2.5 pb-2">
            {deployments.map((d) => (
              <PrDeploymentCard key={d.id} deployment={d} />
            ))}
          </div>
        )}
      </RailSection>

      <RailSection title="Merge">
        <MergeSummary mergeState={mergeState} onOpenExternal={onOpenExternal} />
      </RailSection>
    </div>
  );
});

function RailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{ borderBottom: `1px solid ${COLORS.border}` }}
      data-testid={`pr-status-rail-section-${title.toLowerCase()}`}
    >
      <div
        className="flex items-center px-2.5 pt-2.5"
        style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
      >
        <span className="text-[10px] font-bold uppercase tracking-[1px]">{title}</span>
      </div>
      <div className="pt-1.5 pb-2">{children}</div>
    </section>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1 text-[11px]" style={{ color: COLORS.textDim }}>
      {children}
    </div>
  );
}

function CheckGroupBlock({
  label,
  checks,
  onOpenLog,
  onOpenExternal,
}: {
  label: string;
  checks: PrCheck[];
  onOpenLog: (check: PrCheck) => void;
  onOpenExternal: (url: string) => void;
}) {
  if (checks.length === 0) return null;
  return (
    <div className="px-2.5 pb-1 pt-0.5">
      <div
        className="px-1 pb-1 text-[9px] font-bold uppercase tracking-[1px]"
        style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}
      >
        {label}
      </div>
      <div className="flex flex-col">
        {checks.map((check) => (
          <CheckRow
            key={`${label}-${check.name}`}
            check={check}
            onOpenLog={onOpenLog}
            onOpenExternal={onOpenExternal}
          />
        ))}
      </div>
    </div>
  );
}

function CheckRow({
  check,
  onOpenLog,
  onOpenExternal,
}: {
  check: PrCheck;
  onOpenLog: (check: PrCheck) => void;
  onOpenExternal: (url: string) => void;
}) {
  const duration = durationMs(check);
  return (
    <div
      className="flex items-center gap-2 py-1.5"
      data-testid="pr-status-rail-check-row"
      data-check-name={check.name}
    >
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: checkDotColor(check) }}
      />
      <span
        className="min-w-0 flex-1 truncate text-[11px]"
        style={{ color: COLORS.textPrimary }}
      >
        {check.name}
      </span>
      {duration != null ? (
        <span
          className="text-[10px]"
          style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}
        >
          {formatDurationMs(duration)}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => {
          if (check.detailsUrl) {
            onOpenLog(check);
          }
        }}
        disabled={!check.detailsUrl}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] transition-colors"
        style={{
          color: check.detailsUrl ? COLORS.accent : COLORS.textDim,
          cursor: check.detailsUrl ? "pointer" : "not-allowed",
          fontFamily: MONO_FONT,
        }}
        aria-label={`View logs for ${check.name}`}
      >
        logs
        <ArrowSquareOut size={9} weight="regular" />
      </button>
    </div>
  );
}

function MergeSummary({
  mergeState,
  onOpenExternal,
}: {
  mergeState: PrStatusRailMergeState;
  onOpenExternal: (url: string) => void;
}) {
  const approvalsNeeded =
    mergeState.requiredApprovals != null &&
    mergeState.approvals < mergeState.requiredApprovals;

  return (
    <div className="flex flex-col gap-1.5 px-2.5 pb-2">
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.textPrimary }}>
        {mergeState.hasConflicts ? (
          <>
            <Warning size={12} weight="fill" style={{ color: COLORS.danger }} />
            <span style={{ color: COLORS.danger }}>Conflicts with base</span>
          </>
        ) : mergeState.mergeable === "clean" ? (
          <>
            <CheckCircle size={12} weight="fill" style={{ color: COLORS.success }} />
            <span>Ready to merge</span>
          </>
        ) : mergeState.mergeable === "dirty" ? (
          <>
            <Warning size={12} weight="fill" style={{ color: COLORS.warning }} />
            <span style={{ color: COLORS.warning }}>Unmergeable</span>
          </>
        ) : (
          <>
            <Clock size={12} weight="fill" style={{ color: COLORS.textMuted }} />
            <span style={{ color: COLORS.textMuted }}>Checking mergeability…</span>
          </>
        )}
      </div>

      <MergeStat
        label="Approvals"
        value={
          mergeState.requiredApprovals != null
            ? `${mergeState.approvals}/${mergeState.requiredApprovals}`
            : String(mergeState.approvals)
        }
        tone={approvalsNeeded ? "warning" : "ok"}
      />
      <MergeStat
        label="Failing"
        value={String(mergeState.failingChecks)}
        tone={mergeState.failingChecks > 0 ? "danger" : "ok"}
      />
      <MergeStat
        label="Pending"
        value={String(mergeState.pendingChecks)}
        tone={mergeState.pendingChecks > 0 ? "warning" : "ok"}
      />

      <button
        type="button"
        onClick={() => {
          if (mergeState.githubUrl) onOpenExternal(mergeState.githubUrl);
        }}
        disabled={!mergeState.githubUrl}
        className="mt-1 inline-flex h-7 items-center justify-center gap-1.5 text-[11px] font-medium transition-colors"
        style={{
          color: mergeState.githubUrl ? COLORS.accent : COLORS.textDim,
          background: mergeState.githubUrl ? COLORS.accentSubtle : "transparent",
          border: `1px solid ${mergeState.githubUrl ? COLORS.accentBorder : COLORS.border}`,
          cursor: mergeState.githubUrl ? "pointer" : "not-allowed",
        }}
      >
        <GitMerge size={11} weight="bold" />
        Merge on GitHub
        <ArrowSquareOut size={10} weight="regular" />
      </button>
    </div>
  );
}

function MergeStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warning" | "danger";
}) {
  const color =
    tone === "danger" ? COLORS.danger : tone === "warning" ? COLORS.warning : COLORS.textPrimary;
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span style={{ color: COLORS.textMuted }}>{label}</span>
      <span style={{ color, fontFamily: MONO_FONT }}>{value}</span>
    </div>
  );
}

export default PrStatusRail;
