import { useEffect, useRef } from "react";
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
  Shape,
  Texture,
} from "three";
import { cn } from "../ui/cn";
import {
  appleDeviceModel,
  type AppleDeviceModelId,
  type AppleDeviceModelSource,
} from "./appleDeviceModels";
import { createAppleDeviceOrbit, type AppleDeviceOrbit } from "./appleDeviceOrbit";

export type AppleDeviceFamily = "iphone" | "ipad";
export type AppleDeviceOrientation =
  | "portrait"
  | "portrait-upside-down"
  | "landscape-left"
  | "landscape-right";

export type AppleDevice3DViewProps = {
  /** The decoded device screen. The stage draws every frame into this canvas; the view samples it as a texture. */
  screenCanvas: HTMLCanvasElement | null;
  /** Increments once per drawn frame; the view re-uploads the texture when it changes and otherwise renders only on interaction. */
  frameVersion: number;
  family: AppleDeviceFamily;
  /** Product hint from the simulator device type, e.g. "iPhone 17 Pro"; the model map picks the closest body. */
  deviceTypeName: string | null;
  realistic: boolean;
  orientation: AppleDeviceOrientation;
  screenPixelSize: { width: number; height: number };
  interactive: boolean;
  onDeviceInput: (input: { phase: "begin" | "move" | "end"; x: number; y: number }) => void;
  onReady?: (info: { modelId: string | null; procedural: boolean }) => void;
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

type BodyKind = "procedural" | "imported";

type DeviceBody = {
  kind: BodyKind;
  modelId: AppleDeviceModelId | null;
  root: Group;
  orientation: Group;
  display: Mesh;
  screenWidth: number;
  screenHeight: number;
  dispose: () => void;
};

const SCREEN_HEIGHT = 2.2;
const ZOOM_MIN = Math.log(0.55);
const ZOOM_MAX = Math.log(2.4);
const CAMERA_FOV = 32;

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

function displayLayout(
  orientation: AppleDeviceOrientation,
  pixelSize: { width: number; height: number },
  canvas: HTMLCanvasElement | null,
): DisplayLayout {
  const width = canvas?.width || pixelSize.width || 390;
  const height = canvas?.height || pixelSize.height || 844;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return {
    rotation: orientationZ(orientation),
    rawLandscape: width > height,
    aspect: long > 0 ? short / long : 9 / 19.5,
  };
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

function roundedRect(THREE: ThreeNS, width: number, height: number, radius: number): Shape {
  const x = -width / 2;
  const y = -height / 2;
  const path = new THREE.Shape();
  const r = Math.min(radius, width / 2, height / 2);
  path.moveTo(x + r, y);
  path.lineTo(x + width - r, y);
  path.quadraticCurveTo(x + width, y, x + width, y + r);
  path.lineTo(x + width, y + height - r);
  path.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  path.lineTo(x + r, y + height);
  path.quadraticCurveTo(x, y + height, x, y + height - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
  return path;
}

function meshMaterials(material: Mesh["material"]): Material[] {
  return Array.isArray(material) ? material : [material];
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

function createProceduralBody(
  THREE: ThreeNS,
  family: AppleDeviceFamily,
  texture: Texture | null,
  layout: DisplayLayout,
): DeviceBody {
  const bezel = family === "ipad" ? 0.055 : 0.07;
  const screenWidth = SCREEN_HEIGHT * layout.aspect;
  const width = screenWidth + bezel * 2;
  const height = SCREEN_HEIGHT + bezel * 2;
  const depth = family === "ipad" ? 0.09 : 0.11;
  const root = new THREE.Group();
  const orientation = new THREE.Group();
  root.add(orientation);

  const metal = new THREE.MeshStandardMaterial({ color: 0xb8bfc8, metalness: 0.86, roughness: 0.28 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x12151c,
    metalness: 0.18,
    roughness: 0.22,
    clearcoat: 1,
  });
  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(roundedRect(THREE, width, height, family === "ipad" ? 0.12 : 0.22), {
      depth,
      bevelEnabled: true,
      bevelSize: 0.012,
      bevelThickness: 0.012,
      bevelSegments: 3,
      steps: 1,
      curveSegments: 12,
    }),
    metal,
  );
  body.position.z = 0.02 - depth;
  orientation.add(body);

  const face = new THREE.Mesh(
    new THREE.ShapeGeometry(roundedRect(THREE, width - 0.016, height - 0.016, family === "ipad" ? 0.1 : 0.2), 16),
    glass,
  );
  face.position.z = 0.038;
  orientation.add(face);

  const screenGeometry = new THREE.ShapeGeometry(
    roundedRect(THREE, screenWidth, SCREEN_HEIGHT, family === "ipad" ? 0.04 : 0.12),
    20,
  );
  writeScreenUvs(THREE, screenGeometry, screenWidth, SCREEN_HEIGHT, layout);
  const screenMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    color: texture ? 0xffffff : 0x111111,
    toneMapped: false,
  });
  const display = new THREE.Mesh(screenGeometry, screenMaterial);
  display.name = "device-screen";
  display.position.z = 0.042;
  orientation.add(display);

  return {
    kind: "procedural",
    modelId: null,
    root,
    orientation,
    display,
    screenWidth,
    screenHeight: SCREEN_HEIGHT,
    dispose() {
      root.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
      });
      metal.dispose();
      glass.dispose();
      screenMaterial.map = null;
      screenMaterial.dispose();
    },
  };
}

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
  });
  display.material = screenMaterial;
  display.name = "device-screen";
  const root = new THREE.Group();
  const orientation = new THREE.Group();
  orientation.add(asset);
  root.add(orientation);
  return {
    kind: "imported",
    modelId: source.id,
    root,
    orientation,
    display,
    screenWidth,
    screenHeight,
    dispose() {
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

type Viewer = {
  sync(props: AppleDevice3DViewProps): void;
  resize(width: number, height: number, pixelRatio: number): void;
  pointerDown(nx: number, ny: number, now: number): "input" | "orbit" | "none";
  pointerMove(nx: number, ny: number, dx: number, dy: number, now: number): void;
  pointerUp(nx: number, ny: number, now: number): void;
  zoomBy(logDelta: number): void;
  cancelGestures(now: number): void;
  dispose(): void;
};

function createViewer(
  THREE: ThreeNS,
  GLTFLoader: GltfLoaderCtor,
  canvas: HTMLCanvasElement,
  initial: AppleDevice3DViewProps,
  getProps: () => AppleDevice3DViewProps,
): Viewer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene: Scene = new THREE.Scene();
  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 40);
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
  let layout = displayLayout(initial.orientation, initial.screenPixelSize, initial.screenCanvas);
  let body = createProceduralBody(THREE, initial.family, null, layout);
  scene.add(body.root);
  body.root.quaternion.copy(motion.rotation);
  body.orientation.rotation.z = layout.rotation;

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

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const localHit = new THREE.Vector3();

  const applyPose = () => {
    body.root.quaternion.copy(motion.rotation);
    body.orientation.rotation.z = layout.rotation;
  };

  const fitCamera = () => {
    if (!viewport.width || !viewport.height) return;
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

  const draw = () => {
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
      const now = performance.now();
      if (motion.advance(now, reducedMotionPreferred())) applyPose();
      camera.position.z = fitDistance * Math.exp(zoomLog);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      if (motion.needsFrame()) invalidate();
    } catch {
      // WebGL can throw on a lost context; the canvas listener reports unavailability.
    }
  };

  const attachTexture = (source: HTMLCanvasElement | null) => {
    if (texture) {
      texture.dispose();
      texture = null;
    }
    if (!source) return;
    texture = new THREE.CanvasTexture(source);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
  };

  const paintDisplay = () => {
    const material = body.display.material as MeshBasicMaterial;
    material.map = texture;
    material.color.set(texture ? 0xffffff : 0x111111);
    material.needsUpdate = true;
    writeScreenUvs(THREE, body.display.geometry, body.screenWidth, body.screenHeight, layout);
  };

  const replaceBody = (next: DeviceBody) => {
    scene.remove(body.root);
    body.dispose();
    body = next;
    scene.add(body.root);
    applyPose();
    fitCamera();
    invalidate();
  };

  const announce = (info: { modelId: string | null; procedural: boolean }) => {
    getProps().onReady?.(info);
  };

  const installProcedural = (family: AppleDeviceFamily, ready: boolean) => {
    replaceBody(createProceduralBody(THREE, family, texture, layout));
    if (ready) announce({ modelId: null, procedural: true });
  };

  const loadRealistic = (source: AppleDeviceModelSource, family: AppleDeviceFamily) => {
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    const gen = ++loadGen;
    void (async () => {
      try {
        const response = await fetch(source.url, { signal: controller.signal });
        if (!response.ok) throw new Error(`model ${response.status}`);
        const data = await response.arrayBuffer();
        if (controller.signal.aborted || disposed || gen !== loadGen) return;
        const gltf = await new GLTFLoader().parseAsync(data, "");
        if (controller.signal.aborted || disposed || gen !== loadGen) {
          disposeImportedSubtree(gltf.scene, texture);
          return;
        }
        const imported = createImportedBody(THREE, gltf.scene, source, texture, layout);
        if (!imported) {
          disposeImportedSubtree(gltf.scene, texture);
          installProcedural(family, true);
          return;
        }
        replaceBody(imported);
        announce({ modelId: source.id, procedural: false });
      } catch (cause) {
        if (controller.signal.aborted || disposed || gen !== loadGen) return;
        void cause;
        installProcedural(family, true);
      }
    })();
  };

  const screenPoint = (nx: number, ny: number, captured: boolean): ScreenHit | null => {
    if (!viewport.width || !viewport.height) return null;
    applyPose();
    body.orientation.updateWorldMatrix(true, true);
    camera.updateMatrixWorld(true);
    pointerNdc.set(nx * 2 - 1, 1 - ny * 2);
    raycaster.setFromCamera(pointerNdc, camera);
    const props = getProps();
    const points = orientedPointSize(props.orientation, props.screenPixelSize);
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
    const sizeChanged =
      props.screenCanvas != null
      && texture != null
      && (texture.image?.width !== props.screenCanvas.width || texture.image?.height !== props.screenCanvas.height);
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
    body.orientation.rotation.z = layout.rotation;
    writeScreenUvs(THREE, body.display.geometry, body.screenWidth, body.screenHeight, layout);

    const modelKey = props.realistic
      ? `${props.family}:${appleDeviceModel(props.family, props.deviceTypeName).id}`
      : `procedural:${props.family}`;
    if (modelKey !== currentModelKey) {
      currentModelKey = modelKey;
      if (!props.realistic) {
        loadController?.abort();
        loadGen += 1;
        installProcedural(props.family, true);
      } else {
        installProcedural(props.family, false);
        loadRealistic(appleDeviceModel(props.family, props.deviceTypeName), props.family);
      }
    } else {
      applyPose();
      invalidate();
    }
  };

  const onContextLost = (event: Event) => {
    event.preventDefault();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

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
      invalidate();
    },
    pointerDown(nx, ny, now) {
      if (disposed) return "none";
      const props = getProps();
      if (props.interactive) {
        const hit = screenPoint(nx, ny, false);
        if (hit) {
          pointerMode = "input";
          motion.hold(true, now);
          props.onDeviceInput({ phase: "begin", ...hit });
          invalidate();
          return "input";
        }
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
    zoomBy(logDelta) {
      if (disposed || !Number.isFinite(logDelta) || logDelta === 0) return;
      zoomLog = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomLog + logDelta));
      invalidate();
    },
    cancelGestures(now) {
      if (disposed) return;
      if (pointerMode === "input") {
        const props = getProps();
        if (props.interactive) {
          const points = orientedPointSize(props.orientation, props.screenPixelSize);
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
      loadController?.abort();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      scene.remove(body.root);
      body.dispose();
      texture?.dispose();
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

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    let cancelled = false;
    let viewer: Viewer | null = null;
    let trackpadDispose: (() => void) | null = null;

    const bindTrackpad = (target: HTMLCanvasElement, next: Viewer) => {
      let gestureScale: number | null = null;
      const consume = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      const wheel = (event: WheelEvent) => {
        consume(event);
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.getBoundingClientRect().height : 1;
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
      viewer = createViewer(THREE, GLTFLoader, canvas, propsRef.current, () => propsRef.current);
      viewerRef.current = viewer;
      trackpadDispose = bindTrackpad(canvas, viewer);
      const { width, height } = host.getBoundingClientRect();
      viewer.resize(width, height, window.devicePixelRatio || 1);
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
    viewerRef.current?.sync(propsRef.current);
  }, [
    props.screenCanvas,
    props.frameVersion,
    props.family,
    props.deviceTypeName,
    props.realistic,
    props.orientation,
    props.screenPixelSize.width,
    props.screenPixelSize.height,
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

  return (
    <div ref={hostRef} className={cn("relative h-full w-full min-h-0 min-w-0 bg-black", props.className)}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const point = localPoint(event);
          lastPointer.current = { x: point.x, y: point.y };
          const mode = viewerRef.current?.pointerDown(point.nx, point.ny, performance.now());
          if (!mode || mode === "none") return;
          event.preventDefault();
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
    </div>
  );
}
