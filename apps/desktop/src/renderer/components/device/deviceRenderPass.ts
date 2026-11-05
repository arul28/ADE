import type { DirectionalLight, Mesh, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import type { DeviceBody, ThreeNS } from "./deviceScene";

/** A camera preset, or the angle the person left the device at. */
export type DeviceRenderShot = { yaw: number; pitch: number } | { current: true };

export type DeviceRenderLighting = "transparent" | "studio" | "dusk";

export type DeviceRenderOptions = {
  width: number;
  height: number;
  lighting: DeviceRenderLighting;
  /** A soft contact shadow under the phone. */
  shadow: boolean;
};

/** What the pane drives renders through; set while a 3D view is mounted. */
export type DeviceRenderer = {
  /** Stills of the body at camera presets, as PNG data URLs. */
  renderShots(shots: DeviceRenderShot[], options: DeviceRenderOptions): string[];
  /** A turntable of the body, recorded as WebM. Null when the window cannot record. */
  renderTurntable(options: DeviceRenderOptions & { seconds: number }): Promise<Blob | null>;
};

export type DeviceRenderViewport = { width: number; height: number; pixelRatio: number };

/** The parts of the live 3D view a render borrows, and gives back. */
export type DeviceRenderPassHost = {
  THREE: ThreeNS;
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  lights: { key: DirectionalLight; rim: DirectionalLight; fill: DirectionalLight };
  body: () => DeviceBody | null;
  disposed: () => boolean;
  /** Give the viewport and the drawing buffer to the render, at this size. Answers the viewport it replaced. */
  enterOffscreen: (width: number, height: number) => DeviceRenderViewport;
  /** Give the viewport back (or a resize that came meanwhile) and redraw. */
  leaveOffscreen: (saved: DeviceRenderViewport) => void;
  /** Fit the camera to the body. `zoomed` keeps the person's zoom. */
  fitCamera: (zoomed: boolean) => void;
  /** Put the newest frame of the screen on the body's texture. */
  refreshScreen: () => void;
};

/**
 * Renders of the body off the live loop, at a size and with lighting of their
 * own. Each render puts everything back exactly as the person left it: the
 * pose, the lights, the background and the viewport.
 */
export function createDeviceRenderPass(host: DeviceRenderPassHost): DeviceRenderer {
  const { THREE, scene, renderer, lights } = host;
  let shadowMesh: Mesh | null = null;
  /**
   * One render at a time. A turntable yields between frames, and a second
   * render in that gap would take the viewport and lights from under it.
   */
  let rendering = false;

  const ensureShadow = () => {
    if (shadowMesh) return shadowMesh;
    const size = 256;
    const canvas2d = document.createElement("canvas");
    canvas2d.width = size;
    canvas2d.height = size;
    const ctx = canvas2d.getContext("2d");
    if (ctx) {
      const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, "rgba(0,0,0,0.55)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    const material = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas2d), transparent: true, depthWrite: false });
    shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.renderOrder = -1;
    return shadowMesh;
  };

  const withRenderSetup = <T,>(options: DeviceRenderOptions, run: () => T): T => {
    if (rendering) throw new Error("Another render of this device is still running. Try again when it ends.");
    const body = host.body();
    if (!body) throw new Error("There is no device body to render yet.");
    rendering = true;
    // The body this render turns; restored even if a model swap replaced it.
    const turned = body;
    const { key, rim, fill } = lights;
    const saved = {
      quaternion: turned.root.quaternion.clone(),
      background: scene.background,
      key: { color: key.color.clone(), intensity: key.intensity },
      rim: { color: rim.color.clone(), intensity: rim.intensity },
      fill: { color: fill.color.clone(), intensity: fill.intensity },
    };
    if (options.lighting === "studio") {
      scene.background = new THREE.Color(0xe7e8ec);
      key.color.set(0xffffff);
      key.intensity = 5.2;
    } else if (options.lighting === "dusk") {
      scene.background = new THREE.Color(0x1d1830);
      key.color.set(0xffc58a);
      key.intensity = 4.8;
      rim.color.set(0x8fa8ff);
      fill.color.set(0x6b4fa8);
    } else {
      scene.background = null;
    }
    const shadow = options.shadow ? ensureShadow() : null;
    if (shadow) scene.add(shadow);
    const savedViewport = host.enterOffscreen(options.width, options.height);
    const restore = () => {
      rendering = false;
      if (shadow) scene.remove(shadow);
      scene.background = saved.background;
      key.color.copy(saved.key.color);
      key.intensity = saved.key.intensity;
      rim.color.copy(saved.rim.color);
      rim.intensity = saved.rim.intensity;
      fill.color.copy(saved.fill.color);
      fill.intensity = saved.fill.intensity;
      turned.root.quaternion.copy(saved.quaternion);
      host.leaveOffscreen(savedViewport);
    };
    let result: T;
    try {
      result = run();
    } catch (error) {
      restore();
      throw error;
    }
    // An async render (the turntable) restores when it settles, not now.
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  };

  const renderOne = (shot: DeviceRenderShot, options: DeviceRenderOptions) => {
    const body = host.body();
    if (!body) return;
    // A still is of the pose, not of the way there: finish any fold ease.
    for (let step = 0, at = performance.now(); step < 80 && body.duo?.animate?.(at); step++) at += 100;
    if (!("current" in shot)) body.root.quaternion.setFromEuler(new THREE.Euler(shot.pitch, shot.yaw, 0, "YXZ"));
    body.orientation.updateWorldMatrix(true, true);
    host.fitCamera("current" in shot);
    if (shadowMesh && options.shadow) {
      const bounds = new THREE.Box3().setFromObject(body.root);
      const size = bounds.getSize(new THREE.Vector3());
      shadowMesh.position.set(0, bounds.min.y - 0.01, 0);
      shadowMesh.scale.set(size.x * 1.2, Math.max(size.z, size.x * 0.35), 1);
    }
    host.refreshScreen();
    renderer.render(scene, host.camera);
  };

  return {
    renderShots(shots, options) {
      return withRenderSetup(options, () => shots.map((shot) => {
        renderOne(shot, options);
        return renderer.domElement.toDataURL("image/png");
      }));
    },
    async renderTurntable(options) {
      if (typeof MediaRecorder === "undefined") return null;
      const recorderCanvas = document.createElement("canvas");
      recorderCanvas.width = options.width;
      recorderCanvas.height = options.height;
      const ctx = recorderCanvas.getContext("2d");
      if (!ctx) return null;
      const stream = recorderCanvas.captureStream(30);
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();
      const frames = Math.max(30, Math.round(options.seconds * 30));
      try {
        await withRenderSetup(options, async () => {
          for (let frame = 0; frame < frames; frame++) {
            if (host.disposed()) throw new Error("The 3D view closed during the render.");
            const yaw = -0.6 + (Math.PI * 2 * frame) / frames;
            renderOne({ yaw, pitch: 0.12 }, options);
            ctx.clearRect(0, 0, options.width, options.height);
            ctx.drawImage(renderer.domElement, 0, 0, options.width, options.height);
            await new Promise((resolve) => setTimeout(resolve, 1000 / 30));
          }
        });
      } finally {
        // The recorder and its stream stop whether the loop finished or threw.
        if (recorder.state !== "inactive") recorder.stop();
        await stopped;
        for (const track of stream.getTracks()) track.stop();
      }
      return new Blob(chunks, { type: "video/webm" });
    },
  };
}
