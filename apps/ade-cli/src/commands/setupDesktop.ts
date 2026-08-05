/**
 * Desktop-app acquisition for `ade setup`.
 *
 * This used to live twice -- once in PowerShell, once in POSIX sh -- which is
 * how the Windows path lost the progress bar the macOS path had, and how the
 * Windows path ended up launching Electron with an inherited console. One
 * implementation, two small platform branches at the edges.
 *
 * The published SHA256SUMS covers only the standalone runtime assets, so the
 * desktop artifact is verified against the base64 SHA-512 in the
 * electron-updater manifest (`latest.yml` / `latest-mac.yml`) -- the same digest
 * the auto-updater checks.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_ADE_RELEASE_REPO,
  releaseAssetUrl,
} from "../lib/releaseAssets";
import { resolveDefaultDesktopAppName } from "./doctor";

export { DEFAULT_ADE_RELEASE_REPO };

export type DesktopManifestEntry = {
  /** Asset file name as named by the manifest. */
  name: string;
  /** Base64 SHA-512, as electron-updater writes it. */
  sha512: string;
};

export type DownloadProgress = {
  receivedBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number | null;
};

export function manifestNameForPlatform(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "latest-mac.yml" : "latest.yml";
}

/**
 * Thin argument-order adapter over the canonical `releaseAssetUrl`. The release
 * feed's latest-vs-tag rule lives in `lib/releaseAssets.ts` and is shared with
 * `ade brain update` and the remote-runtime bootstrap; this keeps setup on that
 * one implementation instead of a fourth copy of the same URL shape.
 *
 * Note the downloader below is deliberately *not* `downloadReleaseAsset` from
 * that module: this path needs byte progress and Range-resume for a 1 GB
 * artifact, which that helper does not provide.
 */
export function assetUrl(
  name: string,
  repo = DEFAULT_ADE_RELEASE_REPO,
  version = "latest",
): string {
  return releaseAssetUrl(repo, version, name);
}

/**
 * electron-updater manifests are a `files:` list of `- url:` / `sha512:` pairs
 * followed by a top-level `path:`/`sha512:` repeat. We take the first entry
 * whose url matches the artifact this platform installs, which is the same one
 * the shell implementations picked.
 */
export function parseDesktopManifest(
  yaml: string,
  platform: NodeJS.Platform,
  arch: string = process.arch,
): DesktopManifestEntry | null {
  const matches = platform === "darwin"
    ? (url: string) => url.endsWith(`-${arch === "arm64" ? "arm64" : "x64"}.zip`)
    : (url: string) => url.toLowerCase().endsWith(".exe");

  let pendingUrl: string | null = null;
  for (const rawLine of yaml.split(/\r?\n/)) {
    const urlMatch = /^\s*-\s+url:\s*(\S+)\s*$/.exec(rawLine);
    if (urlMatch?.[1]) {
      pendingUrl = urlMatch[1];
      continue;
    }
    const shaMatch = /^\s*sha512:\s*(\S+)\s*$/.exec(rawLine);
    if (shaMatch?.[1]) {
      if (pendingUrl && matches(pendingUrl)) {
        return { name: pendingUrl, sha512: shaMatch[1] };
      }
      pendingUrl = null;
    }
  }
  return null;
}

/**
 * Streamed, not buffered: the file this hashes is the ~1 GB desktop installer,
 * and a single allocation that size is an out-of-memory kill mid-install on a
 * small VM or container -- one that grows with every release. The shell code
 * this replaced streamed it too (`[IO.File]::OpenRead` -> `ComputeHash`).
 */
export async function sha512Base64(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  // Fed by hand rather than piped into `hash` as a stream: ending its writable
  // side finalizes the digest internally, and `hash.digest()` would then throw.
  await pipeline(fs.createReadStream(filePath), async (source) => {
    for await (const chunk of source) hash.update(chunk as Uint8Array);
  });
  return hash.digest("base64");
}

const RETRYABLE_ATTEMPTS = 3;

/**
 * How long the transfer may go completely silent before we call it dead.
 *
 * Deliberately an idle deadline and not a total one: a 1 GB artifact on a slow
 * line legitimately takes an hour, and killing that mid-flight would be a worse
 * bug than the hang it fixes.
 */
