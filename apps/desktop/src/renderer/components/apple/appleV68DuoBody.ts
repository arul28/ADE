import type { BufferGeometry, Group, Material, Mesh, Object3D, Raycaster, Texture, Vector3 } from "three";
import { disposeImportedSubtree, type DeviceBody, type DuoBodyControls, type ThreeNS } from "./appleDeviceScene";
import { APPLE_DUO_COVER_SCREEN_ID, APPLE_DUO_INNER_SCREEN_ID } from "../../../shared/types/iosSimulator";
import { clampAppleDuoAngle } from "./appleDuo";
import { appleEaseFactor } from "./appleDeviceOrbit";

/**
 * The iPhone Duo on Apple's own model (`V68.usdz` from the local Xcode,
 * prepared by the vendored serve-sim `prepareDuoModel`: split at the hinge
 * into `left-half` and `right-half`, with `inner-display-left/right` and
 * `cover-display` named).
 *
 * Unlike every other body, this one is PHYSICAL: the model's inner display is
 * landscape and its cover portrait, exactly as the phone is. So it opts out of
 * the 3D view's display-orientation turn (`physical`) and maps each
 * panel's raw framebuffer onto its own mesh:
 *
 * - inner: the panel is mounted a quarter turn from its framebuffer, so a
 *   point `u` across / `vTop` down the open display is framebuffer
 *   `(vTop, 1 - u)` — the mapping measured on the simulator, where a tap at
 *   that point opened the app under it;
 * - cover: seen from the back of its half, so `u` runs right to left.
 *
 * Only the active panel shows the stream; the other is the dark glass it is on
 * the real phone.
 */

/** The bundled bodies' normalized height; the open Duo is scaled to its width. */
const DUO_OPEN_WIDTH = 2.8;
const DEG = Math.PI / 180;
/** The held phone's turn about the view axis, by CoreDevice's orientation name. */
const PHYSICAL_TURN: Readonly<Record<string, number>> = {
  portrait: 0,
  "landscape-left": Math.PI / 2,
  "landscape-right": -Math.PI / 2,
  pud: Math.PI,
};

/** How far above the table the camera looks down on a laptop or a tent. */
const LAPTOP_LOOK_DOWN = 22 * DEG;
const TENT_LOOK_DOWN = 12 * DEG;

/**
 * How far the held phone tips about the view's X axis to stand as it would
 * on a table, in radians, for a hinge at `angle`.
 *
 * Held sideways and folded, the Duo is a laptop: the lower half lies flat and
 * the upper half stands, seen from a little above. Both halves fold toward the
 * camera, so the lower half points down by 90° − φ (φ is each half's fold);
 * tipping by that much lays it flat. The stand fades in from flat (180°) to
 * 120°, so a hinge drag moves the view smoothly rather than snapping at a pose.
 * A tent stands on its edges with the cover toward the viewer, seen from a
 * little above. Everything else is seen face on.
 */
export function appleDuoStandTilt(input: {
  angle: number;
  sideways: boolean;
  tableMode: boolean;
  coverLive: boolean;
}): number {
  if (input.tableMode) return TENT_LOOK_DOWN;
  if (!input.sideways || input.coverLive) return 0;
  const angle = clampAppleDuoAngle(input.angle);
  const phi = ((180 - angle) / 2) * DEG;
  const t = Math.min(1, Math.max(0, (180 - angle) / 60));
  const weight = t * t * (3 - 2 * t);
  return weight * (LAPTOP_LOOK_DOWN - (Math.PI / 2 - phi));
}

type PanelMap = {
  meshes: Mesh[];
  /** The panel's extent in model space, at the open pose. */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Model-space point → framebuffer fraction (x right, y down). */
  toFrame: (x: number, y: number) => { x: number; y: number };
  /** Framebuffer fraction → model-space point on the panel. */
  fromFrame: (fx: number, fy: number) => { x: number; y: number };
  z: number;
};

