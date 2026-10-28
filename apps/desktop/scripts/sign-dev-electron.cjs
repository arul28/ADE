#!/usr/bin/env node

/**
 * Gives the dev Electron in node_modules a stable code identity on macOS, so
 * the login Keychain stops asking for the password on every Electron upgrade.
 *
 * Electron ships ad-hoc signed. An ad-hoc app's identity is its cdhash, so the
 * Keychain trusts one exact binary: every Electron version (and every lane on a
 * new version) is a stranger to the "ade-desktop Safe Storage" item, and the
 * main process blocks at startup on a password prompt nobody may be there to
 * answer. Signed with a real certificate, the identity is the bundle id plus
 * the certificate, which survives upgrades: "Always Allow" once and it holds.
 *
 * The identity: `ADE_DEV_SIGN_IDENTITY`, else a certificate named `ADE Local`
 * (the one channel builds use), else the first `Apple Development:` identity.
 * Developer ID is never picked: it is slow locally and fails over SSH. With no
 * identity, or `ADE_DEV_SIGN=0`, this does nothing and Electron stays ad-hoc.
 * It never fails the launch: on any error it puts the ad-hoc signature back.
 */

const cp = require("node:child_process");
const path = require("node:path");

const LOCAL_IDENTITY = "ADE Local";
// A key prompt for codesign itself must never hang the launcher.
const SIGN_TIMEOUT_MS = 60_000;

function log(message) {
  process.stdout.write(`[ade] dev electron signing: ${message}\n`);
}

function run(args, timeout = 15_000) {
  return cp.spawnSync("codesign", args, { encoding: "utf8", timeout });
}

function appBundleOf(executable) {
  const marker = ".app/";
  const index = executable.indexOf(marker);
  return index === -1 ? null : executable.slice(0, index + marker.length - 1);
}

function codeSigningIdentities() {
  const result = cp.spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) return [];
  const identities = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]*)"\s*$/);
    if (match) identities.push({ hash: match[1], name: match[2] });
  }
  return identities;
}

/** The identity named by `ADE_DEV_SIGN_IDENTITY` (a name or a SHA-1 hash), or null. */
function explicitIdentity() {
  const fromEnv = (process.env.ADE_DEV_SIGN_IDENTITY || "").trim();
  if (!fromEnv) return null;
  const known = codeSigningIdentities().find(
    (identity) => identity.name === fromEnv || identity.hash.toLowerCase() === fromEnv.toLowerCase(),
  );
  return known ?? { hash: fromEnv, name: fromEnv };
}

function pickIdentity() {
  const identities = codeSigningIdentities();
  const local = identities.find((identity) => identity.name === LOCAL_IDENTITY);
  const development = identities.find((identity) => identity.name.startsWith("Apple Development:"));
  return local ?? development ?? null;
}

/** The identity the bundle is signed with now, or null for ad-hoc / unsigned. */
function currentSigner(bundle) {
  const verify = run(["--verify", "--deep", "--strict", bundle]);
  if (verify.status !== 0) return null;
  const info = run(["-dvvv", bundle]);
  const match = `${info.stdout}${info.stderr}`.match(/^Authority=(.+)$/m);
  return match ? match[1].trim() : null;
}

function main() {
  if (process.platform !== "darwin" || process.env.ADE_DEV_SIGN === "0" || process.env.CI) return;
  let executable;
  try {
    executable = require("electron");
  } catch {
    return;
  }
  const bundle = typeof executable === "string" ? appBundleOf(executable) : null;
  if (!bundle) return;

  // An explicit identity re-signs a bundle signed with another one; otherwise any real
  // signature is kept, so launches do not re-sign (and re-prompt) for nothing.
  const explicit = explicitIdentity();
  const signer = currentSigner(bundle);
  if (signer && (!explicit || signer === explicit.name)) return;

  const identity = explicit ?? pickIdentity();
  if (!identity) {
    log("no Apple Development or \"ADE Local\" certificate; Electron stays ad-hoc and macOS may ask for the Keychain password after an Electron upgrade");
    return;
  }

  const signed = run(["--force", "--deep", "--sign", identity.hash, bundle], SIGN_TIMEOUT_MS);
  const newSigner = signed.status === 0 ? currentSigner(bundle) : null;
  if (newSigner) {
    log(`signed ${path.basename(bundle)} as "${newSigner}"; allow the Keychain once and it stays allowed`);
    return;
  }
  const reason = signed.error?.code === "ETIMEDOUT" ? "codesign timed out" : (signed.stderr || "").trim() || "verify failed";
  log(`failed (${reason}); restoring the ad-hoc signature`);
  run(["--force", "--deep", "--sign", "-", bundle], SIGN_TIMEOUT_MS);
}

try {
  main();
} catch (error) {
  log(`skipped (${error instanceof Error ? error.message : String(error)})`);
}
