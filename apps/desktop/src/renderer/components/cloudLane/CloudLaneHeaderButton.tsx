import { useState } from "react";
import { Cloud, Cpu, MagnifyingGlass, Moon, Trash } from "@phosphor-icons/react";
import { navigateToAppTarget } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { MachineActionsMenu, type MachineAction } from "../remoteTargets/MachineActionsMenu";
import { callCloudMachineAction, confirmCloudSleep } from "../remoteTargets/useCloudBoxActions";
import { refreshCloudMachines } from "../remoteTargets/useCloudMachines";
import { WORK_HEADER_ICON_BUTTON_CLASS } from "../work/WorkHeaderPaneToggles";
import { CloudTierChangeDialog } from "./CloudTierChangeDialog";
import { cloudLaneLifeAvailable } from "./cloudLaneActions";
import { deleteCloudLaneWithCheck } from "./deleteCloudLane";

/**
 * A cloud lane's chat header: one cloud button to manage the lane's computer
 * right there (B14-21): change its size, see what uses its disk, put it to
 * sleep, or delete the lane. Account level, by the computer's ADE Cloud id,
 * like the ADE Cloud page. Nothing for a lane that isn't on ADE Cloud.
 *
 * `turnRunning`: this chat's turn is running, so Sleep asks first (sleep
 * freezes the computer, and the turn may fail), as Sleep does everywhere.
 */
export function CloudLaneHeaderButton({ laneId, turnRunning }: { laneId: string | null; turnRunning: boolean }) {
  const { computers } = useAdeCloudLaneComputers();
  const [sizing, setSizing] = useState(false);
  const computer = laneId ? computers.find((entry) => entry.laneId === laneId) ?? null : null;
  if (!computer) return null;
  const life = cloudLaneLifeAvailable();
  const name = computer.laneName || "this lane";
  const actions: MachineAction[] = [];
  if (life) actions.push({ key: "size", label: "Change size", icon: <Cpu size={13} />, onSelect: () => setSizing(true) });
  actions.push({
    key: "disk",
    label: "Disk, hours and more on the ADE Cloud page",
    icon: <MagnifyingGlass size={13} />,
    onSelect: () => navigateToAppTarget({ kind: "settings", tab: "ade-cloud", anchor: "cloud-lanes" }),
  });
  if (computer.state === "running") {
    actions.push({
      key: "sleep",
      label: "Put its computer to sleep",
      icon: <Moon size={13} />,
      onSelect: () => void sleepLaneComputer(computer.instanceId, name, turnRunning),
    });
  }
  if (life) {
    actions.push({
      key: "delete",
      label: "Delete lane",
      icon: <Trash size={13} />,
      danger: true,
      onSelect: () => void deleteCloudLaneWithCheck({ instanceId: computer.instanceId, laneName: name, askFirst: true }),
    });
  }
  return (
    <>
      <MachineActionsMenu
        label={`ADE Cloud computer of ${name}`}
        actions={actions}
        trigger={{ icon: <Cloud size={16} weight="bold" />, className: WORK_HEADER_ICON_BUTTON_CLASS, title: "This lane's ADE Cloud computer" }}
      />
      {sizing ? <CloudTierChangeDialog instanceId={computer.instanceId} laneName={name} onClose={() => setSizing(false)} /> : null}
    </>
  );
}

/** Sleep from the chat header: the shared confirm and IPC call, a toast either way, then the list read again. */
async function sleepLaneComputer(instanceId: string, name: string, turnRunning: boolean): Promise<void> {
  if (!(await confirmCloudSleep(`${name}'s computer`, turnRunning ? 1 : 0))) return;
  const result = await callCloudMachineAction({ instanceId, action: "sleep" });
  if (result?.ok) {
    showToast({ tone: "info", title: `${name}'s computer is going to sleep.` });
  } else {
    showToast({
      tone: "warning",
      title: `Couldn't put ${name}'s computer to sleep`,
      message: result?.message || "This window can't reach ADE Cloud. Try it from the ADE desktop app.",
    });
  }
  refreshCloudMachines();
}
