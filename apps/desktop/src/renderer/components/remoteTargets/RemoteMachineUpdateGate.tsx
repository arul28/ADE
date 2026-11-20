import { useMemo, type ReactNode } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { desktopUpdateRequirement, type DesktopUpdateRequirement } from "../../../shared/clientUpdateGate";
import { isWindowsSelfInstallBlocked } from "../../../shared/updateVersions";
import { useClientUpdateGate } from "../../state/clientUpdateGateStore";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { adeCloudInstanceIdForMachine, useAdeCloudLaneComputers, useMachineLabelForBinding } from "../../state/adeCloudLaneIndex";
import { Banner, type BannerModel } from "../ui/notice";
import type { NoticeAction } from "../ui/notice/NoticeParts";
import {
  canUpdateOtherMachines,
  isMachineUpdateBusy,
  machineUpdateIsManual,
  requestMachineUpdates,
  useMachineUpdates,
} from "./machineUpdates";
import { connectedMachinesFromSnapshot, type ConnectedMachine } from "./remoteMachineModel";
import { describeMachineUpdateAttempt } from "./machineUpdateStatus";
import { cloudBoxContext, useCloudBoxActions } from "./useCloudBoxActions";
import { useCloudMachines } from "./useCloudMachines";

type RequiredUpdate = Extract<DesktopUpdateRequirement, { required: true }>;

type RemoteMachineBlock = {
  machine: ConnectedMachine;
  /** The connection's host name: an ADE Cloud computer's is its id. */
  hostname: string | null;
  requirement: RequiredUpdate;
};

/**
 * Whether the machine a binding names runs a build below the owner's minimum,
 * judged here from its live connection's version (`desktopUpdateRequirement`).
 *
 * Only a machine connected right now counts: an offline or sleeping one (an
 * ADE Cloud computer at rest updates itself when it wakes) is never blocked.
 * Reads nothing while no minimum is set, which is most of the time.
 */
export function useRemoteMachineUpdateBlock(binding: OpenProjectBinding | null | undefined): RemoteMachineBlock | null {
  const targetId = binding?.kind === "remote" ? binding.targetId : null;
  const gate = useClientUpdateGate();
  const { snapshot } = useRemoteConnectionSnapshot(targetId != null && gate.minimum != null);
  return useMemo(() => {
    if (!targetId || !gate.minimum || !snapshot) return null;
    const connection = snapshot.connections.find((entry) => entry.target.id === targetId && entry.state === "connected");
    if (!connection) return null;
    const machine = connectedMachinesFromSnapshot({ ...snapshot, connections: [connection] })[0];
    if (!machine) return null;
    const requirement = desktopUpdateRequirement({ currentVersion: machine.version, minimum: gate.minimum, latest: gate.latest });
    return requirement.required ? { machine, hostname: connection.target.hostname ?? null, requirement } : null;
  }, [gate.latest, gate.minimum, snapshot, targetId]);
}

/**
 * A surface of another machine (its chat, terminal or lane): the surface
 * itself, or, while that machine runs a build below the minimum, a panel that
 * blocks it there and says how to update it. Other machines are unaffected.
 */
export function RemoteMachineUpdateGate({
  binding,
  children,
}: {
  /** The binding the surface runs on: its pin, or the tab's binding. */
  binding: OpenProjectBinding | null | undefined;
  children: ReactNode;
}) {
  const block = useRemoteMachineUpdateBlock(binding);
  if (!block) return <>{children}</>;
  return <RemoteMachineUpdatePanel binding={binding ?? null} block={block} />;
}

function RemoteMachineUpdatePanel({ binding, block }: { binding: OpenProjectBinding | null; block: RemoteMachineBlock }) {
  const label = useMachineLabelForBinding(binding)?.trim() || null;
  const index = useAdeCloudLaneComputers();
  const instanceId = adeCloudInstanceIdForMachine({ hostname: block.hostname, machineKey: block.machine.colorKey ?? null }, index);
  // A desktop goes by its own name (as in the update confirm); an ADE Cloud
  // computer by the account's name for it.
  const name = instanceId ? label ?? block.machine.name : block.machine.name.trim() || label || "That computer";
  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col items-center justify-center px-6"
      data-testid="remote-machine-update-gate"
    >
      <div style={{ width: "min(480px, 100%)" }}>
        {instanceId
          ? <CloudComputerUpdateBanner name={name} block={block} instanceId={instanceId} />
          : <DesktopUpdateBanner name={name} block={block} />}
      </div>
    </div>
  );
}

