// The macOS 26 app icon. macOS 26 draws an app whose icon is only an `.icns`
// as a "legacy" icon: the art shrunk inside a grey rounded frame, in the Dock,
// Finder and the About panel. An app gets a full-size icon from an asset
// catalog (`Contents/Resources/Assets.car`) named by `CFBundleIconName`.
//
// afterPack compiles the Icon Composer icon beside the configured `.icns`
// (`build/icon.icns` -> `build/icon.icon`, `build/icon.beta.icns` ->
// `build/icon.beta.icon`, ...) with Xcode's `actool` into `Assets.car` and sets
// `CFBundleIconName`. `CFBundleIconFile` (`icon.icns`) stays as it is, so
// macOS 15 and older keep showing the curated `.icns`. The catalog targets
// macOS 26 only, like electron-builder's own `.icon` support.
//
// Why not electron-builder's `mac.icon: "*.icon"` (26.15.3)? It replaces
// `icon.icns` with actool's rendering of the `.icon`, and it fails every Mac
// build whose selected Xcode is older than 26. This finds an Xcode 26 or newer
// by itself (CI images keep one beside an older default) and keeps the `.icns`.
//
// ADE_MAC_ICON_COMPOSER: `required` fails the build when the icon cannot be
// compiled, `off` skips it. Unset, it is required when the build signs
// (CSC_LINK or CSC_NAME, every release build) and a warning otherwise, so a
// local `dist:mac:dir` on a Mac without Xcode 26 still builds.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ICON_NAME = "AppIcon";
const MIN_ACTOOL_MAJOR = 26;

function iconComposerMode(env = process.env) {
  const value = String(env.ADE_MAC_ICON_COMPOSER || "").trim().toLowerCase();
  if (value === "off" || value === "required") return value;
  return env.CSC_LINK || env.CSC_NAME ? "required" : "optional";
}

/** The `.icon` package beside the configured `.icns`, or null when there is none. */
function iconComposerSourceFor(configuredIcon, searchDirs) {
  const icns = typeof configuredIcon === "string" && configuredIcon.trim() ? configuredIcon.trim() : "build/icon.icns";
  if (!/\.icns$/i.test(icns)) return null;
  const relative = icns.replace(/\.icns$/i, ".icon");
  for (const dir of searchDirs) {
    const candidate = path.resolve(dir, relative);
    if (fs.existsSync(path.join(candidate, "icon.json"))) return candidate;
  }
  return null;
}

function actoolMajorVersion(env) {
  const result = spawnSync("/usr/bin/xcrun", ["actool", "--version"], { encoding: "utf8", env, timeout: 60_000 });
  if (result.status !== 0) return null;
  const match = /<key>short-bundle-version<\/key>\s*<string>(\d+)/.exec(`${result.stdout || ""}`);
  return match ? Number(match[1]) : null;
}

/**
 * The environment to run an actool 26 or newer with: the selected Xcode's
 * when it is new enough, else the newest `/Applications/Xcode*.app` that is,
 * through DEVELOPER_DIR. Null when there is none.
 */
