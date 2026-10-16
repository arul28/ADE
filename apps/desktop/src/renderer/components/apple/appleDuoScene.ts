import type { Group, Mesh, Texture } from "three";
import {
  disposeImportedSubtree,
  portraitUvToTextureUv,
  type DeviceBody,
  type DisplayLayout,
  type DuoBodyControls,
  type ThreeNS,
} from "./appleDeviceScene";
import { appleDuoPanelRotationsDeg, type AppleDuoPose } from "./appleDuo";

/**
 * The procedural iPhone Duo body.
 *
 * This is NOT a bundled GLB: there is no Duo model asset, and the bundled
 * Apple bodies carry no redistribution license, so the foldable is drawn from
 * primitives — two screen halves, two body slabs and a hinge barrel — sized
 * from the streamed inner display. It is capability-gated by the caller and
 * never built for a non-foldable device, so the GLB path pays nothing for it.
 *
 * Geometry is built in the inner display's PORTRAIT frame (width × height,
 * hinge across the middle at y = 0), exactly like the GLB bodies' normalized
 * portrait space, so `displayLayout`'s rotation term keeps working through
 * `portraitUvToTextureUv`.
 */

/** Height of the normalized body, matching the bundled GLBs. */
const DUO_BODY_HEIGHT = 2.2;
/** How far the live screen sits in front of its slab. */
const DUO_SCREEN_LIFT = 0.004;
/** The barrel radius and the slab depth, in scene units. */
const DUO_HINGE_RADIUS = 0.032;
const DUO_SLAB_DEPTH = 0.06;
const DEG = Math.PI / 180;

type Panel = {
  pivot: Group;
  screen: Mesh;
  /** The panel's centre offset from the hinge, along the portrait Y axis. */
  offsetY: number;
};

export function createProceduralDuoBody(
  THREE: ThreeNS,
  options: {
    innerAspect: number;
    texture: Texture | null;
    layout: DisplayLayout;
    pose?: AppleDuoPose;
  },
): DeviceBody {
  const screenHeight = DUO_BODY_HEIGHT;
  const aspect = Number.isFinite(options.innerAspect) && options.innerAspect > 0
    ? options.innerAspect
    : 0.46;
  const screenWidth = screenHeight * aspect;
  const gap = Math.min(0.02, screenHeight * 0.012);
  const panelHeight = screenHeight / 2 - gap / 2;

  const root = new THREE.Group();
  const orientation = new THREE.Group();
  root.add(orientation);

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
    color: 0x17171b,
    roughness: 0.62,
    metalness: 0.32,
  });
  const hingeMaterial = new THREE.MeshStandardMaterial({
    color: 0x3b3b42,
    roughness: 0.4,
    metalness: 0.72,
  });

  const panelsByMesh = new Map<Mesh, Panel>();

  const buildPanel = (sign: 1 | -1): Panel => {
    const pivot = new THREE.Group();
    const offsetY = sign * (panelHeight / 2 + gap / 2);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(screenWidth, panelHeight), screenMaterial);
    screen.position.set(0, offsetY, DUO_SCREEN_LIFT);
    screen.renderOrder = 1;
    screen.name = sign > 0 ? "duo-screen-upper" : "duo-screen-lower";
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(screenWidth + 0.08, panelHeight + 0.08, DUO_SLAB_DEPTH),
      bodyMaterial,
    );
    slab.position.set(0, offsetY, -DUO_SLAB_DEPTH / 2);
    pivot.add(slab, screen);
    orientation.add(pivot);
    const panel: Panel = { pivot, screen, offsetY };
    panelsByMesh.set(screen, panel);
    return panel;
  };

  const upper = buildPanel(1);
  const lower = buildPanel(-1);

  const hinge = new THREE.Mesh(
    new THREE.CylinderGeometry(DUO_HINGE_RADIUS, DUO_HINGE_RADIUS, screenWidth + 0.08, 20),
    hingeMaterial,
  );
  // Cylinders are born along +Y; lay the barrel across the hinge.
  hinge.rotation.z = Math.PI / 2;
  orientation.add(hinge);

  const writePanelUvs = (three: ThreeNS, layout: DisplayLayout) => {
    for (const panel of [upper, lower]) {
      const position = panel.screen.geometry.getAttribute("position");
      if (!panel.screen.geometry.hasAttribute("uv")) {
        panel.screen.geometry.setAttribute(
          "uv",
          new three.Float32BufferAttribute(new Float32Array(position.count * 2), 2),
        );
      }
      const uv = panel.screen.geometry.getAttribute("uv");
      for (let i = 0; i < position.count; i++) {
        const u = (position.getX(i) + screenWidth / 2) / screenWidth;
        const vFromBottom = ((position.getY(i) + panel.offsetY) + screenHeight / 2) / screenHeight;
        const texture = portraitUvToTextureUv(u, vFromBottom, layout);
        uv.setXY(i, texture.u, texture.v);
      }
      uv.needsUpdate = true;
    }
  };

  const applyPose = (pose: AppleDuoPose) => {
    const { upper: upperDeg, lower: lowerDeg } = appleDuoPanelRotationsDeg(pose);
    upper.pivot.rotation.x = upperDeg * DEG;
    lower.pivot.rotation.x = lowerDeg * DEG;
  };

  writePanelUvs(THREE, options.layout);
  applyPose(options.pose ?? { angle: 180, lowerFlat: false });

  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

  const duo: DuoBodyControls = {
    setHinge(angle, lowerFlat) {
      applyPose({ angle, lowerFlat });
    },
    pickInner(raycaster) {
      const hits = raycaster.intersectObjects([upper.screen, lower.screen], false);
      const hit = hits[0];
      if (!hit) return null;
      const mesh = hit.object as Mesh;
      const panel = panelsByMesh.get(mesh);
      if (!panel) return null;
      const local = mesh.worldToLocal(hit.point.clone());
      return {
        u: clamp01((local.x + screenWidth / 2) / screenWidth),
        vFromBottom: clamp01(((local.y + panel.offsetY) + screenHeight / 2) / screenHeight),
      };
    },
    innerToWorld(u, vFromBottom) {
      const panel = vFromBottom >= 0.5 ? upper : lower;
      const portraitY = (vFromBottom - 0.5) * screenHeight;
      const local = new THREE.Vector3(
        (u - 0.5) * screenWidth,
        portraitY - panel.offsetY,
        panel.screen.position.z,
      );
      panel.screen.updateWorldMatrix(true, false);
      panel.screen.localToWorld(local);
      return local;
    },
  };

  const panels: Mesh[] = [upper.screen, lower.screen];

  return {
    modelId: "duo-procedural",
    root,
    orientation,
    display: upper.screen,
    panels,
    screenWidth,
    screenHeight,
    rewriteUvs: writePanelUvs,
    duo,
    dispose() {
      // Dispose the subtree while it is still attached — the traversal walks
      // children, so emptying `orientation` first would leak every geometry.
      disposeImportedSubtree(orientation, options.texture);
      orientation.remove(upper.pivot, lower.pivot, hinge);
    },
  };
}
