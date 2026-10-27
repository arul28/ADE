// Portions adapted from T3 Code (https://github.com/pingdotgg/t3code),
// MIT License, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// Adapted: the phone scene and the trackpad rule that ctrl-wheel and pinch
// are camera zoom while a plain wheel is the DEVICE's scroll. The body and display live in `appleDeviceScene.ts`.
import type { AppleRenderLighting } from "../../../shared/types/iosSimulator";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CanvasTexture, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3 } from "three";
import type { AppleDeviceOrientation } from "../../../shared/types";
import { cn } from "../ui/cn";
import { appleDeviceModel, type AppleDeviceModelSource } from "./appleDeviceModels";
import { appleEaseFactor, createAppleDeviceOrbit, type AppleDeviceOrbit } from "./appleDeviceOrbit";
import { loadAppleDeviceModelInstance } from "./appleDeviceModelLoader";
import { appleDuoHingeAfterPinch } from "./appleDuo";
import { createProceduralDuoBody } from "./appleDuoScene";
import { createV68DuoBody } from "./appleV68DuoBody";
import {
  appleDeviceInputSize,
  createImportedBody,
  disposeImportedSubtree,
  displayLayout,
  importThreeRuntime,
  orientedPointSize,
  orientedToPortrait,
  portraitToOriented,
  type AppleDeviceBodyModelId,
  type DeviceBody,
  type GltfLoaderCtor,
  type ThreeNS,
} from "./appleDeviceScene";

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

/** Why the 3D presenter cannot show this device, in a sentence the strip can print. */
export type AppleDevice3DFailure =
  | "The 3D body could not be loaded."
  | "3D view needs WebGL, which this window does not have.";

