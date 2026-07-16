import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import {
  MACHINE_STATE_MIGRATION_MARKER,
  markMachineStateMigrationComplete,
  readMachineRegistryRecentProjects,
  runMachineStateMigration,
} from "./machineStateMigration";
import {
  MACHINE_TRUST_RESET_MARKER,
  MACHINE_TRUST_RESET_PENDING_MARKER,
  markMachineTrustResetComplete,
  runMachineTrustResetMigration,
} from "./machineTrustResetMigration";

function makeLayout(root: string): MachineAdeLayout {
  return {
    adeDir: root,
    projectsPath: path.join(root, "projects.json"),
    secretsDir: path.join(root, "secrets"),
    sockDir: path.join(root, "sock"),
    socketPath: path.join(root, "sock", "ade.sock"),
    desktopBridgeSocketPath: path.join(root, "sock", "desktop-bridge.sock"),
    binDir: path.join(root, "bin"),
    runtimeDir: path.join(root, "runtime"),
  };
}

function makeProject(root: string, name: string): string {
  const projectRoot = path.join(root, name);
  fs.mkdirSync(path.join(projectRoot, ".ade", "secrets"), { recursive: true });
  return fs.realpathSync.native(projectRoot);
}

describe("machine state migration", () => {
  it("skips work when the migration marker already exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-migration-"));
    const layout = makeLayout(path.join(root, ".ade-home"));
    fs.mkdirSync(layout.adeDir, { recursive: true });
    fs.writeFileSync(path.join(layout.adeDir, MACHINE_STATE_MIGRATION_MARKER), "done\n", "utf8");
    const add = vi.fn();

    const result = runMachineStateMigration({
      layout,
      recentProjects: [{ rootPath: "/missing", displayName: "Missing", lastOpenedAt: "2026-05-10T00:00:00.000Z" }],
      projectRegistry: { add },
    });

    expect(result).toMatchObject({ didRun: false, shouldShowNotice: false });
    expect(add).not.toHaveBeenCalled();
  });

  it("merges legacy sync secrets and registers valid recent projects", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-migration-"));
    const layout = makeLayout(path.join(root, ".ade-home"));
    fs.mkdirSync(layout.secretsDir, { recursive: true });
    fs.writeFileSync(
      path.join(layout.secretsDir, "sync-paired-devices.json"),
      `${JSON.stringify({ existing: { name: "Machine" } })}\n`,
      "utf8",
    );
    const projectA = makeProject(root, "project-a");
    const projectB = makeProject(root, "project-b");
    const missingAdeProject = path.join(root, "missing-ade");
    fs.mkdirSync(missingAdeProject, { recursive: true });
    fs.writeFileSync(path.join(projectA, ".ade", "secrets", "sync-bootstrap-token"), "token-a", "utf8");
    fs.writeFileSync(path.join(projectB, ".ade", "secrets", "sync-bootstrap-token"), "token-b", "utf8");
    fs.writeFileSync(path.join(projectB, ".ade", "secrets", "sync-pin.json"), "{\"pin\":\"123456\"}", "utf8");
    fs.writeFileSync(
      path.join(projectA, ".ade", "secrets", "sync-paired-devices.json"),
      `${JSON.stringify({ existing: { name: "Legacy" }, phoneA: { name: "Phone A" } })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectB, ".ade", "secrets", "sync-paired-devices.json"),
      `${JSON.stringify({ phoneB: { name: "Phone B" } })}\n`,
      "utf8",
    );
    const add = vi.fn();

    const result = runMachineStateMigration({
      layout,
      recentProjects: [
        { rootPath: projectA, displayName: "A", lastOpenedAt: "2026-05-10T00:00:00.000Z" },
        { rootPath: projectB, displayName: "B", lastOpenedAt: "2026-05-10T00:00:01.000Z" },
        { rootPath: missingAdeProject, displayName: "Missing", lastOpenedAt: "2026-05-10T00:00:02.000Z" },
      ],
      projectRegistry: { add },
    });

    expect(result).toMatchObject({ didRun: true, shouldShowNotice: true });
    expect(fs.readFileSync(path.join(layout.secretsDir, "sync-bootstrap-token"), "utf8")).toBe("token-a");
    expect(fs.readFileSync(path.join(layout.secretsDir, "sync-pin.json"), "utf8")).toBe("{\"pin\":\"123456\"}");
    expect(JSON.parse(fs.readFileSync(path.join(layout.secretsDir, "sync-paired-devices.json"), "utf8"))).toEqual({
      existing: { name: "Machine" },
      phoneA: { name: "Phone A" },
      phoneB: { name: "Phone B" },
    });
    expect(add).toHaveBeenCalledWith(projectA, {
      catalogVisibility: "system",
      registrationSource: "runtime-auto",
    });
    expect(add).toHaveBeenCalledWith(projectB, {
      catalogVisibility: "system",
      registrationSource: "runtime-auto",
    });
    expect(add).not.toHaveBeenCalledWith(missingAdeProject);
    expect(fs.existsSync(path.join(layout.adeDir, MACHINE_STATE_MIGRATION_MARKER))).toBe(false);
  });

  it("seeds channel registries from stable machine projects", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-migration-"));
    const stableLayout = makeLayout(path.join(root, ".ade"));
    const alphaLayout = makeLayout(path.join(root, ".ade-alpha"));
    const projectA = makeProject(root, "project-a");
    const projectB = makeProject(root, "project-b");
    fs.mkdirSync(path.join(projectA, ".git"));
    fs.mkdirSync(path.join(projectB, ".git"));
    fs.mkdirSync(stableLayout.adeDir, { recursive: true });
    fs.writeFileSync(
      stableLayout.projectsPath,
      `${JSON.stringify({
        version: 1,
        projects: [
          {
            projectId: "project_a",
            rootPath: projectA,
            displayName: "Project A",
            addedAt: Date.parse("2026-05-10T00:00:00.000Z"),
            lastOpenedAt: Date.parse("2026-05-10T00:00:00.000Z"),
          },
          {
            projectId: "project_b",
            rootPath: projectB,
            displayName: "Project B",
            addedAt: Date.parse("2026-05-10T00:00:01.000Z"),
            lastOpenedAt: Date.parse("2026-05-10T00:00:01.000Z"),
          },
        ],
      })}\n`,
      "utf8",
    );
    const add = vi.fn();

    const result = runMachineStateMigration({
      layout: alphaLayout,
      recentProjects: [],
      projectRegistry: { add },
    });

    expect(result).toMatchObject({ didRun: true, shouldShowNotice: true });
    expect(add).toHaveBeenCalledWith(projectA, {
      catalogVisibility: "system",
      registrationSource: "runtime-auto",
    });
    expect(add).toHaveBeenCalledWith(projectB, {
      catalogVisibility: "system",
      registrationSource: "runtime-auto",
    });
  });

  it("exposes machine registry projects as startup recents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-migration-"));
    const layout = makeLayout(path.join(root, ".ade"));
    const projectRoot = makeProject(root, "project-a");
    fs.mkdirSync(path.join(projectRoot, ".git"));
    fs.mkdirSync(layout.adeDir, { recursive: true });
    fs.writeFileSync(
      layout.projectsPath,
      `${JSON.stringify({
        version: 1,
        projects: [
          {
            projectId: "project_a",
            rootPath: projectRoot,
            displayName: "Project A",
            addedAt: Date.parse("2026-05-10T00:00:00.000Z"),
            lastOpenedAt: Date.parse("2026-05-10T00:00:00.000Z"),
          },
        ],
      })}\n`,
      "utf8",
    );

    expect(readMachineRegistryRecentProjects(layout)).toEqual([
      {
        rootPath: projectRoot,
        displayName: "Project A",
        lastOpenedAt: "2026-05-10T00:00:00.000Z",
      },
    ]);
  });

  it("marks migration complete only when explicitly requested", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-migration-"));
    const layout = makeLayout(path.join(root, ".ade-home"));

    markMachineStateMigrationComplete({
      layout,
      completedAt: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(fs.readFileSync(path.join(layout.adeDir, MACHINE_STATE_MIGRATION_MARKER), "utf8")).toBe(
      "2026-05-10T12:00:00.000Z\n",
    );
  });

  it("treats malformed legacy pairing files as empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-migration-"));
    const layout = makeLayout(path.join(root, ".ade-home"));
    const projectRoot = makeProject(root, "project-a");
    fs.writeFileSync(path.join(projectRoot, ".ade", "secrets", "sync-paired-devices.json"), "{not-json", "utf8");

    expect(() =>
      runMachineStateMigration({
        layout,
        recentProjects: [{ rootPath: projectRoot, displayName: "A", lastOpenedAt: "2026-05-10T00:00:00.000Z" }],
        projectRegistry: { add: vi.fn() },
      })
    ).not.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(layout.secretsDir, "sync-paired-devices.json"), "utf8"))).toEqual({});
  });
});

describe("machine trust reset migration", () => {
  it("clears only saved machine trust and preserves identity, account, PIN, and projects", () => {
    const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-trust-reset-"));
    const secretsDir = path.join(adeDir, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    for (const fileName of [
      "remote-machines.json",
      "desktop-paired-machines.json",
      "sync-paired-devices.json",
      "sync-paired-devices.json.runtime-host-grants",
    ]) {
      fs.writeFileSync(path.join(secretsDir, fileName), "{}\n", "utf8");
    }
    for (const fileName of [
      "account-session.v1.enc",
      "machine-identity.json",
      "machine-key.json",
      "sync-pin.json",
      "sync-bootstrap-token",
    ]) {
      fs.writeFileSync(path.join(secretsDir, fileName), `${fileName}\n`, "utf8");
    }
    fs.writeFileSync(path.join(adeDir, "projects.json"), "[]\n", "utf8");

    const result = runMachineTrustResetMigration({ adeDir, secretsDir });

    expect(result.didRun).toBe(true);
    expect(result.removedFiles).toEqual([
      "remote-machines.json",
      "desktop-paired-machines.json",
      "sync-paired-devices.json",
      "sync-paired-devices.json.runtime-host-grants",
    ]);
    expect(result.restartRequired).toBe(true);
    expect(fs.existsSync(path.join(adeDir, MACHINE_TRUST_RESET_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(adeDir, MACHINE_TRUST_RESET_PENDING_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(adeDir, "projects.json"))).toBe(true);
    expect(fs.readdirSync(secretsDir).sort()).toEqual([
      "account-session.v1.enc",
      "machine-identity.json",
      "machine-key.json",
      "sync-bootstrap-token",
      "sync-pin.json",
    ]);
  });

  it("keeps restart pending across relaunch until service restart is confirmed", () => {
    const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-trust-reset-"));
    const secretsDir = path.join(adeDir, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });

    expect(runMachineTrustResetMigration({ adeDir, secretsDir })).toMatchObject({
      didRun: true,
      restartRequired: true,
    });
    fs.writeFileSync(path.join(secretsDir, "remote-machines.json"), "{}\n", "utf8");

    expect(runMachineTrustResetMigration({ adeDir, secretsDir })).toMatchObject({
      didRun: false,
      restartRequired: true,
      removedFiles: [],
    });
    expect(fs.existsSync(path.join(adeDir, MACHINE_TRUST_RESET_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(secretsDir, "remote-machines.json"))).toBe(true);

    markMachineTrustResetComplete({ adeDir });

    expect(fs.existsSync(path.join(adeDir, MACHINE_TRUST_RESET_PENDING_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(adeDir, MACHINE_TRUST_RESET_MARKER))).toBe(true);
    expect(runMachineTrustResetMigration({ adeDir, secretsDir })).toMatchObject({
      didRun: false,
      restartRequired: false,
      removedFiles: [],
    });
    expect(fs.existsSync(path.join(secretsDir, "remote-machines.json"))).toBe(true);
  });
});
