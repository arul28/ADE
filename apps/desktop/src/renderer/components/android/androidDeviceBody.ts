// The Android bodies for the shared 3D view (`device/Device3DView`): the
// procedural body every Android profile can use, and a bundled GLB where the
// catalog names one. Three.js is passed in, so this module never pulls it into
// a flat-only bundle.
import type { BufferGeometry, Group, Material, Mesh, MeshStandardMaterial, Texture } from "three";
import type {
  AndroidCatalogBodyShape,
  AndroidCatalogColor,
  AndroidCatalogEntry,
} from "../../../shared/androidDeviceCatalog";
import { androidCatalogColor } from "../../../shared/androidDeviceCatalog";
import type { AndroidHardwareProfile } from "../../../shared/types/androidEmulator";
import type { DeviceBodySource } from "../device/Device3DView";
import { loadDeviceModelInstance } from "../device/deviceModelLoader";
import {
  createImportedBody,
  disposeImportedSubtree,
  writeScreenUvs,
  type DeviceBody,
  type DisplayLayout,
  type ThreeNS,
} from "../device/deviceScene";
import { createProceduralFoldBody } from "../device/proceduralFoldBody";
import { androidDeviceModelSource } from "./androidDeviceModels";

/** The scene's screen height for a portrait device (the GLB contract: height 2.2). */
const SCREEN_HEIGHT_UNITS = 2.2;
/** How far in front of the glass the live screen sits (see `SCREEN_LIFT` in `deviceScene.ts`). */
const SCREEN_LIFT = 0.002;

/** The neutral body of a device with no catalog entry. */
export const ANDROID_DEFAULT_BODY_COLOR: AndroidCatalogColor = { id: "graphite", name: "Graphite", body: "#2a2c30", frame: "#3a3d42" };

/** What the 3D body is drawn from: a catalog entry, or a bare hardware profile ("More…"). */
export type AndroidBodySpec = {
  /** The catalog entry, when the AVD was made from one. */
  entry: AndroidCatalogEntry | null;
  /** The profile (for a body with no entry: its screen size and form factor). */
  profile: Pick<AndroidHardwareProfile, "screenInches" | "widthPx" | "heightPx" | "formFactor"> | null;
  colorId: string | null;
};

export function androidBodyColor(spec: AndroidBodySpec): AndroidCatalogColor {
  return spec.entry ? androidCatalogColor(spec.entry, spec.colorId) : ANDROID_DEFAULT_BODY_COLOR;
}

/**
 * The shape a body is drawn at. A catalog entry has its spec-sheet shape; a
 * bare profile gets one sized from its diagonal and aspect, with the bezel and
 * corners of its form factor.
 */
export function androidBodyShape(spec: AndroidBodySpec, screenAspect: number): AndroidCatalogBodyShape {
  if (spec.entry) return spec.entry.body;
  const formFactor = spec.profile?.formFactor ?? "phone";
  const inches = spec.profile?.screenInches && spec.profile.screenInches > 0 ? spec.profile.screenInches : 6.3;
  const aspect = screenAspect > 0 && screenAspect <= 1 ? screenAspect : 9 / 20;
  const diagonalMm = inches * 25.4;
  const shortMm = diagonalMm * aspect / Math.hypot(1, aspect);
  if (formFactor === "wear") {
    return { widthMm: shortMm + 7, heightMm: shortMm + 7, depthMm: 11, cornerMm: shortMm / 2, bezelMm: 3.5, rearCamera: "none", frontCamera: "none", round: true };
  }
  const tablet = formFactor === "tablet" || inches >= 7.5;
  const bezel = tablet ? 10 : formFactor === "foldable" ? 2.6 : 2;
  const width = shortMm + bezel * 2;
  return {
    widthMm: width,
    heightMm: shortMm / aspect + bezel * 2,
    depthMm: tablet ? 7 : formFactor === "foldable" ? 5.5 : 8.4,
    cornerMm: tablet ? 12 : width * 0.13,
    bezelMm: bezel,
    rearCamera: tablet ? "none" : "island",
    frontCamera: "punch",
  };
}

/** A rounded rectangle centred on the origin. */
function roundedRect(THREE: ThreeNS, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const x = -width / 2;
  const y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}

function circleShape(THREE: ThreeNS, radius: number) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
  return shape;
}