export type AppleDevice3DViewProps = {
  /** The decoded device screen. The stage draws every frame into this canvas; the view samples it as a texture. */
  screenCanvas: HTMLCanvasElement | null;
  /** Increments once per drawn frame; the view re-uploads the texture when it changes and otherwise renders only on interaction. */
  frameVersion: number;
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
  /** Decoded frame size in PIXELS — the texture's own aspect. */
  screenPixelSize: { width: number; height: number };
  /**
   * Device size in POINTS, which is the coordinate space the simulator's input
   * and its accessibility frames are both in. Null falls back to pixels.
   */
  devicePointSize: { width: number; height: number } | null;
  interactive: boolean;
  /**
   * The foldable body controls. Present ONLY for a device the caller has proven
   * folds; absent everywhere else, so the imported GLB path is byte-for-byte
   * unchanged and does no extra per-frame work.
   */
  duo?: AppleDeviceDuoProps | undefined;
  /** Set to the viewer's render methods while it is mounted. */
  rendererRef?: { current: AppleDeviceRenderer | null } | undefined;
  /**
   * Bumped by "Reset view". Handled IN PLACE — the round-3 stage remounted the
   * whole view for this, and a remount means a new `WebGLRenderer` and a new
   * GPU context every time. Browsers cap live contexts (Chromium at 16) and
   * drop the oldest to make room, so a pane you reset a dozen times started
   * losing the context it was still drawing on.
   */
  resetNonce: number;
  onDeviceInput: (input: { phase: "begin" | "move" | "end"; x: number; y: number }) => void;
  /** A wheel over the SCREEN is the device's scroll, in device points (§A3). */
  onDeviceScroll?: ((delta: { x: number; y: number; deltaX: number; deltaY: number }) => void) | undefined;
  /** A key pressed while the 3D surface holds focus. True = forwarded. */
  onDeviceKey?: ((event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => boolean) | undefined;
  /** The real body is on screen. */
  onReady?: ((info: { modelId: AppleDeviceBodyModelId }) => void) | undefined;
  /**
   * There will be no 3D device (§A1). The pane falls back to the flat view and
   * says this once; the view NEVER substitutes a procedural slab.
   */
  onUnavailable?: ((reason: AppleDevice3DFailure) => void) | undefined;
  /**
   * Drawn over the canvas — the live inspect overlay. The argument is the
   * device-point → canvas-pixel projection, or null while there is nothing to
   * project against (no body yet).
   */
  renderScreenOverlay?: ((
    deviceToView: ((point: { x: number; y: number }) => { x: number; y: number }) | null,
  ) => ReactNode) | undefined;
  className?: string;
};

type ScreenHit = { x: number; y: number };

const ZOOM_MIN = Math.log(0.55);
const ZOOM_MAX = Math.log(2.4);
const CAMERA_FOV = 32;
/** The overlay re-projects at most this often while the body is still moving. */
const POSE_NOTIFY_MS = 90;
/** How long a lost context has to come back before the pane gives up on 3D. */
const CONTEXT_RESTORE_MS = 2_000;
/**
 * The screen texture's longer side, in pixels: as many as the view can show
 * the screen at (its longer side in device pixels; a render's whole canvas),
 * never fewer than the floor and never more than the cap. A fixed 512 wide
 * was soft on a Retina pane, and halved again across the Duo's two halves;
 * a whole 3× frame is still more upload than any pane shows.
 */
const MIRROR_MIN_LONG_SIDE = 512;
const MIRROR_MAX_LONG_SIDE = 1600;

/**
 * §A3's one rule for a drag in 3D: on the glass it is the DEVICE's, off the
 * glass it turns the body, and Alt always turns the body.
 *
 * Pure because it is the whole behaviour: the raycast that answers `onScreen`
 * needs a GPU, but what we do with the answer must be checkable without one.
 */
export function appleDragIntent(input: {
  onScreen: boolean;
  altKey: boolean;
  interactive: boolean;
}): "input" | "orbit" {
  if (!input.interactive || input.altKey || !input.onScreen) return "orbit";
  return "input";
}

/**
 * §A3's wheel rule (adapted, see the file header): ctrl (or cmd)
 * plus wheel, and the Safari pinch gesture, are the CAMERA's zoom; a plain
 * wheel over the glass is the DEVICE's scroll. Round 3 sent every wheel to the
 * camera, so nothing on the simulator could be scrolled in 3D at all.
 */
export function appleWheelIntent(input: {
  ctrlKey: boolean;
  metaKey: boolean;
  onScreen: boolean;
  interactive: boolean;
}): "zoom" | "scroll" {
  if (input.ctrlKey || input.metaKey) return "zoom";
  return input.onScreen && input.interactive ? "scroll" : "zoom";
}

function reducedMotionPreferred(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

type ViewerHooks = {
  /** The body moved: anything projected onto it has to be re-measured. */
  onPose: () => void;
  onReady: (info: { modelId: AppleDeviceBodyModelId }) => void;
  onUnavailable: (reason: AppleDevice3DFailure) => void;
};

/** One render angle: yaw/pitch in radians, or the camera exactly as the person left it. */
export type AppleDeviceRenderShot = { yaw: number; pitch: number } | { current: true };


export type AppleDeviceRenderOptions = {
  width: number;
  height: number;
  lighting: AppleRenderLighting;
  /** A soft contact shadow under the phone. */
  shadow: boolean;
};

/** What the pane drives renders through; set while a 3D view is mounted. */
export type AppleDeviceRenderer = Pick<Viewer, "renderShots" | "renderTurntable">;

type Viewer = {
  sync(props: AppleDevice3DViewProps): void;
  resize(width: number, height: number, pixelRatio: number): void;
  pointerDown(nx: number, ny: number, now: number, forceOrbit: boolean): "input" | "orbit" | "none";
  pointerMove(nx: number, ny: number, dx: number, dy: number, now: number): void;
  pointerUp(nx: number, ny: number, now: number): void;
  /** The device point under the pointer, or null when the pointer is off the screen. */
  screenPointAt(nx: number, ny: number): ScreenHit | null;
  /** A device point, projected to canvas-local CSS pixels. Null with no body. */
  projectDevicePoint(point: { x: number; y: number }): { x: number; y: number } | null;
  zoomBy(logDelta: number): void;
  /** "Reset view": back to the rest pose and the default zoom, same renderer. */
  resetView(now: number): void;
  cancelGestures(now: number): void;
  /** Stills of the body at camera presets, as PNG data URLs. */
  renderShots(shots: AppleDeviceRenderShot[], options: AppleDeviceRenderOptions): string[];
  /** A turntable of the body, recorded as WebM. Null when the window cannot record. */
  renderTurntable(options: AppleDeviceRenderOptions & { seconds: number }): Promise<Blob | null>;
  dispose(): void;
};

function createViewer(
  THREE: ThreeNS,
  GLTFLoader: GltfLoaderCtor,
  canvas: HTMLCanvasElement,
  initial: AppleDevice3DViewProps,
  getProps: () => AppleDevice3DViewProps,
  hooks: ViewerHooks,
): Viewer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene: Scene = new THREE.Scene();
  // Near 0.1 with far 40 spends almost the whole depth buffer on the first
  // centimetre in front of the lens; the body lives at ~5 units, where the
  // remaining precision could not separate the display from its cover glass.
  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 40);
  camera.position.z = 5.5;
  scene.add(new THREE.AmbientLight(0xffffff, 2.3));
  const key = new THREE.DirectionalLight(0xe4edff, 4.6);
  key.position.set(-3, 4, 5);
  const rim = new THREE.DirectionalLight(0xffffff, 3.4);
  rim.position.set(3, 1, -3);
  const fill = new THREE.DirectionalLight(0x9facd4, 1.8);
  fill.position.set(-2, -2, -4);
  scene.add(key, rim, fill);

  const rest = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.035, -0.12, 0, "YXZ"));
  // Free orbit: a drag leaves the phone where it was let go (coasting on its
  // release speed), never latched back to a front-facing view. "Reset view"
  // is how you get the rest pose back.
  const motion: AppleDeviceOrbit = createAppleDeviceOrbit({ choose: (rotation) => rotation });
  motion.setPose(rest, performance.now(), true);

  let texture: CanvasTexture | null = null;
  /**
   * The decoder's canvas, and our own copy of it.
   *
   * WebGL is handed the COPY, never the decoder's canvas directly. Uploading
   * the decoder's canvas worked for the first frame after a mount and then
   * returned black for every frame after it, whatever the element's position,
   * size or opacity — its backing store still answered `getImageData`, so the
   * frames were always there; they just would not come back out through
   * `texImage2D`. A plain detached canvas has none of that coupling: it is a
   * bitmap, it is blitted once per drawn frame, and the upload reads what the
   * blit just wrote.
   */
  let source: HTMLCanvasElement | null = null;
  let mirror: HTMLCanvasElement | null = null;
  let mirrorContext: CanvasRenderingContext2D | null = null;
  let layout = displayLayout(initial.orientation, initial.screenPixelSize, initial.screenCanvas);
  /** Null until the real body is on screen. There is no procedural fallback (§A1). */
  let body: DeviceBody | null = null;

  let disposed = false;
  let raf = 0;
  let zoomLog = 0;
  let fitDistance = 5.5;
  /**
   * The distance actually drawn. A fold changes the phone's shape and so the
   * fit; jumping to each new fit pumped the zoom on every hinge step, so the
   * drawn distance eases to it instead. Zero until the first fit.
   */
  let shownDistance = 0;
  let lastDistanceAt = 0;
  let viewport = { width: 0, height: 0, pixelRatio: 1 };
  let drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };
  let pointerMode: "input" | "orbit" | null = null;
  /** Where the touch in progress last was, so a cancel ends it there. */
  let lastInputHit: ScreenHit | null = null;
  let loadGen = 0;
  let currentModelKey = "";
  let lastFrameVersion = Number.NaN;
  let lastCanvas: HTMLCanvasElement | null = null;
  let lastPoseNotice = 0;
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set by anything that MOVES the body, and by nothing else.
   *
   * Without it the notice fires once per drawn frame — 30 times a second over
   * a live stream — and re-projects an inspect overlay that has not moved a
   * pixel. A new texture is not a new pose.
   */
  let poseDirty = false;

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const localHit = new THREE.Vector3();
  const projected: Vector3 = new THREE.Vector3();

  const notifyPose = (force: boolean) => {
    if (!poseDirty) return;
    const now = performance.now();
    if (!force && now - lastPoseNotice < POSE_NOTIFY_MS) return;
    lastPoseNotice = now;
    poseDirty = false;
    hooks.onPose();
  };

  const applyPose = () => {
    if (!body) return;
    body.root.quaternion.copy(motion.rotation);
    // A physical body (Apple's Duo model) turns itself to the device's
    // physical orientation; only the others take the display's turn here.
    if (!body.physical) body.orientation.rotation.z = layout.rotation;
  };

  const fitCamera = () => {
    if (!viewport.width || !viewport.height || !body) return;
    camera.aspect = viewport.width / viewport.height;
    body.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(body.root);
    const size = bounds.getSize(new THREE.Vector3());
    const tan = Math.tan(((CAMERA_FOV * Math.PI) / 180) / 2);
    const distance = Math.max(size.x / (tan * camera.aspect), size.y / tan) * 0.62 + Math.max(0, bounds.max.z);
    fitDistance = Math.max(1.4, distance);
    if (!shownDistance) shownDistance = fitDistance;
    camera.position.set(0, 0, shownDistance * Math.exp(zoomLog));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };

  const invalidate = () => {
    if (disposed || raf) return;
    raf = requestAnimationFrame(draw);
  };

  function draw() {
    raf = 0;
    if (disposed || renderingOffscreen || !viewport.width || !viewport.height) return;
    try {
      if (
        drawingBuffer.width !== viewport.width
        || drawingBuffer.height !== viewport.height
        || drawingBuffer.pixelRatio !== viewport.pixelRatio
      ) {
        renderer.setDrawingBufferSize(viewport.width, viewport.height, viewport.pixelRatio);
        drawingBuffer = { ...viewport };
      }
      const blit = mirrorFrame();
      if (blit.resized) rebuildTexture();
      else if (texture && blit.drawn) texture.needsUpdate = true;
      const now = performance.now();
      if (motion.advance(now, reducedMotionPreferred())) {
        applyPose();
        poseDirty = true;
        notifyPose(false);
      }
      // A Duo eases into each pose; while it moves its shape (and fit) does.
      const folding = body?.duo?.animate?.(now) ?? false;
      if (folding) {
        fitCamera();
        poseDirty = true;
        notifyPose(false);
      }
      const easing = Math.abs(fitDistance - shownDistance) > 0.001;
      if (easing) {
        shownDistance += (fitDistance - shownDistance) * appleEaseFactor(lastDistanceAt, now, 0.12);
        lastDistanceAt = now;
      } else {
        shownDistance = fitDistance;
        lastDistanceAt = 0;
      }
      camera.position.z = shownDistance * Math.exp(zoomLog);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      if (motion.needsFrame() || folding || easing) invalidate();
      else notifyPose(true);
    } catch {
      // A render can throw while the context is gone; `webglcontextlost` is
      // what decides whether that heals or becomes the flat fallback.
    }
  }

  /**
   * Blit the decoded frame into our own bitmap.
   *
   * Returns whether the texture should re-upload, and whether the bitmap
   * CHANGED SIZE while doing it — which is the difference between a re-upload
   * and a rebuild, and the whole reason the 3D screen used to be black.
   *
   * A decoder canvas is 300×150 until its first frame sizes it. Three
   * allocates a texture's storage from the image it is handed at construction,
   * so a texture built against that placeholder is 300×150 forever; every
   * upload afterwards asks the GPU to copy a 512×1111 bitmap into it and
   * Chromium refuses the whole copy with
   * `GL_INVALID_VALUE: glCopySubTextureCHROMIUM: Offset overflows texture
   * dimensions` — 412 of them in one dev session. The copy fails silently as
   * far as the page is concerned: no exception, no lost context, just a screen
   * that stays black over a canvas that demonstrably holds the picture.
   */
  const mirrorFrame = (): { drawn: boolean; resized: boolean } => {
    if (!source || !mirror || !mirrorContext) return { drawn: false, resized: false };
    if (source.width <= 0 || source.height <= 0) return { drawn: false, resized: false };
    const shown = Math.max(viewport.width, viewport.height) * viewport.pixelRatio;
    // Stepped, so dragging the pane's edge rebuilds the texture now and then,
    // not on every pixel.
    const longSide = Math.min(MIRROR_MAX_LONG_SIDE, Math.max(MIRROR_MIN_LONG_SIDE, Math.ceil(shown / 128) * 128));
    const scale = Math.min(1, longSide / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const resized = mirror.width !== width || mirror.height !== height;
    if (resized) {
      mirror.width = width;
      mirror.height = height;
    }
    try {
      mirrorContext.drawImage(source, 0, 0, width, height);
    } catch {
      // A canvas mid-resize can throw; the next frame blits again.
      return { drawn: false, resized };
    }
    return { drawn: true, resized };
  };

  /** A resized bitmap needs new storage, which means a new texture. */
  const rebuildTexture = () => {
    if (!mirror) return;
    texture?.dispose();
    texture = new THREE.CanvasTexture(mirror);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    paintDisplay();
  };

  const attachTexture = (next: HTMLCanvasElement | null) => {
    if (texture) {
      texture.dispose();
      texture = null;
    }
    source = next;
    if (!next) return;
    if (!mirror) {
      mirror = document.createElement("canvas");
      mirrorContext = mirror.getContext("2d", { alpha: false });
    }
    mirrorFrame();
    texture = new THREE.CanvasTexture(mirror);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
  };

  const paintDisplay = () => {
    if (!body) return;
    // A single-body device has one panel; the Duo has two halves sharing one
    // texture. Both go through the same loop.
    for (const panel of body.panels) {
      const material = panel.material as MeshBasicMaterial;
      material.map = texture;
      material.color.set(texture ? 0xffffff : 0x111111);
      material.needsUpdate = true;
    }
    /*
     * Ask for the upload here, not only on the next decoded frame.
     *
     * The body arrives a beat after the stream does, and an idle device sends
     * NO further frames — an iOS home screen is perfectly still. Without this
     * the texture was hung on the material and then never uploaded, so the
     * first thing you saw on a quiet device was a perfect phone with a dead
     * black screen, which came back the moment you touched it.
     */
    if (texture) texture.needsUpdate = true;
    body.rewriteUvs(THREE, layout);
  };

  const installBody = (next: DeviceBody) => {
    if (body) {
      scene.remove(body.root);
      body.dispose();
    }
    body = next;
    scene.add(body.root);
    applyPose();
    fitCamera();
    poseDirty = true;
    invalidate();
    notifyPose(true);
  };

  const loadModel = (source: AppleDeviceModelSource) => {
    const gen = ++loadGen;
    void (async () => {
      try {
        const scene = await loadAppleDeviceModelInstance(source, THREE, GLTFLoader);
        if (disposed || gen !== loadGen) {
          // Superseded: drop this instance's own copies.
          disposeImportedSubtree(scene, null);
          return;
        }
        const imported = createImportedBody(THREE, scene, source, texture, layout);
        if (!imported) {
          disposeImportedSubtree(scene, texture);
          hooks.onUnavailable("The 3D body could not be loaded.");
          return;
        }
        installBody(imported);
        paintDisplay();
        hooks.onReady({ modelId: source.id });
      } catch (cause) {
        if (disposed || gen !== loadGen) return;
        void cause;
        // §A1: never a plain slab. The pane falls back to the flat view.
        hooks.onUnavailable("The 3D body could not be loaded.");
      }
    })();
  };

  /**
   * Build the procedural foldable body, sized from the streamed inner display.
   *
   * Synchronous, unlike the GLB load: there is no asset to fetch. It is only
   * reached when the caller has already proven the device folds, so the import
   * path and the single-display body are untouched for every other device.
   */
  const installDuoBody = (props: AppleDevice3DViewProps) => {
    const duo = props.duo;
    if (duo?.model) {
      try {
        const v68 = createV68DuoBody(THREE, {
          model: duo.model,
          texture,
          angle: duo.angle,
          activeScreenId: duo.activeScreenId ?? null,
        });
        v68.duo?.setPhysicalOrientation?.(duo.physicalOrientation ?? null, duo.tableMode === true);
        installBody(v68);
        paintDisplay();
        hooks.onReady({ modelId: v68.modelId });
        return;
      } catch {
        // A changed Xcode model: the drawn body below still works.
      }
    }
    const next = createProceduralDuoBody(THREE, {
      innerAspect: layout.aspect,
      texture,
      layout,
      ...(duo ? { pose: { angle: duo.angle } } : {}),
    });
    installBody(next);
    paintDisplay();
    hooks.onReady({ modelId: next.modelId });
  };

  const screenPoint = (nx: number, ny: number, captured: boolean): ScreenHit | null => {
    if (!viewport.width || !viewport.height || !body) return null;
    applyPose();
    body.orientation.updateWorldMatrix(true, true);
    camera.updateMatrixWorld(true);
    pointerNdc.set(nx * 2 - 1, 1 - ny * 2);
    raycaster.setFromCamera(pointerNdc, camera);
    const props = getProps();
    /**
     * A hit on the panel (u across, v up) as the device point it sends. A
     * portrait frame lies on the panel as is, whichever way the phone is
     * turned, so the hit is a point on the framebuffer: what the flat view
     * sends and the device takes (`source: "user"` input is frame space). Only
     * a frame the helper already turned wide is the picture.
     */
    const framePoint = (u: number, vFromBottom: number, framePictured: boolean): ScreenHit => {
      const size = appleDeviceInputSize(props.devicePointSize, props.screenPixelSize);
      if (!framePictured) return { x: u * size.width, y: (1 - vFromBottom) * size.height };
      const points = orientedPointSize(props.orientation, size);
      const oriented = portraitToOriented(u, vFromBottom, props.orientation);
      return { x: oriented.x * points.width, y: oriented.y * points.height };
    };
    if (body.duo) {
      // The foldable body is two panels, so the hit is resolved across both and
      // answered in the continuous inner-display space either way.
      const hit = body.duo.pickInner(raycaster);
      if (!hit) return null;
      // Apple's model answers in the live panel's own framebuffer, whatever
      // shape the frame arrives in.
      return framePoint(hit.u, hit.vFromBottom, !body.physical && layout.rawLandscape);
    }
    if (!captured) {
      const hit = raycaster.intersectObject(body.display, false)[0];
      if (!hit) return null;
      localHit.copy(hit.point);
      body.orientation.worldToLocal(localHit);
    } else {
      body.display.geometry.computeBoundingBox();
      const z = body.display.position.z + (body.display.geometry.boundingBox?.max.z ?? 0);
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
      const ray = raycaster.ray.clone().applyMatrix4(body.orientation.matrixWorld.clone().invert());
      if (!ray.intersectPlane(plane, localHit)) return null;
    }
    const u = Math.min(1, Math.max(0, (localHit.x + body.screenWidth / 2) / body.screenWidth));
    const vFromBottom = Math.min(1, Math.max(0, (localHit.y + body.screenHeight / 2) / body.screenHeight));
    return framePoint(u, vFromBottom, layout.rawLandscape);
  };

  const sync = (props: AppleDevice3DViewProps) => {
    if (disposed) return;
    layout = displayLayout(props.orientation, props.screenPixelSize, props.screenCanvas);
    const canvasChanged = props.screenCanvas !== lastCanvas;
    // The mirror is resized by the blit, so a source that changes resolution
    // mid-stream needs nothing here; only a different ELEMENT does.
    const sizeChanged = false;
    if (canvasChanged || sizeChanged) {
      lastCanvas = props.screenCanvas;
      attachTexture(props.screenCanvas);
      paintDisplay();
      lastFrameVersion = props.frameVersion;
      invalidate();
    } else if (props.frameVersion !== lastFrameVersion) {
      lastFrameVersion = props.frameVersion;
      if (texture) texture.needsUpdate = true;
      invalidate();
    }
    // Apple's Duo model is physical (its inner display is landscape), so the
    // display-orientation turn that stands a raw portrait frame up does not
    // apply to it; its panels map their framebuffers themselves.
    if (body && !body.physical) {
      body.orientation.rotation.z = layout.rotation;
      body.rewriteUvs(THREE, layout);
    }

    const duo = props.duo;
    if (duo?.enabled) {
      // Capability-gated by the caller: only a device that folds reaches here.
      const wantedKey = duo.model ? DUO_V68_MODEL_KEY : DUO_MODEL_KEY;
      if (currentModelKey !== wantedKey) {
        currentModelKey = wantedKey;
        installDuoBody(props);
      } else if (body?.duo) {
        body.duo.setHinge(duo.angle);
        body.duo.setActivePanel?.(duo.activeScreenId ?? null);
        body.duo.setPhysicalOrientation?.(duo.physicalOrientation ?? null, duo.tableMode === true);
        applyPose();
        // Folding changes the phone's shape: frame it again.
        fitCamera();
        invalidate();
      }
      return;
    }

    const source = appleDeviceModel(props.family, {
      deviceTypeIdentifier: props.deviceTypeIdentifier ?? null,
      deviceTypeName: props.deviceTypeName,
    });
    if (source.id !== currentModelKey) {
      currentModelKey = source.id;
      loadModel(source);
    } else {
      applyPose();
      invalidate();
    }
  };

  /*
   * A LOST context is not a missing one.
   *
   * `preventDefault` is what lets the browser hand the context back, and
   * `webglcontextrestored` is where the scene picks up again. Reporting it as
   * "this window has no WebGL" was wrong twice over: the pane fell back to
   * flat for something that heals by itself, and — because `dispose()` calls
   * `forceContextLoss()` — every unmount raised the alarm on its way out.
   */
  const onContextLost = (event: Event) => {
    event.preventDefault();
    if (restoreTimer) clearTimeout(restoreTimer);
    // One shot: give the browser its chance to hand the context back, and only
    // then call 3D unavailable. `dispose()` unhooks this listener BEFORE it
    // forces the loss, so an unmount can never reach here.
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      if (!disposed) hooks.onUnavailable("3D view needs WebGL, which this window does not have.");
    }, CONTEXT_RESTORE_MS);
  };
  const onContextRestored = () => {
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = null;
    if (disposed) return;
    drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };
    if (texture) texture.needsUpdate = true;
    fitCamera();
    invalidate();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  sync(initial);

  /**
   * Render the body off the live loop, at a size and with lighting of its own,
   * then put everything back exactly as the person left it.
   */
  let shadowMesh: Mesh | null = null;
  const ensureShadow = () => {
    if (shadowMesh) return shadowMesh;
    const size = 256;
    const canvas2d = document.createElement("canvas");
    canvas2d.width = size;
    canvas2d.height = size;
    const ctx = canvas2d.getContext("2d");
    if (ctx) {
      const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, "rgba(0,0,0,0.55)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    const material = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas2d), transparent: true, depthWrite: false });
    shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.renderOrder = -1;
    return shadowMesh;
  };

  /**
   * True while a render owns the renderer: the live loop does not draw, or it
   * would resize the drawing buffer back to the pane between a turntable's
   * frames (and flash the person's lighting into the recording).
   */
  let renderingOffscreen = false;
  /** A resize that arrived while a render owned the viewport, applied when it ends. */
  let pendingViewport: typeof viewport | null = null;

  const withRenderSetup = <T,>(options: AppleDeviceRenderOptions, run: () => T): T => {
    if (!body) throw new Error("There is no device body to render yet.");
    // The body this render turns; restored even if a model swap replaced it.
    const turned = body;
    const saved = {
      viewport: { ...viewport },
      quaternion: turned.root.quaternion.clone(),
      background: scene.background,
      key: { color: key.color.clone(), intensity: key.intensity },
      rim: { color: rim.color.clone(), intensity: rim.intensity },
      fill: { color: fill.color.clone(), intensity: fill.intensity },
    };
    if (options.lighting === "studio") {
      scene.background = new THREE.Color(0xe7e8ec);
      key.color.set(0xffffff);
      key.intensity = 5.2;
    } else if (options.lighting === "dusk") {
      scene.background = new THREE.Color(0x1d1830);
      key.color.set(0xffc58a);
      key.intensity = 4.8;
      rim.color.set(0x8fa8ff);
      fill.color.set(0x6b4fa8);
    } else {
      scene.background = null;
    }
    const shadow = options.shadow ? ensureShadow() : null;
    if (shadow) scene.add(shadow);
    viewport = { width: options.width, height: options.height, pixelRatio: 1 };
    renderer.setDrawingBufferSize(options.width, options.height, 1);
    renderingOffscreen = true;
    const restore = () => {
      renderingOffscreen = false;
      if (pendingViewport) saved.viewport = pendingViewport;
      pendingViewport = null;
      if (shadow) scene.remove(shadow);
      scene.background = saved.background;
      key.color.copy(saved.key.color);
      key.intensity = saved.key.intensity;
      rim.color.copy(saved.rim.color);
      rim.intensity = saved.rim.intensity;
      fill.color.copy(saved.fill.color);
      fill.intensity = saved.fill.intensity;
      turned.root.quaternion.copy(saved.quaternion);
      viewport = saved.viewport;
      drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };
      fitCamera();
      invalidate();
    };
    let result: T;
    try {
      result = run();
    } catch (error) {
      restore();
      throw error;
    }
    // An async render (the turntable) restores when it settles, not now.
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  };

  const renderOne = (shot: AppleDeviceRenderShot, options: AppleDeviceRenderOptions) => {
    if (!body) return;
    // A still is of the pose, not of the way there: finish any fold ease.
    for (let step = 0, at = performance.now(); step < 80 && body.duo?.animate?.(at); step++) at += 100;
    if (!("current" in shot)) body.root.quaternion.setFromEuler(new THREE.Euler(shot.pitch, shot.yaw, 0, "YXZ"));
    body.orientation.updateWorldMatrix(true, true);
    fitCamera();
    camera.position.z = fitDistance * ("current" in shot ? Math.exp(zoomLog) : 1);
    camera.updateProjectionMatrix();
    if (shadowMesh && options.shadow) {
      const bounds = new THREE.Box3().setFromObject(body.root);
      const size = bounds.getSize(new THREE.Vector3());
      shadowMesh.position.set(0, bounds.min.y - 0.01, 0);
      shadowMesh.scale.set(size.x * 1.2, Math.max(size.z, size.x * 0.35), 1);
    }
    const blit = mirrorFrame();
    if (blit.resized) rebuildTexture();
    else if (texture) texture.needsUpdate = true;
    renderer.render(scene, camera);
  };

  return {
    sync,
    renderShots(shots, options) {
      return withRenderSetup(options, () => shots.map((shot) => {
        renderOne(shot, options);
        return renderer.domElement.toDataURL("image/png");
      }));
    },
    async renderTurntable(options) {
      if (typeof MediaRecorder === "undefined") return null;
      const recorderCanvas = document.createElement("canvas");
      recorderCanvas.width = options.width;
      recorderCanvas.height = options.height;
      const ctx = recorderCanvas.getContext("2d");
      if (!ctx) return null;
      const stream = recorderCanvas.captureStream(30);
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();
      const frames = Math.max(30, Math.round(options.seconds * 30));
      try {
        await withRenderSetup(options, async () => {
          for (let frame = 0; frame < frames; frame++) {
            if (disposed) throw new Error("The 3D view closed during the render.");
            const yaw = -0.6 + (Math.PI * 2 * frame) / frames;
            renderOne({ yaw, pitch: 0.12 }, options);
            ctx.clearRect(0, 0, options.width, options.height);
            ctx.drawImage(renderer.domElement, 0, 0, options.width, options.height);
            await new Promise((resolve) => setTimeout(resolve, 1000 / 30));
          }
        });
      } finally {
        // The recorder and its stream stop whether the loop finished or threw.
        if (recorder.state !== "inactive") recorder.stop();
        await stopped;
        for (const track of stream.getTracks()) track.stop();
      }
      return new Blob(chunks, { type: "video/webm" });
    },
    resize(width, height, pixelRatio) {
      if (disposed) return;
      if (![width, height, pixelRatio].every(Number.isFinite) || width <= 0 || height <= 0) return;
      const ratio = Math.min(2, Math.max(1, pixelRatio));
      // A render owns the viewport: keep the pane's new size for when it ends.
      if (renderingOffscreen) {
        pendingViewport = { width, height, pixelRatio: ratio };
        return;
      }
      if (viewport.width === width && viewport.height === height && viewport.pixelRatio === ratio) return;
      viewport = { width, height, pixelRatio: ratio };
      fitCamera();
      poseDirty = true;
      invalidate();
      notifyPose(true);
    },
    pointerDown(nx, ny, now, forceOrbit) {
      // During a render the viewport is the render's, so a tap would map wrong.
      if (disposed || renderingOffscreen) return "none";
      const props = getProps();
      // §A3: a drag that starts ON the screen is input; one that starts off it
      // orbits; Alt forces the orbit even over the glass.
      const hit = props.interactive && !forceOrbit ? screenPoint(nx, ny, false) : null;
      if (appleDragIntent({
        onScreen: hit !== null,
        altKey: forceOrbit,
        interactive: props.interactive,
      }) === "input" && hit) {
        pointerMode = "input";
        lastInputHit = hit;
        motion.hold(true, now);
        props.onDeviceInput({ phase: "begin", ...hit });
        invalidate();
        return "input";
      }
      pointerMode = "orbit";
      motion.dragActive(true, now);
      invalidate();
      return "orbit";
    },
    pointerMove(nx, ny, dx, dy, now) {
      if (disposed || !pointerMode) return;
      if (pointerMode === "input") {
        if (!getProps().interactive) return;
        const hit = screenPoint(nx, ny, true);
        if (hit) {
          lastInputHit = hit;
          getProps().onDeviceInput({ phase: "move", ...hit });
        }
        return;
      }
      motion.orbit(dx, dy, now);
      invalidate();
    },
    pointerUp(nx, ny, now) {
      if (disposed || !pointerMode) return;
      const mode = pointerMode;
      pointerMode = null;
      if (mode === "input") {
        lastInputHit = null;
        const hit = screenPoint(nx, ny, true);
        if (hit && getProps().interactive) getProps().onDeviceInput({ phase: "end", ...hit });
        motion.hold(false, now);
      } else {
        motion.dragActive(false, now);
      }
      invalidate();
    },
    screenPointAt(nx, ny) {
      if (disposed) return null;
      return screenPoint(nx, ny, false);
    },
    projectDevicePoint(point) {
      if (disposed || !body || !viewport.width || !viewport.height) return null;
      const props = getProps();
      const points = orientedPointSize(
      props.orientation,
      appleDeviceInputSize(props.devicePointSize, props.screenPixelSize),
    );
      if (points.width <= 0 || points.height <= 0) return null;
      const { u, vFromBottom } = orientedToPortrait(
        point.x / points.width,
        point.y / points.height,
        props.orientation,
      );
      if (body.duo) {
        const world = body.duo.innerToWorld(u, vFromBottom);
        if (!world) return null;
        camera.updateMatrixWorld(true);
        projected.copy(world).project(camera);
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
        return {
          x: ((projected.x + 1) / 2) * viewport.width,
          y: ((1 - projected.y) / 2) * viewport.height,
        };
      }
      body.display.geometry.computeBoundingBox();
      const z = body.display.position.z + (body.display.geometry.boundingBox?.max.z ?? 0);
      projected.set(
        (u - 0.5) * body.screenWidth,
        (vFromBottom - 0.5) * body.screenHeight,
        z,
      );
      body.orientation.updateWorldMatrix(true, false);
      camera.updateMatrixWorld(true);
      body.orientation.localToWorld(projected);
      projected.project(camera);
      if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
      return {
        x: ((projected.x + 1) / 2) * viewport.width,
        y: ((1 - projected.y) / 2) * viewport.height,
      };
    },
    zoomBy(logDelta) {
      if (disposed || !Number.isFinite(logDelta) || logDelta === 0) return;
      zoomLog = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomLog + logDelta));
      poseDirty = true;
      invalidate();
      notifyPose(false);
    },
    resetView(now) {
      if (disposed) return;
      zoomLog = 0;
      motion.reset(rest.clone(), now);
      applyPose();
      fitCamera();
      poseDirty = true;
      invalidate();
      notifyPose(true);
    },
    cancelGestures(now) {
      if (disposed) return;
      if (pointerMode === "input") {
        // End the touch where it last was, in the space it began in.
        if (getProps().interactive && lastInputHit) getProps().onDeviceInput({ phase: "end", ...lastInputHit });
        lastInputHit = null;
        motion.hold(false, now);
      } else if (pointerMode === "orbit") {
        motion.dragActive(false, now);
      }
      pointerMode = null;
      invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = null;
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      if (body) {
        scene.remove(body.root);
        body.dispose();
        body = null;
      }
      texture?.dispose();
      source = null;
      mirror = null;
      mirrorContext = null;
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

type GestureEventLike = Event & { scale?: number; clientX?: number; clientY?: number };

export function AppleDevice3DView(props: AppleDevice3DViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const viewerRef = useRef<Viewer | null>(null);
  const lastPointer = useRef({ x: 0, y: 0 });
  /** Bumped whenever the body has moved, so anything projected onto it re-measures. */
  const [poseVersion, setPoseVersion] = useState(0);
  const [hasBody, setHasBody] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    let cancelled = false;
    let viewer: Viewer | null = null;
    let trackpadDispose: (() => void) | null = null;
    let announcedFailure = false;

    const fail = (reason: AppleDevice3DFailure) => {
      if (announcedFailure) return;
      announcedFailure = true;
      setHasBody(false);
      propsRef.current.onUnavailable?.(reason);
    };

    /*
     * The trackpad rule: ctrl-wheel and the Safari pinch
     * gesture are the CAMERA's zoom, a plain wheel is the DEVICE's scroll.
     * Round 3 sent every wheel to the camera, so a list on the simulator could
     * not be scrolled in 3D at all.
     */
    const bindTrackpad = (target: HTMLCanvasElement, next: Viewer) => {
      let gestureScale: number | null = null;
      const consume = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      const unitOf = (event: WheelEvent) =>
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.getBoundingClientRect().height : 1;
      const wheel = (event: WheelEvent) => {
        consume(event);
        if (gestureScale !== null) return;
        const unit = unitOf(event);
        const rect = target.getBoundingClientRect();
        const scroll = propsRef.current.onDeviceScroll;
        const point = !event.ctrlKey && !event.metaKey && scroll && rect.width > 0 && rect.height > 0
          ? next.screenPointAt(
            (event.clientX - rect.left) / rect.width,
            (event.clientY - rect.top) / rect.height,
          )
          : null;
        const intent = appleWheelIntent({
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          onScreen: point !== null,
          interactive: propsRef.current.interactive,
        });
        if (intent === "scroll" && point && scroll) {
          scroll({ ...point, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit });
          return;
        }
        // Off the glass there is nothing to scroll, so the wheel is the zoom.
        next.zoomBy((-event.deltaY * unit) / 240);
      };
      const scaleOf = (event: GestureEventLike) =>
        typeof event.scale === "number" && Number.isFinite(event.scale) && event.scale > 0 ? event.scale : null;
      const start = (event: Event) => {
        consume(event);
        gestureScale = scaleOf(event as GestureEventLike) ?? 1;
      };
      const change = (event: Event) => {
        consume(event);
        const scale = scaleOf(event as GestureEventLike);
        if (gestureScale === null || scale === null) return;
        const duo = propsRef.current.duo;
        if (duo?.enabled && duo.onHingeChange) {
          // Pinch is the hinge, not the camera, once the device folds.
          duo.onHingeChange(appleDuoHingeAfterPinch({
            angle: duo.angle,
            fromScale: gestureScale,
            toScale: scale,
          }));
        } else {
          next.zoomBy(Math.log(scale / gestureScale));
        }
        gestureScale = scale;
      };
      const end = (event: Event) => {
        consume(event);
        gestureScale = null;
      };
      target.addEventListener("wheel", wheel, { passive: false });
      target.addEventListener("gesturestart", start, { passive: false });
      target.addEventListener("gesturechange", change, { passive: false });
      target.addEventListener("gestureend", end, { passive: false });
      return () => {
        target.removeEventListener("wheel", wheel);
        target.removeEventListener("gesturestart", start);
        target.removeEventListener("gesturechange", change);
        target.removeEventListener("gestureend", end);
      };
    };

    void importThreeRuntime().then(({ THREE, GLTFLoader }) => {
      if (cancelled || !canvasRef.current || !hostRef.current) return;
      try {
        viewer = createViewer(THREE, GLTFLoader, canvas, propsRef.current, () => propsRef.current, {
          onPose: () => setPoseVersion((version) => version + 1),
          onReady: (info) => {
            setHasBody(true);
            propsRef.current.onReady?.(info);
          },
          onUnavailable: fail,
        });
      } catch {
        // No WebGL context: the pane falls back to the flat view (§A1).
        fail("3D view needs WebGL, which this window does not have.");
        return;
      }
      viewerRef.current = viewer;
      if (propsRef.current.rendererRef) propsRef.current.rendererRef.current = viewer;
      trackpadDispose = bindTrackpad(canvas, viewer);
      const { width, height } = host.getBoundingClientRect();
      viewer.resize(width, height, window.devicePixelRatio || 1);
    }, () => {
      if (!cancelled) fail("3D view needs WebGL, which this window does not have.");
    });

    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      viewerRef.current?.resize(width, height, window.devicePixelRatio || 1);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const blur = () => viewerRef.current?.cancelGestures(performance.now());
    window.addEventListener("blur", blur);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener("blur", blur);
      trackpadDispose?.();
      viewerRef.current?.dispose();
      viewerRef.current = null;
      if (propsRef.current.rendererRef) propsRef.current.rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewerRef.current?.resetView(performance.now());
  }, [props.resetNonce]);

  useEffect(() => {
    viewerRef.current?.sync(propsRef.current);
  }, [
    props.screenCanvas,
    props.frameVersion,
    props.family,
    props.deviceTypeName,
    props.orientation,
    props.screenPixelSize.width,
    props.screenPixelSize.height,
    props.devicePointSize?.width,
    props.devicePointSize?.height,
    props.interactive,
    props.duo?.enabled,
    props.duo?.angle,
    props.duo?.model,
    props.duo?.activeScreenId,
    props.duo?.physicalOrientation,
    props.duo?.tableMode,
  ]);

  const localPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.max(rect.width, 1);
    const height = Math.max(rect.height, 1);
    return {
      nx: (event.clientX - rect.left) / width,
      ny: (event.clientY - rect.top) / height,
      x: event.clientX,
      y: event.clientY,
    };
  };

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLCanvasElement>) => {
    const send = propsRef.current.onDeviceKey;
    if (!propsRef.current.interactive || !send) return;
    if (event.target !== event.currentTarget) return;
    // Cmd-R and friends stay the app's, exactly as in the flat view.
    if (event.metaKey || event.ctrlKey) return;
    if (send({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
    })) {
      event.preventDefault();
    }
  }, []);

  /**
   * The device→canvas projection the inspect overlay draws with. Re-made on
   * every pose change so the frames follow the body as it turns.
   */
  const deviceToView = useMemo(() => {
    if (!hasBody) return null;
    void poseVersion;
    return (point: { x: number; y: number }) =>
      viewerRef.current?.projectDevicePoint(point) ?? { x: 0, y: 0 };
  }, [hasBody, poseVersion]);

  const overlay = props.renderScreenOverlay?.(deviceToView);

  return (
    <div ref={hostRef} className={cn("relative h-full w-full min-h-0 min-w-0", props.className)}>
      <canvas
        ref={canvasRef}
        tabIndex={props.interactive ? 0 : -1}
        aria-label="iOS Simulator screen"
        role="application"
        className="absolute inset-0 h-full w-full touch-none outline-none"
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const point = localPoint(event);
          lastPointer.current = { x: point.x, y: point.y };
          const mode = viewerRef.current?.pointerDown(point.nx, point.ny, performance.now(), event.altKey);
          if (!mode || mode === "none") return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const point = localPoint(event);
          const dx = point.x - lastPointer.current.x;
          const dy = point.y - lastPointer.current.y;
          lastPointer.current = { x: point.x, y: point.y };
          viewerRef.current?.pointerMove(point.nx, point.ny, dx, dy, performance.now());
        }}
        onPointerUp={(event) => {
          const point = localPoint(event);
          viewerRef.current?.pointerUp(point.nx, point.ny, performance.now());
        }}
        onPointerCancel={(event) => {
          const point = localPoint(event);
          viewerRef.current?.pointerUp(point.nx, point.ny, performance.now());
        }}
        onLostPointerCapture={() => {
          viewerRef.current?.cancelGestures(performance.now());
        }}
      />
      {overlay ? <div className="absolute inset-0">{overlay}</div> : null}
    </div>
  );
}
