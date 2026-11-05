import { useState, type ReactNode } from "react";
import { Dialog } from "../ui/dialog";
import type { DeviceRenderLighting } from "./deviceRenderPass";
import type { DeviceRenderAngle, DeviceRenderAngleId } from "./deviceRenderProof";

const BACKGROUNDS: ReadonlyArray<{ id: DeviceRenderLighting; label: string }> = [
  { id: "transparent", label: "Transparent" },
  { id: "studio", label: "Studio" },
  { id: "dusk", label: "Dusk" },
];

export function DeviceRenderCheck({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 font-sans text-[12px] text-fg/85">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      {label}
    </label>
  );
}

export function DeviceRenderSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-sans text-[11px] uppercase tracking-[0.08em] text-muted-fg">{title}</span>
      <div className="flex flex-wrap gap-3">{children}</div>
    </div>
  );
}

export function toggleRenderChoice<T>(list: T[], value: T, on: boolean): T[] {
  return on ? [...list, value] : list.filter((entry) => entry !== value);
}

export type DeviceRenderChoice<A extends DeviceRenderAngleId> = {
  angles: A[];
  background: DeviceRenderLighting;
  shadow: boolean;
  video: boolean;
  contactSheet: boolean;
};

/**
 * The Render sheet every device shares: which angles, the background and the
 * extras. Every image is filed to the proof drawer. A device adds its own
 * section in `extra` (the Duo's poses) and says how many images each angle
 * makes and whether its section blocks the render.
 */
export function DeviceRenderSheet<A extends DeviceRenderAngleId>({
  tool,
  deviceName,
  angles: angleOptions,
  rendering,
  imagesPerAngle = 1,
  extra = null,
  extraBlocksRender = false,
  onClose,
  onRender,
}: {
  /** Names the background radio group. */
  tool: "apple" | "android";
  deviceName: string;
  angles: ReadonlyArray<DeviceRenderAngle<A>>;
  rendering: boolean;
  imagesPerAngle?: number;
  extra?: ReactNode;
  extraBlocksRender?: boolean;
  onClose: () => void;
  onRender: (choice: DeviceRenderChoice<A>) => void;
}) {
  const [angles, setAngles] = useState<A[]>(() =>
    angleOptions.filter((angle) => angle.id === "front" || angle.id === "three-quarter-left").map((angle) => angle.id),
  );
  const [background, setBackground] = useState<DeviceRenderLighting>("transparent");
  const [shadow, setShadow] = useState(true);
  const [video, setVideo] = useState(false);
  const [contactSheet, setContactSheet] = useState(true);
  const imageCount = angles.length * imagesPerAngle;
  return (
    <Dialog
      // Mounted only while open, so each render starts from the defaults.
      open
      onOpenChange={(next) => {
        if (!next && !rendering) onClose();
      }}
      title={`Render ${deviceName}`}
      description="Stills of the 3D device with its live screen, filed to the proof drawer."
      width={460}
      actions={[
        { label: "Cancel", onClick: onClose, disabled: rendering, variant: "secondary" },
        {
          label: rendering ? "Rendering…" : `Render ${imageCount} image${imageCount === 1 ? "" : "s"}`,
          onClick: () => onRender({ angles, background, shadow, video, contactSheet }),
          disabled: rendering || angles.length === 0 || extraBlocksRender,
          variant: "primary",
          autoFocus: true,
        },
      ]}
    >
      <div data-device-render-sheet={tool} className="flex flex-col gap-3 py-1">
        <DeviceRenderSection title="Angles">
          {angleOptions.map((angle) => (
            <DeviceRenderCheck
              key={angle.id}
              label={angle.label}
              checked={angles.includes(angle.id)}
              onChange={(on) => setAngles((current) => toggleRenderChoice(current, angle.id, on))}
            />
          ))}
        </DeviceRenderSection>
        {extra}
        <DeviceRenderSection title="Background">
          {BACKGROUNDS.map((option) => (
            <label key={option.id} className="inline-flex cursor-pointer items-center gap-1.5 font-sans text-[12px] text-fg/85">
              <input
                type="radio"
                name={`${tool}-render-background`}
                checked={background === option.id}
                onChange={() => setBackground(option.id)}
              />
              {option.label}
            </label>
          ))}
        </DeviceRenderSection>
        <div className="flex flex-wrap gap-3">
          <DeviceRenderCheck label="Contact shadow" checked={shadow} onChange={setShadow} />
          <DeviceRenderCheck label="Contact sheet" checked={contactSheet} onChange={setContactSheet} />
          <DeviceRenderCheck label="Turntable video (6 s)" checked={video} onChange={setVideo} />
        </div>
      </div>
    </Dialog>
  );
}
