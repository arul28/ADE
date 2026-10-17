// Electron entrypoint for `electron .`
// We point Electron at the compiled main process output.
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// The main bundle is ~17 MB, and Node compiles all of it on every launch before
// the first window can open. Node's compile cache keeps the compiled code from
// the last launch on disk, so a warm launch skips most of that. Entries are
// checked against the file's content, so an update recompiles rather than
// reusing stale code. The directory is outside app.asar. NODE_DISABLE_COMPILE_CACHE
// turns it off, and a directory that cannot be used only costs the speed-up.
function enableMainCompileCache() {
  if (typeof Module.enableCompileCache !== "function") return;
  try {
    Module.enableCompileCache(compileCacheDir());
  } catch {
    // Starting without the cache is correct, just slower.
  }
}

// This runs before Electron's app is ready, so the per-user cache root is computed here
// rather than taken from app.getPath().
function compileCacheDir() {
  const override = process.env.ADE_COMPILE_CACHE_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ADE", "compile-cache");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "ADE", "compile-cache");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ade", "compile-cache");
}

enableMainCompileCache();

// When developing, `tsup --watch` writes to `dist/main/main.cjs`.
require(path.join(__dirname, "dist", "main", "main.cjs"));

