/**
 * `window.ade.androidEmulator` for the Vite-only preview (`browserMock.ts`).
 *
 * Six AVDs shaped like the owner's machines (plan §9), an SDK that is found,
 * and one lane device booted, so the Android pane renders without a brain.
 * `?mockAndroid=<scenario>` picks another state to look at:
 *
 * - `live` (default): the lane's AVD is booted and streams a drawn test screen.
 * - `picker`: the lane holds nothing.
 * - `setup`: no SDK.  `noaccel`: the SDK, no acceleration.
 * - `starting`, `off`, `crashed`, `unsupported`.
 *
 * The live picture is real H.264: a canvas encoded with WebCodecs and served
 * through a `fetch` stand-in for one fake loopback address, in the same video
 * records the brain writes. A touch draws a dot where it landed (scaled from
 * device pixels), and `window.__adeMockAndroidTouches` keeps every touch, so
 * the pointer mapping can be checked by eye and by number.
 */

import type {
  AndroidAvdListing,
  AndroidEmulatorEvent,
  AndroidEmulatorPreloadApi,
  AndroidEmulatorStatus,
  AndroidHardwareProfile,
  AndroidLaneDeviceStatus,
  AndroidSdkStatus,
  AndroidTouchEvent,
} from "../shared/types/androidEmulator";
import {
  IOS_VIDEO_RECORD_FLAG_KEYFRAME,
  IOS_VIDEO_RECORD_HEADER_BYTES,
  IOS_VIDEO_RECORD_MAGIC,
  IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT,
  IOS_VIDEO_RECORD_TYPE_CONFIG,
} from "../shared/types/iosSimulator";

type Scenario = "live" | "picker" | "setup" | "noaccel" | "starting" | "off" | "crashed" | "unsupported";

const MOCK_STREAM_PATH = "/android-mock-stream";
const MOCK_STREAM_URL = `http://127.0.0.1:9${MOCK_STREAM_PATH}`;
/** The video is the lane AVD's 1080×2400 at the brain's 1280 px long side, rounded to even. */
const VIDEO_WIDTH = 576;
const VIDEO_HEIGHT = 1280;
const LCD = { width: 1080, height: 2400 };

function scenario(): Scenario {
  try {
    const value = new URLSearchParams(window.location.search).get("mockAndroid");
    const known: Scenario[] = ["live", "picker", "setup", "noaccel", "starting", "off", "crashed", "unsupported"];
    return known.includes(value as Scenario) ? (value as Scenario) : "live";
  } catch {
    return "live";
  }
}

const PROFILES: AndroidHardwareProfile[] = [
  { id: "medium_phone", name: "Medium Phone", origin: "sdk", screenInches: 6.4, widthPx: 1080, heightPx: 2400, density: 420, formFactor: "phone" },
  { id: "small_phone", name: "Small Phone", origin: "sdk", screenInches: 4.65, widthPx: 720, heightPx: 1280, density: 320, formFactor: "phone" },
  { id: "pixel_9", name: "Pixel 9", origin: "sdk", screenInches: 6.3, widthPx: 1080, heightPx: 2424, density: 420, formFactor: "phone" },
  { id: "pixel_9_pro", name: "Pixel 9 Pro", origin: "sdk", screenInches: 6.3, widthPx: 1280, heightPx: 2856, density: 480, formFactor: "phone" },
  { id: "pixel_8a", name: "Pixel 8a", origin: "sdk", screenInches: 6.1, widthPx: 1080, heightPx: 2400, density: 420, formFactor: "phone" },
  { id: "medium_tablet", name: "Medium Tablet", origin: "sdk", screenInches: 10.1, widthPx: 2560, heightPx: 1600, density: 320, formFactor: "tablet" },
  { id: "pixel_tablet", name: "Pixel Tablet", origin: "sdk", screenInches: 10.95, widthPx: 2560, heightPx: 1600, density: 320, formFactor: "tablet" },
  { id: "pixel_9_pro_fold", name: "Pixel 9 Pro Fold", origin: "sdk", screenInches: 8.0, widthPx: 2076, heightPx: 2152, density: 390, formFactor: "foldable" },
  { id: "resizable", name: "Resizable (Experimental)", origin: "sdk", screenInches: 6.0, widthPx: 1080, heightPx: 2340, density: 420, formFactor: "phone" },
  { id: "wearos_large_round", name: "Wear OS Large Round", origin: "sdk", screenInches: 1.43, widthPx: 466, heightPx: 466, density: 320, formFactor: "wear" },
  { id: "tv_1080p", name: "Television (1080p)", origin: "sdk", screenInches: 55, widthPx: 1920, heightPx: 1080, density: 320, formFactor: "tv" },
  { id: "automotive_1024p_landscape", name: "Automotive (1024p landscape)", origin: "sdk", screenInches: 8.4, widthPx: 1024, heightPx: 768, density: 160, formFactor: "automotive" },
];

