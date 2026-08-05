import { execFile } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "./errors";
import { type ToolDownloader, fileIntegrity } from "./download";
import { ensureTools, gcTools, resolveTool, tryResolveTool, type ToolsContext } from "./install";
import { type ToolsManifest, parseToolsManifest } from "./manifest";
import { TOOL_INSTALL_SENTINEL, toolSentinelPath, toolVersionDir } from "./paths";
import { acquireToolLock, isToolLockContention } from "./lock";

const execFileAsync = promisify(execFile);

let tmpRoot: string;
let toolsRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-tools-"));
  toolsRoot = path.join(tmpRoot, "tools");
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Build a real npm-shaped tarball (`package/` root) with the system tar, so the
 * extraction path — including `--strip-components 1` — is exercised for real.
 * Only the network is stubbed anywhere in this file.
 */
async function buildTarball(files: Record<string, string>): Promise<{ path: string; integrity: string }> {
  const sourceRoot = await fsp.mkdtemp(path.join(tmpRoot, "src-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(sourceRoot, "package", ...relativePath.split("/"));
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, contents, "utf8");
  }
  const archivePath = path.join(sourceRoot, "package.tgz");
  await execFileAsync("tar", ["-czf", archivePath, "-C", sourceRoot, "package"]);
  return { path: archivePath, integrity: await fileIntegrity(archivePath) };
}

function manifestFor(options: {
  entryPath: string;
  integrity: string;
  packageName?: string;
  version?: string;
}): ToolsManifest {
  return parseToolsManifest({
    schemaVersion: 1,
    generatedFrom: "test",
    tools: [
      {
        name: "demo",
        description: "Demo tool.",
        entry: { kind: "binary", path: options.entryPath },
        targets: {
          "darwin-arm64": {
            package: options.packageName ?? "demo-tool-darwin-arm64",
            version: options.version ?? "1.2.3",
            tarball: "https://registry.npmjs.org/demo-tool-darwin-arm64/-/demo-1.2.3.tgz",
            integrity: options.integrity,
          },
        },
      },
    ],
  });
}

type Recorder = { calls: number };

function stubDownloader(
  archivePath: string,
  integrity: string,
  recorder: Recorder,
  delayMs = 0,
): ToolDownloader {
  return async (_url, destPath, downloadOptions) => {
    recorder.calls += 1;
    const bytes = (await fsp.stat(archivePath)).size;
    await downloadOptions?.onSize?.(bytes);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.copyFile(archivePath, destPath);
    downloadOptions?.onProgress?.({ receivedBytes: bytes, totalBytes: bytes });
    return { bytes, integrity };
  };
}

function baseContext(manifest: ToolsManifest): ToolsContext {
  return {
    manifest,
    toolsRoot,
    platform: "darwin",
    arch: "arm64",
    target: "darwin-arm64",
    lock: { pollIntervalMs: 5, timeoutMs: 5_000, staleMs: 2_000 },
  };
}

async function listStagingEntries(): Promise<string[]> {
  try {
    return await fsp.readdir(path.join(toolsRoot, ".staging"));
  } catch {
    return [];
  }
}

