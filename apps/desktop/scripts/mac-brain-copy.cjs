// The brain copy: a second copy of the app's own executable,
// `Contents/MacOS/Daex Brain` (`Daex Alpha Brain` for `ADE Alpha`), for the
// brain-executable switch in `apps/ade-cli/src/serviceManager/brainExecutable.ts`
// (mode `brain-copy`). macOS names the background item after this file
// ("Background Items Added", Login Items).
//
// Builds before the rename called it `<CFBundleExecutable> Brain` (`ADE Brain`),
// and a launch agent they installed still names that path until the new app
// or CLI installs the service again (it rewrites the plist whenever its text
// differs). The bundle also carries a copy under the old name, so such an agent
// still starts after an update that replaced the bundle without reinstalling
// the service (a Homebrew upgrade or a drag-and-drop install, then a restart).
// Remove the legacy copy once no supported build writes `ADE Brain`
// (docs/brand/desktop-packaging.md).
//
// The brain service, its watchdog and its PTY host run this copy as Node, so
// the process that is the app (`CFBundleExecutable`) is gone after a quit
// while the brain keeps running. The copy is signed with the app's own
// identity, signing identifier, team, hardened-runtime flag and entitlements,
// so its code satisfies the app's designated requirement.
//
// Two steps, because signing has to come after electron-builder's own pass:
// 1. `createBrainCopy` (afterPack): copy the executable when the mode is on.
// 2. `signBrainCopyIfPresent` (afterSign, before notarization; and after the
//    local channel build's own `codesign --deep`): re-sign the copy with the
//    app's identifier, then re-seal the app with its own metadata kept, so the
//    seal records the copy's new signature. Both do nothing without a copy,
//    so a build with the mode off is unchanged. Step 2 also does nothing on
//    an ad-hoc app that is not sealed yet (an afterSign with no signing).
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MODE_FILE = path.resolve(__dirname, "..", "..", "ade-cli", "src", "serviceManager", "brainExecutableMode.json");
// Keep in step with brainCopyFileName / legacyBrainCopyFileName in brainExecutable.ts.
const BRAIN_COPY_SUFFIX = " Brain";
const FROZEN_EXECUTABLE_PREFIX = "ADE";
const BRAIN_COPY_PREFIX = "Daex";
// Restricted entitlements need a provisioning profile, which authorizes the
// app's main executable only. The brain uses none of them.
const RESTRICTED_ENTITLEMENT_KEYS = [
  "keychain-access-groups",
  "com.apple.application-identifier",
  "com.apple.developer.team-identifier",
  "com.apple.developer.associated-domains",
  "com.apple.developer.web-browser.public-key-credential",
];

function readBrainExecutableMode() {
  try {
    const mode = String(JSON.parse(fs.readFileSync(MODE_FILE, "utf8")).mode || "").trim().toLowerCase();
    return mode === "helper" || mode === "brain-copy" ? mode : "off";
  } catch {
    return "off";
  }
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const output = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`[brain-copy] ${command} ${args.join(" ")} failed (exit ${result.status}).${output ? `\n${output}` : ""}`);
  }
  return result;
}

function bundleExecutableName(appPath) {
  const result = run("/usr/bin/plutil", [
    "-extract", "CFBundleExecutable", "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist"),
  ]);
  const name = result.stdout.trim();
  if (!name) throw new Error(`[brain-copy] ${appPath} has no CFBundleExecutable.`);
  return name;
}

/** `ADE` -> `Daex Brain`; another executable name -> `<name> Brain`. */
function brainCopyFileName(executableName) {
  const branded = executableName === FROZEN_EXECUTABLE_PREFIX || executableName.startsWith(`${FROZEN_EXECUTABLE_PREFIX} `)
    ? `${BRAIN_COPY_PREFIX}${executableName.slice(FROZEN_EXECUTABLE_PREFIX.length)}`
    : executableName;
  return `${branded}${BRAIN_COPY_SUFFIX}`;
}

/** The copy's path and, when it differs, the path older builds used (`ADE Brain`). */
function brainCopyPaths(appPath) {
  const name = bundleExecutableName(appPath);
  const macosDir = path.join(appPath, "Contents", "MacOS");
  const names = [brainCopyFileName(name), `${name}${BRAIN_COPY_SUFFIX}`];
  return Array.from(new Set(names)).map((fileName) => path.join(macosDir, fileName));
}

