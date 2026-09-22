import { Quaternion, Vector3 } from "three";

/** Recovered Bitrig / t3 #12787 feel. Keep these as the single source of orbit numbers. */
export const APPLE_DEVICE_ORBIT = {
  gain: 0.006,
  dragForceLimit: 1.2,
  gestureSpeedLimit: 7.5,
  springSpeedLimit: 9,
  predictionSeconds: 0.085,
  gestureVelocityBlend: 0.65,
  currentVelocityBlend: 0.35,
  response: 0.5,
  damping: 0.78,
  dragResponse: 0.68,
  dragDamping: 1.12,
  tickHz: 120,
  yawLimit: Math.PI / 3,
  settleAngle: 0.0005,
  settleSpeed: 0.005,
  inputPauseMs: 100,
  releaseQuietMs: 140,
} as const;

const TICK = 1 / APPLE_DEVICE_ORBIT.tickHz;
const RELEASE_OMEGA = (2 * Math.PI) / APPLE_DEVICE_ORBIT.response;
const DRAG_OMEGA = (2 * Math.PI) / APPLE_DEVICE_ORBIT.dragResponse;
const Y_AXIS = new Vector3(0, 1, 0);

function quatFromRotationVector(vector: Vector3): Quaternion {
  const angle = vector.length();
  if (angle < 1e-8) return new Quaternion();
  return new Quaternion().setFromAxisAngle(vector.clone().divideScalar(angle), angle);
}

/** Shortest rotation vector. q and −q are the same orientation. */
export function quatRotationVector(rotation: Quaternion): Vector3 {
  const q = rotation.clone().normalize();
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const length = Math.hypot(q.x, q.y, q.z);
  if (length < 1e-8) return new Vector3();
  return new Vector3(q.x, q.y, q.z).multiplyScalar((2 * Math.atan2(length, q.w)) / length);
}

function errorToward(target: Quaternion, current: Quaternion): Vector3 {
  return quatRotationVector(target.clone().multiply(current.clone().invert()));
}

/**
 * Latch to the front-facing pose, keeping nearby yaw so a small glance does not
 * slam the device back to dead-on.
 */
export function nearestScreenFacingRotation(
  rotation: Quaternion,
  yawLimit = APPLE_DEVICE_ORBIT.yawLimit,
): Quaternion {
  const relative = rotation.clone().normalize();
  const turn = 2 * Math.atan2(relative.y, relative.w);
  const wrapped = Math.atan2(Math.sin(turn), Math.cos(turn));
  const yaw = Math.max(-yawLimit, Math.min(yawLimit, wrapped));
  const candidate = new Quaternion().setFromAxisAngle(Y_AXIS, yaw);
  const flipped = relative.clone().set(-relative.x, -relative.y, -relative.z, -relative.w);
  const flippedTurn = 2 * Math.atan2(flipped.y, flipped.w);
  const flippedWrapped = Math.atan2(Math.sin(flippedTurn), Math.cos(flippedTurn));
  const flippedYaw = Math.max(-yawLimit, Math.min(yawLimit, flippedWrapped));
  const flippedCandidate = new Quaternion().setFromAxisAngle(Y_AXIS, flippedYaw);
  return flippedCandidate.angleTo(rotation) + 1e-8 < candidate.angleTo(rotation)
    ? flippedCandidate
    : candidate;
}

function integrateToward(
  rotation: Quaternion,
  velocity: Vector3,
  target: Quaternion,
  dt: number,
  options: { clampForce?: number; omega: number; damping: number; speedLimit: number },
): void {
  const error = errorToward(target, rotation);
  if (options.clampForce !== undefined) error.clampLength(0, options.clampForce);
  const acceleration = error
    .multiplyScalar(options.omega * options.omega)
    .addScaledVector(velocity, -2 * options.damping * options.omega);
  velocity.addScaledVector(acceleration, dt).clampLength(0, options.speedLimit);
  rotation.premultiply(quatFromRotationVector(velocity.clone().multiplyScalar(dt))).normalize();
}

