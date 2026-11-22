import { useMemo } from "react";
import { Desktop } from "@phosphor-icons/react";
import {
  CLOUD_PLAN_LABELS,
  cloudComputerLimitDetailOf,
  cloudComputerLimitTitle,
  cloudComputerLimitUpgradeLabel,
  type CloudAccountState,
  type CloudComputerLimitDetail,
  type CloudComputerLimitLane,
  type CloudNextPlan,
} from "../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { ipcErrorMessage } from "../../lib/format";
import { showToast } from "../app/toast/toastStore";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { refreshCloudMachines, useCloudMachines } from "../remoteTargets/useCloudMachines";
import { Dialog, openDialog } from "../ui/dialog";
import { checkoutCloudPlanUp, confirmCloudPlanMoveUp } from "../settings/cloudDashboard/cloudPlanMoveUp";
import { deleteCloudLaneWithCheck, freeCloudLaneWithConfirm } from "./deleteCloudLane";
import { cloudLaneChangesAvailable } from "./cloudLaneActions";
import "./cloudLane.css";

/**
 * The computer limit card (Pricing v2): a new cloud lane needs a computer and
 * the account uses all its plan's. One card, three ways out:
 *
 * 1. Free up a computer from another lane (the server's "free the computer,
 *    keep the lane" job, `POST /cloud/instances/:id/free`). The lane and its
 *    chats stay; it gets a new computer the next time a message is sent there.
 * 2. Delete a lane (the ordinary cloud lane delete, which checks its work first).
 * 3. Move to the next plan (the ordinary checkout).
 *
 * It opens from a refusal (`computer_limit`, whose `CloudComputerLimitDetail`
 * names the computers) or before a new lane, from the account read. Account
 * level: every call here goes to ADE Cloud by the computer's id, no pin. Each
 * way out closes the card first and reports with a toast.
 */

/** The account's computers, least recently used first, from the list read (when no refusal named them). */
function lanesOfMachines(machines: readonly CloudLaneMachine[]): CloudComputerLimitLane[] {
  return machines
    .filter((machine) => machine.state !== "deleting")
    .map((machine) => ({
      instanceId: machine.instanceId,
      laneName: machine.lane?.laneName ?? machine.name ?? machine.instanceId,
      awake: machine.state === "running" || machine.state === "starting",
      lastAwakeAt: machine.lastActiveAtMs ?? machine.awakeSinceMs ?? null,
      hasLane: Boolean(machine.lane),
    }))
    .sort((a, b) => (a.lastAwakeAt ?? 0) - (b.lastAwakeAt ?? 0));
}

async function moveUp(next: CloudNextPlan, onPaidPlan: boolean): Promise<void> {
  // A paid plan's move up charges the difference now: ask once, as the Plans card does.
  if (onPaidPlan && !(await confirmCloudPlanMoveUp(next))) return;
  try {
    await checkoutCloudPlanUp(next);
  } catch (error) {
    showToast({ tone: "error", title: `Couldn't open ${CLOUD_PLAN_LABELS[next.planId]}`, message: ipcErrorMessage(error) || "Try again in a moment." });
  } finally {
    refreshCloudMachines();
  }
}

