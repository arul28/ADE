import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareDoctorVersions,
  doctorRuntimeStatusFromInitialize,
  evaluateDoctorRows,
  parseWindowsDesktopInstallProbe,
  probeDoctorBrain,
  readAutoDiagnosticsSharingForDoctor,
  readStorageEnvironmentForDoctor,
  type DoctorInput,
} from "./doctor";
import type {
  StorageEnvironment,
  StorageEnvironmentRoot,
} from "../services/diagnostics/storageEnvironmentProbe";
import type { MachineAdeLayout } from "../services/projects/machineLayout";
import { createSyncAccountDirectoryHealth } from "../../../desktop/src/shared/types/sync";
import { PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE } from "../services/account/accountMachinePublisherService";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

function storageRoot(
  overrides: Partial<StorageEnvironmentRoot> & { label: string },
): StorageEnvironmentRoot {
  return {
    location: "local",
    sampledFiles: 120,
    datalessFiles: 0,
    sampleTruncated: false,
    ...overrides,
  };
}

function storageEnvironment(overrides: {
  roots: StorageEnvironmentRoot[];
  materializeDatalessFiles?: boolean | null;
}): StorageEnvironment {
  return {
    roots: overrides.roots,
    process: {
      platform: "darwin",
      processType: "cli",
      launchdManaged: true,
      materializeDatalessFiles: overrides.materializeDatalessFiles ?? null,
    },
    limitations: [],
  };
}

