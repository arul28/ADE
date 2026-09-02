import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGACY_BINARY_SOURCE,
  resolveBinary,
  type ResolveBinaryOptions,
  type ResolvedBinary,
} from "../src/binary.js";
import { bundledRuntimePackageName, resolveBundledRuntime } from "../src/bundledRuntime.js";
import { createAdeChat, type AdeChatClient, type InternalAdeChatOptions } from "../src/client.js";
import { runtimeSpawnEnv } from "../src/download.js";
import { AdeError } from "../src/errors.js";
import { probeRuntimeSignature, type SignatureCommandRunner } from "../src/runtimeSignature.js";
import { writeRuntimePidfile } from "../src/runtimePidfile.js";
import { MockRuntime } from "./mockRuntime.js";

const tempDirs: string[] = [];
const clients: AdeChatClient[] = [];
const runtimes: MockRuntime[] = [];

function makeTempDir(prefix = "ade-sdk-runtime-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  // Node's own resolver realpaths, so an assertion built from the raw mkdtemp
  // path would compare /var against /private/var on macOS.
  return fs.realpathSync(dir);
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose().catch(() => {});
  for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => {});
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A platform package the way `build-runtime-npm-packages.mjs` lays one out.
 * `parentDir` becomes the resolution anchor: `<parentDir>/node_modules/<pkg>`.
 */
function writeFakeRuntimePackage(options: {
  parentDir: string;
  target: string;
  platform?: NodeJS.Platform;
  version?: string;
  withBinary?: boolean;
  withNodeModules?: boolean;
}): string {
  const {
    parentDir,
    target,
    platform = "darwin",
    version = "1.2.3",
    withBinary = true,
    withNodeModules = true,
  } = options;
  const packageName = bundledRuntimePackageName(target);
  const packageRoot = path.join(parentDir, "node_modules", packageName);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: packageName, version }),
  );
  if (withBinary) {
    fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "bin", platform === "win32" ? "ade.exe" : "ade"),
      "#!/bin/sh\n",
      { mode: 0o755 },
    );
  }
  if (withNodeModules) {
    fs.mkdirSync(path.join(packageRoot, "native", "node_modules"), { recursive: true });
  }
  return packageRoot;
}

