import { useCallback } from "react";
import { AndroidLogo } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { workRuntimeScopeKey } from "../../lib/chatMachineRouting";
import { useWorkSurfaceElementMounted, workSurfaceKey } from "../../lib/workToolOnScreen";
import { useAppStore } from "../../state/appStore";
import { floatAndroidMiniPlayerForChat, useAndroidMiniPlayerTarget } from "../android/androidMiniPlayerStore";
import { useAndroidLaneDeviceCard } from "../android/useAndroidLaneDeviceCard";
import { requestWorkTool } from "../terminals/workToolRequests";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { DeviceRunningPill } from "./DeviceRunningPill";

/**
 * The chat-chrome chip shown while the chat's lane has an Android emulator
 * running and nothing shows it: the twin of `IosSimulatorRunningPill`.
 *
 * Open shows the Android tool in the Work tools pane; Float puts the emulator
 * in the floating player. It reads the lane's emulator on the CHAT's machine
 * (`runtimePin`, from `useChatRuntimeScope`), so a chat whose lane lives on
 * another machine sees that machine's emulator. The reading comes from the
 * shared store in `useAndroidLaneDeviceCard`: every pill on one machine and
 * lane shares one status read and one event subscription; no poll.
 *
 * Hidden while the Android pane is mounted for the lane, or while the
 * floating player already shows this lane's emulator: the pill would only
 * repeat them.
 */
export function AndroidEmulatorRunningPill({
  laneId,
  chatSessionId,
  runtimePin,
}: {
  laneId: string | null;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
}) {
  const bound = useAppStore((state) => state.projectBinding);
  const device = useAndroidLaneDeviceCard({ laneId, runtimePin, enabled: Boolean(laneId) });
  const scope = workRuntimeScopeKey(runtimePin, bound);
  const paneMounted = useWorkSurfaceElementMounted(laneId ? workSurfaceKey("android", scope, laneId) : null);
  const floating = useAndroidMiniPlayerTarget();
  const floatingHere = Boolean(floating && laneId && floating.laneId === laneId
    && workRuntimeScopeKey(floating.runtimePin, bound) === scope);

  const open = useCallback(() => requestWorkTool("android"), []);
  const float = useCallback(() => {
    void floatAndroidMiniPlayerForChat({ laneId, chatSessionId, runtimePin, auto: false })
      .then((floated) => {
        // Nothing floats when the emulator went off meanwhile; the pane still can show it.
        if (!floated) requestWorkTool("android");
      })
      .catch((cause: unknown) => {
        logRendererDebugEvent("android.running_pill_float_failed", { error: cause instanceof Error ? cause.message : String(cause) });
      });
  }, [chatSessionId, laneId, runtimePin]);

  if (!device || device.state !== "booted" || paneMounted || floatingHere) return null;
  return (
    <DeviceRunningPill
      icon={<AndroidLogo size={11} weight="fill" aria-hidden className="shrink-0" />}
      label="Emulator running"
      title={`Emulator running on ${device.name}`}
      dataAttributes={{ "data-android-emulator-running-pill": device.avdName }}
      openDataAttributes={{ "data-android-emulator-running-open": "" }}
      floatDataAttributes={{ "data-android-emulator-running-float": "" }}
      onOpen={open}
      onFloat={float}
    />
  );
}