function brainCopyPath(appPath) {
  return brainCopyPaths(appPath)[0];
}

/** afterPack: copy the app's executable when the mode is `brain-copy`. Returns the copy's path or null. */
function createBrainCopy(appPath, { mode = readBrainExecutableMode() } = {}) {
  if (mode !== "brain-copy") {
    // A reused output folder must not keep a copy from an earlier build.
    // Best effort: with the mode off nothing here may fail the build.
    try {
      for (const copy of brainCopyPaths(appPath)) fs.rmSync(copy, { force: true });
    } catch {
      // No readable Info.plist: there is no copy to remove either.
    }
    return null;
  }
  const name = bundleExecutableName(appPath);
  const source = path.join(appPath, "Contents", "MacOS", name);
  const targets = brainCopyPaths(appPath);
  for (const target of targets) {
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
    adHocSignIfUnsigned(target);
  }
  return targets[0];
}

/**
 * The x64 Electron executable has no signature at all (arm64 has the linker's
 * ad-hoc one), and `codesign` refuses to sign an app holding unsigned code
 * ("code object is not signed at all, In subcomponent: … Brain"). An ad-hoc
 * signature puts the x64 copy where the arm64 copy starts; afterSign then
 * signs it with the app's identity. A copy that is signed already is kept.
 */
function adHocSignIfUnsigned(file) {
  if (process.platform !== "darwin") return;
  const display = run("/usr/bin/codesign", ["-d", file], { allowFailure: true });
  if (display.status === 0 || !/not signed at all/.test(`${display.stderr || ""}${display.stdout || ""}`)) return;
  run("/usr/bin/codesign", ["--force", "--sign", "-", file]);
}

/** What the app's signature says, read from `codesign -dvvv`. */
function readAppSignature(appPath) {
  const result = run("/usr/bin/codesign", ["-dvvv", appPath]);
  const text = `${result.stderr || ""}${result.stdout || ""}`;
  const field = (key) => {
    const match = new RegExp(`^${key}=(.*)$`, "m").exec(text);
    return match ? match[1].trim() : null;
  };
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text)?.[1] ?? "";
  return {
    identifier: field("Identifier"),
    teamIdentifier: field("TeamIdentifier"),
    adhoc: /^Signature=adhoc$/m.test(text),
    hardenedRuntime: flags.split(",").includes("runtime"),
    // A secure timestamp prints `Timestamp=`; `--timestamp=none` prints `Signed Time=`.
    secureTimestamp: /^Timestamp=/m.test(text),
  };
}

/** The SHA-1 of the app's signing certificate: the identity that signed it, by hash. */
function signingIdentityHash(appPath, tempDir) {
  const prefix = path.join(tempDir, "cert");
  run("/usr/bin/codesign", ["-d", `--extract-certificates=${prefix}`, appPath]);
  const leaf = `${prefix}0`;
  if (!fs.existsSync(leaf)) throw new Error(`[brain-copy] No signing certificate in ${appPath}.`);
  return crypto.createHash("sha1").update(fs.readFileSync(leaf)).digest("hex").toUpperCase();
}

/** The app's entitlements minus the restricted ones, as a plist file, or null when it has none. */
function brainEntitlementsFile(appPath, tempDir) {
  const result = run("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", appPath], { allowFailure: true });
  const xml = (result.stdout || "").trim();
  if (result.status !== 0 || !xml.includes("<plist")) return null;
  const file = path.join(tempDir, "brain.entitlements.plist");
  fs.writeFileSync(file, xml.slice(xml.indexOf("<?xml") >= 0 ? xml.indexOf("<?xml") : xml.indexOf("<plist")));
  for (const key of RESTRICTED_ENTITLEMENT_KEYS) {
    run("/usr/bin/plutil", ["-remove", key, file], { allowFailure: true });
  }
  return file;
}

/**
 * afterSign (and after a local channel build's signing): give the copies (the
 * new name and the legacy one) the app's identifier and re-seal the app.
 * Nothing without a copy.
 */
