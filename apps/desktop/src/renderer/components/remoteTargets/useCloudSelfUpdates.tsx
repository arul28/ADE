import { useCallback, useMemo, type ReactNode } from "react";
import { cloudMachineSelfUpdating, type CloudMachine } from "../../../shared/adeCloud";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { CloudUpdateLine } from "./CloudUpdateLine";
import { cloudBoxContext, useCloudBoxActions, type CloudBoxActionError } from "./useCloudBoxActions";
import { useCloudMachines } from "./useCloudMachines";

const NO_ITEMS: never[] = [];
const keepSavedConnection = async () => undefined;

/**
 * The account's cloud computers for the update lists (Settings): each one
 * updates itself, so these lists show its update line where another machine
 * has an Update button. Only computers that update themselves count (their
 * server reports updates and their channel's automatic updates are on); any
 * other cloud computer stays an ordinary machine there.
 *
 * Account level, like every cloud read: the list and Retry go out with no
 * pin. It shares the one cloud list in memory and starts no re-read timer.
 */
export function useCloudSelfUpdates(enabled = true) {
  const cloudEnabled = useAdeCloudEnabled();
  const cloud = useCloudMachines(enabled && cloudEnabled && isAdeAvailable(window.ade?.cloud?.listMachines), { settle: false });
  const actions = useCloudBoxActions({ refresh: cloud.refresh, forgetTarget: keepSavedConnection });
  const boxes = useMemo(
    () => (cloud.result?.state === "ok" ? cloud.result.machines.filter((box) => cloudMachineSelfUpdating(box) && box.machineKey) : []),
    [cloud.result],
  );
  const byMachineKey = useMemo(() => new Map(boxes.map((box) => [box.machineKey!, box])), [boxes]);

  /** The cloud computer a machine is, by its account machine key (a connection's color key). */
  const boxFor = useCallback((machineKey: string | null | undefined): CloudMachine | null => (
    machineKey ? byMachineKey.get(machineKey) ?? null : null
  ), [byMachineKey]);

  /** The line, with Retry as the person's own update (and its confirm). */
  const lineFor = useCallback((box: CloudMachine, name: string): ReactNode => (
    <CloudUpdateLine
      update={box.update}
      onRetry={box.pastDue ? null : () => void actions.update(cloudBoxContext({ box, accountMachine: null, targetId: null, activityItems: NO_ITEMS, accountKnown: false, name }))}
      retrying={actions.pendingById[box.instanceId] === "update"}
    />
  ), [actions]);

  const errorFor = useCallback((box: CloudMachine): CloudBoxActionError | null => actions.errorById[box.instanceId] ?? null, [actions.errorById]);

  return { boxes, boxFor, lineFor, errorFor, dismissError: actions.dismissError };
}
