import React from "react";
import { ArrowClockwise, CheckCircle, Desktop } from "@phosphor-icons/react";
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
import { CompareBars, MemoryBar } from "./healthCharts";
import { useHealthData, type HealthData } from "./useHealthData";
import "./health.css";

const MB = 1024 * 1024;

/**
 * Computer → ADE service, top section: how the background service on this
 * computer is doing. Reads only the service diagnostics (no storage scan, no
 * project check), once on open and again on Check again.
 */
export function ServiceStatusSection() {
  const { pin, isThisMachine } = useSettingsMachineScope();
  const data = useHealthData(pin, isThisMachine, { diagnostics: true });
  return <HealthService data={data} />;
}

/**
 * The background service on this computer: its calls over the last day (slow
 * and failed kept apart, with the p95 of the slow ones) as two bars, what it
 * holds in memory against the computer's memory, how loaded the computer is,
 * and Repair.
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
      <ModernSection group="Background service" anchor="diagnostics" title="Service status" hint={`On ${machineName}.`}>
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
  const totalMemory = typeof usage?.totalMemoryMB === "number" && usage.totalMemoryMB > 0 ? usage.totalMemoryMB * MB : null;
  const freeMemory = typeof usage?.freeMemoryMB === "number" && Number.isFinite(usage.freeMemoryMB) ? usage.freeMemoryMB * MB : null;
  const quiet = responses != null && responses.slow === 0 && (responses.failed ?? 0) === 0;
  const pending = <span className="ade-modern-muted">{usageReady ? "Not available" : "Reading…"}</span>;

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
        title="Service status"
        hint="The service that runs your lanes, chats and terminals here."
        actions={(
          <button type="button" className="ade-modern-btn" data-variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
            <ArrowClockwise size={13} className={refreshing ? "animate-spin" : undefined} />
            {refreshing ? "Checking" : "Check again"}
          </button>
        )}
      >
        <div className="ade-health-chart-grid">
          <div className="ade-health-chart-panel">
            <div className="ade-health-chart-head">
              <span className="kit-eyebrow">Responses, last 24 hours</span>
              {load ? (
                <span className="kit-tag" data-tone={load.tone === "ok" ? undefined : load.tone} title="This computer's CPU and memory right now">
                  Load: {load.label}
                </span>
              ) : null}
            </div>
            {runtimeHealthAvailable && responses ? (
              quiet ? (
                <div className="ade-health-quiet">
                  <CheckCircle size={14} weight="fill" />
                  No slow or failed responses
                </div>
              ) : (
                <>
                  <CompareBars
                    ariaLabel="Slow and failed responses in the last 24 hours"
                    bars={[
                      { id: "slow", label: "Slow (over 500 ms)", value: responses.slow, tone: responses.slow > 0 ? "warn" : undefined },
                      {
                        id: "failed",
                        label: "Failed",
                        value: responses.failed ?? 0,
                        display: responses.failed == null ? "—" : undefined,
                        tone: (responses.failed ?? 0) > 0 ? "crit" : undefined,
                      },
                    ]}
                  />
                  {responses.slow > 0 && responses.p95Ms != null ? (
                    <span className="ade-modern-muted">95% of slow ones finished within {formatDurationMs(responses.p95Ms)}.</span>
                  ) : null}
                </>
              )
            ) : pending}
          </div>
          <div className="ade-health-chart-panel">
            <div className="ade-health-chart-head">
              <span className="kit-eyebrow">Memory</span>
              {memory ? (
                <span className="kit-num ade-health-chart-value">{formatBytes(memory.bytes)}</span>
              ) : null}
            </div>
            {memory && totalMemory ? (
              <MemoryBar serviceBytes={memory.bytes} totalBytes={totalMemory} freeBytes={freeMemory} />
            ) : memory ? (
              <span className="ade-modern-muted">
                {memory.processCount === 1 ? "One service process" : `${memory.processCount} service processes`}, not counting agents or shells.
              </span>
            ) : pending}
          </div>
        </div>
      </ModernSection>

      {repair.available ? (
        <ModernSection group="Background service" title="Repair" hint="When chats won't start or ADE can't reach its service.">
          <ModernRows>
            <ModernRow
              title="Repair the background service"
              hint="Fixes a sign-in the service can't read, then restarts it."
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
