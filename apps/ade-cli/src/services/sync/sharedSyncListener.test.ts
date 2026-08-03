import http from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  buildWindowsPortHolderQueryArgs,
  createSharedSyncListener,
  inspectSyncListenerPort,
  parseWindowsPortHolders,
  SYNC_RELAY_BRIDGE_PROOF_HEADER,
} from "./sharedSyncListener";

async function connect(
  port: number,
  path = "/",
  options: { origin?: string; headers?: Record<string, string> } = {},
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    origin: options.origin,
    headers: options.headers,
  });
  await once(ws, "open");
  return ws;
}

async function reject(
  port: number,
  path: string,
  options: { origin?: string; headers?: Record<string, string> } = {},
): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    origin: options.origin,
    headers: options.headers,
  });
  ws.on("error", () => {});
  const [, response] = await once(ws, "unexpected-response");
  response.resume();
  return response.statusCode ?? 0;
}

describe("shared sync listener upgrade policy", () => {
  it("skips duplicate preferred-port retries when a live process owns the port", async () => {
    const holder = http.createServer();
    holder.listen(0, "127.0.0.1");
    await once(holder, "listening");
    const address = holder.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP holder.");
    const logger = { warn: vi.fn() };
    const inspectPort = vi.fn(async (port: number) => ({
      port,
      holders: [{
        pid: 999_999,
        command: "/Applications/ADE.app/Contents/MacOS/ADE",
        startTime: "Fri Aug  1 04:00:00 2026",
      }],
    }));
    const listener = createSharedSyncListener({
      bindHost: "127.0.0.1",
      logger,
      inspectPort,
      activeServicePid: () => null,
    });
    try {
      const port = await listener.ensureListening([address.port, 0]);
      expect(port).not.toBe(address.port);
      expect(inspectPort).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith("sync_listener.bind_port_conflict", expect.objectContaining({
        attemptedPort: address.port,
        holderPids: [999_999],
        retriesSkipped: 7,
      }));
    } finally {
      await listener.close();
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("accepts only the sync root path", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const port = await listener.ensureListening([0]);
    const accepted = await connect(port, "/");
    try {
      expect(accepted.readyState).toBe(WebSocket.OPEN);
      expect(await reject(port, "/anything")).toBe(400);
      expect(await reject(port, "/connect/machine-key")).toBe(400);
    } finally {
      accepted.terminate();
      await listener.close();
    }
  });

  it("accepts the hosted web and local Vite origins", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const port = await listener.ensureListening([0]);
    const sockets: WebSocket[] = [];
    try {
      for (const origin of [
        "https://app.ade-app.dev",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
      ]) {
        const ws = await connect(port, "/", { origin });
        sockets.push(ws);
        expect(ws.readyState).toBe(WebSocket.OPEN);
      }
    } finally {
      for (const ws of sockets) ws.terminate();
      await listener.close();
    }
  });

  it("accepts no-Origin non-browser and relay-bridge clients", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const port = await listener.ensureListening([0]);
    const origins: string[] = [];
    listener.setConnectionHandler((connection) => {
      origins.push(connection.transportOrigin);
    });
    const direct = await connect(port);
    const relay = await connect(port, "/", {
      headers: {
        [SYNC_RELAY_BRIDGE_PROOF_HEADER]: listener.getRelayBridgeProof(),
      },
    });
    expect(direct.readyState).toBe(WebSocket.OPEN);
    expect(relay.readyState).toBe(WebSocket.OPEN);
    expect(origins).toEqual(["direct", "relay-bridge"]);
    direct.terminate();
    relay.terminate();
    await listener.close();
  });

  it("rejects and logs a foreign browser Origin", async () => {
    const logger = { debug: vi.fn() };
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1", logger });
    const port = await listener.ensureListening([0]);
    try {
      expect(await reject(port, "/", { origin: "https://evil.example" })).toBe(401);
      expect(logger.debug).toHaveBeenCalledWith("sync_listener.origin_rejected", {
        origin: "https://evil.example",
      });
      expect(listener.isListening()).toBe(true);
    } finally {
      await listener.close();
    }
  });
});

