import { AndroidLogo } from "@phosphor-icons/react";
import {
  cloudAndroidNeedsVmCost,
  cloudAndroidVmShape,
  cloudCatalogOf,
  cloudDiskGrowPlan,
  cloudMachineKindOf,
  cloudMachineRunsAndroid,
  cloudShape,
  describeCloudMachineSize,
  type CloudAccountState,
  type CloudMachine,
} from "../../../shared/adeCloud";
import { androidLowDiskSentence } from "../../../shared/androidDisk";
import { cloudTierOfMachine, cloudTiers, type CloudTierId } from "../../../shared/cloudTiers";
import { confirmDialog } from "../ui/dialog";
import { changeCloudLaneTier, cloudLaneChangesAvailable } from "../cloudLane/cloudLaneActions";
import type { NoticeAction } from "../ui/notice";
import { Banner } from "../ui/notice";
import { cloudBoxContext, cloudPendingLabel, useCloudBoxActions } from "../remoteTargets/useCloudBoxActions";
import { plainErrorText } from "../../lib/plainError";

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
 * - too little disk: "Grow the disk" to the smallest step that fits, up to
 *   the size's own disk maximum. It runs as the lane's size-change job at
 *   the same size (save work, grow, start ADE, connect), so the lane's chats
 *   show its steps and its result across the restart (`CloudLaneChatStatus`).
 *   The person starts the device again once it is back. With the account
 *   not read, the grow goes straight to the server, whose refusal shows.
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
  const failure = actions.errorById[box.instanceId]?.message ?? null;
  const items: NoticeAction[] = [];
  let sentence: string;
  if (need.kind === "disk") {
    const plan = cloudDiskGrowPlan(box, account, need.neededMb - need.freeMb);
    sentence = `${androidLowDiskSentence(need.neededMb, need.freeMb)} ${plan.sentence}`;
    if (plan.grow && box.state === "running") {
      const toGb = plan.toGb;
      // Inside the size's maximum: the lane's job, whose card shows in its chats.
      const sizeId: CloudTierId | null = cloudTierOfMachine(box, cloudTiers(cloudCatalogOf(account)))?.id ?? null;
      const viaJob = cloudLaneChangesAvailable() && sizeId != null && plan.within != null;
      items.push({
        label: "Grow the disk",
        onClick: viaJob && sizeId
          ? () => void (async () => {
            const ok = await confirmDialog({
              title: `Grow the disk of ${ctx.name} to ${toGb} GB?`,
              message: `ADE saves the chats on ${ctx.name}, grows the disk and starts ADE again: the computer restarts and is back in a few minutes. Chats and agent CLIs that were working continue after it; a command running in a terminal stops. The lane's chats show the steps. A disk can't shrink later.`,
              confirmLabel: "Grow the disk",
            });
            if (!ok) return;
            try {
              actions.dismissError(box.instanceId);
              await changeCloudLaneTier({ instanceId: box.instanceId, sizeId, timing: "now", diskGb: toGb });
              onDismiss?.();
            } catch (error) {
              actions.reportError(box.instanceId, plainErrorText(error, "ADE couldn't resize the cloud computer."));
            }
          })()
          : () => void actions.growDisk(ctx, toGb).then((result) => {
            // A refusal shows the server's own sentence (`errorById`).
            if (result?.ok) onDismiss?.();
          }),
      });
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
    describeCloudMachineSize(box, cloudCatalogOf(account)),
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
          tone: failure || need.kind === "disk" ? "warning" : "neutral",
          icon: <AndroidLogo size={13} />,
          title,
          detail: pending ? cloudPendingLabel(pending) : failure ?? sentence,
          actions: pending ? [] : items,
          busy: pending != null,
          report: false,
          dismiss: failure
            ? {
              onDismiss: () => actions.dismissError(box.instanceId),
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
