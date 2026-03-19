import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeUniversalApp } from "@electron/universal";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");

function readFlag(name) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function resolveAbsolute(input, fallback) {
  const value = input?.trim() || fallback;
  if (!value) {
    throw new Error("Missing required path argument");
  }
  return path.isAbsolute(value) ? value : path.resolve(appDir, value);
}

const x64AppPath = resolveAbsolute(
  readFlag("--x64-app") ?? process.env.ADE_X64_APP_PATH,
  path.join(appDir, "release", "_ci", "x64", "ADE.app"),
);
const arm64AppPath = resolveAbsolute(
  readFlag("--arm64-app") ?? process.env.ADE_ARM64_APP_PATH,
  path.join(appDir, "release", "_ci", "arm64", "ADE.app"),
);
const outAppPath = resolveAbsolute(
  readFlag("--out-app") ?? process.env.ADE_UNIVERSAL_APP_PATH,
  path.join(appDir, "release", "mac-universal", "ADE.app"),
);

const mergeAsars = hasFlag("--merge-asars") || process.env.ADE_MERGE_ASARS === "1";
const singleArchFiles = readFlag("--single-arch-files") ?? process.env.ADE_SINGLE_ARCH_FILES ?? undefined;
const x64ArchFiles = readFlag("--x64-arch-files") ?? process.env.ADE_X64_ARCH_FILES ?? undefined;

await fs.access(x64AppPath);
await fs.access(arm64AppPath);
await fs.rm(outAppPath, { recursive: true, force: true });
await fs.mkdir(path.dirname(outAppPath), { recursive: true });

await makeUniversalApp({
  x64AppPath,
  arm64AppPath,
  outAppPath,
  force: true,
  mergeASARs: mergeAsars,
  singleArchFiles,
  x64ArchFiles,
});

console.log(
  `[release:mac] Created universal app bundle at ${outAppPath} ` +
    `(mergeASARs=${mergeAsars ? "true" : "false"}).`,
);