const IDLE_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resumable, retrying download.
 *
 * A dropped connection 800 MB into a 1 GB file re-requests only the remainder
 * via a Range header rather than starting over. A server that ignores the range
 * (answers 200 instead of 206) is handled by truncating and restarting, because
 * appending a full body onto a partial file would silently corrupt it.
 */
export async function downloadWithResume(
  url: string,
  destination: string,
  onProgress: (progress: DownloadProgress) => void,
  deps: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** Test seam for the idle deadline; see IDLE_TIMEOUT_MS. */
    idleTimeoutMs?: number;
  } = {},
): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < RETRYABLE_ATTEMPTS; attempt += 1) {
    const resumeFrom = fs.existsSync(destination)
      ? fs.statSync(destination).size
      : 0;
    const headers: Record<string, string> = {};
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

    // A socket that is accepted and then goes quiet never rejects on its own,
    // so without this the step line freezes forever and the retry loop below
    // never gets a turn -- the same hang class as a read on a dead stdin.
    const attemptAbort = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => attemptAbort.abort(), idleTimeoutMs);
    };
    const onCallerAbort = () => attemptAbort.abort();
    deps.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (deps.signal?.aborted) attemptAbort.abort();
    armIdleTimer();

    try {
      const response = await fetchImpl(url, {
        headers,
        signal: attemptAbort.signal,
      });
      // A file that is already whole answers a `bytes=<size>-` range with 416,
      // not 206. Report it rather than burning three attempts on it: the
      // caller's SHA-512 check, not the byte count, decides whether it is good.
      if (response.status === 416 && resumeFrom > 0) {
        onProgress({
          receivedBytes: resumeFrom,
          totalBytes: resumeFrom,
          bytesPerSecond: null,
        });
        return resumeFrom;
      }
      if (!response.ok) {
        throw new Error(`download failed with HTTP ${response.status}`);
      }
      // 206 continues the file; 200 means the server sent the whole thing again.
      const appending = resumeFrom > 0 && response.status === 206;
      if (resumeFrom > 0 && !appending) fs.rmSync(destination, { force: true });

      const contentLength = Number(response.headers.get("content-length"));
      const alreadyHave = appending ? resumeFrom : 0;
      const totalBytes = Number.isFinite(contentLength) && contentLength > 0
        ? contentLength + alreadyHave
        : null;

      if (!response.body) throw new Error("download response had no body");

      const handle = fs.openSync(destination, appending ? "a" : "w");
      let received = alreadyHave;
      const startedAt = Date.now();
      let lastReport = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          fs.writeSync(handle, chunk);
          received += chunk.byteLength;
          armIdleTimer();
          // Throttle: a 1 GB download emits tens of thousands of chunks and the
          // renderer would spend more time drawing than the socket does reading.
          const now = Date.now();
          if (now - lastReport < 100) continue;
          lastReport = now;
          const elapsedSeconds = (now - startedAt) / 1000;
          onProgress({
            receivedBytes: received,
            totalBytes,
            bytesPerSecond: elapsedSeconds > 0
              ? (received - alreadyHave) / elapsedSeconds
              : null,
          });
        }
      } finally {
        fs.closeSync(handle);
      }
      onProgress({ receivedBytes: received, totalBytes, bytesPerSecond: null });
      return received;
    } catch (error) {
      lastError = error;
      // Only the caller's own abort is terminal. The idle deadline aborts the
      // same way, but it means "this connection died", which is exactly what
      // the retry loop exists for -- and the partial file makes it cheap.
      if (deps.signal?.aborted) throw error;
      if (attempt < RETRYABLE_ATTEMPTS - 1) {
        await sleep(500 * 2 ** attempt);
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      deps.signal?.removeEventListener("abort", onCallerAbort);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type DesktopInstallResult = {
  appPath: string | null;
  /** Human detail for the step line. */
  detail: string;
};

/**
 * Where the installed app lives, for the "already installed" short-circuit.
 *
 * The name is channel-dependent (`ADE Beta.exe` under `Programs\ADE Beta\`), so
 * it comes from the one helper that already resolves it -- hardcoding `ADE` here
 * made the post-install launch a silent no-op on every non-stable channel.
 */
export function defaultDesktopAppPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const name = resolveDefaultDesktopAppName(env);
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return local ? path.join(local, "Programs", name, `${name}.exe`) : null;
  }
  if (platform === "darwin") return `/Applications/${name}.app`;
  return null;
}

