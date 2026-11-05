import { useState } from "react";
import {
  ANDROID_RENDER_BACKGROUNDS,
  type AndroidRenderAngleId,
  type AndroidRenderBackground,
  type AndroidRenderRequestSpec,
} from "../../../shared/types/androidEmulator";
import { Dialog } from "../ui/dialog";
import { ANDROID_RENDER_ANGLES } from "./androidRender";

function Check({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 font-sans text-[12px] text-fg/85">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      {label}
    </label>
  );
}

const BACKGROUND_LABELS: Record<AndroidRenderBackground, string> = {
  transparent: "Transparent",
  studio: "Studio",
  dusk: "Dusk",
};

/**
 * The Render sheet: which angles, the background and the extras. Every image
 * is filed to the proof drawer. The Apple sheet's layout, with a Back angle.
 */
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
  const [angles, setAngles] = useState<AndroidRenderAngleId[]>(["front", "three-quarter-left"]);
  const [background, setBackground] = useState<AndroidRenderBackground>("transparent");
  const [shadow, setShadow] = useState(true);
  const [video, setVideo] = useState(false);
  const [contactSheet, setContactSheet] = useState(true);
  const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? [...list, value] : list.filter((entry) => entry !== value));
  const imageCount = angles.length;
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
          disabled: rendering || angles.length === 0,
          variant: "primary",
          autoFocus: true,
        },
      ]}
    >
      <div data-android-render-sheet="" className="flex flex-col gap-3 py-1">
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] uppercase tracking-[0.08em] text-muted-fg">Angles</span>
          <div className="flex flex-wrap gap-3">
            {ANDROID_RENDER_ANGLES.map((angle) => (
              <Check
                key={angle.id}
                label={angle.label}
                checked={angles.includes(angle.id)}
                onChange={(on) => setAngles((current) => toggle(current, angle.id, on))}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] uppercase tracking-[0.08em] text-muted-fg">Background</span>
          <div className="flex flex-wrap gap-3">
            {ANDROID_RENDER_BACKGROUNDS.map((value) => (
              <label key={value} className="inline-flex cursor-pointer items-center gap-1.5 font-sans text-[12px] text-fg/85">
                <input type="radio" name="android-render-background" checked={background === value} onChange={() => setBackground(value)} />
                {BACKGROUND_LABELS[value]}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <Check label="Contact shadow" checked={shadow} onChange={setShadow} />
          <Check label="Contact sheet" checked={contactSheet} onChange={setContactSheet} />
          <Check label="Turntable video (6 s)" checked={video} onChange={setVideo} />
        </div>
      </div>
    </Dialog>
  );
}