function bannerModel(name: string, block: RemoteMachineBlock, extra: Partial<BannerModel>): BannerModel {
  const { currentVersion, targetVersion } = block.requirement;
  return {
    id: `remote-machine-update:${block.machine.id}`,
    tone: "warning",
    icon: <ArrowsClockwise size={16} weight="bold" />,
    title: `${name} runs an old version of ADE (${currentVersion} → ${targetVersion})`,
    detail: "Update it to keep working on it. Its lanes, chats and work are saved.",
    report: false,
    ...extra,
  };
}

/** A paired desktop: the ordinary "Update & restart", with its impact confirmation. */
function DesktopUpdateBanner({ name, block }: { name: string; block: RemoteMachineBlock }) {
  const updates = useMachineUpdates();
  const { machine, requirement } = block;
  const attempt = updates.attempts[machine.id];
  const status = attempt ? describeMachineUpdateAttempt(attempt, { ...machine, connected: true }, updates.nowMs) : null;
  const busy = isMachineUpdateBusy(updates, machine, updates.nowMs);
  const manual = machineUpdateIsManual(machine, attempt);
  // A brain too old to take `machine.updateAndRestart`, a build whose app
  // cannot run its installer, or a client that cannot ask (no bridge).
  const askable = canUpdateOtherMachines()
    && machine.canUpdate !== false
    && !manual
    && !isWindowsSelfInstallBlocked(machine.version, machine.arch ?? null);
  const updateThere = `Open ADE on ${name} and update it there.`;
  const actions: NoticeAction[] = [];
  if (askable) {
    actions.push({
      label: `Update & restart ${name}`,
      variant: "solid",
      busy,
      onClick: () => void requestMachineUpdates([{ ...machine, targetVersion: requirement.targetVersion }]),
    });
  }
  if (manual && machine.downloadUrl) actions.push({ label: "Download the update", href: machine.downloadUrl, variant: "secondary" });
  const failed = Boolean(status && !status.ok && !status.inFlight);
  // Asking failed (an old brain may not know the call): the panel stays and
  // says where it can be updated.
  const note = !askable || failed ? updateThere : status?.message ?? null;
  return (
    <Banner
      layout="inline"
      model={bannerModel(name, block, {
        actions,
        busy,
        ...(note ? { extra: <span className="text-[11px]" style={{ opacity: 0.85 }}>{note}</span> } : {}),
        ...(failed && status ? { error: status.message } : {}),
      })}
    />
  );
}

const NO_ITEMS: never[] = [];
const keepSavedConnection = async () => undefined;

/** An ADE Cloud computer: "Update computer", through the account (no pin). */
function CloudComputerUpdateBanner({ name, block, instanceId }: { name: string; block: RemoteMachineBlock; instanceId: string }) {
  const cloud = useCloudMachines(true, { settle: false });
  const actions = useCloudBoxActions({ refresh: cloud.refresh, forgetTarget: keepSavedConnection });
  const box = cloud.result?.state === "ok" ? cloud.result.machines.find((entry) => entry.instanceId === instanceId) ?? null : null;
  const pending = actions.pendingById[instanceId] === "update";
  const error = actions.errorById[instanceId]?.message ?? null;
  // The account's list answered without this computer (or could not be
  // read): its own brain is asked instead, as for any other machine.
  if ((cloud.result || cloud.loadError) && !box) return <DesktopUpdateBanner name={name} block={block} />;
  return (
    <>
      <Banner
        layout="inline"
        model={bannerModel(name, block, {
          busy: pending,
          actions: [{
            label: "Update computer",
            variant: "solid",
            busy: pending,
            disabled: !box,
            title: box ? undefined : "Loading your ADE Cloud computers…",
            onClick: () => {
              if (!box) return;
              void actions.update(cloudBoxContext({ box, accountMachine: null, targetId: block.machine.id, activityItems: NO_ITEMS, accountKnown: false, name }));
            },
          }],
          ...(error ? { error } : {}),
        })}
      />
      {actions.dialog}
    </>
  );
}