// `inspectSyncListenerPort` used to shell out to lsof/ps unconditionally. On
// Windows both are absent (or, under Git Bash, present and hostile to the POSIX
// flags), execFileText swallows the failure, and every diagnosis came back with
// an empty `holders`. That silently disabled the stale-port reclaim above and
// left `ade doctor` unable to name the process holding the sync port.
describe("inspectSyncListenerPort on win32", () => {
  const TRUSTED_POWERSHELL = /[\\/]system32[\\/]windowspowershell[\\/]v1\.0[\\/]powershell\.exe$/i;

  it("builds a Get-NetTCPConnection query joined to Win32_Process", () => {
    const args = buildWindowsPortHolderQueryArgs(8787);
    const script = args.join(" ");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(script).toContain("Get-NetTCPConnection -LocalPort 8787 -State Listen");
    expect(script).toContain("OwningProcess");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("CommandLine");
    expect(script).toContain("CreationDate");
    // wmic is deprecated and is being removed from Windows.
    expect(script).not.toMatch(/wmic/i);
  });

  it("refuses to interpolate anything that is not a real port", () => {
    for (const port of [0, -1, 1.5, 70_000, Number.NaN]) {
      expect(() => buildWindowsPortHolderQueryArgs(port)).toThrow(/Invalid port/);
    }
  });

  it("queries the trusted PowerShell instead of lsof, with a workable timeout", async () => {
    const calls: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
    const diagnosis = await inspectSyncListenerPort(8788, {
      platform: "win32",
      exec: async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
        return JSON.stringify([
          { pid: 4242, command: "C:\\ADE\\ade.exe serve", startTime: "2026-08-01T04:00:00.0000000Z" },
        ]);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toMatch(TRUSTED_POWERSHELL);
    expect(calls[0]!.command).not.toBe("lsof");
    // The POSIX budget is 200ms; PowerShell needs seconds to start and load CIM,
    // so reusing it would kill every Windows query before it answered.
    expect(calls[0]!.timeoutMs).toBeGreaterThan(1_000);
    expect(diagnosis).toEqual({
      port: 8788,
      holders: [{
        pid: 4242,
        command: "C:\\ADE\\ade.exe serve",
        startTime: "2026-08-01T04:00:00.0000000Z",
      }],
    });
  });

  it("still uses lsof and ps off win32", async () => {
    const commands: string[] = [];
    await inspectSyncListenerPort(8789, {
      platform: "darwin",
      exec: async (command) => {
        commands.push(command);
        return command === "lsof" ? "p4242\n" : "ade serve\n";
      },
    });
    expect(commands[0]).toBe("lsof");
    expect(commands).toContain("ps");
    expect(commands.some((command) => /powershell/i.test(command))).toBe(false);
  });

  it("reports no holders when the query fails rather than inventing one", async () => {
    expect(await inspectSyncListenerPort(8790, {
      platform: "win32",
      exec: async () => null,
    })).toEqual({ port: 8790, holders: [] });
  });

  it("parses PowerShell holder payloads defensively", () => {
    expect(parseWindowsPortHolders(JSON.stringify([
      { pid: 10, command: "a.exe", startTime: "2026-08-01T04:00:00Z" },
      { pid: 11, command: "b.exe", startTime: "2026-08-01T05:00:00Z" },
    ]))).toEqual([
      { pid: 10, command: "a.exe", startTime: "2026-08-01T04:00:00Z" },
      { pid: 11, command: "b.exe", startTime: "2026-08-01T05:00:00Z" },
    ]);
    // PowerShell 5.1 unwraps a single-element array into a bare object.
    expect(parseWindowsPortHolders(
      JSON.stringify({ pid: 12, command: "c.exe", startTime: "2026-08-01T04:00:00Z" }),
    )).toEqual([{ pid: 12, command: "c.exe", startTime: "2026-08-01T04:00:00Z" }]);
    // Another user's process yields no CommandLine without elevation. Keep the
    // pid: it still proves the port is occupied.
    expect(parseWindowsPortHolders(JSON.stringify([{ pid: 13, command: "", startTime: "" }])))
      .toEqual([{ pid: 13, command: null, startTime: null }]);
    expect(parseWindowsPortHolders(JSON.stringify([{ pid: 14 }, { pid: 14 }]))).toHaveLength(1);
    expect(parseWindowsPortHolders(JSON.stringify([{ pid: 0 }, { pid: -3 }, null, "x"]))).toEqual([]);
    // An empty PowerShell collection prints nothing at all.
    expect(parseWindowsPortHolders("")).toEqual([]);
    expect(parseWindowsPortHolders(null)).toEqual([]);
    expect(parseWindowsPortHolders("not json")).toEqual([]);
  });
});

describe.runIf(process.platform === "win32")("inspectSyncListenerPort against the real Windows host", () => {
  it("names this process as the holder of a port it is listening on", async () => {
    // No mocks: this is the case that shipped broken. Before the win32 branch
    // existed every real Windows diagnosis came back with zero holders.
    const holder = http.createServer();
    holder.listen(0, "127.0.0.1");
    await once(holder, "listening");
    const address = holder.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP holder.");
    try {
      const diagnosis = await inspectSyncListenerPort(address.port);
      expect(diagnosis.port).toBe(address.port);
      const self = diagnosis.holders.find((entry) => entry.pid === process.pid);
      expect(self).toBeDefined();
      // The reclaim path matches on the command line and guards PID reuse with
      // the start time, so neither may be null for a process we own.
      expect(self?.command).toBeTruthy();
      expect(self?.startTime).toBeTruthy();
      expect(Number.isFinite(Date.parse(self!.startTime!))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  }, 30_000);
});
