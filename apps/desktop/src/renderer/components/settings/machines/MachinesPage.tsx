import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { AppleLogo, ArrowRight, Brain, CaretRight, Palette, Wrench } from "@phosphor-icons/react";
import { THIS_MACHINE_NAME } from "../../../../shared/machineIdentity";
import type { ProjectMachine } from "../../../state/projectMachines";
import { isMacPlatform } from "../../../lib/platform";
import { useAutoUpdateSnapshot } from "../../app/useAutoUpdateSnapshot";
import { UpdateTrackChip } from "../../app/ChannelBadge";
import { MachineAvatar, machineFormFactor, useMachineColor } from "../../remoteTargets/MachineIdentity";
import { FreeSpaceMeter } from "../health/healthCharts";
import { formatBytes, freeSpaceLevel } from "../storage/storageView";
import { osLabel } from "../general/GeneralPage";
import { machineSectionAvailable, type SettingsMachinePage } from "../SettingsMachinesNav";
import { knownAdeVersions, machineUpdateTargetVersion } from "../../remoteTargets/remoteMachineModel";
import { TabContent } from "../settingsTabContent";
import { useMachineFacts, type MachineFacts } from "./machineFacts";
import { SingleMachineUpdateRow } from "../general/MachineUpdateRows";
import { useSettingsMachines } from "./settingsMachinesContext";
import { useThisComputerFacts } from "./useThisComputerFacts";
import "./machinesPage.css";

/**
 * System → Machines: every machine on one page, this one first. A machine
 * opens to its own page with only the sections that work for it from here;
 * anything that would only say "open ADE over there" is left out.
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
  const { machines, thisMachineName, openMachine } = useSettingsMachines();
  const update = useAutoUpdateSnapshot();
  const facts = useMachineFacts(machines, update.currentVersion || null);
  const local = useThisComputerFacts();
  const known = useKnownVersions();
  const online = machines.filter((machine) => machine.online || machine.isThisMachine).length;
  const onBeta = machines.filter((machine) => facts.get(machine.machineId)?.track === "beta").length;
  const behind = machines.filter((machine) => {
    const connected = facts.get(machine.machineId)?.connected;
    return connected && machine.online && machineUpdateTargetVersion(connected, known) != null;
  }).length;
  const { openTab } = useSettingsMachines();
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

/** Every build this computer knows of, on either track (`knownAdeVersions`). */
function useKnownVersions(): string[] {
  const snapshot = useAutoUpdateSnapshot();
  const { currentVersion, version, latestKnownVersion } = snapshot;
  const latestStable = snapshot.latestByTrack?.stable ?? null;
  const latestBeta = snapshot.latestByTrack?.beta ?? null;
  return useMemo(
    () => knownAdeVersions({ currentVersion, version, latestKnownVersion, latestByTrack: { stable: latestStable, beta: latestBeta } }),
    [currentVersion, version, latestKnownVersion, latestStable, latestBeta],
  );
}

