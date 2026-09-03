#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveNpmInvocation } from "./dev-shared.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const currentRepoRoot = path.resolve(scriptDir, "..");
const APPLE_EVENTS_USAGE_DESCRIPTION =
  "ADE launches agent terminals that can use local app automation through Codex Computer Use.";

const CHANNELS = {
  alpha: {
    source: "current",
    productName: "ADE Alpha",
    appId: "com.ade.desktop.alpha",
    cliName: "ade-alpha",
    adeHome: path.join(os.homedir(), ".ade-alpha"),
    outputDir: "release-alpha",
  },
  beta: {
    source: "origin-main",
    productName: "ADE Beta",
    appId: "com.ade.desktop.beta",
    cliName: "ade-beta",
    adeHome: path.join(os.homedir(), ".ade-beta"),
    outputDir: "release-beta",
  },
};

function usage() {
  process.stdout.write([
    "Usage: node scripts/package-channel.mjs <alpha|beta> [options]",
    "",
    "Builds a local packaged ADE channel without using the GitHub release workflow.",
    "macOS produces a .app; Windows produces an NSIS installer, signed when the",
    "Azure signing environment is present and unsigned otherwise.",
    "",
    "Channels:",
    "  alpha    Builds the current checkout as ADE Alpha.",
    "  beta     Fetches origin/main, fast-forwards local main, and builds it as ADE Beta.",
    "",
    "Options:",
    "  --skip-install       Do not run app-local npm install before building.",
    "  --skip-fetch         For beta, do not fetch origin/main before the fast-forward check.",
    "  --dry-run            Print the commands without running them.",
    "  --sign <identity>    macOS: sign with this certificate name or SHA-1 hash instead of ad-hoc.",
    "  --sign-auto          macOS: sign with the first valid Developer ID Application identity,",
    "                       else the first valid Apple Development identity.",
    "  --repo <path>        Internal/debug: build the selected channel from an existing repo path.",
    "  --help               Show this help.",
    "",
    "Signing:",
    "  ADE_CHANNEL_SIGN_IDENTITY sets the same identity as --sign; the flag wins.",
    "  Without one of these the app is signed ad-hoc, so every rebuild produces a new",
    "  code signature and macOS re-prompts for the keychain items the previous build",
    "  created. A stable identity keeps those keychain ACLs valid across rebuilds.",
    "",
  ].join("\n"));
}

function fail(message) {
  process.stderr.write(`[ade] ${message}\n`);
  process.exit(1);
}

export function parseArgs(argv) {
  const options = {
    channel: null,
    skipInstall: false,
    skipFetch: false,
    dryRun: false,
    signIdentity: null,
    signAuto: false,
    repo: null,
  };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--skip-install") {
      options.skipInstall = true;
      continue;
    }
    if (arg === "--skip-fetch") {
      options.skipFetch = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--sign") {
      const value = args.shift();
      if (!value) fail("--sign requires a certificate name or SHA-1 hash.");
      options.signIdentity = value;
      continue;
    }
    if (arg.startsWith("--sign=")) {
      options.signIdentity = arg.slice("--sign=".length);
      continue;
    }
    if (arg === "--sign-auto") {
      options.signAuto = true;
      continue;
    }
    if (arg === "--repo") {
      const value = args.shift();
      if (!value) fail("--repo requires a path.");
      options.repo = path.resolve(value);
      continue;
    }
    if (arg.startsWith("--repo=")) {
      options.repo = path.resolve(arg.slice("--repo=".length));
      continue;
    }
    if (arg.startsWith("-")) fail(`Unknown option: ${arg}`);
    if (options.channel) fail(`Unexpected extra argument: ${arg}`);
    options.channel = arg;
  }
  if (!options.channel) fail("Missing channel. Use alpha or beta.");
  if (!CHANNELS[options.channel]) fail(`Unknown channel: ${options.channel}`);
  return options;
}

/**
 * macOS code signing for local channel builds.
 *
 * An ad-hoc signature's designated requirement is the bundle's own cdhash, so
 * every rebuild is a different program to the keychain. Items the previous
 * build created — the desktop API key store (`com.ade.desktop.api-keys.v1`),
 * the runtime credential key (`com.ade.runtime.credentials.file-store-key.v1`)
 * and Electron's `<productName> Safe Storage` item — keep their ACL bound to
 * the old binary and prompt again. A real certificate gives the bundle a
 * stable designated requirement, so those ACLs keep matching.
 */
