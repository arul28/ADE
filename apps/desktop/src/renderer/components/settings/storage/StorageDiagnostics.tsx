import React from "react";
import { ArrowDown, ArrowUp, Gauge } from "@phosphor-icons/react";
import type {
  RuntimeHealthSnapshot,
  StorageSnapshotExtras,
} from "../../../../shared/types/storage";
import type { AppResourceUsageSnapshot } from "../../../../shared/types";
import { appResourcePressureLevel } from "../../../lib/resourcePressure";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { ModernSection } from "../primitives";
import {
  daemonMemoryBytes,
  dbSizeSamples,
  dbSizeTrend,
  formatBytes,
  formatSlowActions,
  healthChip,
  lastMaintenanceRun,
  maintenanceHeadline,
  sparklinePoints,
  type DbSizeSample,
  type Trend,
} from "./storageView";

export function TrendArrow({ trend }: { trend: Trend }) {
  if (trend === "down") {
    return (
      <span title="Smaller than last cleanup" style={{ display: "inline-flex", alignItems: "center", color: COLORS.success }}>
        <ArrowDown size={12} weight="bold" />
      </span>
    );
  }
  if (trend === "up") {
    return (
      <span title="Larger than last cleanup" style={{ display: "inline-flex", alignItems: "center", color: COLORS.warning }}>
        <ArrowUp size={12} weight="bold" />
      </span>
    );
  }
  return (
    <span title="Unchanged since last cleanup" style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
      –
    </span>
  );
}

/** One diagnostic figure in the strip: eyebrow, value, one quiet line. */
function DiagnosticTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="ade-modern-stat">
      <span className="kit-eyebrow">{label}</span>
      <span className="ade-modern-stat-value">{value}</span>
      {sub ? <span className="ade-modern-stat-sub">{sub}</span> : null}
    </div>
  );
}

function Sparkline({ samples }: { samples: DbSizeSample[] }) {
  const width = 120;
  const height = 30;
  const points = sparklinePoints(samples, width, height);
  if (points.length < 2) return null;
  const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", overflow: "visible", color: "var(--kit-fill)" }} aria-hidden>
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DiagnosticsStrip({
  extras,
  usage,
  usageReady,
  runtimeHealth,
  runtimeHealthAvailable,
  children,
}: {
  extras: StorageSnapshotExtras | undefined;
  usage: AppResourceUsageSnapshot | null;
  usageReady: boolean;
  runtimeHealth: RuntimeHealthSnapshot | null;
  runtimeHealthAvailable: boolean;
  /** Extra blocks under the figures (recordings warning, cleanup journal). */
  children?: React.ReactNode;
}) {
  const samples = React.useMemo(() => dbSizeSamples(extras), [extras]);
  const latestDb = samples.length > 0 ? samples[samples.length - 1] : null;
  const trend = dbSizeTrend(samples);
  const daemonMem = daemonMemoryBytes(usage);
  const lastRun = lastMaintenanceRun(extras);
  const level = usage ? appResourcePressureLevel(usage) : 0;
  const health = healthChip(level);
  const hasCpuSignal = Boolean(usage && [
    usage.cpuPercent,
    usage.mainCpuPercent,
    usage.rendererCpuPercent,
    usage.ptyCpuPercent,
  ].some((value) => typeof value === "number" && Number.isFinite(value)));
  const hasMemorySignal = Boolean(
    usage
      && typeof usage.totalMemoryMB === "number"
      && Number.isFinite(usage.totalMemoryMB)
      && usage.totalMemoryMB > 0
      && [usage.memoryMB, usage.freeMemoryMB]
        .some((value) => typeof value === "number" && Number.isFinite(value)),
  );
  const hasPressureSignal = hasCpuSignal || hasMemorySignal;
  const healthTone = health.tone === "busy" ? "crit" : health.tone === "elevated" ? "warn" : "ok";

  const notAvailable = <span className="ade-modern-stat-sub" style={{ fontSize: 13 }}>Not available yet</span>;
  const slow = runtimeHealth && runtimeHealth.slowActions24h > 0;

  return (
    <ModernSection
      group="Health & diagnostics"
      anchor="diagnostics"
      title="Health & diagnostics"
      hint="How the background service is doing on this computer."
      actions={usageReady && hasPressureSignal ? (
        <span className="kit-tag" data-tone={healthTone}>
          <Gauge size={11} weight="fill" style={{ marginRight: 4 }} />{health.label}
        </span>
      ) : undefined}
    >
      <div className="ade-modern-stats">
        <DiagnosticTile
          label="Database size"
          value={
            latestDb ? (
              <>
                <span className="kit-stat kit-num">{formatBytes(latestDb.bytes)}</span>
                {trend ? <TrendArrow trend={trend} /> : null}
              </>
            ) : (
              notAvailable
            )
          }
          sub={samples.length >= 2 ? <Sparkline samples={samples} /> : latestDb ? "Trend appears after the next cleanup" : undefined}
        />
        <DiagnosticTile
          label="Service memory"
          value={daemonMem != null ? <span className="kit-stat kit-num">{formatBytes(daemonMem)}</span> : notAvailable}
          sub={daemonMem != null ? "Resident right now" : undefined}
        />
        <DiagnosticTile
          label="Slow responses"
          value={
            runtimeHealthAvailable ? (
              <span className="kit-stat" style={{ fontSize: 17, color: slow ? "var(--kit-warn)" : undefined }}>
                {formatSlowActions(runtimeHealth)}
              </span>
            ) : (
              notAvailable
            )
          }
        />
        <DiagnosticTile
          label="Last cleanup"
          value={lastRun ? <span className="kit-stat" style={{ fontSize: 14, lineHeight: 1.35, letterSpacing: 0 }}>{maintenanceHeadline(lastRun)}</span> : notAvailable}
        />
      </div>
      {children}
    </ModernSection>
  );
}
