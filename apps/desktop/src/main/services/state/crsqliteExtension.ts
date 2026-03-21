import fs from "node:fs";
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

let cachedCrsqlitePath: string | null | undefined;

export function resolveCrsqliteExtensionPath(): string | null {
  if (cachedCrsqlitePath !== undefined) {
    return cachedCrsqlitePath;
  }
  const relativePath = path.join("vendor", "crsqlite", platformArchDir(), extensionFileName());
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", relativePath) : null,
    process.resourcesPath ? path.join(process.resourcesPath, relativePath) : null,
    path.resolve(process.cwd(), relativePath),
    path.resolve(process.cwd(), "apps", "desktop", relativePath),
    path.resolve(__dirname, "..", "..", "..", "..", "..", relativePath),
    path.resolve(__dirname, "..", "..", "..", "..", "..", "apps", "desktop", relativePath),
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
