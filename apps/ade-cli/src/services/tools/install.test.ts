import { execFile } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "./errors";
import { type ToolDownloader, fileIntegrity } from "./download";
import { ensureTools, gcTools, resolveTool, tryResolveTool, type ToolsContext } from "./install";
import { type ToolsManifest, parseToolsManifest } from "./manifest";
import { TOOL_INSTALL_SENTINEL, toolVersionDir } from "./paths";

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
