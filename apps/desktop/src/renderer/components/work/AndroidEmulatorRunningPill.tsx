import { useCallback } from "react";
import { AndroidLogo, PictureInPicture } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { workRuntimeScopeKey } from "../../lib/chatMachineRouting";
import { useWorkSurfaceElementMounted, workSurfaceKey } from "../../lib/workToolOnScreen";
import { useAppStore } from "../../state/appStore";
import { floatAndroidMiniPlayerForChat, useAndroidMiniPlayerTarget } from "../android/androidMiniPlayerStore";
import { useAndroidLaneDeviceCard } from "../android/useAndroidLaneDeviceCard";
import { requestWorkTool } from "../terminals/workToolRequests";
import { PaneTooltip } from "../ui/PaneTooltip";
import { cn } from "../ui/cn";
import { logRendererDebugEvent } from "../../lib/debugLog";

/**
 * The chat-chrome chip shown while the chat's lane has an Android emulator
 * running and nothing shows it: the twin of `IosSimulatorRunningPill`.
 *
 * Open shows the Android tool in the Work tools pane; Float puts the emulator
 * in the floating player. It reads the lane's emulator on the CHAT's machine
 * (`runtimePin`, from `useChatRuntimeScope`), so a chat whose lane lives on
 * another machine sees that machine's emulator. One status read, then one
 * after each Android event for the lane (`useAndroidLaneDeviceCard`); no poll.
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
    <span
      className={cn(
        "inline-flex max-w-[280px] items-center gap-1 rounded-full border py-0.5 pl-2 pr-1",
        "border-cyan-300/20 bg-cyan-400/[0.06] font-sans text-[10px] font-medium text-cyan-100/75",
      )}
      title={`Emulator running on ${device.name}`}
      data-android-emulator-running-pill={device.avdName}
    >
      <AndroidLogo size={11} weight="fill" aria-hidden className="shrink-0" />
      <span className="min-w-0 truncate">Emulator running</span>
      <button
        type="button"
        onClick={open}
        data-android-emulator-running-open=""
        className="shrink-0 rounded-full px-1.5 text-cyan-200/70 transition-colors hover:text-cyan-50"
      >
        Open
      </button>
      <PaneTooltip label="Float">
        <button
          type="button"
          aria-label="Float"
          data-android-emulator-running-float=""
          onClick={float}
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
            "text-cyan-200/70 transition-colors hover:text-cyan-50",
          )}
        >
          <PictureInPicture size={10} weight="bold" />
        </button>
      </PaneTooltip>
    </span>
  );
}