describe("ensureTools", () => {
  it("downloads, verifies, unpacks, and publishes a tool atomically", async () => {
    const archive = await buildTarball({ "bin/demo": "#!/bin/sh\necho demo\n", "package.json": "{}" });
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: archive.integrity });
    const recorder: Recorder = { calls: 0 };
    const phases: string[] = [];

    const resolved = await ensureTools(["demo"], {
      ...baseContext(manifest),
      download: stubDownloader(archive.path, archive.integrity, recorder),
      onProgress: (progress) => phases.push(progress.phase),
    });

    const demo = resolved.get("demo")!;
    expect(demo.dir).toBe(toolVersionDir(toolsRoot, "demo-tool-darwin-arm64", "1.2.3"));
    expect(demo.entryPath).toBe(path.join(demo.dir, "bin", "demo"));
    expect(fs.readFileSync(demo.entryPath, "utf8")).toContain("echo demo");
    // --strip-components 1 removed npm's package/ root.
    expect(fs.existsSync(path.join(demo.dir, "package"))).toBe(false);
    expect(fs.existsSync(path.join(demo.dir, TOOL_INSTALL_SENTINEL))).toBe(true);
    expect(phases).toContain("downloading");
    expect(phases.at(-1)).toBe("installed");
    // The archive must not survive inside the published directory.
    expect(fs.existsSync(path.join(demo.dir, "package.tgz"))).toBe(false);
    expect(await listStagingEntries()).toEqual([]);

    // A second call is a pure cache hit: no download, no lock file left behind.
    const again = await ensureTools(["demo"], {
      ...baseContext(manifest),
      download: stubDownloader(archive.path, archive.integrity, recorder),
    });
    expect(recorder.calls).toBe(1);
    expect(again.get("demo")!.entryPath).toBe(demo.entryPath);
  });

  it("expands a globbed entry path, as codex's vendor triple requires", async () => {
    const archive = await buildTarball({ "vendor/aarch64-apple-darwin/bin/codex": "binary" });
    const manifest = manifestFor({ entryPath: "vendor/*/bin/codex", integrity: archive.integrity });
    const recorder: Recorder = { calls: 0 };

    const resolved = await ensureTools(["demo"], {
      ...baseContext(manifest),
      download: stubDownloader(archive.path, archive.integrity, recorder),
    });

    expect(resolved.get("demo")!.entryPath)
      .toBe(path.join(toolsRoot, "demo-tool-darwin-arm64", "1.2.3", "vendor", "aarch64-apple-darwin", "bin", "codex"));
  });

  it("rejects a tarball whose hash does not match the pin and leaves nothing staged", async () => {
    const archive = await buildTarball({ "bin/demo": "real" });
    const tampered = await buildTarball({ "bin/demo": "malicious" });
    // Manifest pins the real archive; the transport serves the tampered one.
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: archive.integrity });
    const recorder: Recorder = { calls: 0 };

    let thrown: unknown;
    try {
      await ensureTools(["demo"], {
        ...baseContext(manifest),
        download: stubDownloader(tampered.path, tampered.integrity, recorder),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).kind).toBe("integrity");
    expect(await listStagingEntries()).toEqual([]);
    expect(fs.existsSync(toolVersionDir(toolsRoot, "demo-tool-darwin-arm64", "1.2.3"))).toBe(false);
    // The lock must be released even on the failure path.
    expect(fs.existsSync(path.join(toolsRoot, ".locks"))).toBe(true);
    expect(await fsp.readdir(path.join(toolsRoot, ".locks"))).toEqual([]);
  });

  it("refuses to download when the volume cannot hold the unpacked tool", async () => {
    const archive = await buildTarball({ "bin/demo": "real" });
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: archive.integrity });
    const recorder: Recorder = { calls: 0 };

    let thrown: unknown;
    try {
      await ensureTools(["demo"], {
        ...baseContext(manifest),
        download: stubDownloader(archive.path, archive.integrity, recorder),
        freeBytes: () => 1024,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).kind).toBe("disk-space");
    expect((thrown as ToolError).availableBytes).toBe(1024);
    expect((thrown as ToolError).requiredBytes).toBeGreaterThan(1024);
    expect(await listStagingEntries()).toEqual([]);
  });

  it("re-fetches a directory whose sentinel is present but whose entry is gone", async () => {
    const archive = await buildTarball({ "bin/demo": "real" });
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: archive.integrity });
    const recorder: Recorder = { calls: 0 };
    const context = baseContext(manifest);

    await ensureTools(["demo"], { ...context, download: stubDownloader(archive.path, archive.integrity, recorder) });
    const dir = toolVersionDir(toolsRoot, "demo-tool-darwin-arm64", "1.2.3");
    // Simulate a truncated extraction that somehow kept its sentinel.
    await fsp.rm(path.join(dir, "bin"), { recursive: true, force: true });
    expect(tryResolveTool("demo", context)).toBeNull();

    await ensureTools(["demo"], { ...context, download: stubDownloader(archive.path, archive.integrity, recorder) });
    expect(recorder.calls).toBe(2);
    expect(fs.existsSync(path.join(dir, "bin", "demo"))).toBe(true);
  });

  it("single-flights concurrent installs across processes sharing the cache", async () => {
    const archive = await buildTarball({ "bin/demo": "real" });
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: archive.integrity });
    const recorder: Recorder = { calls: 0 };
    const download = stubDownloader(archive.path, archive.integrity, recorder, 150);
    const waitedBy: string[] = [];

    const [first, second] = await Promise.all([
      ensureTools(["demo"], {
        ...baseContext(manifest),
        download,
        onProgress: (progress) => {
          if (progress.phase === "waiting") waitedBy.push("a");
        },
      }),
      ensureTools(["demo"], {
        ...baseContext(manifest),
        download,
        onProgress: (progress) => {
          if (progress.phase === "waiting") waitedBy.push("b");
        },
      }),
    ]);

    // The lock is what makes this true: without it both racers would unpack
    // into the same destination directory.
    expect(recorder.calls).toBe(1);
    expect(waitedBy.length).toBeGreaterThan(0);
    expect(first.get("demo")!.entryPath).toBe(second.get("demo")!.entryPath);
    expect(await fsp.readdir(path.join(toolsRoot, ".locks"))).toEqual([]);
    expect(await listStagingEntries()).toEqual([]);
  });
});

