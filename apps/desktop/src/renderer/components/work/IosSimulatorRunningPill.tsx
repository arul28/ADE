import { DeviceMobile } from "@phosphor-icons/react";
import { DeviceRunningPill } from "./DeviceRunningPill";
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
    <DeviceRunningPill
      icon={<DeviceMobile size={11} weight="fill" aria-hidden className="shrink-0" />}
      label="Simulator running"
      title={title}
      dataAttributes={{ "data-ios-simulator-running-pill": "" }}
      floatDataAttributes={{ "data-ios-simulator-running-float": "" }}
      floatTooltip={pipSupported ? "Float" : WORK_LIVE_PIP_UNSUPPORTED_LABEL}
      floatDisabled={!pipSupported}
      onOpen={onOpen}
      onFloat={onFloat}
    />
  );
}
