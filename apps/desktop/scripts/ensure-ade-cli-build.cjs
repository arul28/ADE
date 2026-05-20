#!/usr/bin/env node

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const cliRoot = path.join(repoRoot, "apps", "ade-cli");

const distFiles = [
  path.join(cliRoot, "dist", "cli.cjs"),
  path.join(cliRoot, "dist", "bootstrap.cjs"),
  path.join(cliRoot, "dist", "adeRpcServer.cjs"),
  path.join(cliRoot, "dist", "tuiClient", "cli.mjs"),
];

const sourceEntries = [
  path.join(cliRoot, "src"),
  path.join(cliRoot, "package.json"),
  path.join(cliRoot, "package-lock.json"),
  path.join(cliRoot, "tsconfig.json"),
  path.join(cliRoot, "tsup.config.ts"),
  path.join(desktopRoot, "src", "main"),
  path.join(desktopRoot, "src", "shared"),
  path.join(desktopRoot, "package.json"),
  path.join(desktopRoot, "package-lock.json"),
  path.join(desktopRoot, "tsconfig.json"),
];

function newestMtimeMs(entryPath) {
  let newest = 0;
  const stack = [entryPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory()) continue;
    for (const child of fs.readdirSync(current)) {
      if (child === "node_modules" || child === "dist" || child === ".turbo") continue;
      stack.push(path.join(current, child));
    }
  }
  return newest;
}

function oldestDistMtimeMs() {
  let oldest = Number.POSITIVE_INFINITY;
  for (const filePath of distFiles) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return 0;
    }
    oldest = Math.min(oldest, stat.mtimeMs);
  }
  return oldest;
}

const newestSource = sourceEntries.reduce(
  (newest, entryPath) => Math.max(newest, newestMtimeMs(entryPath)),
  0,
);
const oldestDist = oldestDistMtimeMs();

if (oldestDist >= newestSource) {
  process.stdout.write("[ade] ADE CLI dist is up to date\n");
  process.exit(0);
}

process.stdout.write("[ade] ADE CLI dist is stale; rebuilding before desktop dev launch\n");
const result = cp.spawnSync(
  "npm",
  ["--prefix", path.join("..", "ade-cli"), "run", "build"],
  {
    cwd: desktopRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error) {
  process.stderr.write(`[ade] failed to rebuild ADE CLI: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
