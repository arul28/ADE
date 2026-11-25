import { useMemo, useState } from "react";
import { ArrowCircleUp, Desktop, Recycle, Trash } from "@phosphor-icons/react";
import {
  CLOUD_PLAN_LABELS,
  cloudCatalogOf,
  cloudComputerLimitDetailOf,
  cloudComputerLimitTitle,
  cloudComputerLimitUpgradeLabel,
  cloudSmallUsesHours,
  formatCloudHours,
  type CloudAccountState,
  type CloudComputerLimitDetail,
  type CloudComputerLimitLane,
  type CloudNextPlan,
} from "../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { formatAgo, ipcErrorMessage } from "../../lib/format";
import { showToast } from "../app/toast/toastStore";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { refreshCloudMachines, useCloudMachines } from "../remoteTargets/useCloudMachines";
import { Dialog, openDialog, type DialogAction } from "../ui/dialog";
import { checkoutCloudPlanUp } from "../settings/cloudDashboard/cloudPlanMoveUp";
import { KeepChatsCheckbox, deleteCloudLaneWithCheck, freeCloudLaneWithConfirm } from "./deleteCloudLane";
import { cloudLaneChangesAvailable } from "./cloudLaneActions";
import "./cloudLane.css";

/**
 * The computer limit card (Pricing v2): a new cloud lane needs a computer and
 * the account uses all its plan's. Three ways out, side by side, each with one
 * line under it; picking one opens its step below, which says exactly what
 * will happen, and the confirm button names the action:
 *
 * 1. Free up a computer (the server's "free the computer, keep the lane" job,
 *    `POST /cloud/instances/:id/free`). The lane and its chats stay; it gets a
 *    new computer the next time a message is sent there. A computer with no
 *    lane can only be deleted.
 * 2. Delete lane and computer (the ordinary cloud lane delete, which checks its work first).
 * 3. Move to the next plan (the ordinary checkout). On a paid plan the move
 *    charges the difference now: the step says so, and its button is the one ask.
 *
 * It opens from a refusal (`computer_limit`, whose `CloudComputerLimitDetail`
 * names the computers) or before a new lane, from the account read. Account
 * level: every call here goes to ADE Cloud by the computer's id, no pin. Each
 * way out closes the card first and reports with a toast. The iPhone's
 * `CloudComputerLimitSheet` has the same shape.
 */

type Way = "free" | "delete" | "move";

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

