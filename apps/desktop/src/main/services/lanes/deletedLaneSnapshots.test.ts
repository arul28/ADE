import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySavedLaneFiles,
  createRestoredLaneBranches,
  listDeletedLaneSnapshots,
  saveDeletedLaneSnapshot,
} from "./deletedLaneSnapshots";

// Real git in a throwaway repository: what these guard is what git keeps.
const IDENTITY = "-c user.name=t -c user.email=t@t -c protocol.file.allow=always";

let root: string;
let repo: string;
let worktree: string;

function sh(command: string, cwd = repo): string {
  return execSync(command.replace(/(^|&& )git /g, `$1git ${IDENTITY} `), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const lane = () => ({ projectRoot: repo, laneId: "lane-1", laneName: "Lane one", branchName: "lane", worktreePath: worktree, branchGoes: true });

async function requireSave(args: Parameters<typeof saveDeletedLaneSnapshot>[0]) {
  const saved = await saveDeletedLaneSnapshot(args);
  expect(saved, "the save was expected to happen").not.toBeNull();
  return saved!;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-deleted-lane-test-")));
  repo = path.join(root, "repo");
  worktree = path.join(root, "lane");
  sh(`git init -q --bare ${path.join(root, "origin.git")}`, root);
  sh("git init -q -b main repo", root);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  sh("git add . && git commit -qm init");
  sh(`git remote add origin ${path.join(root, "origin.git")} && git push -q -u origin main`);
  sh(`git worktree add -q ${worktree} -b lane`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("deletedLaneSnapshots", () => {
  it("restores uncommitted files byte for byte, past git's output cap and a user's diff tool", async () => {
    const latin1 = Buffer.from([0x72, 0xe9, 0x73, 0x0a]);
    fs.writeFileSync(path.join(worktree, "latin1.txt"), latin1);
    // Together over the 4 MiB ADE captures from git's output.
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(worktree, `big-${index}.txt`), `${"x".repeat(1023)}\n`.repeat(1024));
    }
    sh("git config diff.external false");

    const saved = await requireSave(lane());
    sh(`git worktree remove --force ${worktree}`);
    const fresh = path.join(root, "fresh");
    sh(`git worktree add -q ${fresh} ${saved.baseCommit}`);

    await expect(applySavedLaneFiles(repo, saved, fresh)).resolves.toEqual({ restored: true, warning: null });
    expect(fs.readFileSync(path.join(fresh, "latin1.txt")).equals(latin1)).toBe(true);
    expect(fs.readdirSync(fresh).filter((name) => name.startsWith("big-"))).toHaveLength(5);
    expect(fs.statSync(path.join(fresh, "big-4.txt")).size).toBe(1024 * 1024);
  });

  it.each([
    {
      label: "remote",
      arrange: () => {
        sh("git push -q -u origin lane", worktree);
        const other = path.join(root, "other");
        sh(`git clone -q -b lane ${path.join(root, "origin.git")} ${other}`, root);
        sh("git commit -q --allow-empty -m only-here && git push -q origin lane", other);
        sh("git fetch -q origin");
        return { remoteGoes: "origin", goneRefs: ["refs/heads/lane", "refs/remotes/origin/lane"] };
      },
    },
    {
      label: "previous",
      arrange: () => {
        sh("git commit -q --allow-empty -m only-here", worktree);
        sh("git checkout -q -b elsewhere main", worktree);
        return { remoteGoes: null, goneRefs: ["refs/heads/lane"] };
      },
    },
  ])("brings back commits only the $label tip held, on their own branch", async ({ label, arrange }) => {
    const { remoteGoes, goneRefs } = arrange();
    await requireSave({ ...lane(), remoteGoes });
    sh(`git worktree remove --force ${worktree}`);
    for (const ref of goneRefs) sh(`git update-ref -d ${ref}`);
    sh("git gc -q --prune=now");

    const [listed] = await listDeletedLaneSnapshots(repo);
    expect(listed!.extraTips.map((tip) => tip.label)).toEqual([label]);
    const { branchName, extraBranches } = await createRestoredLaneBranches(repo, listed!);
    expect(branchName).toBe("lane");
    expect(extraBranches).toEqual([`lane-${label}`]);
    expect(sh(`git log -1 --format=%s lane-${label}`)).toBe("only-here");
  });

  const addSubmodule = () => {
    const upstream = path.join(root, "upstream");
    sh("git init -q -b main upstream", root);
    fs.writeFileSync(path.join(upstream, "s.txt"), "s\n");
    sh("git add . && git commit -qm s", upstream);
    sh(`git submodule add -q ${upstream} sub && git commit -qm sub`, worktree);
    return path.join(worktree, "sub");
  };

  it.each([
    {
      name: "an untracked clone with no remote",
      arrange: () => sh("git init -q nested && cd nested && echo p > p && git add . && git commit -qm n", worktree),
      refused: /git repository nested/i,
    },
    {
      name: "a committed repository with newer commits",
      arrange: () => {
        sh("git init -q n && cd n && echo p > p && git add . && git commit -qm n", worktree);
        sh("git add n && git commit -qm embed", worktree);
        sh("echo q > q && git add . && git commit -qm more", path.join(worktree, "n"));
      },
      refused: /git repository n /i,
    },
    {
      name: "a submodule with uncommitted files",
      arrange: () => fs.writeFileSync(path.join(addSubmodule(), "dirty.txt"), "x"),
      refused: /submodule sub has uncommitted/i,
    },
    {
      name: "a submodule commit held only by a local tag",
      arrange: () => sh("git commit -q --allow-empty -m local && git tag t", addSubmodule()),
      refused: /submodule sub has commits/i,
    },
    {
      name: "a clean submodule pinned to a tag-only commit",
      arrange: () => {
        const sub = addSubmodule();
        sh("git commit -q --allow-empty -m pin && git tag t && git checkout -q --detach t && git branch -q -D main", sub);
        sh("git add sub && git commit -qm pin", worktree);
      },
      refused: null,
    },
  ])("handles work in another repository: $name", async ({ arrange, refused }) => {
    arrange();
    const before = sh("git for-each-ref refs/ade");
    const save = saveDeletedLaneSnapshot({ ...lane(), branchGoes: false });
    if (refused) {
      await expect(save).rejects.toThrow(refused);
      expect(sh("git for-each-ref refs/ade"), "a refused delete leaves no half save").toBe(before);
    } else {
      await expect(save).resolves.not.toThrow();
    }
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it("does not count a branch another running delete will remove as keeping a commit", async () => {
    sh("git commit -q --allow-empty -m shared", worktree);
    sh("git branch twin lane");
    const head = sh("git rev-parse lane");

    await expect(saveDeletedLaneSnapshot(lane())).resolves.toBeNull();
    const saved = await requireSave({ ...lane(), otherBranchesGoing: ["twin"] });
    expect(saved.baseCommit).toBe(head);
    expect(saved.uncommitted).toBe(false);
  });
});