/**
 * Windows: the NSIS installer is built oneClick:false + perMachine:false +
 * allowElevation:false, so `/S` is a silent per-user install with no UAC prompt.
 * macOS: expand the zip and promote the bundle named for this channel (Stable,
 * Beta and Alpha ship different app names), moving any existing copy aside
 * first so a failed promotion leaves the user's working app in place.
 */
export async function installDesktopArtifact(
  artifactPath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DesktopInstallResult> {
  if (platform === "win32") {
    // windowsHide: omitting it is the class behind the host-loss incident in
    // WINDOWS_PORT.md -- console windows piling up and outliving their parent.
    const result = spawnSync(artifactPath, ["/S"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`the desktop installer exited with code ${result.status}`);
    }
    const appPath = defaultDesktopAppPath("win32", env);
    return {
      appPath: appPath && fs.existsSync(appPath) ? appPath : null,
      detail: "installed",
    };
  }

  if (platform === "darwin") {
    const bundleName = `${resolveDefaultDesktopAppName(env)}.app`;
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-"));
    const extract = spawnSync("ditto", ["-x", "-k", artifactPath, stage], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (extract.status !== 0) {
      throw new Error("could not expand the desktop app archive");
    }
    const staged = path.join(stage, bundleName);
    if (!fs.existsSync(staged)) {
      throw new Error(`desktop app archive did not contain ${bundleName}`);
    }
    const appsDir = canWrite("/Applications")
      ? "/Applications"
      : path.join(os.homedir(), "Applications");
    fs.mkdirSync(appsDir, { recursive: true });
    const target = path.join(appsDir, bundleName);
    const backup = `${target}.previous`;
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    try {
      movePath(staged, target);
    } catch (error) {
      // A cross-device copy that died halfway leaves a partial bundle the
      // backup cannot be renamed back over, so clear the way first -- but never
      // let clearing it abort the restore. The user's working app has already
      // been renamed to `.previous` by this point, so a throw here would leave
      // them with no app at all, which is worse than every failure it replaces.
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {}
      if (fs.existsSync(backup)) fs.renameSync(backup, target);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
    return { appPath: target, detail: "installed" };
  }

  return { appPath: null, detail: "not available on this platform" };
}

/**
 * `mv`, including across volumes.
 *
 * The staged bundle is under `os.tmpdir()` and the target is `/Applications`, so
 * a `TMPDIR` on another volume makes `rename` fail with EXDEV. The shell code
 * this replaced used `mv`, which falls back to a copy; without that fallback the
 * install fails safe but fails where it used to work.
 */
function movePath(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // verbatimSymlinks: an .app bundle's Frameworks are relative symlinks, and
    // dereferencing them would both bloat the copy and break the signature.
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    // The copy succeeded, so the move is done. Failing to tidy the staging tree
    // (a file still held open under TMPDIR) must not throw: the caller's catch
    // would read that as a failed install and roll a good app back.
    try {
      fs.rmSync(from, { recursive: true, force: true });
    } catch {}
  }
}

function canWrite(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Launch the app without handing it our console.
 *
 * On Windows a GUI child inherits the parent's console handles, so Electron's
 * main-process logging lands in the user's shell and the prompt never comes
 * back clean. `detached` + `stdio: "ignore"` + `unref()` is what makes it behave
 * like a double-click. macOS delegates to LaunchServices, which already detaches.
 */
export function launchDesktopApp(
  appPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const child = platform === "darwin"
    ? spawn("open", [appPath], { detached: true, stdio: "ignore" })
    : spawn(appPath, [], {
      detached: true,
      stdio: "ignore",
      // Hides a stray *console* window, not the app's own GUI window -- an
      // Electron app never creates the former, so this is free insurance and
      // keeps every spawn in the repo consistent with the windowsHide rule.
      windowsHide: true,
    });
  child.once("error", () => {});
  child.unref();
}
