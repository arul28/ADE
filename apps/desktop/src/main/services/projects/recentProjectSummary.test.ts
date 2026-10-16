import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAdeLayout } from "../../../shared/adeLayout";
import { openKvDb } from "../state/kvDb";
import {
  cleanGitConfigValue,
  clearAdeProjectMemoForTests,
  clearGitOriginCacheForTests,
  inspectRecentProject,
  parseGitOriginUrlFromConfig,
  readGitOriginUrl,
  resolveGitConfigDirectory,
  toShallowRecentProjectSummary,
} from "./recentProjectSummary";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-origin-"));
  tempDirs.push(dir);
  return dir;
}

/** Writes a plain (non-worktree) checkout at `rootPath` with the given config. */
function writeRepo(rootPath: string, configText: string): string {
  const gitDir = path.join(rootPath, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "config"), configText, "utf8");
  return rootPath;
}

function originConfig(url: string, bare = false): string {
  return ["[core]", `\tbare = ${bare}`, "[remote \"origin\"]", `\turl = ${url}`, "\tfetch = +refs/heads/*:refs/remotes/origin/*", ""].join("\n");
}

function writeLinkedWorktree(
  tmp: string,
  commonGitDirName: string,
  originUrl: string,
  bare = false,
): string {
  const commonGitDir = path.join(tmp, commonGitDirName);
  fs.mkdirSync(commonGitDir, { recursive: true });
  fs.writeFileSync(path.join(commonGitDir, "config"), originConfig(originUrl, bare), "utf8");

  const worktreeGitDir = path.join(commonGitDir, "worktrees", "lane-x");
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(
    path.join(worktreeGitDir, "commondir"),
    `${path.relative(worktreeGitDir, commonGitDir)}\n`,
    "utf8",
  );

  const worktreeRoot = path.join(tmp, "lane-x");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
  return worktreeRoot;
}

beforeEach(() => {
  clearGitOriginCacheForTests();
  clearAdeProjectMemoForTests();
});

afterEach(() => {
  clearGitOriginCacheForTests();
  clearAdeProjectMemoForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseGitOriginUrlFromConfig", () => {
  it("stops at an indented section header instead of reading the next remote", () => {
    // The failure this guards is not cosmetic: returning upstream's URL merges
    // two unrelated repositories into a single tab.
    const config = [
      "[remote \"origin\"]",
      "\turl = git@github.com:arul28/ADE.git",
      "  [remote \"upstream\"]",
      "\turl = git@github.com:someone-else/ADE.git",
      "",
    ].join("\n");

    expect(parseGitOriginUrlFromConfig(config)).toBe("git@github.com:arul28/ADE.git");
  });

  it("strips surrounding quotes from a quoted url", () => {
    const config = ["[remote \"origin\"]", "\turl = \"git@github.com:a/b.git\"", ""].join("\n");
    expect(parseGitOriginUrlFromConfig(config)).toBe("git@github.com:a/b.git");
  });

  it("strips an unquoted trailing comment", () => {
    expect(
      parseGitOriginUrlFromConfig(["[remote \"origin\"]", "\turl = git@github.com:a/b.git ; work laptop", ""].join("\n")),
    ).toBe("git@github.com:a/b.git");
    expect(
      parseGitOriginUrlFromConfig(["[remote \"origin\"]", "\turl = git@github.com:a/b.git # work laptop", ""].join("\n")),
    ).toBe("git@github.com:a/b.git");
  });

  it("keeps comment characters that are inside a quoted url", () => {
    const config = ["[remote \"origin\"]", "\turl = \"https://example.com/a/b.git#frag\"", ""].join("\n");
    expect(parseGitOriginUrlFromConfig(config)).toBe("https://example.com/a/b.git#frag");
  });

  it("matches the section name case-insensitively", () => {
    const config = ["[REMOTE \"origin\"]", "\tURL = git@github.com:a/b.git", ""].join("\n");
    expect(parseGitOriginUrlFromConfig(config)).toBe("git@github.com:a/b.git");
  });

  it("returns null when there is no origin remote", () => {
    expect(parseGitOriginUrlFromConfig(["[remote \"upstream\"]", "\turl = git@github.com:a/b.git", ""].join("\n")))
      .toBeNull();
    expect(parseGitOriginUrlFromConfig("")).toBeNull();
  });
});

