import type { AndroidRenderRequestSpec } from "../../../shared/types/androidEmulator";
import { DeviceRenderSheet } from "../device/DeviceRenderSheet";
import { ANDROID_RENDER_ANGLES } from "./androidRender";

/** The shared Render sheet, with the Back angle Android adds. */
export function AndroidRenderSheet({
  deviceName,
  rendering,
  onClose,
  onRender,
}: {
  deviceName: string;
  rendering: boolean;
  onClose: () => void;
  onRender: (request: AndroidRenderRequestSpec) => void;
}) {
  return (
    <DeviceRenderSheet
      tool="android"
      deviceName={deviceName}
      angles={ANDROID_RENDER_ANGLES}
      rendering={rendering}
      onClose={onClose}
      onRender={onRender}
    />
  );
}
