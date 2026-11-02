/**
 * Where an SSH key lives and what is in it: the key path a person typed or
 * ssh_config named, expanded the way they meant it on every OS, and the
 * private key read from it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RemoteRuntimeConnectError } from "../../../shared/types/remoteRuntime";
import { markExpected } from "../../../shared/expectedError";

function lookupEnvVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (typeof direct === "string") return direct;
  // Windows environment names are case-insensitive (`%UserProfile%`, `$env:userprofile`).
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && typeof value === "string") return value;
  }
  return undefined;
}

/** Variable names people paste without their `%…%` / `$` decoration ("USERPROFILE\.ssh\id_ed25519"). */
const BARE_HOME_VARIABLE_PREFIX = /^(USERPROFILE|HOME)(?=[\\/])/i;

/**
 * Expands a user-typed or ssh_config path the way the person meant it, on
 * every OS: `~`, `~/` and `~\`, `%VAR%` (cmd), `$env:VAR` (PowerShell),
 * `${VAR}` and `$VAR` (POSIX shells), and a bare leading `USERPROFILE\` or
 * `HOME/`. Unknown variables stay as typed so the error names them. A path
 * still relative after expansion resolves against the home directory, never
 * against ADE's own working directory (the install folder on Windows).
 */
export function expandUserPath(value: string, args: { homeDir?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const homeDir = args.homeDir ?? os.homedir();
  const env = args.env ?? process.env;
  // HOME and USERPROFILE mean the home directory ADE resolves for SSH, on any OS.
  const homeFor = (name: string): string | undefined => {
    const upper = name.toUpperCase();
    if (upper === "HOME" || upper === "USERPROFILE") return homeDir;
    return lookupEnvVar(env, name);
  };
  let expanded = value.trim();
  if (
    (expanded.startsWith("\"") && expanded.endsWith("\"") && expanded.length >= 2) ||
    (expanded.startsWith("'") && expanded.endsWith("'") && expanded.length >= 2)
  ) {
    expanded = expanded.slice(1, -1).trim();
  }
  expanded = expanded
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string) => homeFor(name) ?? match)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (match, name: string) => homeFor(name) ?? match)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => homeFor(name) ?? match)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => homeFor(name) ?? match);
  if (expanded === "~") return homeDir;
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    return path.join(homeDir, expanded.slice(2));
  }
  const bare = BARE_HOME_VARIABLE_PREFIX.exec(expanded);
  if (bare) {
    return path.join(homeDir, expanded.slice(bare[0].length + 1));
  }
  if (expanded && !path.isAbsolute(expanded) && !path.win32.isAbsolute(expanded)) {
    return path.join(homeDir, expanded);
  }
  return expanded;
}

const PUBLIC_KEY_PREFIX = /^\s*(ssh-(rsa|dss|ed25519)|ecdsa-sha2-|sk-(ssh-ed25519|ecdsa-sha2-)|---- BEGIN SSH2 PUBLIC KEY|-----BEGIN (RSA )?PUBLIC KEY-----)/;

export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * People often pick `id_ed25519.pub` in the key field. When the private key
 * sits next to it under the same name, that is the key they meant, and the
 * `ssh -i` fallback in remote bootstrap gets the same file.
 */
export function privateKeyForPublicKeyPath(identityFile: string): string {
  if (!/\.pub$/i.test(identityFile)) return identityFile;
  const sibling = identityFile.slice(0, -4);
  return isFile(sibling) ? sibling : identityFile;
}

/**
 * Reads the private key the connection authenticates with. A missing file,
 * a folder, or a public key (`.pub`, or text that starts like one) fails
 * with a message naming the resolved path and what to pick instead. The
 * caller has already swapped a `.pub` for the private key beside it
 * (`privateKeyForPublicKeyPath`), so a public key here has no such sibling.
 */
export function readSshPrivateKey(identityFile: string): Buffer {
  let content: Buffer | null = null;
  if (isFile(identityFile)) {
    try {
      content = fs.readFileSync(identityFile);
    } catch {
      content = null;
    }
  }
  if (content && !PUBLIC_KEY_PREFIX.test(content.subarray(0, 64).toString("utf8"))) return content;
  if (content) {
    const sibling = /\.pub$/i.test(identityFile) ? identityFile.slice(0, -4) : null;
    // The person's own choice in the key field: an answer, not an ADE bug.
    throw markExpected(new RemoteRuntimeConnectError({
      kind: "ssh_auth",
      message:
        `The SSH key file ${identityFile} is a public key. ` +
        `Choose the private key instead${sibling ? ` (usually ${sibling}, the same name without .pub)` : ""}.`,
    }), "user");
  }
  let detail = "";
  try {
    if (fs.statSync(identityFile).isDirectory()) detail = " It is a folder, not a key file.";
  } catch {
    // Missing is the common case and needs no detail.
  }
  throw markExpected(new RemoteRuntimeConnectError({
    kind: "ssh_auth",
    message:
      `ADE could not read the SSH key file ${identityFile}.${detail || " No file exists at that path."} ` +
      "Check the SSH key path for this machine, or leave it empty to use ssh-agent or your SSH config.",
  }), "user");
}
