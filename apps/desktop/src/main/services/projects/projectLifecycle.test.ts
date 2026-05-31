import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAdeGitignore, resolveAdeLayout } from "../../../shared/adeLayout";
import { createAdeProjectService, initializeOrRepairAdeProject } from "./adeProjectService";
import { browseProjectDirectories } from "./projectBrowserService";
import { __internal, getProjectDetail } from "./projectDetailService";
import { inspectRecentProject, toRecentProjectSummary, toShallowRecentProjectSummary } from "./recentProjectSummary";
import { openKvDb } from "../state/kvDb";
import { createProjectConfigService } from "../config/projectConfigService";

const { parseLastCommitLine, parseAheadBehind } = __internal;

vi.mock("./projectService", () => ({
  resolveRepoRoot: vi.fn(async (selectedPath: string) => {
    const normalized = path.resolve(selectedPath);
    if (normalized.endsWith(path.join("alpha", "nested"))) {
      return path.dirname(normalized);
    }
    if (normalized.endsWith("alpha")) {
      return normalized;
    }
    throw new Error("Not a git repository");
  }),
}));

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function withTrailingSlash(input: string): string {
  return input.endsWith(path.sep) ? input : `${input}${path.sep}`;
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

function makeProjectConfigDb() {
  const store = new Map<string, unknown>();
  return {
    getJson: vi.fn((key: string) => (store.has(key) ? store.get(key) : null)),
    setJson: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
    run: vi.fn(),
  } as any;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function insertProject(
  db: Awaited<ReturnType<typeof openKvDb>>,
  projectId: string,
  projectRoot: string,
  now: string,
) {
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, projectRoot, path.basename(projectRoot), "main", now, now],
  );
}

function insertLane(
  db: Awaited<ReturnType<typeof openKvDb>>,
  args: {
    laneId: string;
    projectId: string;
    laneType: "primary" | "worktree" | "attached";
    worktreePath: string;
    branchRef: string;
    status?: "active" | "archived";
    archivedAt?: string | null;
    attachedRootPath?: string | null;
  },
) {
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      args.laneId,
      args.projectId,
      args.laneId,
      null,
      args.laneType,
      "main",
      args.branchRef,
      args.worktreePath,
      args.attachedRootPath ?? null,
      args.laneType === "primary" ? 1 : 0,
      null,
      null,
      null,
      null,
      args.status ?? "active",
      "2026-04-02T12:00:00.000Z",
      args.archivedAt ?? null,
    ],
  );
}

