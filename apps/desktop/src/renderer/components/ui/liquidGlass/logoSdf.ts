/* ------------------------------------------------------------------ *
 * Signed distance field from a logo's alpha (TinySDF method)
 * ------------------------------------------------------------------ *
 * Pure math with no DOM, so the page and `logoSdf.worker.ts` run the same code
 * and get the same field. */

/**
 * The signed distance field of a `size`×`size` RGBA image's alpha: + outside,
 * − inside, in texture units (distance / size).
 */
export function sdfFromRgba(rgba: Uint8Array | Uint8ClampedArray, size: number): Float32Array {
  const n = size * size;
  const INF = 1e20;
  const outer = new Float64Array(n);
  const inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    if (a >= 1) { outer[i] = 0; inner[i] = INF; }
    else if (a <= 0) { outer[i] = INF; inner[i] = 0; }
    else {
      const dd = 0.5 - a;
      outer[i] = dd > 0 ? dd * dd : 0;
      inner[i] = dd < 0 ? dd * dd : 0;
    }
  }
  const f = new Float64Array(size);
  const z = new Float64Array(size + 1);
  const v = new Uint16Array(size);
  edt(outer, size, f, v, z, INF);
  edt(inner, size, f, v, z, INF);
  const sdf = new Float32Array(n);
  for (let i = 0; i < n; i++) sdf[i] = (Math.sqrt(outer[i]) - Math.sqrt(inner[i])) / size;
  return sdf;
}

function edt(grid: Float64Array, size: number, f: Float64Array, v: Uint16Array, z: Float64Array, INF: number) {
  for (let x = 0; x < size; x++) edt1d(grid, x, size, size, f, v, z, INF);
  for (let y = 0; y < size; y++) edt1d(grid, y * size, 1, size, f, v, z, INF);
}

function edt1d(grid: Float64Array, offset: number, stride: number, size: number, f: Float64Array, v: Uint16Array, z: Float64Array, INF: number) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < size; q++) {
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
  for (let q = 0, k = 0; q < size; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}