function CloudComputerLimitCard({ given, onClose }: { given: CloudComputerLimitDetail | null; onClose: () => void }) {
  // The account's list: the computers to offer when no refusal named them, and the plan for the card's facts.
  const machines = useCloudMachines(true, { settle: false });
  const result = machines.result?.state === "ok" ? machines.result : null;
  const account: CloudAccountState | null = result?.account ?? null;
  const detail = useMemo<CloudComputerLimitDetail | null>(() => {
    if (given) return given.lanes.length || !result ? given : { ...given, lanes: lanesOfMachines(result.machines as CloudLaneMachine[]) };
    return account ? cloudComputerLimitDetailOf(account, lanesOfMachines((result?.machines ?? []) as CloudLaneMachine[])) : null;
  }, [account, given, result]);
  const canChange = cloudLaneChangesAvailable();
  const onPaidPlan = (detail?.planId ?? "free") !== "free";

  const run = (work: () => Promise<unknown>) => {
    onClose();
    void work().finally(() => refreshCloudMachines());
  };

  const title = detail ? cloudComputerLimitTitle(detail) : "You're using all your cloud computers.";
  const lanes = detail?.lanes ?? [];
  return (
    <Dialog
      open
      size="md"
      tone="warning"
      icon={<CloudMark size={16} brand />}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={title}
      description="A new cloud lane needs a computer of its own. Make room one of these ways."
      actions={detail?.nextPlan
        ? [
          { label: `${cloudComputerLimitUpgradeLabel(detail.nextPlan)}`, variant: "solid", autoFocus: true, onClick: () => { const next = detail.nextPlan!; onClose(); void moveUp(next, onPaidPlan); } },
          { label: "Not now", variant: "secondary", onClick: onClose },
        ]
        : [{ label: "Close", variant: "secondary", onClick: onClose }]}
    >
      <ol className="adecl-limit-ways">
        <li>
          <b>Free up a computer from another lane.</b>
          <span className="adecl-limit-why">The lane and its chats stay; it gets a new computer the next time you send a message there.</span>
          {!detail && machines.loading ? (
            <p className="adecl-limit-empty">Reading your computers…</p>
          ) : lanes.length === 0 ? (
            <p className="adecl-limit-empty">ADE couldn't list your computers here. Open Settings › ADE Cloud to see every lane.</p>
          ) : (
            <ul className="adecl-limit-lanes" aria-label="Your cloud computers">
              {lanes.map((lane) => (
                <li key={lane.instanceId} className="adecl-limit-lane">
                  <Desktop size={13} aria-hidden />
                  <span className="adecl-limit-lane-name" title={lane.laneName}>{lane.laneName}</span>
                  <span className="kit-tag" data-tone={lane.awake ? "accent" : undefined}>{lane.awake ? "Awake" : "Asleep"}</span>
                  <span className="adecl-limit-lane-actions">
                    {lane.hasLane !== false ? <button
                      type="button"
                      className="kit-btn"
                      data-size="sm"
                      disabled={!canChange}
                      title={lane.awake ? "Its work is pushed to GitHub first; what runs on it now stops." : "Its work is pushed to GitHub first."}
                      onClick={() => run(() => freeCloudLaneWithConfirm({ instanceId: lane.instanceId, laneName: lane.laneName }))}
                    >
                      Free up
                    </button> : null}
                    <button
                      type="button"
                      className="kit-btn kit-btn-ghost"
                      data-size="sm"
                      data-tone="crit"
                      disabled={!canChange}
                      onClick={() => run(() => deleteCloudLaneWithCheck({ instanceId: lane.instanceId, laneName: lane.laneName, askFirst: true }))}
                    >
                      Delete
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </li>
        <li>
          <b>Delete a lane.</b>
          <span className="adecl-limit-why">Its computer goes with it. ADE checks first that its work is on GitHub.</span>
        </li>
        {detail?.nextPlan ? (
          <li>
            <b>{cloudComputerLimitUpgradeLabel(detail.nextPlan)}.</b>
            <span className="adecl-limit-why">${detail.nextPlan.priceUsd} a month. Small computers stay unlimited on every plan.</span>
          </li>
        ) : null}
      </ol>
      {!canChange ? <p className="adecl-limit-empty">Free up or delete lanes from the ADE desktop app.</p> : null}
    </Dialog>
  );
}

/**
 * Opens the limit card on the dialog host. `detail`: the refusal's (it names
 * the computers); without it the card reads the account. One card at a time:
 * opening it again replaces the one up.
 */
export function openCloudComputerLimitCard(detail: CloudComputerLimitDetail | null = null): void {
  openDialog((close) => <CloudComputerLimitCard given={detail} onClose={close} />, { key: "cloud-computer-limit" });
}