function MachineListRow({
  machine,
  name,
  fact,
  local,
  known,
  onOpen,
}: {
  machine: ProjectMachine;
  name: string;
  fact: MachineFacts | undefined;
  local: ReturnType<typeof useThisComputerFacts> | null;
  known: readonly string[];
  onOpen: () => void;
}) {
  const offline = !machine.online && !machine.isThisMachine;
  const status = presence(machine, local);
  const target = fact?.connected && machine.online ? machineUpdateTargetVersion(fact.connected, known) : null;
  const os = machine.isThisMachine ? osLabel(local?.info?.platform) : platformWord(fact?.platform);
  const pressure = local?.pressure ?? null;
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
          {name}
          {machine.isThisMachine ? <span className="kit-tag">This machine</span> : null}
        </span>
        <span className="ade-mx-row-sub">
          <span className="kit-dot" data-state={status.state} aria-hidden />
          {[status.word, os].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="ade-mx-row-facts">
        {pressure && pressure.totalBytes > 0 ? (
          <span className="ade-mx-row-disk" title={`${formatBytes(pressure.freeBytes)} free`}>
            <span className="kit-num">{formatBytes(pressure.freeBytes)} free</span>
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

function platformWord(platform: MachineFacts["platform"] | undefined): string | null {
  if (platform === "mac") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "linux") return "Linux";
  return null;
}

/**
 * One machine's page: what it is, then the settings that reach it from here.
 * Its Behaviour sections come in through the page's machine scope (the pin
 * Settings built for it), so each one acts on this machine and no other.
 */
function MachineDetail({ scope }: { scope: SettingsMachinePage }) {
  const { machines, thisMachineName, openMachine, openTab } = useSettingsMachines();
  const update = useAutoUpdateSnapshot();
  const machine = machines.find((candidate) => candidate.machineId === scope.machineId) ?? null;
  const facts = useMachineFacts(machine ? [machine] : [], update.currentVersion || null);
  const local = useThisComputerFacts();
  const fact = machine ? facts.get(machine.machineId) : undefined;
  const name = machine ? machineDisplayName(machine, thisMachineName) : scope.machineName;
  const color = useMachineColor(fact?.colorKey ?? scope.machineId);
  const offline = !scope.online && !scope.isThisMachine;
  const providersReach = machineSectionAvailable("routed", scope);
  const os = scope.isThisMachine ? osLabel(local.info?.platform) : platformWord(fact?.platform);
  const runtime = scope.isThisMachine ? local.info?.localRuntime ?? null : null;
  const serviceOk = runtime ? runtime.connectionState === "connected" && runtime.runtimeMode === "primary" : null;
  const pressure = scope.isThisMachine ? local.pressure : null;

  const links: Array<{ id: string; icon: ReactNode; title: string; hint: string; onOpen: () => void }> = [];
  if (providersReach) {
    links.push({
      id: "providers",
      icon: <Brain size={15} />,
      title: "Providers",
      hint: "Sign-ins and models",
      onOpen: () => openMachine(scope.machineId, "agents"),
    });
  }
  if (scope.isThisMachine) {
    links.push({ id: "appearance", icon: <Palette size={15} />, title: "Appearance", hint: "Theme, fonts and terminal", onOpen: () => openTab("appearance") });
    if (isMacPlatform()) {
      links.push({ id: "apple", icon: <AppleLogo size={15} />, title: "Apple devices", hint: "Simulators and recordings", onOpen: () => openTab("apple") });
    }
    links.push({ id: "advanced", icon: <Wrench size={15} />, title: "Advanced", hint: "Service, command line, reports", onOpen: () => openTab("advanced") });
  }

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
              {[scope.isThisMachine ? "This machine" : offline ? "Offline" : "Online", os].filter(Boolean).join(" · ")}
            </div>
          </div>
          <div className="ade-mx-detail-facts">
            {machine ? <SingleMachineUpdateRow machine={machine} name={name} /> : null}
            {serviceOk != null ? (
              <span className="ade-mx-fact">
                <span className="kit-eyebrow">Service</span>
                <span className="ade-mx-fact-value"><span className="kit-dot" data-state={serviceOk ? "ok" : "crit"} aria-hidden />{serviceOk ? "Running" : "Not running"}</span>
              </span>
            ) : null}
            {pressure && pressure.totalBytes > 0 ? (
              <span className="ade-mx-fact ade-mx-fact--disk">
                <span className="kit-eyebrow">Disk</span>
                <span className="ade-mx-fact-value"><span className="kit-num">{formatBytes(pressure.freeBytes)} free</span></span>
                <FreeSpaceMeter freeBytes={pressure.freeBytes} totalBytes={pressure.totalBytes} level={freeSpaceLevel(pressure.freeBytes, pressure.totalBytes)} />
              </span>
            ) : null}
          </div>
        </div>
      </section>

      {offline ? (
        <div className="ade-mx-quiet">Its settings come back when it is online.</div>
      ) : (
        <>
          {links.length > 0 ? (
            <div className="ade-mx-links" aria-label="Settings for this machine">
              {links.map((link) => (
                <button key={link.id} type="button" className="ade-mx-link" onClick={link.onOpen}>
                  <span className="ade-mx-link-icon">{link.icon}</span>
                  <span className="ade-mx-link-text">
                    <span className="ade-mx-link-title">{link.title}</span>
                    <span className="ade-mx-link-hint">{link.hint}</span>
                  </span>
                  <CaretRight size={12} aria-hidden />
                </button>
              ))}
            </div>
          ) : null}
          {/* The Behaviour sections that reach this machine; the rest are left out. */}
          <TabContent tab="behaviour" machine={scope} embedded />
        </>
      )}
    </div>
  );
}
