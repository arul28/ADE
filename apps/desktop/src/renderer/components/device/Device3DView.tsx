// Portions adapted from T3 Code (https://github.com/pingdotgg/t3code),
// MIT License, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// Adapted: the phone scene and the trackpad rule that ctrl-wheel and pinch
// are camera zoom while a plain wheel is the DEVICE's scroll. The body and display live in `deviceScene.ts`.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CanvasTexture, MeshBasicMaterial, PerspectiveCamera, Scene, Texture, Vector3 } from "three";
import { cn } from "../ui/cn";
import { deviceEaseFactor, createDeviceOrbit, type DeviceOrbit } from "./deviceOrbit";
import { createDeviceRenderPass, type DeviceRenderer } from "./deviceRenderPass";
import type { DeviceOrientation } from "../../../shared/types/deviceOrientation";
import {
  deviceInputSize,
  displayLayout,
  importThreeRuntime,
  orientedPointSize,
  orientedToPortrait,
  portraitToOriented,
  type DeviceBody,
  type DisplayLayout,
  type GltfLoaderCtor,
  type ThreeNS,
} from "./deviceScene";

/*
 * The 3D device view, shared by Apple Development and Android Development
 * (moved here from `apple/AppleDevice3DView.tsx` when Android first used it,
 * plan §4). What body it shows is the caller's: `bodySource` builds it, and
 * everything else (camera, orbit, the live screen texture, touch on the
 * glass, renders) is the same for every device.
 */

/** Each drawn frame of the decoded screen. */
export type DeviceFrameFeed = { subscribe: (listener: () => void) => () => void };

/** What a body source is given to build its body with. */
export type DeviceBodyBuildContext = {
  THREE: ThreeNS;
  GLTFLoader: GltfLoaderCtor;
  /** The live screen texture, or null before the first frame. */
  texture: Texture | null;
  layout: DisplayLayout;
};

/**
 * Where the body comes from. A new `key` builds a new body; the same key with
 * a new source object only calls `update` (a hinge angle, a body colour), so
 * a body is never rebuilt for a change it can take in place.
 */
export type DeviceBodySource = {
  key: string;
  /**
   * Build the body. Null (or a throw) means there is no 3D body for this
   * device: the pane falls back to the flat view.
   */
  build: (context: DeviceBodyBuildContext) => DeviceBody | null | Promise<DeviceBody | null>;
  /** Apply live settings to the installed body. True when its shape changed and the camera must frame it again. */
  update?: ((body: DeviceBody) => boolean) | undefined;
};

/** Why the 3D presenter cannot show this device, in a sentence the strip can print. */
export type Device3DFailure =
  | "The 3D body could not be loaded."
  | "3D view needs WebGL, which this window does not have.";

