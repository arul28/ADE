import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Release jobs restore the universal Swift helpers from a cache keyed on their
// sources (.github/actions/release-cache-keys, filled by
// warm-release-caches.yml) and set ADE_NATIVE_HELPERS_CACHED=1 on a hit. The
// build script then reuses the restored binary instead of compiling it again.
export function exitIfCachedHelper(outputPath) {
  if (process.platform !== "darwin" || process.env.ADE_NATIVE_HELPERS_CACHED !== "1") return;
  if (!fs.existsSync(outputPath)) return;
  console.log(`[native-helpers] Reusing cached ${path.basename(outputPath)}.`);
  process.exit(0);
}

/**
 * Build one SwiftPM product for each requested architecture in its own scratch
 * path (`<packageRoot>/.build-<arch>`), fold them with `lipo` into a universal
 * binary, and write it to `outputPath` through a scratch name and a rename: a
 * half-copied binary at the final path is one electron-builder would ship.
 *
 * `archsEnv` names the variable that narrows the architectures (default
 * "arm64,x86_64"); `macosVersion` is the deployment target and must match the
 * package's `platforms:`. Callers keep their own platform, skip and cache
 * guards. macOS only.
 */
export function buildUniversalSwiftProduct({ packageRoot, product, outputPath, archsEnv, tag, macosVersion = "13.0" }) {
  const archs = String(process.env[archsEnv] || "arm64,x86_64")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value === "arm64" || value === "x86_64");
  if (archs.length === 0) throw new Error(`${archsEnv} must include arm64 and/or x86_64`);

  const outputRoot = path.dirname(outputPath);
  fs.mkdirSync(outputRoot, { recursive: true });
  const built = [];
  for (const arch of archs) {
    const args = [
      "build",
      "--package-path", packageRoot,
      "--scratch-path", path.join(packageRoot, `.build-${arch}`),
      "--configuration", "release",
      "--triple", `${arch}-apple-macosx${macosVersion}`,
      "--product", product,
    ];
    console.log(`[${tag}] Building ${arch} ${product}.`);
    execFileSync("swift", args, { stdio: "inherit" });
    const binaryPath = path.join(execFileSync("swift", [...args, "--show-bin-path"], { encoding: "utf8" }).trim(), product);
    if (!fs.existsSync(binaryPath)) throw new Error(`Swift build did not produce ${binaryPath}`);
    built.push(binaryPath);
  }

  const temporaryOutput = path.join(outputRoot, `.${path.basename(outputPath)}.${process.pid}.${Date.now()}`);
  try {
    if (built.length === 1) fs.copyFileSync(built[0], temporaryOutput);
    else execFileSync("lipo", ["-create", ...built, "-output", temporaryOutput], { stdio: "inherit" });
    fs.chmodSync(temporaryOutput, 0o755);
    fs.renameSync(temporaryOutput, outputPath);
  } finally {
    fs.rmSync(temporaryOutput, { force: true });
  }
  const architectures = execFileSync("lipo", ["-archs", outputPath], { encoding: "utf8" }).trim();
  console.log(`[${tag}] Materialized ${path.relative(process.cwd(), outputPath) || outputPath} (${architectures}).`);
}