type BodyMaterials = {
  back: MeshStandardMaterial;
  frame: MeshStandardMaterial;
  glass: MeshStandardMaterial;
  lensGlass: MeshStandardMaterial;
  visor: MeshStandardMaterial;
  hole: MeshStandardMaterial;
};

function createMaterials(THREE: ThreeNS, color: AndroidCatalogColor): BodyMaterials {
  return {
    // Frosted back glass: a little sheen, no mirror (the scene has no environment map).
    back: new THREE.MeshStandardMaterial({ color: color.body, roughness: 0.42, metalness: 0.08 }),
    // The aluminium or titanium band and the buttons.
    frame: new THREE.MeshStandardMaterial({ color: color.frame, roughness: 0.3, metalness: 0.35 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.08, metalness: 0.2 }),
    lensGlass: new THREE.MeshStandardMaterial({ color: 0x0b1020, roughness: 0.05, metalness: 0.6 }),
    visor: new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.12, metalness: 0.3 }),
    hole: new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.3, metalness: 0 }),
  };
}

/** A lens: a metal ring and a dark glass disc, facing −Z (the back). */
function addLens(THREE: ThreeNS, parent: Group, materials: BodyMaterials, x: number, y: number, z: number, radius: number): void {
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, radius * 0.35, 40), materials.frame);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, y, z - radius * 0.175);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.74, 40), materials.lensGlass);
  glass.rotation.y = Math.PI;
  glass.position.set(x, y, z - radius * 0.36);
  parent.add(ring, glass);
}

export type AndroidProceduralBodyInput = {
  shape: AndroidCatalogBodyShape;
  color: AndroidCatalogColor;
  /** Short side over long side of the screen, from the profile or the stream. */
  screenAspect: number;
  /** A tablet's front camera is on its long edge (it is held landscape). */
  formFactor: string | null;
  foldable: boolean;
  texture: Texture | null;
  layout: DisplayLayout;
};

/**
 * The procedural Android body: a rounded slab with a band, cover glass, the
 * live screen (`device-screen`), the front camera hole, the rear camera
 * (Pixel's bar, an island, or Samsung's three lenses), the side buttons, and
 * a hinge seam on a foldable. A round body with a crown for a watch.
 *
 * Built in scene units with the screen centred on the origin, so the shared
 * view's touch mapping (`screenWidth` × `screenHeight` about the origin) holds.
 */