describe("resolveTool", () => {
  it("reports a typed, actionable failure when the tool was never fetched", () => {
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: `sha512-${"A".repeat(86)}==` });
    let thrown: unknown;
    try {
      resolveTool("demo", baseContext(manifest));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).kind).toBe("not-installed");
    expect((thrown as ToolError).packageName).toBe("demo-tool-darwin-arm64");
  });

  it("ignores a version directory that has no sentinel", async () => {
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: `sha512-${"A".repeat(86)}==` });
    const dir = toolVersionDir(toolsRoot, "demo-tool-darwin-arm64", "1.2.3");
    await fsp.mkdir(path.join(dir, "bin"), { recursive: true });
    await fsp.writeFile(path.join(dir, "bin", "demo"), "half-written", "utf8");

    expect(tryResolveTool("demo", baseContext(manifest))).toBeNull();
  });

  it("surfaces an unsupported target rather than pretending it is missing", () => {
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: `sha512-${"A".repeat(86)}==` });
    let thrown: unknown;
    try {
      resolveTool("demo", { ...baseContext(manifest), target: "win32-x64" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).kind).toBe("unsupported-target");
  });
});

describe("gcTools", () => {
  async function seedVersion(version: string, mtimeMs: number): Promise<string> {
    const dir = toolVersionDir(toolsRoot, "demo-tool-darwin-arm64", version);
    await fsp.mkdir(path.join(dir, "bin"), { recursive: true });
    await fsp.writeFile(path.join(dir, "bin", "demo"), version, "utf8");
    await fsp.writeFile(path.join(dir, TOOL_INSTALL_SENTINEL), "{}", "utf8");
    const stamp = new Date(mtimeMs);
    await fsp.utimes(dir, stamp, stamp);
    return dir;
  }

  it("keeps the pinned version and one predecessor, dropping older ones", async () => {
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: `sha512-${"A".repeat(86)}==` });
    const pinned = await seedVersion("1.2.3", Date.now());
    const previous = await seedVersion("1.2.2", Date.now() - 60_000);
    const ancient = await seedVersion("1.0.0", Date.now() - 600_000);

    const result = await gcTools(baseContext(manifest));

    expect(result.removed).toContain(ancient);
    expect(result.kept).toEqual(expect.arrayContaining([pinned, previous]));
    expect(fs.existsSync(pinned)).toBe(true);
    expect(fs.existsSync(previous)).toBe(true);
    expect(fs.existsSync(ancient)).toBe(false);
  });

  it("drops every superseded version when keepPrevious is off", async () => {
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: `sha512-${"A".repeat(86)}==` });
    const pinned = await seedVersion("1.2.3", Date.now());
    const previous = await seedVersion("1.2.2", Date.now() - 60_000);

    const result = await gcTools({ ...baseContext(manifest), keepPrevious: false });

    expect(result.removed).toContain(previous);
    expect(fs.existsSync(previous)).toBe(false);
    expect(fs.existsSync(pinned)).toBe(true);
  });

  it("leaves packages the manifest has never heard of alone", async () => {
    const manifest = manifestFor({ entryPath: "bin/demo", integrity: `sha512-${"A".repeat(86)}==` });
    const foreign = toolVersionDir(toolsRoot, "some-other-channel-tool", "9.9.9");
    await fsp.mkdir(foreign, { recursive: true });

    const result = await gcTools(baseContext(manifest));

    expect(result.removed).not.toContain(foreign);
    expect(fs.existsSync(foreign)).toBe(true);
  });
});

// Folded from installSatisfiedRetry.test.ts (single-consumer concern).
const PACKAGE_NAME = "demo-tool-darwin-arm64";
const VERSION = "1.2.3";

let retryTmpRoot = "";
let retryToolsRoot = "";

beforeEach(async () => {
  retryTmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-tools-flap-"));
  retryToolsRoot = path.join(retryTmpRoot, "tools");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(retryTmpRoot, { recursive: true, force: true });
});

function retryManifest(): ToolsManifest {
  return parseToolsManifest({
    schemaVersion: 1,
    generatedFrom: "test",
    tools: [
      {
        name: "demo",
        description: "Demo tool.",
        entry: { kind: "binary", path: "bin/demo" },
        targets: {
          "darwin-arm64": {
            package: PACKAGE_NAME,
            version: VERSION,
            tarball: `https://registry.npmjs.org/${PACKAGE_NAME}/-/demo-${VERSION}.tgz`,
            integrity: "sha512-deadbeef",
          },
        },
      },
    ],
  });
}

