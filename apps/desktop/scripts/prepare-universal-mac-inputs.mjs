import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const packageLockPath = path.join(appDir, "package-lock.json");
const CRSQLITE_DARWIN_X64_URL =
  "https://github.com/vlcn-io/cr-sqlite/releases/download/v0.16.3/crsqlite-darwin-x86_64.zip";

function readFlag(name) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length).trim();
    }
  }
  return null;
}

function resolveAbsolute(input) {
  if (!input) return null;
  return path.isAbsolute(input) ? input : path.resolve(appDir, input);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertPathExists(targetPath, description) {
  if (!(await pathExists(targetPath))) {
    throw new Error(`[release:mac] Missing ${description}: ${targetPath}`);
  }
}

async function loadPackageLock() {
  return JSON.parse(await fs.readFile(packageLockPath, "utf8"));
}

function getResolvedPackageUrl(packageLock, packagePath) {
  const entry = packageLock?.packages?.[packagePath];
  const resolved = entry?.resolved;
  if (typeof resolved !== "string" || !resolved.startsWith("http")) {
    throw new Error(`[release:mac] Missing resolved tarball URL for ${packagePath} in package-lock.json`);
  }
  return resolved;
}

async function downloadFile(url, outputPath) {
  await execFileAsync("curl", ["-L", "--fail", "--silent", "--show-error", "-o", outputPath, url]);
}

async function extractTarballPackage(tarballPath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-universal-tar-"));
  await execFileAsync("tar", ["-xzf", tarballPath, "-C", tempDir]);
  const packageDir = path.join(tempDir, "package");
  await assertPathExists(packageDir, `package payload extracted from ${path.basename(tarballPath)}`);
  return {
    packageDir,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function seedPackageFromResolvedUrl(packageLock, packagePath, targetRelativePath, description) {
  const url = getResolvedPackageUrl(packageLock, packagePath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-universal-download-"));
  const archivePath = path.join(tempDir, "package.tgz");

  try {
    await downloadFile(url, archivePath);
    const { packageDir, cleanup } = await extractTarballPackage(archivePath);

    try {
      const targetPath = path.join(appDir, targetRelativePath);
      await fs.rm(targetPath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.cp(packageDir, targetPath, { recursive: true, force: true });
      console.log(`[release:mac] Seeded ${description}: ${targetRelativePath}`);
    } finally {
      await cleanup();
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function seedCrsqliteDarwinX64() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-crsqlite-x64-"));
  const archivePath = path.join(tempDir, "crsqlite-darwin-x64.zip");
  const extractedPath = path.join(tempDir, "crsqlite.dylib");
  const targetPath = path.join(appDir, "vendor", "crsqlite", "darwin-x64", "crsqlite.dylib");

  try {
    await downloadFile(CRSQLITE_DARWIN_X64_URL, archivePath);
    await execFileAsync("unzip", ["-q", archivePath, "-d", tempDir]);
    await assertPathExists(extractedPath, "x64 crsqlite dylib from upstream release");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(extractedPath, targetPath);
    console.log("[release:mac] Seeded crsqlite x64 payload: vendor/crsqlite/darwin-x64/crsqlite.dylib");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function findExtractedApp(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!appEntry) {
    throw new Error(`[release:mac] Extracted zip did not contain an .app bundle: ${rootPath}`);
  }
  return path.join(rootPath, appEntry.name);
}

async function resolveX64AppPath() {
  const appPath = resolveAbsolute(readFlag("--x64-app") ?? process.env.ADE_X64_APP_PATH);
  const zipPath = resolveAbsolute(readFlag("--x64-zip") ?? process.env.ADE_X64_APP_ZIP);

  if (appPath && zipPath) {
    throw new Error("[release:mac] Provide either --x64-app or --x64-zip, not both");
  }

  if (!appPath && !zipPath) {
    return null;
  }

  if (appPath) {
    await assertPathExists(appPath, "x64 ADE.app bundle");
    return { appPath, cleanup: async () => {} };
  }

  await assertPathExists(zipPath, "x64 ADE.app zip archive");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-x64-app-"));
  await execFileAsync("ditto", ["-x", "-k", zipPath, tempDir]);
  const extractedAppPath = await findExtractedApp(tempDir);

  return {
    appPath: extractedAppPath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function copyFromAppBundle(x64AppPath, sourceRelativePath, targetRelativePath, description) {
  const sourcePath = path.join(x64AppPath, sourceRelativePath);
  const targetPath = path.join(appDir, targetRelativePath);
  await assertPathExists(sourcePath, description);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
  console.log(`[release:mac] Seeded ${description}: ${targetRelativePath}`);
}

async function seedFromAppBundle(x64AppPath) {
  await copyFromAppBundle(
    x64AppPath,
    "Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-darwin-x64",
    "node_modules/@img/sharp-darwin-x64",
    "sharp x64 package",
  );
  await copyFromAppBundle(
    x64AppPath,
    "Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-x64",
    "node_modules/@img/sharp-libvips-darwin-x64",
    "sharp libvips x64 package",
  );
  await copyFromAppBundle(
    x64AppPath,
    "Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-x64",
    "node_modules/@openai/codex-darwin-x64",
    "Codex CLI x64 package",
  );
  await copyFromAppBundle(
    x64AppPath,
    "Contents/Resources/app.asar.unpacked/vendor/crsqlite/darwin-x64",
    "vendor/crsqlite/darwin-x64",
    "crsqlite x64 payload",
  );
}

async function seedFromLockfileAndPinnedArtifacts() {
  const packageLock = await loadPackageLock();
  await seedPackageFromResolvedUrl(
    packageLock,
    "node_modules/@img/sharp-darwin-x64",
    "node_modules/@img/sharp-darwin-x64",
    "sharp x64 package",
  );
  await seedPackageFromResolvedUrl(
    packageLock,
    "node_modules/@img/sharp-libvips-darwin-x64",
    "node_modules/@img/sharp-libvips-darwin-x64",
    "sharp libvips x64 package",
  );
  await seedPackageFromResolvedUrl(
    packageLock,
    "node_modules/@openai/codex-darwin-x64",
    "node_modules/@openai/codex-darwin-x64",
    "Codex CLI x64 package",
  );
  await seedCrsqliteDarwinX64();
}

async function assertUniversalInputsReady() {
  await assertPathExists(
    path.join(appDir, "node_modules", "@img", "sharp-darwin-x64", "lib", "sharp-darwin-x64.node"),
    "x64 sharp native module",
  );
  await assertPathExists(
    path.join(appDir, "node_modules", "@img", "sharp-libvips-darwin-x64", "lib", "libvips-cpp.8.17.3.dylib"),
    "x64 sharp libvips runtime",
  );
  await assertPathExists(
    path.join(appDir, "node_modules", "@openai", "codex-darwin-x64", "vendor", "x86_64-apple-darwin", "codex", "codex"),
    "x64 Codex CLI binary",
  );
  await assertPathExists(
    path.join(
      appDir,
      "node_modules",
      "@huggingface",
      "transformers",
      "node_modules",
      "onnxruntime-node",
      "bin",
      "napi-v3",
      "darwin",
      "x64",
      "onnxruntime_binding.node",
    ),
    "x64 ONNX Runtime binding from @huggingface/transformers",
  );
  await assertPathExists(
    path.join(appDir, "vendor", "crsqlite", "darwin-x64", "crsqlite.dylib"),
    "x64 crsqlite dylib",
  );
}

const x64App = await resolveX64AppPath();

try {
  if (x64App) {
    await seedFromAppBundle(x64App.appPath);
  } else {
    await seedFromLockfileAndPinnedArtifacts();
  }

  await fs.rm(path.join(appDir, "node_modules", "node-pty", "build"), {
    recursive: true,
    force: true,
  });

  await assertUniversalInputsReady();
  console.log("[release:mac] Universal macOS source tree now contains the required x64 runtime payloads");
} finally {
  await x64App?.cleanup();
}
