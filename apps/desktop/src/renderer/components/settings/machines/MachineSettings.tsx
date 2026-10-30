import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AppleLogo,
  ArrowClockwise,
  ArrowsClockwise,
  Brain,
  CaretRight,
  Coffee,
  Cpu,
  FolderSimple,
  GitBranch,
  HardDrive,
  Gauge,
  PlugsConnected,
  Robot,
  Terminal,
  TerminalWindow,
} from "@phosphor-icons/react";
import type { AutoUpdatePreferences, KeepAwakeLevel, KeepAwakeSnapshot } from "../../../../shared/types";
import type { TerminalShellSettings } from "../../../../shared/types/terminalShells";
import { updateTrackLabel, type UpdateTrack } from "../../../../shared/updateTrack";
import type { ProjectMachine } from "../../../state/projectMachines";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { useAutoUpdateSnapshot } from "../../app/useAutoUpdateSnapshot";
import { showToast } from "../../app/toast/toastStore";
import { SettingsSelect, SettingsToggle } from "../primitives";
import { FreeSpaceMeter } from "../health/healthCharts";
import { formatBytes, freeSpaceLevel } from "../storage/storageView";
import { SingleMachineUpdateRow } from "../general/MachineUpdateRows";
import { machineSectionAvailable, type SettingsMachinePage } from "../SettingsMachinesNav";
import { osLabel, platformWord, type MachineFacts } from "./machineFacts";
import { useSettingsMachines } from "./settingsMachinesContext";
import type { useThisComputerFacts } from "./useThisComputerFacts";
import { MachineCapabilitiesArea, MachinePreferenceRow, MachineWorkCopies } from "./machineSeams";

/**
 * Everything Settings knows or can change about one machine, in four groups
 * of same-size rows. A row is a control that acts on this machine (through
 * its pin), a link to where the setting lives, or — when only that machine's
 * own ADE can change it — its value and "Change on that machine". Never an
 * empty page: what cannot be read says so.
 */
