import React from "react";
import {
  ArrowDown,
  ArrowUp,
  ChartLineUp,
  Clock,
  Gauge,
  Pulse,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  RuntimeHealthSnapshot,
  StorageSnapshotExtras,
} from "../../../../shared/types/storage";
import type { AppResourceUsageSnapshot } from "../../../../shared/types";
import { appResourcePressureLevel } from "../../../lib/resourcePressure";
import { COLORS, SANS_FONT, inlineBadge } from "../../lanes/laneDesignTokens";
import { PANEL_STYLE, STORAGE_BRAND } from "./storageUiConstants";
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

function DiagnosticTile({
  icon,
  label,
  value,
  sub,
  valueColor,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueColor?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 14,
        borderRadius: 11,
        border: `1px solid ${COLORS.borderMuted}`,
        background: "color-mix(in srgb, var(--color-fg) 2.5%, transparent)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, color: COLORS.textMuted }}>
        {icon}
        <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase" }}>{label}</span>
      </div>
      <div style={{ fontFamily: SANS_FONT, fontSize: 16, fontWeight: 650, color: valueColor ?? COLORS.textPrimary, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      {sub ? <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>{sub}</div> : null}
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
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", overflow: "visible" }} aria-hidden>
      <polyline
        points={path}
        fill="none"
        stroke={STORAGE_BRAND}
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
}: {
  extras: StorageSnapshotExtras | undefined;
  usage: AppResourceUsageSnapshot | null;
  usageReady: boolean;
  runtimeHealth: RuntimeHealthSnapshot | null;
  runtimeHealthAvailable: boolean;
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
  const healthColor = health.tone === "busy" ? COLORS.danger : health.tone === "elevated" ? COLORS.warning : COLORS.success;

  const notAvailable = <span style={{ color: COLORS.textMuted, fontWeight: 500, fontSize: 13 }}>Not available yet</span>;

  return (
    <section
      id="diagnostics"
      style={{ ...PANEL_STYLE, padding: 18, display: "flex", flexDirection: "column", gap: 14, scrollMarginTop: 16 }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 13.5, fontWeight: 650, color: COLORS.textPrimary }}>
            Health & diagnostics
          </h3>
          <div style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted, marginTop: 3 }}>
            How the background service is doing on this Mac.
          </div>
        </div>
        {usageReady && hasPressureSignal ? (
          <span style={{ ...inlineBadge(healthColor, { fontSize: 11, gap: 5 }), display: "inline-flex", alignItems: "center" }}>
            <Gauge size={13} weight="fill" /> {health.label}
          </span>
        ) : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <DiagnosticTile
          icon={<ChartLineUp size={14} />}
          label="Database size"
          value={
            latestDb ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {formatBytes(latestDb.bytes)}
                {trend ? <TrendArrow trend={trend} /> : null}
              </span>
            ) : (
              notAvailable
            )
          }
          sub={samples.length >= 2 ? <Sparkline samples={samples} /> : latestDb ? "Trend appears after the next cleanup" : undefined}
        />
        <DiagnosticTile
          icon={<Pulse size={14} />}
          label="Service memory"
          value={daemonMem != null ? formatBytes(daemonMem) : notAvailable}
          sub={daemonMem != null ? "Resident right now" : undefined}
        />
        <DiagnosticTile
          icon={<WarningCircle size={14} />}
          label="Slow responses"
          value={
            runtimeHealthAvailable ? (
              <span style={{ color: runtimeHealth && runtimeHealth.slowActions24h > 0 ? COLORS.warning : COLORS.textPrimary }}>
                {formatSlowActions(runtimeHealth)}
              </span>
            ) : (
              notAvailable
            )
          }
        />
        <DiagnosticTile
          icon={<Clock size={14} />}
          label="Last cleanup"
          value={lastRun ? <span style={{ fontSize: 13 }}>{maintenanceHeadline(lastRun)}</span> : notAvailable}
        />
      </div>
    </section>
  );
}
