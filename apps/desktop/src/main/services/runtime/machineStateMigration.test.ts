import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import {
  MACHINE_STATE_MIGRATION_MARKER,
  markMachineStateMigrationComplete,
  runMachineStateMigration,
} from "./machineStateMigration";

function makeLayout(root: string): MachineAdeLayout {
  return {
    adeDir: root,
    projectsPath: path.join(root, "projects.json"),
    secretsDir: path.join(root, "secrets"),
    sockDir: path.join(root, "sock"),
    socketPath: path.join(root, "sock", "ade.sock"),
    binDir: path.join(root, "bin"),
    runtimeDir: path.join(root, "runtime"),
  };
}

function makeProject(root: string, name: string): string {
  const projectRoot = path.join(root, name);
  fs.mkdirSync(path.join(projectRoot, ".ade", "secrets"), { recursive: true });
  return projectRoot;
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
    expect(add).toHaveBeenCalledWith(projectA);
    expect(add).toHaveBeenCalledWith(projectB);
    expect(add).not.toHaveBeenCalledWith(missingAdeProject);
    expect(fs.existsSync(path.join(layout.adeDir, MACHINE_STATE_MIGRATION_MARKER))).toBe(false);
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