function bounds(meshes: Mesh[]) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let z = 0;
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    minX = Math.min(minX, box.min.x);
    maxX = Math.max(maxX, box.max.x);
    minY = Math.min(minY, box.min.y);
    maxY = Math.max(maxY, box.max.y);
    z = (box.min.z + box.max.z) / 2;
  }
  return { minX, maxX, minY, maxY, z };
}

function writeUvs(three: ThreeNS, geometry: BufferGeometry, map: PanelMap) {
  const position = geometry.getAttribute("position");
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const frame = map.toFrame(position.getX(i), position.getY(i));
    // Canvas textures are flipped: v = 0 is the frame's bottom row.
    uv[i * 2] = frame.x;
    uv[i * 2 + 1] = 1 - frame.y;
  }
  geometry.setAttribute("uv", new three.Float32BufferAttribute(uv, 2));
}

export function createV68DuoBody(
  THREE: ThreeNS,
  options: {
    model: Group;
    texture: Texture | null;
    angle: number;
    activeScreenId: number | null;
  },
): DeviceBody {
  const root = new THREE.Group();
  const orientation = new THREE.Group();
  // A deep clone shares geometry with the cached model; this body writes its
  // own UVs, so every mesh gets its own geometry.
  const model = options.model.clone(true);
  model.traverse((child: Object3D) => {
    if ((child as Mesh).isMesh) (child as Mesh).geometry = (child as Mesh).geometry.clone();
  });
  orientation.add(model);

  const left = model.getObjectByName("left-half") as Group | undefined;
  const right = model.getObjectByName("right-half") as Group | undefined;
  const find = (name: string) => {
    const found: Mesh[] = [];
    model.traverse((child: Object3D) => {
      if ((child as Mesh).isMesh && child.name === name) found.push(child as Mesh);
    });
    return found;
  };
  const innerMeshes = [...find("inner-display-left"), ...find("inner-display-right")];
  const coverMeshes = find("cover-display");
  if (!left || !right || innerMeshes.length === 0 || coverMeshes.length === 0) {
    throw new Error("Xcode's Duo model is missing its displays.");
  }

  // Scale the open phone to a stable width so the camera framing matches.
  const inner = bounds(innerMeshes);
  const scale = DUO_OPEN_WIDTH / Math.max(inner.maxX - inner.minX, 1e-6);
  model.scale.setScalar(scale);

  // Which way the inner glass faces in model space: face it toward +Z.
  const normal = innerMeshes[0]!.geometry.getAttribute("normal");
  if (normal && normal.count > 0) {
    let sum = 0;
    for (let i = 0; i < normal.count; i++) sum += normal.getZ(i);
    if (sum < 0) model.rotation.y = Math.PI;
  }

  const innerMap: PanelMap = {
    meshes: innerMeshes,
    ...inner,
    toFrame: (x, y) => {
      const u = (x - inner.minX) / (inner.maxX - inner.minX);
      const vTop = (inner.maxY - y) / (inner.maxY - inner.minY);
      return { x: vTop, y: 1 - u };
    },
    fromFrame: (fx, fy) => ({
      x: inner.minX + (1 - fy) * (inner.maxX - inner.minX),
      y: inner.maxY - fx * (inner.maxY - inner.minY),
    }),
  };
  const cover = bounds(coverMeshes);
  const coverMap: PanelMap = {
    meshes: coverMeshes,
    ...cover,
    toFrame: (x, y) => ({
      x: (cover.maxX - x) / (cover.maxX - cover.minX),
      y: (cover.maxY - y) / (cover.maxY - cover.minY),
    }),
    fromFrame: (fx, fy) => ({
      x: cover.maxX - fx * (cover.maxX - cover.minX),
      y: cover.maxY - fy * (cover.maxY - cover.minY),
    }),
  };
  for (const mesh of innerMeshes) writeUvs(THREE, mesh.geometry, innerMap);
  for (const mesh of coverMeshes) writeUvs(THREE, mesh.geometry, coverMap);

  const liveMaterial = new THREE.MeshBasicMaterial({
    map: options.texture,
    color: options.texture ? 0xffffff : 0x111111,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  const darkMaterial = new THREE.MeshBasicMaterial({ color: 0x050506, toneMapped: false });
  const originalMaterials = new Map<Mesh, Material | Material[]>();
  for (const mesh of [...innerMeshes, ...coverMeshes]) originalMaterials.set(mesh, mesh.material);

  // The half that carries the cover stays put; the other folds over it.
  const coverHalf = (() => {
    let node: Object3D | null = coverMeshes[0]!;
    while (node && node !== left && node !== right) node = node.parent;
    return node === left ? left : right;
  })();

  let activeScreenId = options.activeScreenId;
  /*
   * Every pose change EASES: the hinge, the landscape turn and the turn that
   * shows the cover. The simulator reports its sweep in 10° steps, a preset
   * jumps 90° at once, and the cover coming on is a half turn; drawn as they
   * arrive, each read as a snap. `target*` is what was asked for, `shown*`
   * what is drawn, and `animate` closes the gap a little every frame.
   */
  let targetAngle = options.angle;
  let angle = options.angle;
  /**
   * The phone as held, about the view axis: laptop is the open phone turned
   * landscape with its hinge across. The 3D view leaves this group's Z turn to
   * this body.
   */
  let physicalTurn = 0;
  let targetTurn = 0;
  let coverYaw = 0;
  /** Tent's Table Mode: the phone stands on its edges. */
  let tableMode = false;
  /** The tip that stands the phone as it would sit on a table (`appleDuoStandTilt`). */
  let standTilt = 0;
  let lastAnimateAt = 0;
  const holder = new THREE.Group();
  holder.add(orientation);
  const stand = new THREE.Group();
  stand.add(holder);
  root.add(stand);
  const activeMap = () => (activeScreenId === APPLE_DUO_COVER_SCREEN_ID ? coverMap : innerMap);

  const paintPanels = () => {
    const coverActive = activeScreenId === APPLE_DUO_COVER_SCREEN_ID;
    for (const mesh of innerMeshes) mesh.material = coverActive ? darkMaterial : liveMaterial;
    for (const mesh of coverMeshes) mesh.material = coverActive ? liveMaterial : darkMaterial;
  };

  /**
   * Both halves turn about the hinge (model x = 0), screens toward each other.
   * When the cover is the live panel the whole phone turns so it faces the
   * viewer: the cover rides on the back of its half, which at a fold of φ
   * per half faces π − φ away from the camera.
   */
  const applyPose = () => {
    const phi = ((180 - Math.min(180, Math.max(0, angle))) / 2) * DEG;
    left.rotation.y = phi;
    right.rotation.y = -phi;
    orientation.rotation.y = coverYaw;
    // Folded, the phone is no longer centred on the hinge: keep whatever is
    // standing there centred, so the camera's fit frames it.
    model.position.set(0, 0, 0);
    orientation.updateMatrixWorld(true);
    const centerWorld = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
    // `model.position` is in its parent's (orientation's) space.
    model.position.copy(orientation.worldToLocal(centerWorld).negate());
    holder.rotation.z = physicalTurn;
    stand.rotation.x = standTilt;
  };

  const targetStandTilt = () => appleDuoStandTilt({
    angle: targetAngle,
    sideways: Math.abs(Math.abs(targetTurn) - Math.PI / 2) < 0.01,
    tableMode,
    coverLive: activeScreenId === APPLE_DUO_COVER_SCREEN_ID,
  });

  /** The turn that puts the cover toward the camera at the TARGET fold. */
  const targetCoverYaw = () => {
    if (activeScreenId !== APPLE_DUO_COVER_SCREEN_ID) return 0;
    const phi = ((180 - Math.min(180, Math.max(0, targetAngle))) / 2) * DEG;
    return coverHalf === right ? -(Math.PI - phi) : Math.PI - phi;
  };
  coverYaw = targetCoverYaw();

  paintPanels();
  applyPose();

  /** Exponential ease: ~90% of the way in 230 ms, whatever the frame rate. */
  const animate = (now: number): boolean => {
    const k = appleEaseFactor(lastAnimateAt, now, 0.1);
    lastAnimateAt = now;
    const yawGoal = targetCoverYaw();
    const tiltGoal = targetStandTilt();
    const settled = Math.abs(targetAngle - angle) < 0.05
      && Math.abs(targetTurn - physicalTurn) < 0.001
      && Math.abs(yawGoal - coverYaw) < 0.001
      && Math.abs(tiltGoal - standTilt) < 0.001;
    if (settled) {
      if (angle === targetAngle && physicalTurn === targetTurn && coverYaw === yawGoal && standTilt === tiltGoal) {
        lastAnimateAt = 0;
        return false;
      }
      angle = targetAngle;
      physicalTurn = targetTurn;
      coverYaw = yawGoal;
      standTilt = tiltGoal;
    } else {
      angle += (targetAngle - angle) * k;
      physicalTurn += (targetTurn - physicalTurn) * k;
      coverYaw += (yawGoal - coverYaw) * k;
      standTilt += (tiltGoal - standTilt) * k;
    }
    applyPose();
    return true;
  };

  const raycastActive = (raycaster: Raycaster) => {
    const map = activeMap();
    const hit = raycaster.intersectObjects(map.meshes, false)[0];
    if (!hit) return null;
    const local = (hit.object as Mesh).worldToLocal(hit.point.clone());
    return map.toFrame(local.x, local.y);
  };

  const duo: DuoBodyControls = {
    setHinge(next) {
      targetAngle = clampAppleDuoAngle(next);
    },
    setPhysicalOrientation(value, nextTableMode) {
      tableMode = nextTableMode === true;
      // A tent stands hinge up with its halves across the view: the cover
      // then faces out the way its landscape picture reads upright (checked
      // with Safari on the cover; a quarter turn the other way stood it on
      // its hinge, upside down).
      targetTurn = tableMode ? -Math.PI / 2 : PHYSICAL_TURN[value ?? ""] ?? 0;
    },
    setActivePanel(screenId) {
      if (screenId !== APPLE_DUO_COVER_SCREEN_ID && screenId !== APPLE_DUO_INNER_SCREEN_ID) return;
      if (screenId === activeScreenId) return;
      activeScreenId = screenId;
      paintPanels();
    },
    animate,
    // The 3D view's contract: framebuffer portrait coordinates of the live
    // panel, `vFromBottom` counted from the frame's bottom row.
    pickInner(raycaster) {
      const frame = raycastActive(raycaster);
      if (!frame) return null;
      const clamp = (value: number) => Math.min(1, Math.max(0, value));
      return { u: clamp(frame.x), vFromBottom: clamp(1 - frame.y) };
    },
    innerToWorld(u, vFromBottom) {
      const map = activeMap();
      const point = map.fromFrame(u, 1 - vFromBottom);
      const mesh = map.meshes.find((candidate) => {
        candidate.geometry.computeBoundingBox();
        const box = candidate.geometry.boundingBox!;
        return point.x >= box.min.x - 1e-6 && point.x <= box.max.x + 1e-6;
      }) ?? map.meshes[0]!;
      const world: Vector3 = new THREE.Vector3(point.x, point.y, map.z);
      mesh.updateWorldMatrix(true, false);
      return mesh.localToWorld(world);
    },
  };

  const openWidth = (inner.maxX - inner.minX) * scale;
  const openHeight = (inner.maxY - inner.minY) * scale;

  return {
    modelId: "duo-v68",
    root,
    orientation,
    display: innerMeshes[0]!,
    panels: [...innerMeshes, ...coverMeshes],
    screenWidth: openWidth,
    screenHeight: openHeight,
    // Fixed by the hardware: the panel mapping never depends on orientation.
    rewriteUvs: () => undefined,
    duo,
    physical: true,
    dispose() {
      for (const [mesh, material] of originalMaterials) mesh.material = material;
      liveMaterial.dispose();
      darkMaterial.dispose();
      disposeImportedSubtree(orientation, options.texture);
      orientation.remove(model);
    },
  };
}
