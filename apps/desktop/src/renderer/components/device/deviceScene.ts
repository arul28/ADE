// Portions adapted from T3 Code (https://github.com/pingdotgg/t3code),
// MIT License, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// Adapted: the normalized-GLB display contract (one `device-screen` mesh,
// portrait, front +Z, height 2.2) and the planar display UVs.
import type {
  BufferGeometry,
  Group,
  Material,
  Mesh,
  Object3D,
  Raycaster,
  Texture,
  Vector3,
} from "three";
import type { DeviceOrientation } from "../../../shared/types/deviceOrientation";

/** What `createImportedBody` needs of a model: its id and its screen mesh's names. */
export type DeviceScreenModelSource = { id: string; screenNodeNames: readonly string[] };

/**
 * The 3D device's body and screen: the three.js runtime, the imported body
 * with the live display on it, and the math between the display's own 0..1
 * space and the device's oriented points. No renderer, camera or input here.
 */

/** Three.js is loaded on first 3D mount so a flat-only bundle never pays for it. */
export async function importThreeRuntime() {
  const [THREE, gltf] = await Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/GLTFLoader.js"),
  ]);
  return { THREE, GLTFLoader: gltf.GLTFLoader };
}

export type ThreeNS = Awaited<ReturnType<typeof importThreeRuntime>>["THREE"];
export type GltfLoaderCtor = Awaited<ReturnType<typeof importThreeRuntime>>["GLTFLoader"];

export type DisplayLayout = {
  rotation: number;
  rawLandscape: boolean;
  aspect: number;
  /**
   * The device is upside down and its frames already come turned the right
   * way up (Android's scrcpy turns them), so the texture turns a half turn
   * back. Apple's frames come in the panel's own shape, so this stays unset.
   */
  flipped?: boolean;
};

/**
 * The articulated controls a foldable body adds. Absent on every imported GLB
 * body, so the single-display path never touches them and pays nothing.
 */
export type DuoBodyControls = {
  /** Fold both halves to an interior hinge angle (0 shut, 180 flat). */
  setHinge: (angle: number) => void;
  /**
   * Raycast both panels and answer the hit in continuous inner-display
   * portrait coordinates. Null when the ray misses both halves.
   */
  pickInner: (raycaster: Raycaster) => { u: number; vFromBottom: number } | null;
  /**
   * Continuous inner-display portrait coordinates → that panel's world
   * position. Null when the point cannot be placed.
   */
  innerToWorld: (u: number, vFromBottom: number) => Vector3 | null;
  /**
   * Ease toward the last pose asked for, at `now` (ms). True while still
   * moving, so the view keeps drawing. Bodies that jump straight to their
   * pose leave it out.
   */
  animate?: (now: number) => boolean;
  /** Apple's physical body only: which panel is live (it shows the stream). */
  setActivePanel?: (screenId: number | null) => void;
  /**
   * Apple's physical body only: the device as held (`landscape-left`, …) and
   * whether it stands in Tent's Table Mode, which set how it sits in view.
   */
  setPhysicalOrientation?: (orientation: string | null, tableMode?: boolean) => void;
};