const APPLE_CERTIFICATE_NAME_PREFIXES = [
  "Developer ID Application:",
  "Developer ID Installer:",
  "3rd Party Mac Developer Application:",
  "3rd Party Mac Developer Installer:",
];

const DEVELOPMENT_CERTIFICATE_NAME_PREFIXES = ["Apple Development", "Mac Developer"];

/**
 * electron-builder only looks for a `Developer ID Application` certificate
 * unless `mac.type` is `development` (app-builder-lib `getCertificateTypes`),
 * so a development certificate needs that flag to be selected deliberately
 * rather than through the "non-Apple certificate" fallback.
 */
export function signingCertificateType(name) {
  const value = (name ?? "").trim().toLowerCase();
  const isDevelopment = DEVELOPMENT_CERTIFICATE_NAME_PREFIXES.some(
    (prefix) => value.startsWith(prefix.toLowerCase()),
  );
  return isDevelopment ? "development" : "distribution";
}

/** A SHA-1 certificate hash carries no certificate type, so it cannot be classified. */
export function looksLikeCertificateHash(value) {
  return /^[0-9A-Fa-f]{40}$/.test((value ?? "").trim());
}

/**
 * `security find-identity` prints the certificate type as part of the name, and
 * that is what a person copies. electron-builder rejects a qualifier that still
 * carries the prefix (`checkPrefix` in app-builder-lib), so strip it for the
 * qualifier and keep the original text for the printed line.
 */
export function normalizeSignIdentity(rawValue) {
  const value = (rawValue ?? "").trim();
  if (!value) return null;
  if (looksLikeCertificateHash(value)) {
    // Nothing in a hash says development or distribution. Only the keychain
    // lookup can classify it, so an unresolved hash stays unclassified rather
    // than being defaulted to distribution.
    return { qualifier: value, display: value, type: "unknown" };
  }
  let qualifier = value;
  for (const prefix of APPLE_CERTIFICATE_NAME_PREFIXES) {
    if (qualifier.toLowerCase().startsWith(prefix.toLowerCase())) {
      qualifier = qualifier.slice(prefix.length).trim();
      break;
    }
  }
  if (!qualifier) return null;
  return { qualifier, display: value, type: signingCertificateType(value) };
}

/** Parse the `1) <sha1> "<name>"` lines of `security find-identity -v -p codesigning`. */
export function parseCodesigningIdentities(output) {
  const identities = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (line.includes("CSSMERR_TP_CERT_REVOKED")) continue;
    const match = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"/.exec(line);
    if (!match) continue;
    identities.push({ hash: match[1], name: match[2] });
  }
  return identities;
}

/** Turn a keychain entry into the identity the build passes to electron-builder. */
export function toSignIdentity(entry) {
  return {
    qualifier: entry.hash,
    display: `${entry.name} (${entry.hash})`,
    type: signingCertificateType(entry.name),
  };
}

/** Prefer a Developer ID Application certificate, then an Apple Development one. */
export function selectAutoSignIdentity(output) {
  const identities = parseCodesigningIdentities(output);
  const preferred = identities.find((identity) => identity.name.startsWith("Developer ID Application:"))
    ?? identities.find((identity) => identity.name.startsWith("Apple Development"));
  return preferred ? toSignIdentity(preferred) : null;
}

/**
 * Find the certificate a `--sign` value names, so a SHA-1 hash can be
 * classified by the name it belongs to. The substring match is what
 * electron-builder itself does with a qualifier.
 */
export function lookupSignIdentity(output, rawValue) {
  const value = (rawValue ?? "").trim();
  if (!value) return null;
  const identities = parseCodesigningIdentities(output);
  const lower = value.toLowerCase();
  const entry = identities.find((identity) => identity.hash.toLowerCase() === lower)
    ?? identities.find((identity) => identity.name === value)
    ?? identities.find((identity) => identity.name.includes(value));
  return entry ? toSignIdentity(entry) : null;
}

