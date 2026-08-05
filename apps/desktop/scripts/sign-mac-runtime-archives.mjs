import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeArchiveAction, nativeArchiveNotarizeArgs } from "./mac-runtime-archive-mode.mjs";
import runtimeResourceTargets from "./runtime-resource-targets.cjs";

const { resolveRuntimeTargets } = runtimeResourceTargets;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const adeCliRoot = path.join(repoRoot, "apps", "ade-cli");
const runtimeRoot = path.join(desktopRoot, "resources", "runtime");
// Only the darwin sidecars this build actually stages carry Mach-O payloads to
// sign or verify. A per-arch release job stages exactly one.
const darwinTargets = resolveRuntimeTargets().targets.filter((target) => target.startsWith("darwin-"));
const action = nativeArchiveAction();

async function assertExists(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`[release:mac] Missing ${label}: ${filePath}`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status || 1}`);
  }
}

if (darwinTargets.length === 0) {
  throw new Error("[release:mac] No darwin runtime sidecar is staged for signing in resources/runtime.");
}

for (const target of darwinTargets) {
  const binaryPath = path.join(runtimeRoot, `ade-${target}`);
  await assertExists(binaryPath, `${target} runtime binary`);
  await assertExists(`${binaryPath}.native.tar.gz`, `${target} runtime native archive`);
  run("npm", [
    "--prefix",
    adeCliRoot,
    "run",
    "notarize:static",
    "--",
    ...nativeArchiveNotarizeArgs(binaryPath, action),
  ]);
}

console.log(
  action === "verify"
    ? "[release:mac] Verified pre-signed Mach-O payloads inside darwin runtime native archives"
    : "[release:mac] Signed Mach-O payloads inside darwin runtime native archives",
);