export type Device3DViewProps = {
  /** The decoded device screen. The stage draws every frame into this canvas; the view samples it as a texture. */
  screenCanvas: HTMLCanvasElement | null;
  /** Each drawn frame; the view re-uploads the texture on each and otherwise renders only on interaction. */
  frames: DeviceFrameFeed | null;
  /** The body to show (see `DeviceBodySource`). Memoize it: a new object calls `update`. */
  bodySource: DeviceBodySource;
  /** The canvas's accessible name ("iOS Simulator screen"). */
  ariaLabel: string;
  orientation: DeviceOrientation;
  /** Decoded frame size in PIXELS — the texture's own aspect. */
  screenPixelSize: { width: number; height: number };
  /**
   * Device size in POINTS, which is the coordinate space the simulator's input
   * and its accessibility frames are both in. Null falls back to pixels.
   */
  devicePointSize: { width: number; height: number } | null;
  interactive: boolean;
  /**
   * A pinch on the glass, from scale to scale. True = the caller used it (the
   * Duo's hinge); otherwise it is the camera's zoom.
   */
  onPinchScale?: ((fromScale: number, toScale: number) => boolean) | undefined;
  /**
   * Turn the body smoothly to a new orientation instead of at once. Android
   * sets it: its picture turns with the device, so the body follows it.
   */
  animateRotation?: boolean | undefined;
  /** Set to the viewer's render methods while it is mounted. */
  rendererRef?: { current: DeviceRenderer | null } | undefined;
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
  onReady?: ((info: { modelId: string }) => void) | undefined;
  /**
   * There will be no 3D device (§A1). The pane falls back to the flat view and
   * says this once; the view never substitutes a body the source did not build.
   */
  onUnavailable?: ((reason: Device3DFailure) => void) | undefined;
  /**
   * Drawn over the canvas — the live inspect overlay. The argument is the
   * device-point → canvas-pixel projection, or null while there is nothing to
   * project against (no body yet).
   */
  renderScreenOverlay?: ((
    deviceToView: ((point: { x: number; y: number }) => { x: number; y: number }) | null,
  ) => ReactNode) | undefined;
  /**
   * CSS pixels at the right edge the framed body must stay out of: the rail,
   * while it shows. The canvas still fills the stage; only the framing moves.
   */
  railInset?: number | undefined;
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
export function deviceDragIntent(input: {
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
export function deviceWheelIntent(input: {
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
  onReady: (info: { modelId: string }) => void;
  onUnavailable: (reason: Device3DFailure) => void;
};

/** One render angle: yaw/pitch in radians, or the camera exactly as the person left it. */
type Viewer = {
  sync(props: Device3DViewProps): void;
  /** A new frame is in the screen canvas: re-upload the texture and draw. */
  noteFrame(): void;
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
  dispose(): void;
} & DeviceRenderer;

function createViewer(
  THREE: ThreeNS,
  GLTFLoader: GltfLoaderCtor,
  canvas: HTMLCanvasElement,
  initial: Device3DViewProps,
  getProps: () => Device3DViewProps,
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
  const motion: DeviceOrbit = createDeviceOrbit({ choose: (rotation) => rotation });
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
  /** Null until the source's body is on screen (§A1). */
  let body: DeviceBody | null = null;
  /**
   * The body's turn on screen. Equal to `layout.rotation` except while an
   * `animateRotation` body eases to a new orientation.
   */
  let shownRotation = layout.rotation;
  let lastRotationAt = 0;

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
  /**
   * True while a render owns the renderer: the live loop does not draw, or it
   * would resize the drawing buffer back to the pane between a turntable's
   * frames (and flash the person's lighting into the recording).
   */
  let renderingOffscreen = false;
  /** The rail inset and display turn the camera was last framed for. */
  let lastRailInset = 0;
  let lastFitRotation = layout.rotation;
  let drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };
  let pointerMode: "input" | "orbit" | null = null;
  /** Where the touch in progress last was, so a cancel ends it there. */
  let lastInputHit: ScreenHit | null = null;
  let loadGen = 0;
  let currentModelKey = "";
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
    if (!body.physical) body.orientation.rotation.z = shownRotation;
  };

  /** Ease the shown turn toward the layout's; true while it still moves. */
  const advanceRotation = (now: number): boolean => {
    const target = layout.rotation;
    if (!getProps().animateRotation || reducedMotionPreferred()) {
      shownRotation = target;
      lastRotationAt = 0;
      return false;
    }
    if (Math.abs(target - shownRotation) < 0.002) {
      shownRotation = target;
      lastRotationAt = 0;
      return false;
    }
    shownRotation += (target - shownRotation) * deviceEaseFactor(lastRotationAt, now, 0.09);
    lastRotationAt = now;
    return true;
  };

  const fitCamera = () => {
    if (!viewport.width || !viewport.height || !body) return;
    const { width, height } = viewport;
    body.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(body.root);
    const size = bounds.getSize(new THREE.Vector3());
    const tan = Math.tan(((CAMERA_FOV * Math.PI) / 180) / 2);
    /** Distance from the body's front face that frames it in `room` CSS pixels of width. */
    const fitFor = (room: number) => Math.max(size.x / (tan * (room / height)), size.y / tan) * 0.62;
    let fit = fitFor(width);
    // The rail floats over the right edge. A body framed in the whole width
    // that would run under it is framed in the width left of it instead, by
    // shifting the projection's centre; one that clears it is left alone. A
    // render's frame has no rail.
    const inset = renderingOffscreen ? 0 : Math.min(Math.max(0, getProps().railInset ?? 0), width / 2);
    const rightEdge = width / 2 + (bounds.max.x / (fit * tan * (width / height))) * (width / 2);
    if (inset > 0 && rightEdge > width - inset) {
      fit = fitFor(width - inset);
      camera.aspect = (width + inset) / height;
      camera.setViewOffset(width + inset, height, inset, 0, width, height);
    } else {
      camera.aspect = width / height;
      camera.clearViewOffset();
    }
    const distance = fit + Math.max(0, bounds.max.z);
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
      // A body that turns smoothly to a new orientation does too.
      const turning = advanceRotation(now);
      if (turning) applyPose();
      const folding = (body?.duo?.animate?.(now) ?? false) || turning;
      if (folding) {
        fitCamera();
        poseDirty = true;
        notifyPose(false);
      }
      const easing = Math.abs(fitDistance - shownDistance) > 0.001;
      if (easing) {
        shownDistance += (fitDistance - shownDistance) * deviceEaseFactor(lastDistanceAt, now, 0.12);
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

  /**
   * Build the source's body and put it on screen. A synchronous build (a
   * procedural body) lands at once; an async one (a GLB) lands when it
   * resolves, unless a newer source came first, and then its body is dropped.
   */
  const installSource = (bodySource: DeviceBodySource) => {
    const gen = ++loadGen;
    const land = (next: DeviceBody | null) => {
      if (disposed || gen !== loadGen) {
        // Superseded: drop this instance's own copies.
        next?.dispose();
        return;
      }
      if (!next) {
        hooks.onUnavailable("The 3D body could not be loaded.");
        return;
      }
      installBody(next);
      paintDisplay();
      hooks.onReady({ modelId: next.modelId });
    };
    const fail = () => {
      if (disposed || gen !== loadGen) return;
      // §A1: the pane falls back to the flat view.
      hooks.onUnavailable("The 3D body could not be loaded.");
    };
    let built: DeviceBody | null | Promise<DeviceBody | null>;
    try {
      built = bodySource.build({ THREE, GLTFLoader, texture, layout });
    } catch {
      fail();
      return;
    }
    if (built && typeof (built as Promise<DeviceBody | null>).then === "function") {
      void (built as Promise<DeviceBody | null>).then(land, fail);
    } else {
      land(built as DeviceBody | null);
    }
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
      const size = deviceInputSize(props.devicePointSize, props.screenPixelSize);
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

  const sync = (props: Device3DViewProps) => {
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
      invalidate();
    }
    // Apple's Duo model is physical (its inner display is landscape), so the
    // display-orientation turn that stands a raw portrait frame up does not
    // apply to it; its panels map their framebuffers themselves.
    if (body && !body.physical) {
      if (!props.animateRotation) shownRotation = layout.rotation;
      body.orientation.rotation.z = shownRotation;
      body.rewriteUvs(THREE, layout);
    }
    // The rail came or went, or the body turned a quarter and changed shape:
    // frame it again. Kept on the old framing, a landscape body ran past both
    // edges of the pane and under the rail.
    const railInset = props.railInset ?? 0;
    if (railInset !== lastRailInset || layout.rotation !== lastFitRotation) {
      lastRailInset = railInset;
      lastFitRotation = layout.rotation;
      fitCamera();
      poseDirty = true;
      invalidate();
    }

    const bodySource = props.bodySource;
    if (bodySource.key !== currentModelKey) {
      currentModelKey = bodySource.key;
      installSource(bodySource);
    } else if (body && bodySource.update?.(body)) {
      // A hinge step changes the phone's shape: frame it again.
      applyPose();
      fitCamera();
      invalidate();
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

  /** A resize that arrived while a render owned the viewport, applied when it ends. */
  let pendingViewport: typeof viewport | null = null;
  const renderPass = createDeviceRenderPass({
    THREE,
    scene,
    camera,
    renderer,
    lights: { key, rim, fill },
    body: () => body,
    disposed: () => disposed,
    enterOffscreen(width, height) {
      const saved = { ...viewport };
      viewport = { width, height, pixelRatio: 1 };
      renderer.setDrawingBufferSize(width, height, 1);
      renderingOffscreen = true;
      return saved;
    },
    leaveOffscreen(saved) {
      renderingOffscreen = false;
      viewport = pendingViewport ?? saved;
      pendingViewport = null;
      drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };
      fitCamera();
      invalidate();
    },
    fitCamera(zoomed) {
      fitCamera();
      camera.position.z = fitDistance * (zoomed ? Math.exp(zoomLog) : 1);
      camera.updateProjectionMatrix();
    },
    refreshScreen() {
      const blit = mirrorFrame();
      if (blit.resized) rebuildTexture();
      else if (texture) texture.needsUpdate = true;
    },
  });

  return {
    sync,
    noteFrame() {
      if (disposed) return;
      if (texture) texture.needsUpdate = true;
      invalidate();
    },
    renderShots: renderPass.renderShots,
    renderTurntable: renderPass.renderTurntable,
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
      if (deviceDragIntent({
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
      deviceInputSize(props.devicePointSize, props.screenPixelSize),
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

export function Device3DView(props: Device3DViewProps) {
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

    const fail = (reason: Device3DFailure) => {
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
        const intent = deviceWheelIntent({
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
        // A caller may take the pinch (the Duo's hinge); otherwise it is the zoom.
        if (!propsRef.current.onPinchScale?.(gestureScale, scale)) {
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
      resize();
    }, () => {
      if (!cancelled) fail("3D view needs WebGL, which this window does not have.");
    });

    /**
     * The viewport is the host's LAYOUT size, the CSS pixels the inspect
     * overlay draws in. CSS zoom (the web client's 1.1) scales the bounding
     * rect but not the layout box, so a rect-sized viewport put the overlay's
     * boxes 10% off; the zoom goes into the pixel ratio instead, which keeps
     * the canvas as sharp. Pointer input reads fractions of the rect, which
     * zoom does not change.
     */
    let layoutSize: { width: number; height: number } | null = null;
    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = layoutSize?.width || rect.width;
      const height = layoutSize?.height || rect.height;
      const zoom = width > 0 && rect.width > 0 ? rect.width / width : 1;
      viewerRef.current?.resize(width, height, (window.devicePixelRatio || 1) * zoom);
    };
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) layoutSize = { width: box.width, height: box.height };
      resize();
    });
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

  useEffect(() => props.frames?.subscribe(() => viewerRef.current?.noteFrame()), [props.frames]);

  useEffect(() => {
    viewerRef.current?.sync(propsRef.current);
  }, [
    props.screenCanvas,
    props.bodySource,
    props.orientation,
    props.screenPixelSize.width,
    props.screenPixelSize.height,
    props.devicePointSize?.width,
    props.devicePointSize?.height,
    props.interactive,
    props.railInset,
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
        aria-label={props.ariaLabel}
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
