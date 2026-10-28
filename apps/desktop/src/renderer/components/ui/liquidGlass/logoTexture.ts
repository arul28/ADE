/* ------------------------------------------------------------------ *
 * Logo → texture + signed distance field
 * ------------------------------------------------------------------ */
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

// Signed distance field from alpha (TinySDF method): + outside, − inside, in texture units.
function buildSdf(canvas: HTMLCanvasElement) {
  const n = TEX * TEX;
  const alpha = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, TEX, TEX).data;
  const INF = 1e20;
  const outer = new Float64Array(n);
  const inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i * 4 + 3] / 255;
    if (a >= 1) { outer[i] = 0; inner[i] = INF; }
    else if (a <= 0) { outer[i] = INF; inner[i] = 0; }
    else {
      const dd = 0.5 - a;
      outer[i] = dd > 0 ? dd * dd : 0;
      inner[i] = dd < 0 ? dd * dd : 0;
    }
  }
  const f = new Float64Array(TEX);
  const z = new Float64Array(TEX + 1);
  const v = new Uint16Array(TEX);
  edt(outer, f, v, z, INF);
  edt(inner, f, v, z, INF);
  const sdf = new Float32Array(n);
  for (let i = 0; i < n; i++) sdf[i] = (Math.sqrt(outer[i]) - Math.sqrt(inner[i])) / TEX;
  return sdf;
}

function edt(grid: Float64Array, f: Float64Array, v: Uint16Array, z: Float64Array, INF: number) {
  for (let x = 0; x < TEX; x++) edt1d(grid, x, TEX, f, v, z, INF);
  for (let y = 0; y < TEX; y++) edt1d(grid, y * TEX, 1, f, v, z, INF);
}

function edt1d(grid: Float64Array, offset: number, stride: number, f: Float64Array, v: Uint16Array, z: Float64Array, INF: number) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < TEX; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < TEX; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}

// One texture and SDF per logo: about 100 ms to build and about 8 MB to keep. A reveal holds its
// logo while it is mounted, and the cache keeps it a while after, so a remount (the boot guard,
// then a Suspense fallback) or a twin reuses it. Then it goes: a finished splash never needs it again.
const RELEASE_AFTER_MS = 30_000;

type CacheEntry = { job: Promise<LogoData>; users: number; timer: ReturnType<typeof setTimeout> | null };
const logoCache = new Map<string, CacheEntry>();

/** The logo's texture and SDF, and `release` for when the caller no longer shows it. */
export function loadLogo(logo: string, alphaFloor = 0): { job: Promise<LogoData>; release: () => void } {
  const key = `${alphaFloor}|${logo}`;
  let entry = logoCache.get(key);
  if (!entry) {
    const job = loadImage(logoUrl(logo)).then((img) => {
      const canvas = fitToTexture(img, img.naturalWidth || TEX, img.naturalHeight || TEX, alphaFloor);
      return { canvas, sdf: buildSdf(canvas) };
    });
    const created: CacheEntry = { job, users: 0, timer: null };
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