describe("resolveBundledRuntime", () => {
  it("returns null when no platform package is installed", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    expect(
      resolveBundledRuntime({ resolveFrom: dir, platform: "darwin", arch: "arm64" }),
    ).toBeNull();
  });

  it("resolves the binary, runtime root and node_modules of an installed package", () => {
    const dir = makeTempDir();
    const packageRoot = writeFakeRuntimePackage({
      parentDir: dir,
      target: "darwin-arm64",
      version: "9.9.9",
    });
    const resolved = resolveBundledRuntime({
      resolveFrom: dir,
      platform: "darwin",
      arch: "arm64",
    });
    expect(resolved).toEqual({
      binaryPath: path.join(packageRoot, "bin", "ade"),
      runtimeRoot: path.join(packageRoot, "native"),
      nodeModulesPath: path.join(packageRoot, "native", "node_modules"),
      packageName: "@ade-dev/runtime-darwin-arm64",
      version: "9.9.9",
    });
  });

  it("names ade.exe on Windows", () => {
    const dir = makeTempDir();
    writeFakeRuntimePackage({ parentDir: dir, target: "win32-x64", platform: "win32" });
    const resolved = resolveBundledRuntime({ resolveFrom: dir, platform: "win32", arch: "x64" });
    expect(path.basename(resolved!.binaryPath)).toBe("ade.exe");
  });

  it("survives a resolution anchor that is a path with spaces", () => {
    // `/Applications/My App.app/Contents/Resources/...` is the normal case for
    // an Electron bundle, and every path here goes through `path.join`.
    const dir = path.join(makeTempDir(), "My App.app", "Contents", "Resources");
    fs.mkdirSync(dir, { recursive: true });
    const packageRoot = writeFakeRuntimePackage({ parentDir: dir, target: "darwin-arm64" });
    const resolved = resolveBundledRuntime({
      resolveFrom: dir,
      platform: "darwin",
      arch: "arm64",
    });
    expect(resolved?.binaryPath).toBe(path.join(packageRoot, "bin", "ade"));
    expect(resolved?.binaryPath).toContain("My App.app");
    // The spawn env is the other half of the quoting question: it carries the
    // spaces verbatim rather than shell-quoting them, because nothing here ever
    // builds a shell string.
    const env = runtimeSpawnEnv(resolved!.runtimeRoot, {}, resolved!.nodeModulesPath);
    expect(env.ADE_RUNTIME_ROOT).toBe(resolved!.runtimeRoot);
    expect(env.ADE_RUNTIME_NODE_MODULES).toBe(resolved!.nodeModulesPath);
    expect(env.NODE_PATH).toBe(resolved!.nodeModulesPath);
  });

  it("resolves from a file anchor as well as a directory anchor", () => {
    const dir = makeTempDir();
    writeFakeRuntimePackage({ parentDir: dir, target: "linux-x64" });
    const fileAnchor = path.join(dir, "index.cjs");
    fs.writeFileSync(fileAnchor, "");
    expect(
      resolveBundledRuntime({ resolveFrom: fileAnchor, platform: "linux", arch: "x64" }),
    ).not.toBeNull();
  });

  it("throws binary_not_found naming the missing binary", () => {
    const dir = makeTempDir();
    const packageRoot = writeFakeRuntimePackage({
      parentDir: dir,
      target: "darwin-arm64",
      withBinary: false,
    });
    try {
      resolveBundledRuntime({ resolveFrom: dir, platform: "darwin", arch: "arm64" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdeError);
      expect((error as AdeError).code).toBe("binary_not_found");
      expect((error as AdeError).message).toContain(path.join(packageRoot, "bin", "ade"));
    }
  });

  it("throws binary_not_found naming the missing native modules", () => {
    const dir = makeTempDir();
    const packageRoot = writeFakeRuntimePackage({
      parentDir: dir,
      target: "darwin-arm64",
      withNodeModules: false,
    });
    try {
      resolveBundledRuntime({ resolveFrom: dir, platform: "darwin", arch: "arm64" });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as AdeError).code).toBe("binary_not_found");
      expect((error as AdeError).message).toContain(
        path.join(packageRoot, "native", "node_modules"),
      );
    }
  });

  it("returns null on a platform ADE publishes no runtime for", () => {
    const dir = makeTempDir();
    expect(resolveBundledRuntime({ resolveFrom: dir, platform: "freebsd", arch: "x64" })).toBeNull();
  });
});

