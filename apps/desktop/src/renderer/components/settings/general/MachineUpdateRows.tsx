import { useMemo, useState, type ReactNode } from "react";
import { ArrowClockwise, ArrowRight, CircleNotch } from "@phosphor-icons/react";
import type { ProjectMachine } from "../../../state/projectMachines";
import { useAutoUpdateSnapshot } from "../../app/useAutoUpdateSnapshot";
import { requestDownloadedUpdateInstall } from "../../app/autoUpdateInstallAction";
import { updateRestartAction } from "../../app/updateRestartAction";
import { UpdateTrackChip } from "../../app/ChannelBadge";
import { MachineAvatar, machineFormFactor } from "../../remoteTargets/MachineIdentity";
import {
  canUpdateOtherMachines,
  isMachineUpdateBusy,
  requestMachineUpdates,
  useMachineUpdates,
} from "../../remoteTargets/machineUpdates";
import {
  describeMachineUpdateAttempt,
  knownAdeVersions,
  machineUpdateTargetVersion,
  machinesBehindOnTheirTrack,
  newestKnownVersionOnTrack,
} from "../../remoteTargets/remoteMachineModel";
import { Banner } from "../../ui/notice";
import { useMachineFacts, type MachineFacts } from "../machines/machineFacts";
import { useSettingsMachines } from "../machines/settingsMachinesContext";

/**
 * Every machine's ADE, one row each: its tile, name and track, the version it
 * runs and the newest one on ITS track, and the one button that moves it
 * there. This computer's row restarts into a downloaded build; another
 * machine's row sends it an update (each on its own track, never the other).
 * Replaces the separate "Update other machines" list on this page.
 */
export function MachineUpdateRows() {
  const { machines, thisMachineName, openMachine } = useSettingsMachines();
  const snapshot = useAutoUpdateSnapshot();
  const facts = useMachineFacts(machines, snapshot.currentVersion || null);
  const updates = useMachineUpdates();
  const { currentVersion, version: downloaded, latestKnownVersion } = snapshot;
  const latestStable = snapshot.latestByTrack?.stable ?? null;
  const latestBeta = snapshot.latestByTrack?.beta ?? null;
  const known = useMemo(
    () => knownAdeVersions({
      currentVersion,
      version: downloaded,
      latestKnownVersion,
      latestByTrack: { stable: latestStable, beta: latestBeta },
    }),
    [currentVersion, downloaded, latestKnownVersion, latestStable, latestBeta],
  );
  const remoteUpdates = canUpdateOtherMachines();
  const connectedBehind = machinesBehindOnTheirTrack(
    machines.flatMap((machine) => {
      const connected = facts.get(machine.machineId)?.connected;
      return connected && machine.online ? [connected] : [];
    }),
    known,
  );
  const anyBusy = connectedBehind.some((machine) => isMachineUpdateBusy(updates, machine, updates.nowMs));

  if (machines.length === 0) return null;

  return (
    <div className="ade-gen-mup" id="update-other-machines" data-settings-anchor="update-other-machines">
      <div className="ade-gen-mup-head">
        <span className="kit-eyebrow">Every machine</span>
        {remoteUpdates && connectedBehind.length > 1 ? (
          <button
            type="button"
            className="ade-modern-btn"
            data-size="sm"
            disabled={anyBusy}
            onClick={() => void requestMachineUpdates(connectedBehind)}
          >
            <ArrowClockwise size={12} weight="bold" />
            {`Update all ${connectedBehind.length}`}
          </button>
        ) : null}
      </div>
      <div className="ade-gen-mup-list">
        {machines.map((machine) => (
          <MachineUpdateRow
            key={machine.machineId}
            machine={machine}
            name={machine.isThisMachine ? (thisMachineName ?? machine.machineName) : machine.machineName}
            fact={facts.get(machine.machineId)}
            known={known}
            remoteUpdates={remoteUpdates}
            onOpen={() => openMachine(machine.machineId)}
          />
        ))}
      </div>
    </div>
  );
}

/** One machine's update row, alone: on that machine's page under Machines. */
export function SingleMachineUpdateRow({ machine, name }: { machine: ProjectMachine; name: string }) {
  const snapshot = useAutoUpdateSnapshot();
  const facts = useMachineFacts([machine], snapshot.currentVersion || null);
  const { currentVersion, version: downloaded, latestKnownVersion } = snapshot;
  const latestStable = snapshot.latestByTrack?.stable ?? null;
  const latestBeta = snapshot.latestByTrack?.beta ?? null;
  const known = useMemo(
    () => knownAdeVersions({
      currentVersion,
      version: downloaded,
      latestKnownVersion,
      latestByTrack: { stable: latestStable, beta: latestBeta },
    }),
    [currentVersion, downloaded, latestKnownVersion, latestStable, latestBeta],
  );
  return (
    <MachineUpdateRow
      machine={machine}
      name={name}
      fact={facts.get(machine.machineId)}
      known={known}
      remoteUpdates={canUpdateOtherMachines()}
      bare
    />
  );
}

