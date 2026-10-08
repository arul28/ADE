import { memo, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { BatteryMedium, Cpu, Plugs, StopCircle } from "@phosphor-icons/react";
import type { HomeListenersResult, HomeMachineDetail, HomeMachineHealth } from "../../../../shared/types/homeWidgets";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { usageLeftLevel } from "../../usage/usageDesign";
import { useWidgetSpan, useWidgetVisible } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import { FitList } from "../HomeFitList";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { formatBytesShort, usePolling } from "./widgetHooks";
import "../homeWidgets.css";

/**
 * Machine health for the computer this window runs on.
 *
 * - Compact: CPU, memory and system-disk rings, and a one-line dev-server summary.
 * - Regular (one column): the rings, a minute of CPU with a bar per core,
 *   network in and out, the biggest memory users, and the listening ports.
 * - Large (two columns): the same with room: drives, memory and the lists side
 *   by side with the charts.
 *
 * Cost: one `health` call every 3 s (6 s when ADE is not focused) while the card is on screen (counters,
 * plus in Regular and Large one `netstat -e`, with drives and the process
 * list (tasklist, ~45 ms of main CPU) re-read every 30 s; never PowerShell), and a port scan every 10 s.
 */

type View = "compact" | "wide" | "regular" | "large";

const PERCENT_LEVEL = (percent: number | null) => (percent == null ? undefined : usageLeftLevel(100 - percent));

/**
 * A gauge in the Limits & machines ring style: the same 270° arc, neutral
 * with room and amber or red by the kit's one rule (20% / 5% left).
 */
function Gauge({ label, percent, detail }: { label: string; percent: number | null; detail: string }) {
  const level = PERCENT_LEVEL(percent);
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

function formatRate(bytesPerSecond: number): string {
  return `${formatBytesShort(bytesPerSecond)}/s`;
}

/** A drive's name as the OS shows it: "C:" on Windows, the volume name elsewhere. */
function driveLabel(drivePath: string): string {
  if (/^[A-Z]:\\$/i.test(drivePath)) return drivePath.slice(0, 2).toUpperCase();
  if (drivePath === "/") return "System";
  return drivePath.split("/").filter(Boolean).pop() ?? drivePath;
}

/** The charts show the last minute, each reading placed by when it was taken. */
const WINDOW_MS = 60_000;

/**
 * A live area chart over the last minute: each reading sits at its age, the
 * newest at the right edge. `max` fixes the scale (CPU zooms to a 25% step)
 * and `scale` labels the top line. Hovering reads the nearest value out.
 */
function LiveChart({
  series,
  agesMs,
  max,
  height,
  label,
  onHover,
  fill = false,
  scale,
}: {
  series: Array<{ values: number[]; tone: "fg" | "accent" }>;
  /** Age of each reading, aligned with every series' values. */
  agesMs: number[];
  max: number;
  height: number;
  label: string;
  onHover?: (index: number | null) => void;
  /** Stretch to the parent's height (Large) instead of drawing `height` px tall. */
  fill?: boolean;
  /** What the top line means ("25%", "256 KB/s"), shown at its start. */
  scale?: string;
}) {
  const id = useId().replace(/:/g, "");
  const width = 240;
  const xOf = (age: number) => width * (1 - Math.min(WINDOW_MS, Math.max(0, age)) / WINDOW_MS);
  const paths = series.map(({ values, tone }) => {
    const points = values.map((value, index) => [
      xOf(agesMs[index] ?? 0),
      2 + (1 - Math.min(1, Math.max(0, value) / max)) * (height - 4),
    ] as const);
    if (points.length === 0) return { tone, line: "", area: "" };
    const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const area = `${line} L${points[points.length - 1]![0].toFixed(1)} ${height} L${points[0]![0].toFixed(1)} ${height} Z`;
    return { tone, line, area };
  });
  const nearestTo = (x: number): number | null => {
    let nearest: number | null = null;
    let distance = Infinity;
    agesMs.forEach((age, index) => {
      const gap = Math.abs(xOf(age) - x);
      if (gap < distance) {
        nearest = index;
        distance = gap;
      }
    });
    return distance < 14 ? nearest : null;
  };
  return (
    <div className="ade-mh-chart-wrap" data-fill={fill || undefined} style={fill ? undefined : { height }}>
    <svg
      className="ade-mh-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      data-fill={fill || undefined}
      role="img"
      aria-label={label}
      onMouseMove={onHover ? (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        onHover(nearestTo(((event.clientX - box.left) / Math.max(1, box.width)) * width));
      } : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <defs>
        {paths.map((path, index) => (
          <linearGradient key={index} id={`${id}-${index}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="ade-mh-chart-stop" data-tone={path.tone} stopOpacity={0.26} />
            <stop offset="100%" className="ade-mh-chart-stop" data-tone={path.tone} stopOpacity={0} />
          </linearGradient>
        ))}
      </defs>
      {[2, 2 + (height - 4) / 2].map((y) => (
        <line key={y} x1="0" x2={width} y1={y} y2={y} className="ade-mh-chart-grid" vectorEffect="non-scaling-stroke" />
      ))}
      {paths.map((path, index) => (path.line ? (
        <g key={index}>
          <path d={path.area} fill={`url(#${id}-${index})`} />
          <path d={path.line} className="ade-mh-chart-line" data-tone={path.tone} vectorEffect="non-scaling-stroke" />
        </g>
      ) : null))}
    </svg>
    {scale ? <span className="ade-mh-chart-scale kit-num" aria-hidden>{scale}</span> : null}
    </div>
  );
}

/** One thin bar per logical core, busy percent tall. */
function CoreBars({ cores }: { cores: number[] }) {
  return (
    <div className="ade-mh-cores" role="img" aria-label={`${cores.length} cores, busiest ${Math.max(0, ...cores)}%`}>
      {cores.map((value, index) => (
        <i key={index} title={`Core ${index + 1} · ${value}%`} data-level={PERCENT_LEVEL(value)}>
          <b style={{ transform: `scaleY(${Math.max(4, value) / 100})` }} />
        </i>
      ))}
    </div>
  );
}

function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`ade-mh-section${className ? ` ${className}` : ""}`}>
      {/* A block box around the head: a flex item cannot be a relayout
          boundary, its size-contained child can, so a new number re-lays-out
          only the head. */}
      <div className="ade-mh-box">
        <div className="ade-mh-section-head">
          <span className="kit-eyebrow">{title}</span>
          {aside != null ? <span className="ade-mh-section-aside kit-num">{aside}</span> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

function CpuSection({ health, detail, chartHeight, fill = false }: { health: HomeMachineHealth; detail: HomeMachineDetail; chartHeight: number; fill?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const history = detail.cpuHistory;
  const shown = hover != null ? history[hover] : health.cpuPercent;
  const seconds = hover != null ? Math.round((detail.cpuAgesMs[hover] ?? 0) / 1_000) : 0;
  // A quiet machine still shows its shape: the top line is the next 25% step above the minute's peak.
  const top = Math.min(100, Math.max(25, Math.ceil(Math.max(0, ...history) / 25) * 25));
  return (
    <Section
      title="CPU"
      className="ade-mh-cpu"
      aside={shown == null ? "—" : hover != null && seconds > 0 ? `${shown}% · ${seconds}s ago` : `${shown}%`}
    >
      <LiveChart series={[{ values: history, tone: "fg" }]} agesMs={detail.cpuAgesMs} max={top} scale={`${top}%`} height={chartHeight} fill={fill} label={`CPU over the last minute, now ${health.cpuPercent ?? 0}%`} onHover={setHover} />
      {detail.cores.length > 1 ? <CoreBars cores={detail.cores} /> : null}
      <div className="ade-mh-cpu-model" title={health.cpuModel ?? undefined}>
        {health.cpuModel ?? "Processor"} · {health.cpuCount} threads
      </div>
    </Section>
  );
}

function NetworkSection({ detail, chartHeight, fill = false }: { detail: HomeMachineDetail; chartHeight: number; fill?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const rx = detail.netHistory?.rx ?? [];
  const tx = detail.netHistory?.tx ?? [];
  // Scale to the busiest moment, but never below 64 KB/s so background chatter stays a flat line.
  const peak = Math.max(64 * 1024, ...rx, ...tx);
  // Round the top line up to a 1-2-5 step so its label reads cleanly.
  const magnitude = 2 ** Math.floor(Math.log2(peak));
  const max = [1, 1.5, 2].map((step) => step * magnitude).find((step) => step >= peak) ?? peak;
  const down = hover != null ? rx[hover] : detail.net?.rxBps;
  const up = hover != null ? tx[hover] : detail.net?.txBps;
  return (
    <Section
      title="Network"
      className="ade-mh-net"
      aside={(
        <span className="ade-mh-net-legend">
          <span className="kit-legend"><i data-tone="accent" />In <b>{down == null ? "—" : formatRate(down)}</b></span>
          <span className="kit-legend"><i data-tone="fg" />Out <b>{up == null ? "—" : formatRate(up)}</b></span>
        </span>
      )}
    >
      {detail.netHistory ? (
        <LiveChart
          series={[{ values: rx, tone: "accent" }, { values: tx, tone: "fg" }]}
          agesMs={detail.netHistory.agesMs}
          max={max}
          scale={formatRate(max)}
          height={chartHeight}
          fill={fill}
          label={`Network: ${formatRate(detail.net?.rxBps ?? 0)} in, ${formatRate(detail.net?.txBps ?? 0)} out`}
          onHover={setHover}
        />
      ) : (
        <div className="ade-mh-chart-empty" data-fill={fill || undefined} style={fill ? undefined : { height: chartHeight }}>Measuring…</div>
      )}
    </Section>
  );
}

type ProcessGroups = NonNullable<HomeMachineDetail["processes"]>;

/**
 * The biggest memory users. Main refreshes the list every 30 s while the
 * card re-renders every 3 s, so it skips renders whose rows did not change.
 */
const ProcessList = memo(function ProcessList({ groups, total }: { groups: ProcessGroups; total: number }) {
  // Bars are relative to the biggest user, so the list reads as a ranking.
  const biggest = Math.max(1, groups[0]?.memBytes ?? 1);
  const renderGroup = (group: ProcessGroups[number]) => (
    <div key={group.name} role="listitem" className="ade-mh-proc" title={`${group.name}${group.count > 1 ? ` · ${group.count} processes` : ""} · ${formatBytesShort(group.memBytes)} (${Math.round((group.memBytes / total) * 100)}% of memory)`}>
      <span className="ade-mh-proc-name">
        {group.name}
        {group.count > 1 ? <i className="kit-num">×{group.count}</i> : null}
      </span>
      <span className="kit-meter ade-mh-proc-meter"><span style={{ width: `${Math.max(2, (group.memBytes / biggest) * 100)}%` }} /></span>
      {group.cpuPercent != null ? <span className="ade-mh-proc-cpu kit-num">{group.cpuPercent.toFixed(group.cpuPercent < 10 ? 1 : 0)}%</span> : null}
      <span className="ade-mh-proc-value kit-num">{formatBytesShort(group.memBytes)}</span>
    </div>
  );
  return (
    <FitList className="ade-mh-proc-fit" listClassName="ade-mh-proc-list" ariaLabel="Biggest memory users" more={{ dialog: { title: "Memory by app", render: () => groups.map(renderGroup) } }}>
      {groups.map(renderGroup)}
    </FitList>
  );
}, (before, after) => before.total === after.total
  && before.groups.length === after.groups.length
  && before.groups.every((group, index) => {
    const next = after.groups[index]!;
    return group.name === next.name && group.count === next.count && group.memBytes === next.memBytes && group.cpuPercent === next.cpuPercent;
  }));

function MemorySection({ health, detail }: { health: HomeMachineHealth; detail: HomeMachineDetail }) {
  const total = Math.max(1, health.memTotalBytes);
  const usedPercent = Math.round((health.memUsedBytes / total) * 100);
  return (
    <Section
      title="Memory"
      className="ade-mh-mem"
      aside={`${formatBytesShort(health.memUsedBytes)} used · ${formatBytesShort(detail.memAvailableBytes)} available`}
    >
      <div className="ade-mh-box">
        <span
          className="kit-meter ade-mh-mem-bar"
          data-level={PERCENT_LEVEL(usedPercent)}
          title={`${formatBytesShort(health.memUsedBytes)} used of ${formatBytesShort(health.memTotalBytes)} (${usedPercent}%)`}
        >
          <span style={{ width: `${usedPercent}%` }} />
        </span>
      </div>
      {detail.processes == null ? <div className="ade-hw-note">Reading processes…</div> : <ProcessList groups={detail.processes} total={total} />}
    </Section>
  );
}

function DrivesSection({ detail, fallback }: { detail: HomeMachineDetail; fallback: HomeMachineHealth["disk"] }) {
  const drives = detail.drives.length > 0 ? detail.drives : fallback ? [fallback] : [];
  if (drives.length === 0) return null;
  return (
    <Section title={drives.length === 1 ? "Disk" : "Drives"} className="ade-mh-drives">
      <div className="ade-mh-drive-list" role="list">
        {drives.map((drive) => {
          const used = Math.round(((drive.totalBytes - drive.freeBytes) / Math.max(1, drive.totalBytes)) * 100);
          return (
            <div key={drive.path} role="listitem" className="ade-mh-drive" title={`${drive.path} · ${used}% used`}>
              <span className="ade-mh-drive-name">{driveLabel(drive.path)}</span>
              <span className="kit-meter" data-level={PERCENT_LEVEL(used)}><span style={{ width: `${used}%` }} /></span>
              <span className="ade-mh-drive-value kit-num">{formatBytesShort(drive.freeBytes)} free of {formatBytesShort(drive.totalBytes)}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return focused;
}

export default function MachineHealthWidget({ item }: HomeWidgetProps) {
  const visible = useWidgetVisible();
  const bridge = window.ade?.home?.machine;
  const [health, setHealth] = useState<HomeMachineHealth | null>(null);
  const [listeners, setListeners] = useState<HomeListenersResult | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<number | null>(null);

  const span = useWidgetSpan(item);
  const view: View = span.h >= 2 ? (span.w >= 2 ? "large" : "regular") : span.w >= 2 ? "wide" : "compact";
  const wantsDetail = view !== "compact";

  // Live every 3 s while ADE is the focused app; every 6 s behind other
  // windows, where nobody is watching the chart move.
  const focused = useWindowFocused();
  usePolling(async () => {
    if (!bridge) return;
    setHealth(await bridge.health({ detail: wantsDetail }));
  }, focused ? 3_000 : 6_000, visible && Boolean(bridge));

  const loadListeners = useCallback(async () => {
    if (!bridge) return;
    setListeners(await bridge.listeners());
  }, [bridge]);
  usePolling(loadListeners, 10_000, visible && Boolean(bridge));

  const stop = async (entry: { pid: number; name: string | null; ports: number[] }) => {
    if (!bridge) return;
    const name = (entry.name ?? "this process").replace(/\.exe$/i, "");
    const confirmed = await confirmDialog({
      title: `Stop ${name}?`,
      message: `Process ${entry.pid} is listening on ${entry.ports.map((port) => `:${port}`).join(", ")}. Stopping it ends it and its child processes; unsaved work in it is lost.`,
      confirmLabel: "Stop",
      destructive: true,
    });
    if (!confirmed) return;
    setStopping(entry.pid);
    setKillError(null);
    const result = await bridge.kill(entry.pid).catch((error: unknown) => ({ ok: false as const, error: String(error) }));
    setStopping(null);
    if (!result.ok) setKillError(result.error);
    await loadListeners();
  };

  const memPercent = health ? Math.round((health.memUsedBytes / Math.max(1, health.memTotalBytes)) * 100) : null;
  const disk = health?.disk ?? null;
  const diskPercent = disk ? Math.round(((disk.totalBytes - disk.freeBytes) / Math.max(1, disk.totalBytes)) * 100) : null;
  const processes = listeners?.ok ? listeners.processes.filter((entry) => showAll || entry.dev) : [];
  const hiddenCount = listeners?.ok ? listeners.processes.filter((entry) => !entry.dev).length : 0;
  const devServers = listeners?.ok ? listeners.processes.filter((entry) => entry.dev) : [];
  const detail = health?.detail ?? null;

  const renderProcess = (entry: (typeof processes)[number]) => (
                  <div key={entry.pid} role="listitem" className="ade-mh-row" data-dev={entry.dev || undefined}>
                    <span className="ade-mh-name" title={`${entry.name ?? "Unknown"} · pid ${entry.pid}`}>{(entry.name ?? "unknown").replace(/\.exe$/i, "")}</span>
                    <span className="ade-mh-port-list kit-num">
                      {entry.ports.slice(0, 4).map((port) => <i key={port}>:{port}</i>)}
                      {entry.ports.length > 4 ? <i>+{entry.ports.length - 4}</i> : null}
                    </span>
                    {entry.protected ? (
                      <span className="ade-mh-own" title="One of ADE's own processes">ADE</span>
                    ) : entry.system ? (
                      <span className="ade-mh-own" title="A system or service process; ADE does not stop it">System</span>
                    ) : (
                      <button
                        type="button"
                        className="kit-icon-btn ade-mh-kill"
                        aria-label={`Stop ${entry.name ?? "process"} (pid ${entry.pid})`}
                        title={stopping === entry.pid ? "Stopping…" : `Stop pid ${entry.pid}`}
                        disabled={stopping === entry.pid}
                        onClick={() => void stop(entry)}
                      >
                        <StopCircle size={14} />
                      </button>
                    )}
                  </div>
  );

  const gauges = health ? (
    <div className="ade-mh-gauges">
      <Gauge label="CPU" percent={health.cpuPercent} detail={`${health.cpuCount} threads`} />
      <Gauge label="Memory" percent={memPercent} detail={`${formatBytesShort(health.memUsedBytes)} / ${formatBytesShort(health.memTotalBytes)}`} />
      {disk ? <Gauge label="Disk" percent={diskPercent} detail={`${formatBytesShort(disk.freeBytes)} free`} /> : null}
    </div>
  ) : null;

  // The ports list changes every 10 s (or on a stop), not on every 3 s reading.
  const ports = useMemo(() => (
    <div className="ade-mh-ports">
      <div className="ade-mh-ports-head">
        <span className="kit-eyebrow">Listening ports</span>
        {hiddenCount > 0 ? (
          <button type="button" className="kit-card-head-action ade-mh-toggle" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Dev servers only" : `Show all (${hiddenCount} more)`}
          </button>
        ) : null}
      </div>
      {killError ? (
        <Banner
          layout="inline"
          model={{ id: "home-machine-kill", tone: "error", title: "Couldn't stop it", detail: killError, dismiss: { onDismiss: () => setKillError(null) } }}
        />
      ) : null}
      {!listeners ? (
        <div className="ade-hw-note">Scanning ports…</div>
      ) : !listeners.ok ? (
        <Banner layout="inline" model={{ id: "home-machine-ports", tone: "warning", title: "Couldn't list ports", detail: listeners.error }} />
      ) : processes.length === 0 ? (
        <div className="ade-hw-note"><Plugs size={13} aria-hidden /> No dev servers are listening.</div>
      ) : (
        <FitList listClassName="ade-mh-list" more={{ dialog: { title: "Listening ports", render: () => processes.map(renderProcess) } }}>
          {processes.map(renderProcess)}
        </FitList>
      )}
    </div>
  ),
  // renderProcess and stop only read the state listed here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [listeners, showAll, stopping, killError, hiddenCount]);

  const summary = (
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
  );

  let body: ReactNode;
  if (!health) {
    body = <div className="ade-home-empty"><span>Reading this machine…</span></div>;
  } else if (view === "compact" || !detail) {
    body = (
      <>
        {gauges}
        {view === "compact" ? summary : ports}
      </>
    );
  } else if (view === "wide") {
    body = (
      <div className="ade-mh-wide">
        {gauges}
        <div className="ade-mh-col">
          <CpuSection health={health} detail={detail} chartHeight={34} />
          {summary}
        </div>
      </div>
    );
  } else if (view === "regular") {
    body = (
      <>
        {gauges}
        <CpuSection health={health} detail={detail} chartHeight={38} />
        <NetworkSection detail={detail} chartHeight={26} />
        <MemorySection health={health} detail={detail} />
        {ports}
      </>
    );
  } else {
    body = (
      <div className="ade-mh-large">
        <div className="ade-mh-col">
          {gauges}
          <CpuSection health={health} detail={detail} chartHeight={64} fill />
          <NetworkSection detail={detail} chartHeight={44} fill />
        </div>
        <div className="ade-mh-col">
          <MemorySection health={health} detail={detail} />
          <DrivesSection detail={detail} fallback={disk} />
          {ports}
        </div>
      </div>
    );
  }

  return (
    <section className="kit-card ade-home-card ade-mh" aria-label="Machine health" data-size={item.size} data-view={view}>
      <WelcomeCardHead icon={Cpu} title="Machine health">
        {health ? (
          <span className="ade-mh-head-meta">
            {/* Only "on battery": Electron gives no charge level, and Chromium's
                Battery Status API costs the main process ~7 ms/s while open. */}
            {health.onBattery ? (
              <span className="ade-mh-battery" title="Running on battery power">
                <BatteryMedium size={13} aria-hidden />
                On battery
              </span>
            ) : null}
            <span className="ade-home-card-scope" title={health.cpuModel ?? undefined}>{health.hostname} · up {formatUptime(health.uptimeSec)}</span>
          </span>
        ) : null}
      </WelcomeCardHead>
      <div className="kit-card-body ade-mh-body">{body}</div>
    </section>
  );
}
