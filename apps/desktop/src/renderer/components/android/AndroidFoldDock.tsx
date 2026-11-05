import {
  ANDROID_FOLD_POSE_ANGLES,
  type AndroidFoldPose,
  type AndroidPosture,
} from "../../../shared/types/androidEmulator";
import { HingeSlider, type HingeDetent } from "../device/HingeSlider";

/**
 * A foldable emulator's hinge, docked under the device (P3 fold), as the
 * iPhone Duo's dock (`AppleDuoDock`).
 *
 * - **3D:** the hinge slider. A drag folds the drawn body under the pointer;
 *   the release folds the emulator, and Android swaps the screen (the cover
 *   screen below 30°, the inner one above). Pinch on the body does the same.
 * - **Flat:** there is no body to fold, so the three folds are buttons.
 *
 * The readout on the right is what the emulator reports.
 */

const DETENTS: readonly HingeDetent[] = [
  { angle: ANDROID_FOLD_POSE_ANGLES.closed, label: "Closed" },
  { angle: ANDROID_FOLD_POSE_ANGLES.half, label: "Half" },
  { angle: ANDROID_FOLD_POSE_ANGLES.open, label: "Open" },
];

const POSES: ReadonlyArray<{ pose: AndroidFoldPose; label: string; title: string }> = [
  { pose: "closed", label: "Closed", title: "Fold the phone shut: the cover screen shows" },
  { pose: "half", label: "Half", title: "Fold the phone half open (90°): tabletop or book" },
  { pose: "open", label: "Open", title: "Unfold the phone flat: the inner screen shows" },
];

const STATE_LABELS: Record<NonNullable<AndroidPosture["state"]>, string> = {
  closed: "closed · cover screen",
  "half-open": "half open · inner screen",
  open: "open · inner screen",
};

export function AndroidFoldDock({
  mode,
  angle,
  posture,
  busy,
  onPreview,
  onCommit,
}: {
  mode: "flat" | "3d";
  /** The angle the body shows. */
  angle: number;
  posture: AndroidPosture | null;
  busy: boolean;
  onPreview: (angle: number) => void;
  onCommit: (angle: number) => void;
}) {
  const readout = posture
    ? [
      posture.angle !== null ? `${Math.round(posture.angle)}°` : null,
      busy ? "folding…" : posture.state ? STATE_LABELS[posture.state] : null,
    ].filter(Boolean).join(" · ")
    : "";
  const pressed = (pose: AndroidFoldPose) => posture?.angle === ANDROID_FOLD_POSE_ANGLES[pose];
  return (
    <div
      data-android-fold-dock=""
      className="relative shrink-0 border-t border-[color:var(--kit-rule)] bg-[color:var(--kit-card-bg)] pr-14"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-h-12 flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4 py-2">
        <div role="group" aria-label="Hinge" className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="kit-eyebrow shrink-0">Hinge</span>
          {mode === "3d" ? (
            <HingeSlider angle={angle} detents={DETENTS} onPreview={onPreview} onCommit={(next) => onCommit(next)} />
          ) : (
            <div className="kit-seg" data-case="sentence">
              {POSES.map(({ pose, label, title }) => (
                <button
                  key={pose}
                  type="button"
                  aria-pressed={pressed(pose)}
                  title={title}
                  disabled={busy}
                  onClick={() => onCommit(ANDROID_FOLD_POSE_ANGLES[pose])}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {readout ? (
          <span title="What the emulator reports" className="kit-num hidden shrink-0 text-[10.5px] text-[var(--kit-text-3)] @[520px]:inline">
            {readout}
          </span>
        ) : null}
      </div>
    </div>
  );
}
