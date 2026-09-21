import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import {
  APPLE_DEVICE_ORBIT,
  createAppleDeviceOrbit,
  nearestScreenFacingRotation,
  quatRotationVector,
} from "./appleDeviceOrbit";

function axisAngle(x: number, y: number, z = 0): Quaternion {
  const axis = new Vector3(x, y, z);
  const angle = axis.length();
  if (angle < 1e-8) return new Quaternion();
  return new Quaternion().setFromAxisAngle(axis.normalize(), angle);
}

describe("nearestScreenFacingRotation", () => {
  it("keeps a nearby yaw and treats opposite quaternion signs as the same pose", () => {
    const glanced = axisAngle(0, 0.4);
    const latched = nearestScreenFacingRotation(glanced);
    expect(latched.angleTo(glanced)).toBeLessThan(1e-6);
    const negated = glanced.clone().set(-glanced.x, -glanced.y, -glanced.z, -glanced.w);
    expect(nearestScreenFacingRotation(negated).angleTo(latched)).toBeLessThan(1e-6);
  });

  it("clamps yaw to the screen-facing window", () => {
    const spun = axisAngle(0, 3);
    const latched = nearestScreenFacingRotation(spun);
    expect(latched.angleTo(new Quaternion())).toBeLessThanOrEqual(APPLE_DEVICE_ORBIT.yawLimit + 1e-6);
  });
});

describe("createAppleDeviceOrbit", () => {
  it("follows a cumulative drag without teleporting, independent of event partitioning", () => {
    const run = (parts: number) => {
      const motion = createAppleDeviceOrbit({ choose: (q) => q });
      motion.dragActive(true, 0);
      for (let part = 0; part < parts; part++) motion.orbit(160 / parts, 80 / parts, 0);
      expect(motion.rotation.angleTo(new Quaternion())).toBeLessThan(1e-6);
      for (let time = 8; time <= 400; time += 8) motion.advance(time);
      expect(motion.rotation.angleTo(new Quaternion())).toBeGreaterThan(0.5);
      motion.dragActive(false, 400);
      for (let time = 408; time <= 2400; time += 8) motion.advance(time);
      expect(motion.needsFrame()).toBe(false);
      return motion.rotation.clone();
    };
    expect(run(1).angleTo(run(20))).toBeLessThan(1e-6);
  });

  it("latches the predicted nearest screen-facing view on release", () => {
    const motion = createAppleDeviceOrbit();
    motion.dragActive(true, 0);
    motion.orbit(0, 240, 0);
    motion.orbit(0, 20, 20);
    motion.dragActive(false, 40);
    for (let time = 56; time <= 2500; time += 16) motion.advance(time);
    expect(motion.needsFrame()).toBe(false);
    expect(motion.rotation.angleTo(new Quaternion())).toBeLessThanOrEqual(APPLE_DEVICE_ORBIT.yawLimit + 1e-5);
  });

  it("advances at the same pose across refresh rates", () => {
    const run = (step: number) => {
      const motion = createAppleDeviceOrbit({ choose: () => new Quaternion() });
      motion.dragActive(true, 0);
      motion.orbit(160, 80, 0);
      motion.advance(50);
      motion.dragActive(false, 50);
      for (let time = 50; time < 450; time += step) motion.advance(time);
      motion.advance(450);
      return motion;
    };
    const fast = run(8);
    const slow = run(33);
    const throttled = run(1000);
    expect(fast.rotation.angleTo(slow.rotation)).toBeLessThan(1e-6);
    expect(fast.rotation.angleTo(throttled.rotation)).toBeLessThan(1e-6);
  });

  it("keeps release angular speed within the spring limit", () => {
    const motion = createAppleDeviceOrbit({ choose: () => axisAngle(0, Math.PI) });
    motion.setPose(axisAngle(0, Math.PI), 0);
    let previous = motion.rotation.clone();
    const maxStep = APPLE_DEVICE_ORBIT.springSpeedLimit * 0.008 + 1e-5;
    for (let time = 8; time <= 1600; time += 8) {
      motion.advance(time);
      expect(motion.rotation.angleTo(previous)).toBeLessThanOrEqual(maxStep);
      previous = motion.rotation.clone();
    }
    expect(motion.rotation.angleTo(axisAngle(0, Math.PI))).toBeLessThan(1e-6);
    expect(motion.needsFrame()).toBe(false);
  });

  it("a click with no drag returns to the previous rest pose", () => {
    const motion = createAppleDeviceOrbit({ choose: () => new Quaternion() });
    const rest = axisAngle(0, 0.8);
    motion.setPose(rest, 0);
    motion.advance(50);
    motion.dragActive(true, 50);
    motion.advance(60);
    motion.dragActive(false, 60);
    motion.advance(2100);
    expect(motion.rotation.angleTo(rest)).toBeLessThan(1e-6);
    expect(motion.needsFrame()).toBe(false);
  });

  it("ignores invalid deltas and freezes while a screen contact is held", () => {
    const motion = createAppleDeviceOrbit({ choose: () => new Quaternion() });
    motion.orbit(NaN, 0, 0);
    expect(motion.needsFrame()).toBe(false);
    motion.orbit(200, 100, 0);
    motion.advance(100);
    expect(motion.rotation.angleTo(new Quaternion())).toBeGreaterThan(0);
    motion.hold(true, 120);
    const frozen = motion.rotation.clone();
    motion.orbit(80, 80, 200);
    motion.advance(800);
    expect(motion.rotation.angleTo(frozen)).toBeLessThan(1e-6);
    motion.hold(false, 800);
    motion.advance(2400);
    expect(motion.needsFrame()).toBe(false);
  });

  it("reports a π rotation vector around Y", () => {
    expect(quatRotationVector(axisAngle(0, Math.PI)).length()).toBeCloseTo(Math.PI);
  });
});