function retryContext(): ToolsContext {
  return {
    manifest: retryManifest(),
    toolsRoot: retryToolsRoot,
    platform: "darwin",
    arch: "arm64",
    target: "darwin-arm64",
    lock: { pollIntervalMs: 1, timeoutMs: 2_000, staleMs: 1_000 },
  };
}

describe("ensureTools with a flapping install sentinel", () => {
  it("gives up with a typed error instead of recursing forever", async () => {
    // The lock reports `satisfied` (its poll saw a complete install) but the
    // read-back immediately after finds nothing. Before the bound, that path
    // called ensureOneTool again with no depth limit, so a sentinel that keeps
    // flipping pinned a core with no diagnosis and no download ever starting.
    const versionDir = toolVersionDir(retryToolsRoot, PACKAGE_NAME, VERSION);
    const sentinelPath = toolSentinelPath(versionDir);
    // The declared entry is real, so only the sentinel decides installedness.
    await fsp.mkdir(path.join(versionDir, "bin"), { recursive: true });
    await fsp.writeFile(path.join(versionDir, "bin", "demo"), "#!/bin/sh\n", "utf8");

    // Per attempt the sentinel is probed three times: the pre-lock cache check
    // (absent), the lock's isSatisfied poll (present), and the post-`satisfied`
    // read-back (absent again). That middle `true` is the flap.
    let probes = 0;
    const realExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((target) => {
      if (target !== sentinelPath) return realExistsSync(target);
      const present = probes % 3 === 1;
      probes += 1;
      return present;
    });

    const download = vi.fn(async () => {
      throw new Error("a flapping sentinel must never reach the network");
    });

    await expect(
      ensureTools(["demo"], { ...retryContext(), download: download as never }),
    ).rejects.toMatchObject({
      name: "ToolError",
      kind: "filesystem",
      tool: "demo",
      packageName: PACKAGE_NAME,
      version: VERSION,
    });

    await expect(
      ensureTools(["demo"], { ...retryContext(), download: download as never }),
    ).rejects.toThrow(new RegExp(`demo.*${TOOL_INSTALL_SENTINEL.replace(".", "\\.")}`, "s"));

    expect(download).not.toHaveBeenCalled();
    // Three attempts per call, three sentinel probes each, across two calls.
    expect(probes).toBe(18);
  });
});

// Folded from lock.test.ts: lock.ts is consumed only by install.ts.
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

