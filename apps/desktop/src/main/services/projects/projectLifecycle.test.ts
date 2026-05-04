import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAdeGitignore, resolveAdeLayout } from "../../../shared/adeLayout";
import { initializeOrRepairAdeProject } from "./adeProjectService";
import { browseProjectDirectories } from "./projectBrowserService";
import { __internal, getProjectDetail } from "./projectDetailService";
import { inspectRecentProject, toRecentProjectSummary } from "./recentProjectSummary";
import { openKvDb } from "../state/kvDb";

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
    fs.writeFileSync(path.join(root, ".ade", "mission-state-run-1.json"), "{\"runId\":\"run-1\"}\n", "utf8");
    fs.mkdirSync(path.join(root, ".ade", "cto"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ade", "cto", "openclaw-history.json"), "[]\n", "utf8");

    return root;
  }

  it("creates the canonical layout, scrubs stale git excludes, and rehomes legacy state", () => {
    const root = createRepoFixture();
    const layout = resolveAdeLayout(root);

    const result = initializeOrRepairAdeProject(root);

    expect(result.cleanup.changed).toBe(true);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).not.toContain("/.ade");
    expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")).not.toContain(".ade/");
    const adeGitignore = fs.readFileSync(path.join(layout.adeDir, ".gitignore"), "utf8");
    expect(adeGitignore).toBe(buildAdeGitignore());
    expect(adeGitignore).toContain("cto/core-memory.json");
    expect(adeGitignore).toContain("context/");
    expect(adeGitignore).toContain("agents/");
    expect(adeGitignore).toContain("cto/openclaw-history.json");
    expect(adeGitignore).not.toContain("cto/identity.yaml");
    expect(fs.readFileSync(path.join(layout.adeDir, "ade.yaml"), "utf8")).toContain("version: 1");
    expect(fs.readFileSync(path.join(layout.ctoDir, "identity.yaml"), "utf8")).toContain("name: CTO");
    expect(fs.existsSync(path.join(layout.templatesDir, ".gitkeep"))).toBe(true);
    expect(fs.existsSync(path.join(layout.skillsDir, ".gitkeep"))).toBe(true);
    expect(fs.existsSync(layout.linearWorkflowsDir)).toBe(true);
    expect(fs.existsSync(path.join(layout.logsDir, "main.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(layout.chatSessionsDir, "session-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(layout.missionStateDir, "mission-state-run-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(layout.cacheDir, "openclaw", "openclaw-history.json"))).toBe(true);
    expect(fs.existsSync(path.join(layout.adeDir, "logs"))).toBe(false);
    expect(fs.existsSync(path.join(layout.adeDir, "chat-sessions"))).toBe(false);
    expect(fs.existsSync(path.join(layout.ctoDir, "openclaw-history.json"))).toBe(false);
  });

  it("is idempotent once the canonical structure is in place", () => {
    const root = createRepoFixture();

    initializeOrRepairAdeProject(root);
    const second = initializeOrRepairAdeProject(root);

    expect(second.cleanup.changed).toBe(false);
    expect(second.cleanup.actions).toHaveLength(0);
  });

  it("does not overwrite an existing shared ade.yaml", () => {
    const root = createRepoFixture();
    const layout = resolveAdeLayout(root);
    fs.mkdirSync(layout.adeDir, { recursive: true });
    fs.writeFileSync(path.join(layout.adeDir, "ade.yaml"), "version: 1\nprocesses:\n  - id: keep-me\n", "utf8");

    initializeOrRepairAdeProject(root);

    expect(fs.readFileSync(path.join(layout.adeDir, "ade.yaml"), "utf8")).toContain("keep-me");
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
