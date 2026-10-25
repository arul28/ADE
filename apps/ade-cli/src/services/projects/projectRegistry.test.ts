import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectRegistry,
  deriveProjectId,
  isDisallowedProjectRoot,
  recordLocalProjectDatabaseIdentity,
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
  vi.unstubAllEnvs();
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

  it.each([
    ["folder", "brain", false],
    ["database", "brain", false],
    ["folder", "desktop", false],
    ["database", "desktop", false],
    // An older ADE on the same machine rewrites projects.json with only the
    // fields it knows; the record that the database existed must survive.
    ["database", "brain", true],
  ] as const)("blocks recreating initialized project data after losing its %s (%s, older ADE rewrote projects.json: %s) and accepts restoration", (missing, opener, olderAdeRewrites) => {
    const root = makeTempRoot();
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(projectRoot);
    const registryDir = path.join(root, "machine");
    const layout = { adeDir: registryDir, projectsPath: path.join(registryDir, "projects.json") } as any;
    const registry = new ProjectRegistry(layout);
    const record = registry.add(projectRoot);
    const adeDir = path.join(projectRoot, ".ade");
    const dbPath = path.join(adeDir, "ade.db");
    fs.writeFileSync(dbPath, "fixture");
    if (opener === "desktop") {
      vi.stubEnv("ADE_HOME", registryDir);
      recordLocalProjectDatabaseIdentity(projectRoot);
    } else {
      registry.touch(record.projectId);
    }
    if (olderAdeRewrites) {
      const file = JSON.parse(fs.readFileSync(layout.projectsPath, "utf8"));
      file.projects = file.projects.map((project: Record<string, unknown>) => ({
        projectId: project.projectId,
        rootPath: project.rootPath,
        displayName: project.displayName,
        addedAt: project.addedAt,
        lastOpenedAt: project.lastOpenedAt,
        gitOriginUrl: project.gitOriginUrl,
        catalogVisibility: project.catalogVisibility,
        registrationSource: project.registrationSource,
      }));
      fs.writeFileSync(layout.projectsPath, JSON.stringify(file));
    }
    const source = missing === "folder" ? adeDir : dbPath;
    const saved = path.join(root, "saved");
    fs.renameSync(source, saved);
    // Re-read from disk as a restarted brain would.
    const restarted = new ProjectRegistry(layout);
    expect(() => restarted.assertProjectDataAvailable(restarted.get(record.projectId))).toThrowError(expect.objectContaining({ code: "project_data_missing" }));
    expect(() => restarted.add(projectRoot)).toThrowError(expect.objectContaining({ code: "project_data_missing" }));
    expect(fs.existsSync(source)).toBe(false);
    fs.renameSync(saved, source);
    expect(() => restarted.add(projectRoot)).not.toThrow();
    expect(fs.readFileSync(dbPath, "utf8")).toBe("fixture");
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

  describe("writers in other processes", () => {
    function makeRegistry(prefix: string) {
      const root = makeTempRoot(prefix);
      const registryDir = path.join(root, "machine");
      fs.mkdirSync(registryDir, { recursive: true });
      const layout = { adeDir: registryDir, projectsPath: path.join(registryDir, "projects.json") } as any;
      const makeProject = (name: string) => {
        const dir = path.join(root, name);
        fs.mkdirSync(dir);
        return fs.realpathSync(dir);
      };
      return { layout, registry: new ProjectRegistry(layout), makeProject };
    }

    it("keeps a project another process added while this one waited for the list", async () => {
      const { layout, registry, makeProject } = makeRegistry("ade-project-registry-race-");
      const theirs = makeProject("theirs");
      const ours = makeProject("ours");
      // Another ADE process (the CLI, a second brain) mid-write: it holds the
      // lock, has read the list, and writes its copy plus its project a moment
      // later. Before the lock, this process wrote over it, or it over us.
      const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const childScript = `
        const fs = require("node:fs");
        const [projectsPath, rootPath, projectId] = process.argv.slice(1);
        const lockPath = projectsPath + ".lock";
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, JSON.stringify({ id: "child", pid: process.pid }));
        let copy = { version: 2, projects: [] };
        try { copy = JSON.parse(fs.readFileSync(projectsPath, "utf8")); } catch {}
        process.stdout.write("locked\\n");
        setTimeout(() => {
          copy.projects.push({ projectId, rootPath, displayName: "theirs", addedAt: 1, lastOpenedAt: 1,
            gitOriginUrl: null, catalogVisibility: "recent", registrationSource: "cli-explicit" });
          fs.writeFileSync(projectsPath, JSON.stringify(copy));
          fs.closeSync(fd);
          fs.unlinkSync(lockPath);
          process.exit(0);
        }, 300);
      `;
      const child = spawn(process.execPath, ["-e", childScript, layout.projectsPath, theirs, deriveProjectId(theirs)], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("locked")) resolve();
        });
        child.once("exit", () => reject(new Error("the writer exited before it took the lock")));
      });

      registry.add(ours);
      expect(await exited).toBe(0);

      const roots = new ProjectRegistry(layout).list().map((record) => record.rootPath).sort();
      expect(roots).toEqual([ours, theirs].sort());
      expect(fs.existsSync(`${layout.projectsPath}.lock`)).toBe(false);
    });

    it("takes over a lock left by a crashed writer whose pid now belongs to a live process", () => {
      const { layout, registry, makeProject } = makeRegistry("ade-project-registry-stale-lock-");
      const project = makeProject("project");
      const lockPath = `${layout.projectsPath}.lock`;
      // The pid is alive (it is this test), so only the lock's age shows it is abandoned.
      fs.writeFileSync(lockPath, JSON.stringify({ id: "crashed-writer", pid: process.pid }));
      const minuteAgo = new Date(Date.now() - 60_000);
      fs.utimesSync(lockPath, minuteAgo, minuteAgo);

      const record = registry.add(project);

      expect(fs.existsSync(lockPath)).toBe(false);
      expect(new ProjectRegistry(layout).get(record.projectId)?.rootPath).toBe(project);
      const journal = fs.readFileSync(path.join(path.dirname(layout.projectsPath), "projects.journal.jsonl"), "utf8");
      expect(journal).toContain('"op":"add"');
      expect(journal).not.toContain('"lockWaitMs":null');
    });

    it("keeps an old project id working after the folder resolves to a new one", () => {
      const { layout, makeProject } = makeRegistry("ade-project-registry-id-change-");
      const project = makeProject("project");
      // A window or phone holds the id the list stored. The folder now
      // resolves differently, so its id is a different hash.
      const heldId = "project_000000000000000000c0ffee";
      fs.writeFileSync(layout.projectsPath, JSON.stringify({
        version: 2,
        projects: [{ projectId: heldId, rootPath: project, displayName: "project", addedAt: 1, lastOpenedAt: 1,
          gitOriginUrl: null, catalogVisibility: "recent", registrationSource: "desktop" }],
      }));
      const registry = new ProjectRegistry(layout);

      const [record] = registry.list();

      expect(record?.projectId).toBe(deriveProjectId(project));
      expect(record?.projectId).not.toBe(heldId);
      expect(registry.resolveMovedProjectId(heldId)).toBe(record?.projectId);
      // The next write stores the new id; the alias still answers for the old one.
      registry.touch(record!.projectId);
      expect(new ProjectRegistry(layout).resolveMovedProjectId(heldId)).toBe(record?.projectId);
    });
  });
});
