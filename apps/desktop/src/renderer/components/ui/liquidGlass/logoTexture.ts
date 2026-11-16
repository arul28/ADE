/* ------------------------------------------------------------------ *
 * Logo → texture + signed distance field
 * ------------------------------------------------------------------ */
import { captureError } from "../../../../shared/sentry/capture";
import { sdfFromRgba } from "./logoSdf";
import LogoSdfWorker from "./logoSdf.worker?worker";
import type { LogoSdfRequest, LogoSdfResponse } from "./logoSdf.worker";

export const TEX = 1024; // logo texture size
export const BOX = 0.75; // share of the texture the logo fills (the rest is room for the SDF)

export interface LogoData {
  canvas: HTMLCanvasElement;
  sdf: Float32Array;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    // Only a cross-origin image needs CORS. A same-origin one (a packaged `file://` page
    // loading `./logo.png`) must not ask for it, or Chromium refuses the load.
    if (!src.startsWith("data:")) {
      try {
        if (new URL(src, window.location.href).origin !== window.location.origin) img.crossOrigin = "anonymous";
      } catch {
        img.crossOrigin = "anonymous";
      }
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("GlassIconReveal: the logo could not be loaded"));
    img.src = src;
  });
}

function isMarkup(logo: string) {
  return logo.trimStart().startsWith("<");
}

// SVG markup → data URL rendered at texture size; currentColor turns white (only the shape matters).
function svgToUrl(text: string) {
  const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg") throw new Error("GlassIconReveal: the SVG could not be read");
  let w = parseFloat(svg.getAttribute("width") || "");
  let h = parseFloat(svg.getAttribute("height") || "");
  const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) [w, h] = [vb[2], vb[3]];
  if (!(w > 0 && h > 0)) w = h = 100;
  const s = TEX / Math.max(w, h);
  svg.setAttribute("width", String(Math.round(w * s)));
  svg.setAttribute("height", String(Math.round(h * s)));
  const out = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, "#ffffff");
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(out);
}

export const logoUrl = (logo: string) => (isMarkup(logo) ? svgToUrl(logo) : logo);

// Draws the source into a TEX×TEX canvas, cropped to its visible pixels and fitted into the logo box.
// Opaque images (JPG, flat PNG) get their corner colour keyed out so the mark becomes the shape.
// alphaFloor drops a soft glow baked into a transparent image: alpha under it turns clear.
function fitToTexture(source: CanvasImageSource, sw: number, sh: number, alphaFloor = 0) {
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = TEX;
  const tc = tmp.getContext("2d", { willReadFrequently: true })!;
  const s0 = Math.min(TEX / sw, TEX / sh);
  const dx0 = (TEX - sw * s0) / 2;
  const dy0 = (TEX - sh * s0) / 2;
  tc.drawImage(source, dx0, dy0, sw * s0, sh * s0);
  const d = tc.getImageData(0, 0, TEX, TEX).data;

  let opaque = true;
  for (let i = 3; i < d.length; i += 4 * 97) if (d[i] < 250) { opaque = false; break; }
  const key = [d[0], d[1], d[2]];
  const floorAlpha = (a: number) => (alphaFloor > 0 ? Math.max(0, (a - alphaFloor * 255) / (1 - alphaFloor)) : a);
  const keyAlpha = (r: number, g: number, b: number) =>
    Math.min(1, Math.max(0, (Math.hypot(r - key[0], g - key[1], b - key[2]) / 441 - 0.08) / 0.2));

  let x0 = TEX, y0 = TEX, x1 = -1, y1 = -1;
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const i = (y * TEX + x) * 4;
      const a = opaque ? keyAlpha(d[i], d[i + 1], d[i + 2]) * 255 : floorAlpha(d[i + 3]);
      if (a > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("GlassIconReveal: the logo is empty");
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const s = (TEX * BOX) / Math.max(bw, bh);

  const out = document.createElement("canvas");
  out.width = out.height = TEX;
  const oc = out.getContext("2d", { willReadFrequently: true })!;
  oc.imageSmoothingQuality = "high";
  oc.drawImage(source, TEX / 2 - (x0 + bw / 2 - dx0) * s, TEX / 2 - (y0 + bh / 2 - dy0) * s, sw * s0 * s, sh * s0 * s);
  if (opaque) {
    const im = oc.getImageData(0, 0, TEX, TEX);
    const e = im.data;
    for (let i = 0; i < e.length; i += 4) e[i + 3] = Math.round(e[i + 3] * keyAlpha(e[i], e[i + 1], e[i + 2]));
    oc.putImageData(im, 0, 0);
  } else if (alphaFloor > 0) {
    const im = oc.getImageData(0, 0, TEX, TEX);
    const e = im.data;
    for (let i = 3; i < e.length; i += 4) e[i] = Math.round(floorAlpha(e[i]));
    oc.putImageData(im, 0, 0);
  }
  return out;
}

// The SDF of the texture's alpha. It is about 30 ms of math, so a worker builds it when it can and
// the page keeps drawing; the page builds it itself when no worker can start or the worker fails.
// Both run `sdfFromRgba`, so the field is the same either way.
async function buildSdf(canvas: HTMLCanvasElement): Promise<Float32Array> {
  const read = () => canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, TEX, TEX).data;
  return (await sdfInWorker(read())) ?? sdfFromRgba(read(), TEX);
}