let root = "";

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-tool-lock-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", realPlatform);
  await fsp.rm(root, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function lockRecord(overrides: Partial<{ pid: number; host: string }> = {}): string {
  return JSON.stringify({
    pid: overrides.pid ?? process.pid,
    host: overrides.host ?? os.hostname(),
    startedAt: new Date().toISOString(),
  });
}

describe("isToolLockContention", () => {
  it("treats EEXIST as contention on every platform", () => {
    expect(isToolLockContention(errno("EEXIST"))).toBe(true);
  });

  it("treats the Windows delete-pending codes as contention only on win32", () => {
    setPlatform("win32");
    expect(isToolLockContention(errno("EPERM"))).toBe(true);
    expect(isToolLockContention(errno("EACCES"))).toBe(true);
    expect(isToolLockContention(errno("EBUSY"))).toBe(true);

    setPlatform("linux");
    expect(isToolLockContention(errno("EPERM"))).toBe(false);
    expect(isToolLockContention(errno("EACCES"))).toBe(false);
    expect(isToolLockContention(errno("EBUSY"))).toBe(false);
  });

  it("never treats an unrelated failure as contention", () => {
    setPlatform("win32");
    expect(isToolLockContention(errno("ENOSPC"))).toBe(false);
    expect(isToolLockContention(new Error("boom"))).toBe(false);
    expect(isToolLockContention(null)).toBe(false);
  });
});

describe("acquireToolLock", () => {
  it("keeps waiting when Windows reports a delete-pending lock as EPERM/EACCES/EBUSY", async () => {
    // The regression: `open(path, "wx")` against a lock another process is
    // mid-unlink of fails with EPERM/EACCES/EBUSY on Windows, not EEXIST.
    // Rethrowing those turned a benign race into a hard install failure.
    setPlatform("win32");
    const lockPath = path.join(root, "locks", "codex.lock");
    // A live, non-stale holder's record, so the stale-takeover branch does not
    // short-circuit the wait this asserts on.
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    await fsp.writeFile(lockPath, lockRecord());

    const codes = ["EPERM", "EACCES", "EBUSY"];
    let attempts = 0;
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      attempts += 1;
      const code = codes[attempts - 1];
      if (code) throw errno(code);
      // The "holder" finally finished: its name is gone and we win the create.
      await fsp.rm(lockPath, { force: true });
      return realOpen(...args);
    });

    const sleep = vi.fn(async () => undefined);
    const acquisition = await acquireToolLock({ lockPath, sleep, pollIntervalMs: 1 });

    expect(acquisition.kind).toBe("acquired");
    expect(attempts).toBe(codes.length + 1);
    expect(sleep).toHaveBeenCalledTimes(codes.length);
  });

  it("still rethrows a genuine filesystem failure as a typed ToolError", async () => {
    const lockPath = path.join(root, "locks", "codex.lock");
    vi.spyOn(fsp, "open").mockRejectedValue(errno("ENOSPC"));

    await expect(
      acquireToolLock({ lockPath, sleep: async () => undefined }),
    ).rejects.toMatchObject({ name: "ToolError", kind: "filesystem" });
  });

  it("release() leaves a lock alone once another process has reclaimed it", async () => {
    // Our lock went stale, a second process took it over and wrote its own
    // record. A late unconditional rm here would release *their* lock and let
    // two installs race the same cache directory.
    const lockPath = path.join(root, "locks", "codex.lock");
    const acquisition = await acquireToolLock({ lockPath, sleep: async () => undefined });
    if (acquisition.kind !== "acquired") throw new Error("expected to acquire the lock");

    const stolen = lockRecord({ pid: process.pid + 1_000, host: "some-other-host" });
    await fsp.writeFile(lockPath, stolen);

    await acquisition.release();

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(stolen);
  });

  it("polls instead of spinning when a stale lock cannot be removed", async () => {
    // A lock that reads as permanently stale but cannot be unlinked (an
    // unremovable file, a denied directory, a Windows handle still open on it)
    // used to retry the takeover with no sleep between attempts, spinning a core
    // in syscalls for the whole 15-minute deadline.
    const lockPath = path.join(root, "locks", "codex.lock");
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    // This host, a pid far above any pid_max: the stale check sees a dead
    // holder without depending on wall-clock mtime, which the fake clock below
    // would otherwise make meaningless.
    await fsp.writeFile(lockPath, lockRecord({ pid: 4_000_000 }));

    let clock = 0;
    let removeAttempts = 0;
    const realRm = fsp.rm.bind(fsp);
    // Scoped to the lock path: the suite-level afterEach cleans temp dirs with
    // the same fsp.rm and must not inherit the failure.
    vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
      if (String(target) !== lockPath) return realRm(target as string, options);
      removeAttempts += 1;
      // Advance a little so a regression terminates on the deadline instead of
      // hanging the suite; it just does so having never slept.
      clock += 1;
      throw errno("EPERM");
    });
    const sleep = vi.fn(async () => {
      clock += 250;
    });

    await expect(
      acquireToolLock({ lockPath, sleep, pollIntervalMs: 250, timeoutMs: 1_000, now: () => clock }),
    ).rejects.toMatchObject({ name: "ToolError", kind: "lock-timeout" });

    expect(sleep).toHaveBeenCalled();
    expect(removeAttempts).toBeLessThan(10);
  });

  it("stops the heartbeat once another process has reclaimed the lock", async () => {
    // The mirror of the release() guard: a stalled holder whose heartbeat kept
    // running would keep refreshing the new owner's mtime, so that owner's lock
    // could never age out if it died.
    vi.useFakeTimers();
    try {
      const lockPath = path.join(root, "locks", "codex.lock");
      const acquisition = await acquireToolLock({
        lockPath,
        sleep: async () => undefined,
        staleMs: 4_000,
      });
      if (acquisition.kind !== "acquired") throw new Error("expected to acquire the lock");

      const utimes = vi.spyOn(fs, "utimesSync");
      vi.advanceTimersByTime(1_000);
      expect(utimes).toHaveBeenCalledTimes(1);

      fs.writeFileSync(lockPath, lockRecord({ pid: process.pid + 1_000, host: "some-other-host" }));
      vi.advanceTimersByTime(10_000);

      expect(utimes).toHaveBeenCalledTimes(1);
      await acquisition.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("release() removes the lock it actually wrote", async () => {
    const lockPath = path.join(root, "locks", "codex.lock");
    const acquisition = await acquireToolLock({ lockPath, sleep: async () => undefined });
    if (acquisition.kind !== "acquired") throw new Error("expected to acquire the lock");

    await acquisition.release();

    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