/**
 * Entitlements that only a provisioning profile can authorize.
 *
 * A local channel build is signed without a profile, and AMFI refuses to launch
 * a hardened-runtime binary that claims one of these anyway: `open` reports
 * "Launchd job spawn failed" (RBSRequestErrorDomain 5 / POSIX 163). An ad-hoc
 * signature is not held to this, which is why the default path never hit it.
 */
const RESTRICTED_ENTITLEMENT_KEYS = new Set([
  "keychain-access-groups",
  "application-identifier",
  "com.apple.application-identifier",
]);

export function isRestrictedEntitlement(name) {
  const key = (name ?? "").trim();
  return RESTRICTED_ENTITLEMENT_KEYS.has(key) || key.startsWith("com.apple.developer.");
}

/** End offset of the XML element that starts at or after `from`. */
function endOfNextElement(xml, from) {
  const tagPattern = /<([A-Za-z][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  tagPattern.lastIndex = from;
  const opening = tagPattern.exec(xml);
  if (!opening) return null;
  if (opening[3] === "/") return opening.index + opening[0].length;
  const name = opening[1];
  const pairPattern = new RegExp(`<(/?)${name}((?:[^>"']|"[^"]*"|'[^']*')*?)(/?)>`, "g");
  pairPattern.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  let tag = pairPattern.exec(xml);
  while (tag) {
    if (tag[3] !== "/") {
      depth += tag[1] === "/" ? -1 : 1;
      if (depth === 0) return tag.index + tag[0].length;
    }
    tag = pairPattern.exec(xml);
  }
  return null;
}

/**
 * Remove every provisioning-restricted key, and its value, from an
 * entitlements plist. Text in, text out: the file keeps its formatting and no
 * plist library is needed.
 */
export function stripRestrictedEntitlements(source) {
  let xml = String(source ?? "");
  const dropped = [];
  const keyPattern = /<key>([^<]*)<\/key>/g;
  let searchFrom = 0;
  for (;;) {
    keyPattern.lastIndex = searchFrom;
    const match = keyPattern.exec(xml);
    if (!match) break;
    const afterKey = match.index + match[0].length;
    const name = match[1].trim();
    if (!isRestrictedEntitlement(name)) {
      searchFrom = afterKey;
      continue;
    }
    const valueEnd = endOfNextElement(xml, afterKey);
    if (valueEnd == null) {
      searchFrom = afterKey;
      continue;
    }
    let start = match.index;
    while (start > 0 && (xml[start - 1] === " " || xml[start - 1] === "\t")) start -= 1;
    let end = valueEnd;
    if (xml.startsWith("\r\n", end)) end += 2;
    else if (xml[end] === "\n") end += 1;
    xml = xml.slice(0, start) + xml.slice(end);
    dropped.push(name);
    searchFrom = start;
  }
  return { xml, dropped };
}

/** The flag wins over the environment variable. */
export function resolveSignSelection(options, env = process.env) {
  if (options.signIdentity) return { mode: "explicit", value: options.signIdentity, fromEnv: false };
  if (options.signAuto) return { mode: "auto" };
  const fromEnv = env.ADE_CHANNEL_SIGN_IDENTITY?.trim();
  if (fromEnv) return { mode: "explicit", value: fromEnv, fromEnv: true };
  return { mode: "adhoc" };
}

/**
 * Windows ships npm as a `.cmd` shim, which Node cannot spawn by bare name
 * (`ENOENT`) or by its `.cmd` name (`EINVAL`, since CVE-2024-27980) — both
 * measured. This script only ever ran on macOS, where the bare name is correct,
 * so the gap surfaced the first time channel packaging ran on Windows.
 *
 * `resolveNpmInvocation` is the repo's existing answer: on Windows it runs
 * npm's own JavaScript entry point under this process's `node`, so there is no
 * shell in the picture and therefore no re-parsing of paths containing spaces.
 * Only npm is rewritten — `git` is extensionless on the command line too, but
 * is a real `git.exe` and must be spawned as-is.
 */
function resolveRunnableCommand(command, args) {
  if (command !== "npm") return { command, args };
  return resolveNpmInvocation(args);
}

function run(command, args, options = {}) {
  const cwd = options.cwd ?? currentRepoRoot;
  const env = options.env ?? process.env;
  const printable = [command, ...args].join(" ");
  process.stdout.write(`[ade] ${cwd}$ ${printable}\n`);
  if (options.dryRun) return;
  const invocation = resolveRunnableCommand(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return;
    throw new Error(`${printable} exited with ${result.status ?? "unknown status"}`);
  }
}

function gitOutput(args, options = {}) {
  const cwd = options.cwd ?? currentRepoRoot;
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} exited with ${result.status ?? "unknown status"}`);
  }
  return result.stdout.trim();
}

function removePath(targetPath, dryRun) {
  if (dryRun) {
    process.stdout.write(`[ade] rm -rf ${targetPath}\n`);
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function currentTarget() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${platform}-${arch}`;
}

function runtimeArtifactNames(target) {
  return [`ade-${target}`, `ade-${target}.native.tar.gz`];
}

function readDesktopVersion(repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "utf8"));
  const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  if (!version) fail("apps/desktop/package.json is missing a version.");
  return version;
}