export function createAndroidProceduralBody(THREE: ThreeNS, input: AndroidProceduralBodyInput, modelId: string): DeviceBody {
  const { shape } = input;
  const aspect = input.screenAspect > 0 && input.screenAspect <= 1 ? input.screenAspect : 9 / 20;
  const round = shape.round === true;
  const screenWmm = round ? shape.widthMm - shape.bezelMm * 2 : Math.max(10, shape.widthMm - shape.bezelMm * 2);
  const screenHmm = round ? screenWmm : screenWmm / aspect;
  const unit = SCREEN_HEIGHT_UNITS / screenHmm;
  const screenW = screenWmm * unit;
  const screenH = screenHmm * unit;
  const bezel = shape.bezelMm * unit;
  const bodyW = screenW + bezel * 2;
  const bodyH = round ? bodyW : screenH + bezel * 2;
  const depth = shape.depthMm * unit;
  const corner = round ? bodyW / 2 : Math.min(shape.cornerMm * unit, bodyW / 2);
  const materials = createMaterials(THREE, input.color);
  const geometries: BufferGeometry[] = [];
  const track = <T extends BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };

  const asset = new THREE.Group();
  asset.name = "android-procedural-body";

  // The slab: an extrusion with a rounded bevel, so the edges catch the light.
  const bevel = Math.min(depth * 0.42, corner * 0.6);
  const outline = round ? circleShape(THREE, bodyW / 2 - bevel) : roundedRect(THREE, bodyW - bevel * 2, bodyH - bevel * 2, Math.max(0.001, corner - bevel));
  const slabGeometry = track(new THREE.ExtrudeGeometry(outline, {
    depth: Math.max(0.001, depth - bevel * 2),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 6,
    curveSegments: 28,
  }));
  slabGeometry.translate(0, 0, -depth / 2 + bevel);
  // Group 0 is the caps (the back is the body colour), group 1 the band.
  const slab = new THREE.Mesh(slabGeometry, [materials.back, materials.frame]);
  slab.name = "device-body";
  asset.add(slab);

  // The cover glass over the whole front.
  const front = depth / 2;
  const glassInset = Math.min(bevel * 0.8, bezel * 0.5);
  const glassOutline = round ? circleShape(THREE, bodyW / 2 - glassInset) : roundedRect(THREE, bodyW - glassInset * 2, bodyH - glassInset * 2, Math.max(0.001, corner - glassInset));
  const glassGeometry = track(new THREE.ShapeGeometry(glassOutline, 28));
  const glass = new THREE.Mesh(glassGeometry, materials.glass);
  glass.position.z = front + 0.0015;
  asset.add(glass);

  // The live screen.
  const screenCorner = round ? screenW / 2 : Math.max(0.02, corner - bezel);
  const screenOutline = round ? circleShape(THREE, screenW / 2) : roundedRect(THREE, screenW, screenH, screenCorner);
  const screenGeometry = track(new THREE.ShapeGeometry(screenOutline, 28));
  writeScreenUvs(THREE, screenGeometry, screenW, screenH, input.layout);
  const screenMaterial = new THREE.MeshBasicMaterial({
    map: input.texture,
    color: input.texture ? 0xffffff : 0x111111,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  const display = new THREE.Mesh(screenGeometry, screenMaterial);
  display.name = "device-screen";
  display.position.z = front + 0.0015 + SCREEN_LIFT;
  display.renderOrder = 1;
  asset.add(display);

  // The front camera, drawn over the picture as on the real glass.
  if (shape.frontCamera === "punch") {
    const radius = 1.45 * unit;
    const tablet = input.formFactor === "tablet";
    const hole = new THREE.Mesh(track(new THREE.CircleGeometry(radius, 32)), materials.hole);
    // A tablet is held landscape: its camera sits in the long side's bezel.
    if (tablet) hole.position.set(screenW / 2 + bezel / 2, 0, display.position.z + 0.0005);
    else hole.position.set(0, screenH / 2 - 4.2 * unit, display.position.z + 0.0005);
    hole.renderOrder = 2;
    asset.add(hole);
  }

  const back = -depth / 2;
  if (shape.rearCamera === "bar") {
    // Pixel's camera bar: a band across the back with a dark visor and lenses.
    const barH = 11.5 * unit;
    const barW = bodyW - 2.4 * unit;
    const barDepth = 1.6 * unit;
    const barY = bodyH / 2 - 17 * unit;
    const barGeometry = track(new THREE.ExtrudeGeometry(roundedRect(THREE, barW, barH, barH / 2), {
      depth: barDepth * 0.6,
      bevelEnabled: true,
      bevelThickness: barDepth * 0.2,
      bevelSize: barDepth * 0.2,
      bevelSegments: 4,
      curveSegments: 20,
    }));
    const bar = new THREE.Mesh(barGeometry, materials.frame);
    bar.position.set(0, barY, back - barDepth * 0.8);
    asset.add(bar);
    const visorW = barW * 0.62;
    const visor = new THREE.Mesh(track(new THREE.ShapeGeometry(roundedRect(THREE, visorW, barH * 0.78, barH * 0.39), 20)), materials.visor);
    visor.rotation.y = Math.PI;
    // Seen from the back the visor and its lenses are on the left: +x in the
    // body's own (front-facing) frame.
    visor.position.set(barW / 2 - visorW / 2 - barH * 0.11, barY, back - barDepth * 1.01);
    asset.add(visor);
    const lensR = barH * 0.3;
    const lensZ = back - barDepth * 1.02;
    const startX = barW / 2 - barH * 0.62;
    for (let index = 0; index < 3; index += 1) addLens(THREE, asset, materials, startX - index * lensR * 2.5, barY, lensZ, lensR);
  } else if (shape.rearCamera === "island") {
    const size = Math.min(26 * unit, bodyW * 0.42);
    const islandDepth = 1.4 * unit;
    // Top left seen from the back: +x in the body's front-facing frame.
    const islandX = bodyW / 2 - size / 2 - 4 * unit;
    const islandY = bodyH / 2 - size / 2 - 4 * unit;
    const island = new THREE.Mesh(track(new THREE.ExtrudeGeometry(roundedRect(THREE, size, size, size * 0.32), {
      depth: islandDepth * 0.6,
      bevelEnabled: true,
      bevelThickness: islandDepth * 0.2,
      bevelSize: islandDepth * 0.2,
      bevelSegments: 4,
      curveSegments: 20,
    })), materials.visor);
    island.position.set(islandX, islandY, back - islandDepth * 0.8);
    asset.add(island);
    const lensR = size * 0.17;
    const lensZ = back - islandDepth * 1.02;
    addLens(THREE, asset, materials, islandX + size * 0.22, islandY + size * 0.22, lensZ, lensR);
    addLens(THREE, asset, materials, islandX + size * 0.22, islandY - size * 0.22, lensZ, lensR);
    addLens(THREE, asset, materials, islandX - size * 0.22, islandY + size * 0.22, lensZ, lensR);
  } else if (shape.rearCamera === "triple-vertical") {
    const lensR = 4.6 * unit;
    // Samsung's lenses run down the top left of the back: +x from the front.
    const x = bodyW / 2 - 10 * unit;
    for (let index = 0; index < 3; index += 1) {
      addLens(THREE, asset, materials, x, bodyH / 2 - 11 * unit - index * lensR * 2.45, back - 0.2 * unit, lensR);
    }
  }

  // A foldable: the hinge seam down the back.
  if (input.foldable) {
    const seam = new THREE.Mesh(track(new THREE.PlaneGeometry(0.5 * unit, bodyH - corner)), materials.visor);
    seam.rotation.y = Math.PI;
    seam.position.set(0, 0, back - 0.0008);
    asset.add(seam);
  }

  // Buttons on the right edge (a crown on a watch).
  if (round) {
    const crown = new THREE.Mesh(track(new THREE.CylinderGeometry(3.6 * unit, 3.6 * unit, 3 * unit, 32)), materials.frame);
    crown.rotation.z = Math.PI / 2;
    crown.position.set(bodyW / 2 + 1.2 * unit, 0, 0);
    asset.add(crown);
  } else {
    const buttonDepth = Math.min(depth * 0.36, 2.6 * unit);
    const buttonOut = 0.7 * unit;
    const tablet = input.formFactor === "tablet";
    const add = (length: number, fromTop: number) => {
      const button = new THREE.Mesh(
        track(new THREE.BoxGeometry(buttonOut, length * unit, buttonDepth)),
        materials.frame,
      );
      // On the right edge; a tablet is held landscape, so that is its top.
      button.position.set(bodyW / 2 + buttonOut * 0.3, bodyH / 2 - fromTop * unit - length * unit / 2, 0);
      asset.add(button);
    };
    add(10, tablet ? 30 : 33);
    add(20, tablet ? 46 : 50);
  }

  const orientation = new THREE.Group();
  orientation.add(asset);
  const root = new THREE.Group();
  root.add(orientation);
  const allMaterials: Material[] = [...Object.values(materials), screenMaterial];

  return {
    modelId,
    root,
    orientation,
    display,
    panels: [display],
    screenWidth: screenW,
    screenHeight: screenH,
    rewriteUvs(three, layout) {
      writeScreenUvs(three, screenGeometry, screenW, screenH, layout);
    },
    dispose() {
      orientation.remove(asset);
      screenMaterial.map = null;
      for (const geometry of geometries) geometry.dispose();
      for (const material of allMaterials) material.dispose();
    },
  };
}

/** Recolour a body in place: its colour materials, by name. */
function recolorBody(body: DeviceBody, color: AndroidCatalogColor): void {
  body.root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      const standard = material as MeshStandardMaterial;
      if (!standard.color) continue;
      // Procedural body: the slab's caps and band. GLB: the materials the
      // conversion named `device-body` and `device-frame`.
      if (mesh.name === "device-body" && list.length === 2) {
        standard.color.set(list.indexOf(material) === 0 ? color.body : color.frame);
      } else if (material.name === "device-body") {
        standard.color.set(color.body);
      } else if (material.name === "device-frame") {
        standard.color.set(color.frame);
      }
    }
  });
  // The procedural body's buttons, lens rings and camera bar share the band's
  // one material, so they follow it.
}

