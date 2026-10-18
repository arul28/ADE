import React from "react";
import { ArrowClockwise, Desktop } from "@phosphor-icons/react";
import { ModernRow, ModernRows, ModernSection } from "../primitives";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { BrainRepairButton } from "../BrainRepairButton";
import { useBrainRepair } from "../../../hooks/useBrainRepair";
import { appResourcePressureLevel } from "../../../lib/resourcePressure";
import {
  formatBytes,
  formatDurationMs,
  loadChip,
  responseHealth,
  serviceMemory,
} from "../storage/storageView";
import type { HealthData } from "./useHealthData";

/**
 * The background service on this computer: what it holds in memory, how its
 * calls went over the last day (slow and failed kept apart, with the p95 of
 * the slow ones), how loaded the computer is, and Repair.
 *
 * Everything here is read over plain IPC, which only reaches this computer,
 * so another machine's page says so instead of showing this one's numbers.
 */
export function HealthService({ data }: { data: HealthData }) {
  const { isThisMachine, machineName } = useSettingsMachineScope();
  const { loadDiagnostics } = data;
  const repair = useBrainRepair(() => void loadDiagnostics());
  const [refreshing, setRefreshing] = React.useState(false);

  if (!isThisMachine) {
    return (
      <ModernSection group="Background service" anchor="diagnostics" title="Background service" hint={`On ${machineName}.`}>
        <div className="ade-modern-note">
          <Desktop size={14} />
          <span>Only on this computer. Open Settings on {machineName} to see its background service.</span>
        </div>
      </ModernSection>
    );
  }

  const { usage, usageReady, runtimeHealth, runtimeHealthAvailable } = data.diagnostics;
  const memory = serviceMemory(usage);
  const responses = responseHealth(runtimeHealth);
  const level = usage ? appResourcePressureLevel(usage) : null;
  const hasPressureSignal = Boolean(usage && (
    [usage.cpuPercent, usage.mainCpuPercent, usage.rendererCpuPercent, usage.ptyCpuPercent]
      .some((value) => typeof value === "number" && Number.isFinite(value))
    || (typeof usage.totalMemoryMB === "number" && usage.totalMemoryMB > 0
      && [usage.memoryMB, usage.freeMemoryMB].some((value) => typeof value === "number" && Number.isFinite(value)))
  ));
  const load = level != null && hasPressureSignal ? loadChip(level) : null;
  const unavailable = <span className="ade-modern-stat-sub" style={{ fontSize: 13 }}>{usageReady ? "Not available" : "Reading…"}</span>;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadDiagnostics();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="ade-modern-sections">
      <ModernSection
        group="Background service"
        anchor="diagnostics"
        title="Background service"
        hint="ADE's service on this computer runs your lanes, chats and terminals."
        actions={(
          <button type="button" className="ade-modern-btn" data-variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
            <ArrowClockwise size={13} className={refreshing ? "animate-spin" : undefined} />
            {refreshing ? "Reading" : "Read again"}
          </button>
        )}
      >
        <div className="ade-modern-stats">
          <div className="ade-modern-stat">
            <span className="kit-eyebrow">Slow responses</span>
            {runtimeHealthAvailable && responses ? (
              <>
                <span className="ade-modern-stat-value">
                  <span className="kit-stat kit-num" style={responses.slow > 0 ? { color: "var(--kit-warn)" } : undefined}>
                    {responses.slow}
                  </span>
                </span>
                <span className="ade-modern-stat-sub">
                  {responses.slow > 0 && responses.p95Ms != null
                    ? `Over 500 ms in 24 h; 95% of them within ${formatDurationMs(responses.p95Ms)}`
                    : "Over 500 ms, last 24 hours"}
                </span>
              </>
            ) : unavailable}
          </div>
          <div className="ade-modern-stat">
            <span className="kit-eyebrow">Failed responses</span>
            {runtimeHealthAvailable && responses && responses.failed != null ? (
              <>
                <span className="ade-modern-stat-value">
                  <span className="kit-stat kit-num" style={responses.failed > 0 ? { color: "var(--kit-crit)" } : undefined}>
                    {responses.failed}
                  </span>
                </span>
                <span className="ade-modern-stat-sub">Errors and timeouts, last 24 hours</span>
              </>
            ) : unavailable}
          </div>
          <div className="ade-modern-stat">
            <span className="kit-eyebrow">Service memory</span>
            {memory ? (
              <>
                <span className="ade-modern-stat-value">
                  <span className="kit-stat kit-num">{formatBytes(memory.bytes)}</span>
                </span>
                <span className="ade-modern-stat-sub">
                  {memory.processCount === 1
                    ? "The ADE service process, not the agents or shells it runs"
                    : `${memory.processCount} ADE service processes, not the agents or shells they run`}
                </span>
              </>
            ) : unavailable}
          </div>
          <div className="ade-modern-stat">
            <span className="kit-eyebrow">Load</span>
            {load ? (
              <>
                <span className="ade-modern-stat-value">
                  <span className="kit-dot" data-state={load.tone} aria-hidden />
                  <span className="kit-stat" style={{ fontSize: 17 }}>{load.label}</span>
                </span>
                <span className="ade-modern-stat-sub">This computer&apos;s CPU and memory right now</span>
              </>
            ) : unavailable}
          </div>
        </div>
        <p className="ade-modern-muted">
          Disk measurements and project checks are slow on purpose and are not counted.
        </p>
      </ModernSection>

      {repair.available ? (
        <ModernSection group="Background service" title="Repair" hint="When chats won't start or ADE says it can't reach its service.">
          <ModernRows>
            <ModernRow
              title="Repair the background service"
              hint="Fixes a sign-in the service can't read, then restarts the service."
              control={<BrainRepairButton repair={repair} height={28} />}
            >
              {repair.notice ? (
                <p className={repair.notice.tone === "ok" ? "ade-modern-muted" : "ade-modern-warn"}>{repair.notice.text}</p>
              ) : null}
            </ModernRow>
          </ModernRows>
        </ModernSection>
      ) : null}
    </div>
  );
}
