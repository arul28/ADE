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
import { SettingsDashboardPage, SettingsDashboardStat } from "../primitives/SettingsDashboardPage";
import { STORAGE_BRAND } from "./storageUiConstants";
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

/**
 * One diagnostic figure. The tile itself is `SettingsDashboardStat` — the one
 * stat tile every dashboard page uses — with an icon glyph tucked in front of
 * the label, which is the only thing this surface adds over a plain stat.
 */
function DiagnosticTile({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <SettingsDashboardStat
      label={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          {icon}
          {label}
        </span>
      }
      value={value}
      hint={sub}
    />
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
    // Read-only figures, so this is a dashboard page: the panel, the title and
    // the scope chip come from the template rather than being drawn here.
    <SettingsDashboardPage
      anchor="diagnostics"
      title="Health & diagnostics"
      description="How the background service is doing on this computer."
    >
      {usageReady && hasPressureSignal ? (
        <div>
          <span style={{ ...inlineBadge(healthColor, { fontSize: 11, gap: 5 }), display: "inline-flex", alignItems: "center" }}>
            <Gauge size={13} weight="fill" /> {health.label}
          </span>
        </div>
      ) : null}

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
    </SettingsDashboardPage>
  );
}
