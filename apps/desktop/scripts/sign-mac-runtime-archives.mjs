import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const adeCliRoot = path.join(repoRoot, "apps", "ade-cli");
const runtimeRoot = path.join(desktopRoot, "resources", "runtime");
const darwinTargets = ["darwin-arm64", "darwin-x64"];

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
    `--binary=${binaryPath}`,
    "--sign-native-only",
  ]);
}

console.log("[release:mac] Signed Mach-O payloads inside darwin runtime native archives");