describe("cleanGitConfigValue", () => {
  it("honours backslash escapes inside a quoted value", () => {
    expect(cleanGitConfigValue("\"git@github.com:a/b\\\"c.git\"")).toBe("git@github.com:a/b\"c.git");
  });

  it("returns null for an empty or comment-only value", () => {
    expect(cleanGitConfigValue("   ")).toBeNull();
    expect(cleanGitConfigValue("; just a comment")).toBeNull();
  });
});

describe("resolveGitConfigDirectory", () => {
  it("walks a linked worktree's metadata dir back to the main repo", () => {
    const gitDir = path.join("/repos", "main", ".git", "worktrees", "lane-x");
    expect(resolveGitConfigDirectory(gitDir)).toBe(path.join("/repos", "main", ".git"));
  });

  it("leaves a repo that merely lives under a folder named worktrees alone", () => {
    const gitDir = path.join("/Users", "me", "worktrees", "myrepo", ".git");
    expect(resolveGitConfigDirectory(gitDir)).toBe(gitDir);
  });

  it("leaves a submodule nested inside a linked worktree alone", () => {
    const gitDir = path.join("/repos", "main", ".git", "worktrees", "lane-x", "modules", "sub");
    expect(resolveGitConfigDirectory(gitDir)).toBe(gitDir);
  });
});

describe("readGitOriginUrl", () => {
  it("reads the origin of a plain checkout", () => {
    const root = writeRepo(path.join(makeTempDir(), "repo"), originConfig("git@github.com:arul28/ADE.git"));
    expect(readGitOriginUrl(root)).toBe("git@github.com:arul28/ADE.git");
  });

  it("reads the main repo's origin from a linked worktree", () => {
    const tmp = makeTempDir();
    const mainRoot = writeRepo(path.join(tmp, "main"), originConfig("git@github.com:arul28/ADE.git"));
    const worktreeGitDir = path.join(mainRoot, ".git", "worktrees", "lane-x");
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    const worktreeRoot = path.join(tmp, "lane-x");
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

    expect(readGitOriginUrl(worktreeRoot)).toBe("git@github.com:arul28/ADE.git");
  });

  it("reads the origin from a linked worktree backed by a bare repository", () => {
    const worktreeRoot = writeLinkedWorktree(
      makeTempDir(),
      "central.git",
      "git@github.com:arul28/bare-backed.git",
      true,
    );

    expect(readGitOriginUrl(worktreeRoot)).toBe("git@github.com:arul28/bare-backed.git");
  });

  it("reads the origin from a linked worktree with a separately named common Git directory", () => {
    const worktreeRoot = writeLinkedWorktree(
      makeTempDir(),
      "git-metadata",
      "git@github.com:arul28/separate-metadata.git",
    );

    expect(readGitOriginUrl(worktreeRoot)).toBe("git@github.com:arul28/separate-metadata.git");
  });

  it("does not truncate a repo that lives under a directory named worktrees", () => {
    // The old marker search cut `<home>/worktrees/myrepo/.git` down to `<home>`
    // and read `<home>/config` — a file that either does not exist or belongs
    // to something else entirely.
    const tmp = makeTempDir();
    fs.writeFileSync(path.join(tmp, "config"), originConfig("git@github.com:someone/decoy.git"), "utf8");
    const root = writeRepo(
      path.join(tmp, "worktrees", "myrepo"),
      originConfig("git@github.com:arul28/myrepo.git"),
    );

    expect(readGitOriginUrl(root)).toBe("git@github.com:arul28/myrepo.git");
  });

  it("reads a submodule's own origin when it sits inside a linked worktree", () => {
    const tmp = makeTempDir();
    const mainRoot = writeRepo(path.join(tmp, "main"), originConfig("git@github.com:arul28/super.git"));
    const submoduleGitDir = path.join(mainRoot, ".git", "worktrees", "lane-x", "modules", "sub");
    fs.mkdirSync(submoduleGitDir, { recursive: true });
    fs.writeFileSync(
      path.join(submoduleGitDir, "config"),
      originConfig("git@github.com:arul28/sub.git"),
      "utf8",
    );
    const submoduleRoot = path.join(tmp, "lane-x", "sub");
    fs.mkdirSync(submoduleRoot, { recursive: true });
    fs.writeFileSync(path.join(submoduleRoot, ".git"), `gitdir: ${submoduleGitDir}\n`, "utf8");

    expect(readGitOriginUrl(submoduleRoot)).toBe("git@github.com:arul28/sub.git");
  });

  it("returns null when the checkout has no git metadata", () => {
    const dir = makeTempDir();
    expect(readGitOriginUrl(path.join(dir, "not-a-repo"))).toBeNull();
  });

  it("re-reads after the config changes", () => {
    const root = writeRepo(path.join(makeTempDir(), "repo"), originConfig("git@github.com:arul28/ADE.git"));
    expect(readGitOriginUrl(root)).toBe("git@github.com:arul28/ADE.git");

    const configPath = path.join(root, ".git", "config");
    fs.writeFileSync(configPath, originConfig("git@github.com:arul28/renamed.git"), "utf8");
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(configPath, future, future);

    expect(readGitOriginUrl(root)).toBe("git@github.com:arul28/renamed.git");
  });
});