function findActoolEnv(env = process.env, applicationsDir = "/Applications") {
  const selected = actoolMajorVersion(env);
  if (selected != null && selected >= MIN_ACTOOL_MAJOR) return { env, version: selected, developerDir: env.DEVELOPER_DIR || null };
  let apps = [];
  try {
    apps = fs.readdirSync(applicationsDir).filter((name) => /^Xcode.*\.app$/.test(name));
  } catch {
    return null;
  }
  // Newest first by the number in the name (`Xcode_26.1.app`, `Xcode-27.2.app`); plain `Xcode.app` last.
  const versionOf = (name) => Number(/(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? 0);
  apps.sort((a, b) => versionOf(b) - versionOf(a));
  for (const app of apps) {
    const developerDir = path.join(applicationsDir, app, "Contents", "Developer");
    if (!fs.existsSync(developerDir)) continue;
    const candidateEnv = { ...env, DEVELOPER_DIR: developerDir };
    const version = actoolMajorVersion(candidateEnv);
    if (version != null && version >= MIN_ACTOOL_MAJOR) return { env: candidateEnv, version, developerDir };
  }
  return null;
}

/** Compiles `iconPath` (a `.icon` package) and returns the `Assets.car` bytes. */
function compileAssetCatalog(iconPath, toolEnv) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-icon-composer-"));
  try {
    // actool names the app icon after the package: `<ICON_NAME>.icon`.
    const input = path.join(tempDir, `${ICON_NAME}.icon`);
    const output = path.join(tempDir, "out");
    fs.cpSync(iconPath, input, { recursive: true });
    fs.mkdirSync(output);
    const result = spawnSync("/usr/bin/xcrun", [
      "actool", input,
      "--compile", output,
      "--output-format", "human-readable-text",
      "--notices", "--warnings", "--errors",
      "--output-partial-info-plist", path.join(output, "assetcatalog_generated_info.plist"),
      "--app-icon", ICON_NAME,
      "--include-all-app-icons",
      "--enable-on-demand-resources", "NO",
      "--development-region", "en",
      "--target-device", "mac",
      "--minimum-deployment-target", "26.0",
      "--platform", "macosx",
    ], { encoding: "utf8", env: toolEnv, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const catalog = path.join(output, "Assets.car");
    if (result.status !== 0 || !fs.existsSync(catalog)) {
      const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
      throw new Error(`actool could not compile ${iconPath} (exit ${result.status}).${detail ? `\n${detail}` : ""}`);
    }
    return fs.readFileSync(catalog);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * afterPack (macOS): adds the macOS 26 icon to `appBundlePath`. Returns what
 * it did, or throws when the mode is `required` and it cannot.
 */
function applyMacIconComposerIcon(appBundlePath, {
  configuredIcon,
  searchDirs,
  env = process.env,
  log = console.log,
} = {}) {
  const mode = iconComposerMode(env);
  if (mode === "off") return { applied: false, reason: "ADE_MAC_ICON_COMPOSER=off" };
  const skip = (reason) => {
    if (mode === "required") {
      throw new Error(`[afterPack] The macOS 26 app icon is required for this build, but ${reason}. Set ADE_MAC_ICON_COMPOSER=off to build without it.`);
    }
    log(`[afterPack] Warning: no macOS 26 app icon (${reason}); macOS 26 shows the .icns in a grey frame.`);
    return { applied: false, reason };
  };
  if (process.platform !== "darwin") return skip("actool runs only on macOS");
  const source = iconComposerSourceFor(configuredIcon, searchDirs);
  if (!source) return skip(`there is no .icon package beside ${configuredIcon || "build/icon.icns"}`);
  const tool = findActoolEnv(env);
  if (!tool) return skip(`no Xcode ${MIN_ACTOOL_MAJOR} or newer was found (actool)`);

  const catalog = compileAssetCatalog(source, tool.env);
  const contents = path.join(appBundlePath, "Contents");
  fs.writeFileSync(path.join(contents, "Resources", "Assets.car"), catalog);
  const plist = spawnSync("/usr/bin/plutil", ["-replace", "CFBundleIconName", "-string", ICON_NAME, path.join(contents, "Info.plist")], { encoding: "utf8" });
  if (plist.status !== 0) {
    throw new Error(`[afterPack] Could not set CFBundleIconName in ${contents}/Info.plist: ${`${plist.stderr || ""}`.trim()}`);
  }
  log(`[afterPack] macOS 26 app icon: ${path.basename(source)} -> Assets.car (actool ${tool.version}${tool.developerDir ? `, ${tool.developerDir}` : ""})`);
  return { applied: true, source };
}

module.exports = {
  applyMacIconComposerIcon,
  iconComposerSourceFor,
};