const IMAGE = {
  packageId: "system-images;android-36;google_apis_playstore;arm64-v8a",
  apiLevel: 36,
  tag: "google_apis_playstore",
  abi: "arm64-v8a",
  path: "/Users/mock/Library/Android/sdk/system-images/android-36/google_apis_playstore/arm64-v8a",
};

function sdkStatus(which: Scenario): AndroidSdkStatus {
  const found = which !== "setup";
  const root = found ? "/Users/mock/Library/Android/sdk" : null;
  return {
    found,
    root,
    source: found ? "default" : null,
    tools: [
      { id: "platform-tools", available: found, path: found ? `${root}/platform-tools/adb` : null, version: found ? "36.0.0" : null, detail: found ? null : "adb is part of the SDK's platform-tools." },
      { id: "emulator", available: found, path: found ? `${root}/emulator/emulator` : null, version: found ? "37.1.11" : null, detail: found ? null : "The Android emulator is not installed." },
      { id: "cmdline-tools", available: false, path: null, version: null, detail: "Optional." },
      { id: "system-image", available: found, path: found ? IMAGE.path : null, version: found ? "API 36" : null, detail: found ? null : "No phone image for arm64-v8a is installed." },
    ],
    acceleration: which === "noaccel"
      ? { kind: "WHPX", usable: false, detail: "Windows Hypervisor Platform is off. Turn it on in Windows Features, then restart." }
      : { kind: "HVF", usable: true, detail: null },
    hostAbi: "arm64-v8a",
    avdHome: "/Users/mock/.android/avd",
    checkedAt: new Date().toISOString(),
  };
}

function avd(partial: Partial<AndroidAvdListing> & Pick<AndroidAvdListing, "name">): AndroidAvdListing {
  return {
    displayName: null,
    profileId: "medium_phone",
    apiLevel: 36,
    tag: "google_apis_playstore",
    abi: "arm64-v8a",
    lcdWidth: LCD.width,
    lcdHeight: LCD.height,
    density: 420,
    path: `/Users/mock/.android/avd/${partial.name}.avd`,
    sizeBytes: 2.1e9,
    adeCreated: false,
    running: null,
    heldByLaneId: null,
    ...partial,
  };
}

function runningOn(name: string, port: number, startedByAde: boolean) {
  return { avdName: name, serial: `emulator-${port}`, consolePort: port, adbPort: port + 1, grpcPort: 8554 + (port - 5554), pid: 40_000 + port, grpcTokenRequired: !startedByAde, startedByAde, booted: true };
}

