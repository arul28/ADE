#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const electronDir = path.join(projectRoot, "node_modules", "electron");
const installScript = path.join(electronDir, "install.js");
const distDir = path.join(electronDir, "dist");
const pathFile = path.join(electronDir, "path.txt");
const cacheDir = path.join(projectRoot, ".cache", "electron");

function hasInstalledBinary() {
  if (!fs.existsSync(distDir)) return false;
  if (!fs.existsSync(pathFile)) return false;
  const relative = fs.readFileSync(pathFile, "utf8").trim();
  if (!relative) return false;
  return fs.existsSync(path.join(distDir, relative));
}

function main() {
  if (!fs.existsSync(installScript)) {
    console.error("[ensure-electron] Missing electron install script at node_modules/electron.");
    console.error("[ensure-electron] Run `npm install` in apps/desktop first.");
    process.exit(1);
  }

  if (hasInstalledBinary()) {
    return;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  console.log("[ensure-electron] Electron binary missing; running install.js...");
  const result = childProcess.spawnSync(process.execPath, [installScript], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      electron_config_cache: process.env.electron_config_cache || cacheDir
    }
  });

  if (result.status !== 0) {
    console.error("[ensure-electron] Electron install failed.");
    process.exit(result.status ?? 1);
  }

  if (!hasInstalledBinary()) {
    console.error("[ensure-electron] Install finished but Electron binary is still missing.");
    process.exit(1);
  }
}

main();
