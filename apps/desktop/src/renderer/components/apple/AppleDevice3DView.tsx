// Ported from t3code packages/client-runtime/src/device/{modelScene,phoneScene}.ts
// and apps/web/src/components/device/phoneTrackpad.ts (MIT, T3 Tools Inc.) —
// the normalized-GLB display contract (one `device-screen` mesh, portrait,
// front +Z, height 2.2), the planar display UVs, and the trackpad rule that
// ctrl-wheel and pinch are camera zoom while a plain wheel is the DEVICE's
// scroll.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type {
  BufferGeometry,
  CanvasTexture,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3,
} from "three";
import { cn } from "../ui/cn";
import { appleDeviceModel, type AppleDeviceModelId, type AppleDeviceModelSource } from "./appleDeviceModels";
import { createAppleDeviceOrbit, type AppleDeviceOrbit } from "./appleDeviceOrbit";

export type AppleDeviceFamily = "iphone" | "ipad";
export type AppleDeviceOrientation =
  | "portrait"
  | "portrait-upside-down"
  | "landscape-left"
  | "landscape-right";

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
  onReady?: ((info: { modelId: AppleDeviceModelId }) => void) | undefined;
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

/** Three.js is loaded on first 3D mount so a flat-only bundle never pays for it. */
async function importThreeRuntime() {
  const [THREE, gltf] = await Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/GLTFLoader.js"),
  ]);
  return { THREE, GLTFLoader: gltf.GLTFLoader };
}

type ThreeNS = Awaited<ReturnType<typeof importThreeRuntime>>["THREE"];
type GltfLoaderCtor = Awaited<ReturnType<typeof importThreeRuntime>>["GLTFLoader"];

type DisplayLayout = {
  rotation: number;
  rawLandscape: boolean;
  aspect: number;
};

type ScreenHit = { x: number; y: number };

type DeviceBody = {
  modelId: AppleDeviceModelId;
  root: Group;
  orientation: Group;
  display: Mesh;
  screenWidth: number;
  screenHeight: number;
  dispose: () => void;
};

/**
 * How far in front of the body the live display sits, in scene units.
 *
 * The bundled bodies keep Apple's own cover glass: on `iphone-18-pro` that is
 * a BLACK slab whose front face is at z = 0.0430 — exactly the plane of the
 * `device-screen` placeholder. Two coplanar opaque surfaces under Three's
 * default `LessEqualDepth` are a coin flip decided by draw order, and the one
 * that kept winning was the black one, which is why the first round-4 build
 * drew a perfect phone with a dead screen.
 *
 * The lift alone was not enough. At the default camera distance the depth
 * buffer could not tell 0.001 units apart, so the glass came back head-on and
 * went away again as soon as you zoomed or turned the body — which read as
 * "the picture only appears when you touch it". The lift is paired with a
 * polygon offset on the screen material (the standard answer for coplanar
 * geometry, applied in depth units rather than world units) and a near plane
 * far enough out to leave the depth buffer some precision to spend.
 */
const SCREEN_LIFT = 0.002;

const ZOOM_MIN = Math.log(0.55);
const ZOOM_MAX = Math.log(2.4);
const CAMERA_FOV = 32;
/** The overlay re-projects at most this often while the body is still moving. */
const POSE_NOTIFY_MS = 90;
/** How long a lost context has to come back before the pane gives up on 3D. */
const CONTEXT_RESTORE_MS = 2_000;
/** The 3D screen is a few hundred CSS pixels wide; a 3× frame is wasted on it. */
const MIRROR_MAX_WIDTH = 512;

function orientationZ(orientation: AppleDeviceOrientation): number {
  switch (orientation) {
    case "portrait":
      return 0;
    case "portrait-upside-down":
      return Math.PI;
    case "landscape-left":
      return -Math.PI / 2;
    case "landscape-right":
      return Math.PI / 2;
    default: {
      const _exhaustive: never = orientation;
      return _exhaustive;
    }
  }
}

function isLandscape(orientation: AppleDeviceOrientation): boolean {
  return orientation === "landscape-left" || orientation === "landscape-right";
}

/**
 * Has this canvas ever been sized by a decode?
 *
 * A canvas element is 300×150 until something writes to it, and the decoder
 * sets its real size on the first frame it draws. That placeholder is a
 * LANDSCAPE shape, so a layout measured from it comes back rotated — and the
 * body's UVs are written once at install, so a device that goes idle right
 * then keeps a sideways screen with no frame coming to correct it. No Apple
 * device decodes at 300×150, which makes the default unambiguous.
 */
