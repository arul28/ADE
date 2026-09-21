import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliProxyApiSupervisor,
  PROXY_HEALTH_MAX_AGE_MS,
  isHashedManagementKey,
} from "./cliProxyApiSupervisor";
import {
  createCliProxyApiConfig,
  readCliProxyApiConfig,
  readCliProxyApiState,
  renderCliProxyApiConfig,
  writeCliProxyApiConfig,
  writeCliProxyApiState,
  type CliProxyApiState,
} from "./cliProxyApiConfig";
import { defaultExtractArchive, verifySha256 } from "./cliProxyApiInstall";
import { applyWindowsOwnerOnlyAcl } from "../../lib/trustedWindowsTools";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cliproxyapi-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("CLIProxyAPI supervisor", () => {
  it("rejects a tampered downloaded archive before extraction", async () => {
    const extractArchive = vi.fn(async () => {});
    const supervisor = new CliProxyApiSupervisor({
      adeHome: makeTemporaryDirectory(),
      platform: "linux",
      arch: "x64",
      fetchImpl: async () => new Response(Buffer.from("tampered fixture"), { status: 200 }),
      extractArchive,
    });

    await expect(supervisor.ensureInstalled()).rejects.toThrow(/checksum mismatch/);
    expect(extractArchive).not.toHaveBeenCalled();
    expect(() => verifySha256(Buffer.from("tampered fixture"), "0".repeat(64))).toThrow(/checksum mismatch/);
  });

  it("removes a downloaded archive after extraction fails", async () => {
    const adeHome = makeTemporaryDirectory();
    const archiveBytes = Buffer.from("extract fixture");
    const extractArchive = vi.fn(async () => {
      throw new Error("extract failed");
    });
    const supervisor = new CliProxyApiSupervisor({
      adeHome,
      platform: "linux",
      arch: "x64",
      release: {
        version: "test-release",
        assets: {
          "linux-amd64": {
            url: "https://example.test/proxy.tar.gz",
            sha256: createHash("sha256").update(archiveBytes).digest("hex"),
            archive: "tar.gz",
            binaryName: "cli-proxy-api",
          },
        },
      } as never,
      fetchImpl: async () => new Response(archiveBytes, { status: 200 }),
      extractArchive,
    });

    await expect(supervisor.ensureInstalled()).rejects.toThrow("extract failed");
    expect(extractArchive).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(adeHome, "proxy", "bin", "test-release", "cli-proxy-api.tar.gz"))).toBe(false);
  });

  it("generates and round-trips the owned config.yaml contract", () => {
    const directory = makeTemporaryDirectory();
    const configPath = path.join(directory, "proxy", "config.yaml");
    const config = createCliProxyApiConfig({
      port: 43821,
      apiKey: "a".repeat(64),
      managementKey: "b".repeat(64),
      authDir: path.join(directory, "proxy", "auth"),
    });

    writeCliProxyApiConfig(configPath, config);
    expect(readCliProxyApiConfig(configPath)).toEqual(config);
    const yaml = renderCliProxyApiConfig(config);
    expect(yaml).toContain("host: 127.0.0.1");
    expect(yaml).toContain("allow-remote: false");
    expect(yaml).toContain("strategy: round-robin");
    expect(yaml).toContain("force-model-prefix: true");
    expect(yaml).toContain("disable-cloaking-model-list: false");
    expect(yaml).toContain("request-retry: 0");
    expect(yaml).toContain("switch-project: false");
  });

  it("round-trips state.json without duplicating proxy credentials", () => {
    const statePath = path.join(makeTemporaryDirectory(), "proxy", "state.json");
    const state: CliProxyApiState = {
      port: 43822,
      version: "7.3.7",
      pid: 12345,
      startedAt: Date.now(),
      healthyAt: Date.now(),
    };

    writeCliProxyApiState(statePath, state);
    expect(readCliProxyApiState(statePath)).toEqual(state);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).not.toHaveProperty("apiKey");
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).not.toHaveProperty("managementKey");
  });

  it("records startup and periodic health timestamps, then clears health on stop", async () => {
    vi.useFakeTimers();
    try {
      const adeHome = makeTemporaryDirectory();
      const binaryPath = path.join(adeHome, "proxy", "bin", "7.3.7", "cli-proxy-api");
      fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
      fs.writeFileSync(binaryPath, "fixture");
      const configPath = path.join(adeHome, "proxy", "config.yaml");
      writeCliProxyApiConfig(configPath, createCliProxyApiConfig({
        port: 43823,
        apiKey: "a".repeat(64),
        managementKey: "b".repeat(64),
        authDir: path.join(adeHome, "proxy", "auth"),
      }));

      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        kill: () => boolean;
      };
      child.pid = process.pid;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        queueMicrotask(() => child.emit("close", 0, null));
        return true;
      };
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      const supervisor = new CliProxyApiSupervisor({
        adeHome,
        platform: "linux",
        arch: "x64",
        fetchImpl,
        spawnImpl: () => child as never,
        healthCheckIntervalMs: 10,
        healthTimeoutMs: 100,
        healthRequestTimeoutMs: 100,
        healthRetryDelayMs: 0,
        sleep: async () => {},
      });

      await supervisor.ensureRunning();
      const statePath = path.join(adeHome, "proxy", "state.json");
      const started = readCliProxyApiState(statePath);
      expect(started).toMatchObject({ pid: process.pid, healthyAt: expect.any(Number) });
      const managementKeyPath = path.join(adeHome, "proxy", ".management-key");
      expect(fs.readFileSync(managementKeyPath, "utf8")).toMatch(/^[0-9a-f]{64}$/i);
      expect(fs.readFileSync(statePath, "utf8")).not.toContain("managementKey");
      const firstHealthyAt = started?.healthyAt ?? 0;

      await vi.advanceTimersByTimeAsync(10);
      const periodicallyHealthy = readCliProxyApiState(statePath);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(periodicallyHealthy?.healthyAt).toBeGreaterThanOrEqual(firstHealthyAt);

      await supervisor.stop();
      expect(readCliProxyApiState(statePath)).toMatchObject({ pid: null, healthyAt: null });
      expect(fs.existsSync(managementKeyPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts a persisted live and recently healthy proxy instead of spawning a duplicate", async () => {
    const adeHome = makeTemporaryDirectory();
    const statePath = path.join(adeHome, "proxy", "state.json");
    const managementKey = "c".repeat(64);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(path.join(adeHome, "proxy", ".management-key"), managementKey, { mode: 0o600 });
    writeCliProxyApiState(statePath, {
      port: 43825,
      version: "7.3.7",
      pid: process.pid,
      startedAt: Date.now() - 1_000,
      healthyAt: Date.now(),
    });
    const spawnImpl = vi.fn();
    const supervisor = new CliProxyApiSupervisor({
      adeHome,
      platform: "linux",
      arch: "x64",
      spawnImpl,
    });

    await expect(supervisor.ensureRunning()).resolves.toMatchObject({
      running: true,
      pid: process.pid,
      port: 43825,
      managementKey,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("refreshes the health stamp for an adopted proxy on the health loop", async () => {
    vi.useFakeTimers();
    try {
      const adeHome = makeTemporaryDirectory();
      const statePath = path.join(adeHome, "proxy", "state.json");
      const pid = 42_424;
      const managementKey = "e".repeat(64);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(path.join(adeHome, "proxy", ".management-key"), managementKey, { mode: 0o600 });
      writeCliProxyApiState(statePath, {
        port: 43827,
        version: "7.3.7",
        pid,
        startedAt: Date.now() - 1_000,
        healthyAt: Date.now(),
      });
      let live = true;
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      const supervisor = new CliProxyApiSupervisor({
        adeHome,
        platform: "linux",
        arch: "x64",
        fetchImpl,
        healthCheckIntervalMs: 10,
        isLivePid: () => live,
        processKill: () => {
          live = false;
        },
        healthProbe: () => true,
        sleep: async () => {},
      });

      await supervisor.ensureRunning();
      const firstHealthyAt = readCliProxyApiState(statePath)?.healthyAt ?? 0;
      await vi.advanceTimersByTimeAsync(10);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(readCliProxyApiState(statePath)?.healthyAt).toBeGreaterThan(firstHealthyAt);
      await supervisor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts a persisted live proxy after a stale health stamp passes the loopback probe", async () => {
    const healthServer = spawn(process.execPath, [
      "-e",
      "const http=require('node:http'); const server=http.createServer((_request,response)=>{response.writeHead(200);response.end('ok');}); server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)));",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    const port = await new Promise<number>((resolve, reject) => {
      healthServer.once("error", reject);
      healthServer.stdout?.once("data", (chunk) => {
        const parsed = Number(String(chunk).trim());
        if (Number.isInteger(parsed) && parsed > 0) resolve(parsed);
        else reject(new Error(`invalid health server port: ${String(chunk)}`));
      });
    });

    try {
      const adeHome = makeTemporaryDirectory();
      const statePath = path.join(adeHome, "proxy", "state.json");
      const managementKey = "d".repeat(64);
      const staleHealthyAt = Date.now() - PROXY_HEALTH_MAX_AGE_MS - 1_000;
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(path.join(adeHome, "proxy", ".management-key"), managementKey, { mode: 0o600 });
      writeCliProxyApiState(statePath, {
        port,
        version: "7.3.7",
        pid: process.pid,
        startedAt: staleHealthyAt,
        healthyAt: staleHealthyAt,
      });
      const spawnImpl = vi.fn();
      const supervisor = new CliProxyApiSupervisor({
        adeHome,
        platform: "linux",
        arch: "x64",
        spawnImpl,
      });

      await expect(supervisor.ensureRunning()).resolves.toMatchObject({
        running: true,
        pid: process.pid,
        port,
        managementKey,
      });
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(readCliProxyApiState(statePath)?.healthyAt).toBeGreaterThan(staleHealthyAt);
    } finally {
      healthServer.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (healthServer.exitCode !== null) resolve();
        else healthServer.once("exit", () => resolve());
      });
    }
  });

  it("waits for an adopted proxy to exit before clearing state", async () => {
    const adeHome = makeTemporaryDirectory();
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100)); setInterval(() => {}, 1_000);",
    ], { stdio: "ignore" });
    const pid = child.pid;
    if (!pid) throw new Error("test proxy did not provide a pid");
    try {
      writeCliProxyApiState(path.join(adeHome, "proxy", "state.json"), {
        port: 43826,
        version: "7.3.7",
        pid,
        startedAt: Date.now() - 1_000,
        healthyAt: Date.now(),
      });
      const supervisor = new CliProxyApiSupervisor({
        adeHome,
        platform: "linux",
        arch: "x64",
        healthProbe: () => true,
      });

      await supervisor.ensureRunning();
      await supervisor.stop();

      expect(() => process.kill(pid, 0)).toThrow();
      expect(readCliProxyApiState(path.join(adeHome, "proxy", "state.json"))).toMatchObject({
        pid: null,
        healthyAt: null,
      });
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  });

  it("rechecks an adopted proxy and uses the Windows process-tree kill", async () => {
    const adeHome = makeTemporaryDirectory();
    const statePath = path.join(adeHome, "proxy", "state.json");
    const pid = 42_425;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(path.join(adeHome, "proxy", ".management-key"), "f".repeat(64), { mode: 0o600 });
    writeCliProxyApiState(statePath, {
      port: 43828,
      version: "7.3.7",
      pid,
      startedAt: Date.now() - 1_000,
      healthyAt: Date.now(),
    });
    let live = true;
    const healthProbe = vi.fn(() => true);
    const killProcessTree = vi.fn(() => {
      live = false;
      return true;
    });
    const processKill = vi.fn();
    const supervisor = new CliProxyApiSupervisor({
      adeHome,
      platform: "win32",
      arch: "x64",
      healthCheckIntervalMs: 0,
      currentUser: "ADEBOX\\arul",
      aclRunner: () => ({ status: 0 }),
      isLivePid: () => live,
      healthProbe,
      killProcessTree,
      processKill,
    });

    await supervisor.ensureRunning();
    await supervisor.stop();

    expect(healthProbe).toHaveBeenCalledWith(43828);
    expect(killProcessTree).toHaveBeenCalledWith(pid);
    expect(processKill).not.toHaveBeenCalled();
  });

  it("keeps the plaintext management key the proxy hashes in its own config", async () => {
    const adeHome = makeTemporaryDirectory();
    const binaryPath = path.join(adeHome, "proxy", "bin", "7.3.7", "cli-proxy-api");
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, "fixture");
    const configPath = path.join(adeHome, "proxy", "config.yaml");
    // A config left behind by a previous run: CLIProxyAPI replaced the
    // plaintext secret with its bcrypt digest on startup.
    const hashed = "$2a$10$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvwxyz01234";
    writeCliProxyApiConfig(configPath, createCliProxyApiConfig({
      port: 43824,
      apiKey: "a".repeat(64),
      managementKey: hashed,
      authDir: path.join(adeHome, "proxy", "auth"),
    }));
    expect(isHashedManagementKey(hashed)).toBe(true);
    expect(isHashedManagementKey("b".repeat(64))).toBe(false);

    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: () => boolean;
    };
    child.pid = process.pid;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      queueMicrotask(() => child.emit("close", 0, null));
      return true;
    };
    const supervisor = new CliProxyApiSupervisor({
      adeHome,
      platform: "linux",
      arch: "x64",
      fetchImpl: async () => new Response(null, { status: 200 }),
      spawnImpl: () => child as never,
      healthCheckIntervalMs: 0,
      healthTimeoutMs: 100,
      healthRequestTimeoutMs: 100,
      healthRetryDelayMs: 0,
      sleep: async () => {},
    });

    const status = await supervisor.ensureRunning();
    // The key handed to the management client is a usable secret, never the
    // digest read back off disk — sending that one answers HTTP 401.
    expect(status.managementKey).not.toBeNull();
    expect(isHashedManagementKey(status.managementKey ?? "")).toBe(false);
    expect(status.managementKey).toBe(readCliProxyApiConfig(configPath)["remote-management"]["secret-key"]);
    // The port and the api-key launched CLIs are pointed at survive the restart.
    expect(status.port).toBe(43824);
    expect(status.apiKey).toBe("a".repeat(64));

    await supervisor.stop();
  });

  it("uses the trusted tar path even when PATH contains a poisoned tar.exe", async () => {
    const spawnCalls: Array<[string, string[]]> = [];
    const spawnImpl = vi.fn((command: string, args: string[]) => {
      spawnCalls.push([command, args]);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    });
    const originalPath = process.env.PATH;
    process.env.PATH = path.join(makeTemporaryDirectory(), "poison");
    try {
      await defaultExtractArchive(
        { archive: "tar.gz" } as never,
        "/tmp/proxy.tar.gz",
        "/tmp/proxy-extracted",
        "win32",
        spawnImpl,
      );
    } finally {
      process.env.PATH = originalPath;
    }

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.[0]).not.toBe("tar.exe");
    expect(spawnCalls[0]?.[0].toLowerCase()).toMatch(/tar\.exe$/);
  });

  it("applies an injected owner-only Windows ACL with the trusted icacls", () => {
    const calls: Array<[string, string[]]> = [];
    applyWindowsOwnerOnlyAcl("C:\\ADE\\proxy\\config.yaml", {
      currentUser: "ADEBOX\\arul",
      aclRunner: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0].toLowerCase()).toMatch(/icacls\.exe$/);
    expect(calls[0]?.[1]).toEqual([
      "C:\\ADE\\proxy\\config.yaml",
      "/inheritance:r",
      "/grant:r",
      "ADEBOX\\arul:F",
    ]);
  });
});