function assertRuntimeArtifacts(repoRoot, target) {
  const runtimeRoot = path.join(repoRoot, "apps", "desktop", "resources", "runtime");
  for (const name of runtimeArtifactNames(target)) {
    const artifactPath = path.join(runtimeRoot, name);
    const stat = fs.existsSync(artifactPath) ? fs.statSync(artifactPath) : null;
    if (!stat?.isFile() || stat.size <= 0) {
      fail(`Missing host runtime artifact after build: ${artifactPath}`);
    }
  }
}

function cleanHostRuntimeArtifacts(repoRoot, target, options) {
  const runtimeRoot = path.join(repoRoot, "apps", "desktop", "resources", "runtime");
  for (const name of runtimeArtifactNames(target)) {
    removePath(path.join(runtimeRoot, name), options.dryRun);
  }
}

function ensureHostRuntimeResources(repoRoot, options, baseEnv = process.env) {
  const target = currentTarget();
  const env = {
    ...baseEnv,
    ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY: "1",
  };
  cleanHostRuntimeArtifacts(repoRoot, target, options);
  run("npm", [
    "--prefix",
    "apps/desktop",
    "run",
    "materialize:runtime-resources",
  ], { cwd: repoRoot, env, dryRun: options.dryRun });
  if (!options.dryRun) assertRuntimeArtifacts(repoRoot, target);
  cleanRuntimeBuildIntermediates(repoRoot, target, options);
}

function cleanRuntimeBuildIntermediates(repoRoot, target, options) {
  const runtimeRoot = path.join(repoRoot, "apps", "desktop", "resources", "runtime");
  removePath(path.join(runtimeRoot, ".sea"), options.dryRun);
  removePath(path.join(runtimeRoot, `ade-${target}.native`), options.dryRun);
}

function ensureRepoRoot(repoRoot, options) {
  if (options.dryRun && !fs.existsSync(repoRoot)) return;
  if (!fs.existsSync(path.join(repoRoot, "apps", "desktop", "package.json"))) {
    fail(`${repoRoot} is not an ADE repo root.`);
  }
}

function packageScriptExists(repoRoot, packagePath, scriptName) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, packagePath), "utf8"));
    return typeof packageJson?.scripts?.[scriptName] === "string";
  } catch {
    return false;
  }
}

function assertPackageChannelPrereqs(repoRoot, channel, options) {
  if (options.dryRun && !fs.existsSync(repoRoot)) return;
  if (packageScriptExists(repoRoot, path.join("apps", "ade-cli", "package.json"), "build:static")) return;
  if (channel === "beta") {
    throw new Error(
      "origin/main does not include ADE's static runtime packaging script yet. " +
        "Run npm run package:beta after this branch lands on main, or build Alpha from the current checkout.",
    );
  }
  throw new Error("apps/ade-cli/package.json is missing the build:static script required for local channel packages.");
}

