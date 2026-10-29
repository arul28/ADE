/**
 * The iPhone Duo's articulated body, as pure math.
 *
 * The Duo is a foldable: two display halves joined by a hinge, where the
 * interior hinge angle runs from 0° (folded shut) to 180° (flat). ADE has no
 * Duo simulator runtime on this machine, so the 3D body is procedural rather
 * than a bundled GLB — and everything that decides *how* it folds (the stance
 * state machine, the panel rotations, the continuous inner-display coordinate
 * mapping, and the capability gate) lives here, away from three.js, so it can
 * be tested without a GPU or a device.
 *
 * Coordinate contract, shared with `appleDeviceScene`:
 * - The inner display is ONE continuous portrait canvas, width × height.
 * - The hinge is a horizontal line across its middle, at portrait y = 0.
 * - The upper half samples texture v ∈ [0.5, 1]; the lower half v ∈ [0, 0.5].
 * - `vFromBottom` is the continuous-canvas v in [0, 1], 0 at the bottom.
 */

import { appleDeviceTypeSupportsDuo } from "../../../shared/appleOrientation";
import { APPLE_DEVICE_POSE_TARGETS } from "../../../shared/types/iosSimulator";

export type AppleDuoStanceId = "open" | "laptop" | "book" | "tent" | "closed";

export type AppleDuoPose = {
  /** Interior hinge angle in degrees: 0 = folded shut, 180 = flat. */
  angle: number;
};

export type AppleDuoStance = {
  id: AppleDuoStanceId;
  label: string;
  angle: number;
};

export const APPLE_DUO_MIN_ANGLE = 0;
export const APPLE_DUO_MAX_ANGLE = 180;

/** How much one pinch unit (a 1× scale change) moves the hinge, in degrees. */
export const APPLE_DUO_PINCH_DEGREES_PER_SCALE = 120;

/** Nudge step for the rail's "Close/Open hinge" items. */
export const APPLE_DUO_NUDGE_DEGREES = 15;

/**
 * The named postures, in the order the control lists them. Open
 * and Closed are the extremes; every stance folds both halves the same way.
 */
export const APPLE_DUO_STANCES: readonly AppleDuoStance[] = [
  { id: "open", label: "Open", angle: APPLE_DEVICE_POSE_TARGETS.open.angle },
  // The simulator's own preset angles (APPLE_DEVICE_POSE_TARGETS): drawn at
  // anything else, the hinge jumped when the simulator's report landed.
  { id: "laptop", label: "Laptop", angle: APPLE_DEVICE_POSE_TARGETS.laptop.angle },
  // Book is Laptop's angle held upright: the simulator tells them apart by
  // how the phone is held, not by the hinge.
  { id: "book", label: "Book", angle: APPLE_DEVICE_POSE_TARGETS.book.angle },
  { id: "tent", label: "Tent", angle: APPLE_DEVICE_POSE_TARGETS.tent.angle },
  { id: "closed", label: "Closed", angle: APPLE_DEVICE_POSE_TARGETS.closed.angle },
];

export function clampAppleDuoAngle(angle: number): number {
  if (!Number.isFinite(angle)) return APPLE_DUO_MAX_ANGLE;
  return Math.min(APPLE_DUO_MAX_ANGLE, Math.max(APPLE_DUO_MIN_ANGLE, angle));
}

/** A reported hinge this close to the drawn one is the same fold, not a move. */
const APPLE_DUO_SAME_HINGE_DEGREES = 2;

export function appleDuoSameHinge(a: number, b: number): boolean {
  return Math.abs(a - b) <= APPLE_DUO_SAME_HINGE_DEGREES;
}

export function appleDuoStance(id: AppleDuoStanceId): AppleDuoStance {
  return APPLE_DUO_STANCES.find((stance) => stance.id === id) ?? APPLE_DUO_STANCES[0]!;
}

export function appleDuoPoseForStance(id: AppleDuoStanceId): AppleDuoPose {
  return { angle: appleDuoStance(id).angle };
}

export function appleDuoPoseForAngle(angle: number): AppleDuoPose {
  return { angle: clampAppleDuoAngle(angle) };
}

/**
 * The named posture the phone is in, from what the simulator reports.
 *
 * Tent is its own Table Mode. Otherwise the angle picks the nearest of
 * Closed, the 90° fold and Open (a custom angle reads as its closest label),
 * and how the phone is held tells the two 90° poses apart: sideways is a
 * laptop, upright a book. Without a report of the hold, the 90° fold reads as
 * Laptop.
 */
