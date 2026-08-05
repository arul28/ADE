import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseAssetDownloadError } from "../../../../../ade-cli/src/lib/releaseAssets";
import { resolveBootstrapRuntimeSidecars } from "./remoteBootstrap";
import {
  RemoteSidecarFetchError,
  releaseTagForAppVersion,
  resolveRemoteRuntimeSidecars,
} from "./remoteSidecarCache";

const ARCH = "linux-arm64";
const BINARY_ASSET = `ade-${ARCH}`;
const NATIVE_ASSET = `ade-${ARCH}.native.tar.gz`;
const BINARY_BYTES = "linux-arm64 runtime binary";
const NATIVE_BYTES = "linux-arm64 native deps";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function checksumsFile(overrides: { binary?: string; native?: string } = {}): string {
  return [
    `${overrides.binary ?? sha256(BINARY_BYTES)}  ${BINARY_ASSET}`,
    `${overrides.native ?? sha256(NATIVE_BYTES)}  ${NATIVE_ASSET}`,
    `${sha256("someone else's target")}  ade-darwin-x64`,
    "",
  ].join("\n");
}

/** Injected transport: serves the published assets without touching the network. */
function releaseTransport(options: { checksums?: string } = {}) {
  return vi.fn(async (url: string, outPath: string): Promise<void> => {
    const asset = url.split("/").at(-1) ?? "";
    const body = asset === BINARY_ASSET
      ? BINARY_BYTES
      : asset === NATIVE_ASSET
        ? NATIVE_BYTES
        : asset === "SHA256SUMS"
          ? (options.checksums ?? checksumsFile())
          : null;
    if (body === null) {
      throw new ReleaseAssetDownloadError(`Download failed with HTTP 404: ${url}`, { url, statusCode: 404 });
    }
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, body);
  });
}

let cacheRoot: string;
let bundleDir: string;

beforeEach(async () => {
  cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-sidecar-cache-"));
  bundleDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-sidecar-bundle-"));
});

afterEach(async () => {
  await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  await fs.promises.rm(bundleDir, { recursive: true, force: true });
});

describe("releaseTagForAppVersion", () => {
  it("prefixes plain desktop versions and rejects non-release versions", () => {
    expect(releaseTagForAppVersion("1.2.33")).toBe("v1.2.33");
    expect(releaseTagForAppVersion("v1.2.33")).toBe("v1.2.33");
    expect(releaseTagForAppVersion("1.2.33-beta.1")).toBe("v1.2.33-beta.1");
    expect(releaseTagForAppVersion("")).toBeNull();
    expect(releaseTagForAppVersion("dev")).toBeNull();
  });
});

