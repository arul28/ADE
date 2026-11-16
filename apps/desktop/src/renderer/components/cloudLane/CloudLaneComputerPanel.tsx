import { useState, type ReactNode } from "react";
import { ArrowSquareOut, Clock, Cpu, Moon, Package, Trash } from "@phosphor-icons/react";
import { idleCleanupWhen, type CloudMachineState } from "../../../shared/adeCloud";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { navigateToAppTarget } from "../../lib/openExternal";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { showToast } from "../app/toast/toastStore";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { refreshCloudMachines } from "../remoteTargets/useCloudMachines";
import { CloudTierChangeDialog } from "./CloudTierChangeDialog";
import { sleepLaneComputer } from "./CloudLaneHeaderButton";
import { cloudLaneLifeAvailable } from "./cloudLaneActions";
import { freeCloudLaneWithConfirm, useCloudLaneDelete } from "./deleteCloudLane";
import "./cloudLane.css";

/**
 * Manage lane's Computer tab for an ADE Cloud lane: what a person can do with
 * the lane's computer, one row each (size, sleep, keep the lane and free the
 * computer, the ADE Cloud page). The Delete tab deletes the lane and its
 * computer together. Account level, by the computer's ADE Cloud id: it works
 * for a lane on any machine. Nothing when the lane has no computer.
 */
export function CloudLaneComputerPanel({
  pin,
  laneId,
  laneName,
  onClose,
  onDelete,
}: {
  pin: OpenProjectBinding | null | undefined;
  laneId: string;
  laneName: string;
  /** Closes Manage lane: after a step that ends the computer, or opens another page. */
  onClose: () => void;
  /** Opens Manage lane's Delete tab, where the lane, its computer and its chats go together. */
  onDelete: () => void;
}) {
  const cloud = useCloudLaneDelete();
  const { computers } = useAdeCloudLaneComputers();
  const owned = cloud.computerOf(pin, laneId);
  const computer = owned ? computers.find((entry) => entry.instanceId === owned.instanceId) ?? null : null;
  const account = useCloudAccount();
  const [sizing, setSizing] = useState(false);
  const [freeing, setFreeing] = useState(false);
  if (!computer) {
    return <p className="adecl-muted">ADE can&apos;t find this lane&apos;s computer right now. Open the ADE Cloud page to see it.</p>;
  }
  const life = cloudLaneLifeAvailable();
  const awake = computer.state === "running";
  const idle = account?.dueForDeletion?.find((entry) => entry.instanceId === computer.instanceId) ?? null;

  const keep = async () => {
    const result = await window.ade.cloud?.keepIdleComputer?.(computer.instanceId).catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : undefined }));
    if (result?.ok) showToast({ tone: "success", title: `Kept ${laneName}'s computer`, message: "ADE Cloud won't delete it. Its unused days count again from now." });
    else showToast({ tone: "warning", title: `Couldn't keep ${laneName}'s computer`, message: result?.message || "Send a message in the lane to keep it." });
    refreshCloudMachines();
  };

  const free = async () => {
    setFreeing(true);
    try {
      if (await freeCloudLaneWithConfirm({ instanceId: computer.instanceId, laneName, onDone: refreshCloudMachines })) onClose();
    } finally {
      setFreeing(false);
    }
  };

  return (
    <div className="adecl-manage">
      <div className="adecl-manage-head">
        <CloudMark size={16} brand />
        <span>ADE Cloud computer</span>
        <span className="adecl-cx-state" data-awake={awake ? "true" : undefined}>
          <i aria-hidden />
          {COMPUTER_STATE_LABEL[computer.state]}
        </span>
      </div>
      <ul className="adecl-manage-rows">
        {idle && window.ade.cloud?.keepIdleComputer ? (
          <ManageRow
            icon={<Clock size={14} />}
            title="Keep this computer"
            hint={idle.held ? "ADE couldn't save its work, so it wasn't deleted." : `It isn't used, so it is ${idleCleanupWhen(idle.deletesAt, Date.now())}.`}
            tone="warn"
          >
            <button type="button" className="kit-btn" data-size="sm" onClick={() => void keep()}>Keep it</button>
          </ManageRow>
        ) : null}
        {life ? (
          <ManageRow icon={<Cpu size={14} />} title="Size" hint="More CPU and memory use hours faster.">
            <button type="button" className="kit-btn" data-size="sm" onClick={() => setSizing(true)}>Change size</button>
          </ManageRow>
        ) : null}
        {awake ? (
          <ManageRow icon={<Moon size={14} />} title="Sleep" hint="A sleeping computer uses no hours. A message wakes it.">
            <button type="button" className="kit-btn" data-size="sm" onClick={() => void sleepLaneComputer(computer.instanceId, laneName, false)}>Put to sleep</button>
          </ManageRow>
        ) : null}
        {life ? (
          <ManageRow
            icon={<Package size={14} />}
            title="Keep the lane, free its computer"
            hint="ADE pushes its work, then removes the computer. Your next message makes a new one."
          >
            <button type="button" className="kit-btn" data-size="sm" disabled={freeing} onClick={() => void free()}>
              {freeing ? "Freeing…" : "Free computer"}
            </button>
          </ManageRow>
        ) : null}
        <ManageRow icon={<ArrowSquareOut size={14} />} title="Disk and hours" hint="What uses its disk, and the account's hours.">
          <button
            type="button"
            className="kit-btn kit-btn-ghost"
            data-size="sm"
            onClick={() => {
              onClose();
              navigateToAppTarget({ kind: "settings", tab: "ade-cloud", anchor: "cloud-lanes" });
            }}
          >
            Open ADE Cloud
          </button>
        </ManageRow>
        {life ? (
          <ManageRow icon={<Trash size={14} />} title="Delete lane and computer" hint="Its chats go too, unless you keep them." tone="crit">
            <button type="button" className="kit-btn" data-size="sm" data-tone="crit" onClick={onDelete}>Delete…</button>
          </ManageRow>
        ) : null}
      </ul>
      {sizing ? <CloudTierChangeDialog instanceId={computer.instanceId} laneName={laneName} onClose={() => setSizing(false)} /> : null}
    </div>
  );
}

const COMPUTER_STATE_LABEL: Record<CloudMachineState, string> = {
  running: "Awake",
  asleep: "Asleep",
  stopped: "Asleep",
  starting: "Waking",
  stopping: "Going to sleep",
  deleting: "Deleting",
  error: "Not answering",
};

function ManageRow({ icon, title, hint, tone, children }: { icon: ReactNode; title: string; hint: string; tone?: "warn" | "crit"; children: ReactNode }) {
  return (
    <li className="adecl-manage-row" data-tone={tone}>
      <span className="adecl-manage-ic" aria-hidden>{icon}</span>
      <span className="adecl-manage-text">
        <b>{title}</b>
        <span>{hint}</span>
      </span>
      {children}
    </li>
  );
}
