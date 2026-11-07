import type { Object3D, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import type { AndroidCatalogEntry } from "../../../shared/androidDeviceCatalog";
import { androidCatalogColor } from "../../../shared/androidDeviceCatalog";
import { importThreeRuntime, type DeviceBody, type GltfLoaderCtor, type ThreeNS } from "../device/deviceScene";
import { androidBodySource, type AndroidBodySpec } from "./androidDeviceBody";

/*
 * The picker's device pictures: one still per tile, and a slow turn on the
 * tile the pointer is on. ONE WebGL context draws all of them, whatever the
 * number of tiles, and it goes away when the picker has drawn nothing for a
 * while. A tile shows a still (`<img>`) or a 2D canvas the turn is copied to,
 * never a canvas of its own with a WebGL context.
 *
 * Stills are cached twice: in this module for the window's life, and in
 * localStorage (WebP, keyed by the model, the colour, the size and
 * `TILE_RENDER_VERSION`), so a second open of the picker draws no GPU frame.
 */

/** Change this when the body, lighting or pose of a still changes: old stills are not used again. */
const TILE_RENDER_VERSION = 6;
const STORAGE_PREFIX = `ade.android.tileStill.v${TILE_RENDER_VERSION}:`;
/** A still over this size is kept in memory only (localStorage has ~5 MB for every key). */
const STORAGE_MAX_CHARS = 60_000;
/** The shared context goes away after this long with nothing drawn. */
const IDLE_DISPOSE_MS = 20_000;
/**
 * The tile's resting turn and tilt: the back, three-quarter, a little from
 * above, as a store shows a phone: the colour and the camera (Pixel's bar,
 * Samsung's lenses) are what tell the devices apart.
 */
const TILE_YAW = Math.PI + 0.55;
const TILE_PITCH = 0.16;
/** The hovered tile turns once in this long. */
const TURN_PERIOD_MS = 9_000;

export type AndroidTileSpec = {
  entry: AndroidCatalogEntry | null;
  /** The bare profile, for a body with no catalog entry. */
  profile?: AndroidBodySpec["profile"];
  colorId: string | null;
  /** Short side over long side of the screen. */
  aspect: number;
  /** CSS size of the picture; it is drawn at twice this. */
  width: number;
  height: number;
};

type Shared = {
  THREE: ThreeNS;
  GLTFLoader: GltfLoaderCtor;
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
};

let sharedPromise: Promise<Shared | null> | null = null;
let shared: Shared | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Draws run one at a time on the shared context. */
let queue: Promise<unknown> = Promise.resolve();
const stills = new Map<string, string>();
const pendingStills = new Map<string, Promise<string | null>>();

function keyFor(spec: AndroidTileSpec): string {
  const color = spec.entry ? androidCatalogColor(spec.entry, spec.colorId).id : spec.colorId ?? "default";
  const model = spec.entry
    ? `${spec.entry.id}:${spec.entry.model ?? "procedural"}`
    : `profile:${spec.profile?.formFactor ?? "phone"}:${spec.profile?.screenInches ?? ""}`;
  return `${model}:${color}:${spec.aspect.toFixed(3)}:${Math.round(spec.width)}x${Math.round(spec.height)}`;
}

function readStored(key: string): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_PREFIX + key);
    return value && value.startsWith("data:image/") ? value : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, dataUrl: string): void {
  if (dataUrl.length > STORAGE_MAX_CHARS) return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, dataUrl);
  } catch {
    // Storage full or blocked: the memory cache still holds it.
  }
}

/** The still for a tile when one is cached already; never draws. */
export function cachedAndroidTileStill(spec: AndroidTileSpec): string | null {
  const key = keyFor(spec);
  const memory = stills.get(key);
  if (memory) return memory;
  const stored = readStored(key);
  if (stored) stills.set(key, stored);
  return stored;
}

function scheduleIdleDispose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (turning) return;
    disposeShared();
  }, IDLE_DISPOSE_MS);
}

function disposeShared(): void {
  const current = shared;
  shared = null;
  sharedPromise = null;
  if (!current) return;
  current.renderer.dispose();
  current.renderer.forceContextLoss();
}

