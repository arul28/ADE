import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareDoctorVersions,
  doctorRuntimeStatusFromInitialize,
  evaluateDoctorRows,
  parseWindowsDesktopInstallProbe,
  probeDoctorBrain,
  type DoctorInput,
} from "./doctor";
import { createSyncAccountDirectoryHealth } from "../../../desktop/src/shared/types/sync";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

function healthyInput(): DoctorInput {
  return {
    nowMs: NOW,
    app: {
      installedVersion: "1.2.35",
      latestKnownVersion: "1.2.35",
      path: "/Applications/ADE.app",
      online: false,
    },
    brain: {
      running: true,
      version: "1.2.35",
      buildHash: "build",
      pid: 123,
      uptimeMs: 90_000,
      mismatchReason: null,
      error: null,
    },
    wedge: null,
    syncPort: 8787,
    portDiagnoses: [],
    publishHealth: createSyncAccountDirectoryHealth("published", null, {
      lastSuccessAt: NOW - 10_000,
      lastLegDurations: { snapshot: 20, token: 40, http: 80 },
    }),
    relayHealth: {
      enabled: true,
      relayControlConnected: true,
      relayBridgeValidated: true,
      relayEndToEndVerifiedAt: "2026-07-23T11:59:50.000Z",
      relayEndToEndFailure: null,
      lastFailureAt: null,
      skipReason: null,
      lastControlError: null,
      lastControlOpenAt: "2026-07-23T11:59:00.000Z",
      lastBridgeValidationAt: "2026-07-23T11:59:10.000Z",
    },
    account: {
      signedIn: true,
      source: "loopback",
      error: null,
    },
  };
}

