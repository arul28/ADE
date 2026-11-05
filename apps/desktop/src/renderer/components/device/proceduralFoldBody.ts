import type { Group, Mesh, Texture, Vector3 } from "three";
import {
  disposeImportedSubtree,
  portraitUvToTextureUv,
  type DeviceBody,
  type DisplayLayout,
  type DuoBodyControls,
  type ThreeNS,
} from "./deviceScene";

/**
 * The procedural foldable body: the iPhone Duo, and an Android foldable
 * (Pixel Fold, Galaxy Z Fold) with its inner screen showing.
 *
 * This is NOT a bundled GLB: there is no licensed foldable model, so the body
 * is drawn from primitives — two screen halves, two body slabs and a hinge
 * barrel — sized from the streamed inner display. The caller builds it only
 * for a device that folds, so the GLB path pays nothing for it.
 *
 * The hinge runs across the inner display (the Duo: an upper and a lower
 * half) or down it (a book-style Android foldable: a left and a right half).
 * Geometry is built in a FOLD frame where the hinge is always across, at
 * y = 0; for a hinge down the display the frame turns a quarter. Every
 * coordinate the view sees stays in the inner display's PORTRAIT frame
 * (width × height, as the GLB bodies' normalized portrait space), so
 * `displayLayout`'s rotation term keeps working through `portraitUvToTextureUv`.
 */

/** Height of the normalized body, matching the bundled GLBs. */
const FOLD_BODY_HEIGHT = 2.2;
/** How far the live screen sits in front of its slab. */
const FOLD_SCREEN_LIFT = 0.004;
const FOLD_HINGE_RADIUS = 0.032;
const FOLD_SLAB_DEPTH = 0.06;
/** The slab's margin round each screen half. */
const FOLD_BEZEL = 0.04;
const DEG = Math.PI / 180;

/** Across the display (upper and lower halves) or down it (left and right). */
export type FoldHingeAxis = "across" | "down";

export type FoldBodyLook = {
  /** Body and band colours (`#rrggbb` or a number). */
  body?: string | number;
  hinge?: string | number;
  /** The slab's margin round each half, and its depth, in scene units. */
  bezel?: number;
  slabDepth?: number;
};

/**
 * How far each half turns about the hinge, in degrees. Positive on the first
 * half and negative on the second both bring the faces toward the viewer
 * (+Z), so at 90° each the halves meet and the device is shut.
 */
export function foldPanelRotationsDeg(angle: number): { first: number; second: number } {
  const clamped = Math.min(180, Math.max(0, Number.isFinite(angle) ? angle : 180));
  const fold = (180 - clamped) / 2;
  return { first: fold, second: fold === 0 ? 0 : -fold };
}

type Panel = {
  pivot: Group;
  screen: Mesh;
  /** The panel's centre offset from the hinge, along the fold frame's Y axis. */
  offsetY: number;
};