export function appleDuoStanceFor(input: {
  angle: number;
  held: "portrait" | "landscape" | null;
  tableMode: boolean;
}): AppleDuoStanceId {
  if (input.tableMode) return "tent";
  const angle = clampAppleDuoAngle(input.angle);
  const fold = APPLE_DEVICE_POSE_TARGETS.laptop.angle;
  const toFold = Math.abs(angle - fold);
  if (toFold > Math.abs(angle - APPLE_DEVICE_POSE_TARGETS.open.angle)) return "open";
  if (toFold > Math.abs(angle - APPLE_DEVICE_POSE_TARGETS.closed.angle)) return "closed";
  return input.held === "portrait" ? "book" : "laptop";
}

/**
 * How far each half rotates about the hinge, in degrees.
 *
 * Positive upper rotation and negative lower rotation both bring the panels'
 * faces toward the viewer (+Z), so at 90° each the two halves meet and the
 * device is shut. The drawn hinge is the angle alone: every posture folds
 * both halves the same way.
 */
export function appleDuoPanelRotationsDeg(pose: AppleDuoPose): { upper: number; lower: number } {
  const angle = clampAppleDuoAngle(pose.angle);
  const fold = (APPLE_DUO_MAX_ANGLE - angle) / 2;
  return { upper: fold, lower: fold === 0 ? 0 : -fold };
}

/** The texture v-range each half samples in the continuous inner canvas. */
export const APPLE_DUO_PANEL_V_RANGES = {
  upper: { min: 0.5, max: 1 },
  lower: { min: 0, max: 0.5 },
} as const;

export type AppleDuoPanelId = keyof typeof APPLE_DUO_PANEL_V_RANGES;

/** Which half a point on the continuous inner canvas lands on. */
export function appleDuoPanelForInnerPoint(vFromBottom: number): AppleDuoPanelId {
  return vFromBottom >= 0.5 ? "upper" : "lower";
}

/** The hinge angle after a pinch, clamped. `toScale / fromScale` is the gesture ratio. */
export function appleDuoHingeAfterPinch(input: {
  angle: number;
  fromScale: number;
  toScale: number;
}): number {
  if (!Number.isFinite(input.fromScale) || !Number.isFinite(input.toScale) || input.fromScale <= 0) {
    return clampAppleDuoAngle(input.angle);
  }
  const delta = (input.toScale - input.fromScale) * APPLE_DUO_PINCH_DEGREES_PER_SCALE;
  return clampAppleDuoAngle(input.angle + delta);
}

/**
 * The foldable capability gate.
 *
 * ADE's installed-simulator record carries Apple's CoreSimulator type
 * identifier (preferred) and the user-editable name. A Duo reports `Duo` in
 * one of them; a future foldable may report `Fold`. A device that matches
 * neither is not foldable and the whole mode must stay off — the caller passes
 * no `duo` prop, and nothing in the 3D path does any Duo work.
 *
 * NOTE: this matcher is written from Apple's naming convention, not observed on
 * a real Duo runtime (this machine has none). It is deliberately narrow so a
 * false positive is unlikely; if a real Duo reports a different identifier this
 * is the one line to widen.
 */
export function appleDeviceSupportsDuo(input: {
  deviceTypeIdentifier?: string | null;
  deviceTypeName?: string | null;
}): boolean {
  const name = (input.deviceTypeName ?? "").trim();
  return appleDeviceTypeSupportsDuo(input.deviceTypeIdentifier)
    || /(^|[^a-z])duo([^a-z]|$)/i.test(name);
}

/* ── The control state machine ──────────────────────────────────────────── */

export type AppleDuoState = {
  pose: AppleDuoPose;
};

export type AppleDuoAction =
  /** Jump to a named posture. */
  | { type: "stance"; stance: AppleDuoStanceId }
  /** Set a custom angle. */
  | { type: "angle"; angle: number }
  /** Step the angle by a signed number of degrees. */
  | { type: "nudge"; delta: number };

export function createAppleDuoState(): AppleDuoState {
  return { pose: appleDuoPoseForStance("open") };
}

export function reduceAppleDuoState(state: AppleDuoState, action: AppleDuoAction): AppleDuoState {
  switch (action.type) {
    case "stance":
      return { pose: appleDuoPoseForStance(action.stance) };
    case "angle":
      return { pose: appleDuoPoseForAngle(action.angle) };
    case "nudge":
      return { pose: appleDuoPoseForAngle(state.pose.angle + action.delta) };
  }
}
