import { useState } from "react";
import type { AppleDevicePose } from "../../../shared/types/iosSimulator";
import { Dialog } from "../ui/dialog";
import type { AppleDeviceRenderLighting, AppleDeviceRenderShot } from "./AppleDevice3DView";

export type AppleRenderAngleId = "front" | "three-quarter-left" | "three-quarter-right" | "current";

export const APPLE_RENDER_ANGLES: ReadonlyArray<{ id: AppleRenderAngleId; label: string; shot: AppleDeviceRenderShot }> = [
  { id: "front", label: "Front", shot: { yaw: 0, pitch: 0.04 } },
  { id: "three-quarter-left", label: "¾ left", shot: { yaw: -0.62, pitch: 0.14 } },
  { id: "three-quarter-right", label: "¾ right", shot: { yaw: 0.62, pitch: 0.14 } },
  { id: "current", label: "This angle", shot: { current: true } },
];

const DUO_POSES: ReadonlyArray<{ id: AppleDevicePose; label: string }> = [
  { id: "closed", label: "Closed" },
  { id: "tent", label: "Tent" },
  { id: "laptop", label: "Laptop" },
  { id: "book", label: "Book" },
  { id: "open", label: "Open" },
];

export type AppleRenderRequest = {
  angles: AppleRenderAngleId[];
  /** Duo only: each pose folds the real simulator before its shots. */
  poses: AppleDevicePose[];
  lighting: AppleDeviceRenderLighting;
  shadow: boolean;
  video: boolean;
  contactSheet: boolean;
};

function Check({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 font-sans text-[12px] text-fg/85">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      {label}
    </label>
  );
}

/**
 * The Render sheet: which angles, which Duo poses, the background, and the
 * extras. Every image is filed to the proof drawer; nothing leaves the Mac.
 */
export function AppleRenderSheet({
  open,
  deviceName,
  duo,
  rendering,
  onClose,
  onRender,
}: {
  open: boolean;
  deviceName: string;
  duo: boolean;
  rendering: boolean;
  onClose: () => void;
  onRender: (request: AppleRenderRequest) => void;
}) {
  const [angles, setAngles] = useState<AppleRenderAngleId[]>(["front", "three-quarter-left"]);
  const [poses, setPoses] = useState<AppleDevicePose[]>(["closed", "tent", "laptop", "open"]);
  const [lighting, setLighting] = useState<AppleDeviceRenderLighting>("transparent");
  const [shadow, setShadow] = useState(true);
  const [video, setVideo] = useState(false);
  const [contactSheet, setContactSheet] = useState(true);
  const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? [...list, value] : list.filter((entry) => entry !== value));
  const imageCount = angles.length * (duo ? Math.max(1, poses.length) : 1);
  return (
    <Dialog
      open={open}
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
          onClick: () => onRender({ angles, poses: duo ? poses : [], lighting, shadow, video, contactSheet }),
          disabled: rendering || angles.length === 0 || (duo && poses.length === 0),
          variant: "primary",
          autoFocus: true,
        },
      ]}
    >
      <div className="flex flex-col gap-3 py-1">
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] uppercase tracking-[0.08em] text-muted-fg">Angles</span>
          <div className="flex flex-wrap gap-3">
            {APPLE_RENDER_ANGLES.map((angle) => (
              <Check
                key={angle.id}
                label={angle.label}
                checked={angles.includes(angle.id)}
                onChange={(on) => setAngles((current) => toggle(current, angle.id, on))}
              />
            ))}
          </div>
        </div>
        {duo ? (
          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-[11px] uppercase tracking-[0.08em] text-muted-fg">Poses (folds the simulator)</span>
            <div className="flex flex-wrap gap-3">
              {DUO_POSES.map((pose) => (
                <Check
                  key={pose.id}
                  label={pose.label}
                  checked={poses.includes(pose.id)}
                  onChange={(on) => setPoses((current) => toggle(current, pose.id, on))}
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] uppercase tracking-[0.08em] text-muted-fg">Background</span>
          <div className="flex flex-wrap gap-3">
            {(["transparent", "studio", "dusk"] as const).map((value) => (
              <label key={value} className="inline-flex cursor-pointer items-center gap-1.5 font-sans text-[12px] text-fg/85">
                <input type="radio" name="apple-render-lighting" checked={lighting === value} onChange={() => setLighting(value)} />
                {value === "transparent" ? "Transparent" : value === "studio" ? "Studio" : "Dusk"}
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

/** Tile labelled shots into one PNG, for PR descriptions. */
export async function appleRenderContactSheet(shots: Array<{ dataUrl: string; label: string }>): Promise<string | null> {
  if (!shots.length) return null;
  const images = await Promise.all(shots.map((shot) => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = shot.dataUrl;
  })));
  const columns = Math.min(3, images.length);
  const rows = Math.ceil(images.length / columns);
  const cell = 520;
  const label = 36;
  const canvas = document.createElement("canvas");
  canvas.width = columns * cell;
  canvas.height = rows * (cell + label);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#16161b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  images.forEach((image, index) => {
    const x = (index % columns) * cell;
    const y = Math.floor(index / columns) * (cell + label);
    const scale = Math.min(cell / image.width, cell / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, x + (cell - w) / 2, y + (cell - h) / 2, w, h);
    ctx.fillStyle = "#c9c9d2";
    ctx.font = "500 18px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(shots[index]!.label, x + cell / 2, y + cell + 24);
  });
  return canvas.toDataURL("image/png");
}