function signBrainCopyIfPresent(appPath, { keychain = null, log = console.log } = {}) {
  if (process.platform !== "darwin") return false;
  const copies = brainCopyPaths(appPath).filter((copy) => fs.existsSync(copy));
  if (copies.length === 0) return false;
  // An unsigned x64 build has no signature at all (arm64 gets the linker's
  // ad-hoc one). Same case as an unsealed ad-hoc app below.
  const display = run("/usr/bin/codesign", ["-d", appPath], { allowFailure: true });
  if (display.status !== 0 && /not signed at all/.test(`${display.stderr || ""}${display.stdout || ""}`)) {
    log(`[brain-copy] ${path.basename(appPath)} is not signed yet; the copy is signed when the app is.`);
    return false;
  }
  const signature = readAppSignature(appPath);
  if (!signature.identifier) throw new Error(`[brain-copy] Cannot read the signing identifier of ${appPath}.`);
  // electron-builder 26 calls afterSign even when it signed nothing
  // (`mac.identity: null`, the local channel build): the app then carries only
  // the linker's ad-hoc signature and is not sealed, so no deep check can pass
  // yet, with or without a copy. The step that signs that app (package-channel)
  // calls this again afterwards. An app signed with a real identity must
  // already be sealed: a failure there is an error.
  const baseline = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { allowFailure: true });
  if (baseline.status !== 0) {
    const reason = `${baseline.stderr || ""}${baseline.stdout || ""}`.trim().split("\n").slice(0, 2).join(" ");
    if (!signature.adhoc) {
      throw new Error(`[brain-copy] ${appPath} is signed but does not verify before the brain copy is signed: ${reason}`);
    }
    log(`[brain-copy] ${path.basename(appPath)} is not sealed yet (${reason}); the copy is signed when the app is.`);
    return false;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-brain-copy-"));
  try {
    const identity = signature.adhoc ? "-" : signingIdentityHash(appPath, tempDir);
    const common = ["--force", "--sign", identity];
    if (keychain) common.push("--keychain", keychain);
    common.push(signature.secureTimestamp ? "--timestamp" : "--timestamp=none");

    const copyArgs = [...common, "--identifier", signature.identifier];
    if (signature.hardenedRuntime) copyArgs.push("--options", "runtime");
    const entitlements = brainEntitlementsFile(appPath, tempDir);
    if (entitlements) copyArgs.push("--entitlements", entitlements);
    for (const copy of copies) run("/usr/bin/codesign", [...copyArgs, copy]);

    // Re-seal the app so CodeResources holds the copy's new code hash. The
    // app keeps its own identifier, entitlements, requirements and flags.
    run("/usr/bin/codesign", [
      ...common,
      "--preserve-metadata=identifier,entitlements,requirements,flags,runtime",
      appPath,
    ]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

    for (const copy of copies) {
      const copySignature = readAppSignature(copy);
      if (copySignature.identifier !== signature.identifier || copySignature.teamIdentifier !== signature.teamIdentifier) {
        throw new Error(
          `[brain-copy] ${copy} is signed as ${copySignature.identifier} (${copySignature.teamIdentifier}), `
            + `not the app's ${signature.identifier} (${signature.teamIdentifier}).`,
        );
      }
    }
    if (!signature.adhoc) {
      // Real identities only: an ad-hoc requirement is the app's own code hash.
      const requirement = run("/usr/bin/codesign", ["-d", "-r-", appPath]);
      const designated = /designated => (.*)$/m.exec(`${requirement.stdout || ""}${requirement.stderr || ""}`)?.[1]?.trim();
      if (!designated) throw new Error(`[brain-copy] Cannot read the designated requirement of ${appPath}.`);
      for (const copy of copies) run("/usr/bin/codesign", ["--verify", "--strict", `--test-requirement==${designated}`, copy]);
    }
    log(
      `[brain-copy] Signed ${copies.map((copy) => path.basename(copy)).join(", ")} as ${signature.identifier}`
        + ` (${signature.adhoc ? "ad-hoc" : `team ${signature.teamIdentifier}`}`
        + `${signature.hardenedRuntime ? ", hardened runtime" : ""}) and re-sealed ${path.basename(appPath)}.`,
    );
    return true;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  BRAIN_COPY_SUFFIX,
  brainCopyPath,
  createBrainCopy,
  readBrainExecutableMode,
  signBrainCopyIfPresent,
};
