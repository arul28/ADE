import { useCallback, useMemo } from "react";
import type { Group } from "three";
import type { AppleDeviceOrientation } from "../../../shared/types";
import {
  Device3DView,
  deviceDragIntent,
  deviceWheelIntent,
  type Device3DFailure,
  type Device3DViewProps,
  type DeviceBodySource,
} from "../device/Device3DView";
import { loadDeviceModelInstance } from "../device/deviceModelLoader";
import { createImportedBody, disposeImportedSubtree, type DeviceBody } from "../device/deviceScene";
import { appleDeviceModel, type AppleDeviceBodyModelId } from "./appleDeviceModels";
import { appleDuoHingeAfterPinch } from "./appleDuo";
import { createProceduralDuoBody } from "./appleDuoScene";
import { createV68DuoBody } from "./appleV68DuoBody";
import type { AppleFrameFeed } from "./useAppleDeviceStream";

/*
 * The Apple device in 3D: the shared `device/Device3DView` with the Apple
 * bodies (the bundled iPhone and iPad GLBs, and the iPhone Duo). The viewer
 * itself moved to the shared device layer when Android first used it
 * (plan §4); this file keeps every Apple name its callers use.
 */

export type AppleDeviceFamily = "iphone" | "ipad";

/**
 * The foldable controls for the procedural Duo body.
 *
 * The caller capability-gates this: it passes a `duo` prop ONLY for a device
 * that reports fold/dual-screen support, so a non-foldable device takes the
 * unchanged GLB path and does no Duo work at all. When absent, the viewer never
 * builds or touches the articulated body.
 */
export type AppleDeviceDuoProps = {
  enabled: boolean;
  /** Interior hinge angle in degrees: 0 folded shut, 180 flat. */
  angle: number;
  /** A pinch on the glass adjusts the hinge (only while enabled). */
  onHingeChange?: ((angle: number) => void) | undefined;
  /**
   * Apple's Duo model, prepared (`loadDuoModel`). Null while it loads or when
   * this Xcode has none, and the drawn body stands in.
   */
  model?: Group | null | undefined;
  /** The panel that is on (1 cover, 3 inner); only Apple's model shows the cover. */
  activeScreenId?: number | null | undefined;
  /** How the phone is held (`portrait`, `landscape-left`, …), as the simulator reports it. */
  physicalOrientation?: string | null | undefined;
  /** Tent's Table Mode: the phone stands on its edges. */
  tableMode?: boolean | null | undefined;
};

/** The model id a procedural Duo body reports. */
const DUO_MODEL_KEY = "duo-procedural" as const;
/** The model id of the body on Apple's own model. */
const DUO_V68_MODEL_KEY = "duo-v68" as const;

export type AppleDevice3DFailure = Device3DFailure;

/** §A3's drag rule; see `deviceDragIntent`. */
export const appleDragIntent = deviceDragIntent;
/** §A3's wheel rule; see `deviceWheelIntent`. */
export const appleWheelIntent = deviceWheelIntent;

export type AppleDevice3DViewProps = Omit<
  Device3DViewProps,
  "bodySource" | "ariaLabel" | "onPinchScale" | "animateRotation" | "onReady" | "frames" | "orientation"
> & {
  frames: AppleFrameFeed | null;
  family: AppleDeviceFamily;
  /** Product hint from the simulator device type, e.g. "iPhone 17 Pro"; the model map picks the closest body. */
  deviceTypeName: string | null;
  /**
   * `com.apple.CoreSimulator.SimDeviceType.…` for this device, when known.
   *
   * Preferred over `deviceTypeName` because a simulator's NAME is whatever a
   * person typed, and ADE names its clones after the lane — so a real Pro Max
   * in a lane used to render on the smaller Pro body.
   */
  deviceTypeIdentifier?: string | null;
  orientation: AppleDeviceOrientation;
  /**
   * The foldable body controls. Present ONLY for a device the caller has proven
   * folds; absent everywhere else, so the imported GLB path is byte-for-byte
   * unchanged and does no extra per-frame work.
   */
  duo?: AppleDeviceDuoProps | undefined;
  /** The real body is on screen. */
  onReady?: ((info: { modelId: AppleDeviceBodyModelId }) => void) | undefined;
};

export function AppleDevice3DView({
  family,
  deviceTypeName,
  deviceTypeIdentifier,
  duo,
  onReady,
  ...rest
}: AppleDevice3DViewProps) {
  const duoEnabled = duo?.enabled === true;
  const duoModel = duo?.model ?? null;
  const duoAngle = duo?.angle ?? 180;
  const duoActive = duo?.activeScreenId ?? null;
  const duoPhysical = duo?.physicalOrientation ?? null;
  const duoTable = duo?.tableMode === true;

  const bodySource = useMemo<DeviceBodySource>(() => {
    if (duoEnabled) {
      // Capability-gated by the caller: only a device that folds reaches here.
      return {
        key: duoModel ? DUO_V68_MODEL_KEY : DUO_MODEL_KEY,
        build: ({ THREE, texture, layout }) => {
          if (duoModel) {
            try {
              const v68 = createV68DuoBody(THREE, { model: duoModel, texture, angle: duoAngle, activeScreenId: duoActive });
              v68.duo?.setPhysicalOrientation?.(duoPhysical, duoTable);
              return v68;
            } catch {
              // A changed Xcode model: the drawn body below still works.
            }
          }
          return createProceduralDuoBody(THREE, {
            innerAspect: layout.aspect,
            texture,
            layout,
            pose: { angle: duoAngle },
          });
        },
        update: (body: DeviceBody) => {
          if (!body.duo) return false;
          body.duo.setHinge(duoAngle);
          body.duo.setActivePanel?.(duoActive);
          body.duo.setPhysicalOrientation?.(duoPhysical, duoTable);
          // Folding changes the phone's shape: frame it again.
          return true;
        },
      };
    }
    const source = appleDeviceModel(family, {
      deviceTypeIdentifier: deviceTypeIdentifier ?? null,
      deviceTypeName,
    });
    return {
      key: source.id,
      build: async ({ THREE, GLTFLoader, texture, layout }) => {
        const scene = await loadDeviceModelInstance(source, THREE, GLTFLoader);
        const imported = createImportedBody(THREE, scene, source, texture, layout);
        if (!imported) disposeImportedSubtree(scene, texture);
        return imported;
      },
    };
  }, [deviceTypeIdentifier, deviceTypeName, duoActive, duoAngle, duoEnabled, duoModel, duoPhysical, duoTable, family]);

  const onHingeChange = duo?.onHingeChange;
  const onPinchScale = useCallback((fromScale: number, toScale: number): boolean => {
    // Pinch is the hinge, not the camera, once the device folds.
    if (!duoEnabled || !onHingeChange) return false;
    onHingeChange(appleDuoHingeAfterPinch({ angle: duoAngle, fromScale, toScale }));
    return true;
  }, [duoAngle, duoEnabled, onHingeChange]);

  const handleReady = useCallback((info: { modelId: string }) => {
    onReady?.({ modelId: info.modelId as AppleDeviceBodyModelId });
  }, [onReady]);

  return (
    <Device3DView
      {...rest}
      bodySource={bodySource}
      ariaLabel="iOS Simulator screen"
      onPinchScale={onPinchScale}
      onReady={handleReady}
    />
  );
}
