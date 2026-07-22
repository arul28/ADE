#!/usr/bin/env node

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { packagedAdeCliBuildResources } = require("./packaged-ade-cli-resources.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const cliRoot = path.join(repoRoot, "apps", "ade-cli");

const distFiles = packagedAdeCliBuildResources({ desktopRoot })
  .map((entry) => entry.sourcePath);

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
    let children;
    try {
      children = fs.readdirSync(current);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
    for (const child of children) {
      if (child === "node_modules" || child === "dist" || child === ".turbo") continue;
      stack.push(path.join(current, child));
    }
  }
  return newest;
}

function oldestMtimeMs(entryPath) {
  let stat;
  try {
    stat = fs.statSync(entryPath);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let children;
  try {
    children = fs.readdirSync(entryPath);
  } catch {
    return 0;
  }
  if (children.length === 0) return 0;
  return children.reduce(
    (oldest, child) => Math.min(oldest, oldestMtimeMs(path.join(entryPath, child))),
    Number.POSITIVE_INFINITY,
  );
}

function oldestDistMtimeMs() {
  if (distFiles.length === 0) return 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const filePath of distFiles) {
    const fileMtime = oldestMtimeMs(filePath);
    if (fileMtime === 0) return 0;
    oldest = Math.min(oldest, fileMtime);
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
