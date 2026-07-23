import { describe, expect, it } from "vitest";
import {
  compareDoctorVersions,
  doctorRuntimeStatusFromInitialize,
  evaluateDoctorRows,
  type DoctorInput,
} from "./doctor";
import { createSyncAccountDirectoryHealth } from "../../../desktop/src/shared/types/sync";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

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

  it("compares release versions without depending on tag formatting", () => {
    expect(compareDoctorVersions("v1.2.36", "1.2.35")).toBe(1);
    expect(compareDoctorVersions("1.2.35", "v1.2.35")).toBe(0);
    expect(compareDoctorVersions("1.2.34", "1.2.35")).toBe(-1);
    expect(compareDoctorVersions("next", "1.2.35")).toBeNull();
  });
});
