import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type {
  AndroidEmulatorPostureServiceApi,
  AndroidScreenshot,
  AndroidStoreScreenshotsArgs,
  AndroidStoreScreenshotsResult,
  AndroidStoreShot,
  AndroidStoreShotSlot,
} from "../../../shared/types/androidEmulator";
import { androidStoreShotCaption } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { runAdb } from "./adb";
import { runDeviceScript, type BootedDevice } from "./androidDeviceShell";
import { requireLaneId } from "./androidEmulatorErrors";
import { androidLaneFolderName, writeAndroidFileNoFollow } from "./androidScreenshot";

/*
 * Google Play screenshots of the lane's emulator, as Apple's "App Store Duo
 * shots" (`appleDuoService.ts`): one shot of each screen a person sees.
 *
 * - A foldable: the cover screen shut (Play's phone slot) and the inner
 *   screen open (Play's large-screen slot, which Play uses for tablets and
 *   for the inner screen of a foldable). The hinge goes back after.
 * - Any other device: its one screen, in the slot its size calls for
 *   (smallest width 600 dp and up is a large screen).
 *
 * Play's rules (Play Console Help 9866151, read 2026-11-06): JPEG or 24-bit
 * PNG with no alpha, each side 320 to 3840 px, the long side at most twice
 * the short one; for recommendations and large screens, 16:9 or 9:16 with a
 * short side of 1080 px or more. A device screen is rarely 9:16 (a Pixel
 * Fold's cover is 1080×2424, past 2:1; its inner screen is near square), so
 * each capture is centred on a black 9:16 or 16:9 canvas at its own pixels,
 * scaled down only when the canvas would pass 3840 px.
 *
 * The capture is raw RGBA (`screencap` with no `-p`), so no PNG decoder is
 * needed: the PNG is packed as RGB by pngjs, its deflate off the event loop.
 * The canvas and the pack yield to the event loop between them, so a set of
 * shots does not hold up the brain's other calls.
 */

const CAPTURE_TIMEOUT_MS = 30_000;
/** A screen at least this wide in dp is a large screen for Play. */
const LARGE_SCREEN_DP = 600;
const PLAY_MIN_SHORT_SIDE = 1080;
const PLAY_MAX_SIDE = 3840;
/** A fold needs a moment after it settles before apps finish their new layout. */
const LAYOUT_SETTLE_MS = 600;
/**
 * How long a fold may take to put the other screen in the capture. The
 * posture read can call a fold settled before `screencap` follows it (seen
 * once on a Pixel 9 Pro Fold AVD: the cover shot came out the inner screen).
 */
const SCREEN_SWAP_TIMEOUT_MS = 6_000;
const SCREEN_SWAP_POLL_MS = 200;
/** How long the lock screen may take to go after `wm dismiss-keyguard`. */
const UNLOCK_TIMEOUT_MS = 3_000;

export type AndroidStoreShotsDeps = {
  requireBooted: (laneId: string) => Promise<BootedDevice>;
  posture: AndroidEmulatorPostureServiceApi;
  /** Files one PNG as proof in the calling chat; null when nothing filed it. */
  fileShot: (laneId: string, shot: AndroidScreenshot, chatSessionId: string | null, caption: string) => string | null;
  dataDir: string;
  signal: AbortSignal;
  logger?: Logger | null;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
};

/** One raw capture: RGBA pixels, row by row. */
export type RawFrame = { width: number; height: number; rgba: Buffer };

/**
 * Parses `screencap`'s raw output: width, height, format (and, from Android
 * 9, a colour space), then RGBA_8888 pixels. The header size is what is left
 * after the pixels.
 */
export function parseRawScreencap(data: Buffer): RawFrame {
  if (data.length < 12) throw new Error("The emulator returned no screen capture.");
  const width = data.readUInt32LE(0);
  const height = data.readUInt32LE(4);
  const format = data.readUInt32LE(8);
  const pixels = width * height * 4;
  const header = data.length - pixels;
  if (!width || !height || (header !== 12 && header !== 16)) {
    throw new Error(`The emulator's screen capture has an unexpected size (${width}x${height}, ${data.length} bytes).`);
  }
  if (format !== 1 && format !== 2) throw new Error(`The emulator's screen capture is in pixel format ${format}, not RGBA.`);
  return { width, height, rgba: data.subarray(header, header + pixels) };
}

/**
 * The 9:16 or 16:9 canvas for a screen of this size: the screen's own
 * shape picks portrait or landscape, the canvas is the smallest one that
 * holds the screen with a short side of at least 1080 px, and `scale` (1 or
 * less) keeps the long side at 3840 px or under.
 */
export function playCanvasFor(width: number, height: number): { width: number; height: number; scale: number } {
  const portrait = height >= width;
  const [unitW, unitH] = portrait ? [9, 16] : [16, 9];
  const fit = (w: number, h: number) => Math.max(Math.ceil(w / unitW), Math.ceil(h / unitH), Math.ceil(PLAY_MIN_SHORT_SIDE / 9));
  let scale = 1;
  let k = fit(width, height);
  if (Math.max(unitW, unitH) * k > PLAY_MAX_SIDE) {
    k = Math.floor(PLAY_MAX_SIDE / Math.max(unitW, unitH));
    scale = Math.min(k * unitW / width, k * unitH / height);
  }
  return { width: unitW * k, height: unitH * k, scale };
}

