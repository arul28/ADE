import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleNotch, HardDrives, Plus, Sun } from "@phosphor-icons/react";
import {
  describeAgent37MachineSize,
  formatAgent37Usd,
  type Agent37CreateMachineResult,
  type Agent37Machine,
  type Agent37Status,
} from "../../../shared/agent37";
import { accountMachineDisplayName } from "../../../shared/accountDirectory";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { RemoteRuntimeTarget } from "../../../shared/types";
import { useActivityStore } from "../../state/activityStore";
import { fetchAccountMachines } from "../../lib/account";
import { showToast } from "../app/toast/toastStore";
import { Banner } from "../ui/notice";
import { IntegrationCard } from "./integrations/IntegrationChrome";
import { AGENT37_NAME } from "../remoteTargets/agent37Brand";
import {
  AGENT37_STATE_LABELS,
  agent37BoxWork,
  agent37StateTone,
  describeAgent37Rate,
  matchAgent37Boxes,
} from "../remoteTargets/agent37MachineModel";
import { MachineActionsMenu } from "../remoteTargets/MachineActionsMenu";
import { NewAgent37MachineDialog } from "../remoteTargets/NewAgent37MachineDialog";
import { agent37PendingLabel, useAgent37BoxActions, type Agent37BoxContext } from "../remoteTargets/useAgent37BoxActions";
import type { Agent37MachinesState } from "../remoteTargets/useAgent37Machines";
import "../remoteTargets/connections.css";

/**
 * Settings › Integrations › Agent 37 › Machines: every machine in the Agent 37
 * workspace with what it costs now and spent this month, its lanes and chats,
 * and the same actions and confirmations as Your computers. Account-level (the
 * key is the account's), so every call goes out with no pin.
 */