/**
 * A foldable's hinge, for its body (P3 fold). Open or half open, the inner
 * screen shows on two panels that fold at `angle`; shut, the cover screen
 * shows on the folded phone (half as wide, twice as thick).
 */
export type AndroidFoldView = {
  angle: number;
  /** The stream shows the cover screen: the phone is shut. */
  cover: boolean;
};

/** The shut foldable: one half of the open body, twice as thick, with no seam on its back. */
function androidCoverShape(shape: AndroidCatalogBodyShape): AndroidCatalogBodyShape {
  return { ...shape, widthMm: shape.widthMm / 2, depthMm: shape.depthMm * 2 };
}

/**
 * The open foldable: the shared two-panel body (`device/proceduralFoldBody`)
 * in the catalog colour, with the hinge down the inner screen as on a Pixel
 * Fold or a Galaxy Z Fold (across it, if the inner screen is wider than tall).
 */
function androidFoldBodySource(
  spec: AndroidBodySpec,
  identity: string,
  screenAspect: number,
  angle: number,
): DeviceBodySource {
  const color = androidBodyColor(spec);
  const shape = androidBodyShape(spec, screenAspect);
  const aspect = screenAspect > 0 && screenAspect <= 1 ? screenAspect : 0.96;
  const wide = (spec.entry?.screen.widthPx ?? spec.profile?.widthPx ?? 0) > (spec.entry?.screen.heightPx ?? spec.profile?.heightPx ?? Infinity);
  // Scene units per millimetre: the inner screen's long side is the body height (2.2).
  const unit = SCREEN_HEIGHT_UNITS / (Math.max(10, shape.widthMm - shape.bezelMm * 2) / aspect);
  return {
    key: `${identity}:${aspect.toFixed(3)}:fold`,
    build: ({ THREE, texture, layout }) => createProceduralFoldBody(THREE, {
      innerAspect: aspect,
      texture,
      layout,
      angle,
      hingeAxis: wide ? "across" : "down",
      look: { body: color.body, hinge: color.frame, bezel: shape.bezelMm * unit, slabDepth: shape.depthMm * unit },
      modelId: `${identity}:fold`,
    }),
    update: (body) => {
      recolorBody(body, color);
      body.duo?.setHinge(angle);
      // Folding changes the phone's shape: frame it again.
      return true;
    },
  };
}