export function appleCanvasHasDecoded(canvas: HTMLCanvasElement | null): boolean {
  if (!canvas) return false;
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  return !(canvas.width === 300 && canvas.height === 150);
}

function displayLayout(
  orientation: AppleDeviceOrientation,
  pixelSize: { width: number; height: number },
  canvas: HTMLCanvasElement | null,
): DisplayLayout {
  const decoded = appleCanvasHasDecoded(canvas) ? canvas : null;
  const width = decoded?.width || pixelSize.width || 390;
  const height = decoded?.height || pixelSize.height || 844;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return {
    rotation: orientationZ(orientation),
    rawLandscape: width > height,
    aspect: long > 0 ? short / long : 9 / 19.5,
  };
}

/**
 * The coordinate space a tap, a scroll and an inspect frame all speak.
 *
 * POINTS, not decoded pixels. Round 3's 3D view measured taps against the
 * decoded frame — 1179×2556 on a 3× phone — and sent those numbers to a
 * device that answers in 393×852, so every 3D tap landed three times too far
 * down and to the right (clamped to the edge in practice), and the inspect
 * frames it projected collapsed into the top-left third of the screen.
 */
export function appleDeviceInputSize(
  pointSize: { width: number; height: number } | null | undefined,
  pixelSize: { width: number; height: number },
): { width: number; height: number } {
  if (pointSize && pointSize.width > 0 && pointSize.height > 0) return pointSize;
  return pixelSize;
}

function orientedPointSize(
  orientation: AppleDeviceOrientation,
  size: { width: number; height: number },
): { width: number; height: number } {
  const short = Math.min(size.width, size.height);
  const long = Math.max(size.width, size.height);
  if (isLandscape(orientation)) return { width: long, height: short };
  return { width: short, height: long };
}

function portraitToOriented(
  u: number,
  vFromBottom: number,
  orientation: AppleDeviceOrientation,
): { x: number; y: number } {
  switch (orientation) {
    case "portrait":
      return { x: u, y: 1 - vFromBottom };
    case "portrait-upside-down":
      return { x: 1 - u, y: vFromBottom };
    case "landscape-left":
      return { x: vFromBottom, y: u };
    case "landscape-right":
      return { x: 1 - vFromBottom, y: 1 - u };
    default: {
      const _exhaustive: never = orientation;
      return _exhaustive;
    }
  }
}

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
 * §A3's wheel rule, ported from t3code's `phoneTrackpad.ts`: ctrl (or cmd)
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

/** The inverse of `portraitToOriented`: a point on the ORIENTED screen, back to the panel's own 0..1. */
export function orientedToPortrait(
  x: number,
  y: number,
  orientation: AppleDeviceOrientation,
): { u: number; vFromBottom: number } {
  switch (orientation) {
    case "portrait":
      return { u: x, vFromBottom: 1 - y };
    case "portrait-upside-down":
      return { u: 1 - x, vFromBottom: y };
    case "landscape-left":
      return { u: y, vFromBottom: x };
    case "landscape-right":
      return { u: 1 - y, vFromBottom: 1 - x };
    default: {
      const _exhaustive: never = orientation;
      return _exhaustive;
    }
  }
}

function writeScreenUvs(
  THREE: ThreeNS,
  geometry: BufferGeometry,
  width: number,
  height: number,
  layout: DisplayLayout,
): void {
  const position = geometry.getAttribute("position");
  if (!geometry.hasAttribute("uv")) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(position.count * 2), 2));
  }
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < position.count; i++) {
    const u = (position.getX(i) + width / 2) / width;
    const v = (position.getY(i) + height / 2) / height;
    if (layout.rawLandscape) {
      uv.setXY(i, layout.rotation > 0 ? 1 - v : v, layout.rotation > 0 ? u : 1 - u);
    } else {
      uv.setXY(i, u, v);
    }
  }
  uv.needsUpdate = true;
}

function meshMaterials(material: Mesh["material"]): Material[] {
  return Array.isArray(material) ? material : [material];
}

