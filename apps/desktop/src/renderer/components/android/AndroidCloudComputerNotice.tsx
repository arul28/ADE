import { useState } from "react";
import { AndroidLogo } from "@phosphor-icons/react";
import {
  cloudAndroidNeedsVmCost,
  cloudAndroidVmShape,
  cloudDiskGrowPlan,
  cloudMachineKindOf,
  cloudMachineRunsAndroid,
  cloudShape,
  describeCloudMachineSize,
  type CloudAccountState,
  type CloudMachine,
} from "../../../shared/adeCloud";
import { androidLowDiskSentence } from "../../../shared/androidDisk";
import type { NoticeAction } from "../ui/notice";
import { Banner } from "../ui/notice";
import { cloudBoxContext, cloudPendingLabel, useCloudBoxActions } from "../remoteTargets/useCloudBoxActions";
import { openCloudPlanSettings } from "../remoteTargets/openCloudPlanSettings";

/** What the cloud computer lacks for the Android emulator. */
export type AndroidCloudNeed =
  /** A standard computer, or a full computer smaller than Medium: no emulator at all. */
  | { kind: "full-computer" }
  /** A device's first start needs this much free on the disk, and this much is free. */
  | { kind: "disk"; neededMb: number; freeMb: number };

/**
 * The cloud computer behind the Android pane, when it can't run the emulator:
 * a standard computer, or a full computer smaller than Medium. Null for any
 * other machine, and while the computer is not known yet.
 */
export function cloudComputerWithoutAndroid(box: CloudMachine | null): CloudMachine | null {
  return box && !cloudMachineRunsAndroid(box) ? box : null;
}

/** Can the menu's own Move run on it (the Connections row offers it in the same states). */
function canMove(box: CloudMachine): boolean {
  return Boolean(box.machineKey) && (box.state === "running" || box.state === "asleep" || box.state === "stopped");
}

/**
 * What an ADE Cloud computer lacks for the Android emulator, in place of the
 * emulator's own refusal: nobody can turn on KVM there, and its disk starts
 * small. Says what the computer is and offers the one way forward, with its
 * own confirmation:
 *
 * - no emulator: the Connections menu's "Move to a full computer…" (a
 *   standard computer) or "Resize…" (a small full computer), with the hours
 *   that uses;
 * - too little disk: "Grow the disk" to the smallest step that fits, with
 *   what it takes of the plan's disk at one time, or what extra disk costs.
 *   The computer restarts; the person starts the device again once it is
 *   back. A grow the server holds for extra disk opens the plans card.
 *
 * All account level: they take the instance id, never a pin (the pane finds
 * the computer by its pin). Not an error, so nothing to report.
 */
export function AndroidCloudComputerNotice({
  box,
  account,
  need,
  name,
  refresh,
  onDismiss,
}: {
  box: CloudMachine;
  /** The account's plan and disk, when read. */
  account: CloudAccountState | null;
  need: AndroidCloudNeed;
  /** The pane's name for the machine, when it has one. */
  name: string | null;
  /** Read the computers again after an action. */
  refresh: () => void;
  /** Dismisses the notice; also called once a disk grow has started, since the refusal is then stale. */
  onDismiss?: (() => void) | undefined;
}) {
  const actions = useCloudBoxActions({
    refresh,
    // This notice offers no Remove from ADE, the only action that forgets a connection.
    forgetTarget: async () => {},
  });
  const ctx = cloudBoxContext({ box, accountMachine: null, targetId: null, activityItems: [], accountKnown: false, name });
  const kind = cloudMachineKindOf(box.type);
  const boxShape = cloudShape(box.shapeId);
  const pending = actions.pendingById[box.instanceId] ?? null;
  const serverFailure = actions.errorById[box.instanceId]?.message ?? null;
  // The grow went past the plan's disk with extra disk never decided: the
  // server's sentence says so, and the way on is the plans card.
  const [needsApproval, setNeedsApproval] = useState(false);
  const approvalAsked = serverFailure != null && needsApproval;
  const items: NoticeAction[] = [];
  let sentence: string;
  if (need.kind === "disk") {
    const plan = cloudDiskGrowPlan(box, account, need.neededMb - need.freeMb);
    sentence = `${androidLowDiskSentence(need.neededMb, need.freeMb)} ${plan.sentence}`;
    if (!approvalAsked && plan.grow && box.state === "running") {
      const toGb = plan.toGb;
      items.push({
        label: "Grow the disk",
        onClick: () => void actions.growDisk(ctx, toGb).then((result) => {
          if (!result) return;
          // Any other refusal shows the server's own sentence (`errorById`).
          setNeedsApproval(!result.ok && result.diskRefusal?.reason === "needs_approval");
          if (result.ok) onDismiss?.();
        }),
      });
    }
    if (approvalAsked || (!plan.grow && plan.settings)) {
      items.push({ label: "Open Settings", onClick: openCloudPlanSettings });
    }
  } else {
    sentence = cloudAndroidNeedsVmCost(boxShape, kind);
    if (kind === "box" && canMove(box)) {
      items.push({ label: "Move to a full computer…", onClick: () => void actions.moveBox(ctx, cloudAndroidVmShape(boxShape).id) });
    } else if (kind === "vm" && box.state === "running" && box.resources) {
      items.push({ label: "Resize…", onClick: () => actions.resize(ctx) });
    }
  }
  const title = [
    ctx.name,
    kind === "vm" ? null : "Standard computer",
    // Says the disk too, when the provider reports it.
    describeCloudMachineSize(box),
  ]
    .filter(Boolean)
    .join(" · ");
  const testId = need.kind === "disk" ? "android-cloud-low-disk" : "android-cloud-needs-vm";
  return (
    <>
      <Banner
        layout="inline"
        style={{ margin: "6px 8px", flexShrink: 0 }}
        testId={testId}
        model={{
          id: testId,
          tone: serverFailure || need.kind === "disk" ? "warning" : "neutral",
          icon: <AndroidLogo size={13} />,
          title,
          detail: pending ? cloudPendingLabel(pending) : serverFailure ?? sentence,
          actions: pending ? [] : items,
          busy: pending != null,
          report: false,
          dismiss: serverFailure
            ? {
              onDismiss: () => {
                setNeedsApproval(false);
                actions.dismissError(box.instanceId);
              },
              title: "Dismiss this message",
              label: "Dismiss this message",
            }
            : onDismiss ? { onDismiss, title: "Dismiss this message", label: "Dismiss this message" } : undefined,
        }}
      />
      {actions.dialog}
    </>
  );
}
