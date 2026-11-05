import type { ComponentProps } from "react";
import { DeviceInspectOverlay, type DeviceInspectAdapter } from "../device/DeviceInspectOverlay";
import {
  ancestorsOf,
  describeElement,
  refTierMeaning,
  type IosSimulatorSnapshotElement,
} from "./appleInspectGeometry";

/**
 * The Apple pane's Inspect overlay: the shared `DeviceInspectOverlay` with
 * the snapshot elements' adapter. The card's rows say the element's ref tier,
 * so the person sees whether an agent's ref survives a re-render.
 */
export const APPLE_INSPECT_ADAPTER: DeviceInspectAdapter<IosSimulatorSnapshotElement> = {
  id: (element) => element.id,
  frame: (element) => element.frame,
  describe: (element) => {
    const described = describeElement(element);
    const frame = element.frame;
    return {
      title: described.title,
      subtitle: described.subtitle,
      rows: [
        ["Label", element.label ?? "—"],
        ["Role", element.role ?? element.elementType ?? "—"],
        ["Identifier", element.identifier ?? "—"],
        ["Ref", `${described.refTier} ${refTierMeaning(described.refTier)}`],
        ["Frame", `${frame.x},${frame.y} ${frame.width}×${frame.height}`],
      ],
    };
  },
  ancestors: (elements, element) => ancestorsOf(elements, element.id),
};

export type AppleInspectOverlayProps = Omit<
  ComponentProps<typeof DeviceInspectOverlay<IosSimulatorSnapshotElement>>,
  "tool" | "adapter"
>;

export function AppleInspectOverlay(props: AppleInspectOverlayProps) {
  return <DeviceInspectOverlay<IosSimulatorSnapshotElement> tool="apple" adapter={APPLE_INSPECT_ADAPTER} {...props} />;
}
