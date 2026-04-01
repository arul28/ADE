#!/usr/bin/env node

/**
 * After a fresh `npm install`, `dist/main/main.cjs` does not exist until `tsup` runs.
 * `electron .` loads that file via electron.cjs, so generate it once when missing.
 */

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const mainBundle = path.join(projectRoot, "dist", "main", "main.cjs");

function main() {
  if (fs.existsSync(mainBundle)) {
    return;
  }

  console.log("[ade] dist/main/main.cjs missing; running tsup (main/preload compile)…");
  const result = cp.spawnSync("npx", ["tsup"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    console.error("[ade] tsup failed; main process bundle was not created.");
    process.exit(result.status ?? 1);
  }

  if (!fs.existsSync(mainBundle)) {
    console.error("[ade] tsup finished but dist/main/main.cjs is still missing.");
    process.exit(1);
  }
}

main();