function healthyInput(): DoctorInput {
  return {
    nowMs: NOW,
    app: {
      installedVersion: "1.2.35",
      latestKnownVersion: "1.2.35",
      path: "/Applications/ADE.app",
      online: false,
    },
    cli: {
      path: "/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade",
      version: "1.2.35",
      adeHome: "/Users/tester/.ade",
      adeHomeReason: "default",
      hasPluginDomain: true,
      chatSessionId: null,
      sessionCliPath: null,
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
    credentials: {
      path: "/Users/tester/.ade/secrets/credentials.json.enc",
      exists: true,
      state: "available",
      reason: null,
      sealedBinding: "machine",
      declaredBinding: "machine",
      quarantine: null,
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
      ["cli", "ok"],
      ["brain", "ok"],
      ["wedge", "ok"],
      ["sync_port", "ok"],
      ["publish", "ok"],
      ["relay", "ok"],
      ["account", "ok"],
      ["credentials", "ok"],
      ["storage", "ok"],
      ["diagnostics", "ok"],
    ]);
  });

  it("reports a young registered brain as starting, and a dead one as failing", () => {
    const starting = healthyInput();
    starting.brain = {
      ...starting.brain,
      running: false,
      error: "connect ENOENT /tmp/ade.sock",
      starting: true,
      startingAgeMs: 12_000,
    };
    const startingRow = evaluateDoctorRows(starting).find((row) => row.key === "brain");
    expect(startingRow?.status).toBe("warn");
    expect(startingRow?.detail).toContain("starting");
    expect(startingRow?.detail).not.toContain("connect ENOENT");

    const dead = healthyInput();
    dead.brain = {
      ...dead.brain,
      running: false,
      error: "connect ENOENT /tmp/ade.sock",
      starting: false,
    };
    const deadRow = evaluateDoctorRows(dead).find((row) => row.key === "brain");
    expect(deadRow?.status).toBe("fail");
    expect(deadRow?.detail).toContain("not responding");
  });

  it("names the credential store's two bad states with the right next step", () => {
    const lockedOut = healthyInput();
    lockedOut.credentials = {
      ...lockedOut.credentials!,
      state: "unreadable",
      reason: "no_os_key_material",
      sealedBinding: null,
      declaredBinding: "os",
    };
    const lockedRow = evaluateDoctorRows(lockedOut).find((row) => row.key === "credentials");
    expect(lockedRow?.status).toBe("fail");
    expect(lockedRow?.detail).toContain("open the ADE app");

    const corrupt = healthyInput();
    corrupt.credentials = {
      ...corrupt.credentials!,
      state: "unreadable",
      reason: "decrypt_failure",
      sealedBinding: null,
    };
    const corruptRow = evaluateDoctorRows(corrupt).find((row) => row.key === "credentials");
    expect(corruptRow?.status).toBe("fail");
    expect(corruptRow?.detail).toContain("sign in again");

    const quarantined = healthyInput();
    quarantined.credentials = {
      ...quarantined.credentials!,
      quarantine: {
        version: 1,
        at: "2026-07-23T11:00:00.000Z",
        file: "credentials.json.enc.quarantined-2026-07-23T11-00-00-000Z",
        reason: "no_os_key_material",
        recoverable: true,
      },
    };
    const quarantinedRow = evaluateDoctorRows(quarantined).find((row) => row.key === "credentials");
    expect(quarantinedRow?.status).toBe("warn");
    expect(quarantinedRow?.detail).toContain("open the ADE app");
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

  it("says the external watchdog stopped the brain rather than naming it as the blocker", () => {
    const input = healthyInput();
    // The external checker leaves the same breadcrumb the in-process loop
    // watchdog does, so `lastCommand` is the watchdog itself here.
    input.wedge = {
      lastCommand: "external-watchdog",
      blockedMs: 120_000,
      ts: new Date(NOW - 60_000).toISOString(),
    };

    const wedge = evaluateDoctorRows(input).find((row) => row.key === "wedge");

    expect(wedge).toMatchObject({ status: "warn" });
    expect(wedge?.detail).toContain("stopped by the watchdog");
    expect(wedge?.detail).toContain("no heartbeat");
    expect(wedge?.detail).not.toContain("external-watchdog blocked");
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

  it("keeps the directory refusal sentence on a long-failing publish row", () => {
    // A refused machine is terminal, so by the time anyone runs doctor it is
    // always in the ≥2min branch — the one that used to print the bare state.
    const input = healthyInput();
    input.publishHealth = createSyncAccountDirectoryHealth(
      "http_error",
      PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE,
      { failingSinceMs: NOW - 6 * 60_000, lastHttpStatus: 403 },
    );

    const publish = evaluateDoctorRows(input).find((row) => row.key === "publish");

    expect(publish?.status).toBe("fail");
    expect(publish?.detail).toContain(PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE);
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

  it("reports the needs-reconnect reason over a stale relay self-probe failure", () => {
    const input = healthyInput();
    input.relayHealth = {
      ...input.relayHealth!,
      relayControlConnected: false,
      relayBridgeValidated: false,
      relayEndToEndVerifiedAt: null,
      // Kept across control generations by the tunnel client, so a machine that
      // is now capped still reports whatever its last probe said.
      relayEndToEndFailure: "Relay self-probe skipped because the control socket is not connected.",
      // What the brain ranks into skipReason once the rotation budget is spent.
      skipReason: "This computer needs to be reconnected to your ADE account.",
      lastControlError: "claim failed (409)",
    };

    const relay = evaluateDoctorRows(input).find((row) => row.key === "relay");

    expect(relay?.status).toBe("fail");
    expect(relay?.detail).toBe("This computer needs to be reconnected to your ADE account.");
  });

  it("still reports a self-probe failure while relay control is connected", () => {
    const input = healthyInput();
    input.relayHealth = {
      ...input.relayHealth!,
      relayEndToEndVerifiedAt: null,
      relayEndToEndFailure: "Relay echo never came back.",
    };

    const relay = evaluateDoctorRows(input).find((row) => row.key === "relay");

    expect(relay?.status).toBe("fail");
    expect(relay?.detail).toBe("Relay echo never came back.");
  });

  it("states diagnostics sharing as a preference, never as a problem", () => {
    const on = healthyInput();
    on.diagnostics = { enabled: true, sendsInWindow: 1, limit: 3 };
    const off = healthyInput();
    off.diagnostics = { enabled: false, sendsInWindow: 0, limit: 3 };

    expect(evaluateDoctorRows(on).find((row) => row.key === "diagnostics")).toEqual({
      key: "diagnostics",
      label: "Diagnostics sharing",
      status: "ok",
      detail: "on · 1 of 3 automatic reports sent today",
    });
    // "Off" is a choice the user made, so it stays green: a diagnostic that
    // paints a respected preference yellow trains people to ignore the colour.
    expect(evaluateDoctorRows(off).find((row) => row.key === "diagnostics")).toEqual({
      key: "diagnostics",
      label: "Diagnostics sharing",
      status: "ok",
      detail: "off · no automatic reports are sent",
    });
    // Omitted by a caller that did not read the ledger: say so, do not guess.
    expect(evaluateDoctorRows(healthyInput()).find((row) => row.key === "diagnostics"))
      .toMatchObject({ status: "ok", detail: "not checked" });
  });

  it("reads diagnostics sharing off the shared ledger, defaulting on when it is absent or unreadable", () => {
    const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-doctor-diagnostics-"));
    try {
      const statePath = path.join(adeDir, "secrets", "diagnostics-autosend.json");
      fs.mkdirSync(path.dirname(statePath), { recursive: true });

      // Never auto-sent: the setting is on and the budget is untouched.
      expect(readAutoDiagnosticsSharingForDoctor(adeDir, {})).toEqual({
        enabled: true,
        sendsInWindow: 0,
        limit: 3,
      });

      fs.writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          enabled: false,
          sends: [{ code: "brain_wedge", atMs: Date.now(), source: "brain", pending: false }],
        }),
      );
      expect(readAutoDiagnosticsSharingForDoctor(adeDir, {})).toMatchObject({
        enabled: false,
        sendsInWindow: 1,
      });

      // Unreadable is reported as the default the next auto-send would act on,
      // rather than as a failure of the machine's health.
      fs.rmSync(statePath);
      fs.writeFileSync(statePath, "{ not json");
      expect(readAutoDiagnosticsSharingForDoctor(adeDir, {})).toEqual({
        enabled: true,
        sendsInWindow: 0,
        limit: 3,
      });
    } finally {
      fs.rmSync(adeDir, { recursive: true, force: true });
    }
  });

  it("reports evicted cloud files, and calls a denied download policy the failure it is", () => {
    // The outage this row exists for: the project is in iCloud Drive, its files
    // have been evicted, and the launch agent this machine runs predates the
    // key that lets the background service fetch them back.
    const denied = healthyInput();
    denied.storage = storageEnvironment({
      roots: [
        storageRoot({ label: "ADE home" }),
        storageRoot({
          label: "Project",
          location: "icloud",
          sampledFiles: 120,
          datalessFiles: 47,
        }),
      ],
      materializeDatalessFiles: false,
    });
    const deniedRow = evaluateDoctorRows(denied).find((row) => row.key === "storage");
    expect(deniedRow?.status).toBe("fail");
    expect(deniedRow?.detail).toContain("Project: 47 of 120 sampled files are not downloaded (icloud)");
    expect(deniedRow?.detail).toContain("ade runtime install-service");

    // The same evicted files with the policy granted are a provider taking its
    // time, not a machine that cannot read its own data.
    const allowed = healthyInput();
    allowed.storage = storageEnvironment({
      roots: [
        storageRoot({ label: "ADE home" }),
        storageRoot({
          label: "Project",
          location: "icloud",
          sampledFiles: 120,
          datalessFiles: 47,
        }),
      ],
      materializeDatalessFiles: true,
    });
    const allowedRow = evaluateDoctorRows(allowed).find((row) => row.key === "storage");
    expect(allowedRow?.status).toBe("warn");
    expect(allowedRow?.detail).not.toContain("ade runtime install-service");
  });

  it("keeps a denied download policy quiet unless this machine has bytes in the cloud", () => {
    // Every machine that has not reinstalled its service since the key shipped
    // reads as denied. On local disks that costs the user nothing, and a row
    // that is yellow everywhere is a row nobody reads.
    const local = healthyInput();
    local.storage = storageEnvironment({
      roots: [storageRoot({ label: "ADE home" }), storageRoot({ label: "Project" })],
      materializeDatalessFiles: false,
    });
    expect(evaluateDoctorRows(local).find((row) => row.key === "storage")).toEqual({
      key: "storage",
      label: "Storage",
      status: "ok",
      detail: "ADE home: local · Project: local",
    });

    // Nothing is missing yet, but the next eviction lands on a service that may
    // not fetch it back, and the fix is the same one.
    const cloud = healthyInput();
    cloud.storage = storageEnvironment({
      roots: [
        storageRoot({ label: "ADE home" }),
        storageRoot({ label: "Project", location: "dropbox" }),
      ],
      materializeDatalessFiles: false,
    });
    const cloudRow = evaluateDoctorRows(cloud).find((row) => row.key === "storage");
    expect(cloudRow?.status).toBe("warn");
    expect(cloudRow?.detail).toContain("Project on cloud storage");
  });

  it("fails the storage row when a root could not be read, and says nothing when it was not checked", () => {
    const unreadable = healthyInput();
    unreadable.storage = storageEnvironment({
      roots: [
        storageRoot({ label: "ADE home" }),
        storageRoot({ label: "Project", error: "(could not be read)" }),
      ],
    });
    expect(evaluateDoctorRows(unreadable).find((row) => row.key === "storage")).toMatchObject({
      status: "fail",
      detail: "Project could not be read",
    });

    expect(evaluateDoctorRows(healthyInput()).find((row) => row.key === "storage"))
      .toMatchObject({ status: "ok", detail: "not checked" });
  });

  it("samples the ADE home and the last project this machine opened", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-doctor-storage-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "ade-doctor-storage-project-"));
    try {
      fs.mkdirSync(path.join(project, ".ade"), { recursive: true });
      fs.writeFileSync(path.join(project, "README.md"), "hello");
      fs.writeFileSync(path.join(home, "machine.json"), "{}");
      const projectsPath = path.join(home, "projects.json");
      fs.writeFileSync(
        projectsPath,
        JSON.stringify({ projects: [{ rootPath: project, lastOpenedAt: Date.now() }] }),
      );

      const environment = await readStorageEnvironmentForDoctor(
        { adeDir: home, projectsPath } as MachineAdeLayout,
        {},
        "linux",
      );
      expect(environment?.roots.map((root) => root.label)).toEqual(["ADE home", "Project"]);
      // Both roots were really walked, and neither reported a path.
      expect(environment?.roots[1]?.sampledFiles).toBeGreaterThan(0);
      expect(JSON.stringify(environment)).not.toContain(project);
      // Off darwin there is no launch agent and no policy to read.
      expect(environment?.process.materializeDatalessFiles).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("compares release versions without depending on tag formatting", () => {
    expect(compareDoctorVersions("v1.2.36", "1.2.35")).toBe(1);
    expect(compareDoctorVersions("1.2.35", "v1.2.35")).toBe(0);
    expect(compareDoctorVersions("1.2.34", "1.2.35")).toBe(-1);
    expect(compareDoctorVersions("next", "1.2.35")).toBeNull();
  });
});

/**
 * The CLI row: which `ade` answered, and whether it is this chat's `ade`.
 *
 * The row exists because an agent could not tell. Its PATH `ade` was stable
 * ADE 1.2.64 while its chat ran in ADE Alpha, so `ade plugin list` failed and
 * the agent told the user they were not on Alpha — with the Alpha window open
 * in front of them (docs/reports/ade-plugins-agent-diagnostic-2026-08-26.md §1).
 */
describe("doctor CLI row", () => {
  const cliRowOf = (cli: Partial<DoctorInput["cli"]>) => {
    const input = healthyInput();
    input.cli = { ...input.cli, ...cli };
    const row = evaluateDoctorRows(input).find((entry) => entry.key === "cli");
    if (!row) throw new Error("no cli row");
    return row;
  };

  it("prints the binary, the version, the home and whether plugins are here", () => {
    const row = cliRowOf({});
    expect(row.status).toBe("ok");
    expect(row.detail).toContain("/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade");
    expect(row.detail).toContain("version 1.2.35");
    expect(row.detail).toContain("ADE_HOME /Users/tester/.ade (default, $ADE_HOME unset)");
    expect(row.detail).toContain("plugin commands: yes");
  });

  it("names the signal each machine home came from", () => {
    expect(cliRowOf({ adeHomeReason: "env" }).detail).toContain(
      "ADE_HOME /Users/tester/.ade (from $ADE_HOME)",
    );
    expect(
      cliRowOf({
        adeHome: "/Users/tester/.ade-alpha",
        adeHomeReason: "channel-env",
        adeHomeDetail: "$ADE_PACKAGE_CHANNEL=alpha",
      }).detail,
    ).toContain("ADE_HOME /Users/tester/.ade-alpha (from $ADE_PACKAGE_CHANNEL=alpha)");
    expect(
      cliRowOf({
        path: "/Applications/ADE Alpha.app/Contents/Resources/ade-cli/bin/ade",
        adeHome: "/Users/tester/.ade-alpha",
        adeHomeReason: "bundle",
        adeHomeDetail: "ADE Alpha.app",
      }).detail,
    ).toContain("ADE_HOME /Users/tester/.ade-alpha (derived from ADE Alpha.app)");
  });

  /**
   * The bug this row could not see: an Alpha chat's injected `ade` lost
   * ADE_HOME on the way to the runtime worker, so an Alpha binary read the
   * stable machine. The bundle comparison below stayed happy — both CLIs were
   * Alpha's — and the wrong home sailed through as "ok".
   */
  it("WARNS when a channel app's CLI defaulted to the stable machine home", () => {
    const row = cliRowOf({
      path: "/Applications/ADE Alpha.app/Contents/Resources/ade-cli/bin/ade",
      adeHome: "/Users/tester/.ade",
      adeHomeReason: "default",
      chatSessionId: "bbca6866-ffc5-4d8a-9d04-8073f2e92cb6",
      sessionCliPath: "/Applications/ADE Alpha.app/Contents/Resources/ade-cli/bin/ade",
    });
    expect(row.status).toBe("warn");
    expect(row.detail).toContain("/Applications/ADE Alpha.app");
    expect(row.detail).toContain("reading the stable machine");
    // Actionable: the reader is told what to change, not just what is wrong.
    expect(row.detail).toContain("set ADE_HOME");
  });

  it("WARNS when the running binary belongs to a different app than this chat", () => {
    const row = cliRowOf({
      chatSessionId: "bbca6866-ffc5-4d8a-9d04-8073f2e92cb6",
      sessionCliPath: "/Applications/ADE Alpha.app/Contents/Resources/ade-cli/bin/ade",
    });
    expect(row.status).toBe("warn");
    expect(row.detail).toContain("/Applications/ADE Alpha.app");
    // Actionable: the reader is handed the binary to run, not just the problem.
    expect(row.detail).toContain("/Applications/ADE Alpha.app/Contents/Resources/ade-cli/bin/ade");
  });

  it("says the two agree when they are the same app bundle", () => {
    // The shim in ADE_HOME and the binary in the bundle are the same app, so a
    // file-by-file comparison would cry wolf on every ordinary session.
    const row = cliRowOf({
      chatSessionId: "chat-1",
      sessionCliPath: "/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade",
    });
    expect(row.status).toBe("ok");
    expect(row.detail).toContain("matches this chat's app");
  });

  it("stays quiet outside a chat, and says so when the app named no CLI", () => {
    expect(cliRowOf({}).detail).not.toContain("chat");
    const older = cliRowOf({ chatSessionId: "chat-1", sessionCliPath: null });
    expect(older.status).toBe("ok");
    expect(older.detail).toContain("did not name its own CLI");
  });
});
