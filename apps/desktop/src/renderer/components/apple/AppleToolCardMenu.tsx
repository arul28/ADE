import { useCallback, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowSquareOut, DotsThree, Eject, Play, Trash } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { showToast } from "../app/toast/toastStore";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from "../ui/paneMenuTokens";
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
 * - **Boot** (or, while it is running, **Open in Apple Development**) — the
 *   one click that turns the device on, then shows it.
 * - **Release device** — the lane gives up the claim; the simulator stays
 *   installed with everything on it. This is what "how do I unclaim?" was
 *   missing.
 * - **Delete device…** — only ever offered for an ADE CLONE. It is the one
 *   action that frees disk and destroys data, so it lives behind the same
 *   two-step inline confirmation the device picker uses, and an attached
 *   simulator never gets the row at all (ADE only detaches what it did not
 *   create).
 *
 * Mutations carry `ignoreOwnership: true`, the Work pane's standing rule: the
 * pane is lane-scoped and acts for whoever is here, so it must not impersonate
 * the chat session that happens to own the device right now.
 */
export function AppleToolCardMenu({
  device,
  laneId,
  chatSessionId,
  runtimePin,
  onOpenTool,
}: {
  device: AppleLaneDeviceCard;
  laneId: string;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** Open the Apple Development pane, after a boot or from "Open". */
  onOpenTool: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // `starting` counts as "already coming up": offering Boot mid-boot would
  // queue a second start. The one useful action then is to watch it.
  const comingUp = device.state === "running" || device.state === "starting";

  const run = useCallback(
    (action: string, task: () => Promise<unknown>, after?: () => void) => {
      setPending(true);
      void task()
        .then(() => after?.())
        .catch((error: unknown) => {
          showToast({
            title: `${action} failed`,
            message: error instanceof Error ? error.message : String(error),
            tone: "error",
          });
        })
        .finally(() => setPending(false));
    },
    [],
  );

  const boot = useCallback(() => {
    run("Boot device", () => window.ade.iosSimulator.deviceStart({
      laneId,
      chatSessionId,
      udid: device.udid,
    }, runtimePin), onOpenTool);
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

  const isClone = device.origin === "clone";

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) setConfirmingDelete(false);
      }}
    >
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-label={`Manage ${device.name}`}
          data-apple-tool-card-menu={device.udid ?? device.name}
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
              data-apple-tool-card-open={device.udid ?? device.name}
              onSelect={onOpenTool}
            >
              <ArrowSquareOut size={14} />
              Open in Apple Development
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              data-apple-tool-card-boot={device.udid ?? device.name}
              onSelect={boot}
            >
              <Play size={14} />
              Boot device
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            data-apple-tool-card-release={device.udid ?? device.name}
            onSelect={release}
          >
            <Eject size={14} />
            Release device
          </DropdownMenu.Item>
          {isClone ? (
            <>
              <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
              {confirmingDelete ? (
                <DropdownMenu.Item
                  className={cn(MENU_ITEM_CLASS, "text-[var(--color-error)]")}
                  data-apple-tool-card-delete-confirm={device.udid ?? device.name}
                  onSelect={remove}
                >
                  <Trash size={14} />
                  Delete for good
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item
                  className={cn(MENU_ITEM_CLASS, "text-[var(--color-error)]")}
                  data-apple-tool-card-delete={device.udid ?? device.name}
                  onSelect={(event) => {
                    // Keep the menu open: the confirmation is the same row, one
                    // step further on, so the device being deleted never changes
                    // between the two clicks.
                    event.preventDefault();
                    setConfirmingDelete(true);
                  }}
                >
                  <Trash size={14} />
                  Delete device…
                </DropdownMenu.Item>
              )}
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