function prepareBetaCheckout(options) {
  if (!options.skipFetch) {
    run("git", ["fetch", "origin", "main"], { cwd: currentRepoRoot, dryRun: options.dryRun });
  }
  if (options.dryRun) {
    run("git", ["merge", "--ff-only", "origin/main"], { cwd: currentRepoRoot, dryRun: true });
    return currentRepoRoot;
  }
  const branch = gitOutput(["branch", "--show-current"]);
  if (branch !== "main") {
    fail("package:beta builds the local main checkout after fetching origin/main. Check out main first, or use --repo <path> for an explicit source.");
  }
  run("git", ["merge", "--ff-only", "origin/main"], { cwd: currentRepoRoot });
  const status = gitOutput(["status", "--porcelain"]);
  if (status) {
    process.stdout.write("[ade] Warning: building beta with local working tree changes. Commit or stash first for a byte-for-byte clean origin/main beta.\n");
  }
  const aheadBehind = gitOutput(["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
  const [ahead = "0"] = aheadBehind.split(/\s+/);
  if (Number(ahead) > 0) {
    process.stdout.write("[ade] Warning: local main has commits not on origin/main. Push first for a remote-main-only beta.\n");
  }
  return currentRepoRoot;
}

function installApps(repoRoot, options) {
  if (options.skipInstall) return;
  run("npm", ["--prefix", "apps/ade-cli", "install"], { cwd: repoRoot, dryRun: options.dryRun });
  run("npm", ["--prefix", "apps/desktop", "install"], { cwd: repoRoot, dryRun: options.dryRun });
}

function findBuiltApp(outputRoot, productName) {
  const matches = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        matches.push(entryPath);
        continue;
      }
      if (entry.isDirectory()) walk(entryPath);
    }
  };
  walk(outputRoot);
  const exact = matches.find((candidate) => path.basename(candidate) === `${productName}.app`);
  return exact ?? matches[0] ?? null;
}

function zipApp(appPath, outputRoot, channel, options) {
  if (process.platform !== "darwin") return null;
  const zipPath = path.join(outputRoot, `${CHANNELS[channel].productName.replace(/\s+/g, "-")}-local.zip`);
  removePath(zipPath, options.dryRun);
  run("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], {
    cwd: path.dirname(appPath),
    dryRun: options.dryRun,
  });
  return zipPath;
}

function postprocessChannelApp(appPath, channel, config, options) {
  const resourcesRoot = path.join(appPath, "Contents", "Resources");
  const cliRoot = path.join(resourcesRoot, "ade-cli");
  const binRoot = path.join(cliRoot, "bin");
  const sourceWrapper = path.join(binRoot, "ade");
  const channelWrapper = path.join(binRoot, config.cliName);
  if (options.dryRun) {
    process.stdout.write(`[ade] stamp ${config.cliName} in ${appPath}\n`);
    return;
  }
  if (!fs.existsSync(sourceWrapper)) fail(`Packaged app is missing bundled CLI wrapper: ${sourceWrapper}`);
  fs.copyFileSync(sourceWrapper, channelWrapper);
  fs.chmodSync(sourceWrapper, 0o755);
  fs.chmodSync(channelWrapper, 0o755);
  fs.writeFileSync(path.join(cliRoot, "channel"), `${channel}\n`);
}

/**
 * Seal the bundle after `postprocessChannelApp` added files under
 * `Contents/Resources`, which invalidates whatever seal the packager wrote.
 *
 * With an identity electron-builder has already signed every nested binary, so
 * only the outer bundle is re-sealed, and `--preserve-metadata` keeps the
 * entitlements and the hardened-runtime flag it set. Without an identity this
 * is the ad-hoc pass the script has always run.
 */
function signLocalMacApp(appPath, identity) {
  if (process.platform !== "darwin") return;
  const cwd = path.dirname(appPath);
  if (identity) {
    process.stdout.write(`[ade] Signing local app bundle with ${identity.display}: ${appPath}\n`);
    run("codesign", [
      "--force",
      "--sign",
      identity.qualifier,
      "--timestamp=none",
      "--preserve-metadata=entitlements,requirements,flags",
      appPath,
    ], { cwd });
  } else {
    process.stdout.write(`[ade] Ad-hoc signing local app bundle: ${appPath}\n`);
    run("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], { cwd });
  }
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { cwd });
}

/**
 * Ask the keychain for a signing identity. Read-only, so it also runs under
 * `--dry-run`: the printed electron-builder command has to name the identity
 * the real build would use.
 */