describe("resolveBinary resolution order", () => {
  const target = "darwin-arm64";

  /**
   * Every filesystem probe and the bundled-package lookup are injected, so each
   * row of the order is expressed as "what exists" rather than as a real tree.
   */
  function resolve(present: {
    explicitBinary?: string;
    explicitNodeModules?: string;
    bundled?: boolean;
    cache?: boolean;
    onPath?: boolean;
    allowDownload?: boolean;
    allowPathDiscovery?: boolean;
    directories?: string[];
  }): Promise<ResolvedBinary> {
    const home = "/fake/home";
    const cacheBinary = path.join(home, "bin", "ade");
    const cacheNodeModules = path.join(home, "runtime", target, "node_modules");
    const pathBinary = "/usr/local/bin/ade";
    const files = new Set<string>();
    const directories = new Set<string>(present.directories ?? []);
    if (present.explicitBinary) files.add(path.resolve(present.explicitBinary));
    if (present.cache) {
      files.add(cacheBinary);
      directories.add(cacheNodeModules);
    }
    if (present.onPath) files.add(pathBinary);

    const options: ResolveBinaryOptions = {
      home,
      logger: () => {},
      platform: "darwin",
      arch: "arm64",
      env: present.onPath ? { PATH: "/usr/local/bin" } : { PATH: "" },
      fileExists: (candidate) => files.has(candidate),
      directoryExists: (candidate) => directories.has(candidate),
      discoverOnPath: () => (present.onPath ? pathBinary : null),
      resolveBundled: () =>
        present.bundled
          ? {
              binaryPath: "/bundle/bin/ade",
              runtimeRoot: "/bundle/native",
              nodeModulesPath: "/bundle/native/node_modules",
              packageName: bundledRuntimePackageName(target),
              version: "1.0.0",
            }
          : null,
      download: async () => ({
        binaryPath: cacheBinary,
        runtimeRoot: path.join(home, "runtime", target),
        checksumVerified: true,
      }),
      ...(present.explicitBinary ? { binaryPath: present.explicitBinary } : {}),
      ...(present.explicitNodeModules ? { runtimeNodeModules: present.explicitNodeModules } : {}),
      ...(present.allowDownload !== undefined ? { allowDownload: present.allowDownload } : {}),
      ...(present.allowPathDiscovery !== undefined
        ? { allowPathDiscovery: present.allowPathDiscovery }
        : {}),
    };
    return resolveBinary(options);
  }

  it("prefers an explicit binaryPath over every other source", async () => {
    const resolved = await resolve({
      explicitBinary: "/pinned/ade",
      bundled: true,
      cache: true,
      onPath: true,
    });
    expect(resolved.source).toBe("explicit");
    expect(resolved.binaryPath).toBe(path.resolve("/pinned/ade"));
  });

  it("prefers a bundled package over the cache, PATH and a download", async () => {
    const resolved = await resolve({ bundled: true, cache: true, onPath: true });
    expect(resolved.source).toBe("bundled-package");
    expect(resolved.runtimeRoot).toBe("/bundle/native");
    expect(resolved.nodeModulesPath).toBe("/bundle/native/node_modules");
  });

  it("prefers the cache over PATH and a download", async () => {
    const resolved = await resolve({ cache: true, onPath: true });
    expect(resolved.source).toBe("cached-download");
    expect(resolved.nodeModulesPath).toBe(
      path.join("/fake/home", "runtime", target, "node_modules"),
    );
  });

  it("prefers PATH over a download", async () => {
    const resolved = await resolve({ onPath: true });
    expect(resolved.source).toBe("path");
    expect(resolved.runtimeRoot).toBeNull();
    expect(resolved.nodeModulesPath).toBeNull();
  });

  it("downloads when nothing else is available", async () => {
    const resolved = await resolve({});
    expect(resolved.source).toBe("downloaded");
    expect(resolved.checksumVerified).toBe(true);
  });

  it("maps every source back onto the 0.1.x doctor().binary.source values", async () => {
    expect(LEGACY_BINARY_SOURCE).toEqual({
      explicit: "option",
      "bundled-package": "option",
      "cached-download": "cache",
      path: "path",
      downloaded: "download",
    });
    // `legacySource` is no longer stored on the result: it is
    // `LEGACY_BINARY_SOURCE[source]` by construction, derived at the one
    // consumer in `doctor()`.
    const legacyOf = async (options: Parameters<typeof resolve>[0]) =>
      LEGACY_BINARY_SOURCE[(await resolve(options)).source];
    expect(await legacyOf({ explicitBinary: "/pinned/ade" })).toBe("option");
    expect(await legacyOf({ bundled: true })).toBe("option");
    expect(await legacyOf({ cache: true })).toBe("cache");
    expect(await legacyOf({ onPath: true })).toBe("path");
    expect(await legacyOf({})).toBe("download");
  });

  it("throws runtime_unavailable instead of downloading when allowDownload is false", async () => {
    await expect(resolve({ allowDownload: false })).rejects.toMatchObject({
      name: "AdeError",
      code: "runtime_unavailable",
    });
  });

  it("lists what it tried in the runtime_unavailable message", async () => {
    const error = await resolve({ allowDownload: false }).catch((caught: unknown) => caught);
    const message = (error as AdeError).message;
    expect(message).toContain("no binaryPath was supplied");
    expect(message).toContain("no @ade-dev/runtime-* platform package is installed");
    expect(message).toContain("no previous download is cached");
    expect(message).toContain("no `ade` was found on PATH");
    expect(message).toContain("@ade-dev/runtime-darwin-arm64");
  });

  it("still downloads with allowDownload unset, preserving 0.1.x behavior", async () => {
    expect((await resolve({})).source).toBe("downloaded");
  });

  it("carries an explicit runtimeNodeModules through, defaulting runtimeRoot to its parent", async () => {
    const resolved = await resolve({
      explicitBinary: "/pinned/bin/ade",
      explicitNodeModules: "/pinned/native/node_modules",
      directories: ["/pinned/native/node_modules", "/pinned/native"],
    });
    expect(resolved.nodeModulesPath).toBe("/pinned/native/node_modules");
    expect(resolved.runtimeRoot).toBe("/pinned/native");
  });

  it("rejects a runtimeNodeModules that is not a directory", async () => {
    await expect(
      resolve({
        explicitBinary: "/pinned/bin/ade",
        explicitNodeModules: "/pinned/missing/node_modules",
      }),
    ).rejects.toMatchObject({ code: "binary_not_found" });
  });

  it("leaves the runtime paths null when only binaryPath is pinned", async () => {
    const resolved = await resolve({ explicitBinary: "/pinned/ade" });
    expect(resolved.runtimeRoot).toBeNull();
    expect(resolved.nodeModulesPath).toBeNull();
  });
});

