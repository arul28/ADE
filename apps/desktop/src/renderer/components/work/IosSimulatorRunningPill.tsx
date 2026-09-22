import { DeviceMobile, PictureInPicture } from "@phosphor-icons/react";
import { PaneTooltip } from "../ui/PaneTooltip";
import { cn } from "../ui/cn";
import {
  isWorkLivePictureInPictureSupported,
  WORK_LIVE_PIP_UNSUPPORTED_LABEL,
} from "./workLiveIosPictureInPicture";

/**
 * The chat-chrome chip shown while an agent has a simulator running and the
 * Apple pane is closed. Open reveals the pane; Float pops the device out into
 * the mini player (§7), which owns native picture-in-picture itself.
 */
export function IosSimulatorRunningPill({
  deviceName,
  onOpen,
  onFloat,
}: {
  deviceName: string | null;
  onOpen: () => void;
  onFloat: () => void;
}) {
  const pipSupported = isWorkLivePictureInPictureSupported();
  const title = deviceName ? `Simulator running on ${deviceName}` : "Simulator running";

  return (
    <span
      className={cn(
        "inline-flex max-w-[280px] items-center gap-1 rounded-full border py-0.5 pl-2 pr-1",
        "border-cyan-300/20 bg-cyan-400/[0.06] font-sans text-[10px] font-medium text-cyan-100/75",
      )}
      title={title}
      data-ios-simulator-running-pill=""
    >
      <DeviceMobile size={11} weight="fill" aria-hidden className="shrink-0" />
      <span className="min-w-0 truncate">Simulator running</span>
      <button
        type="button"
        onClick={onOpen}
        className="shrink-0 rounded-full px-1.5 text-cyan-200/70 transition-colors hover:text-cyan-50"
      >
        Open
      </button>
      <PaneTooltip label={pipSupported ? "Float" : WORK_LIVE_PIP_UNSUPPORTED_LABEL}>
        <button
          type="button"
          aria-label="Float"
          data-ios-simulator-running-float=""
          disabled={!pipSupported}
          onClick={onFloat}
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
            "text-cyan-200/70 transition-colors hover:text-cyan-50",
            "disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          <PictureInPicture size={10} weight="bold" />
        </button>
      </PaneTooltip>
    </span>
  );
}