async function acquireShared(): Promise<Shared | null> {
  if (shared) return shared;
  if (!sharedPromise) {
    sharedPromise = (async () => {
      try {
        const { THREE, GLTFLoader } = await importThreeRuntime();
        const canvas = document.createElement("canvas");
        const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power", preserveDrawingBuffer: true });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setClearColor(0x000000, 0);
        const scene = new THREE.Scene();
        // The 3D stage's lights, so a tile and the stage show one device.
        scene.add(new THREE.AmbientLight(0xffffff, 2.3));
        const key = new THREE.DirectionalLight(0xe4edff, 4.6);
        key.position.set(-3, 4, 5);
        const rim = new THREE.DirectionalLight(0xffffff, 3.4);
        rim.position.set(3, 1, -3);
        const fill = new THREE.DirectionalLight(0x9facd4, 1.8);
        fill.position.set(-2, -2, -4);
        // Tiles show the back, which the stage's front key light leaves dim.
        const back = new THREE.DirectionalLight(0xffffff, 3.2);
        back.position.set(-2.5, 3, -5);
        scene.add(key, rim, fill, back);
        const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 40);
        shared = { THREE, GLTFLoader, renderer, scene, camera };
        return shared;
      } catch {
        return null;
      }
    })();
  }
  return sharedPromise;
}

/** The screen a tile shows: Android's default wallpaper colours and a clock. */
function wallpaper(spec: AndroidTileSpec): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const round = spec.entry?.body.round === true;
  canvas.width = 360;
  canvas.height = round ? 360 : Math.round(360 / Math.max(0.3, Math.min(1, spec.aspect)));
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const { width, height } = canvas;
  const accent = spec.entry ? androidCatalogColor(spec.entry, spec.colorId).body : "#4a5a7a";
  const gradient = context.createLinearGradient(0, 0, width * 0.4, height);
  gradient.addColorStop(0, "#0d1a2e");
  gradient.addColorStop(0.55, "#1f3550");
  gradient.addColorStop(1, "#0a0f18");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  // A soft disc of the body's colour, as Material You tints the wallpaper.
  const glow = context.createRadialGradient(width * 0.7, height * 0.72, 0, width * 0.7, height * 0.72, width * 0.9);
  glow.addColorStop(0, `${accent}cc`);
  glow.addColorStop(1, `${accent}00`);
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(255,255,255,0.92)";
  context.textAlign = "center";
  context.font = `300 ${Math.round(width * 0.24)}px system-ui, sans-serif`;
  context.fillText("12:30", width / 2, round ? height * 0.58 : height * 0.26);
  return canvas;
}

type Built = { body: DeviceBody; dispose: () => void };

async function buildBody(context: Shared, spec: AndroidTileSpec): Promise<Built | null> {
  const { THREE, GLTFLoader } = context;
  const texture = new THREE.CanvasTexture(wallpaper(spec));
  texture.colorSpace = THREE.SRGBColorSpace;
  const source = androidBodySource({ entry: spec.entry, profile: spec.profile ?? null, colorId: spec.colorId }, spec.aspect);
  const body = await source.build({ THREE, GLTFLoader, texture, layout: { rotation: 0, rawLandscape: false, aspect: spec.aspect, flipped: false } });
  if (!body) {
    texture.dispose();
    return null;
  }
  return {
    body,
    dispose: () => {
      body.dispose();
      texture.dispose();
    },
  };
}

type Staged = {
  /** Sets the context's size and camera for this body (a still in between may have changed them). */
  apply: () => void;
  unstage: () => void;
};