describe("doctor row evaluation", () => {
  it("parses Windows installed-product discovery without accepting partial records", () => {
    expect(parseWindowsDesktopInstallProbe(
      '{"version":"1.2.35","path":"C:\\\\Users\\\\dev\\\\AppData\\\\Local\\\\Programs\\\\ADE\\\\ADE.exe"}',
    )).toEqual({
      version: "1.2.35",
      path: "C:\\Users\\dev\\AppData\\Local\\Programs\\ADE\\ADE.exe",
    });
    expect(parseWindowsDesktopInstallProbe('{"version":"1.2.35"}'))
      .toEqual({ version: null, path: null });
    expect(parseWindowsDesktopInstallProbe("not-json"))
      .toEqual({ version: null, path: null });
  });

  it("keeps an initialized brain reachable when later health reads time out", async () => {
    vi.useFakeTimers();
    const never = new Promise<unknown>(() => {});
    const request = vi.fn((method: string) => method === "ade/initialize"
      ? Promise.resolve({
          runtimeInfo: {
            version: "1.2.35",
            buildHash: "build",
            pid: 123,
            uptimeMs: 90_000,
            syncPort: 8787,
          },
        })
      : never);
    const resultPromise = probeDoctorBrain(
      { role: "cto", socketPath: null },
      {
        resolveMachineRuntimeSocketPath: async () => "/tmp/ade.sock",
        connectRuntime: async () => ({ request, destroy: vi.fn() }),
        buildInitializeParams: () => ({}),
        readMachineRuntimeInfo: () => ({
          version: "1.2.35",
          buildHash: "build",
          defaultRole: "cto",
          packageChannel: null,
          projectRoot: null,
          pid: 123,
          uptimeMs: 90_000,
        }),
        resolveExpectedMachineRuntimeBuildHash: async () => "build",
        machineRuntimeMismatchReason: () => null,
        unwrapActionEnvelope: (value) => value,
      },
    );

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;

    expect(result.brain).toMatchObject({
      running: true,
      version: "1.2.35",
      pid: 123,
      error: null,
    });
    expect(result.runtimeSyncPort).toBe(8787);
    expect(result.syncStatus).toBeNull();
    expect(result.account).toMatchObject({
      signedIn: null,
      error: "ADE brain health reads timed out.",
    });
  });

  it("parses the complete runtime publish and wedge health envelope", () => {
    expect(doctorRuntimeStatusFromInitialize({
      runtimeInfo: {
        syncPort: 8789,
        publishHealth: {
          state: " published ",
          failingSinceMs: -1,
          lastLegDurations: {
            snapshot: 12.4,
            token: 34.6,
            http: -1,
          },
          lastSuccessAt: 123_456.5,
          skipReason: " signed out ",
        },
        lastWedge: {
          lastCommand: " chat.send ",
          blockedMs: 16_500.8,
          ts: " 2026-07-23T12:00:00.000Z ",
        },
      },
    })).toEqual({
      syncPort: 8789,
      publishHealth: {
        state: "published",
        failingSinceMs: 0,
        lastLegDurations: {
          snapshot: 12,
          token: 35,
          http: null,
        },
        lastSuccessAt: 123_456.5,
        skipReason: "signed out",
      },
      lastWedge: {
        lastCommand: "chat.send",
        blockedMs: 16_500,
        ts: "2026-07-23T12:00:00.000Z",
      },
    });
  });

  it("marks a healthy machine with no red rows", () => {
    const rows = evaluateDoctorRows(healthyInput());

    expect(rows.map((row) => [row.key, row.status])).toEqual([
      ["app", "ok"],
      ["brain", "ok"],
      ["wedge", "ok"],
      ["sync_port", "ok"],
      ["publish", "ok"],
      ["relay", "ok"],
      ["account", "ok"],
    ]);
  });

  it("warns for a recent wedge and alternate port with diagnosed holders", () => {
    const input = healthyInput();
    input.wedge = {
      lastCommand: "chat.send",
      blockedMs: 16_500,
      ts: new Date(NOW - 60_000).toISOString(),
    };
    input.syncPort = 8789;
    input.portDiagnoses = [{
      port: 8787,
      holders: [{ pid: 456, command: "old ade serve", startTime: null }],
    }];

    const rows = evaluateDoctorRows(input);

    expect(rows.find((row) => row.key === "wedge")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("chat.send"),
    });
    expect(rows.find((row) => row.key === "sync_port")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("8787: pid 456"),
    });
  });

  it("fails a mismatched brain and a publish episode over two minutes", () => {
    const input = healthyInput();
    input.brain.mismatchReason = "build hash changed";
    input.publishHealth = createSyncAccountDirectoryHealth("http_timeout", "timed out", {
      failingSinceMs: NOW - 5 * 60_000,
      lastLegDurations: { snapshot: 12, token: 80, http: 9_200 },
    });

    const rows = evaluateDoctorRows(input);

    expect(rows.find((row) => row.key === "brain")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("build hash changed"),
    });
    expect(rows.find((row) => row.key === "publish")).toEqual(expect.objectContaining({
      status: "fail",
      detail: expect.stringMatching(/failing for 5m .* slow leg: http \(9\.2s\)/),
    }));
    // Only the brain-session states get the restart remedy; a slow HTTP leg is
    // not fixed by restarting.
    expect(rows.find((row) => row.key === "publish")?.detail).not.toContain("ade brain restart");
  });

  it("points an unreadable account session at `ade brain restart`", () => {
    // Desktop's Connections panel shows a Repair (brain restart) button for
    // this state; the CLI has to name the same remedy or an agent is stuck.
    const warning = healthyInput();
    warning.publishHealth = createSyncAccountDirectoryHealth("token_unreadable", null, {
      failingSinceMs: NOW - 30_000,
    });
    const failing = healthyInput();
    failing.publishHealth = createSyncAccountDirectoryHealth("token_unreadable", null, {
      failingSinceMs: NOW - 5 * 60_000,
    });

    expect(evaluateDoctorRows(warning).find((row) => row.key === "publish")).toEqual(
      expect.objectContaining({
        status: "warn",
        detail: expect.stringContaining("ade brain restart"),
      }),
    );
    expect(evaluateDoctorRows(failing).find((row) => row.key === "publish")).toEqual(
      expect.objectContaining({
        status: "fail",
        detail: expect.stringContaining("ade brain restart"),
      }),
    );
  });

  it("fails only the brain while dependent checks degrade when the socket is dead", () => {
    const input = healthyInput();
    input.brain = {
      running: false,
      version: null,
      buildHash: null,
      pid: null,
      uptimeMs: null,
      mismatchReason: null,
      error: "Timed out waiting for ade/initialize.",
    };
    input.syncPort = null;
    input.publishHealth = null;
    input.relayHealth = null;
    input.account = { signedIn: null, source: null, error: "brain unavailable" };

    const rows = evaluateDoctorRows(input);

    expect(rows.filter((row) => row.status === "fail").map((row) => row.key)).toEqual(["brain"]);
  });

  it("names the rival ADE process when relay control is suppressed", () => {
    const input = healthyInput();
    input.relayHealth = {
      ...input.relayHealth!,
      relayControlConnected: false,
      relayControlSuppressed: true,
      relayControlSuppressedReason: "Another ADE process owns the relay connection for this machine.",
      // A stale bridge/control error must not outrank the actionable reason:
      // total relay failure was previously invisible everywhere but here.
      lastControlError: "Relay control closed (4505): replaced by newer host",
    };

    const relay = evaluateDoctorRows(input).find((row) => row.key === "relay");

    expect(relay?.status).toBe("fail");
    expect(relay?.detail).toBe(
      "Another ADE process owns the relay connection for this machine.",
    );
  });

  it("compares release versions without depending on tag formatting", () => {
    expect(compareDoctorVersions("v1.2.36", "1.2.35")).toBe(1);
    expect(compareDoctorVersions("1.2.35", "v1.2.35")).toBe(0);
    expect(compareDoctorVersions("1.2.34", "1.2.35")).toBe(-1);
    expect(compareDoctorVersions("next", "1.2.35")).toBeNull();
  });
});
