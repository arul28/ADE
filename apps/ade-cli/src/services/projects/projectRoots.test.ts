import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { findLinkedLaneWorktreeRoot, isRegisteredLinkedLanePath } from "./projectRoots";
import { detectProjectLaunchContext } from "../../tuiClient/project";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (file: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...values: unknown[]): void };
    close(): void;
  };
};

const roots: string[] = [];

function makeLinkedWorktree(options: { ownDatabase?: boolean; registered?: boolean; absolutePointers?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linked-worktree-"));
  roots.push(root);
  const parent = path.join(root, "repository");
  const worktree = path.join(root, "repo-worktrees", "feature");
  const nested = path.join(worktree, "apps", "ade-cli");
  const admin = path.join(parent, ".git", "worktrees", "feature");
  const parentAde = path.join(parent, ".ade");

  fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
  fs.mkdirSync(path.join(parentAde), { recursive: true });
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(worktree, ".ade"), { recursive: true });
  const gitdirPointer = options.absolutePointers ? admin : path.relative(worktree, admin);
  const worktreeGitFile = path.join(worktree, ".git");
  const backPointer = options.absolutePointers ? worktreeGitFile : path.relative(admin, worktreeGitFile);
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitdirPointer}\n`);
  fs.writeFileSync(path.join(admin, "gitdir"), `${backPointer}\n`);

  const db = new DatabaseSync(path.join(parentAde, "ade.db"));
  db.exec("create table lanes (worktree_path text, attached_root_path text, archived_at text)");
  if (options.registered) {
    db.prepare("insert into lanes (worktree_path, attached_root_path, archived_at) values (?, null, null)")
      .run(worktree);
  }
  db.close();

  if (options.ownDatabase) {
    fs.writeFileSync(path.join(worktree, ".ade", "ade.db"), "standalone project database");
  }

  return { parent, worktree, nested };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 });
});

describe("linked lane project roots", () => {
  it("resolves a registered sibling worktree to its parent project", () => {
    const fixture = makeLinkedWorktree({ ownDatabase: true, registered: true, absolutePointers: true });

    expect(findLinkedLaneWorktreeRoot(fixture.nested)).toEqual({
      projectRoot: fs.realpathSync.native(fixture.parent),
      workspaceRoot: fs.realpathSync.native(fixture.worktree),
    });
    expect(isRegisteredLinkedLanePath(fixture.nested)).toBe(true);
    expect(detectProjectLaunchContext({ cwd: fixture.nested })).toMatchObject({
      projectRoot: fs.realpathSync.native(fixture.parent),
      workspaceRoot: fs.realpathSync.native(fixture.worktree),
      laneHint: null,
    });
  });

  it("uses the parent for a linked checkout without its own ADE database", () => {
    const fixture = makeLinkedWorktree();

    expect(findLinkedLaneWorktreeRoot(fixture.nested)).toEqual({
      projectRoot: fs.realpathSync.native(fixture.parent),
      workspaceRoot: fs.realpathSync.native(fixture.worktree),
    });
    expect(isRegisteredLinkedLanePath(fixture.nested)).toBe(false);
  });

  it("keeps an unregistered linked checkout with its own database as a separate project", () => {
    const fixture = makeLinkedWorktree({ ownDatabase: true });

    expect(findLinkedLaneWorktreeRoot(fixture.nested)).toBeNull();
    expect(isRegisteredLinkedLanePath(fixture.nested)).toBe(false);
  });

  it("rejects a checkout whose Git metadata does not point back to its worktree", () => {
    const fixture = makeLinkedWorktree({ registered: true });
    const admin = path.join(fixture.parent, ".git", "worktrees", "feature");
    fs.writeFileSync(path.join(admin, "gitdir"), path.join(fixture.parent, ".git"));

    expect(findLinkedLaneWorktreeRoot(fixture.nested)).toBeNull();
    expect(isRegisteredLinkedLanePath(fixture.nested)).toBe(false);
  });
});