export function MachineSettings({
  scope,
  machine,
  name,
  fact,
  local,
}: {
  scope: SettingsMachinePage;
  machine: ProjectMachine | null;
  name: string;
  fact: MachineFacts | undefined;
  local: ReturnType<typeof useThisComputerFacts>;
}) {
  const { openMachine, openTab } = useSettingsMachines();
  const isThis = scope.isThisMachine;
  // Reachable through its own brain: pinned calls (or unpinned on the tab's own machine).
  const reach = machineSectionAvailable("routed", scope);
  const mac = fact?.platform === "mac";
  const elsewhere = <UnreachableHint isThis={isThis} />;
  const connection = fact?.connection ?? null;
  // "darwin-arm64" from a connection: the platform is already in `os`.
  const rawArch = isThis ? local.info?.arch ?? null : connection?.arch ?? null;
  const arch = rawArch ? rawArch.split("-").pop() ?? rawArch : null;
  const os = isThis ? osLabel(local.info?.platform) : platformWord(fact?.platform);
  const runtime = isThis ? local.info?.localRuntime ?? null : null;
  const serviceOk = runtime ? runtime.connectionState === "connected" && runtime.runtimeMode === "primary" : null;
  const projects = connection?.projects.filter((project) => project.catalogVisibility !== "system") ?? null;

  return (
    <div className="ade-mx-groups">
      <MachineGroup title="Updates">
        <MachineRow icon={<ArrowsClockwise size={14} />} title="Version"
          control={machine ? <SingleMachineUpdateRow machine={machine} name={name} /> : <RowValue>Unknown</RowValue>} />
        <TrackRow scope={scope} fact={fact} reach={reach} onOpen={() => openTab("general", "update-track")} />
        <AutoInstallRow isThis={isThis} onOpen={() => openTab("general", "auto-updates")} />
      </MachineGroup>

      <MachineGroup title="Chats and agents">
        <MachineRow
          icon={<Brain size={14} />}
          title="Providers"
          value="Sign-ins and models"
          control={reach ? <RowLink onClick={() => openMachine(scope.machineId, "agents")} /> : elsewhere}
        />
        <ContinueRow scope={scope} reach={reach} />
        <ShellRow scope={scope} reach={reach} />
      </MachineGroup>

      <MachineGroup title={isThis ? "This machine" : "Machine"}>
        <MachineRow
          icon={<Gauge size={14} />}
          title="Background service"
          value={isThis
            ? <><span className="kit-dot" data-state={serviceOk == null ? undefined : serviceOk ? "ok" : "crit"} aria-hidden />{serviceOk == null ? "Checking…" : serviceOk ? "Running" : "Not running"}</>
            : <><span className="kit-dot" data-state={scope.online ? "ok" : undefined} aria-hidden />{scope.online ? `Connected${connection?.route ? ` over ${routeWord(connection.route.kind)}` : ""}` : "Not connected"}</>}
          control={isThis ? <RowLink label="Advanced" onClick={() => openTab("advanced", "diagnostics")} /> : null}
        />
        <CliRow isThis={isThis} onOpen={() => openTab("advanced", "ade-cli")} />
        <KeepAwakeRow scope={scope} reach={reach} onOpen={isThis ? () => openTab("behaviour", "keep-awake") : undefined} />
        {mac ? (
          <MachineRow
            icon={<AppleLogo size={14} />}
            title="Apple devices"
            value="Simulators and recordings"
            control={isThis ? <RowLink onClick={() => openTab("apple")} /> : elsewhere}
          />
        ) : null}
        <MachineRow icon={<Cpu size={14} />} title="System" value={[os, arch].filter(Boolean).join(" · ") || "Unknown"} />
        {isThis && local.pressure && local.pressure.totalBytes > 0 ? (
          <MachineRow
            icon={<HardDrive size={14} />}
            title="Disk"
            value={`${formatBytes(local.pressure.freeBytes)} free of ${formatBytes(local.pressure.totalBytes)}`}
            control={(
              <span className="ade-mx-row-meter">
                <FreeSpaceMeter freeBytes={local.pressure.freeBytes} totalBytes={local.pressure.totalBytes} level={freeSpaceLevel(local.pressure.freeBytes, local.pressure.totalBytes)} />
              </span>
            )}
          />
        ) : null}
        {projects ? (
          <MachineRow
            icon={<FolderSimple size={14} />}
            title="Projects"
            value={projects.length === 0 ? "None yet" : projects.slice(0, 3).map((project) => project.displayName).join(", ") + (projects.length > 3 ? ` and ${projects.length - 3} more` : "")}
            control={projects.length > 0 ? <RowValue>{projects.length}</RowValue> : null}
          />
        ) : null}
        {!isThis && connection?.target.hostname ? (
          <MachineRow icon={<PlugsConnected size={14} />} title="Address" value={connection.target.hostname} />
        ) : null}
        {/* How often other machines send work here, once it can be read and set. */}
        <MachinePreferenceRow preference={null} />
      </MachineGroup>

      {/* What the machine can run, and the copies of other machines' work it
          holds, once its brain reports them (lane 8fbb5263). */}
      <MachineCapabilitiesArea capabilities={null} />
      <MachineWorkCopies pin={scope.pin} reach={reach} />
    </div>
  );
}

// ── Layout ─────────────────────────────────────────────────────────────────

function MachineGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ade-mx-group">
      <h2 className="kit-eyebrow ade-mx-group-title">{title}</h2>
      <div className="ade-mx-group-rows">{children}</div>
    </section>
  );
}

export function MachineRow({
  icon,
  title,
  value,
  control,
}: {
  icon: ReactNode;
  title: string;
  value?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="ade-mx-srow">
      <span className="ade-mx-srow-icon" aria-hidden>{icon}</span>
      <span className="ade-mx-srow-text">
        <span className="ade-mx-srow-title">{title}</span>
        {value != null && value !== "" ? <span className="ade-mx-srow-value">{value}</span> : null}
      </span>
      <span className="ade-mx-srow-control">{control}</span>
    </div>
  );
}

function RowLink({ label = "Open", onClick }: { label?: string; onClick: () => void }) {
  return (
    <button type="button" className="ade-mx-srow-link" onClick={onClick}>
      {label}
      <CaretRight size={11} weight="bold" aria-hidden />
    </button>
  );
}

function RowHint({ children = "Change on that machine" }: { children?: ReactNode }) {
  return <span className="ade-mx-srow-hint">{children}</span>;
}

/**
 * A row this page cannot reach. Another machine: change it there. This
 * computer: the project tab is bound to another machine and this computer has
 * no checkout, so its routed calls have nowhere to go from this tab.
 */
function UnreachableHint({ isThis }: { isThis: boolean }) {
  return <RowHint>{isThis ? "Not from this project tab" : undefined}</RowHint>;
}

function RowValue({ children }: { children: ReactNode }) {
  return <span className="ade-mx-srow-hint">{children}</span>;
}