export function Agent37MachinesCard({ status, machines }: { status: Agent37Status | null; machines: Agent37MachinesState }) {
  const [accountMachines, setAccountMachines] = useState<AdeAccountMachine[]>([]);
  const [targets, setTargets] = useState<RemoteRuntimeTarget[]>([]);
  const [creating, setCreating] = useState(false);

  const loadAccount = useCallback((force: boolean) => {
    void fetchAccountMachines({ force }).then((result) => {
      if (result.state === "ok") setAccountMachines(result.machines);
    }, () => undefined);
    void window.ade.remoteRuntime?.listTargets?.().then(setTargets, () => undefined);
  }, []);
  useEffect(() => { loadAccount(false); }, [loadAccount]);

  const forgetTarget = useCallback(async (targetId: string) => {
    await window.ade.remoteRuntime.removeTarget(targetId);
    setTargets((current) => current.filter((entry) => entry.id !== targetId));
  }, []);
  const actions = useAgent37BoxActions({
    refresh: machines.refresh,
    onAccountChanged: () => loadAccount(true),
    forgetTarget,
    tier: machines.result?.tier ?? null,
  });

  const activityItemsById = useActivityStore((state) => state.itemsById);
  const activityItems = useMemo(() => Object.values(activityItemsById), [activityItemsById]);
  const boxes = useMemo(() => (machines.result?.state === "ok" ? machines.result.machines : []), [machines.result]);
  const byMachineKey = useMemo(() => matchAgent37Boxes(boxes, accountMachines), [boxes, accountMachines]);
  const month = machines.result?.state === "ok" ? machines.result.month ?? null : null;

  const contextFor = (box: Agent37Machine): Agent37BoxContext => {
    let accountMachine: AdeAccountMachine | null = null;
    for (const [machineKey, matched] of byMachineKey) {
      if (matched.instanceId === box.instanceId) {
        accountMachine = accountMachines.find((entry) => entry.machineKey === machineKey) ?? null;
        break;
      }
    }
    const target = accountMachine
      ? targets.find((entry) => entry.pairedMachine?.machineKey === accountMachine!.machineKey) ?? null
      : null;
    return {
      box,
      name: (accountMachine ? accountMachineDisplayName(accountMachine) : null) ?? (box.name?.trim() || box.instanceId),
      accountMachine,
      targetId: target?.id ?? null,
      work: agent37BoxWork(accountMachine, activityItems),
    };
  };

  const onCreated = useCallback((result: Agent37CreateMachineResult) => {
    setCreating(false);
    machines.refresh();
    loadAccount(true);
    showToast({
      tone: "success",
      title: `Made ${result.name}`,
      message: result.joined ? "It's in Your computers. Connect it there, or pick it when you start a chat." : "It's still starting. It shows in Your computers once it's ready.",
      replayMask: { title: true },
    });
  }, [loadAccount, machines]);

  const savedUsd = month ? Object.values(month.byInstance).reduce((sum, entry) => sum + (entry.savedUsd ?? 0), 0) : null;
  const newButton = (
    <button type="button" className="ade-modern-btn" data-size="sm" disabled={!status?.connected} onClick={() => setCreating(true)}>
      <Plus size={12} /> New machine
    </button>
  );

  return (
    <IntegrationCard
      anchor="agent37-machines"
      span="full"
      icon={<HardDrives size={15} weight="fill" />}
      title="Machines"
      badge={machines.loading && !machines.result ? <CircleNotch size={12} className="animate-spin" /> : null}
      actions={boxes.length ? newButton : null}
    >
      {machines.loadError && !machines.result ? (
        <Banner layout="inline" model={{ id: "agent37-machines-load", tone: "warning", title: `ADE couldn't read your ${AGENT37_NAME} machines`, detail: machines.loadError, actions: [{ label: "Retry", onClick: machines.refresh }] }} />
      ) : null}
      {machines.result && machines.result.state !== "ok" && machines.result.message ? (
        <Banner layout="inline" model={{ id: "agent37-machines-state", tone: "warning", title: `ADE couldn't read your ${AGENT37_NAME} machines`, detail: machines.result.message, actions: [{ label: "Retry", onClick: machines.refresh }] }} />
      ) : null}

      {machines.result?.state === "ok" && boxes.length === 0 ? (
        <div className="ade-ig-card-foot">
          <span className="ade-ig-note">No machines yet. A new one signs in to your ADE account on its own.</span>
          {newButton}
        </div>
      ) : null}

      {boxes.length ? (
        <div className="ade-ig-mini-rows" aria-label={`${AGENT37_NAME} machines`}>
          {boxes.map((box) => {
            const ctx = contextFor(box);
            const tone = agent37StateTone(box);
            const pending = actions.pendingById[box.instanceId] ?? null;
            const error = actions.errorById[box.instanceId] ?? null;
            const rate = describeAgent37Rate(box);
            const spent = month?.byInstance[box.instanceId]?.spentUsd ?? null;
            const lanes = ctx.work.lanes.map((lane) => lane.name);
            const canWake = (box.state === "asleep" || box.state === "stopped") && !box.pastDue;
            return (
              <div key={box.instanceId} style={{ display: "grid", gap: 6 }}>
                <div className="ade-ig-mini-row" data-agent37-instance={box.instanceId}>
                  <span className="ade-ig-mini-title">{ctx.name}</span>
                  <span className="kit-tag" data-tone={tone ?? undefined} title={`${AGENT37_NAME} status: ${box.status}`}>
                    {box.pastDue ? "Suspended" : AGENT37_STATE_LABELS[box.state]}
                  </span>
                  <span className="ade-ig-mini-detail">
                    {[
                      describeAgent37MachineSize(box),
                      rate ? `${rate} now` : null,
                      spent != null ? `${formatAgent37Usd(spent)} this month` : null,
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
                  <div role="status" className="ade-ig-note"><CircleNotch size={12} className="animate-spin" /> {agent37PendingLabel(pending)}</div>
                ) : null}
                {error ? (
                  <Banner
                    layout="inline"
                    model={{ id: `agent37-settings-action-${box.instanceId}`, tone: error.blocker ? "warning" : "error", title: error.message, dismiss: { onDismiss: () => actions.dismissError(box.instanceId) }, report: false }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {month && (savedUsd != null && savedUsd >= 0.01 || month.deletedSpentUsd >= 0.01) ? (
        <p className="ade-ig-note" title={`${AGENT37_NAME} settles spend once an hour, so the newest hour shows later.`}>
          {[
            savedUsd != null && savedUsd >= 0.01 ? `Sleeping saved ${formatAgent37Usd(savedUsd)} this month.` : null,
            month.deletedSpentUsd >= 0.01
              ? `Deleted machines spent ${formatAgent37Usd(month.deletedSpentUsd)} this month.`
              : null,
          ].filter(Boolean).join(" ")}
        </p>
      ) : null}
      {/* Room for the stale-rows cleanup line (backend to come). */}
      {actions.dialog}
      {creating && status ? (
        <NewAgent37MachineDialog status={status} onCreated={onCreated} onClose={() => setCreating(false)} />
      ) : null}
    </IntegrationCard>
  );
}