export function createMockAndroidEmulator(): AndroidEmulatorPreloadApi {
  const which = scenario();
  const listeners = new Set<(event: AndroidEmulatorEvent) => void>();
  const emit = (event: AndroidEmulatorEvent) => {
    for (const listener of listeners) listener(event);
  };
  const touches: AndroidTouchEvent[] = [];
  (window as unknown as Record<string, unknown>).__adeMockAndroidTouches = touches;
  const typed: string[] = [];
  (window as unknown as Record<string, unknown>).__adeMockAndroidTyped = typed;
  const keys: string[] = [];
  (window as unknown as Record<string, unknown>).__adeMockAndroidKeys = keys;

  /** The lane the pane asked about; the lane's device belongs to whichever lane that is. */
  let laneId: string | null = null;
  let laneAvd: string | null = which === "picker" ? null : "ade_lane_medium_phone";
  let laneState: AndroidLaneDeviceStatus["state"] = which === "picker" ? "none"
    : which === "starting" ? "starting"
      : which === "off" ? "off"
        : which === "crashed" ? "crashed"
          : "booted";
  let streamRunning = false;

  const otherAvds: AndroidAvdListing[] = [
    avd({ name: "versic_tablet", profileId: "pixel_tablet", apiLevel: 35, lcdWidth: 2560, lcdHeight: 1600, density: 320, heldByLaneId: "lane-b", running: runningOn("versic_tablet", 5554, false), sizeBytes: 6.4e9 }),
    avd({ name: "versic_fold", profileId: "pixel_9_pro_fold", lcdWidth: 2076, lcdHeight: 2152, density: 390, sizeBytes: 4.8e9 }),
    avd({ name: "vphone4", displayName: "Medium Phone API 36", sizeBytes: 3.2e9 }),
    avd({ name: "vphone3", profileId: "small_phone", apiLevel: 35, lcdWidth: 720, lcdHeight: 1280, density: 320, sizeBytes: 1.9e9 }),
    avd({ name: "ade_9f2c71ab_pixel_9", displayName: "ADE · fix-login", profileId: "pixel_9", lcdWidth: 1080, lcdHeight: 2424, adeCreated: true, sizeBytes: 1.1e9 }),
  ];
  const laneAvdRecord = (): AndroidAvdListing | null => {
    if (!laneAvd) return null;
    const known = otherAvds.find((entry) => entry.name === laneAvd);
    if (known) return { ...known, heldByLaneId: laneId, running: laneState === "booted" ? runningOn(known.name, 5556, true) : null };
    return avd({
      name: laneAvd,
      displayName: "ADE · android-emulator-suite",
      adeCreated: true,
      heldByLaneId: laneId,
      running: laneState === "booted" ? runningOn(laneAvd, 5556, true) : null,
      sizeBytes: 2.6e9,
    });
  };
  const laneStatus = (): AndroidLaneDeviceStatus => {
    const record = laneAvdRecord();
    return {
      laneId: laneId ?? "lane",
      device: record ? {
        laneId: laneId ?? "lane",
        avdName: record.name,
        origin: record.adeCreated ? "created" : "attached",
        profileId: record.profileId,
        systemImage: IMAGE.packageId,
        createdAt: "2026-11-03T09:00:00.000Z",
        adeInstalledPackages: [],
      } : null,
      avd: record,
      state: record ? laneState : "none",
      error: laneState === "crashed"
        ? { code: "ANDROID_EMULATOR_EXITED", message: "The emulator exited during boot (exit code 1).", logPath: "/Users/mock/.ade/android/logs/ade_lane_medium_phone-2026-11-03.log" }
        : null,
    };
  };
  const status = (forLane: string | null | undefined): AndroidEmulatorStatus => {
    if (forLane) laneId = forLane;
    return {
      platformSupported: which !== "unsupported",
      unsupportedReason: which === "unsupported" ? "This host is a 32-bit ARM Linux machine; the emulator needs x86_64 or arm64." : null,
      sdk: sdkStatus(which),
      lane: forLane ? laneStatus() : null,
    };
  };
  const boot = (name: string) => {
    laneAvd = name;
    laneState = "starting";
    otherAvds.splice(0, otherAvds.length, ...otherAvds.filter((entry) => entry.name !== name));
    if (laneId) emit({ type: "android.device.state", laneId, state: "starting" });
    window.setTimeout(() => {
      laneState = "booted";
      if (laneId) emit({ type: "android.device.state", laneId, state: "booted" });
    }, 1_800);
  };
  const delay = <T,>(value: T, ms = 120) => new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));

  installMockStreamFetch(touches);

  return {
    getStatus: async (args) => delay(status(args?.laneId ?? null), 60),
    listDevices: async (args) => {
      if (args?.laneId) laneId = args.laneId;
      const lane = laneAvdRecord();
      return delay({ avds: [...(lane ? [lane] : []), ...otherAvds], profiles: PROFILES, images: [IMAGE] }, 140);
    },
    createDevice: async (args) => {
      laneId = args.laneId;
      boot(`ade_${args.laneId.slice(0, 8)}_${args.profileId}`);
      return delay(laneStatus(), 2_000);
    },
    attachDevice: async (args) => {
      laneId = args.laneId;
      boot(args.avdName);
      return delay(laneStatus(), 2_000);
    },
    start: async (args) => {
      laneId = args.laneId;
      if (laneAvd) boot(laneAvd);
      return delay(laneStatus(), 2_000);
    },
    stop: async (args) => {
      laneId = args.laneId;
      laneState = "off";
      streamRunning = false;
      emit({ type: "android.device.state", laneId: args.laneId, state: "off" });
      return delay(laneStatus());
    },
    releaseDevice: async (args) => {
      laneId = args.laneId;
      const released = laneAvdRecord();
      if (released) otherAvds.unshift({ ...released, heldByLaneId: null, running: null });
      laneAvd = null;
      laneState = "none";
      emit({ type: "android.inventory.changed" });
      return delay({ released: Boolean(released), deletedAvd: null });
    },
    deleteDevice: async (args) => {
      const index = otherAvds.findIndex((entry) => entry.name === args.avdName);
      if (index >= 0) otherAvds.splice(index, 1);
      emit({ type: "android.inventory.changed" });
      return delay({ deleted: index >= 0 });
    },
    startStream: async (args) => {
      streamRunning = true;
      return delay({
        laneId: args.laneId,
        running: true,
        backend: "scrcpy" as const,
        transport: { url: MOCK_STREAM_URL, token: "mock-token", codec: "avc1.42001f", width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
        fps: 60,
      });
    },
    stopStream: async (args) => {
      streamRunning = false;
      return { laneId: args.laneId, running: false, backend: null, transport: null, fps: null };
    },
    getStreamStatus: async (args) => ({
      laneId: args.laneId,
      running: streamRunning,
      backend: streamRunning ? "scrcpy" as const : null,
      transport: null,
      fps: streamRunning ? 57 + Math.round(Math.random() * 3) : null,
    }),
    sendTouch: async (args) => {
      touches.push(...args.events);
    },
    sendKey: async (args) => {
      keys.push(args.key);
    },
    sendText: async (args) => {
      typed.push(args.text);
    },
    screenshot: async () => delay({
      path: "/Users/mock/.ade/android/screenshots/ade_lane_medium_phone-1.png",
      width: LCD.width,
      height: LCD.height,
      bytes: 812_000,
      capturedAt: new Date().toISOString(),
    }, 300),
    resolveStreamUrl: async (url) => ({ url, forwarded: false, error: null }),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/* ── The fake loopback stream ───────────────────────────────────────────── */

type WebCodecsEncoderScope = {
  VideoEncoder?: new (init: {
    output: (chunk: { type: "key" | "delta"; byteLength: number; copyTo: (target: Uint8Array) => void }) => void;
    error: (error: Error) => void;
  }) => {
    configure: (config: Record<string, unknown>) => void;
    encode: (frame: unknown, options?: { keyFrame?: boolean }) => void;
    close: () => void;
    readonly state: string;
  };
  VideoFrame?: new (source: OffscreenCanvas | HTMLCanvasElement, init: { timestamp: number }) => { close: () => void };
};

function record(type: number, flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(IOS_VIDEO_RECORD_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, IOS_VIDEO_RECORD_MAGIC, false);
  view.setUint8(4, type);
  view.setUint8(5, flags);
  view.setUint32(8, payload.byteLength, false);
  out.set(payload, IOS_VIDEO_RECORD_HEADER_BYTES);
  return out;
}

function drawScreen(context: OffscreenCanvasRenderingContext2D, tick: number, touches: AndroidTouchEvent[]) {
  const w = VIDEO_WIDTH;
  const h = VIDEO_HEIGHT;
  const gradient = context.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, "#0b3d2e");
  gradient.addColorStop(1, "#14213d");
  context.fillStyle = gradient;
  context.fillRect(0, 0, w, h);
  context.fillStyle = "rgba(255,255,255,0.9)";
  context.font = "600 22px sans-serif";
  const now = new Date();
  context.fillText(`${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`, 28, 42);
  context.font = "600 96px sans-serif";
  context.fillText(`${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`, 60, 300);
  context.font = "400 26px sans-serif";
  context.fillText("Mock emulator · 1080×2400", 64, 350);
  // App icons in a 4×2 grid near the foot.
  const colors = ["#3ddc84", "#4285f4", "#ea4335", "#fbbc05", "#a142f4", "#24c1e0", "#f6aea9", "#ffffff"];
  for (let index = 0; index < 8; index += 1) {
    const col = index % 4;
    const row = Math.floor(index / 4);
    context.fillStyle = colors[index]!;
    context.beginPath();
    context.arc(88 + col * 133, 900 + row * 150, 46, 0, Math.PI * 2);
    context.fill();
  }
  // A moving bar so the stream is never still.
  context.fillStyle = "rgba(61,220,132,0.8)";
  context.fillRect((tick * 6) % w, h - 60, 80, 6);
  // The last touches, scaled from device pixels to the video.
  const recent = touches.slice(-24);
  recent.forEach((touch, index) => {
    const x = (touch.x / LCD.width) * w;
    const y = (touch.y / LCD.height) * h;
    context.fillStyle = touch.action === "down" ? "rgba(255,80,80,0.95)" : touch.action === "up" ? "rgba(80,160,255,0.95)" : `rgba(255,255,255,${0.25 + (index / recent.length) * 0.6})`;
    context.beginPath();
    context.arc(x, y, touch.action === "move" ? 6 : 14, 0, Math.PI * 2);
    context.fill();
  });
}

/** Encodes the drawn screen into the brain's video records, as a streaming body. */
function mockStreamBody(signal: AbortSignal | null | undefined, touches: AndroidTouchEvent[]): ReadableStream<Uint8Array> {
  const scope = globalThis as unknown as WebCodecsEncoderScope;
  let timer: number | null = null;
  let encoder: InstanceType<NonNullable<WebCodecsEncoderScope["VideoEncoder"]>> | null = null;
  const stop = () => {
    if (timer != null) window.clearInterval(timer);
    timer = null;
    try {
      if (encoder && encoder.state !== "closed") encoder.close();
    } catch {
      // Already closed.
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!scope.VideoEncoder || !scope.VideoFrame || typeof OffscreenCanvas === "undefined") {
        controller.error(new Error("This browser cannot encode the mock emulator stream."));
        return;
      }
      const codec = "avc1.42001f";
      controller.enqueue(record(
        IOS_VIDEO_RECORD_TYPE_CONFIG,
        0,
        new TextEncoder().encode(JSON.stringify({ codec, width: VIDEO_WIDTH, height: VIDEO_HEIGHT, annexB: true })),
      ));
      encoder = new scope.VideoEncoder({
        output: (chunk) => {
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          try {
            controller.enqueue(record(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, chunk.type === "key" ? IOS_VIDEO_RECORD_FLAG_KEYFRAME : 0, bytes));
          } catch {
            stop();
          }
        },
        error: (error) => {
          stop();
          try {
            controller.error(error);
          } catch {
            // The reader already went away.
          }
        },
      });
      encoder.configure({ codec, width: VIDEO_WIDTH, height: VIDEO_HEIGHT, bitrate: 2_000_000, framerate: 30, avc: { format: "annexb" }, latencyMode: "realtime" });
      const canvas = new OffscreenCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
      const context = canvas.getContext("2d")!;
      let tick = 0;
      timer = window.setInterval(() => {
        if (!encoder || encoder.state !== "configured") return;
        drawScreen(context, tick, touches);
        const frame = new scope.VideoFrame!(canvas, { timestamp: tick * 33_333 });
        encoder.encode(frame, { keyFrame: tick % 60 === 0 });
        frame.close();
        tick += 1;
      }, 33);
      signal?.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      stop();
    },
  });
}

let fetchInstalled = false;

/** Answers the one fake loopback address; every other request goes to the real `fetch`. */
function installMockStreamFetch(touches: AndroidTouchEvent[]) {
  if (fetchInstalled || typeof window.fetch !== "function") return;
  fetchInstalled = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(MOCK_STREAM_URL)) {
      return Promise.resolve(new Response(mockStreamBody(init?.signal, touches), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }));
    }
    return realFetch(input, init);
  };
}