afterEach(() => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// initializeOrRepairAdeProject — canonical .ade/ layout init + repair
// ---------------------------------------------------------------------------

describe("initializeOrRepairAdeProject", () => {
  function createRepoFixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-layout-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n/.ade\n", "utf8");
    fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "*.tmp\n.ade/\n", "utf8");

    fs.mkdirSync(path.join(root, ".ade", "logs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ade", "logs", "main.jsonl"), "{\"ok\":true}\n", "utf8");
    fs.mkdirSync(path.join(root, ".ade", "chat-sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ade", "chat-sessions", "session-1.json"), "{\"id\":\"session-1\"}\n", "utf8");

    return root;
  }

  it("creates the canonical shared layout, scrubs stale git excludes, and rehomes legacy state when requested", () => {
    const root = createRepoFixture();
    const layout = resolveAdeLayout(root);

    const result = initializeOrRepairAdeProject(root, { mode: "shared" });

    expect(result.cleanup.changed).toBe(true);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).not.toContain("/.ade");
    expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")).not.toContain(".ade/");
    const adeGitignore = fs.readFileSync(path.join(layout.adeDir, ".gitignore"), "utf8");
    expect(adeGitignore).toBe(buildAdeGitignore());
    expect(adeGitignore).toContain("*");
    expect(adeGitignore).toContain("!cto/identity.yaml");
    expect(adeGitignore).toContain("!workflows/linear/**");
    expect(adeGitignore).toContain("!project-icons/**");
    expect(fs.readFileSync(path.join(layout.adeDir, "ade.yaml"), "utf8")).toContain("version: 1");
    expect(fs.readFileSync(path.join(layout.ctoDir, "identity.yaml"), "utf8")).toContain("name: CTO");
    expect(fs.existsSync(path.join(layout.templatesDir, ".gitkeep"))).toBe(true);
    expect(fs.existsSync(path.join(layout.skillsDir, ".gitkeep"))).toBe(true);
    expect(fs.existsSync(layout.linearWorkflowsDir)).toBe(true);
    expect(fs.existsSync(path.join(layout.logsDir, "main.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(layout.chatSessionsDir, "session-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(layout.adeDir, "logs"))).toBe(false);
    expect(fs.existsSync(path.join(layout.adeDir, "chat-sessions"))).toBe(false);
  });

  it("is idempotent once the canonical structure is in place", () => {
    const root = createRepoFixture();

    initializeOrRepairAdeProject(root, { mode: "shared" });
    const second = initializeOrRepairAdeProject(root);

    expect(second.cleanup.changed).toBe(false);
    expect(second.cleanup.actions).toHaveLength(0);
  });

  it("does not overwrite an existing shared ade.yaml", () => {
    const root = createRepoFixture();
    const layout = resolveAdeLayout(root);
    fs.mkdirSync(layout.adeDir, { recursive: true });
    fs.writeFileSync(path.join(layout.adeDir, "ade.yaml"), "version: 1\nprocesses:\n  - id: keep-me\n", "utf8");

    initializeOrRepairAdeProject(root, { mode: "shared" });

    expect(fs.readFileSync(path.join(layout.adeDir, "ade.yaml"), "utf8")).toContain("keep-me");
  });

  it("keeps a non-ADE repo local-only on open so Git stays clean", () => {
    const root = makeTempDir("ade-project-local-open-");
    git(root, ["init"]);

    const result = initializeOrRepairAdeProject(root);
    const layout = resolveAdeLayout(root);

    expect(result.cleanup.changed).toBe(true);
    expect(fs.existsSync(layout.sharedConfigPath)).toBe(false);
    expect(fs.existsSync(path.join(layout.adeDir, ".gitignore"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")).toContain(".ade/");
    expect(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim()).toBe("");
  });

  it("does not promote generated local CTO files on a later open", () => {
    const root = makeTempDir("ade-project-local-cto-open-");
    git(root, ["init"]);
    const layout = resolveAdeLayout(root);
    initializeOrRepairAdeProject(root);
    fs.mkdirSync(layout.ctoDir, { recursive: true });
    fs.writeFileSync(path.join(layout.ctoDir, "identity.yaml"), "name: CTO\nupdatedAt: 2026-01-01T00:00:00.000Z\n", "utf8");

    const second = initializeOrRepairAdeProject(root);

    expect(second.cleanup.actions.some((action) => action.kind === "scrub_exclude")).toBe(false);
    expect(fs.existsSync(layout.sharedConfigPath)).toBe(false);
    expect(fs.existsSync(path.join(layout.adeDir, ".gitignore"))).toBe(false);
    expect(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim()).toBe("");
  });

  it("repairs shared scaffold automatically when a clone already has ADE config", () => {
    const root = makeTempDir("ade-project-shared-open-");
    git(root, ["init"]);
    const layout = resolveAdeLayout(root);
    fs.mkdirSync(layout.adeDir, { recursive: true });
    fs.writeFileSync(layout.sharedConfigPath, "version: 1\nprocesses: []\n", "utf8");

    const result = initializeOrRepairAdeProject(root);

    expect(result.cleanup.actions.some((action) => action.relativePath === ".gitignore")).toBe(true);
    expect(fs.readFileSync(path.join(layout.adeDir, ".gitignore"), "utf8")).toBe(buildAdeGitignore());
    expect(fs.readFileSync(layout.sharedConfigPath, "utf8")).toContain("version: 1");
    expect(fs.existsSync(path.join(layout.ctoDir, "identity.yaml"))).toBe(true);
  });

  it("promotes local-only ADE state to shared scaffold and removes local excludes", () => {
    const root = makeTempDir("ade-project-promote-");
    git(root, ["init"]);
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n/.ade/**\n", "utf8");
    initializeOrRepairAdeProject(root);
    fs.appendFileSync(path.join(root, ".git", "info", "exclude"), ".ade/*\n", "utf8");

    const result = initializeOrRepairAdeProject(root, { mode: "shared" });
    const layout = resolveAdeLayout(root);

    expect(result.cleanup.actions.some((action) => action.kind === "scrub_exclude")).toBe(true);
    expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")).not.toContain(".ade");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).not.toContain("/.ade");
    expect(fs.existsSync(layout.sharedConfigPath)).toBe(true);
    const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    expect(status).toContain("?? .ade/.gitignore");
    expect(status).toContain("?? .ade/ade.yaml");
    expect(status).toContain("?? .ade/cto/identity.yaml");
  });

  it("promotes local-only ADE state when shared project config is saved", () => {
    const root = makeTempDir("ade-project-config-promote-");
    git(root, ["init"]);
    const layout = resolveAdeLayout(root);
    initializeOrRepairAdeProject(root);

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir: layout.adeDir,
      projectId: "project-config-promote",
      db: makeProjectConfigDb(),
      logger: createLogger(),
    });

    service.save({
      shared: {
        version: 1,
        processes: [{ id: "dev", name: "Dev", command: ["npm", "run", "dev"], cwd: "." }],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      },
      local: {},
    });

    expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")).not.toContain(".ade/");
    const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    expect(status).toContain("?? .ade/.gitignore");
    expect(status).toContain("?? .ade/ade.yaml");
    expect(status).not.toContain(".ade/local.yaml");
  });

  it("keeps local-only project config saves out of Git", () => {
    const root = makeTempDir("ade-project-local-config-");
    git(root, ["init"]);
    const layout = resolveAdeLayout(root);
    initializeOrRepairAdeProject(root);

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir: layout.adeDir,
      projectId: "project-local-config",
      db: makeProjectConfigDb(),
      logger: createLogger(),
    });

    service.save({
      shared: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      },
      local: {
        version: 1,
        processes: [{ id: "dev", name: "Dev", command: ["npm", "run", "dev"], cwd: "." }],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      },
    });

    expect(fs.existsSync(layout.sharedConfigPath)).toBe(false);
    expect(fs.existsSync(layout.localConfigPath)).toBe(true);
    expect(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim()).toBe("");
  });
});

describe("createAdeProjectService.clearLocalData", () => {
  it("deletes only selected generated .ade data directories", () => {
    const root = makeTempDir("ade-project-clear-local-data-");
    const layout = resolveAdeLayout(root);
    const service = createAdeProjectService({
      projectRoot: root,
      db: makeProjectConfigDb(),
      projectId: "project-1",
      logger: createLogger(),
      projectConfigService: {
        get: () => ({ validation: { ok: true, issues: [] } }),
      },
    });
    fs.mkdirSync(layout.artifactsDir, { recursive: true });
    fs.mkdirSync(layout.logsDir, { recursive: true });
    fs.mkdirSync(layout.transcriptsDir, { recursive: true });
    fs.mkdirSync(layout.cacheDir, { recursive: true });
    fs.mkdirSync(layout.secretsDir, { recursive: true });
    fs.writeFileSync(path.join(layout.artifactsDir, "pack.txt"), "pack", "utf8");
    fs.writeFileSync(path.join(layout.logsDir, "run.log"), "log", "utf8");
    fs.writeFileSync(path.join(layout.transcriptsDir, "chat.jsonl"), "chat", "utf8");
    fs.writeFileSync(path.join(layout.cacheDir, "keep.json"), "cache", "utf8");
    fs.writeFileSync(path.join(layout.secretsDir, "keep"), "secret", "utf8");

    const result = service.clearLocalData({ packs: true, logs: true, transcripts: true });

    expect(result.clearedAt).toEqual(expect.any(String));
    expect(result.deletedPaths).toEqual(expect.arrayContaining([
      path.resolve(layout.artifactsDir),
      path.resolve(layout.logsDir),
      path.resolve(layout.transcriptsDir),
    ]));
    expect(fs.existsSync(layout.artifactsDir)).toBe(false);
    expect(fs.existsSync(layout.logsDir)).toBe(false);
    expect(fs.existsSync(layout.transcriptsDir)).toBe(false);
    expect(fs.readFileSync(path.join(layout.cacheDir, "keep.json"), "utf8")).toBe("cache");
    expect(fs.readFileSync(path.join(layout.secretsDir, "keep"), "utf8")).toBe("secret");
  });
});

// ---------------------------------------------------------------------------
// browseProjectDirectories — directory picker for "Add Project"
// ---------------------------------------------------------------------------

describe("browseProjectDirectories", () => {
  it("returns matching directories for a partial path", async () => {
    const root = makeTempDir("ade-project-browse-");
    fs.mkdirSync(path.join(root, "alpha"));
    fs.mkdirSync(path.join(root, "alpine"));
    fs.writeFileSync(path.join(root, "alpha.txt"), "ignore me", "utf8");

    const result = await browseProjectDirectories({
      partialPath: path.join(root, "alp"),
    });

    expect(result.exactDirectoryPath).toBeNull();
    expect(result.directoryPath).toBe(root);
    expect(result.openableProjectRoot).toBeNull();
    expect(result.entries.map((entry) => entry.name)).toEqual(["alpha", "alpine"]);
  });

  it("lists directory contents and reports an openable repo for an exact directory", async () => {
    const root = makeTempDir("ade-project-browse-dir-");
    const repoRoot = path.join(root, "alpha");
    fs.mkdirSync(path.join(repoRoot, "nested"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });

    const result = await browseProjectDirectories({
      partialPath: repoRoot,
    });

    expect(result.exactDirectoryPath).toBe(repoRoot);
    expect(result.openableProjectRoot).toBe(repoRoot);
    expect(result.entries.map((entry) => entry.name)).toEqual([".config", ".git", "nested", "src"]);
  });

  it("supports relative paths when cwd is provided", async () => {
    const root = makeTempDir("ade-project-browse-rel-");
    const repoRoot = path.join(root, "alpha");
    fs.mkdirSync(path.join(repoRoot, "nested"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

    const result = await browseProjectDirectories({
      cwd: repoRoot,
      partialPath: "./nested",
    });

    expect(result.exactDirectoryPath).toBe(path.join(repoRoot, "nested"));
    expect(result.openableProjectRoot).toBe(repoRoot);
  });

  it("marks entries with a .git directory as git repos", async () => {
    const root = makeTempDir("ade-project-browse-flags-");
    fs.mkdirSync(path.join(root, "alpha", ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "alpine"));

    const result = await browseProjectDirectories({
      partialPath: withTrailingSlash(root),
    });

    const byName = new Map(result.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("alpha")?.isGitRepo).toBe(true);
    expect(byName.get("alpine")?.isGitRepo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getProjectDetail + parsers — project preview details
// ---------------------------------------------------------------------------

describe("parseLastCommitLine", () => {
  it("splits subject, iso date, and short sha on the unit separator", () => {
    const parsed = parseLastCommitLine("Fix thing\u001f2026-04-15T09:00:00Z\u001fabcdef1\n");
    expect(parsed).toEqual({
      subject: "Fix thing",
      isoDate: "2026-04-15T09:00:00Z",
      shortSha: "abcdef1",
    });
  });

  it("returns null when any segment is missing", () => {
    expect(parseLastCommitLine("")).toBeNull();
    expect(parseLastCommitLine("Fix thing\u001f2026-04-15T09:00:00Z")).toBeNull();
    expect(parseLastCommitLine("Fix thing\u001f\u001fabcdef1")).toBeNull();
  });
});

describe("parseAheadBehind", () => {
  it("reads the left-right count output (behind, ahead)", () => {
    expect(parseAheadBehind("3\t2\n")).toEqual({ ahead: 2, behind: 3 });
    expect(parseAheadBehind("0\t0")).toEqual({ ahead: 0, behind: 0 });
  });

  it("returns null when the output cannot be parsed", () => {
    expect(parseAheadBehind("")).toBeNull();
    expect(parseAheadBehind("abc")).toBeNull();
  });
});

describe("getProjectDetail", () => {
  it("rejects paths that are not existing directories", async () => {
    const root = makeTempDir("ade-project-detail-");
    const filePath = path.join(root, "README.md");
    fs.writeFileSync(filePath, "# hello\n", "utf8");

    await expect(getProjectDetail(filePath)).rejects.toThrow(/existing directory/i);
    await expect(getProjectDetail(path.join(root, "missing-project"))).rejects.toThrow(/existing directory/i);
  });

  it("strips repeated leading HTML comments from README excerpts", async () => {
    const root = makeTempDir("ade-project-detail-");
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(
      path.join(root, "README.md"),
      "<!-- generated -->\n<!-- review -->\n# Hello\n\nVisible body.\n",
      "utf8",
    );

    const detail = await getProjectDetail(root);

    expect(detail.readmeExcerpt).toBe("# Hello\n\nVisible body.");
  });

  it("keeps plain folder details lightweight", async () => {
    const root = makeTempDir("ade-project-detail-");
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "README.md"), "# Plain folder\n", "utf8");
    fs.writeFileSync(path.join(root, "index.ts"), "export const value = 1;\n", "utf8");

    const detail = await getProjectDetail(root);

    expect(detail.isGitRepo).toBe(false);
    expect(detail.readmeExcerpt).toBeNull();
    expect(detail.languages).toEqual([]);
    expect(detail.subdirectoryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// toRecentProjectSummary — lane counting for recent-project tiles
// ---------------------------------------------------------------------------

describe("toRecentProjectSummary", () => {
  it("keeps shallow recent-project rows free of lane scans", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-project-shallow-"));
    tempDirs.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, ".git", "worktrees", "lane-a"), { recursive: true });

    const summary = toShallowRecentProjectSummary({
      rootPath: projectRoot,
      displayName: "demo",
      lastOpenedAt: "2026-04-02T12:00:00.000Z",
    });

    expect(summary).toEqual({
      rootPath: projectRoot,
      displayName: "demo",
      lastOpenedAt: "2026-04-02T12:00:00.000Z",
      exists: true,
    });
  });

  it("prefers active ADE lanes over raw git worktree metadata", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-project-summary-"));
    tempDirs.push(projectRoot);
    const gitWorktreesDir = path.join(projectRoot, ".git", "worktrees");
    fs.mkdirSync(gitWorktreesDir, { recursive: true });
    for (let index = 0; index < 18; index += 1) {
      fs.mkdirSync(path.join(gitWorktreesDir, `raw-${index}`), { recursive: true });
    }

    const layout = resolveAdeLayout(projectRoot);
    const managedLanePath = path.join(layout.worktreesDir, "lane-managed");
    const missingLanePath = path.join(layout.worktreesDir, "lane-missing");
    const attachedLanePath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-project-attached-"));
    tempDirs.push(attachedLanePath);
    fs.mkdirSync(managedLanePath, { recursive: true });

    const db = await openKvDb(layout.dbPath, createLogger());
    const now = "2026-04-02T12:00:00.000Z";
    insertProject(db, "proj-recent", projectRoot, now);
    insertLane(db, {
      laneId: "lane-primary",
      projectId: "proj-recent",
      laneType: "primary",
      worktreePath: projectRoot,
      branchRef: "main",
    });
    insertLane(db, {
      laneId: "lane-managed",
      projectId: "proj-recent",
      laneType: "worktree",
      worktreePath: managedLanePath,
      branchRef: "feature/managed",
    });
    insertLane(db, {
      laneId: "lane-missing",
      projectId: "proj-recent",
      laneType: "worktree",
      worktreePath: missingLanePath,
      branchRef: "feature/missing",
    });
    insertLane(db, {
      laneId: "lane-attached",
      projectId: "proj-recent",
      laneType: "attached",
      worktreePath: attachedLanePath,
      attachedRootPath: attachedLanePath,
      branchRef: "feature/attached",
    });
    insertLane(db, {
      laneId: "lane-archived",
      projectId: "proj-recent",
      laneType: "worktree",
      worktreePath: path.join(layout.worktreesDir, "lane-archived"),
      branchRef: "feature/archived",
      status: "archived",
      archivedAt: now,
    });
    db.close();

    const inspection = inspectRecentProject({
      rootPath: projectRoot,
      displayName: "demo",
      lastOpenedAt: now,
    });
    const summary = inspection.summary;

    expect(summary.exists).toBe(true);
    expect(summary.laneCount).toBe(3);
    expect(inspection.projectId).toBe("proj-recent");
    expect(inspection.defaultBaseRef).toBe("main");
  });

  it("falls back to git worktree metadata when no ADE lane registry exists", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-project-git-fallback-"));
    tempDirs.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, ".git", "worktrees", "lane-a"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".git", "worktrees", "lane-b"), { recursive: true });

    const summary = toRecentProjectSummary({
      rootPath: projectRoot,
      displayName: "demo",
      lastOpenedAt: "2026-04-02T12:00:00.000Z",
    });

    expect(summary.laneCount).toBe(3);
  });

  it("falls back to git worktree metadata when ADE only has archived lanes", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-project-archived-fallback-"));
    tempDirs.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, ".git", "worktrees", "lane-a"), { recursive: true });

    const layout = resolveAdeLayout(projectRoot);
    const db = await openKvDb(layout.dbPath, createLogger());
    const now = "2026-04-02T12:00:00.000Z";
    insertProject(db, "proj-recent-archived", projectRoot, now);
    insertLane(db, {
      laneId: "lane-primary-archived",
      projectId: "proj-recent-archived",
      laneType: "primary",
      worktreePath: projectRoot,
      branchRef: "main",
      status: "archived",
      archivedAt: now,
    });
    db.close();

    const summary = toRecentProjectSummary({
      rootPath: projectRoot,
      displayName: "demo",
      lastOpenedAt: now,
    });

    expect(summary.laneCount).toBe(2);
  });
});