/**
 * One parse per model per process, then a private copy per instance.
 *
 * Measured on this machine: the 3D view mounted ten times in one session and
 * every mount fetched 2.4 MB, ran a GLTF parse of 427 accessors, decoded 17
 * WebP images and uploaded them to the GPU — then the superseded load's
 * textures failed as it was torn down, which is the whole of the
 * `THREE.GLTFLoader: Couldn't load texture blob:` noise (17 per mount, exactly).
 *
 * What is cached is the PARSED scene, which is the expensive half. What is NOT
 * shared is anything `disposeImportedSubtree` destroys: it disposes geometries
 * and materials, so each instance gets clones of both and the dispose path
 * needs no exception list and no change at all. That is the property that
 * makes this safe — a cache that required dispose to skip its resources would
 * be one missed call site away from a body that renders empty.
 *
 * Textures ARE shared, deliberately and safely: nothing in the dispose path
 * disposes a texture (it only detaches the live screen texture from a
 * material's `map`), so one decode serves every instance for the life of the
 * process. Three models at ~0.2 MB of image data each is the whole cost.
 *
 * Geometry is still copied per instance — 2.14 MB of the model's 2.34 MB is
 * vertex data. Sharing it would need per-instance cloning of the display mesh
 * alone (`writeScreenUvs` mutates it) plus a dispose exception, and that is the
 * unsafe version above. A memcpy is much cheaper than the parse it replaces.
 */
const parsedModelCache = new Map<string, Promise<Group>>();

/** Reset between tests; never called in the app. */
export function __testClearAppleModelCache(): void {
  parsedModelCache.clear();
}

function instanceOfCachedScene(template: Group): Group {
  const copy = template.clone(true);
  copy.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    // Own the two things dispose destroys.
    mesh.geometry = mesh.geometry.clone();
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => material.clone())
      : mesh.material.clone();
  });
  return copy;
}

function disposeImportedSubtree(root: Object3D, keep: Texture | null): void {
  const geometries = new Set<Mesh["geometry"]>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of meshMaterials(mesh.material)) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    if (keep && "map" in material && material.map === keep) material.map = null;
    material.dispose();
  }
}

/**
 * The one mesh the live framebuffer goes on.
 *
 * The bundled bodies are converted with the display renamed to `device-screen`
 * (see `assets/apple-device-models/sources.json`); the ids from the conversion
 * record are kept as a fallback so a re-export that skips the rename still
 * finds its screen instead of silently drawing a dead body.
 */
function findScreenMesh(root: Object3D, names: readonly string[]): Mesh | null {
  const wanted = new Set(names);
  let match: Mesh | null = null;
  root.traverse((object) => {
    if (match) return;
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    if (wanted.has(mesh.name) || mesh.name === "device-screen") match = mesh;
  });
  return match;
}

function createImportedBody(
  THREE: ThreeNS,
  asset: Group,
  source: AppleDeviceModelSource,
  texture: Texture | null,
  layout: DisplayLayout,
): DeviceBody | null {
  const display = findScreenMesh(asset, source.screenNodeNames);
  if (!display) return null;
  asset.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(display);
  const screenWidth = bounds.max.x - bounds.min.x;
  const screenHeight = bounds.max.y - bounds.min.y;
  if (
    !Number.isFinite(screenWidth)
    || !Number.isFinite(screenHeight)
    || screenWidth <= 0
    || screenHeight <= 0
  ) {
    return null;
  }
  writeScreenUvs(THREE, display.geometry, screenWidth, screenHeight, layout);
  const originalMaterial = display.material;
  const screenMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    color: texture ? 0xffffff : 0x111111,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  display.material = screenMaterial;
  display.name = "device-screen";
  const restZ = display.position.z;
  display.position.z = restZ + SCREEN_LIFT;
  display.renderOrder = 1;
  const root = new THREE.Group();
  const orientation = new THREE.Group();
  orientation.add(asset);
  root.add(orientation);
  return {
    modelId: source.id,
    root,
    orientation,
    display,
    screenWidth,
    screenHeight,
    dispose() {
      display.position.z = restZ;
      display.renderOrder = 0;
      display.material = originalMaterial;
      screenMaterial.map = null;
      screenMaterial.dispose();
      orientation.remove(asset);
      disposeImportedSubtree(asset, texture);
    },
  };
}