function routeWord(kind: string): string {
  if (kind === "tailnet") return "Tailscale";
  if (kind === "lan") return "your network";
  if (kind === "relay") return "ADE relay";
  if (kind === "ssh") return "SSH";
  return kind;
}

/**
 * A read through the machine's pin, keyed on the pin's key (a rebuilt pin is
 * the same machine). `undefined` while reading, `null` when that machine
 * could not answer (an older brain, or a failed call).
 */
function usePinnedRead<T>(
  scope: SettingsMachinePage,
  enabled: boolean,
  read: (pin: SettingsMachinePage["pin"]) => Promise<T>,
): [T | null | undefined, (next: T) => void] {
  const [value, setValue] = useState<T | null | undefined>(undefined);
  const readRef = useRef(read);
  readRef.current = read;
  const pinRef = useRef(scope.pin);
  pinRef.current = scope.pin;
  const pinKey = scope.pin?.key ?? null;
  useEffect(() => {
    if (!enabled) {
      setValue(null);
      return undefined;
    }
    let cancelled = false;
    setValue(undefined);
    void Promise.resolve()
      .then(() => readRef.current(pinRef.current))
      .then((next) => {
        if (!cancelled) setValue(next);
      })
      .catch(() => {
        if (!cancelled) setValue(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, pinKey]);
  return [value, setValue];
}

// ── Rows that read or change the machine ───────────────────────────────────

function TrackRow({ scope, fact, reach, onOpen }: { scope: SettingsMachinePage; fact: MachineFacts | undefined; reach: boolean; onOpen: () => void }) {
  const snapshot = useAutoUpdateSnapshot();
  const available = isAdeAvailable(window.ade.ai?.getMachineUpdateTrack);
  const [saved] = usePinnedRead(scope, !scope.isThisMachine && reach && available, (pin) => window.ade.ai.getMachineUpdateTrack(pin));
  const track: UpdateTrack | null = scope.isThisMachine
    ? snapshot.track?.selected ?? fact?.track ?? null
    : saved?.track ?? fact?.track ?? null;
  return (
    <MachineRow
      icon={<GitBranch size={14} />}
      title="Update track"
      value={track ? updateTrackLabel(track) : "Unknown"}
      // A switch checks this machine's databases and installs here, so it is
      // made on the machine itself.
      control={scope.isThisMachine ? <RowLink label="Change" onClick={onOpen} /> : <RowHint />}
    />
  );
}

function AutoInstallRow({ isThis, onOpen }: { isThis: boolean; onOpen: () => void }) {
  const [preferences, setPreferences] = useState<AutoUpdatePreferences | null>(null);
  useEffect(() => {
    if (!isThis) return undefined;
    let cancelled = false;
    void Promise.resolve()
      .then(() => window.ade.updateGetPreferences())
      .then((next) => {
        if (!cancelled) setPreferences(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isThis]);
  return (
    <MachineRow
      icon={<ArrowClockwise size={14} />}
      title="Install updates automatically"
      value={isThis ? (preferences ? (preferences.automaticInstall ? "On" : "Off") : "…") : null}
      control={isThis ? <RowLink label="Change" onClick={onOpen} /> : <RowHint />}
    />
  );
}

function ContinueRow({ scope, reach }: { scope: SettingsMachinePage; reach: boolean }) {
  const available = isAdeAvailable(window.ade.ai?.getContinueAfterRestart);
  const can = available && (scope.isThisMachine || reach);
  const [value, setValue] = usePinnedRead(scope, can, (pin) => window.ade.ai.getContinueAfterRestart(pin));
  const [saving, setSaving] = useState(false);
  const save = useCallback(async (next: boolean) => {
    setSaving(true);
    setValue({ enabled: next });
    try {
      setValue(await window.ade.ai.setContinueAfterRestart(next, scope.pin));
    } catch (error) {
      setValue({ enabled: !next });
      showToast({ tone: "error", title: "Couldn't save the setting", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }, [scope.pin, setValue]);
  return (
    <MachineRow
      icon={<Robot size={14} />}
      title="Continue chats after restarts"
      value={value === undefined ? "…" : value === null ? "Unknown" : value.enabled ? "A chat picks up where it stopped" : "Chats stop at a restart"}
      control={value ? (
        <SettingsToggle label="Continue chats after restarts" checked={value.enabled} disabled={saving} onChange={(next) => void save(next)} />
      ) : value === null && !scope.isThisMachine ? <RowHint /> : null}
    />
  );
}

function ShellRow({ scope, reach }: { scope: SettingsMachinePage; reach: boolean }) {
  const [settings, setSettings] = usePinnedRead<TerminalShellSettings>(scope, reach, (pin) => window.ade.pty.getShellSettings(pin));
  const [saving, setSaving] = useState(false);
  const AUTOMATIC = "__automatic__";
  const options = settings
    ? [
        { value: AUTOMATIC, label: settings.automaticShell ? `Automatic (${settings.automaticShell.split(/[\\/]/).pop()})` : "Automatic" },
        ...settings.shells.map((shell) => ({ value: shell.id, label: shell.label })),
      ]
    : [];
  return (
    <MachineRow
      icon={<TerminalWindow size={14} />}
      title="Terminal shell"
      value="What a new terminal opens"
      control={settings ? (
        <SettingsSelect
          ariaLabel="Terminal shell"
          value={settings.defaultShellId ?? AUTOMATIC}
          options={options}
          disabled={saving}
          onChange={(next) => {
            setSaving(true);
            void window.ade.pty.setDefaultShell({ shellId: next === AUTOMATIC ? null : next }, scope.pin)
              .then((result) => setSettings(result))
              .catch((error: unknown) => showToast({ tone: "error", title: "Couldn't change the shell", message: error instanceof Error ? error.message : String(error) }))
              .finally(() => setSaving(false));
          }}
        />
      ) : settings === null ? <UnreachableHint isThis={scope.isThisMachine} /> : null}
    />
  );
}

const KEEP_AWAKE_LABEL: Record<KeepAwakeLevel, string> = {
  never: "Never",
  "while-away": "While I'm away",
  "lid-closed": "Even with the lid closed",
};

function KeepAwakeRow({ scope, reach, onOpen }: { scope: SettingsMachinePage; reach: boolean; onOpen?: () => void }) {
  const [snapshot, setSnapshot] = usePinnedRead<KeepAwakeSnapshot>(scope, reach || scope.isThisMachine, (pin) => window.ade.keepAwakeGet(pin));
  const [saving, setSaving] = useState(false);
  if (snapshot === undefined) {
    return <MachineRow icon={<Coffee size={14} />} title="Keep awake" value="…" />;
  }
  if (snapshot === null || snapshot.platform === "other") {
    return <MachineRow icon={<Coffee size={14} />} title="Keep awake" value={snapshot ? `Not available on ${scope.isThisMachine ? "this machine" : "that machine"}` : "Unknown"} control={snapshot || scope.isThisMachine ? null : <RowHint />} />;
  }
  // The lid-closed level needs the Mac's own password prompt, so it is set
  // from that Mac's page (Behaviour) rather than from a compact row.
  const levels: KeepAwakeLevel[] = ["never", "while-away"];
  if (snapshot.preferences.level === "lid-closed") levels.push("lid-closed");
  return (
    <MachineRow
      icon={<Coffee size={14} />}
      title="Keep awake"
      value={snapshot.levelError ?? "So agents keep working"}
      control={(
        <span className="ade-mx-srow-pair">
          <SettingsSelect
            ariaLabel="Keep awake"
            value={snapshot.preferences.level}
            options={levels.map((level) => ({ value: level, label: KEEP_AWAKE_LABEL[level] }))}
            disabled={saving}
            onChange={(level) => {
              setSaving(true);
              void window.ade.keepAwakeSetLevel(level, scope.pin)
                .then((next) => setSnapshot(next))
                .catch((error: unknown) => showToast({ tone: "error", title: "Couldn't change keep awake", message: error instanceof Error ? error.message : String(error) }))
                .finally(() => setSaving(false));
            }}
          />
          {onOpen ? <RowLink label="More" onClick={onOpen} /> : null}
        </span>
      )}
    />
  );
}

function CliRow({ isThis, onOpen }: { isThis: boolean; onOpen: () => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.ade.adeCli.getStatus>> | null>(null);
  useEffect(() => {
    if (!isThis || !isAdeAvailable(window.ade.adeCli?.getStatus)) return undefined;
    let cancelled = false;
    void Promise.resolve()
      .then(() => window.ade.adeCli.getStatus())
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isThis]);
  const installed = status?.terminalInstalled;
  return (
    <MachineRow
      icon={<Terminal size={14} />}
      title="ade command"
      value={isThis ? (status ? (installed ? "In your Terminal" : "Agents only — not in your Terminal") : "…") : null}
      control={isThis ? <RowLink label="Advanced" onClick={onOpen} /> : <RowHint />}
    />
  );
}