describe("runtimeSpawnEnv with a relocated node_modules", () => {
  it("uses an explicit node_modules verbatim rather than deriving it", () => {
    const env = runtimeSpawnEnv("/bundle/native", {}, "/bundle/elsewhere/node_modules");
    expect(env.ADE_RUNTIME_ROOT).toBe("/bundle/native");
    expect(env.ADE_RUNTIME_NODE_MODULES).toBe("/bundle/elsewhere/node_modules");
    expect(env.NODE_PATH).toBe("/bundle/elsewhere/node_modules");
  });

  it("still derives <runtimeRoot>/node_modules when none is given", () => {
    const env = runtimeSpawnEnv("/bundle/native", {});
    expect(env.ADE_RUNTIME_NODE_MODULES).toBe(path.join("/bundle/native", "node_modules"));
  });

  it("prepends to an existing NODE_PATH", () => {
    const env = runtimeSpawnEnv("/bundle/native", { NODE_PATH: "/host/mods" }, "/bundle/nm");
    expect(env.NODE_PATH).toBe(`/bundle/nm${path.delimiter}/host/mods`);
  });
});

describe("probeRuntimeSignature", () => {
  function runner(
    responses: Record<string, { code: number; stdout?: string; stderr?: string }>,
  ): { run: SignatureCommandRunner; calls: Array<{ command: string; args: string[] }> } {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: SignatureCommandRunner = async (command, args) => {
      calls.push({ command, args });
      const key = Object.keys(responses).find((candidate) => command.includes(candidate));
      const response = key ? responses[key]! : { code: 127 };
      return { code: response.code, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
    };
    return { run, calls };
  }

  it("reads the authority and Gatekeeper acceptance on macOS", async () => {
    const { run, calls } = runner({
      codesign: {
        code: 0,
        stderr: [
          "Executable=/Applications/My App.app/Contents/Resources/ade-runtime/bin/ade",
          "Identifier=ade",
          "Authority=Developer ID Application: Example Inc (ABCDE12345)",
          "Authority=Developer ID Certification Authority",
          "TeamIdentifier=ABCDE12345",
        ].join("\n"),
      },
      spctl: { code: 0 },
    });
    const signature = await probeRuntimeSignature("/Applications/My App.app/bin/ade", {
      platform: "darwin",
      spawn: run,
    });
    expect(signature).toEqual({
      signed: true,
      authority: "Developer ID Application: Example Inc (ABCDE12345)",
      accepted: true,
    });
    expect(calls[0]?.args).toEqual([
      "-dv",
      "--verbose=2",
      "/Applications/My App.app/bin/ade",
    ]);
  });

  it("reports accepted false when Gatekeeper rejects a signed binary", async () => {
    const { run } = runner({
      codesign: { code: 0, stderr: "Authority=Example\nTeamIdentifier=ABCDE12345" },
      spctl: { code: 3 },
    });
    expect(await probeRuntimeSignature("/x/ade", { platform: "darwin", spawn: run })).toEqual({
      signed: true,
      authority: "Example",
      accepted: false,
    });
  });

  it("falls back to the Team ID when no Authority line is present", async () => {
    const { run } = runner({
      codesign: { code: 0, stderr: "TeamIdentifier=ABCDE12345" },
      spctl: { code: 0 },
    });
    expect(await probeRuntimeSignature("/x/ade", { platform: "darwin", spawn: run })).toEqual({
      signed: true,
      authority: "ABCDE12345",
      accepted: true,
    });
  });

  it("reports an ad-hoc signature as signed with no authority", async () => {
    const { run } = runner({
      codesign: { code: 0, stderr: "Signature=adhoc\nTeamIdentifier=not set" },
      spctl: { code: 3 },
    });
    expect(await probeRuntimeSignature("/x/ade", { platform: "darwin", spawn: run })).toEqual({
      signed: true,
      accepted: false,
    });
  });

  it("reports an unsigned macOS binary and never consults Gatekeeper", async () => {
    const { run, calls } = runner({
      codesign: { code: 1, stderr: "/x/ade: code object is not signed at all" },
    });
    expect(await probeRuntimeSignature("/x/ade", { platform: "darwin", spawn: run })).toEqual({
      signed: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("parses Get-AuthenticodeSignature output on Windows", async () => {
    const { run, calls } = runner({
      powershell: {
        code: 0,
        stdout: "status=Valid\nsubject=CN=Example Inc, O=Example Inc, C=US\n",
      },
    });
    const signature = await probeRuntimeSignature(String.raw`C:\Program Files\My App\ade.exe`, {
      platform: "win32",
      spawn: run,
    });
    expect(signature).toEqual({
      signed: true,
      accepted: true,
      authority: "CN=Example Inc, O=Example Inc, C=US",
    });
    // Structured argv, and the path is a PowerShell single-quoted literal
    // rather than an interpolated shell string.
    expect(calls[0]?.args.slice(0, 6)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
    expect(calls[0]?.args[6]).toContain(String.raw`'C:\Program Files\My App\ade.exe'`);
  });

  it("doubles a single quote inside a Windows path", async () => {
    const { run, calls } = runner({ powershell: { code: 0, stdout: "status=NotSigned\n" } });
    await probeRuntimeSignature(String.raw`C:\It's Here\ade.exe`, {
      platform: "win32",
      spawn: run,
    });
    expect(calls[0]?.args[6]).toContain(String.raw`'C:\It''s Here\ade.exe'`);
  });

  it("reports an unsigned Windows binary", async () => {
    const { run } = runner({ powershell: { code: 0, stdout: "status=NotSigned\n" } });
    expect(await probeRuntimeSignature("C:/ade.exe", { platform: "win32", spawn: run })).toEqual({
      signed: false,
    });
  });

  it("reports a signed but untrusted Windows binary as not accepted", async () => {
    const { run } = runner({
      powershell: { code: 0, stdout: "status=UnknownError\nsubject=CN=Self\n" },
    });
    expect(await probeRuntimeSignature("C:/ade.exe", { platform: "win32", spawn: run })).toEqual({
      signed: true,
      accepted: false,
      authority: "CN=Self",
    });
  });

  it("returns null on Linux", async () => {
    const { run, calls } = runner({});
    expect(await probeRuntimeSignature("/x/ade", { platform: "linux", spawn: run })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null rather than throwing when the probe cannot run", async () => {
    const failing: SignatureCommandRunner = async () => {
      throw new Error("codesign is missing");
    };
    expect(
      await probeRuntimeSignature("/x/ade", { platform: "darwin", spawn: failing }),
    ).toBeNull();
    expect(await probeRuntimeSignature("", { platform: "darwin", spawn: failing })).toBeNull();
  });
});

describe("doctor().runtime", () => {
  async function startRuntime(): Promise<MockRuntime> {
    const runtime = new MockRuntime();
    await runtime.start();
    runtimes.push(runtime);
    return runtime;
  }

  /**
   * Boots a real client against `MockRuntime` while still going through
   * `resolveBinary`. A pidfile naming a live process that owns the mock's
   * endpoint makes the client adopt that runtime instead of spawning one, which
   * is the only way to observe a non-attach `doctor().runtime` without a real
   * `ade`.
   */
  async function connectWithResolvedBinary(
    runtime: MockRuntime,
    overrides: Partial<InternalAdeChatOptions>,
  ): Promise<AdeChatClient> {
    const home = makeTempDir("ade-sdk-home-");
    await writeRuntimePidfile(home, {
      // Any live pid that is not this process: the reclaim path refuses to
      // adopt a runtime whose recorded owner is gone.
      pid: process.ppid,
      parentPid: process.pid,
      socketPath: runtime.socketPath,
      startedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const client = await createAdeChat({
      home,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
      allowPathDiscovery: false,
      ...overrides,
    } as InternalAdeChatOptions);
    clients.push(client);
    return client;
  }

  it("reports source attached and no signature in attach mode", async () => {
    const runtime = await startRuntime();
    const client = await createAdeChat({
      home: makeTempDir("ade-sdk-home-"),
      attach: true,
      socketPath: runtime.socketPath,
      pollIntervalMs: 10,
    } as InternalAdeChatOptions);
    clients.push(client);
    const report = await client.doctor();
    expect(report.runtime.source).toBe("attached");
    expect(report.runtime.binaryPath).toBe("(attached)");
    expect(report.runtime.signature).toBeNull();
    expect(report.runtime.downloadedThisSession).toBe(false);
    expect(report.runtime.runtimeRoot).toBeNull();
    // The 0.1.x view is untouched.
    expect(report.binary.source).toBe("option");
    expect(report.binary.path).toBe("(attached)");
  });

  it("reports source explicit with the runtime paths a bundle supplied", async () => {
    const runtime = await startRuntime();
    const bundle = makeTempDir("ade-sdk-bundle-");
    const binaryPath = path.join(bundle, "bin", "ade");
    const nodeModules = path.join(bundle, "native", "node_modules");
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, "");
    fs.mkdirSync(nodeModules, { recursive: true });

    const client = await connectWithResolvedBinary(runtime, {
      binaryPath,
      runtimeNodeModules: nodeModules,
      allowDownload: false,
    });
    const report = await client.doctor();
    expect(report.runtime.source).toBe("explicit");
    expect(report.runtime.binaryPath).toBe(binaryPath);
    expect(report.runtime.runtimeRoot).toBe(path.join(bundle, "native"));
    expect(report.runtime.nodeModulesPath).toBe(nodeModules);
    expect(report.runtime.downloadedThisSession).toBe(false);
    expect(report.runtime.checksumVerified).toBe(false);
    expect(report.binary.source).toBe("option");
  });

  it("reports source bundled-package when a platform package supplied the binary", async () => {
    const runtime = await startRuntime();
    const installRoot = makeTempDir("ade-sdk-install-");
    const target = `${process.platform}-${process.arch}`;
    const packageRoot = writeFakeRuntimePackage({
      parentDir: installRoot,
      target,
      platform: process.platform,
    });
    const client = await connectWithResolvedBinary(runtime, {
      allowDownload: false,
      resolveBundledFrom: installRoot,
    } as Partial<InternalAdeChatOptions>);
    const report = await client.doctor();
    expect(report.runtime.source).toBe("bundled-package");
    expect(report.runtime.runtimeRoot).toBe(path.join(packageRoot, "native"));
    expect(report.binary.source).toBe("option");
  });

  it("throws runtime_unavailable when nothing is bundled and downloads are off", async () => {
    const home = makeTempDir("ade-sdk-home-");
    await expect(
      createAdeChat({
        home,
        allowDownload: false,
        allowPathDiscovery: false,
        resolveBundledFrom: makeTempDir("ade-sdk-empty-"),
      } as InternalAdeChatOptions),
    ).rejects.toMatchObject({ name: "AdeError", code: "runtime_unavailable" });
  });
});
