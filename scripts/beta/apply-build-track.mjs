#!/usr/bin/env node
// Turns a release build into a Beta build when its tag is a beta. Run by
// release-core.yml right after "Stamp release version", on every macOS and
// Windows packaging job; on a stable tag it changes nothing.
//
//   ADE_RELEASE_TAG=v1.2.128-beta.3 node scripts/beta/apply-build-track.mjs
//
// It edits only the runner's checkout, the way set-release-version.mjs stamps
// the version, so every electron-builder call the release makes picks it up:
// the two per-arch `electron-builder --mac` calls in package.json's
// dist:mac:*:signed scripts and run-electron-builder.mjs on Windows. Nothing
// here is committed.
//
// 1. build.detectUpdateChannel = false. electron-builder otherwise reads the
//    "beta" out of 1.2.128-beta.3 and writes beta-mac.yml / beta.yml, which
//    the release jobs, the publish job and the beta feed all expect as
//    latest-mac.yml / latest.yml (docs/plans/beta-track.md).
// 2. build.mac.icon = build/icon.beta.icns, the orange icon.
// 3. build/icon.ico is overwritten with the orange icon. validate-win-artifacts
//    requires build.win.icon to stay "build/icon.ico", so the file changes and
//    the setting does not. The stable icon.ico is one 256 px PNG entry; this
//    writes the same shape from the 256 px PNG inside icon.beta.icns, so no
//    image tool is needed on the runner. build-music-host-win.mjs embeds the
//    same file, so the music host's icon follows the track too.
//
// productName and appId are never touched: both tracks are the same app.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trackOfTag } from "./beta-lib.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The PNG entries of an .icns file, as { type, width, data }. */
function icnsPngs(icns) {
  if (icns.toString("ascii", 0, 4) !== "icns") throw new Error("Not an .icns file.");
  const entries = [];
  const end = Math.min(icns.readUInt32BE(4) || icns.length, icns.length);
  for (let offset = 8; offset + 8 <= end;) {
    const type = icns.toString("ascii", offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > end) break;
    const data = icns.subarray(offset + 8, offset + length);
    if (data.subarray(0, 8).equals(PNG_MAGIC)) {
      entries.push({ type, width: data.readUInt32BE(16), height: data.readUInt32BE(20), data });
    }
    offset += length;
  }
  return entries;
}

/** A one-image .ico holding a 256x256 PNG (Windows Vista+ reads PNG entries). */
export function icoFromPng256(png) {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(0, 6); // width 0 = 256
  header.writeUInt8(0, 7); // height 0 = 256
  header.writeUInt8(0, 8); // no palette
  header.writeUInt8(0, 9); // reserved
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

export function applyBuildTrack({ tag, root = desktopRoot }) {
  if (trackOfTag(tag) !== "beta") {
    console.log(`[build-track] ${tag} is a Stable build; nothing to change.`);
    return false;
  }
  const packagePath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const productName = pkg.build?.productName;
  const appId = pkg.build?.appId;
  pkg.build.detectUpdateChannel = false;
  pkg.build.mac = { ...pkg.build.mac, icon: "build/icon.beta.icns" };
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  if (pkg.build.productName !== productName || pkg.build.appId !== appId) {
    throw new Error("Beta packaging must keep productName and appId.");
  }

  const icnsPath = path.join(root, "build", "icon.beta.icns");
  // ic08 is the 256 px entry; ic13 (128 px @2x) holds the same pixels.
  const square = icnsPngs(fs.readFileSync(icnsPath)).filter((entry) => entry.width === 256 && entry.height === 256);
  const png = square.find((entry) => entry.type === "ic08") ?? square[0];
  if (!png) throw new Error("build/icon.beta.icns has no 256x256 PNG entry to build the Windows icon from.");
  fs.writeFileSync(path.join(root, "build", "icon.ico"), icoFromPng256(png.data));
  console.log(`[build-track] ${tag} is a Beta build: detectUpdateChannel=false, orange mac icon, orange build/icon.ico (${png.type}).`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = (process.env.ADE_RELEASE_TAG ?? "").trim();
  if (!tag) throw new Error("ADE_RELEASE_TAG is required.");
  applyBuildTrack({ tag });
}