export type DeviceBody = {
  /** The model the body is (a GLB id, or a procedural body's own key). */
  modelId: string;
  root: Group;
  orientation: Group;
  /** The primary display mesh — always `panels[0]`. */
  display: Mesh;
  /** Every mesh the live framebuffer is painted on: one, or the Duo's two. */
  panels: Mesh[];
  screenWidth: number;
  screenHeight: number;
  /** Recompute each panel's texture UVs for a new orientation. */
  rewriteUvs: (THREE: ThreeNS, layout: DisplayLayout) => void;
  /** Foldable bodies only; undefined for every imported GLB. */
  duo?: DuoBodyControls;
  /**
   * True for a body that is built as the hardware is (Apple's Duo model): each
   * panel maps its own framebuffer, so the view neither applies the display
   * orientation's turn nor rewrites its UVs, and taps answer in the live
   * panel's raw framebuffer.
   */
  physical?: boolean;
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

function orientationZ(orientation: DeviceOrientation): number {
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

function isLandscape(orientation: DeviceOrientation): boolean {
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
export function canvasHasDecoded(canvas: HTMLCanvasElement | null): boolean {
  if (!canvas) return false;
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  return !(canvas.width === 300 && canvas.height === 150);
}

export function displayLayout(
  orientation: DeviceOrientation,
  pixelSize: { width: number; height: number },
  canvas: HTMLCanvasElement | null,
  framesUpright = false,
): DisplayLayout {
  const decoded = canvasHasDecoded(canvas) ? canvas : null;
  const width = decoded?.width || pixelSize.width || 390;
  const height = decoded?.height || pixelSize.height || 844;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return {
    rotation: orientationZ(orientation),
    rawLandscape: width > height,
    aspect: long > 0 ? short / long : 9 / 19.5,
    flipped: framesUpright && orientation === "portrait-upside-down" && width <= height,
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
export function deviceInputSize(
  pointSize: { width: number; height: number } | null | undefined,
  pixelSize: { width: number; height: number },
): { width: number; height: number } {
  if (pointSize && pointSize.width > 0 && pointSize.height > 0) return pointSize;
  return pixelSize;
}

export function orientedPointSize(
  orientation: DeviceOrientation,
  size: { width: number; height: number },
): { width: number; height: number } {
  const short = Math.min(size.width, size.height);
  const long = Math.max(size.width, size.height);
  if (isLandscape(orientation)) return { width: long, height: short };
  return { width: short, height: long };
}

export function portraitToOriented(
  u: number,
  vFromBottom: number,
  orientation: DeviceOrientation,
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

/** The inverse of `portraitToOriented`: a point on the ORIENTED screen, back to the panel's own 0..1. */
export function orientedToPortrait(
  x: number,
  y: number,
  orientation: DeviceOrientation,
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

/**
 * Continuous portrait coordinates → the texture's own uv.
 *
 * The single display and the Duo's two halves both speak portrait (u,
 * vFromBottom) over the whole canvas; only this rotation term differs. Keeping
 * it in one place is what stops the two paths from disagreeing on a landscape
 * device.
 */
export function portraitUvToTextureUv(
  u: number,
  vFromBottom: number,
  layout: DisplayLayout,
): { u: number; v: number } {
  if (layout.rawLandscape) {
    return layout.rotation > 0
      ? { u: 1 - vFromBottom, v: u }
      : { u: vFromBottom, v: 1 - u };
  }
  if (layout.flipped) return { u: 1 - u, v: 1 - vFromBottom };
  return { u, v: vFromBottom };
}

export function writeScreenUvs(
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
    const vFromBottom = (position.getY(i) + height / 2) / height;
    const texture = portraitUvToTextureUv(u, vFromBottom, layout);
    uv.setXY(i, texture.u, texture.v);
  }
  uv.needsUpdate = true;
}

function meshMaterials(material: Mesh["material"]): Material[] {
  return Array.isArray(material) ? material : [material];
}

export function disposeImportedSubtree(root: Object3D, keep: Texture | null): void {
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

export function createImportedBody(
  THREE: ThreeNS,
  asset: Group,
  source: DeviceScreenModelSource,
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
    panels: [display],
    screenWidth,
    screenHeight,
    rewriteUvs(three, nextLayout) {
      writeScreenUvs(three, display.geometry, screenWidth, screenHeight, nextLayout);
    },
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

/**
 * The bare-screen look ("Realistic body" off in Settings): the view draws only
 * the live panels, each with a thin dark edge behind it, so the picture still
 * reads as a device. Every other mesh of the body is hidden, not removed, so
 * the switch works in place and the camera, the orbit, touch on the glass and
 * renders stay as they are. The hidden meshes still count for the camera's
 * framing (`Box3.setFromObject` reads hidden meshes too), so the shot does not
 * jump when the switch changes.
 *
 * A foldable keeps its two panels: each half gets its own edge, and the hinge
 * between them shows as the gap between two edges. Apple's Duo model also
 * keeps its cover panel on the back of one half.
 */
const BARE_EDGE_WIDTH = 0.022;
const BARE_EDGE_COLOR = 0x2b2d31;

type BareScreenState = {
  hidden: Mesh[];
  edges: Mesh[];
  material: Material;
};

const bareScreenStates = new WeakMap<DeviceBody, BareScreenState>();

/** A copy of a panel's geometry, grown by `BARE_EDGE_WIDTH` on every side in the panel's plane. */
function edgeGeometryFor(THREE: ThreeNS, panel: Mesh): BufferGeometry {
  const geometry = panel.geometry.clone();
  geometry.deleteAttribute("uv");
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  panel.updateWorldMatrix(true, false);
  const worldScale = panel.getWorldScale(new THREE.Vector3());
  const extents = [size.x, size.y, size.z];
  const scales = [Math.abs(worldScale.x) || 1, Math.abs(worldScale.y) || 1, Math.abs(worldScale.z) || 1];
  // The panel's plane is its two longest local axes; the third is its normal.
  const normalAxis = extents.indexOf(Math.min(...extents));
  const factor = extents.map((extent, axis) => {
    if (axis === normalAxis || extent <= 0) return 1;
    return 1 + (2 * BARE_EDGE_WIDTH) / (extent * scales[axis]!);
  });
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(factor[0]!, factor[1]!, factor[2]!);
  geometry.translate(center.x, center.y, center.z);
  return geometry;
}

function isAncestorOfPanel(object: Object3D, panels: ReadonlySet<Object3D>): boolean {
  let found = false;
  object.traverse((child) => {
    if (child !== object && panels.has(child)) found = true;
  });
  return found;
}

/**
 * Show the body bare (`bare` true) or whole. Safe to call again with the same
 * value. Call `releaseBareScreen` before the body is disposed.
 */
export function setBodyBareScreen(THREE: ThreeNS, body: DeviceBody, bare: boolean): void {
  const current = bareScreenStates.get(body);
  if (!bare) {
    if (current) releaseBareScreen(body);
    return;
  }
  if (current) return;
  const panels = new Set<Object3D>(body.panels);
  const hidden: Mesh[] = [];
  body.root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || panels.has(mesh) || !mesh.visible) return;
    // A mesh that carries a panel as its child stays: hiding it would hide the panel.
    if (isAncestorOfPanel(mesh, panels)) return;
    mesh.visible = false;
    hidden.push(mesh);
  });
  // Coplanar with the panel and pushed back in depth, so the live picture
  // always wins where the two overlap (the panel's own offset is −4/−8).
  const material = new THREE.MeshBasicMaterial({
    color: BARE_EDGE_COLOR,
    toneMapped: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
  });
  const edges: Mesh[] = [];
  for (const panel of body.panels) {
    const edge = new THREE.Mesh(edgeGeometryFor(THREE, panel), material);
    edge.name = "device-bare-edge";
    edge.renderOrder = 0;
    edge.raycast = () => undefined;
    panel.add(edge);
    edges.push(edge);
  }
  bareScreenStates.set(body, { hidden, edges, material });
}

/** Undo `setBodyBareScreen`: show the body's meshes again and free the edges. */
export function releaseBareScreen(body: DeviceBody): void {
  const state = bareScreenStates.get(body);
  if (!state) return;
  bareScreenStates.delete(body);
  for (const mesh of state.hidden) mesh.visible = true;
  for (const edge of state.edges) {
    edge.removeFromParent();
    edge.geometry.dispose();
  }
  state.material.dispose();
}