describe("toShallowRecentProjectSummary", () => {
  it("carries the git origin so the tab bar can join checkouts of one repo", () => {
    // IPC.projectListRecent serves the renderer from this shallow path. Without
    // gitOriginUrl here, every tab arrives origin-less and nothing ever merges.
    const root = writeRepo(path.join(makeTempDir(), "repo"), originConfig("git@github.com:arul28/ADE.git"));

    const summary = toShallowRecentProjectSummary({
      rootPath: root,
      displayName: "ADE",
      lastOpenedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(summary.gitOriginUrl).toBe("git@github.com:arul28/ADE.git");
  });

  it("omits the origin for a project that is not on disk", () => {
    const summary = toShallowRecentProjectSummary({
      rootPath: path.join(makeTempDir(), "gone"),
      displayName: "Gone",
      lastOpenedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(summary.exists).toBe(false);
    expect(summary.gitOriginUrl).toBeUndefined();
  });

  it("carries a persisted remote origin without touching the remote filesystem", () => {
    const summary = toShallowRecentProjectSummary({
      rootPath: "/srv/ade/app",
      displayName: "App",
      lastOpenedAt: "2026-07-27T00:00:00.000Z",
      remote: {
        targetId: "studio",
        projectId: "project-1",
        runtimeName: "Mac Studio",
        hostname: "studio.local",
        gitOriginUrl: "git@github.com:arul28/ADE.git",
      },
    });

    expect(summary.kind).toBe("remote");
    expect(summary.gitOriginUrl).toBe("git@github.com:arul28/ADE.git");
  });
});

// ---------------------------------------------------------------------------
// inspectRecentProject — the memoized database read
//
// The read is memoized on a fingerprint of the project database, but the lane
// count is recomputed from disk on every call. These cases pin both halves of
// that split: nothing that changes what the count *is* may be served
// from the memo. A wrong-but-fast recent-projects list is worse than a slow
// one, so each row here is a way the fast path could lie.
// ---------------------------------------------------------------------------

const MEMO_NOW = "2026-04-02T12:00:00.000Z";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

function memoEntry(rootPath: string) {
  return { rootPath, displayName: path.basename(rootPath), lastOpenedAt: MEMO_NOW };
}

type LaneProjectDb = Awaited<ReturnType<typeof openKvDb>>;

type LaneProjectFixture = {
  projectRoot: string;
  layout: ReturnType<typeof resolveAdeLayout>;
  /** Held open across both inspections so the writes stay in the WAL. */
  db: LaneProjectDb;
  lanePath: string;
};

function insertProject(db: LaneProjectDb, projectId: string, projectRoot: string): void {
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, projectRoot, path.basename(projectRoot), "main", MEMO_NOW, MEMO_NOW],
  );
}

function insertLane(
  db: LaneProjectDb,
  args: {
    laneId: string;
    projectId: string;
    laneType: "primary" | "worktree";
    worktreePath: string;
    status?: string;
    archivedAt?: string | null;
  },
): void {
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
      `feature/${args.laneId}`,
      args.worktreePath,
      null,
      args.laneType === "primary" ? 1 : 0,
      null,
      null,
      null,
      null,
      args.status ?? "active",
      MEMO_NOW,
      args.archivedAt ?? null,
    ],
  );
}

