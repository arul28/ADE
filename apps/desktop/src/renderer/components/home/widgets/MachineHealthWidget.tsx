import { useCallback, useState } from "react";
import { Cpu, Plugs, StopCircle } from "@phosphor-icons/react";
import type { HomeListenersResult, HomeMachineHealth } from "../../../../shared/types/homeWidgets";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { usageLeftLevel } from "../../usage/usageDesign";
import { useWidgetSpan, useWidgetVisible } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import { FitList } from "../HomeFitList";
import { formatBytesShort, usePolling } from "./widgetHooks";
import "../homeWidgets.css";

/**
 * Machine health for the computer this window runs on: CPU, memory and the
 * system disk, plus the dev servers holding ports, with a stop button.
 *
 * Cost: counters every 3 s and a port scan every 10 s, both only while the
 * card is on screen. The scan is async native tools in main (netstat and
 * tasklist on Windows, lsof elsewhere), cached 5 s, never PowerShell.
 */

/**
 * A gauge in the Limits & machines ring style: the same 270° arc, neutral
 * with room and amber or red by the kit's one rule (20% / 5% left).
 */
function Gauge({ label, percent, detail }: { label: string; percent: number | null; detail: string }) {
  const level = percent == null ? undefined : usageLeftLevel(100 - percent);
  const radius = 17;
  const circumference = 2 * Math.PI * radius;
  const arc = circumference * 0.75;
  const filled = (arc * Math.max(0, Math.min(100, percent ?? 0))) / 100;
  return (
    <div className="ade-mh-gauge" title={`${label} · ${detail}`}>
      <span className="ade-home-ring-wrap ade-mh-ring">
        <svg viewBox="0 0 44 44" className="ade-home-ring" aria-hidden>
          <circle cx="22" cy="22" r={radius} className="ade-home-ring-track" strokeDasharray={`${arc} ${circumference}`} transform="rotate(135 22 22)" />
          <circle cx="22" cy="22" r={radius} className="ade-home-ring-fill ade-mh-ring-fill" data-level={level} strokeDasharray={`${filled} ${circumference}`} transform="rotate(135 22 22)" />
        </svg>
        <span className="ade-mh-ring-value kit-num" data-level={level}>{percent == null ? "—" : percent}</span>
      </span>
      <span className="ade-mh-gauge-label">{label}</span>
      <span className="ade-mh-gauge-detail kit-num">{detail}</span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

export default function MachineHealthWidget({ item }: HomeWidgetProps) {
  const visible = useWidgetVisible();
  const bridge = window.ade?.home?.machine;
  const [health, setHealth] = useState<HomeMachineHealth | null>(null);
  const [listeners, setListeners] = useState<HomeListenersResult | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [killError, setKillError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<number | null>(null);

  usePolling(async () => {
    if (!bridge) return;
    setHealth(await bridge.health());
  }, 3_000, visible && Boolean(bridge));

  const loadListeners = useCallback(async () => {
    if (!bridge) return;
    setListeners(await bridge.listeners());
  }, [bridge]);
  usePolling(loadListeners, 10_000, visible && Boolean(bridge));

  const stop = async (pid: number) => {
    if (!bridge) return;
    setStopping(pid);
    setKillError(null);
    const result = await bridge.kill(pid).catch((error: unknown) => ({ ok: false as const, error: String(error) }));
    setStopping(null);
    setConfirmPid(null);
    if (!result.ok) setKillError(result.error);
    await loadListeners();
  };

  const memPercent = health ? Math.round((health.memUsedBytes / Math.max(1, health.memTotalBytes)) * 100) : null;
  const disk = health?.disk ?? null;
  const diskPercent = disk ? Math.round(((disk.totalBytes - disk.freeBytes) / Math.max(1, disk.totalBytes)) * 100) : null;
  const processes = listeners?.ok ? listeners.processes.filter((entry) => showAll || entry.dev) : [];
  const hiddenCount = listeners?.ok ? listeners.processes.filter((entry) => !entry.dev).length : 0;
  const span = useWidgetSpan(item);
  const compact = span.w === 1 && span.h === 1;
  const devServers = listeners?.ok ? listeners.processes.filter((entry) => entry.dev) : [];

  const renderProcess = (entry: (typeof processes)[number]) => (
                  <div key={entry.pid} role="listitem" className="ade-mh-row" data-dev={entry.dev || undefined}>
                    <span className="ade-mh-name" title={`${entry.name ?? "Unknown"} · pid ${entry.pid}`}>{(entry.name ?? "unknown").replace(/\.exe$/i, "")}</span>
                    <span className="ade-mh-port-list kit-num">
                      {entry.ports.slice(0, 4).map((port) => <i key={port}>:{port}</i>)}
                      {entry.ports.length > 4 ? <i>+{entry.ports.length - 4}</i> : null}
                    </span>
                    {entry.protected ? (
                      <span className="ade-mh-own" title="One of ADE's own processes">ADE</span>
                    ) : confirmPid === entry.pid ? (
                      <span className="ade-mh-confirm">
                        <button type="button" className="kit-btn kit-btn-ghost" onClick={() => setConfirmPid(null)}>Keep</button>
                        <button type="button" className="kit-btn ade-mh-stop" disabled={stopping === entry.pid} onClick={() => void stop(entry.pid)}>
                          {stopping === entry.pid ? "Stopping…" : "Stop"}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="kit-icon-btn ade-mh-kill"
                        aria-label={`Stop ${entry.name ?? "process"} (pid ${entry.pid})`}
                        title={`Stop pid ${entry.pid}`}
                        onClick={() => setConfirmPid(entry.pid)}
                      >
                        <StopCircle size={14} />
                      </button>
                    )}
                  </div>
  );

  return (
    <section className="kit-card ade-home-card ade-mh" aria-label="Machine health" data-size={item.size}>
      <WelcomeCardHead icon={Cpu} title="Machine health">
        {health ? <span className="ade-home-card-scope" title={health.cpuModel ?? undefined}>{health.hostname} · up {formatUptime(health.uptimeSec)}</span> : null}
      </WelcomeCardHead>
      <div className="kit-card-body ade-mh-body">
        {!health ? (
          <div className="ade-home-empty"><span>Reading this machine…</span></div>
        ) : (
          <div className="ade-mh-gauges">
            <Gauge label="CPU" percent={health.cpuPercent} detail={`${health.cpuCount} cores`} />
            <Gauge label="Memory" percent={memPercent} detail={`${formatBytesShort(health.memUsedBytes)} / ${formatBytesShort(health.memTotalBytes)}`} />
            {disk ? <Gauge label="Disk" percent={diskPercent} detail={`${formatBytesShort(disk.freeBytes)} free`} /> : null}
          </div>
        )}
        {compact ? (
          <button type="button" className="ade-mh-summary" onClick={() => void loadListeners()} title="Dev servers holding ports">
            <Plugs size={12} aria-hidden />
            {!listeners ? "Scanning ports…" : !listeners.ok ? "Ports unavailable" : devServers.length === 0 ? "No dev servers running" : (
              <>
                <span>{devServers.length} dev server{devServers.length === 1 ? "" : "s"}</span>
                <span className="ade-mh-port-list kit-num">
                  {devServers.flatMap((entry) => entry.ports).slice(0, 3).map((port) => <i key={port}>:{port}</i>)}
                </span>
              </>
            )}
          </button>
        ) : (
          <div className="ade-mh-ports">
            <div className="ade-mh-ports-head">
              <span className="kit-eyebrow">Listening ports</span>
              {hiddenCount > 0 ? (
                <button type="button" className="kit-card-head-action ade-mh-toggle" onClick={() => setShowAll((value) => !value)}>
                  {showAll ? "Dev servers only" : `Show all (${hiddenCount} more)`}
                </button>
              ) : null}
            </div>
            {killError ? <div className="ade-hw-note" role="alert">{killError}</div> : null}
            {!listeners ? (
              <div className="ade-hw-note">Scanning ports…</div>
            ) : !listeners.ok ? (
              <div className="ade-hw-note" role="alert">Couldn't list ports: {listeners.error}</div>
            ) : processes.length === 0 ? (
              <div className="ade-hw-note"><Plugs size={13} aria-hidden /> No dev servers are listening.</div>
            ) : (
              <FitList listClassName="ade-mh-list" more={{ dialog: { title: "Listening ports", render: () => processes.map(renderProcess) } }}>
                {processes.map(renderProcess)}
              </FitList>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
