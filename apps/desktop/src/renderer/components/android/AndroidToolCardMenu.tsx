import { useCallback, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowSquareOut, ArrowsClockwise, DotsThree, Eject, PictureInPicture, Play, Stop } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { showToast } from "../app/toast/toastStore";
import { Button } from "../ui/Button";
import { DangerConfirmMenuItem } from "../ui/DangerConfirmMenuItem";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_SEPARATOR_CLASS } from "../ui/paneMenuTokens";
import { floatAndroidMiniPlayerForChat } from "./androidMiniPlayerStore";
import { requestAndroidPicker } from "./androidPickerRequests";
import type { AndroidLaneDeviceCard } from "./useAndroidLaneDeviceCard";

/**
 * The Android Development card's action menu: the twin of `AppleToolCardMenu`.
 *
 * The card names the lane's emulator and its power. The menu makes that
 * claim actionable where it is stated:
 *
 * - **Start device** while it is off, or **Open in Android Development** while
 *   it is up (or coming up). Start opens the pane, so the boot shows.
 * - **Float** puts the running emulator in the floating player.
 * - **Stop device** powers the emulator off. The lane keeps the device.
 * - **Choose another device** opens the pane on its device picker.
 * - **Release device** gives the AVD back. The AVD stays on disk either way;
 *   while the emulator runs, it confirms inline first (release stops it).
 * - **Delete device…** only for an AVD ADE made for this lane: it releases the
 *   device and deletes the AVD with its apps and data, behind a two-step
 *   confirmation. A user's own AVD never gets this row.
 *
 * Every call carries the lane's machine pin, the one the pane uses, so a lane
 * on another machine is acted on THERE.
 */
export function AndroidToolCardMenu({
  device,
  laneId,
  chatSessionId,
  runtimePin,
  onOpenTool,
  onMutated,
}: {
  device: AndroidLaneDeviceCard;
  laneId: string;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** Open the Android Development pane. */
  onOpenTool: () => void;
  /** A mutation succeeded: the card should read again. */
  onMutated: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // `starting` and `stopping` count as up: a second start mid-boot would queue.
  const comingUp = device.state !== "off" && device.state !== "crashed";
  const booted = device.state === "booted";
  const adeMade = device.origin === "created";

  const run = useCallback((action: string, task: () => Promise<unknown>, after?: () => void) => {
    if (pending) return;
    setPending(true);
    // `Promise.resolve().then(task)`: a namespace that throws synchronously
    // must not leave `pending` stuck true.
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

  const start = useCallback(() => {
    // Opened first: the pane shows the boot, and the start answers when it is up.
    onOpenTool();
    run("Start device", () => window.ade.androidEmulator.start({ laneId }, runtimePin));
  }, [laneId, onOpenTool, run, runtimePin]);

  const stop = useCallback(() => {
    run("Stop device", () => window.ade.androidEmulator.stop({ laneId }, runtimePin));
  }, [laneId, run, runtimePin]);

  const float = useCallback(() => {
    run("Float device", async () => {
      const floated = await floatAndroidMiniPlayerForChat({ laneId, chatSessionId, runtimePin, auto: false });
      if (!floated) throw new Error(`${device.name} could not float. Open it in Android Development instead.`);
    });
  }, [chatSessionId, device.name, laneId, run, runtimePin]);

  const choose = useCallback(() => {
    requestAndroidPicker(laneId, runtimePin);
    onOpenTool();
  }, [laneId, onOpenTool, runtimePin]);

  const release = useCallback(() => {
    run("Release device", () => window.ade.androidEmulator.releaseDevice({ laneId, deleteCreated: false }, runtimePin));
  }, [laneId, run, runtimePin]);

  const remove = useCallback(() => {
    run("Delete device", () => window.ade.androidEmulator.releaseDevice({ laneId, deleteCreated: true }, runtimePin));
  }, [laneId, run, runtimePin]);

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
          data-android-tool-card-menu={device.avdName}
          className="h-6 w-6 shrink-0 p-0 text-muted-fg"
        >
          <DotsThree size={16} weight="bold" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CONTENT_CLASS} side="bottom" align="end" sideOffset={6}>
          <div className={MENU_LABEL_CLASS}>{device.name}</div>
          {comingUp ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} data-android-tool-card-open={device.avdName} onSelect={onOpenTool}>
              <ArrowSquareOut size={14} />
              Open in Android Development
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} data-android-tool-card-start={device.avdName} onSelect={start}>
              <Play size={14} />
              Start device
            </DropdownMenu.Item>
          )}
          {booted ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} data-android-tool-card-float={device.avdName} onSelect={float}>
              <PictureInPicture size={14} />
              Float
            </DropdownMenu.Item>
          ) : null}
          {comingUp ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} data-android-tool-card-stop={device.avdName} onSelect={stop}>
              <Stop size={14} />
              Stop device
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item className={MENU_ITEM_CLASS} data-android-tool-card-choose={device.avdName} onSelect={choose}>
            <ArrowsClockwise size={14} />
            Choose another device
          </DropdownMenu.Item>
          {comingUp ? (
            <DangerConfirmMenuItem
              danger={false}
              icon={Eject}
              confirming={confirmingRelease}
              idleLabel="Release device…"
              confirmLabel="Stop and release"
              idleDataAttribute={{ name: "data-android-tool-card-release", value: device.avdName }}
              confirmDataAttribute={{ name: "data-android-tool-card-release-confirm", value: device.avdName }}
              onBeginConfirm={() => setConfirmingRelease(true)}
              onConfirm={release}
            />
          ) : (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} data-android-tool-card-release={device.avdName} onSelect={release}>
              <Eject size={14} />
              Release device
            </DropdownMenu.Item>
          )}
          {adeMade ? (
            <>
              <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
              <DangerConfirmMenuItem
                confirming={confirmingDelete}
                idleLabel="Delete device…"
                confirmLabel="Delete for good"
                idleDataAttribute={{ name: "data-android-tool-card-delete", value: device.avdName }}
                confirmDataAttribute={{ name: "data-android-tool-card-delete-confirm", value: device.avdName }}
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
