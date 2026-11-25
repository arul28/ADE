import { useState, type ReactNode } from "react";
import { ArrowSquareOut, Clock, Cpu, Moon, Package, Trash } from "@phosphor-icons/react";
import { idleCleanupWhen } from "../../../shared/adeCloud";
import type { TerminalSessionSummary } from "../../../shared/types";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { navigateToAppTarget } from "../../lib/openExternal";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { useRootAppStore } from "../../state/appStore";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { refreshCloudMachines } from "../remoteTargets/useCloudMachines";
import { CloudTierChangeDialog } from "./CloudTierChangeDialog";
import { keepLaneComputer, sleepLaneComputer } from "./CloudLaneHeaderButton";
import { cloudLaneChangesAvailable, cloudLaneComputerOfLane, cloudLaneMovesAvailable } from "./cloudLaneActions";
import { CLOUD_MACHINE_STATE_TEXT } from "./CloudLaneConnectionRow";
import { cloudLanePowerOfState } from "./cloudLaneStatus";
import { freeCloudLaneWithConfirm } from "./deleteCloudLane";
import "./cloudLane.css";
import "./cloudLaneStatus.css";

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
  const { computers } = useAdeCloudLaneComputers();
  const owned = cloudLaneComputerOfLane(pin, laneId, computers);
  const computer = owned ? computers.find((entry) => entry.instanceId === owned.instanceId) ?? null : null;
  const account = useCloudAccount();
  // The lane's chats with a turn running, in a project's list or another machine's: Sleep asks first.
  const runningChats = useRootAppStore((state) => runningChatIds([
    ...Object.values(state.sessionsCacheByProject).flat(),
    ...Object.values(state.crossMachineLanesByMachineId).flatMap((entry) => entry.sessions),
  ], laneId)).split(" ").filter(Boolean).length;
  const [sizing, setSizing] = useState(false);
  const [freeing, setFreeing] = useState(false);
  if (!computer) {
    return <p className="adecl-muted">ADE can&apos;t find this lane&apos;s computer right now. Open the ADE Cloud page to see it.</p>;
  }
  const life = cloudLaneChangesAvailable();
  const awake = computer.state === "running";
  const idle = account?.dueForDeletion?.find((entry) => entry.instanceId === computer.instanceId) ?? null;

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
        {/* "Deleting" is on its way out, not in trouble: the going-to-sleep mark. */}
        <span className="adecl-status-state" data-power={computer.state === "deleting" ? "stopping" : cloudLanePowerOfState(computer.state)}>
          <i aria-hidden />
          {CLOUD_MACHINE_STATE_TEXT[computer.state]}
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
            <button type="button" className="kit-btn" data-size="sm" onClick={() => void keepLaneComputer(computer.instanceId, laneName)}>Keep it</button>
          </ManageRow>
        ) : null}
        {life || cloudLaneMovesAvailable() ? (
          <ManageRow icon={<Cpu size={14} />} title="Size" hint="More CPU and memory use credits faster.">
            <button type="button" className="kit-btn" data-size="sm" onClick={() => setSizing(true)}>Change size</button>
          </ManageRow>
        ) : null}
        {awake ? (
          <ManageRow icon={<Moon size={14} />} title="Sleep" hint="A sleeping computer uses no credits. A message wakes it.">
            <button type="button" className="kit-btn" data-size="sm" onClick={() => void sleepLaneComputer(computer.instanceId, laneName, runningChats)}>Put to sleep</button>
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
        <ManageRow icon={<ArrowSquareOut size={14} />} title="Disk and credits" hint="What uses its disk, and the account's credits.">
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

/** The ids of a lane's chats whose turn runs, once each, as one string: a store read that only changes when they do. */
function runningChatIds(sessions: readonly TerminalSessionSummary[], laneId: string): string {
  const ids = new Set(sessions.filter((session) => session.laneId === laneId && session.runtimeState === "running").map((session) => session.id));
  return [...ids].sort().join(" ");
}

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
