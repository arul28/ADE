import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleNotch, HardDrives, Plus, Sun } from "@phosphor-icons/react";
import {
  describeCloudMachineSize,
  type CloudMachine,
  type CloudStatus,
} from "../../../shared/adeCloud";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { RemoteRuntimeTarget } from "../../../shared/types";
import { useActivityStore } from "../../state/activityStore";
import { fetchAccountMachines } from "../../lib/account";
import { showToast } from "../app/toast/toastStore";
import { Banner } from "../ui/notice";
import { IntegrationCard } from "./integrations/IntegrationChrome";
import { ADE_CLOUD_NAME } from "../remoteTargets/cloudBrand";
import {
  CLOUD_STATE_LABELS,
  cloudStateTone,
  describeCloudRate,
  matchCloudBoxes,
} from "../remoteTargets/cloudMachineModel";
import { MachineActionsMenu } from "../remoteTargets/MachineActionsMenu";
import { cloudBoxContext, cloudPendingLabel, useCloudBoxActions, type CloudBoxContext } from "../remoteTargets/useCloudBoxActions";
import type { CloudMachinesState } from "../remoteTargets/useCloudMachines";
import "../remoteTargets/connections.css";

/**
 * Settings › Integrations › ADE Cloud › Machines: every computer on the
 * account with how fast it uses hours, its lanes and chats,
 * and the same actions and confirmations as Your computers. Account-level (cloud
 * access is the account's), so every call goes out with no pin.
 */