describe("resolveRemoteRuntimeSidecars", () => {
  it("uses the bundled sidecar without touching the release when one is present", async () => {
    const downloadFile = releaseTransport();
    const bundledBinaryPath = path.join(bundleDir, BINARY_ASSET);
    const bundledNativeDepsPath = path.join(bundleDir, NATIVE_ASSET);
    fs.writeFileSync(bundledBinaryPath, BINARY_BYTES);
    fs.writeFileSync(bundledNativeDepsPath, NATIVE_BYTES);

    const resolved = await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "1.2.33", bundledBinaryPath, bundledNativeDepsPath },
      { cacheRoot, downloadFile, log: () => {} },
    );

    expect(resolved).toEqual({ binaryPath: bundledBinaryPath, nativeDepsPath: bundledNativeDepsPath, source: "bundled" });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(fs.existsSync(cacheRoot)).toBe(true);
    expect(fs.readdirSync(cacheRoot)).toEqual([]);
  });

  it("downloads and verifies the target's assets against the same version's SHA256SUMS", async () => {
    const downloadFile = releaseTransport();

    const resolved = await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "1.2.33", bundledBinaryPath: null, bundledNativeDepsPath: null },
      { cacheRoot, downloadFile, log: () => {} },
    );

    expect(resolved.source).toBe("release");
    expect(resolved.binaryPath).toBe(path.join(cacheRoot, "v1.2.33", ARCH, BINARY_ASSET));
    expect(resolved.nativeDepsPath).toBe(path.join(cacheRoot, "v1.2.33", ARCH, NATIVE_ASSET));
    expect(fs.readFileSync(resolved.binaryPath!, "utf8")).toBe(BINARY_BYTES);
    expect(fs.readFileSync(resolved.nativeDepsPath!, "utf8")).toBe(NATIVE_BYTES);
    // Every URL pins this desktop's exact version -- never `latest`.
    for (const [url] of downloadFile.mock.calls) {
      expect(url).toContain("/releases/download/v1.2.33/");
    }
    expect(downloadFile.mock.calls.map(([url]) => String(url).split("/").at(-1)))
      .toEqual([BINARY_ASSET, NATIVE_ASSET, "SHA256SUMS"]);
    // The checksum manifest is not left behind next to the cached artifacts.
    expect(fs.readdirSync(path.dirname(resolved.binaryPath!)).sort()).toEqual([BINARY_ASSET, NATIVE_ASSET].sort());
  });

  it("serves a second bootstrap from the cache without re-downloading", async () => {
    const first = releaseTransport();
    const cached = await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "1.2.33", bundledBinaryPath: null, bundledNativeDepsPath: null },
      { cacheRoot, downloadFile: first, log: () => {} },
    );

    const second = releaseTransport();
    const reused = await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "1.2.33", bundledBinaryPath: null, bundledNativeDepsPath: null },
      { cacheRoot, downloadFile: second, log: () => {} },
    );

    expect(second).not.toHaveBeenCalled();
    expect(reused).toEqual({ binaryPath: cached.binaryPath, nativeDepsPath: cached.nativeDepsPath, source: "cache" });
  });

  it("garbage-collects sidecars cached for other versions", async () => {
    fs.mkdirSync(path.join(cacheRoot, "v1.2.30", ARCH), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "v1.2.30", ARCH, BINARY_ASSET), "stale");

    await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "1.2.33", bundledBinaryPath: null, bundledNativeDepsPath: null },
      { cacheRoot, downloadFile: releaseTransport(), log: () => {} },
    );
    // GC is fire-and-forget; let its microtasks drain.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fs.readdirSync(cacheRoot)).toEqual(["v1.2.33"]);
  });

  it("refuses hard when a downloaded asset does not match the published checksum", async () => {
    const downloadFile = releaseTransport({ checksums: checksumsFile({ binary: sha256("tampered") }) });

    const error = await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "1.2.33", bundledBinaryPath: null, bundledNativeDepsPath: null },
      { cacheRoot, downloadFile, log: () => {} },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RemoteSidecarFetchError);
    expect((error as RemoteSidecarFetchError).kind).toBe("checksum");
    expect((error as Error).message).toContain(`${BINARY_ASSET} downloaded from the v1.2.33 release does not match its published checksum`);
    // Nothing unverified is left in the cache for a later run to trust.
    expect(fs.existsSync(path.join(cacheRoot, "v1.2.33", ARCH))).toBe(false);
    expect(fs.readdirSync(path.join(cacheRoot, "v1.2.33"))).toEqual([]);
  });

  it("refuses when the release checksum manifest has no entry for the asset", async () => {
    const downloadFile = releaseTransport({ checksums: `${sha256("x")}  ade-darwin-x64\n` });

    const error = await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "1.2.33", bundledBinaryPath: null, bundledNativeDepsPath: null },
      { cacheRoot, downloadFile, log: () => {} },
    ).catch((thrown: unknown) => thrown);

    expect((error as RemoteSidecarFetchError).kind).toBe("checksum");
    expect((error as Error).message).toContain("has no entry for");
  });

  it("reports an unpublished release as unavailable rather than a network problem", async () => {
    const downloadFile = vi.fn(async (url: string) => {
      throw new ReleaseAssetDownloadError(`Download failed with HTTP 404: ${url}`, { url, statusCode: 404 });
    });

    const error = await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "9.9.9", bundledBinaryPath: null, bundledNativeDepsPath: null },
      { cacheRoot, downloadFile, log: () => {} },
    ).catch((thrown: unknown) => thrown);

    expect((error as RemoteSidecarFetchError).kind).toBe("unavailable");
    expect((error as Error).message).toContain("The ADE v9.9.9 release does not publish linux-arm64 runtime assets");
  });

  it("treats a version that is not a release tag as unavailable without any request", async () => {
    const downloadFile = releaseTransport();

    const error = await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "0.0.0-dev+local", bundledBinaryPath: null, bundledNativeDepsPath: null },
      { cacheRoot, downloadFile, log: () => {} },
    ).catch((thrown: unknown) => thrown);

    expect((error as RemoteSidecarFetchError).kind).toBe("unavailable");
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("names the URL and the remote-side alternative when the download fails", async () => {
    const downloadFile = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND github.com");
    });

    const error = await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "1.2.33", bundledBinaryPath: null, bundledNativeDepsPath: null },
      { cacheRoot, downloadFile, log: () => {} },
    ).catch((thrown: unknown) => thrown);

    expect((error as RemoteSidecarFetchError).kind).toBe("network");
    expect((error as Error).message).toContain(
      `https://github.com/arul28/ADE/releases/download/v1.2.33/${BINARY_ASSET}`,
    );
    expect((error as Error).message).toContain("getaddrinfo ENOTFOUND github.com");
    expect((error as Error).message).toContain('run "ade brain update" on the remote machine');
    expect(fs.readdirSync(path.join(cacheRoot, "v1.2.33"))).toEqual([]);
  });
});

