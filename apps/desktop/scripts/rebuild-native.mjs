import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rebuild } from "@electron/rebuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(appDir, "package.json");

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const electronRange = packageJson.devDependencies?.electron;
const electronVersion = typeof electronRange === "string" ? electronRange.replace(/^[^\d]*/, "") : "";

if (!electronVersion) {
  throw new Error("Unable to determine Electron version from devDependencies.electron");
}

// node-abi can lag a newly installed stable Electron. Ask the actual target
// binary for its ABI, so rebuilding does not silently use the host Node ABI.
let linuxTarget = {};
if (process.platform === "linux") {
  const require = createRequire(import.meta.url);
  const electronBinary = require("electron");
  const probe = spawnSync(electronBinary, ["-p", "JSON.stringify({ version: process.versions.electron, abi: process.versions.modules })"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(`Cannot determine installed Electron ABI: ${probe.error?.message || probe.stderr || `exit ${probe.status}`}`);
  }
  const target = JSON.parse(probe.stdout);
  const abi = Number(target.abi);
  if (!target.version || !Number.isSafeInteger(abi) || abi <= 0) {
    throw new Error("Installed Electron did not report a valid version and native ABI");
  }
  linuxTarget = { electronVersion: target.version, forceABI: abi };
}

await rebuild({
  buildPath: appDir,
  electronVersion,
  ...linuxTarget,
  force: true,
  // node-pty is the required V8-ABI addon. ssh2's cpu-features and
  // sshcrypto are optional accelerators and both fall back when they cannot
  // load; rebuilding cpu-features against Electron 44 fails in NAN. Other
  // shipped native packages use Node-API or are separate executables.
  onlyModules: ["node-pty"],
});

if (process.platform === "linux") {
  // Linux node-pty uses forkpty, but ship its helper alongside the addon so
  // the packaged native payload is complete across node-pty versions.
  const ptyRoot = path.join(appDir, "node_modules", "node-pty");
  const source = path.join(ptyRoot, "src", "unix", "spawn-helper.cc");
  const output = path.join(ptyRoot, "build", "Release", "spawn-helper");
  const compiled = spawnSync(process.env.CXX || "c++", ["-O2", "-o", output, source], { stdio: "inherit" });
  if (compiled.error || compiled.status !== 0) {
    throw new Error(`Unable to build node-pty spawn-helper: ${compiled.error?.message || `exit ${compiled.status}`}`);
  }
}