function MachineUpdateRow({
  machine,
  name,
  fact,
  known,
  remoteUpdates,
  onOpen,
  bare = false,
}: {
  machine: ProjectMachine;
  name: string;
  fact: MachineFacts | undefined;
  known: readonly string[];
  remoteUpdates: boolean;
  /** Absent on the machine's own page, where the row is not a link. */
  onOpen?: () => void;
  /** Version and action only, for a row on the machine's own page. */
  bare?: boolean;
}) {
  const snapshot = useAutoUpdateSnapshot();
  const updates = useMachineUpdates();
  const [restarting, setRestarting] = useState(false);
  const track = fact?.track ?? "stable";
  const version = fact?.versionLabel ?? fact?.version ?? null;
  const knowsTrack = newestKnownVersionOnTrack(known, track) != null;

  // What this row says beside the version, and its one action.
  let target: string | null = null;
  let action: ReactNode = null;
  let status: { ok: boolean; message: string } | null = null;
  if (machine.isThisMachine) {
    const restartAction = updateRestartAction(snapshot);
    const ready = snapshot.status === "ready" && Boolean(snapshot.version) && snapshot.version !== snapshot.currentVersion;
    if (ready && !bare) {
      // The ADE card's head carries this computer's restart; the list says
      // where it stands rather than offering the same button twice.
      target = snapshot.version;
      action = <span className="kit-tag" data-tone="ok">Downloaded</span>;
    } else if (ready) {
      target = snapshot.version;
      action = (
        <button
          type="button"
          className="ade-modern-btn"
          data-size="sm"
          data-tone="primary"
          disabled={restarting}
          onClick={() => {
            void requestDownloadedUpdateInstall(snapshot, () => setRestarting(true)).then((started) => {
              if (!started) setRestarting(false);
            });
          }}
        >
          {restarting ? <CircleNotch size={12} className="animate-spin" /> : <ArrowClockwise size={12} weight="bold" />}
          {restarting ? "Restarting…" : restartAction.label}
        </button>
      );
    } else if (snapshot.status === "downloading") {
      target = snapshot.version;
      action = <span className="kit-tag">Downloading</span>;
    }
  } else if (machine.online && fact?.connected) {
    const connected = fact.connected;
    const attempt = updates.attempts[machine.machineId] ?? null;
    const described = attempt
      ? describeMachineUpdateAttempt(attempt, { connected: true, version: connected.version }, updates.nowMs)
      : null;
    status = described ? { ok: described.ok, message: described.message } : null;
    const updating = updates.updatingIds.has(machine.machineId) || described?.inFlight === true;
    const checking = updates.checkingIds.has(machine.machineId);
    target = updating && attempt?.pendingVersion ? attempt.pendingVersion : machineUpdateTargetVersion(connected, known);
    if (target && remoteUpdates) {
      action = (
        <button
          type="button"
          className="ade-modern-btn"
          data-size="sm"
          disabled={updating || checking}
          onClick={() => void requestMachineUpdates([{ ...connected, targetVersion: target }])}
        >
          <ArrowClockwise size={12} weight="bold" className={updating ? "animate-spin" : undefined} />
          {updating ? "Updating…" : checking ? "Checking…" : "Update"}
        </button>
      );
    }
  }
  if (!action) {
    action = !machine.online && !machine.isThisMachine
      ? <span className="kit-tag">Offline</span>
      : version && knowsTrack && !target
        ? <span className="kit-tag" data-tone="ok">Up to date</span>
        : null;
  }

  const versionLine = (
    <span className="ade-gen-mup-version">
      {version ? <span className="kit-num">{version}</span> : <span>—</span>}
      {target && target !== version ? (
        <>
          <ArrowRight size={10} weight="bold" aria-hidden />
          <span className="kit-num ade-gen-mup-target">{target}</span>
        </>
      ) : null}
    </span>
  );
  if (bare) {
    return (
      <div className="ade-gen-mup-bare">
        <span className="ade-gen-mup-bare-row">
          {versionLine}
          {action}
        </span>
        {status ? <span className="ade-gen-mup-bare-status" role="status">{status.message}</span> : null}
      </div>
    );
  }
  return (
    <div className="ade-gen-mup-row" data-offline={!machine.online && !machine.isThisMachine ? "true" : undefined}>
      <button type="button" className="ade-gen-mup-who" onClick={onOpen} disabled={!onOpen} title={onOpen ? `Open ${name}` : undefined}>
        <MachineAvatar
          colorKey={fact?.colorKey ?? machine.machineId}
          name={name}
          platform={fact?.platform ?? "unknown"}
          formFactor={machineFormFactor({ name })}
          size={28}
          dimmed={!machine.online && !machine.isThisMachine}
        />
        <span className="ade-gen-mup-name">{name}</span>
        <UpdateTrackChip track={track} />
      </button>
      {versionLine}
      <span className="ade-gen-mup-action">{action}</span>
      {status ? (
        <div className="ade-gen-mup-status">
          {status.ok ? (
            <span role="status">{status.message}</span>
          ) : (
            <Banner
              layout="inline"
              model={{ id: `machine-update-error-${machine.machineId}`, tone: "error", title: status.message, report: { surface: "machine_update" } }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
