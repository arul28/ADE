import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupCachedTool } from "../../../../../ade-cli/src/services/tools/cacheLookup";
import type { ToolDownloader } from "../../../../../ade-cli/src/services/tools/download";
import { ToolError } from "../../../../../ade-cli/src/services/tools/errors";
import { ensureTools, type ToolsContext } from "../../../../../ade-cli/src/services/tools/install";
import { parseToolsManifest } from "../../../../../ade-cli/src/services/tools/manifest";
import { registerDeletedPinFallback, trackPinnedToolFetch } from "../../../../../ade-cli/src/services/tools/onDemand";
import { devinDeletedPinFallback } from "./devinFallForward";

// The child process (`devin --version`) and Sentry are the boundaries mocked
// here; the network is the stub downloader and a fake `fetch`.
vi.mock("./providerFallForward", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providerFallForward")>()),
  runProbeProcess: vi.fn(async () => ({ exitCode: 0, stdout: "devin 3000.20.0 (abc123)\n", stderr: "", timedOut: false })),
}));
vi.mock("../../../shared/sentry/capture", () => ({ captureProblem: vi.fn() }));

const execFileAsync = promisify(execFile);
const PINNED_URL = "https://static.devin.ai/cli/3000.11.3/devin-3000.11.3-aarch64-apple-darwin.tar.gz";
const CURRENT_URL = "https://static.devin.ai/cli/3000.20.0/devin-3000.20.0-aarch64-apple-darwin.tar.gz";
const MANIFEST_URL = "https://static.devin.ai/cli/current/manifest.json";
const logger = { warn: vi.fn(), info: vi.fn() };

let tmpRoot: string;
let archive: { path: string; size: number; sha256: string };

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-devin-ff-"));
  const source = path.join(tmpRoot, "src");
  await fsp.mkdir(path.join(source, "bin"), { recursive: true });
  await fsp.writeFile(path.join(source, "bin", "devin"), "#!/bin/sh\necho devin\n", { mode: 0o755 });
  const archivePath = path.join(tmpRoot, "current.tar.gz");
  await execFileAsync("tar", ["-czf", archivePath, "-C", source, "bin"]);
  const bytes = await fsp.readFile(archivePath);
  archive = { path: archivePath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  registerDeletedPinFallback("devin", (failure, context) => devinDeletedPinFallback(failure, context, logger));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/** Devin's host: the pinned archive answers `pinnedStatus`, the current manifest names `manifestSha256`. */
function devinHost(pinnedStatus: number, manifestSha256: string) {
  const fetchCalls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === MANIFEST_URL) {
      return new Response(JSON.stringify({
        version: "3000.20.0",
        platforms: { "aarch64-apple-darwin": { url: CURRENT_URL, sha256: manifestSha256 } },
      }), { status: 200 });
    }
    if (url === CURRENT_URL && init?.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-length": String(archive.size) } });
    }
    return new Response(null, { status: 404 });
  }));
  const download: ToolDownloader = async (url, destPath) => {
    if (url === PINNED_URL) {
      throw new ToolError(`Download failed with HTTP ${pinnedStatus}: ${url}`, { kind: "network", httpStatus: pinnedStatus });
    }
    if (url !== CURRENT_URL) throw new Error(`unexpected download ${url}`);
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.copyFile(archive.path, destPath);
    return { bytes: archive.size, integrity: "" };
  };
  const context: ToolsContext = {
    toolsRoot: path.join(tmpRoot, "tools"),
    platform: "darwin",
    arch: "arm64",
    target: "darwin-arm64",
    download,
    lock: { pollIntervalMs: 5, timeoutMs: 5_000, staleMs: 2_000 },
    manifest: parseToolsManifest({
      schemaVersion: 1,
      generatedFrom: "test",
      tools: [{
        name: "devin",
        description: "Devin.",
        entry: { kind: "binary", path: "bin/devin", windowsPath: "bin/devin.exe" },
        targets: {
          "darwin-arm64": {
            format: "archive",
            package: "devin-darwin-arm64",
            version: "3000.11.3",
            url: PINNED_URL,
            archive: "tar.gz",
            stripComponents: 0,
            sha256: "0".repeat(64),
            size: 1,
          },
        },
      }],
    }),
  };
  // The same tracked fetch a chat, a Retry and the launch prefetch run.
  const fetchDevin = () => trackPinnedToolFetch("devin", () => ensureTools(["devin"], context), context);
  return { context, fetchCalls, fetchDevin };
}

describe("Devin fall-forward when the pinned build is gone", () => {
  it("a 403 on the pinned archive installs Devin's current build as the pin's stand-in", async () => {
    const host = devinHost(403, archive.sha256);

    await expect(host.fetchDevin()).resolves.toBeNull();

    expect(lookupCachedTool("devin", host.context)).toMatchObject({ version: "3000.20.0" });
  });

  it("a 5xx keeps the failure and never asks Devin's host for another build", async () => {
    const host = devinHost(503, archive.sha256);

    await expect(host.fetchDevin()).resolves.toMatchObject({ kind: "network", httpStatus: 503 });

    expect(host.fetchCalls).toEqual([]);
    expect(lookupCachedTool("devin", host.context)).toBeNull();
  });

  it("refuses a current build whose bytes do not match the manifest's sha256", async () => {
    const host = devinHost(403, "f".repeat(64));

    await expect(host.fetchDevin()).resolves.toMatchObject({ kind: "network", httpStatus: 403 });

    expect(lookupCachedTool("devin", host.context)).toBeNull();
  });
});
