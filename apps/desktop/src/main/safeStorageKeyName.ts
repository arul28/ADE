import fs from "node:fs";
import path from "node:path";

/**
 * The name Electron gives this app's safeStorage key.
 *
 * Electron names the key after the app name, which is the packaged
 * package.json `name`: `ade-desktop` for every build. On macOS the key is the
 * Keychain item "ade-desktop Safe Storage" (account "ade-desktop Key"). On Linux
 * it is the secret service entry for application "ade-desktop". So a Stable and
 * an Alpha app on one machine share one key. A build with another signature is
 * asked for the other build's item, and a build that finds the item gone makes
 * a new key that the other build's files cannot be read with.
 *
 * Stable keeps `ade-desktop` exactly. A channel build gets `ade-desktop-<channel>`,
 * but only on its first launch, and only when it has nothing encrypted yet: a
 * key name cannot change under files sealed with the old key, because one
 * process holds one key and the old files would stay unreadable. A channel
 * install that has run before keeps the shared name — its project folders can
 * hold files sealed with the shared key that no check at launch can see. The
 * choice is written down once, beside the files it protects, so it never
 * changes for that install.
 *
 * Windows needs none of this: its key is sealed with DPAPI into the user-data
 * folder's `Local State`, and each channel already has its own folder.
 */
export const STABLE_SAFE_STORAGE_NAME = "ade-desktop";

const MARKER_FILE = "safe-storage-key.json";

type MarkerRecord = { version: 1; name: string };

export type SafeStorageKeyNameArgs = {
  channel: string | null;
  platform: NodeJS.Platform;
  /** This channel's Electron user-data folder. */
  userDataPath: string;
  /** This channel's ADE home (`~/.ade-alpha`). */
  adeHome: string;
};

/**
 * The name to give this process's safeStorage key, or null to leave Electron's
 * default (`ade-desktop`). Runs before the app is ready: Electron reads the name
 * when it sets up the key.
 */
export function resolveSafeStorageKeyName(args: SafeStorageKeyNameArgs): string | null {
  // Linux is left as it is for now: the app name there also names the window
  // class that the desktop entry matches. See the F20 notes.
  if (!args.channel || args.platform !== "darwin") return null;
  const channelName = `${STABLE_SAFE_STORAGE_NAME}-${args.channel}`;
  const allowed = new Set([STABLE_SAFE_STORAGE_NAME, channelName]);
  const markerPaths = [
    // The machine credential file is the more valuable of the two, so its
    // marker wins when both exist.
    path.join(args.adeHome, "secrets", MARKER_FILE),
    path.join(args.userDataPath, MARKER_FILE),
  ];

  const recorded = markerPaths.map((markerPath) => readMarker(markerPath, allowed));
  const known = recorded.find((name): name is string => name !== null);
  if (known) {
    // A marker lost with one folder is written again from the other one.
    markerPaths.forEach((markerPath, index) => {
      if (recorded[index] === null) writeMarker(markerPath, known);
    });
    return known;
  }

  const chosen = !isFirstLaunch(args) || hasFilesSealedWithSharedKey(args) ? STABLE_SAFE_STORAGE_NAME : channelName;
  if (chosen === STABLE_SAFE_STORAGE_NAME) {
    markerPaths.forEach((markerPath) => writeMarker(markerPath, chosen));
    return chosen;
  }
  // A new name is only safe once it is written down: unrecorded, the next
  // launch would find this launch's files and go back to the shared name,
  // which cannot read them. With no marker saved, keep the shared name, as
  // every earlier build did.
  const saved = markerPaths.map((markerPath) => writeMarker(markerPath, chosen));
  return saved.some(Boolean) ? chosen : STABLE_SAFE_STORAGE_NAME;
}

/**
 * Whether this channel has never run on this machine. Its ADE home is made by
 * the first launch, before any credential is written, so its absence is the
 * one signal available before the app is ready that nothing here was sealed
 * with the shared key yet.
 *
 * An install that has run before keeps the shared name, whatever files this
 * module can see: a project's own `.ade/secrets` is sealed with the same key,
 * and no project folder is known at launch. Only a first launch chooses a name
 * of its own.
 */
function isFirstLaunch(args: SafeStorageKeyNameArgs): boolean {
  return !fs.existsSync(args.adeHome);
}

/**
 * Whether this channel already keeps a file sealed with the shared key. Read
 * widely on purpose: a false "yes" only keeps the shared name, a false "no"
 * would lose the secrets.
 *
 * Every file that `safeStorage.encryptString` writes is listed here, not only
 * the credential store's: an install whose only sealed secret is an API key or
 * a Linear token is just as unreadable after a name change. A new store that
 * seals with the OS key adds its file to this list.
 */
function hasFilesSealedWithSharedKey(args: SafeStorageKeyNameArgs): boolean {
  const secretsDir = path.join(args.adeHome, "secrets");
  const userSecretsDir = path.join(args.userDataPath, "secrets");
  const musicDir = path.join(args.userDataPath, "music-player");
  const sealedFiles = [
    path.join(secretsDir, "credentials.safe.enc"),
    // `apiKeyStore` (`AdeLayout.apiKeysPath` and its provenance companion).
    path.join(secretsDir, "api-keys.v1.bin"),
    path.join(secretsDir, "api-keys.v1.bin.provenance"),
    // `linearCredentialService`.
    path.join(secretsDir, "linear-token.v1.bin"),
    path.join(secretsDir, "linear-oauth-client.v1.bin"),
    path.join(secretsDir, "linear-credential-provenance.v1.bin"),
    // `githubService`, and the music stores.
    path.join(userSecretsDir, "github", "github-token.v1.bin"),
    path.join(musicDir, "apple-music-user-token.enc"),
    path.join(musicDir, "spotify-session.enc"),
  ];
  if (sealedFiles.some((filePath) => fs.existsSync(filePath))) return true;
  // The shared file store (`credentials.json.enc`) is JSON and needs no key,
  // but an older build kept its safeStorage data under the same name.
  return isSafeStorageSealed(path.join(secretsDir, "credentials.json.enc"));
}

function isSafeStorageSealed(filePath: string): boolean {
  let head: Buffer;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      head = Buffer.alloc(64);
      head = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  const text = head.toString("latin1");
  // ADE's own header, or Chromium's `v10`/`v11` prefix with no header.
  return text.startsWith("ADE_SAFE_STORAGE_CREDENTIALS_V1") || /^v1\d/.test(text);
}

function readMarker(markerPath: string, allowed: Set<string>): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<MarkerRecord>;
    return typeof parsed.name === "string" && allowed.has(parsed.name) ? parsed.name : null;
  } catch {
    return null;
  }
}

function writeMarker(markerPath: string, name: string): boolean {
  const record: MarkerRecord = { version: 1, name };
  const temporary = `${markerPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, markerPath);
    return true;
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    return false;
  }
}