/**
 * The 3D body source for an Android device. The key covers what changes the
 * body's shape (the entry or profile, and the screen aspect); the colour is
 * an `update`, so a new colour never rebuilds the body or its GPU buffers.
 * `fold` is set for a foldable whose emulator is booted.
 */
export function androidBodySource(spec: AndroidBodySpec, screenAspect: number, fold: AndroidFoldView | null = null): DeviceBodySource {
  const identity = spec.entry ? `catalog:${spec.entry.id}` : `profile:${spec.profile?.formFactor ?? "phone"}:${spec.profile?.screenInches ?? ""}`;
  if (fold && !fold.cover) return androidFoldBodySource(spec, identity, screenAspect, fold.angle);
  const color = androidBodyColor(spec);
  const openShape = androidBodyShape(spec, screenAspect);
  const shape = fold?.cover ? androidCoverShape(openShape) : openShape;
  const formFactor = spec.entry?.formFactor ?? spec.profile?.formFactor ?? null;
  const aspectKey = screenAspect.toFixed(3);
  const model = spec.entry?.model && !fold ? androidDeviceModelSource(spec.entry.model) : null;
  return {
    key: `${identity}:${aspectKey}:${model ? "glb" : fold?.cover ? "cover" : "procedural"}`,
    build: async ({ THREE, GLTFLoader, texture, layout }) => {
      if (model) {
        try {
          const scene = await loadDeviceModelInstance(model, THREE, GLTFLoader);
          const imported = createImportedBody(THREE, scene, model, texture, layout);
          if (imported) {
            recolorBody(imported, color);
            return imported;
          }
          disposeImportedSubtree(scene, texture);
        } catch {
          // A model that will not load: the procedural body stands in.
        }
      }
      return createAndroidProceduralBody(THREE, {
        shape,
        color,
        screenAspect,
        formFactor,
        // The seam down the back is the open phone's; shut, the hinge is an edge.
        foldable: formFactor === "foldable" && !fold?.cover,
        texture,
        layout,
      }, identity);
    },
    update: (body) => {
      recolorBody(body, color);
      return false;
    },
  };
}
