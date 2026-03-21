import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makeUniversalApp } from "@electron/universal";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { minimatch } = require("minimatch");
const { isUniversalMachO } = require("@electron/universal/dist/cjs/asar-utils.js");
const { AppFileType, getAllAppFiles, readMachOHeader } = require("@electron/universal/dist/cjs/file-utils.js");
const { sha } = require("@electron/universal/dist/cjs/sha.js");

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
const defaultX64ArchFiles = [
  "Contents/Resources/app.asar.unpacked/node_modules/**/*darwin*/**/*",
  "Contents/Resources/app.asar.unpacked/vendor/**/*darwin*/**/*",
  "Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/vendor/**/*",
  "Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-darwin-*/**/*",
  "Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-*/**/*",
  "Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-*/**/*",
  "Contents/Resources/app.asar.unpacked/node_modules/node-pty/bin/darwin-*/**/*",
].join(",");
const x64ArchFiles = readFlag("--x64-arch-files") ??
  process.env.ADE_X64_ARCH_FILES ??
  `{${defaultX64ArchFiles}}`;

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function mirrorDirectory(sourcePath, targetPath) {
  if (await pathExists(targetPath)) return;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(sourcePath, targetPath, { recursive: true });
}

async function findFirstSubdirectory(parentPath, prefix) {
  try {
    const entries = await fs.readdir(parentPath, { withFileTypes: true });
    return entries.find((entry) => entry.isDirectory() && entry.name.startsWith(prefix))?.name ?? null;
  } catch {
    return null;
  }
}

async function readMachOArchitectures(filePath) {
  const { stdout } = await execFileAsync("lipo", ["-archs", filePath]);
  return stdout.trim().split(/\s+/).filter(Boolean);
}

async function validateUniversalInputs() {
  const x64Files = await getAllAppFiles(x64AppPath);
  const arm64Files = await getAllAppFiles(arm64AppPath);
  const arm64Paths = new Set(arm64Files.map((file) => file.relativePath));
  const x64Paths = new Set(x64Files.map((file) => file.relativePath));

  const problems = {
    uniqueToX64: x64Files
      .filter((file) => file.type !== AppFileType.SNAPSHOT && file.type !== AppFileType.APP_CODE)
      .map((file) => file.relativePath)
      .filter((relativePath) => !arm64Paths.has(relativePath)),
    uniqueToArm64: arm64Files
      .filter((file) => file.type !== AppFileType.SNAPSHOT && file.type !== AppFileType.APP_CODE)
      .map((file) => file.relativePath)
      .filter((relativePath) => !x64Paths.has(relativePath)),
    sameShaOutsideX64ArchFiles: [],
    sameArchDifferentContent: [],
  };

  for (const machOFile of x64Files.filter((file) => file.type === AppFileType.MACHO)) {
    if (!arm64Paths.has(machOFile.relativePath)) continue;

    const x64FilePath = path.resolve(x64AppPath, machOFile.relativePath);
    const arm64FilePath = path.resolve(arm64AppPath, machOFile.relativePath);
    const x64Header = await readMachOHeader(x64FilePath);
    const arm64Header = await readMachOHeader(arm64FilePath);

    if (isUniversalMachO(x64Header) && isUniversalMachO(arm64Header)) continue;

    const [x64Sha, arm64Sha] = await Promise.all([sha(x64FilePath), sha(arm64FilePath)]);
    if (x64Sha === arm64Sha) {
      if (x64ArchFiles && minimatch(machOFile.relativePath, x64ArchFiles, { matchBase: true })) continue;
      problems.sameShaOutsideX64ArchFiles.push(machOFile.relativePath);
      continue;
    }

    const [x64Architectures, arm64Architectures] = await Promise.all([
      readMachOArchitectures(x64FilePath),
      readMachOArchitectures(arm64FilePath),
    ]);
    if (
      x64Architectures.length === 1 &&
      arm64Architectures.length === 1 &&
      x64Architectures[0] === arm64Architectures[0]
    ) {
      problems.sameArchDifferentContent.push({
        relativePath: machOFile.relativePath,
        architecture: x64Architectures[0],
      });
    }
  }

  if (
    problems.uniqueToX64.length > 0 ||
    problems.uniqueToArm64.length > 0 ||
    problems.sameShaOutsideX64ArchFiles.length > 0 ||
    problems.sameArchDifferentContent.length > 0
  ) {
    console.error("[release:mac] Universal merge preflight failed:", JSON.stringify(problems, null, 2));
    throw new Error("Universal merge preflight found unresolved native file mismatches");
  }
}

async function mirrorArchSpecificDependencies() {
  const unpackedNodeModules = path.join("Contents", "Resources", "app.asar.unpacked", "node_modules");
  const unpackedVendor = path.join("Contents", "Resources", "app.asar.unpacked", "vendor");
  const pairedDirectories = [
    [
      path.join(unpackedNodeModules, "@img", "sharp-darwin-x64"),
      path.join(unpackedNodeModules, "@img", "sharp-darwin-arm64"),
    ],
    [
      path.join(unpackedNodeModules, "@img", "sharp-libvips-darwin-x64"),
      path.join(unpackedNodeModules, "@img", "sharp-libvips-darwin-arm64"),
    ],
    [
      path.join(unpackedNodeModules, "@openai", "codex-darwin-x64"),
      path.join(unpackedNodeModules, "@openai", "codex-darwin-arm64"),
    ],
    [
      path.join(unpackedVendor, "crsqlite", "darwin-x64"),
      path.join(unpackedVendor, "crsqlite", "darwin-arm64"),
    ],
  ];

  const nodePtyBase = path.join(unpackedNodeModules, "node-pty", "bin");
  const x64NodePtyDir = await findFirstSubdirectory(path.join(x64AppPath, nodePtyBase), "darwin-x64-");
  const arm64NodePtyDir = await findFirstSubdirectory(path.join(arm64AppPath, nodePtyBase), "darwin-arm64-");
  if (x64NodePtyDir && arm64NodePtyDir) {
    pairedDirectories.push([
      path.join(nodePtyBase, x64NodePtyDir),
      path.join(nodePtyBase, arm64NodePtyDir),
    ]);
  }

  for (const [x64RelativePath, arm64RelativePath] of pairedDirectories) {
    const x64SourcePath = path.join(x64AppPath, x64RelativePath);
    const arm64SourcePath = path.join(arm64AppPath, arm64RelativePath);
    if (!(await pathExists(x64SourcePath)) || !(await pathExists(arm64SourcePath))) continue;

    await mirrorDirectory(x64SourcePath, path.join(arm64AppPath, x64RelativePath));
    await mirrorDirectory(arm64SourcePath, path.join(x64AppPath, arm64RelativePath));
  }
}

await fs.access(x64AppPath);
await fs.access(arm64AppPath);
await fs.rm(outAppPath, { recursive: true, force: true });
await fs.mkdir(path.dirname(outAppPath), { recursive: true });
await mirrorArchSpecificDependencies();
await validateUniversalInputs();

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
