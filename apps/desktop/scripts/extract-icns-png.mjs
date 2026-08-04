#!/usr/bin/env node
/**
 * Extract the largest embedded PNG from a macOS `.icns` file.
 *
 * The channel icons were only ever authored as `.icns`, because until now only
 * macOS could build a channel. Windows needs its own icon, and electron-builder
 * converts a >=256px PNG into a multi-resolution `.ico` on its own — so the
 * whole job is getting the PNG back out, with no image library involved.
 *
 * `.icns` is a flat container, not a compressed format: an `icns` magic, a
 * big-endian total length, then a sequence of `{4-byte type, 4-byte length,
 * data}` entries. Since OS X 10.7 the large sizes (`ic07`-`ic14`) hold PNG
 * bytes verbatim, so the largest PNG-looking entry can be written straight to
 * disk. Older entries (`is32`, `il32`, `ic04`...) are raw or RLE-packed ARGB
 * and are skipped rather than decoded — the modern entries are always present
 * in icons built this decade, and a missing one should fail loudly rather than
 * silently ship a 32px app icon.
 *
 * Usage: node scripts/extract-icns-png.mjs <input.icns> <output.png>
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_BYTES = 8;
const MIN_ICO_SOURCE_PX = 256;

/** Read a PNG's pixel width from its IHDR chunk, which is always first. */
function pngWidth(data) {
  // 8 magic + 4 length + 4 "IHDR", then width as a big-endian uint32.
  return data.length >= 24 ? data.readUInt32BE(16) : 0;
}

export function extractLargestPng(icns) {
  if (icns.length < HEADER_BYTES || icns.toString("ascii", 0, 4) !== "icns") {
    throw new Error("Not an ICNS file: missing 'icns' magic.");
  }
  // Trust the declared length only as far as the file actually goes; a
  // truncated download should not send us reading past the buffer.
  const declared = icns.readUInt32BE(4);
  const end = Math.min(declared > 0 ? declared : icns.length, icns.length);

  let best = null;
  let offset = HEADER_BYTES;
  while (offset + HEADER_BYTES <= end) {
    const type = icns.toString("ascii", offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    // `length` covers its own 8-byte header. Anything smaller is corrupt, and
    // treating it as progress would spin this loop forever.
    if (length < HEADER_BYTES || offset + length > end) break;
    const data = icns.subarray(offset + HEADER_BYTES, offset + length);
    if (type !== "TOC " && data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      const width = pngWidth(data);
      if (!best || width > best.width) best = { type, width, data };
    }
    offset += length;
  }
  if (!best) throw new Error("No embedded PNG found. The icon may predate OS X 10.7.");
  return best;
}

/**
 * Materialize `<output>` from `<input>` unless it is already newer.
 *
 * The PNGs are generated rather than committed because `apps/desktop/.gitignore`
 * ignores `*.png` — the one tracked icon predates that rule and had to be
 * force-added. Deriving them from the committed `.icns` on every build keeps a
 * Windows-only checkout self-sufficient and makes drift between the two
 * spellings of an icon impossible.
 */
export function ensureIcnsPng(input, output) {
  if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(input).mtimeMs) {
    return { path: output, regenerated: false };
  }
  const best = extractLargestPng(fs.readFileSync(input));
  if (best.width < MIN_ICO_SOURCE_PX) {
    throw new Error(
      `${path.basename(input)}: largest embedded PNG is ${best.width}px; `
      + `electron-builder needs >=${MIN_ICO_SOURCE_PX}px to build an .ico.`,
    );
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, best.data);
  return { path: output, regenerated: true, width: best.width, type: best.type };
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    process.stderr.write("Usage: extract-icns-png.mjs <input.icns> <output.png>\n");
    process.exit(2);
  }
  const best = extractLargestPng(fs.readFileSync(input));
  if (best.width < MIN_ICO_SOURCE_PX) {
    throw new Error(
      `Largest embedded PNG is ${best.width}px; electron-builder needs >=${MIN_ICO_SOURCE_PX}px to build an .ico.`,
    );
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, best.data);
  process.stdout.write(`[icns] ${path.basename(input)} ${best.type} ${best.width}px -> ${output}\n`);
}

// pathToFileURL, not string interpolation: a Windows path produces `file:///C:/…`
// with three slashes, so a hand-built `file://${argv}` never matches and the
// script silently does nothing when run directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