export function createProceduralFoldBody(
  THREE: ThreeNS,
  options: {
    /** The inner display's portrait width over its height. */
    innerAspect: number;
    texture: Texture | null;
    layout: DisplayLayout;
    angle?: number;
    hingeAxis?: FoldHingeAxis;
    look?: FoldBodyLook;
    modelId?: string;
  },
): DeviceBody {
  const down = options.hingeAxis === "down";
  const screenHeight = FOLD_BODY_HEIGHT;
  const aspect = Number.isFinite(options.innerAspect) && options.innerAspect > 0
    ? options.innerAspect
    : 0.46;
  const screenWidth = screenHeight * aspect;
  // The fold frame: the hinge runs along its X axis.
  const frameWidth = down ? screenHeight : screenWidth;
  const frameHeight = down ? screenWidth : screenHeight;
  const gap = Math.min(0.02, frameHeight * 0.012);
  const panelHeight = frameHeight / 2 - gap / 2;
  const bezel = options.look?.bezel ?? FOLD_BEZEL;
  const slabDepth = options.look?.slabDepth ?? FOLD_SLAB_DEPTH;

  /** A fold frame point in the portrait frame (a quarter turn for a hinge down the display). */
  const frameToPortrait = (x: number, y: number) => (down ? { x: y, y: -x } : { x, y });
  const portraitToFrame = (x: number, y: number) => (down ? { x: -y, y: x } : { x, y });

  const root = new THREE.Group();
  const orientation = new THREE.Group();
  root.add(orientation);
  const frame = new THREE.Group();
  if (down) frame.rotation.z = -Math.PI / 2;
  orientation.add(frame);

  const screenMaterial = new THREE.MeshBasicMaterial({
    map: options.texture,
    color: options.texture ? 0xffffff : 0x111111,
    toneMapped: false,
    // Either half may face away from the camera once folded, so the live
    // picture does not blink out of existence at a steep posture.
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: options.look?.body ?? 0x17171b,
    roughness: 0.62,
    metalness: 0.32,
  });
  const hingeMaterial = new THREE.MeshStandardMaterial({
    color: options.look?.hinge ?? 0x3b3b42,
    roughness: 0.4,
    metalness: 0.72,
  });
  // The names a recolour finds (as a GLB's `device-body` and `device-frame`).
  bodyMaterial.name = "device-body";
  hingeMaterial.name = "device-frame";

  const panelsByMesh = new Map<Mesh, Panel>();

  const buildPanel = (sign: 1 | -1): Panel => {
    const pivot = new THREE.Group();
    const offsetY = sign * (panelHeight / 2 + gap / 2);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(frameWidth, panelHeight), screenMaterial);
    screen.position.set(0, offsetY, FOLD_SCREEN_LIFT);
    screen.renderOrder = 1;
    screen.name = sign > 0 ? "fold-screen-first" : "fold-screen-second";
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(frameWidth + bezel * 2, panelHeight + bezel * 2, slabDepth),
      bodyMaterial,
    );
    slab.name = "device-body";
    slab.position.set(0, offsetY, -slabDepth / 2);
    pivot.add(slab, screen);
    frame.add(pivot);
    const panel: Panel = { pivot, screen, offsetY };
    panelsByMesh.set(screen, panel);
    return panel;
  };

  const first = buildPanel(1);
  const second = buildPanel(-1);

  const hinge = new THREE.Mesh(
    new THREE.CylinderGeometry(FOLD_HINGE_RADIUS, FOLD_HINGE_RADIUS, frameWidth + bezel * 2, 20),
    hingeMaterial,
  );
  hinge.name = "device-hinge";
  // Cylinders are born along +Y; lay the barrel along the hinge.
  hinge.rotation.z = Math.PI / 2;
  frame.add(hinge);

  /** A point on a panel's screen mesh, as continuous inner-display portrait (u, v). */
  const portraitUv = (panel: Panel, localX: number, localY: number) => {
    const point = frameToPortrait(localX, localY + panel.offsetY);
    return {
      u: (point.x + screenWidth / 2) / screenWidth,
      vFromBottom: (point.y + screenHeight / 2) / screenHeight,
    };
  };

  const writePanelUvs = (three: ThreeNS, layout: DisplayLayout) => {
    for (const panel of [first, second]) {
      const position = panel.screen.geometry.getAttribute("position");
      if (!panel.screen.geometry.hasAttribute("uv")) {
        panel.screen.geometry.setAttribute(
          "uv",
          new three.Float32BufferAttribute(new Float32Array(position.count * 2), 2),
        );
      }
      const uv = panel.screen.geometry.getAttribute("uv");
      for (let i = 0; i < position.count; i++) {
        const { u, vFromBottom } = portraitUv(panel, position.getX(i), position.getY(i));
        const texture = portraitUvToTextureUv(u, vFromBottom, layout);
        uv.setXY(i, texture.u, texture.v);
      }
      uv.needsUpdate = true;
    }
  };

  const applyHinge = (angle: number) => {
    const turns = foldPanelRotationsDeg(angle);
    first.pivot.rotation.x = turns.first * DEG;
    second.pivot.rotation.x = turns.second * DEG;
  };

  writePanelUvs(THREE, options.layout);
  applyHinge(options.angle ?? 180);

  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

  const duo: DuoBodyControls = {
    setHinge: applyHinge,
    pickInner(raycaster) {
      const hits = raycaster.intersectObjects([first.screen, second.screen], false);
      const hit = hits[0];
      if (!hit) return null;
      const mesh = hit.object as Mesh;
      const panel = panelsByMesh.get(mesh);
      if (!panel) return null;
      const local = mesh.worldToLocal(hit.point.clone());
      const point = portraitUv(panel, local.x, local.y);
      return { u: clamp01(point.u), vFromBottom: clamp01(point.vFromBottom) };
    },
    innerToWorld(u, vFromBottom): Vector3 {
      const point = portraitToFrame((u - 0.5) * screenWidth, (vFromBottom - 0.5) * screenHeight);
      const panel = point.y >= 0 ? first : second;
      const local = new THREE.Vector3(point.x, point.y - panel.offsetY, panel.screen.position.z);
      panel.screen.updateWorldMatrix(true, false);
      panel.screen.localToWorld(local);
      return local;
    },
  };

  return {
    modelId: options.modelId ?? "fold-procedural",
    root,
    orientation,
    display: first.screen,
    panels: [first.screen, second.screen],
    screenWidth,
    screenHeight,
    rewriteUvs: writePanelUvs,
    duo,
    dispose() {
      // Dispose the subtree while it is still attached — the traversal walks
      // children, so emptying `frame` first would leak every geometry.
      disposeImportedSubtree(orientation, options.texture);
      frame.remove(first.pivot, second.pivot, hinge);
    },
  };
}