/** "Awake · in use now", "Asleep 3 days", "Asleep · no lane". */
function laneStateLine(lane: CloudComputerLimitLane, now: number): string {
  const when = lane.lastAwakeAt ? formatAgo(lane.lastAwakeAt, now).replace(/ ago$/, "") : null;
  const state = lane.awake ? "Awake · in use now" : when && when !== "just now" ? `Asleep ${when}` : "Asleep";
  return lane.hasLane === false ? `${state} · no lane` : state;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

async function moveUp(next: CloudNextPlan): Promise<void> {
  try {
    await checkoutCloudPlanUp(next);
  } catch (error) {
    showToast({ tone: "error", title: `Couldn't open ${CLOUD_PLAN_LABELS[next.planId]}`, message: ipcErrorMessage(error) || "Try again in a moment." });
  } finally {
    refreshCloudMachines();
  }
}

function WayButton({ way, picked, icon, title, line, onPick }: { way: Way; picked: Way | null; icon: React.ReactNode; title: string; line: string; onPick: (way: Way) => void }) {
  return (
    <button type="button" className="adecl-limit-way" aria-pressed={picked === way} data-way={way} onClick={() => onPick(way)}>
      <span className="adecl-limit-way-head">{icon}{title}</span>
      <span className="adecl-limit-way-line">{line}</span>
    </button>
  );
}

function LanePicker({ lanes, chosen, onChoose, freeOnly, now, label }: {
  lanes: CloudComputerLimitLane[];
  chosen: string | null;
  onChoose: (instanceId: string) => void;
  freeOnly: boolean;
  now: number;
  label: string;
}) {
  return (
    <div className="adecl-limit-pick" role="radiogroup" aria-label={label}>
      {lanes.map((lane) => {
        const disabled = freeOnly && lane.hasLane === false;
        return (
          <label key={lane.instanceId} className="adecl-limit-pick-row" data-disabled={disabled || undefined}>
            <input
              type="radio"
              name={`adecl-limit-${label}`}
              checked={chosen === lane.instanceId}
              disabled={disabled}
              onChange={() => onChoose(lane.instanceId)}
            />
            <Desktop size={13} aria-hidden />
            <span className="adecl-limit-pick-name" title={lane.laneName}>{lane.laneName}</span>
            <span className="adecl-limit-pick-state">{disabled ? "No lane · delete only" : laneStateLine(lane, now)}</span>
          </label>
        );
      })}
    </div>
  );
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
  const [now] = useState(() => Date.now());
  const [way, setWay] = useState<Way | null>(null);
  const [freeId, setFreeId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [keepChats, setKeepChats] = useState(false);
  const canChange = cloudLaneChangesAvailable();
  const onPaidPlan = (detail?.planId ?? "free") !== "free";
  const lanes = detail?.lanes ?? [];
  const withLane = lanes.filter((lane) => lane.hasLane !== false);
  const next = detail?.nextPlan ?? null;
  // The next plan's hours, when the catalog has them.
  const nextHours = next ? cloudCatalogOf(account).plans[next.planId]?.includedMilli ?? null : null;

  // The first computer each step offers: the one used least lately.
  const freeLane = lanes.find((lane) => lane.instanceId === (freeId ?? withLane[0]?.instanceId)) ?? null;
  const deleteLane = lanes.find((lane) => lane.instanceId === (deleteId ?? lanes[0]?.instanceId)) ?? null;

  const run = (work: () => Promise<unknown>) => {
    onClose();
    void work().finally(() => refreshCloudMachines());
  };

  const loading = !detail && machines.loading;
  const title = detail ? cloudComputerLimitTitle(detail) : "All your cloud computers are in use";

  let step: React.ReactNode = null;
  let confirm: DialogAction | null = null;
  if (way === "free") {
    step = withLane.length === 0 ? (
      <p className="adecl-limit-empty">None of your computers holds a lane to keep. Delete one instead.</p>
    ) : (
      <>
        <p className="adecl-limit-step-q">Which lane?</p>
        <LanePicker lanes={lanes} chosen={freeLane?.instanceId ?? null} onChoose={setFreeId} freeOnly now={now} label="Computer to free up" />
        {freeLane ? (
          <p className="adecl-limit-what">
            Its work is pushed to GitHub and the computer goes.{freeLane.awake ? " What runs on it now stops." : ""} Your next message there starts a new one.
          </p>
        ) : null}
      </>
    );
    if (freeLane && freeLane.hasLane !== false) {
      confirm = { label: `Free up ${freeLane.laneName}`, variant: "solid", disabled: !canChange, onClick: () => run(() => freeCloudLaneWithConfirm({ instanceId: freeLane.instanceId, laneName: freeLane.laneName, confirmed: true })) };
    }
  } else if (way === "delete") {
    step = (
      <>
        <p className="adecl-limit-step-q">Which lane?</p>
        <LanePicker lanes={lanes} chosen={deleteLane?.instanceId ?? null} onChoose={setDeleteId} freeOnly={false} now={now} label="Lane to delete" />
        {deleteLane ? (
          <>
            <p className="adecl-limit-what">
              {deleteLane.hasLane === false
                ? "This computer has no lane, so only the computer goes."
                : keepChats
                  ? "The lane and its computer are deleted; its chats stay in Work. ADE asks first if any work isn't on GitHub."
                  : "The lane, its computer and its chats are deleted. ADE asks first if any work isn't on GitHub."}
            </p>
            {deleteLane.hasLane !== false ? <KeepChatsCheckbox checked={keepChats} onChange={setKeepChats} /> : null}
          </>
        ) : null}
      </>
    );
    if (deleteLane) {
      confirm = {
        label: deleteLane.hasLane === false ? "Delete this computer" : "Delete lane and computer",
        variant: "solid",
        disabled: !canChange,
        onClick: () => run(() => deleteCloudLaneWithCheck({ instanceId: deleteLane.instanceId, laneName: deleteLane.laneName, askFirst: false, keepChats })),
      };
    }
  } else if (way === "move" && next) {
    const label = CLOUD_PLAN_LABELS[next.planId];
    step = (
      <>
        <p className="adecl-limit-step-q">{label} · ${next.priceUsd} a month</p>
        <ul className="adecl-limit-facts">
          <li>{plural(next.computerLimit, "cloud computer")}{detail ? `, ${next.computerLimit - detail.limit} more than now` : ""}</li>
          {nextHours != null ? <li>{formatCloudHours(nextHours)} credits a month</li> : null}
          {/* A paid plan's Small never uses credits; a Free account's may now (sponsored cards off). */}
          <li>{account && cloudSmallUsesHours(cloudCatalogOf(account)) ? "Unlimited Small computers" : "Small computers stay unlimited"}</li>
        </ul>
        <p className="adecl-limit-what">
          <b>What happens:</b>{" "}
          {onPaidPlan
            ? `your plan changes to ${label} now, and you pay the difference for the rest of this month. Credits you used stay used.`
            : `ADE opens the checkout. Once it's paid you can have ${plural(next.computerLimit, "cloud computer")}, and your new lane can start.`}
        </p>
      </>
    );
    confirm = { label: onPaidPlan ? `Move to ${label} now` : `Continue to checkout · $${next.priceUsd} a month`, variant: "solid", onClick: () => { onClose(); void moveUp(next); } };
  }

  return (
    <Dialog
      open
      size="lg"
      tone="warning"
      icon={<CloudMark size={16} brand />}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={title}
      description="Each cloud lane runs on its own computer. Make room for your new lane."
      actions={[...(confirm ? [{ ...confirm, autoFocus: true }] : []), { label: "Not now", variant: "secondary", onClick: onClose }]}
      footerStart={!canChange && way !== "move" && way ? <span className="adecl-limit-empty">Free up or delete lanes from the ADE desktop app.</span> : undefined}
    >
      {loading ? (
        <p className="adecl-limit-empty">Reading your computers…</p>
      ) : (
        <>
          <div className="adecl-limit-ways" data-count={next ? 3 : 2}>
            <WayButton way="free" picked={way} onPick={setWay} icon={<Recycle size={14} />} title="Free up a computer" line="The lane and its chats stay" />
            <WayButton way="delete" picked={way} onPick={setWay} icon={<Trash size={14} />} title="Delete lane and computer" line="Its chats go too, unless you keep them" />
            {next ? (
              <WayButton
                way="move"
                picked={way}
                onPick={setWay}
                icon={<ArrowCircleUp size={14} />}
                title={cloudComputerLimitUpgradeLabel(next)}
                line={`${plural(next.computerLimit, "computer")}${detail && next.computerLimit > detail.limit ? `, ${next.computerLimit - detail.limit} more` : ""} · $${next.priceUsd} a month`}
              />
            ) : null}
          </div>
          {lanes.length === 0 && way && way !== "move" ? (
            <p className="adecl-limit-empty">ADE couldn't list your computers here. Open Settings › ADE Cloud to see every lane.</p>
          ) : step ? (
            <div className="adecl-limit-step">{step}</div>
          ) : null}
        </>
      )}
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
