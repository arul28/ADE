import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function extensionFileName(): string {
  if (process.platform === "darwin") {
    return "crsqlite.dylib";
  }
  if (process.platform === "win32") {
    return "crsqlite.dll";
  }
  return "crsqlite.so";
}

function platformArchDir(): string {
  return `${process.platform}-${process.arch}`;
}

function packagedAsarName(): string {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "app-arm64.asar" : "app-x64.asar";
  }
  return "app.asar";
}

let cachedCrsqlitePath: string | null | undefined;

function findRepoRoot(startDir: string): string | null {
  let cursor = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(path.join(cursor, "apps", "desktop", "package.json")) &&
      fs.existsSync(path.join(cursor, "apps", "ade-cli", "package.json"))
    ) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

export function resolveCrsqliteExtensionPath(): string | null {
  if (cachedCrsqlitePath !== undefined) {
    return cachedCrsqlitePath;
  }
  const relativePath = path.join("vendor", "crsqlite", platformArchDir(), extensionFileName());
  const moduleDir = typeof __dirname === "string" ? __dirname : null;
  const repoRootSet = new Set<string>();
  const cwdRepoRoot = findRepoRoot(process.cwd());
  if (cwdRepoRoot) repoRootSet.add(cwdRepoRoot);
  if (moduleDir) {
    const moduleRepoRoot = findRepoRoot(moduleDir);
    if (moduleRepoRoot) repoRootSet.add(moduleRepoRoot);
  }
  const adeHome = process.env.ADE_HOME ?? path.join(os.homedir(), ".ade");
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, `${packagedAsarName()}.unpacked`, relativePath) : null,
    process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", relativePath) : null,
    process.resourcesPath ? path.join(process.resourcesPath, relativePath) : null,
    // Installed static/headless brain: native tarball is extracted to
    // <ADE_HOME>/runtime/<target>/, carrying crsqlite at vendor/crsqlite/<arch>/.
    path.join(adeHome, "runtime", platformArchDir(), relativePath),
    path.resolve(process.cwd(), relativePath),
    path.resolve(process.cwd(), "apps", "desktop", relativePath),
    ...Array.from(repoRootSet, (repoRoot) => path.join(repoRoot, "apps", "desktop", relativePath)),
    moduleDir ? path.resolve(moduleDir, "..", "..", "..", "..", "..", relativePath) : null,
    moduleDir ? path.resolve(moduleDir, "..", "..", "..", "..", "..", "apps", "desktop", relativePath) : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedCrsqlitePath = candidate;
      return cachedCrsqlitePath;
    }
  }

  cachedCrsqlitePath = null;
  return cachedCrsqlitePath;
}

export function isCrsqliteAvailable(): boolean {
  return resolveCrsqliteExtensionPath() != null;
}