/**
 * A project with one primary lane and one worktree lane that exists on disk,
 * so a correct summary reports a lane count of 2.
 */
async function seedLaneProject(): Promise<LaneProjectFixture> {
  const projectRoot = makeTempDir();
  const layout = resolveAdeLayout(projectRoot);
  const lanePath = path.join(layout.worktreesDir, "lane-managed");
  fs.mkdirSync(lanePath, { recursive: true });

  const db = await openKvDb(layout.dbPath, createLogger());
  insertProject(db, "proj-memo", projectRoot);
  insertLane(db, {
    laneId: "lane-primary",
    projectId: "proj-memo",
    laneType: "primary",
    worktreePath: projectRoot,
  });
  insertLane(db, {
    laneId: "lane-managed",
    projectId: "proj-memo",
    laneType: "worktree",
    worktreePath: lanePath,
  });
  return { projectRoot, layout, db, lanePath };
}

describe("inspectRecentProject lane count is never served stale", () => {
  const mutations: {
    change: string;
    expectedAfter: number;
    mutate: (fixture: LaneProjectFixture) => void;
  }[] = [
    {
      // The database is still open, so this write lands only in `ade.db-wal`
      // and leaves `ade.db`'s mtime and size untouched. A fingerprint taken
      // from the main file alone would keep reporting the old count.
      change: "a lane is added while the store is open",
      expectedAfter: 3,
      mutate: (fixture) => {
        const addedPath = path.join(fixture.layout.worktreesDir, "lane-added");
        fs.mkdirSync(addedPath, { recursive: true });
        insertLane(fixture.db, {
          laneId: "lane-added",
          projectId: "proj-memo",
          laneType: "worktree",
          worktreePath: addedPath,
        });
      },
    },
    {
      change: "a lane is archived",
      expectedAfter: 1,
      mutate: (fixture) => {
        fixture.db.run(
          "update lanes set status = 'archived', archived_at = ? where id = 'lane-managed'",
          [MEMO_NOW],
        );
      },
    },
    {
      // Nothing in the database changes here at all, so no fingerprint can
      // catch it: the count has to be recomputed against the disk each call.
      change: "a lane's worktree is deleted from disk",
      expectedAfter: 1,
      mutate: (fixture) => {
        fs.rmSync(fixture.lanePath, { recursive: true, force: true });
      },
    },
  ];

  it.each(mutations)("reflects the change when $change", async ({ mutate, expectedAfter }) => {
    const fixture = await seedLaneProject();
    try {
      expect(inspectRecentProject(memoEntry(fixture.projectRoot)).summary.laneCount).toBe(2);

      mutate(fixture);

      expect(inspectRecentProject(memoEntry(fixture.projectRoot)).summary.laneCount).toBe(expectedAfter);
    } finally {
      fixture.db.close();
    }
  });

  it("picks up a project database created after an earlier summary", async () => {
    const projectRoot = makeTempDir();
    const layout = resolveAdeLayout(projectRoot);

    expect(inspectRecentProject(memoEntry(projectRoot)).projectId).toBeNull();

    const db = await openKvDb(layout.dbPath, createLogger());
    try {
      insertProject(db, "proj-late", projectRoot);

      expect(inspectRecentProject(memoEntry(projectRoot)).projectId).toBe("proj-late");
    } finally {
      db.close();
    }
  });

  it("still reports a project root that disappears after a summary", async () => {
    const fixture = await seedLaneProject();
    fixture.db.close();

    expect(inspectRecentProject(memoEntry(fixture.projectRoot)).summary.exists).toBe(true);

    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });

    const summary = inspectRecentProject(memoEntry(fixture.projectRoot)).summary;
    expect(summary.exists).toBe(false);
    expect(summary.laneCount).toBeUndefined();
  });
});