describe("resolveBootstrapRuntimeSidecars", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    warn.mockClear();
  });

  it("does not spend a download when the remote already runs this desktop's version", async () => {
    const downloadFile = releaseTransport();

    const resolved = await resolveBootstrapRuntimeSidecars({
      resourcesPath: bundleDir,
      archLabel: ARCH,
      appVersion: "1.2.33",
      remoteRuntimeVersion: "1.2.33",
      bundledBinary: null,
      sidecarDeps: { cacheRoot, downloadFile, log: () => {} },
    });

    expect(resolved).toEqual({ binaryPath: null, nativeDepsPath: null });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("fetches the foreign target's runtime when the remote has none", async () => {
    const downloadFile = releaseTransport();

    const resolved = await resolveBootstrapRuntimeSidecars({
      resourcesPath: bundleDir,
      archLabel: ARCH,
      appVersion: "1.2.33",
      remoteRuntimeVersion: null,
      bundledBinary: null,
      sidecarDeps: { cacheRoot, downloadFile, log: () => {} },
    });

    expect(resolved.binaryPath).toBe(path.join(cacheRoot, "v1.2.33", ARCH, BINARY_ASSET));
    expect(resolved.nativeDepsPath).toBe(path.join(cacheRoot, "v1.2.33", ARCH, NATIVE_ASSET));
  });

  it("falls back to the existing bootstrap error when the desktop version is unpublished", async () => {
    const downloadFile = vi.fn(async (url: string) => {
      throw new ReleaseAssetDownloadError(`Download failed with HTTP 404: ${url}`, { url, statusCode: 404 });
    });

    const resolved = await resolveBootstrapRuntimeSidecars({
      resourcesPath: bundleDir,
      archLabel: ARCH,
      appVersion: "9.9.9",
      remoteRuntimeVersion: null,
      bundledBinary: null,
      sidecarDeps: { cacheRoot, downloadFile, log: () => {} },
    });

    // Null sidecars let bootstrap raise its own "not installed and no bundled
    // ADE service is available" message instead of a download diagnostic.
    expect(resolved).toEqual({ binaryPath: null, nativeDepsPath: null });
    expect(warn).toHaveBeenCalledWith("remote_runtime.sidecar_fetch_failed", expect.objectContaining({ kind: "unavailable" }));
  });

  it("keeps a usable older remote runtime working when the download fails", async () => {
    const downloadFile = vi.fn(async () => {
      throw new Error("socket hang up");
    });

    const resolved = await resolveBootstrapRuntimeSidecars({
      resourcesPath: bundleDir,
      archLabel: ARCH,
      appVersion: "1.2.33",
      remoteRuntimeVersion: "1.2.30",
      bundledBinary: null,
      sidecarDeps: { cacheRoot, downloadFile, log: () => {} },
    });

    expect(resolved).toEqual({ binaryPath: null, nativeDepsPath: null });
    expect(warn).toHaveBeenCalledWith("remote_runtime.sidecar_fetch_failed", expect.objectContaining({ kind: "network" }));
  });

  it("fails the bootstrap when a first-time install cannot reach the release", async () => {
    const downloadFile = vi.fn(async () => {
      throw new Error("socket hang up");
    });

    await expect(resolveBootstrapRuntimeSidecars({
      resourcesPath: bundleDir,
      archLabel: ARCH,
      appVersion: "1.2.33",
      remoteRuntimeVersion: null,
      bundledBinary: null,
      sidecarDeps: { cacheRoot, downloadFile, log: () => {} },
    })).rejects.toThrow(/could not download the linux-arm64 runtime/);
  });

  it("refuses a checksum mismatch even when the remote could have kept its old runtime", async () => {
    const downloadFile = releaseTransport({ checksums: checksumsFile({ native: sha256("tampered") }) });

    await expect(resolveBootstrapRuntimeSidecars({
      resourcesPath: bundleDir,
      archLabel: ARCH,
      appVersion: "1.2.33",
      remoteRuntimeVersion: "1.2.30",
      bundledBinary: null,
      sidecarDeps: { cacheRoot, downloadFile, log: () => {} },
    })).rejects.toThrow(/does not match its published checksum/);
  });
});

describe("sidecar cache promotion", () => {
  it("replaces a half-written cache directory left by an interrupted fetch", async () => {
    const partial = path.join(cacheRoot, "v1.2.33", ARCH);
    fs.mkdirSync(partial, { recursive: true });
    fs.writeFileSync(path.join(partial, BINARY_ASSET), "truncated");

    const resolved = await resolveRemoteRuntimeSidecars(
      { archLabel: ARCH, appVersion: "1.2.33", bundledBinaryPath: null, bundledNativeDepsPath: null },
      { cacheRoot, downloadFile: releaseTransport(), log: () => {} },
    );

    expect(resolved.source).toBe("release");
    expect(fs.readFileSync(path.join(partial, BINARY_ASSET), "utf8")).toBe(BINARY_BYTES);
    expect(fs.existsSync(path.join(partial, NATIVE_ASSET))).toBe(true);
  });
});