function readCodesigningIdentities() {
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exited with ${result.status ?? "unknown status"}`;
    process.stdout.write(`[ade] security find-identity failed (${detail}).\n`);
    return null;
  }
  return result.stdout;
}

function resolveMacSignIdentity(selection) {
  if (selection.mode === "adhoc") return null;
  const output = readCodesigningIdentities();

  if (selection.mode === "auto") {
    const identity = output ? selectAutoSignIdentity(output) : null;
    if (!identity) {
      process.stdout.write(
        "[ade] --sign-auto: no valid Developer ID Application or Apple Development identity found; using an ad-hoc signature.\n",
      );
    }
    return identity;
  }

  const source = selection.fromEnv ? "ADE_CHANNEL_SIGN_IDENTITY" : "--sign";
  const resolved = output ? lookupSignIdentity(output, selection.value) : null;
  if (resolved) return resolved;

  const identity = normalizeSignIdentity(selection.value);
  if (!identity) fail(`${source} requires a certificate name or SHA-1 hash.`);
  process.stdout.write(
    `[ade] ${source}: ${identity.display} matches no valid codesigning identity on this Mac. `
      + "Passing it through unresolved; the build machine must hold the certificate.\n",
  );
  if (identity.type === "unknown") {
    process.stdout.write(
      "[ade] Certificate type unknown, so -c.mac.type is left unset. Run this on the machine that holds the certificate, "
        + "or pass the certificate NAME, to select a development certificate.\n",
    );
  }
  return identity;
}

const ENTITLEMENT_FILES = [
  { key: "entitlements", name: "entitlements.mac.plist" },
  { key: "entitlementsInherit", name: "entitlements.mac.inherit.plist" },
];

/**
 * Give a signed local build entitlements it is allowed to claim.
 *
 * Returns null when nothing has to change, so the ad-hoc path and any build
 * whose entitlements carry no restricted key keep the repo's own files.
 */
function prepareSignedEntitlements(desktopRoot, identity, options) {
  if (!identity) return null;
  const sources = ENTITLEMENT_FILES.map((entry) => ({
    ...entry,
    sourcePath: path.join(desktopRoot, "build", entry.name),
  })).filter((entry) => fs.existsSync(entry.sourcePath));
  if (sources.length === 0) return null;

  const filtered = sources.map((entry) => ({
    ...entry,
    ...stripRestrictedEntitlements(fs.readFileSync(entry.sourcePath, "utf8")),
  }));
  const dropped = [...new Set(filtered.flatMap((entry) => entry.dropped))];
  if (dropped.length === 0) return null;

  const dir = path.join(os.tmpdir(), `ade-channel-entitlements-${process.pid}`);
  process.stdout.write(
    `[ade] Dropping provisioning-restricted entitlements for this signed build: ${dropped.join(", ")}. `
      + "A local channel build has no provisioning profile, and macOS refuses to launch a signed app that claims them. "
      + "Passkey and WebAuthn keychain sharing is unavailable in this build.\n",
  );
  if (options.dryRun) {
    process.stdout.write(`[ade] dry-run: filtered entitlements would be written to ${dir}\n`);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of filtered) fs.writeFileSync(path.join(dir, entry.name), entry.xml);
  }
  const paths = {};
  for (const entry of filtered) paths[entry.key] = path.join(dir, entry.name);
  return { dir, paths };
}

/** The electron-builder invocation for a macOS channel build. */
export function macBuilderArgs({ channel, config, outputRoot, identity, entitlements = null }) {
  const args = ["electron-builder", "--dir", "--mac", "--publish", "never"];
  if (identity) {
    args.push(`-c.mac.identity=${identity.qualifier}`);
    if (identity.type === "development") args.push("-c.mac.type=development");
    // The repo carries no build/ade-desktop.provisionprofile, and a local
    // channel build does not need one. Left set, signing fails on the missing
    // file instead of producing a signed app.
    //
    // The value must be EMPTY, not "null": electron-builder coerces the string
    // "null" to null for `mac.identity` alone (`coerceValue` in
    // electron-builder/out/builder.js), so "null" reaches
    // `@electron/osx-sign` as a file path and it runs `security cms -D -i null`.
    // An empty string is falsy at `macPackager.js` `provisioningProfile ||
    // undefined`, which is what actually unsets it.
    args.push("-c.mac.provisioningProfile=");
    if (entitlements?.paths.entitlements) {
      args.push(`-c.mac.entitlements=${entitlements.paths.entitlements}`);
    }
    if (entitlements?.paths.entitlementsInherit) {
      args.push(`-c.mac.entitlementsInherit=${entitlements.paths.entitlementsInherit}`);
    }
  } else {
    args.push("-c.mac.identity=null");
  }
  args.push(
    "-c.mac.notarize=false",
    `-c.appId=${config.appId}`,
    `-c.productName=${config.productName}`,
    `-c.mac.icon=build/icon.${channel}.icns`,
    `-c.directories.output=${outputRoot}`,
    `-c.extraMetadata.adePackageChannel=${channel}`,
    `-c.extraMetadata.adeCliName=${config.cliName}`,
    `-c.mac.extendInfo.LSEnvironment.ADE_PACKAGE_CHANNEL=${channel}`,
    `-c.mac.extendInfo.LSEnvironment.ADE_DESKTOP_APP_NAME=${config.productName}`,
    `-c.mac.extendInfo.LSEnvironment.ADE_HOME=${config.adeHome}`,
    `-c.mac.extendInfo.NSAppleEventsUsageDescription=${APPLE_EVENTS_USAGE_DESCRIPTION}`,
  );
  return args;
}