/** The frame centred on a black canvas, as RGB rows; a box filter shrinks it when `scale` is under 1. */
export function composeOnCanvas(frame: RawFrame, canvas: { width: number; height: number; scale: number }): Buffer {
  const outW = Math.max(1, Math.round(frame.width * canvas.scale));
  const outH = Math.max(1, Math.round(frame.height * canvas.scale));
  const left = Math.floor((canvas.width - outW) / 2);
  const top = Math.floor((canvas.height - outH) / 2);
  const rgb = Buffer.alloc(canvas.width * canvas.height * 3);
  const { rgba } = frame;
  for (let y = 0; y < outH; y += 1) {
    const sy0 = Math.floor(y / canvas.scale);
    const sy1 = Math.min(frame.height, Math.max(sy0 + 1, Math.floor((y + 1) / canvas.scale)));
    const rowOut = ((top + y) * canvas.width + left) * 3;
    for (let x = 0; x < outW; x += 1) {
      const out = rowOut + x * 3;
      if (canvas.scale === 1) {
        const at = (y * frame.width + x) * 4;
        rgb[out] = rgba[at]!;
        rgb[out + 1] = rgba[at + 1]!;
        rgb[out + 2] = rgba[at + 2]!;
        continue;
      }
      const sx0 = Math.floor(x / canvas.scale);
      const sx1 = Math.min(frame.width, Math.max(sx0 + 1, Math.floor((x + 1) / canvas.scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const at = (sy * frame.width + sx) * 4;
          r += rgba[at]!;
          g += rgba[at + 1]!;
          b += rgba[at + 2]!;
          n += 1;
        }
      }
      rgb[out] = Math.round(r / n);
      rgb[out + 1] = Math.round(g / n);
      rgb[out + 2] = Math.round(b / n);
    }
  }
  return rgb;
}

/**
 * An 8-bit RGB PNG (no alpha, as Play asks), every row with filter 0. pngjs
 * packs it; the deflate runs on the zlib thread pool, off the event loop.
 */
export function encodeRgbPng(width: number, height: number, rgb: Buffer): Promise<Buffer> {
  const png = new PNG({ colorType: 2, inputColorType: 2, inputHasAlpha: false, filterType: 0, deflateLevel: 6, deflateStrategy: 0 });
  png.width = width;
  png.height = height;
  png.data = rgb;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    png.pack()
      .on("data", (chunk: Buffer) => chunks.push(chunk))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

/** Lets other brain work (RPC for every client) run between two CPU-heavy steps. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createAndroidStoreShots(deps: AndroidStoreShotsDeps) {
  const { signal } = deps;

  const capture = async (booted: BootedDevice): Promise<RawFrame> => {
    // `2>/dev/null` on the device: a foldable writes a "Multiple displays"
    // warning to stderr, and `exec-out` joins the two streams.
    const result = await runAdb(booted.adbPath, ["exec-out", "screencap 2>/dev/null"], {
      serial: booted.serial,
      timeoutMs: CAPTURE_TIMEOUT_MS,
      signal,
    });
    return parseRawScreencap(result.stdout);
  };

  /** The capture's size only: the 16-byte header, so a poll costs no frame. */
  const captureSize = async (booted: BootedDevice): Promise<{ width: number; height: number } | null> => {
    const result = await runAdb(booted.adbPath, ["exec-out", "screencap 2>/dev/null | head -c 16"], {
      serial: booted.serial,
      timeoutMs: 10_000,
      signal,
    });
    const data = result.stdout;
    if (data.length < 8) return null;
    return { width: data.readUInt32LE(0), height: data.readUInt32LE(4) };
  };

  /** One screen size, turned or not, is the same screen. */
  const sameScreen = (a: { width: number; height: number } | null, b: { width: number; height: number } | null) =>
    Boolean(a && b && Math.min(a.width, a.height) === Math.min(b.width, b.height) && Math.max(a.width, a.height) === Math.max(b.width, b.height));

  /** Waits until the capture is no longer `previous`'s screen; refuses a shot of the wrong screen. */
  const awaitScreenSwap = async (booted: BootedDevice, previous: { width: number; height: number } | null, display: string) => {
    if (!previous) return;
    const deadline = deps.now().getTime() + SCREEN_SWAP_TIMEOUT_MS;
    for (;;) {
      if (!sameScreen(await captureSize(booted), previous)) return;
      if (deps.now().getTime() >= deadline || signal.aborted) {
        throw new Error(`The emulator still showed the other screen ${SCREEN_SWAP_TIMEOUT_MS / 1000} s after the fold, so no ${display} screen shot was taken. Try again.`);
      }
      await deps.sleep(SCREEN_SWAP_POLL_MS);
    }
  };

  /**
   * A fold shows the lock screen (seen on a Pixel 9 Pro Fold AVD when it
   * shuts), and a Play shot of the lock screen is no use. `wm dismiss-keyguard`
   * (API 26+) takes it away when the device has no screen lock; with one, the
   * call refuses rather than file the lock screen.
   */
  const dismissLockScreen = async (booted: BootedDevice) => {
    const showing = async () => /isKeyguardShowing=true/u.test(
      (await runDeviceScript(booted, "dumpsys window | grep -m1 -o 'isKeyguardShowing=[a-z]*'", { timeoutMs: 10_000, signal })).stdout,
    );
    if (!(await showing())) return;
    await runDeviceScript(booted, "wm dismiss-keyguard", { timeoutMs: 10_000, signal });
    const deadline = deps.now().getTime() + UNLOCK_TIMEOUT_MS;
    while (await showing()) {
      if (deps.now().getTime() >= deadline || signal.aborted) {
        throw new Error("The emulator showed its lock screen after the fold and has a screen lock, so the app cannot be shown. Unlock it (or remove the screen lock) and try again.");
      }
      await deps.sleep(SCREEN_SWAP_POLL_MS);
    }
  };

  /** The slot for a device that does not fold: its smallest width in dp. */
  const slotFor = async (booted: BootedDevice, frame: RawFrame): Promise<AndroidStoreShotSlot> => {
    const text = (await runDeviceScript(booted, "wm density", { timeoutMs: 15_000, signal })).stdout;
    const density = Number(/Override density:\s*(\d+)/u.exec(text)?.[1] ?? /Physical density:\s*(\d+)/u.exec(text)?.[1]);
    if (!Number.isFinite(density) || density <= 0) return Math.min(frame.width, frame.height) >= 1600 ? "large-screen" : "phone";
    return Math.min(frame.width, frame.height) / (density / 160) >= LARGE_SCREEN_DP ? "large-screen" : "phone";
  };

  const write = async (
    laneId: string,
    args: AndroidStoreScreenshotsArgs,
    frame: RawFrame,
    display: AndroidStoreShot["display"],
    slot: AndroidStoreShotSlot,
  ): Promise<AndroidStoreShot> => {
    const canvas = playCanvasFor(frame.width, frame.height);
    await yieldToEventLoop();
    const rgb = composeOnCanvas(frame, canvas);
    await yieldToEventLoop();
    const png = await encodeRgbPng(canvas.width, canvas.height, rgb);
    const capturedAt = deps.now();
    const stamp = capturedAt.toISOString().replace(/[:.]/gu, "-");
    const filePath = path.join(deps.dataDir, "screenshots", `${androidLaneFolderName(laneId)}-play-${display}-${stamp}.png`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeAndroidFileNoFollow(filePath, png);
    const caption = androidStoreShotCaption(slot, display, canvas.width, canvas.height);
    const proofArtifactId = args.proof === false
      ? null
      : deps.fileShot(laneId, {
        path: filePath,
        width: canvas.width,
        height: canvas.height,
        bytes: png.length,
        capturedAt: capturedAt.toISOString(),
      }, args.chatSessionId?.trim() || null, caption);
    return {
      display,
      slot,
      width: canvas.width,
      height: canvas.height,
      screenWidth: frame.width,
      screenHeight: frame.height,
      filePath,
      proofArtifactId,
    };
  };

  const storeScreenshots = async (args: AndroidStoreScreenshotsArgs): Promise<AndroidStoreScreenshotsResult> => {
    const laneId = requireLaneId(args?.laneId);
    const booted = await deps.requireBooted(laneId);
    const before = await deps.posture.getPosture({ laneId });
    if (!before.supported) {
      const frame = await capture(booted);
      return { laneId, foldable: false, shots: [await write(laneId, args, frame, "screen", await slotFor(booted, frame))] };
    }
    const shots: AndroidStoreShot[] = [];
    try {
      // The screen in front before each fold: a shot is taken only once the capture is the other one.
      let previous = before.state === "closed" ? null : await captureSize(booted);
      for (const [display, pose, slot] of [["cover", "closed", "phone"], ["inner", "open", "large-screen"]] as const) {
        const folded = await deps.posture.setPosture({ laneId, pose });
        if (!folded.settled) {
          deps.logger?.warn("android.store_shots_fold_unsettled", { laneId, pose });
        }
        await awaitScreenSwap(booted, previous, display);
        await dismissLockScreen(booted);
        await deps.sleep(LAYOUT_SETTLE_MS);
        const frame = await capture(booted);
        previous = { width: frame.width, height: frame.height };
        shots.push(await write(laneId, args, frame, display, slot));
      }
    } finally {
      if (before.angle !== null) {
        await deps.posture.setPosture({ laneId, angle: before.angle }).catch((error: unknown) => {
          deps.logger?.warn("android.store_shots_hinge_restore_failed", { laneId, error: getErrorMessage(error) });
        });
      }
    }
    return { laneId, foldable: true, shots };
  };

  return { storeScreenshots };
}