/** Puts the body in the scene and fits the camera to it at the tile's aspect. */
function stage(context: Shared, built: Built, spec: AndroidTileSpec): Staged {
  const { THREE, renderer, scene, camera } = context;
  const pixelWidth = Math.max(16, Math.round(spec.width * 2));
  const pixelHeight = Math.max(16, Math.round(spec.height * 2));
  scene.add(built.body.root);
  const box = new THREE.Box3().setFromObject(built.body.root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  built.body.root.position.sub(centre);
  const aspect = pixelWidth / pixelHeight;
  const vertical = (camera.fov * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
  // Fits whatever the turn about the vertical axis: across, the widest the
  // body gets is its width-by-depth diagonal; up, its height (and a little
  // for the tilt). The near face is closer than the centre, hence the margin.
  const across = Math.hypot(size.x, size.z) / 2;
  const up = (size.y / 2) * Math.cos(TILE_PITCH) + (size.z / 2) * Math.sin(TILE_PITCH);
  const distance = Math.max(up / Math.tan(vertical / 2), across / Math.tan(horizontal / 2)) * 1.14 + size.z / 2;
  const apply = () => {
    renderer.setPixelRatio(1);
    const current = renderer.getSize(new THREE.Vector2());
    if (current.x !== pixelWidth || current.y !== pixelHeight) renderer.setSize(pixelWidth, pixelHeight, false);
    camera.aspect = aspect;
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };
  apply();
  return {
    apply,
    unstage: () => {
      scene.remove(built.body.root);
      built.body.root.position.set(0, 0, 0);
    },
  };
}

function pose(built: Built, yaw: number, pitch: number): void {
  built.body.root.rotation.set(pitch, yaw, 0, "YXZ");
}

/**
 * The tile's still, drawn on the shared context when no cache has it. Null
 * when this window cannot draw WebGL (the tile then shows its flat outline).
 */
export function renderAndroidTileStill(spec: AndroidTileSpec): Promise<string | null> {
  const cached = cachedAndroidTileStill(spec);
  if (cached) return Promise.resolve(cached);
  const key = keyFor(spec);
  const inFlight = pendingStills.get(key);
  if (inFlight) return inFlight;
  const job = queue.then(async () => {
    const context = await acquireShared();
    if (!context) return null;
    const built = await buildBody(context, spec);
    if (!built) return null;
    const staged = stage(context, built, spec);
    // The turning tile's body shares the scene: out of this still. Its next
    // frame puts the size and camera back (`apply`).
    const turningRoot = turning?.root ?? null;
    if (turningRoot) turningRoot.visible = false;
    try {
      pose(built, TILE_YAW, TILE_PITCH);
      context.renderer.render(context.scene, context.camera);
      const canvas = context.renderer.domElement;
      const webp = canvas.toDataURL("image/webp", 0.86);
      // A window with no WebP encoder answers PNG.
      const dataUrl = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
      stills.set(key, dataUrl);
      writeStored(key, dataUrl);
      return dataUrl;
    } finally {
      if (turningRoot) turningRoot.visible = true;
      staged.unstage();
      built.dispose();
      scheduleIdleDispose();
    }
  }).catch(() => null).finally(() => pendingStills.delete(key));
  queue = job;
  pendingStills.set(key, job);
  return job;
}

/** Reduced motion (the OS setting, or ADE's own): no tile turns. */
export function androidTileReducedMotion(): boolean {
  return (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
    || globalThis.document?.documentElement.dataset.motion === "reduced";
}

let turning: { stop: () => void; root: Object3D | null } | null = null;

/**
 * The hovered tile's slow turn, drawn on the shared context and copied into
 * `target` (a 2D canvas) each frame. Only one tile turns at a time: a new
 * turn stops the last one. Returns the stop function.
 */
export function startAndroidTileTurn(target: HTMLCanvasElement, spec: AndroidTileSpec, onFirstFrame?: () => void): () => void {
  turning?.stop();
  let stopped = false;
  let raf = 0;
  let built: Built | null = null;
  let staged: Staged | null = null;
  const handle: { stop: () => void; root: Object3D | null } = {
    root: null,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      staged?.unstage();
      built?.dispose();
      if (turning === handle) turning = null;
      scheduleIdleDispose();
    },
  };
  turning = handle;
  queue = queue.then(async () => {
    if (stopped) return;
    const context = await acquireShared();
    if (!context || stopped) return;
    const next = await buildBody(context, spec);
    if (!next) return;
    if (stopped) {
      next.dispose();
      return;
    }
    built = next;
    staged = stage(context, next, spec);
    handle.root = next.body.root;
    const output = target.getContext("2d");
    const started = performance.now();
    let shown = false;
    const draw = (now: number) => {
      if (stopped || !built || !output) return;
      const turn = ((now - started) / TURN_PERIOD_MS) * Math.PI * 2;
      pose(built, TILE_YAW + turn, TILE_PITCH);
      staged?.apply();
      context.renderer.render(context.scene, context.camera);
      const source = context.renderer.domElement;
      if (target.width !== source.width || target.height !== source.height) {
        target.width = source.width;
        target.height = source.height;
      }
      output.clearRect(0, 0, target.width, target.height);
      output.drawImage(source, 0, 0);
      if (!shown) {
        shown = true;
        onFirstFrame?.();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
  }).catch(() => undefined);
  return handle.stop;
}