const AZURE_SIGNING_ENV = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];

/**
 * Build a channel installer on Windows.
 *
 * Unlike the macOS path this does not drive electron-builder directly. The
 * Windows packaging chain (`dist:win`) also materializes and validates runtime
 * resources, runs the artifact preflight, and runs the release
 * validator afterwards — reimplementing that here would mean maintaining a
 * second copy of a contract the release path depends on. So the channel is
 * expressed purely as environment, and the maintained script does the work.
 *
 * `ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY` + `ADE_WINDOWS_TEST_BUILD` are what
 * relax the Darwin/Linux remote-runtime sidecar requirement, which a Windows
 * host cannot satisfy — it cannot build Darwin binaries. The resulting install
 * therefore cannot bootstrap a remote macOS/Linux runtime; that is a documented
 * gap of local channel builds, not of Windows itself. CI-built installers carry
 * the full sidecar set.
 */
function buildWindowsChannel(repoRoot, channel, config, env, options) {
  const missingSigningEnv = AZURE_SIGNING_ENV.filter((name) => !process.env[name]?.trim());
  const canSign = missingSigningEnv.length === 0 && Boolean(process.env.WINDOWS_SIGNING_EXPECTED_SUBJECT?.trim());
  const distScript = canSign ? "dist:win:signed" : "dist:win";

  if (canSign) {
    process.stdout.write("[ade] Azure signing credentials present - building a signed installer.\n");
  } else {
    const missing = missingSigningEnv.length > 0
      ? missingSigningEnv.join(", ")
      : "WINDOWS_SIGNING_EXPECTED_SUBJECT";
    process.stdout.write(
      `[ade] Building UNSIGNED (missing ${missing}). Windows will show a SmartScreen warning on install.\n`,
    );
  }

  run("npm", ["--prefix", "apps/desktop", "run", distScript], {
    cwd: repoRoot,
    env: {
      ...env,
      ADE_WINDOWS_TEST_BUILD: "1",
      // dist:win:signed reads the Azure service principal from the environment.
      // It is inherited rather than echoed, so no credential is ever printed by
      // the `[ade] <cwd>$ <command>` trace above.
    },
    dryRun: options.dryRun,
  });

  if (options.dryRun) return;
  const outputRoot = path.join(repoRoot, "apps", "desktop", config.outputDir);
  const installer = fs.existsSync(outputRoot)
    ? fs.readdirSync(outputRoot).find((name) => /-win-x64\.exe$/.test(name))
    : null;
  if (!installer) {
    fail(`Build finished but no Windows installer was found in ${outputRoot}.`);
  }
  process.stdout.write(`\n[ade] Built ${config.productName}: ${path.join(outputRoot, installer)}\n`);
  process.stdout.write(`[ade] Signed: ${canSign ? "yes" : "no (SmartScreen warning expected)"}\n`);
  process.stdout.write(`[ade] Bundled CLI name: ${config.cliName}\n`);
  process.stdout.write(`[ade] Channel ADE_HOME: ${config.adeHome}\n`);
  process.stdout.write("[ade] Remote macOS/Linux runtimes are unavailable in a local channel build.\n");
}

