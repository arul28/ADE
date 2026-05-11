import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectRegistry,
  deriveProjectId,
  isDisallowedProjectRoot,
} from "./projectRegistry";

const tempRoots = new Set<string>();

function makeTempRoot(prefix = "ade-project-registry-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("ProjectRegistry", () => {
  it("rejects registering the user home directory", () => {
    const homeDir = makeTempRoot("ade-project-registry-home-");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const registry = new ProjectRegistry({
      adeDir: path.join(homeDir, ".ade-runtime"),
      projectsPath: path.join(homeDir, ".ade-runtime", "projects.json"),
      secretsDir: path.join(homeDir, ".ade-runtime", "secrets"),
      sockDir: path.join(homeDir, ".ade-runtime", "sock"),
      socketPath: path.join(homeDir, ".ade-runtime", "sock", "ade.sock"),
      binDir: path.join(homeDir, ".ade-runtime", "bin"),
      runtimeDir: path.join(homeDir, ".ade-runtime", "runtime"),
    });

    expect(isDisallowedProjectRoot(homeDir)).toBe(true);
    expect(() => registry.add(homeDir)).toThrow(/Refusing to register/);
  });

  it("filters already-persisted user home entries from project lists", () => {
    const homeDir = makeTempRoot("ade-project-registry-home-");
    const projectRoot = path.join(homeDir, "Projects", "ADE");
    const registryDir = path.join(homeDir, ".ade-runtime");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const projectsPath = path.join(registryDir, "projects.json");
    fs.writeFileSync(
      projectsPath,
      `${JSON.stringify({
        version: 1,
        projects: [
          {
            projectId: deriveProjectId(homeDir),
            rootPath: homeDir,
            displayName: "admin",
          },
          {
            projectId: deriveProjectId(projectRoot),
            rootPath: projectRoot,
            displayName: "ADE",
          },
        ],
      })}\n`,
      "utf8",
    );
    const registry = new ProjectRegistry({
      adeDir: registryDir,
      projectsPath,
      secretsDir: path.join(registryDir, "secrets"),
      sockDir: path.join(registryDir, "sock"),
      socketPath: path.join(registryDir, "sock", "ade.sock"),
      binDir: path.join(registryDir, "bin"),
      runtimeDir: path.join(registryDir, "runtime"),
    });

    expect(registry.list().map((project) => project.rootPath)).toEqual([
      projectRoot,
    ]);
  });
});
