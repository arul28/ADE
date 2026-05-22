import { ArrowSquareOut } from "@phosphor-icons/react";

import type { PrCheck } from "../../../../shared/types/prs";
import { COLORS, MONO_FONT, healthColor } from "../../lanes/laneDesignTokens";
import { formatDurationMs } from "../../../lib/format";

type CheckGroup = "ci" | "security" | "bots" | "other";

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

export type PrCheckListSummary = {
  total: number;
  passing: number;
  failing: number;
  pending: number;
};

export function summarizeChecks(checks: PrCheck[]): PrCheckListSummary {
  let passing = 0;
  let failing = 0;
  let pending = 0;
  for (const check of checks) {
    if (check.status !== "completed") {
      pending += 1;
      continue;
    }
    if (check.conclusion === "failure" || check.conclusion === "cancelled") {
      failing += 1;
    } else if (check.conclusion === "success") {
      passing += 1;
    }
  }
  return { total: checks.length, passing, failing, pending };
}

export type PrCheckListProps = {
  checks: PrCheck[];
  onOpenLog: (check: PrCheck) => void;
  onSelectCheck?: (check: PrCheck) => void;
  onOpenChecksTab?: () => void;
  emptyMessage?: string;
};

export function PrCheckList({
  checks,
  onOpenLog,
  onSelectCheck,
  onOpenChecksTab,
  emptyMessage = "No checks have reported yet.",
}: PrCheckListProps) {
  const grouped: Record<CheckGroup, PrCheck[]> = { ci: [], security: [], bots: [], other: [] };
  for (const check of checks) {
    grouped[groupCheck(check)].push(check);
  }

  if (checks.length === 0) {
    return (
      <div className="px-3 py-4 text-[11px]" style={{ color: COLORS.textDim }}>
        {emptyMessage}
      </div>
    );
  }

  const blocks: Array<{ label: string; key: CheckGroup }> = [
    { label: "CI", key: "ci" },
    { label: "Bots", key: "bots" },
    { label: "Security", key: "security" },
    { label: "Other", key: "other" },
  ];
  return (
    <div className="flex flex-col pb-2">
      {blocks.map(({ label, key }) => (
        <CheckGroupBlock
          key={key}
          label={label}
          checks={grouped[key]}
          onOpenLog={onOpenLog}
          onSelectCheck={onSelectCheck}
          onOpenChecksTab={onOpenChecksTab}
        />
      ))}
    </div>
  );
}

function CheckGroupBlock({
  label,
  checks,
  onOpenLog,
  onSelectCheck,
  onOpenChecksTab,
}: {
  label: string;
  checks: PrCheck[];
  onOpenLog: (check: PrCheck) => void;
  onSelectCheck?: (check: PrCheck) => void;
  onOpenChecksTab?: () => void;
}) {
  if (checks.length === 0) return null;
  const sectionInteractive = Boolean(onOpenChecksTab);
  return (
    <div className="px-2.5 pb-1 pt-0.5" data-testid={`pr-check-group-${label.toLowerCase()}`}>
      <button
        type="button"
        disabled={!sectionInteractive}
        onClick={() => onOpenChecksTab?.()}
        className="w-full px-1 pb-1 text-left text-[9px] font-bold uppercase tracking-[1px] transition-colors"
        style={{
          color: COLORS.textMuted,
          fontFamily: MONO_FONT,
          cursor: sectionInteractive ? "pointer" : "default",
          background: "transparent",
          border: "none",
        }}
      >
        {label}
      </button>
      <div className="flex flex-col">
        {checks.map((check) => (
          <CheckRow
            key={`${label}-${check.name}`}
            check={check}
            onOpenLog={onOpenLog}
            onSelectCheck={onSelectCheck}
          />
        ))}
      </div>
    </div>
  );
}

function CheckRow({
  check,
  onOpenLog,
  onSelectCheck,
}: {
  check: PrCheck;
  onOpenLog: (check: PrCheck) => void;
  onSelectCheck?: (check: PrCheck) => void;
}) {
  const duration = durationMs(check);
  const rowInteractive = Boolean(onSelectCheck);
  return (
    <div
      role={rowInteractive ? "button" : undefined}
      tabIndex={rowInteractive ? 0 : undefined}
      onClick={rowInteractive ? () => onSelectCheck?.(check) : undefined}
      onKeyDown={
        rowInteractive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectCheck?.(check);
              }
            }
          : undefined
      }
      className="flex items-center gap-2 py-1.5"
      data-testid="pr-status-rail-check-row"
      data-check-name={check.name}
      style={{ cursor: rowInteractive ? "pointer" : "default" }}
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
        onClick={(event) => {
          event.stopPropagation();
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