export function CloudMachinesCard({ status, machines, onNewMachine, accountChangedAt }: {
  status: CloudStatus | null;
  machines: CloudMachinesState;
  /** Opens the New machine dialog, which the page keeps (it must outlive this card). */
  onNewMachine: () => void;
  /** Bumped when a machine joined the account, so the account rows are read again. */
  accountChangedAt: number;
}) {
  const [accountMachines, setAccountMachines] = useState<AdeAccountMachine[]>([]);
  const [accountKnown, setAccountKnown] = useState(false);
  const [targets, setTargets] = useState<RemoteRuntimeTarget[]>([]);

  const loadAccount = useCallback((force: boolean) => {
    void fetchAccountMachines({ force }).then((result) => {
      if (result.state === "ok") {
        setAccountMachines(result.machines);
        setAccountKnown(true);
      }
    }, () => undefined);
    void window.ade.remoteRuntime?.listTargets?.().then(setTargets, () => undefined);
  }, []);
  useEffect(() => { loadAccount(false); }, [loadAccount]);
  useEffect(() => { if (accountChangedAt) loadAccount(true); }, [accountChangedAt, loadAccount]);

  const forgetTarget = useCallback(async (targetId: string) => {
    await window.ade.remoteRuntime.removeTarget(targetId);
    setTargets((current) => current.filter((entry) => entry.id !== targetId));
  }, []);
  const actions = useCloudBoxActions({
    refresh: machines.refresh,
    onAccountChanged: () => loadAccount(true),
    forgetTarget,
  });

  const activityItemsById = useActivityStore((state) => state.itemsById);
  const activityItems = useMemo(() => Object.values(activityItemsById), [activityItemsById]);
  const boxes = useMemo(() => (machines.result?.state === "ok" ? machines.result.machines : []), [machines.result]);
  const byMachineKey = useMemo(() => matchCloudBoxes(boxes, accountMachines), [boxes, accountMachines]);

  // Instance id → its account row, the reverse of the match above.
  const accountMachineByInstance = useMemo(() => {
    const byInstance = new Map<string, AdeAccountMachine>();
    for (const [machineKey, matched] of byMachineKey) {
      const accountMachine = accountMachines.find((entry) => entry.machineKey === machineKey);
      if (accountMachine) byInstance.set(matched.instanceId, accountMachine);
    }
    return byInstance;
  }, [accountMachines, byMachineKey]);

  const contextFor = (box: CloudMachine): CloudBoxContext => {
    const accountMachine = accountMachineByInstance.get(box.instanceId) ?? null;
    const machineKey = accountMachine?.machineKey ?? null;
    return cloudBoxContext({
      box,
      accountMachine,
      targetId: machineKey ? targets.find((entry) => entry.pairedMachine?.machineKey === machineKey)?.id ?? null : null,
      activityItems,
      accountKnown,
    });
  };

  const newButton = (
    <button type="button" className="ade-modern-btn" data-size="sm" disabled={!status?.connected} onClick={onNewMachine}>
      <Plus size={12} /> New computer
    </button>
  );

  return (
    <IntegrationCard
      anchor="cloud-machines"
      span="full"
      icon={<HardDrives size={15} weight="fill" />}
      title="Computers"
      badge={machines.loading && !machines.result ? <CircleNotch size={12} className="animate-spin" /> : null}
      actions={boxes.length ? newButton : null}
    >
      {machines.loadError && !machines.result ? (
        <Banner layout="inline" model={{ id: "cloud-machines-load", tone: "warning", title: `ADE couldn't read your ${ADE_CLOUD_NAME} machines`, detail: machines.loadError, actions: [{ label: "Retry", onClick: machines.refresh }] }} />
      ) : null}
      {machines.result && machines.result.state !== "ok" && machines.result.message ? (
        <Banner layout="inline" model={{ id: "cloud-machines-state", tone: "warning", title: `ADE couldn't read your ${ADE_CLOUD_NAME} machines`, detail: machines.result.message, actions: [{ label: "Retry", onClick: machines.refresh }] }} />
      ) : null}

      {machines.result?.state === "ok" && boxes.length === 0 ? (
        <div className="ade-ig-card-foot">
          <span className="ade-ig-note">No computers yet. A new one signs in to your ADE account on its own.</span>
          {newButton}
        </div>
      ) : null}

      {boxes.length ? (
        <div className="ade-ig-mini-rows" aria-label={`${ADE_CLOUD_NAME} machines`}>
          {boxes.map((box) => {
            const ctx = contextFor(box);
            const tone = cloudStateTone(box);
            const pending = actions.pendingById[box.instanceId] ?? null;
            const error = actions.errorById[box.instanceId] ?? null;
            const rate = describeCloudRate(box);
            const lanes = ctx.work.lanes.map((lane) => lane.name);
            const canWake = (box.state === "asleep" || box.state === "stopped") && !box.pastDue;
            return (
              <div key={box.instanceId} style={{ display: "grid", gap: 6 }}>
                <div className="ade-ig-mini-row" data-cloud-instance={box.instanceId}>
                  <span className="ade-ig-mini-title">{ctx.name}</span>
                  <span className="kit-tag" data-tone={tone ?? undefined} title={`${ADE_CLOUD_NAME} status: ${box.status}`}>
                    {box.pastDue ? "Suspended" : CLOUD_STATE_LABELS[box.state]}
                  </span>
                  <span className="ade-ig-mini-detail">
                    {[
                      describeCloudMachineSize(box),
                      rate,
                      lanes.length ? (lanes.length === 1 ? lanes[0] : `${lanes.length} lanes`) : null,
                      ctx.work.runningChats > 0 ? (ctx.work.runningChats === 1 ? "1 chat running" : `${ctx.work.runningChats} chats running`) : null,
                    ].filter(Boolean).join(" · ")}
                  </span>
                  {canWake && !pending ? (
                    <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" onClick={() => void actions.wake(ctx)}>
                      <Sun size={12} /> {box.state === "stopped" ? "Start" : "Wake"}
                    </button>
                  ) : null}
                  <MachineActionsMenu label={`Actions for ${ctx.name}`} actions={actions.actionsFor(ctx, (message) => showToast({ tone: "error", title: `Couldn't remove ${ctx.name} from ADE`, message }))} />
                </div>
                {pending ? (
                  <div role="status" className="ade-ig-note"><CircleNotch size={12} className="animate-spin" /> {cloudPendingLabel(pending)}</div>
                ) : null}
                {error ? (
                  <Banner
                    layout="inline"
                    model={{ id: `cloud-settings-action-${box.instanceId}`, tone: error.blocker ? "warning" : "error", title: error.message, dismiss: { onDismiss: () => actions.dismissError(box.instanceId) }, report: false }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Room for the stale-rows cleanup line (backend to come). */}
      {actions.dialog}
    </IntegrationCard>
  );
}
