// Ported from t3code packages/client-runtime/src/device/{modelScene,phoneScene}.ts
// (MIT, T3 Tools Inc.): the normalized-GLB display contract (one
// `device-screen` mesh, portrait, front +Z, height 2.2) and the planar display
// UVs.
import type { BufferGeometry, Group, Material, Mesh, Object3D, Texture } from "three";
import type { AppleDeviceOrientation } from "../../../shared/types";
import type { AppleDeviceModelId, AppleDeviceModelSource } from "./appleDeviceModels";

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
};

export type DeviceBody = {
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

export function displayLayout(
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

export function orientedPointSize(
  orientation: AppleDeviceOrientation,
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