function buildChannel(repoRoot, channel, options) {
  const config = CHANNELS[channel];
  ensureRepoRoot(repoRoot, options);
  const desktopRoot = path.join(repoRoot, "apps", "desktop");
  const outputRepoRoot = channel === "beta" && !options.repo ? currentRepoRoot : repoRoot;
  const outputRoot = path.join(outputRepoRoot, "apps", "desktop", config.outputDir);
  const appVersion = readDesktopVersion(repoRoot);
  const env = {
    ...process.env,
    ADE_PACKAGE_CHANNEL: channel,
    ADE_CLI_VERSION: appVersion,
    ADE_DESKTOP_APP_NAME: config.productName,
    ADE_HOME: config.adeHome,
    ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY: "1",
  };

  const signSelection = resolveSignSelection(options);

  removePath(outputRoot, options.dryRun);
  assertPackageChannelPrereqs(repoRoot, channel, options);
  installApps(repoRoot, options);
  run("npm", ["--prefix", "apps/ade-cli", "run", "build"], { cwd: repoRoot, env, dryRun: options.dryRun });

  if (process.platform === "win32") {
    if (signSelection.mode !== "adhoc") {
      process.stdout.write(
        "[ade] --sign / --sign-auto / ADE_CHANNEL_SIGN_IDENTITY apply to macOS only. Windows signing uses the Azure environment.\n",
      );
    }
    buildWindowsChannel(repoRoot, channel, config, env, options);
    return;
  }

  const signIdentity = resolveMacSignIdentity(signSelection);
  if (signIdentity) {
    process.stdout.write(`[ade] Signing identity: ${signIdentity.display} [${signIdentity.type}]\n`);
  } else {
    process.stdout.write(
      "[ade] Signing identity: ad-hoc. Every rebuild changes the signature, so macOS re-prompts for this app's keychain items. Use --sign-auto or --sign <identity> for a stable one.\n",
    );
  }

  const entitlements = prepareSignedEntitlements(desktopRoot, signIdentity, options);
  try {
    ensureHostRuntimeResources(repoRoot, options, env);
    run("npm", ["--prefix", "apps/desktop", "run", "build"], { cwd: repoRoot, env, dryRun: options.dryRun });
    run("npx", macBuilderArgs({ channel, config, outputRoot, identity: signIdentity, entitlements }), {
      cwd: desktopRoot,
      env,
      dryRun: options.dryRun,
    });

    if (options.dryRun) return;
    const appPath = findBuiltApp(outputRoot, config.productName);
    if (!appPath) fail(`Build finished but no .app was found in ${outputRoot}.`);
    postprocessChannelApp(appPath, channel, config, options);
    signLocalMacApp(appPath, signIdentity);
    const zipPath = zipApp(appPath, outputRoot, channel, options);
    process.stdout.write(`\n[ade] Built ${config.productName}: ${appPath}\n`);
    if (zipPath) process.stdout.write(`[ade] Zipped app: ${zipPath}\n`);
    process.stdout.write(`[ade] Signed with: ${signIdentity ? signIdentity.display : "ad-hoc signature"}\n`);
    process.stdout.write(`[ade] Bundled CLI name: ${config.cliName}\n`);
    process.stdout.write(`[ade] Channel ADE_HOME: ${config.adeHome}\n`);
  } finally {
    // The bundle is already signed by here, so the filtered copies are no
    // longer needed. `signLocalMacApp` re-seals with --preserve-metadata and
    // reads no entitlements file.
    if (entitlements && !options.dryRun) removePath(entitlements.dir, false);
  }
}

function main() {
  let parsedOptions = null;
  let selectedRepoRoot = null;
  try {
    parsedOptions = parseArgs(process.argv.slice(2));
    selectedRepoRoot = parsedOptions.repo
      ? parsedOptions.repo
      : parsedOptions.channel === "beta"
        ? prepareBetaCheckout(parsedOptions)
        : currentRepoRoot;
    buildChannel(selectedRepoRoot, parsedOptions.channel, parsedOptions);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Only build when run as a program. The test file imports the pure helpers
 * above, and an import must not start a packaging run.
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) main();
