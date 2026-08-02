import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectRegistry,
  deriveProjectId,
  isDisallowedProjectRoot,
} from "./projectRegistry";
import { createTestDirectoryLink, removeTestTree } from "../../test/filesystem";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

const tempRoots = new Set<string>();

function makeTempRoot(prefix = "ade-project-registry-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of tempRoots) {
    await removeTestTree(root);
  }
  tempRoots.clear();
});

describe("ProjectRegistry", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
  });

  it("migrates v1 records by desktop membership or Git-root existence", () => {
    const homeDir = makeTempRoot("ade-project-registry-v2-");
    const registryDir = path.join(homeDir, ".ade-runtime");
    const desktopRecentRoot = path.join(homeDir, "offline-recent");
    const gitRoot = path.join(homeDir, "smoke");
    const nonGitRoot = path.join(homeDir, "important-project");
    const missingRoot = path.join(homeDir, "missing-project");
    fs.mkdirSync(path.join(gitRoot, ".git"), { recursive: true });
    fs.mkdirSync(nonGitRoot, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    const projectsPath = path.join(registryDir, "projects.json");
    fs.writeFileSync(
      projectsPath,
      `${JSON.stringify({
        version: 1,
        projects: [desktopRecentRoot, gitRoot, nonGitRoot, missingRoot].map(
          (rootPath, index) => ({
            projectId: `legacy-${index}`,
            rootPath,
            displayName: path.basename(rootPath),
            addedAt: index + 1,
            lastOpenedAt: index + 10,
            gitOriginUrl: null,
          }),
        ),
      })}\n`,
      "utf8",
    );
    const registry = new ProjectRegistry(
      {
        adeDir: registryDir,
        projectsPath,
        secretsDir: path.join(registryDir, "secrets"),
        sockDir: path.join(registryDir, "sock"),
        socketPath: path.join(registryDir, "sock", "ade.sock"),
        desktopBridgeSocketPath: path.join(registryDir, "sock", "desktop-bridge.sock"),
        binDir: path.join(registryDir, "bin"),
        runtimeDir: path.join(registryDir, "runtime"),
      },
      { legacyRecentProjectRoots: [desktopRecentRoot] },
    );

    registry.list();

    expect(registry.findByRootPath(desktopRecentRoot)).toMatchObject({
      catalogVisibility: "recent",
      registrationSource: "desktop",
    });
    expect(registry.findByRootPath(gitRoot)).toMatchObject({
      catalogVisibility: "recent",
      registrationSource: "runtime-auto",
    });
    expect(registry.findByRootPath(nonGitRoot)).toMatchObject({
      catalogVisibility: "system",
    });
    expect(registry.findByRootPath(missingRoot)).toMatchObject({
      catalogVisibility: "system",
    });
    expect(JSON.parse(fs.readFileSync(projectsPath, "utf8"))).toMatchObject({
      version: 2,
    });
  });

  it("rejects an unknown registry version without rewriting it", () => {
    const homeDir = makeTempRoot("ade-project-registry-future-");
    const registryDir = path.join(homeDir, ".ade-runtime");
    const projectsPath = path.join(registryDir, "projects.json");
    fs.mkdirSync(registryDir, { recursive: true });
    const futureRegistry = `${JSON.stringify({
      version: 3,
      projects: [{ rootPath: "/future", futureMetadata: "preserve-me" }],
    })}\n`;
    fs.writeFileSync(projectsPath, futureRegistry, "utf8");
    const registry = new ProjectRegistry({
      adeDir: registryDir,
      projectsPath,
      secretsDir: path.join(registryDir, "secrets"),
      sockDir: path.join(registryDir, "sock"),
      socketPath: path.join(registryDir, "sock", "ade.sock"),
      desktopBridgeSocketPath: path.join(registryDir, "sock", "desktop-bridge.sock"),
      binDir: path.join(registryDir, "bin"),
      runtimeDir: path.join(registryDir, "runtime"),
    });

    expect(() => registry.list()).toThrow("Unsupported project registry version: 3");
    expect(fs.readFileSync(projectsPath, "utf8")).toBe(futureRegistry);
  });

  it("does not resurrect a forgotten project during system registration", () => {
    const homeDir = makeTempRoot("ade-project-registry-forget-");
    const projectRoot = path.join(homeDir, "ADE");
    const registryDir = path.join(homeDir, ".ade-runtime");
    fs.mkdirSync(projectRoot, { recursive: true });
    const registry = new ProjectRegistry({
      adeDir: registryDir,
      projectsPath: path.join(registryDir, "projects.json"),
      secretsDir: path.join(registryDir, "secrets"),
      sockDir: path.join(registryDir, "sock"),
      socketPath: path.join(registryDir, "sock", "ade.sock"),
      desktopBridgeSocketPath: path.join(registryDir, "sock", "desktop-bridge.sock"),
      binDir: path.join(registryDir, "bin"),
      runtimeDir: path.join(registryDir, "runtime"),
    });
    const visible = registry.add(projectRoot, {
      catalogVisibility: "recent",
      registrationSource: "desktop",
    });
    registry.setCatalogVisibilityByRootPath(projectRoot, "system", "desktop");

    const automatic = registry.add(projectRoot, {
      catalogVisibility: "system",
      registrationSource: "runtime-auto",
    });

    expect(visible.catalogVisibility).toBe("recent");
    expect(automatic).toMatchObject({
      catalogVisibility: "system",
      registrationSource: "runtime-auto",
    });
    expect(registry.listRecent()).toEqual([]);
  });

  it("does not rewrite the registry when catalog metadata already matches", () => {
    const homeDir = makeTempRoot("ade-project-registry-noop-visibility-");
    const projectRoot = path.join(homeDir, "ADE");
    const registryDir = path.join(homeDir, ".ade-runtime");
    fs.mkdirSync(projectRoot, { recursive: true });
    const registry = new ProjectRegistry({
      adeDir: registryDir,
      projectsPath: path.join(registryDir, "projects.json"),
      secretsDir: path.join(registryDir, "secrets"),
      sockDir: path.join(registryDir, "sock"),
      socketPath: path.join(registryDir, "sock", "ade.sock"),
      desktopBridgeSocketPath: path.join(registryDir, "sock", "desktop-bridge.sock"),
      binDir: path.join(registryDir, "bin"),
      runtimeDir: path.join(registryDir, "runtime"),
    });
    const registered = registry.add(projectRoot, {
      catalogVisibility: "recent",
      registrationSource: "desktop",
    });
    const writeFileSync = vi.spyOn(fs, "writeFileSync");

    const unchanged = registry.setCatalogVisibilityByRootPath(
      projectRoot,
      "recent",
      "desktop",
    );

    expect(unchanged).toEqual(registered);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects registering the user home directory", () => {
    const homeDir = makeTempRoot("ade-project-registry-home-");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const registry = new ProjectRegistry({
      adeDir: path.join(homeDir, ".ade-runtime"),
      projectsPath: path.join(homeDir, ".ade-runtime", "projects.json"),
      secretsDir: path.join(homeDir, ".ade-runtime", "secrets"),
      sockDir: path.join(homeDir, ".ade-runtime", "sock"),
      socketPath: path.join(homeDir, ".ade-runtime", "sock", "ade.sock"),
      desktopBridgeSocketPath: path.join(homeDir, ".ade-runtime", "sock", "desktop-bridge.sock"),
      binDir: path.join(homeDir, ".ade-runtime", "bin"),
      runtimeDir: path.join(homeDir, ".ade-runtime", "runtime"),
    });

    expect(isDisallowedProjectRoot(homeDir)).toBe(true);
    expect(() => registry.add(homeDir)).toThrow(/Refusing to register/);
  });

  it("filters already-persisted user home entries from project lists", () => {
    const homeDir = makeTempRoot("ade-project-registry-home-");
    const rawProjectRoot = path.join(homeDir, "Projects", "ADE");
    const registryDir = path.join(homeDir, ".ade-runtime");
    fs.mkdirSync(rawProjectRoot, { recursive: true });
    const projectRoot = fs.realpathSync.native(rawProjectRoot);
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
      desktopBridgeSocketPath: path.join(registryDir, "sock", "desktop-bridge.sock"),
      binDir: path.join(registryDir, "bin"),
      runtimeDir: path.join(registryDir, "runtime"),
    });

    expect(registry.list().map((project) => project.rootPath)).toEqual([
      projectRoot,
    ]);
  });

  it("registers an ADE-managed lane worktree as the parent project", () => {
    const homeDir = makeTempRoot("ade-project-registry-worktree-");
    const rawProjectRoot = path.join(homeDir, "ADE");
    fs.mkdirSync(path.join(rawProjectRoot, ".ade"), { recursive: true });
    const projectRoot = fs.realpathSync.native(rawProjectRoot);
    const worktreeRoot = path.join(projectRoot, ".ade", "worktrees", "feature-a");
    fs.mkdirSync(path.join(worktreeRoot, "apps", "desktop"), { recursive: true });
    const registryDir = path.join(homeDir, ".ade-runtime");
    const registry = new ProjectRegistry({
      adeDir: registryDir,
      projectsPath: path.join(registryDir, "projects.json"),
      secretsDir: path.join(registryDir, "secrets"),
      sockDir: path.join(registryDir, "sock"),
      socketPath: path.join(registryDir, "sock", "ade.sock"),
      desktopBridgeSocketPath: path.join(registryDir, "sock", "desktop-bridge.sock"),
      binDir: path.join(registryDir, "bin"),
      runtimeDir: path.join(registryDir, "runtime"),
    });

    const registered = registry.add(path.join(worktreeRoot, "apps", "desktop"));

    expect(registered.rootPath).toBe(projectRoot);
    expect(registered.projectId).toBe(deriveProjectId(projectRoot));
    expect(fs.existsSync(path.join(worktreeRoot, ".ade"))).toBe(false);
  });

  it("derives the same project id for symlink aliases", () => {
    const homeDir = makeTempRoot("ade-project-registry-alias-");
    const rawProjectRoot = path.join(homeDir, "ADE");
    const aliasRoot = path.join(homeDir, "ADE-link");
    fs.mkdirSync(rawProjectRoot, { recursive: true });
    const projectRoot = fs.realpathSync.native(rawProjectRoot);
    createTestDirectoryLink(projectRoot, aliasRoot);

    expect(deriveProjectId(aliasRoot)).toBe(deriveProjectId(projectRoot));
  });

  it("does not refresh git origin while touching a registered project", () => {
    const homeDir = makeTempRoot("ade-project-registry-touch-");
    const projectRoot = path.join(homeDir, "ADE");
    const registryDir = path.join(homeDir, ".ade-runtime");
    fs.mkdirSync(projectRoot, { recursive: true });
    const registry = new ProjectRegistry({
      adeDir: registryDir,
      projectsPath: path.join(registryDir, "projects.json"),
      secretsDir: path.join(registryDir, "secrets"),
      sockDir: path.join(registryDir, "sock"),
      socketPath: path.join(registryDir, "sock", "ade.sock"),
      desktopBridgeSocketPath: path.join(registryDir, "sock", "desktop-bridge.sock"),
      binDir: path.join(registryDir, "bin"),
      runtimeDir: path.join(registryDir, "runtime"),
    });
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: "git@github.com:arul28/ADE.git\n",
    });
    const registered = registry.add(projectRoot);
    spawnSyncMock.mockClear();

    const touched = registry.touch(registered.projectId);

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(touched.gitOriginUrl).toBe("git@github.com:arul28/ADE.git");
  });

  it("preserves git origin when an already-registered project is added again", () => {
    const homeDir = makeTempRoot("ade-project-registry-readd-");
    const projectRoot = path.join(homeDir, "ADE");
    const registryDir = path.join(homeDir, ".ade-runtime");
    fs.mkdirSync(projectRoot, { recursive: true });
    const registry = new ProjectRegistry({
      adeDir: registryDir,
      projectsPath: path.join(registryDir, "projects.json"),
      secretsDir: path.join(registryDir, "secrets"),
      sockDir: path.join(registryDir, "sock"),
      socketPath: path.join(registryDir, "sock", "ade.sock"),
      desktopBridgeSocketPath: path.join(registryDir, "sock", "desktop-bridge.sock"),
      binDir: path.join(registryDir, "bin"),
      runtimeDir: path.join(registryDir, "runtime"),
    });
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: "git@github.com:arul28/ADE.git\n",
    });
    registry.add(projectRoot);
    spawnSyncMock.mockClear();

    const updated = registry.add(projectRoot);

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(updated.gitOriginUrl).toBe("git@github.com:arul28/ADE.git");
  });

  it("backfills git origin on re-add when the existing record is missing it", () => {
    const homeDir = makeTempRoot("ade-project-registry-readd-null-");
    const projectRoot = path.join(homeDir, "ADE");
    const registryDir = path.join(homeDir, ".ade-runtime");
    fs.mkdirSync(projectRoot, { recursive: true });
    const registry = new ProjectRegistry({
      adeDir: registryDir,
      projectsPath: path.join(registryDir, "projects.json"),
      secretsDir: path.join(registryDir, "secrets"),
      sockDir: path.join(registryDir, "sock"),
      socketPath: path.join(registryDir, "sock", "ade.sock"),
      desktopBridgeSocketPath: path.join(registryDir, "sock", "desktop-bridge.sock"),
      binDir: path.join(registryDir, "bin"),
      runtimeDir: path.join(registryDir, "runtime"),
    });
    registry.add(projectRoot);
    spawnSyncMock.mockClear();
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: "git@github.com:arul28/ADE.git\n",
    });

    const updated = registry.add(projectRoot);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(updated.gitOriginUrl).toBe("git@github.com:arul28/ADE.git");
  });
});
