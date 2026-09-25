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

export type AppleDuoStanceId = "open" | "laptop" | "tent" | "closed";

export type AppleDuoPose = {
  /** Interior hinge angle in degrees: 0 = folded shut, 180 = flat. */
  angle: number;
  /**
   * True when the lower half stays flat on the surface and only the upper half
   * hinges up — the "laptop" posture. False folds both halves symmetrically.
   */
  lowerFlat: boolean;
};

export type AppleDuoStance = {
  id: AppleDuoStanceId;
  label: string;
  angle: number;
  lowerFlat: boolean;
};

export const APPLE_DUO_MIN_ANGLE = 0;
export const APPLE_DUO_MAX_ANGLE = 180;

/** How much one pinch unit (a 1× scale change) moves the hinge, in degrees. */
export const APPLE_DUO_PINCH_DEGREES_PER_SCALE = 120;

/** Nudge step for the rail's "Close/Open hinge" items. */
export const APPLE_DUO_NUDGE_DEGREES = 15;

/**
 * The named postures t3code ships, in the order the control lists them. Open
 * and Closed are the extremes; Tent is symmetric; Laptop rests on a flat base.
 */
export const APPLE_DUO_STANCES: readonly AppleDuoStance[] = [
  { id: "open", label: "Open", angle: 180, lowerFlat: false },
  { id: "laptop", label: "Laptop", angle: 105, lowerFlat: true },
  { id: "tent", label: "Tent", angle: 70, lowerFlat: false },
  { id: "closed", label: "Closed", angle: 0, lowerFlat: false },
];

export function clampAppleDuoAngle(angle: number): number {
  if (!Number.isFinite(angle)) return APPLE_DUO_MAX_ANGLE;
  return Math.min(APPLE_DUO_MAX_ANGLE, Math.max(APPLE_DUO_MIN_ANGLE, angle));
}

export function appleDuoStance(id: AppleDuoStanceId): AppleDuoStance {
  return APPLE_DUO_STANCES.find((stance) => stance.id === id) ?? APPLE_DUO_STANCES[0]!;
}

export function appleDuoPoseForStance(id: AppleDuoStanceId): AppleDuoPose {
  const stance = appleDuoStance(id);
  return { angle: stance.angle, lowerFlat: stance.lowerFlat };
}

export function appleDuoPoseForAngle(angle: number, lowerFlat = false): AppleDuoPose {
  return { angle: clampAppleDuoAngle(angle), lowerFlat };
}

/**
 * Which named posture this angle is nearest to.
 *
 * Used only to light the checked item in the stance menu; a custom angle still
 * reads as the closest label, which is the honest thing to show when the
 * slider sits between two presets.
 */
export function nearestAppleDuoStance(angle: number): AppleDuoStanceId {
  let best: AppleDuoStance = APPLE_DUO_STANCES[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const stance of APPLE_DUO_STANCES) {
    const distance = Math.abs(stance.angle - angle);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = stance;
    }
  }
  return best.id;
}

/**
 * How far each half rotates about the hinge, in degrees.
 *
 * Positive upper rotation and negative lower rotation both bring the panels'
 * faces toward the viewer (+Z), so at 90° each the two halves meet and the
 * device is shut. A flat base (`lowerFlat`) leaves the lower half at 0 and only
 * tilts the upper half by `180 - angle`.
 */
export function appleDuoPanelRotationsDeg(pose: AppleDuoPose): { upper: number; lower: number } {
  const angle = clampAppleDuoAngle(pose.angle);
  if (pose.lowerFlat) {
    return { upper: APPLE_DUO_MAX_ANGLE - angle, lower: 0 };
  }
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
  const identifier = (input.deviceTypeIdentifier ?? "").trim();
  const name = (input.deviceTypeName ?? "").trim();
  return /(^|[^a-z])duo([^a-z]|$)/i.test(identifier)
    || /(^|[^a-z])duo([^a-z]|$)/i.test(name)
    || /fold/i.test(identifier);
}

/* ── The control state machine ──────────────────────────────────────────── */

export type AppleDuoState = {
  pose: AppleDuoPose;
};

export type AppleDuoAction =
  /** Jump to a named posture. */
  | { type: "stance"; stance: AppleDuoStanceId }
  /** Set a custom angle; clears the flat base. */
  | { type: "angle"; angle: number }
  /** Step the angle by a signed number of degrees, keeping the flat base. */
  | { type: "nudge"; delta: number };

export function createAppleDuoState(): AppleDuoState {
  return { pose: appleDuoPoseForStance("open") };
}

export function reduceAppleDuoState(state: AppleDuoState, action: AppleDuoAction): AppleDuoState {
  switch (action.type) {
    case "stance":
      return { pose: appleDuoPoseForStance(action.stance) };
    case "angle":
      return { pose: appleDuoPoseForAngle(action.angle, false) };
    case "nudge":
      return {
        pose: appleDuoPoseForAngle(state.pose.angle + action.delta, state.pose.lowerFlat),
      };
  }
}