export type AppleDeviceOrbit = {
  readonly rotation: Quaternion;
  setPose(next: Quaternion, now: number, immediate?: boolean): void;
  dragActive(active: boolean, now: number): void;
  orbit(deltaX: number, deltaY: number, now: number): void;
  hold(active: boolean, now: number): void;
  advance(now: number, reducedMotion?: boolean): boolean;
  needsFrame(): boolean;
  reset(next: Quaternion, now: number): void;
};

/**
 * Cumulative camera-space drag moves a spring target. Release predicts 85 ms
 * ahead and latches the nearest screen-facing view. Fixed 120 Hz ticks keep
 * the catch independent of display refresh.
 */
export function createAppleDeviceOrbit(
  options: { choose?: (rotation: Quaternion) => Quaternion } = {},
): AppleDeviceOrbit {
  const choose = options.choose ?? nearestScreenFacingRotation;
  const rotation = new Quaternion();
  const target = new Quaternion();
  const velocity = new Vector3();
  const gestureVelocity = new Vector3();
  let spring: { at: number; rotation: Quaternion; velocity: Vector3; steps: number } | null = null;
  let drag: {
    start: Quaternion;
    rest: Quaternion;
    x: number;
    y: number;
    error: Vector3;
    at: number;
  } | null = null;
  let pointer = false;
  let held = false;
  let interruptedDrag = false;
  let lastInput = -Infinity;

  const beginSpring = (next: Quaternion, now: number) => {
    target.copy(next).normalize();
    spring = {
      at: now,
      rotation: rotation.clone(),
      velocity: velocity.clone(),
      steps: 0,
    };
  };

  const release = (now: number) => {
    if (!drag) return;
    if (now - lastInput > APPLE_DEVICE_ORBIT.inputPauseMs) gestureVelocity.set(0, 0, 0);
    const prediction = target
      .clone()
      .premultiply(quatFromRotationVector(gestureVelocity.clone().multiplyScalar(APPLE_DEVICE_ORBIT.predictionSeconds)));
    velocity
      .multiplyScalar(APPLE_DEVICE_ORBIT.currentVelocityBlend)
      .addScaledVector(gestureVelocity, APPLE_DEVICE_ORBIT.gestureVelocityBlend)
      .clampLength(0, APPLE_DEVICE_ORBIT.springSpeedLimit);
    const moved = drag.x !== 0 || drag.y !== 0;
    const rest = drag.rest;
    drag = null;
    beginSpring(moved ? choose(prediction) : rest, now);
  };

  const beginDrag = (now: number) => {
    if (held || drag) return;
    advance(now);
    drag = {
      start: rotation.clone(),
      rest: target.clone(),
      x: 0,
      y: 0,
      error: new Vector3(),
      at: now,
    };
    target.copy(rotation);
    gestureVelocity.set(0, 0, 0);
    lastInput = -Infinity;
    spring = null;
  };

  const advance = (now: number, reducedMotion = false): boolean => {
    if (held || !Number.isFinite(now)) return false;
    if (drag && !pointer && now >= lastInput + APPLE_DEVICE_ORBIT.releaseQuietMs) {
      release(lastInput + APPLE_DEVICE_ORBIT.releaseQuietMs);
    }
    if (drag) {
      const seconds = Math.min(0.05, Math.max(0, (now - drag.at) / 1000));
      drag.at = now;
      const steps = Math.ceil(seconds * APPLE_DEVICE_ORBIT.tickHz);
      const dt = steps ? seconds / steps : 0;
      for (let step = 0; step < steps; step++) {
        const error = errorToward(target, rotation);
        if (error.lengthSq() > 1e-10) {
          const axis = error.clone().normalize();
          const turns = Math.round((drag.error.dot(axis) - error.length()) / (2 * Math.PI));
          error.addScaledVector(axis, turns * 2 * Math.PI);
        }
        drag.error.copy(error);
        error.clampLength(0, APPLE_DEVICE_ORBIT.dragForceLimit);
        const acceleration = error
          .multiplyScalar(DRAG_OMEGA * DRAG_OMEGA)
          .addScaledVector(velocity, -2 * APPLE_DEVICE_ORBIT.dragDamping * DRAG_OMEGA);
        velocity.addScaledVector(acceleration, dt).clampLength(0, APPLE_DEVICE_ORBIT.springSpeedLimit);
        rotation.premultiply(quatFromRotationVector(velocity.clone().multiplyScalar(dt))).normalize();
      }
      if (reducedMotion) rotation.copy(target);
      return steps > 0 || reducedMotion;
    }
    if (!spring) return false;
    const seconds = Math.max(0, (now - spring.at) / 1000);
    const steps = Math.min(240, Math.floor(seconds / TICK));
    const tick = (q: Quaternion, speed: Vector3, dt: number) => {
      integrateToward(q, speed, target, dt, {
        omega: RELEASE_OMEGA,
        damping: APPLE_DEVICE_ORBIT.damping,
        speedLimit: APPLE_DEVICE_ORBIT.springSpeedLimit,
      });
    };
    for (; spring.steps < steps; spring.steps++) tick(spring.rotation, spring.velocity, TICK);
    rotation.copy(spring.rotation);
    velocity.copy(spring.velocity);
    const nextRotation = spring.rotation.clone();
    const nextVelocity = spring.velocity.clone();
    tick(nextRotation, nextVelocity, TICK);
    const fraction = Math.min(1, (seconds - steps * TICK) / TICK);
    rotation.slerp(nextRotation, fraction);
    velocity.lerp(nextVelocity, fraction);
    if (
      reducedMotion
      || steps === 240
      || (rotation.angleTo(target) < APPLE_DEVICE_ORBIT.settleAngle && velocity.length() < APPLE_DEVICE_ORBIT.settleSpeed)
    ) {
      rotation.copy(target);
      velocity.set(0, 0, 0);
      spring = null;
    }
    return true;
  };

  return {
    rotation,
    setPose(next, now, immediate = false) {
      advance(now);
      drag = null;
      pointer = false;
      beginSpring(next, now);
      if (immediate) {
        rotation.copy(target);
        velocity.set(0, 0, 0);
        spring = null;
      }
    },
    dragActive(active, now) {
      if (active) {
        beginDrag(now);
        pointer = true;
      } else {
        advance(now);
        pointer = false;
        release(now);
      }
    },
    orbit(deltaX, deltaY, now) {
      if (held || ![deltaX, deltaY, now].every(Number.isFinite) || (!deltaX && !deltaY)) return;
      advance(now);
      beginDrag(now);
      if (!drag) return;
      const previous = target.clone();
      drag.x += deltaX;
      drag.y += deltaY;
      target
        .copy(quatFromRotationVector(new Vector3(drag.y * APPLE_DEVICE_ORBIT.gain, drag.x * APPLE_DEVICE_ORBIT.gain, 0)))
        .multiply(drag.start)
        .normalize();
      const seconds = (now - lastInput) / 1000;
      gestureVelocity.copy(errorToward(target, previous));
      if (seconds > 0 && seconds < 0.1) {
        gestureVelocity.divideScalar(seconds).clampLength(0, APPLE_DEVICE_ORBIT.gestureSpeedLimit);
      } else {
        gestureVelocity.set(0, 0, 0);
      }
      lastInput = now;
    },
    hold(active, now) {
      if (held === active) return;
      if (active) {
        interruptedDrag = drag !== null;
        drag = null;
        pointer = false;
        spring = null;
        velocity.set(0, 0, 0);
      }
      held = active;
      if (!active) {
        if (interruptedDrag) beginSpring(choose(target.clone()), now);
        else if (rotation.angleTo(target) > APPLE_DEVICE_ORBIT.settleAngle) beginSpring(target, now);
        interruptedDrag = false;
      }
    },
    advance,
    needsFrame() {
      return (
        !held
        && (spring !== null
          || (drag !== null
            && (!pointer
              || rotation.angleTo(target) > APPLE_DEVICE_ORBIT.settleAngle
              || velocity.length() > APPLE_DEVICE_ORBIT.settleSpeed)))
      );
    },
    reset(next, now) {
      advance(now);
      drag = null;
      pointer = false;
      beginSpring(next, now);
    },
  };
}
