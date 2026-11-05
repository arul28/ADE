import { useState } from "react";
import type { AppleDevicePose, AppleRenderRequestSpec } from "../../../shared/types/iosSimulator";
import { DeviceRenderCheck, DeviceRenderSection, DeviceRenderSheet, toggleRenderChoice } from "../device/DeviceRenderSheet";
import { APPLE_RENDER_ANGLES } from "./appleRenderProof";

const DUO_POSES: ReadonlyArray<{ id: AppleDevicePose; label: string }> = [
  { id: "closed", label: "Closed" },
  { id: "tent", label: "Tent" },
  { id: "laptop", label: "Laptop" },
  { id: "book", label: "Book" },
  { id: "open", label: "Open" },
];

/**
 * The shared Render sheet, plus the Duo's poses: each pose folds the
 * simulator before its shots, so every angle makes one image per pose.
 */
export function AppleRenderSheet({
  deviceName,
  duo,
  rendering,
  onClose,
  onRender,
}: {
  deviceName: string;
  duo: boolean;
  rendering: boolean;
  onClose: () => void;
  onRender: (request: AppleRenderRequestSpec) => void;
}) {
  const [poses, setPoses] = useState<AppleDevicePose[]>(["closed", "tent", "laptop", "open"]);
  return (
    <DeviceRenderSheet
      tool="apple"
      deviceName={deviceName}
      angles={APPLE_RENDER_ANGLES}
      rendering={rendering}
      imagesPerAngle={duo ? Math.max(1, poses.length) : 1}
      extraBlocksRender={duo && poses.length === 0}
      extra={duo ? (
        <DeviceRenderSection title="Poses (folds the simulator)">
          {DUO_POSES.map((pose) => (
            <DeviceRenderCheck
              key={pose.id}
              label={pose.label}
              checked={poses.includes(pose.id)}
              onChange={(on) => setPoses((current) => toggleRenderChoice(current, pose.id, on))}
            />
          ))}
        </DeviceRenderSection>
      ) : null}
      onClose={onClose}
      onRender={({ background, ...choice }) => onRender({ ...choice, poses: duo ? poses : [], lighting: background })}
    />
  );
}
