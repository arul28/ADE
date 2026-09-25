import { useCallback, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowSquareOut, DotsThree, Eject, Play } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { showToast } from "../app/toast/toastStore";
import { Button } from "../ui/Button";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_SEPARATOR_CLASS } from "../ui/paneMenuTokens";
import { DangerConfirmMenuItem } from "./DangerConfirmMenuItem";
import type { AppleLaneDeviceCard } from "./useAppleLaneDeviceCard";

/**
 * The Apple Development card's action menu.
 *
 * The picker card used to have exactly one thing to say about a device — its
 * name and its power state — and exactly one gesture, "open the pane". That
 * left the two questions the owner actually arrives with unanswered on the
 * card: boot it, or hand it back. The claim is invisible until you open the
 * pane, and the pane's "Choose another device" reads as switching, not
 * releasing.
 *
 * So the card grows a menu. It is the lane's device and nothing else:
 *
 * - **Boot** (or, while it is already up, **Open in Apple Development**) — the
 *   one click that turns the device on, then shows it.
 * - **Release device** — the lane gives up the claim; the simulator stays
 *   installed with everything on it. This is what "how do I unclaim?" was
 *   missing. While a session is live it confirms first: releasing ends that
 *   session, which the pane's own running path also gates behind a confirm.
 * - **Delete device…** — only ever offered for an ADE CLONE. It is the one
 *   action that frees disk and destroys data, so it lives behind the same
 *   two-step inline confirmation the device picker uses. An attached simulator
 *   never gets the row at all (ADE only detaches what it did not create).
 *
 * Release and delete carry `ignoreOwnership: true`, the Work pane's standing
 * rule: the pane is lane-scoped and acts for whoever is here, so it must not
 * impersonate the chat session that happens to own the device right now. Boot
 * has no such field to set — it takes the lane, not an owner.
 */
export function AppleToolCardMenu({
  device,
  laneId,
  chatSessionId,
  runtimePin,
  onOpenTool,
  onMutated,
}: {
  device: AppleLaneDeviceCard;
  laneId: string;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** Open the Apple Development pane, after a boot or from "Open". */
  onOpenTool: () => void;
  /** A mutation succeeded: the card should re-read (the web client gets no events). */
  onMutated: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // `starting` counts as "already coming up": offering Boot mid-boot would
  // queue a second start. The one useful action then is to watch it.
  const comingUp = device.state !== "off";
  const isClone = device.origin === "clone";

  const run = useCallback((action: string, task: () => Promise<unknown>, after?: () => void) => {
    if (pending) return;
    setPending(true);
    // `Promise.resolve().then(task)` rather than `task()`: a namespace that
    // throws SYNCHRONOUSLY would escape the chain and leave `pending` stuck
    // true, disabling the trigger for the card's lifetime.
    void Promise.resolve()
      .then(task)
      .then(() => {
        onMutated();
        after?.();
      })
      .catch((error: unknown) => {
        showToast({
          title: `${action} failed`,
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
      })
      .finally(() => setPending(false));
  }, [onMutated, pending]);

  const boot = useCallback(() => {
    run(
      "Boot device",
      () => window.ade.iosSimulator.deviceStart({ laneId, chatSessionId, udid: device.udid }, runtimePin),
      onOpenTool,
    );
  }, [chatSessionId, device.udid, laneId, onOpenTool, run, runtimePin]);

  const release = useCallback(() => {
    run("Release device", () => window.ade.iosSimulator.deviceDetach({
      laneId,
      chatSessionId,
      ignoreOwnership: true,
    }, runtimePin));
  }, [chatSessionId, laneId, run, runtimePin]);

  const remove = useCallback(() => {
    run("Delete device", () => window.ade.iosSimulator.deviceDelete({
      laneId,
      chatSessionId,
      ignoreOwnership: true,
    }, runtimePin));
  }, [chatSessionId, laneId, run, runtimePin]);

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) {
          setConfirmingRelease(false);
          setConfirmingDelete(false);
        }
      }}
    >
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-label={`Manage ${device.name}`}
          data-apple-tool-card-menu={device.udid}
          className="h-6 w-6 shrink-0 p-0 text-muted-fg"
        >
          <DotsThree size={16} weight="bold" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CONTENT_CLASS} side="bottom" align="end" sideOffset={6}>
          <div className={MENU_LABEL_CLASS}>{device.name}</div>
          {comingUp ? (
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              data-apple-tool-card-open={device.udid}
              onSelect={onOpenTool}
            >
              <ArrowSquareOut size={14} />
              Open in Apple Development
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              data-apple-tool-card-boot={device.udid}
              onSelect={boot}
            >
              <Play size={14} />
              Boot device
            </DropdownMenu.Item>
          )}
          {comingUp ? (
            <DangerConfirmMenuItem
              danger={false}
              confirming={confirmingRelease}
              idleLabel="Release device…"
              confirmLabel="End session and release"
              idleDataAttribute={{ name: "data-apple-tool-card-release", value: device.udid }}
              confirmDataAttribute={{ name: "data-apple-tool-card-release-confirm", value: device.udid }}
              onBeginConfirm={() => setConfirmingRelease(true)}
              onConfirm={release}
            />
          ) : (
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              data-apple-tool-card-release={device.udid}
              onSelect={release}
            >
              <Eject size={14} />
              Release device
            </DropdownMenu.Item>
          )}
          {isClone ? (
            <>
              <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
              <DangerConfirmMenuItem
                confirming={confirmingDelete}
                idleLabel="Delete device…"
                confirmLabel="Delete for good"
                idleDataAttribute={{ name: "data-apple-tool-card-delete", value: device.udid }}
                confirmDataAttribute={{ name: "data-apple-tool-card-delete-confirm", value: device.udid }}
                onBeginConfirm={() => setConfirmingDelete(true)}
                onConfirm={remove}
              />
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