// A worker that answers nothing this long is stuck; the page builds the field instead.
const WORKER_ANSWER_CAP_MS = 4000;
let workerUnusable = false;

/** One report per renderer for each way the worker can fail; the page builds the field instead. */
const reportedWorkerFailures = new Set<string>();
function reportWorkerFailure(kind: "worker_start" | "worker_error" | "post" | "stuck", error: unknown): void {
  workerUnusable = true;
  if (reportedWorkerFailures.has(kind)) return;
  reportedWorkerFailures.add(kind);
  captureError(error, { fingerprint: ["logo_reveal", "sdf_worker", kind], tags: { area: "logo_reveal", step: "sdf_worker", kind }, level: "warning", handled: true });
}

// The field from a worker of its own (moved there with the pixels), or null when no worker can do it.
// `rgba` is moved to the worker, so the caller must not use it again.
function sdfInWorker(rgba: Uint8ClampedArray): Promise<Float32Array | null> {
  if (workerUnusable || typeof Worker === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new LogoSdfWorker();
    } catch (error) {
      reportWorkerFailure("worker_start", error);
      resolve(null);
      return;
    }
    let done = false;
    const finish = (sdf: Float32Array | null) => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      worker.terminate();
      resolve(sdf);
    };
    const cap = setTimeout(() => {
      reportWorkerFailure("stuck", new Error("GlassIconReveal: the SDF worker did not answer"));
      finish(null);
    }, WORKER_ANSWER_CAP_MS);
    worker.onmessage = (event: MessageEvent<LogoSdfResponse>) => {
      const sdf = event.data?.sdf;
      finish(sdf instanceof Float32Array && sdf.length === TEX * TEX ? sdf : null);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      reportWorkerFailure("worker_error", new Error(event.message || "GlassIconReveal: the SDF worker failed"));
      finish(null);
    };
    worker.onmessageerror = () => {
      reportWorkerFailure("worker_error", new Error("GlassIconReveal: the SDF worker answer could not be read"));
      finish(null);
    };
    try {
      const request: LogoSdfRequest = { rgba, size: TEX };
      worker.postMessage(request, [rgba.buffer]);
    } catch (error) {
      reportWorkerFailure("post", error);
      finish(null);
    }
  });
}

// One texture and SDF per logo: about 50 ms to build (most of it in a worker) and about 8 MB to keep. A reveal holds its
// logo while it is mounted, and the cache keeps it a while after, so a remount (the boot guard,
// then a Suspense fallback) or a twin reuses it. Then it goes: a finished splash never needs it again.
const RELEASE_AFTER_MS = 30_000;

type CacheEntry = { job: Promise<LogoData>; users: number; timer: ReturnType<typeof setTimeout> | null };
// The job of a logo no reveal shows any more: it never settles.
const NEVER: Promise<LogoData> = new Promise(() => undefined);
const logoCache = new Map<string, CacheEntry>();

/** The logo's texture and SDF, and `release` for when the caller no longer shows it. */
export function loadLogo(logo: string, alphaFloor = 0): { job: Promise<LogoData>; release: () => void } {
  const key = `${alphaFloor}|${logo}`;
  let entry = logoCache.get(key);
  if (!entry) {
    const created: CacheEntry = { job: NEVER, users: 0, timer: null };
    // The texture and SDF are built only while a reveal still shows this logo. A splash that went
    // before the image arrived (a fast boot) builds nothing: the entry goes, and its job never
    // settles, which no one waits for. A later reveal of the logo starts a new entry.
    const stillShown = () => {
      if (logoCache.get(key) === created && created.users > 0) return true;
      if (logoCache.get(key) === created) logoCache.delete(key);
      return false;
    };
    const job = loadImage(logoUrl(logo)).then(async (img) => {
      if (!stillShown()) return NEVER;
      const canvas = fitToTexture(img, img.naturalWidth || TEX, img.naturalHeight || TEX, alphaFloor);
      if (!stillShown()) return NEVER;
      return { canvas, sdf: await buildSdf(canvas) };
    });
    created.job = job;
    logoCache.set(key, created);
    job.catch(() => {
      if (logoCache.get(key) === created) logoCache.delete(key);
    });
    entry = created;
  }
  const held = entry;
  held.users += 1;
  if (held.timer !== null) {
    clearTimeout(held.timer);
    held.timer = null;
  }
  let released = false;
  return {
    job: held.job,
    release() {
      if (released) return;
      released = true;
      held.users -= 1;
      if (held.users > 0) return;
      held.timer = setTimeout(() => {
        if (logoCache.get(key) === held && held.users === 0) logoCache.delete(key);
      }, RELEASE_AFTER_MS);
    },
  };
}
