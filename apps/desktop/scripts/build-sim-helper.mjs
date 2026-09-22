import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the native simulator helper.
 *
 * Modelled on `build-capture-helper.mjs` down to the arch list, the scratch
 * paths, the `lipo` fold and the write-then-rename — including the
 * skip-off-platform guard, which is what lets `dist:win` run this script on a
 * Windows box without failing.
 *
 * Unlike the capture helper there is NO Windows half and there never will be:
 * the helper drives iOS simulators through CoreSimulator and SimulatorKit,
 * which exist only on macOS. A Windows ADE reaches a simulator by connecting to
 * a remote Mac runtime, exactly as it does today.
 *
 * ---------------------------------------------------------------------------
 * DIST WIRING — applied in phase 2 (unit 2D)
 * ---------------------------------------------------------------------------
 *
 * Three edits, mirroring exactly what `ade-capture-helper` already does:
 *
 * 1. package.json `build.extraResources` — widen the existing entry rather
 *    than adding a second one:
 *
 *        { "from": "resources/native", "to": "native",
 *          "filter": ["ade-capture-helper", "ade-capture-helper.exe",
 *                     "ade-sim-helper"] }
 *
 *    No `.exe` sibling: see above.
 *
 * 2. Every macOS dist script gains `npm run build:sim-helper` beside the
 *    existing `npm run build:capture-helper` — `dist:mac`, `dist:mac:dir`,
 *    `dist:mac:signed`, `dist:mac:universal:signed`,
 *    `dist:mac:universal:signed:zip`, `dist:mac:perarch:signed`,
 *    `dist:mac:arm64:signed`, `dist:mac:x64:signed`. The `dist:win*` scripts do
 *    NOT: this script no-ops off macOS, but there is nothing for it to produce.
 *
 * 3. Nothing else. Signing and notarisation need no new work:
 *    electron-builder signs everything under `Contents/Resources` with the
 *    app's Developer ID and `build/entitlements.mac.inherit.plist`, and
 *    notarises the enclosing DMG/ZIP — which is how the capture helper is
 *    already handled. `runtimeBinaryPermissions.cjs` lists `ade-sim-helper`
 *    next to `ade-capture-helper` so the packaged binary keeps its +x bit.
 *
 * ENTITLEMENTS: none to add. The helper `dlopen`s CoreSimulator and
 * SimulatorKit out of the active Xcode, which under the hardened runtime needs
 * `com.apple.security.cs.disable-library-validation` — already granted in both
 * `build/entitlements.mac.plist` and the inherit plist. It needs NO privacy
 * entitlement and triggers NO TCC prompt: frames come from the simulator's own
 * IOSurface framebuffer via CoreSimulator (not the window server, so Screen
 * Recording does not apply) and input goes to the simulator's HID port (not
 * CGEvent, so Accessibility does not apply).
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(desktopRoot, "native", "ADESimHelper");
const outputRoot = path.join(desktopRoot, "resources", "native");
const outputPath = path.join(outputRoot, "ade-sim-helper");

if (process.platform !== "darwin") {
  console.log("[sim-helper] Skipping simulator helper build outside macOS.");
  process.exit(0);
}

if (process.env.ADE_SKIP_SIM_HELPER_BUILD === "1") {
  console.log("[sim-helper] Skipping simulator helper build (ADE_SKIP_SIM_HELPER_BUILD=1).");
  process.exit(0);
}

const requestedArchs = String(process.env.ADE_SIM_HELPER_ARCHS || "arm64,x86_64")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value === "arm64" || value === "x86_64");

if (requestedArchs.length === 0) {
  throw new Error("ADE_SIM_HELPER_ARCHS must include arm64 and/or x86_64");
}

fs.mkdirSync(outputRoot, { recursive: true });
const builtBinaries = [];

for (const arch of requestedArchs) {
  // macOS 14, not 13 as the capture helper targets: the vendored capture and
  // HID actors use `DispatchSerialQueue` as a custom executor, which is 14.0+.
  // Keep this in step with `platforms:` in native/ADESimHelper/Package.swift.
  const triple = `${arch}-apple-macosx14.0`;
  const scratchPath = path.join(packageRoot, `.build-${arch}`);
  const baseArgs = [
    "build",
    "--package-path", packageRoot,
    "--scratch-path", scratchPath,
    "--configuration", "release",
    "--triple", triple,
    "--product", "ade-sim-helper",
  ];
  console.log(`[sim-helper] Building ${arch} helper.`);
  execFileSync("swift", baseArgs, { stdio: "inherit" });
  const binPath = execFileSync("swift", [...baseArgs, "--show-bin-path"], {
    encoding: "utf8",
  }).trim();
  const binaryPath = path.join(binPath, "ade-sim-helper");
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Swift build did not produce ${binaryPath}`);
  }
  builtBinaries.push(binaryPath);
}

// Write to a scratch name and rename into place: a half-copied binary at the
// final path is one electron-builder would happily ship.
const temporaryOutput = path.join(
  outputRoot,
  `.ade-sim-helper.${process.pid}.${Date.now()}`,
);

try {
  if (builtBinaries.length === 1) {
    fs.copyFileSync(builtBinaries[0], temporaryOutput);
  } else {
    execFileSync("lipo", ["-create", ...builtBinaries, "-output", temporaryOutput], {
      stdio: "inherit",
    });
  }
  fs.chmodSync(temporaryOutput, 0o755);
  fs.renameSync(temporaryOutput, outputPath);
} finally {
  fs.rmSync(temporaryOutput, { force: true });
}

const architectures = execFileSync("lipo", ["-archs", outputPath], {
  encoding: "utf8",
}).trim();
console.log(
  `[sim-helper] Materialized ${path.relative(desktopRoot, outputPath)} (${architectures}, ${os.platform()}).`,
);
