import { useMemo, type CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowRight, CaretRight } from "@phosphor-icons/react";
import { THIS_MACHINE_NAME } from "../../../../shared/machineIdentity";
import type { ProjectMachine } from "../../../state/projectMachines";
import { useAutoUpdateSnapshot } from "../../app/useAutoUpdateSnapshot";
import { UpdateTrackChip } from "../../app/ChannelBadge";
import { MachineAvatar, machineFormFactor, useMachineColor } from "../../remoteTargets/MachineIdentity";
import { FreeSpaceMeter } from "../health/healthCharts";
import { formatBytes, freeSpaceLevel } from "../storage/storageView";
import { machineSectionAvailable, settingsMachinePageFor, type SettingsMachinePage } from "../SettingsMachinesNav";
import type { MachineStats } from "../../../../shared/types/machineStats";
import { useMachineStatsMap, type MachineStatsRequest } from "../../../state/machineStats";
import { useMachinePlacementPreferences } from "../../../state/machinePlacement";
import { placementTag } from "../../lanes/machineLoadText";
import { headroomLevel, Meter, powerWords } from "./machineSeams";
import { machineUpdateTargetVersion } from "../../remoteTargets/remoteMachineModel";
import { useKnownAdeVersions } from "../../remoteTargets/machineUpdates";
import { osLabel, platformWord, useMachineFacts, type MachineFacts } from "./machineFacts";
import { useSettingsMachines } from "./settingsMachinesContext";
import { useThisComputerFacts } from "./useThisComputerFacts";
import { MachineSettings } from "./MachineSettings";
import "./machinesPage.css";

/**
 * System → Machines: every machine on one page, this one first. A machine
 * opens to its own page: everything Settings knows or can change about it.
 */
export function MachinesPage({ machine }: { machine: SettingsMachinePage | null }) {
  const [searchParams] = useSearchParams();
  const detail = searchParams.get("machine");
  return detail && machine ? <MachineDetail scope={machine} /> : <MachinesList />;
}

function machineDisplayName(machine: ProjectMachine, thisMachineName: string | null): string {
  return machine.isThisMachine ? (thisMachineName ?? THIS_MACHINE_NAME) : machine.machineName;
}