function reducedMotionPreferred(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

type ViewerHooks = {
  /** The body moved: anything projected onto it has to be re-measured. */
  onPose: () => void;
  onReady: (info: { modelId: AppleDeviceModelId }) => void;
  onUnavailable: (reason: AppleDevice3DFailure) => void;
};

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
  const motion: AppleDeviceOrbit = createAppleDeviceOrbit();
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
  let viewport = { width: 0, height: 0, pixelRatio: 1 };
  let drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };
  let pointerMode: "input" | "orbit" | null = null;
  let loadGen = 0;
  let loadController: AbortController | null = null;
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
    body.orientation.rotation.z = layout.rotation;
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
    camera.position.set(0, 0, fitDistance * Math.exp(zoomLog));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };

  const invalidate = () => {
    if (disposed || raf) return;
    raf = requestAnimationFrame(draw);
  };

  function draw() {
    raf = 0;
    if (disposed || !viewport.width || !viewport.height) return;
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
      camera.position.z = fitDistance * Math.exp(zoomLog);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      if (motion.needsFrame()) invalidate();
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
    const scale = Math.min(1, MIRROR_MAX_WIDTH / source.width);
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
    const material = body.display.material as MeshBasicMaterial;
    material.map = texture;
    material.color.set(texture ? 0xffffff : 0x111111);
    material.needsUpdate = true;
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
    writeScreenUvs(THREE, body.display.geometry, body.screenWidth, body.screenHeight, layout);
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
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    const gen = ++loadGen;
    void (async () => {
      try {
        let template = parsedModelCache.get(source.id);
        if (!template) {
          // The fetch is NOT given the abort signal any more. An abandoned
          // load used to throw its parse away; now it finishes and fills the
          // cache, so the mount that superseded it pays nothing. The guards
          // below still stop an abandoned load from touching the scene.
          template = (async () => {
            const response = await fetch(source.url);
            if (!response.ok) throw new Error(`model ${response.status}`);
            const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), "");
            return gltf.scene;
          })();
          parsedModelCache.set(source.id, template);
          // A failed parse must not be cached, or one bad load poisons the
          // model for the life of the process.
          void template.catch(() => parsedModelCache.delete(source.id));
        }
        const cached = await template;
        if (controller.signal.aborted || disposed || gen !== loadGen) return;
        const scene = instanceOfCachedScene(cached);
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
        if (controller.signal.aborted || disposed || gen !== loadGen) return;
        void cause;
        // §A1: never a plain slab. The pane falls back to the flat view.
        hooks.onUnavailable("The 3D body could not be loaded.");
      }
    })();
  };

  const screenPoint = (nx: number, ny: number, captured: boolean): ScreenHit | null => {
    if (!viewport.width || !viewport.height || !body) return null;
    applyPose();
    body.orientation.updateWorldMatrix(true, true);
    camera.updateMatrixWorld(true);
    pointerNdc.set(nx * 2 - 1, 1 - ny * 2);
    raycaster.setFromCamera(pointerNdc, camera);
    const props = getProps();
    const points = orientedPointSize(
      props.orientation,
      appleDeviceInputSize(props.devicePointSize, props.screenPixelSize),
    );
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
    const oriented = portraitToOriented(u, vFromBottom, props.orientation);
    return { x: oriented.x * points.width, y: oriented.y * points.height };
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
    if (body) {
      body.orientation.rotation.z = layout.rotation;
      writeScreenUvs(THREE, body.display.geometry, body.screenWidth, body.screenHeight, layout);
    }

    const source = appleDeviceModel(props.family, props.deviceTypeName);
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

  return {
    sync,
    resize(width, height, pixelRatio) {
      if (disposed) return;
      if (![width, height, pixelRatio].every(Number.isFinite) || width <= 0 || height <= 0) return;
      const ratio = Math.min(2, Math.max(1, pixelRatio));
      if (viewport.width === width && viewport.height === height && viewport.pixelRatio === ratio) return;
      viewport = { width, height, pixelRatio: ratio };
      fitCamera();
      poseDirty = true;
      invalidate();
      notifyPose(true);
    },
    pointerDown(nx, ny, now, forceOrbit) {
      if (disposed) return "none";
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
        if (hit) getProps().onDeviceInput({ phase: "move", ...hit });
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
        const props = getProps();
        if (props.interactive) {
          const points = orientedPointSize(
      props.orientation,
      appleDeviceInputSize(props.devicePointSize, props.screenPixelSize),
    );
          props.onDeviceInput({ phase: "end", x: points.width / 2, y: points.height / 2 });
        }
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
      loadController?.abort();
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
     * Ported from t3code's `phoneTrackpad.ts`: ctrl-wheel and the Safari pinch
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
        next.zoomBy(Math.log(scale / gestureScale));
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