function MachinesList() {
  const { machines, thisMachineName, openMachine, openTab } = useSettingsMachines();
  const update = useAutoUpdateSnapshot();
  const facts = useMachineFacts(machines, update.currentVersion || null);
  const local = useThisComputerFacts();
  const known = useKnownAdeVersions();
  // Each machine's load, read through its own pin once when the list opens.
  const statsRequests = useMemo<MachineStatsRequest[]>(() => machines.flatMap((machine) => {
    if (!machine.online && !machine.isThisMachine) return [];
    const page = settingsMachinePageFor(machine);
    return machineSectionAvailable("routed", page) ? [{ id: machine.machineId, pin: page.pin }] : [];
  }), [machines]);
  const { stats } = useMachineStatsMap(statsRequests, true);
  const { preferenceOf } = useMachinePlacementPreferences();
  const online = machines.filter((machine) => machine.online || machine.isThisMachine).length;
  const onBeta = machines.filter((machine) => facts.get(machine.machineId)?.track === "beta").length;
  const behind = machines.filter((machine) => {
    const connected = facts.get(machine.machineId)?.connected;
    return connected && machine.online && machineUpdateTargetVersion(connected, known) != null;
  }).length;
  const summary = [
    online === machines.length ? "All online" : `${online} online — ${machines.length - online} offline`,
    onBeta > 0 ? `${machines.length - onBeta} on Stable, ${onBeta} on Beta` : "All on Stable",
  ];
  return (
    <div className="ade-mx" id="machines-list" data-settings-anchor="machines-list">
      <section className="ade-mx-hero ade-mx-hero--list">
        <div className="ade-mx-hero-wash" aria-hidden />
        <div className="ade-mx-lineup" aria-hidden>
          {machines.slice(0, 5).map((machine, index) => {
            const fact = facts.get(machine.machineId);
            const name = machineDisplayName(machine, thisMachineName);
            return (
              <span key={machine.machineId} className="ade-mx-lineup-tile" style={{ "--i": index } as CSSProperties}>
                <MachineAvatar
                  colorKey={fact?.colorKey ?? machine.machineId}
                  name={name}
                  platform={fact?.platform ?? "unknown"}
                  formFactor={machineFormFactor({ name })}
                  size={60}
                  dimmed={!machine.online && !machine.isThisMachine}
                />
              </span>
            );
          })}
        </div>
        <div className="ade-mx-hero-text">
          <div className="ade-mx-hero-title">{machines.length === 1 ? "1 machine" : `${machines.length} machines`}</div>
          <div className="ade-mx-hero-chips">
            {summary.map((line) => <span key={line} className="ade-mx-hero-chip">{line}</span>)}
            {behind > 0 ? (
              // The updates themselves are on General, one row per machine.
              <button type="button" className="ade-mx-hero-chip" data-tone="accent" onClick={() => openTab("general", "update-other-machines")}>
                {behind === 1 ? "1 can update" : `${behind} can update`}
                <ArrowRight size={10} weight="bold" aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <div className="ade-mx-list" role="list">
        {machines.map((machine) => (
          <MachineListRow
            key={machine.machineId}
            machine={machine}
            name={machineDisplayName(machine, thisMachineName)}
            fact={facts.get(machine.machineId)}
            local={machine.isThisMachine ? local : null}
            known={known}
            stats={stats.get(machine.machineId) ?? null}
            preferenceTag={placementTag({ preference: preferenceOf(facts.get(machine.machineId)?.colorKey) })}
            onOpen={() => openMachine(machine.machineId)}
          />
        ))}
      </div>
    </div>
  );
}

/** The dot and word under a machine's name: its service here, its connection elsewhere. */
function presence(
  machine: ProjectMachine,
  local: ReturnType<typeof useThisComputerFacts> | null,
): { state: "ok" | "crit" | undefined; word: string } {
  if (machine.isThisMachine) {
    const runtime = local?.info?.localRuntime ?? null;
    if (!runtime) return { state: undefined, word: "Service" };
    const ok = runtime.connectionState === "connected" && runtime.runtimeMode === "primary";
    return ok ? { state: "ok", word: "Service running" } : { state: "crit", word: "Service not running" };
  }
  return machine.online ? { state: "ok", word: "Online" } : { state: undefined, word: "Offline" };
}

function MachineListRow({
  machine,
  name,
  fact,
  local,
  known,
  stats,
  preferenceTag,
  onOpen,
}: {
  machine: ProjectMachine;
  name: string;
  fact: MachineFacts | undefined;
  local: ReturnType<typeof useThisComputerFacts> | null;
  known: readonly string[];
  stats: MachineStats | null;
  /** "Preferred", "Less often", "Manual only"; null for Normal. */
  preferenceTag: string | null;
  onOpen: () => void;
}) {
  const offline = !machine.online && !machine.isThisMachine;
  const status = presence(machine, local);
  const target = fact?.connected && machine.online ? machineUpdateTargetVersion(fact.connected, known) : null;
  const os = machine.isThisMachine ? osLabel(local?.info?.platform) : platformWord(fact?.platform);
  const pressure = local?.pressure ?? (stats?.disk ? { freeBytes: stats.disk.freeBytes, totalBytes: stats.disk.totalBytes } : null);
  const busy = stats?.cpu.busyPercent ?? null;
  const builds = stats?.builds?.reduce((sum, build) => sum + build.count, 0) ?? 0;
  const busyNotes = offline ? [] : [
    builds > 0 ? (builds === 1 ? "1 build running" : `${builds} builds running`) : null,
    stats?.power?.onBattery ? powerWords(stats.power) : null,
  ];
  return (
    <button type="button" role="listitem" className="ade-mx-row" data-offline={offline ? "true" : undefined} onClick={onOpen}>
      <MachineAvatar
        colorKey={fact?.colorKey ?? machine.machineId}
        name={name}
        platform={fact?.platform ?? "unknown"}
        formFactor={machineFormFactor({ name })}
        size={40}
        dimmed={offline}
      />
      <span className="ade-mx-row-id">
        <span className="ade-mx-row-name">
          <span className="ade-mx-row-name-text">{name}</span>
          {machine.isThisMachine ? <span className="kit-tag">This machine</span> : null}
          {preferenceTag ? <span className="kit-tag" data-tone={preferenceTag === "Manual only" ? "warn" : undefined}>{preferenceTag}</span> : null}
        </span>
        <span className="ade-mx-row-sub">
          <span className="kit-dot" data-state={status.state} aria-hidden />
          {[status.word, os, ...busyNotes].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="ade-mx-row-facts">
        {stats && !offline && busy != null ? (
          <span
            className="ade-mx-row-load"
            title={`CPU ${busy}% busy over ${stats.cpu.cores} cores · ${formatBytes(stats.memory.availableBytes)} of ${formatBytes(stats.memory.totalBytes)} memory free`}
          >
            <span className="ade-mx-row-load-line">
              <span className="kit-num">CPU {busy}%</span>
              <span className="kit-num">{formatBytes(stats.memory.availableBytes)} memory</span>
            </span>
            <Meter percent={busy} level={headroomLevel(100 - busy)} label="CPU busy" />
          </span>
        ) : null}
        {pressure && pressure.totalBytes > 0 ? (
          <span className="ade-mx-row-disk" title={`${formatBytes(pressure.freeBytes)} free`}>
            <span className="kit-num">{formatBytes(pressure.freeBytes)} disk free</span>
            <FreeSpaceMeter freeBytes={pressure.freeBytes} totalBytes={pressure.totalBytes} level={freeSpaceLevel(pressure.freeBytes, pressure.totalBytes)} />
          </span>
        ) : null}
        <span className="ade-mx-row-version">
          {fact?.versionLabel ? <span className="kit-num">{fact.versionLabel}</span> : null}
          {target ? (
            <span className="ade-mx-row-target" title={`${target} is out on its track`}>
              <ArrowRight size={10} weight="bold" aria-hidden />
              <span className="kit-num">{target}</span>
            </span>
          ) : null}
          {fact ? <UpdateTrackChip track={fact.track} /> : null}
        </span>
      </span>
      <CaretRight size={13} className="ade-mx-row-caret" aria-hidden />
    </button>
  );
}

/**
 * One machine's page: who it is, then everything Settings knows or can change
 * about it, grouped (`MachineSettings`). Its controls act through the page's
 * machine scope (the pin Settings built for it), so each one reaches this
 * machine and no other.
 */
function MachineDetail({ scope }: { scope: SettingsMachinePage }) {
  const { machines, thisMachineName } = useSettingsMachines();
  const update = useAutoUpdateSnapshot();
  const machine = machines.find((candidate) => candidate.machineId === scope.machineId) ?? null;
  const facts = useMachineFacts(machine ? [machine] : [], update.currentVersion || null);
  const local = useThisComputerFacts();
  const fact = machine ? facts.get(machine.machineId) : undefined;
  const name = machine ? machineDisplayName(machine, thisMachineName) : scope.machineName;
  const color = useMachineColor(fact?.colorKey ?? scope.machineId);
  const offline = !scope.online && !scope.isThisMachine;
  const os = scope.isThisMachine ? osLabel(local.info?.platform) : platformWord(fact?.platform);

  return (
    <div className="ade-mx">
      <section className="ade-mx-hero ade-mx-hero--machine" style={{ "--mx-color": color } as CSSProperties}>
        <div className="ade-mx-hero-wash" aria-hidden />
        <div className="ade-mx-detail-row">
          <MachineAvatar
            colorKey={fact?.colorKey ?? scope.machineId}
            name={name}
            platform={fact?.platform ?? "unknown"}
            formFactor={machineFormFactor({ name })}
            size={64}
            dimmed={offline}
          />
          <div className="ade-mx-detail-id">
            <div className="ade-mx-hero-title ade-mx-hero-title--row">
              {name}
              {fact ? <UpdateTrackChip track={fact.track} /> : null}
            </div>
            <div className="ade-mx-hero-sub">
              <span className="kit-dot" data-state={offline ? undefined : "ok"} aria-hidden />
              {[scope.isThisMachine ? "This machine" : offline ? "Offline" : "Online", os, fact?.versionLabel ? `ADE ${fact.versionLabel}` : null].filter(Boolean).join(" · ")}
            </div>
          </div>
        </div>
      </section>

      {offline ? (
        // An offline machine still shows what Settings knows; its controls
        // come back when it does.
        <div className="ade-mx-quiet">Its settings can be changed when it is back online.</div>
      ) : null}
      <MachineSettings scope={scope} machine={machine} name={name} fact={fact} local={local} />
    </div>
  );
}
