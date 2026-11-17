import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloudBackupReport, CloudLaneBackup, CloudLaneBackupFacts } from "../../../../account-directory/src/cloud/contract";
import type { CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import { prepareLaneBranchFromBackup, restoreLaneBackupIfNeeded, runLaneBackups } from "./cloudLaneBackup";

/**
 * A lane's unpushed work lives only in its backup once its computer is
 * deleted, so this proves with real git that the backup holds all of it and
 * the restore puts it back exactly, never over newer work and never by a
 * push. Only the account server is faked (the network boundary).
 */

const LANE = "lane-pricing";
const BRANCH = "ade/pricing";
const silent = () => {};
const logger = { info: silent, warn: silent };

let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const write = (dir: string, file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};

/** The account server as the computer sees it: backups in memory, one per (machine, lane). */
function fakeServer() {
  const rows = new Map<string, CloudLaneBackup & { bundle: Buffer; patch: Buffer }>();
  const pending = new Map<string, { parts: Record<string, Buffer[]>; start: { fingerprint: string; facts: CloudLaneBackupFacts } }>();
  const reports: CloudBackupReport[] = [];
  const deleted: string[] = [];
  const key = (machineKey: string, laneId: string) => `${machineKey}/${laneId}`;
  const api = {
    laneBackups: async (laneId?: string | null) => [...rows.values()].filter((row) => !laneId || row.laneId === laneId),
    startLaneBackup: async (machineKey: string, laneId: string, start: { fingerprint: string; facts: CloudLaneBackupFacts }) => {
      const uploadId = `${machineKey}-${laneId}-${pending.size}`;
      pending.set(uploadId, { parts: { bundle: [], patch: [] }, start });
      return { uploadId, partBytes: 1024 };
    },
    putLaneBackupPart: async (_m: string, _l: string, uploadId: string, kind: string, part: number, _i: string, bytes: Buffer) => {
      pending.get(uploadId)!.parts[kind]![part - 1] = Buffer.from(bytes);
      return { ok: true, bytes: bytes.byteLength };
    },
    commitLaneBackup: async (machineKey: string, laneId: string, uploadId: string) => {
      const upload = pending.get(uploadId)!;
      const bundle = Buffer.concat(upload.parts.bundle!);
      const patch = Buffer.concat(upload.parts.patch!);
      const row = {
        ...upload.start.facts, machineKey, laneId, instanceId: "box", fingerprint: upload.start.fingerprint,
        bundleBytes: bundle.byteLength, patchBytes: patch.byteLength, bundleParts: upload.parts.bundle!.length, patchParts: upload.parts.patch!.length,
        savedAt: Date.now() + rows.size, restoredAt: null, restoredByMachineKey: null, bundle, patch,
      };
      rows.set(key(machineKey, laneId), row);
      return row;
    },
    readLaneBackupPart: async (machineKey: string, laneId: string, kind: "bundle" | "patch", part: number) => {
      const row = rows.get(key(machineKey, laneId))!;
      const bytes = kind === "bundle" ? row.bundle : row.patch;
      const slice = bytes.subarray((part - 1) * 1024, part * 1024);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
    // As the server: the computer's own backup of the lane, and every one of the lane it restored.
    deleteLaneBackup: async (machineKey: string, laneId: string) => {
      const gone = [...rows.entries()].filter(([, row]) => row.laneId === laneId && (row.machineKey === machineKey || row.restoredByMachineKey === machineKey));
      for (const [id] of gone) {
        deleted.push(id);
        rows.delete(id);
      }
      return { deleted: gone.length };
    },
    markLaneBackupRestored: async (machineKey: string, laneId: string) => {
      const row = rows.get(key(machineKey, laneId))!;
      row.restoredAt = Date.now();
      row.restoredByMachineKey = "key-new";
      return { ok: true };
    },
    reportLaneBackups: async (report: CloudBackupReport) => {
      reports.push(report);
      return { state: report.complete && report.lanes.every((lane) => ["clean", "saved", "unchanged"].includes(lane.state)) ? "current" as const : "failed" as const };
    },
  };
  return { api: api as unknown as CloudApiClient, rows, reports, deleted };
}

/** GitHub as a bare repository with `main` and the lane's branch at one pushed commit. */
function seedOrigin(): { origin: string; source: string } {
  const origin = path.join(root, "origin.git");
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  const source = path.join(root, "source");
  git(root, "clone", "-q", origin, source);
  write(source, "README.md", "hello\n");
  write(source, "gone.txt", "to be deleted\n");
  write(source, "edit.txt", "v1\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  git(source, "push", "-q", "origin", "HEAD:main");
  git(source, "checkout", "-q", "-b", BRANCH);
  git(source, "push", "-q", "-u", "origin", BRANCH);
  return { origin, source };
}

/** The lane's work that only this computer has: two commits, and every kind of uncommitted change. */
function makeUnpushedWork(source: string): void {
  write(source, "feature.ts", "export const a = 1;\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "one");
  write(source, "feature.ts", "export const a = 2;\n");
  git(source, "commit", "-q", "-am", "two");
  write(source, "edit.txt", "v2 staged\n");
  git(source, "add", "edit.txt");
  write(source, "edit.txt", "v3 unstaged\n");
  fs.rmSync(path.join(source, "gone.txt"));
  write(source, "notes/new file.md", "untracked\n");
  write(source, "image.bin", Buffer.from([0, 1, 2, 255, 254, 0, 10]));
  write(source, "latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  fs.symlinkSync("README.md", path.join(source, "link-to-readme"));
  write(source, ".gitignore", "secret.env\n");
  write(source, "secret.env", "TOKEN=ignored\n");
}

/** Every file a person sees in the lane (not .git), with its bytes or its link target. */
function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const next = path.join(rel, entry.name);
      const full = path.join(dir, next);
      if (entry.isSymbolicLink()) out[next] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) walk(next);
      else out[next] = fs.readFileSync(full).toString("base64");
    }
  };
  walk("");
  return out;
}

const backupLanes = (worktreePath: string) => async () => ({ complete: true, lanes: [{ laneId: LANE, laneName: "pricing", worktreePath, projectKey: "github.com/acme/web" }] });
const save = (server: ReturnType<typeof fakeServer>, worktreePath: string, machineKey = "key-old") =>
  runLaneBackups({ api: server.api, instanceId: "box", machineKey, logger, lanes: backupLanes(worktreePath), mayGoOn: () => true });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-backup-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lane backups", () => {
  it("a new computer gets the lane's work back exactly: commits, staged, unstaged, deleted, untracked, binary and symlink; ignored files stay out; nothing reaches GitHub", async () => {
    const { origin, source } = seedOrigin();
    makeUnpushedWork(source);
    const originBefore = git(origin, "for-each-ref");
    const server = fakeServer();

    const saved = await save(server, source);

    expect(saved).toMatchObject({ state: "current", saved: 1 });
    expect(server.reports.at(-1)!.lanes).toEqual([expect.objectContaining({ laneId: LANE, state: "saved" })]);
    // Nothing pushed, no branch or ref left behind, the person's staging as it was.
    expect(git(origin, "for-each-ref")).toBe(originBefore);
    expect(git(source, "for-each-ref", "--format=%(refname)").split("\n").filter((ref) => ref.includes("ade-backup"))).toEqual([]);
    expect(git(source, "diff", "--cached", "--name-only")).toBe("edit.txt");
    // A second save of the same work uploads nothing.
    const again = await save(server, source);
    expect(again).toMatchObject({ state: "current", saved: 0, unchanged: 1 });

    // A new computer clones GitHub's copy of the branch and the lane starts there.
    const target = path.join(root, "target");
    git(root, "clone", "-q", "-b", BRANCH, origin, target);
    const outcome = await restoreLaneBackupIfNeeded({ api: server.api, instanceId: "box2", machineKey: "key-new", laneId: LANE, worktreePath: target, projectRoot: target, logger });

    expect(outcome).toBe("applied");
    const expected = treeOf(source);
    delete expected["secret.env"];
    expect(treeOf(target)).toEqual(expected);
    expect(git(target, "log", "--format=%s", "-3")).toBe(git(source, "log", "--format=%s", "-3"));
    expect(git(target, "rev-parse", "HEAD")).toBe(git(source, "rev-parse", "HEAD"));
    expect(git(origin, "for-each-ref")).toBe(originBefore);
    // The restored backup is marked, and once the new computer's lane is on GitHub, its backups go.
    expect(server.rows.get(`key-old/${LANE}`)!.restoredByMachineKey).toBe("key-new");
    git(target, "add", "-A");
    git(target, "commit", "-q", "-m", "done");
    git(target, "push", "-q", "origin", BRANCH);
    const clean = await runLaneBackups({ api: server.api, instanceId: "box2", machineKey: "key-new", logger, lanes: backupLanes(target), mayGoOn: () => true });
    expect(clean).toMatchObject({ state: "current", clean: 1 });
    expect(server.rows.size).toBe(0);
  });

  it.each<[string, (target: string) => void]>([
    ["uncommitted work of its own", (target) => write(target, "mine.txt", "newer\n")],
    ["a commit past the backup's base that the backup lacks", (target) => {
      write(target, "other.txt", "other\n");
      git(target, "add", "-A");
      git(target, "commit", "-q", "-m", "elsewhere");
    }],
  ])("a lane with %s is left as it is, and the backup stays", async (_label, change) => {
    const { origin, source } = seedOrigin();
    makeUnpushedWork(source);
    const server = fakeServer();
    await save(server, source);
    const target = path.join(root, "target");
    git(root, "clone", "-q", "-b", BRANCH, origin, target);
    change(target);
    const before = treeOf(target);
    const head = git(target, "rev-parse", "HEAD");

    const outcome = await restoreLaneBackupIfNeeded({ api: server.api, instanceId: "box2", machineKey: "key-new", laneId: LANE, worktreePath: target, projectRoot: target, logger });

    expect(["kept_newer_local_work", "kept_branch_differs"]).toContain(outcome);
    expect([treeOf(target), git(target, "rev-parse", "HEAD")]).toEqual([before, head]);
    expect(server.rows.get(`key-old/${LANE}`)!.restoredByMachineKey).toBeNull();
  });

  it("a lane at the backup's commit: one that holds the work is left alone and marked restored; one with other uncommitted work keeps it", async () => {
    const { source } = seedOrigin();
    makeUnpushedWork(source);
    const server = fakeServer();
    await save(server, source);
    const restore = () => restoreLaneBackupIfNeeded({ api: server.api, instanceId: "box2", machineKey: "key-new", laneId: LANE, worktreePath: source, projectRoot: source, logger });

    expect(await restore()).toBe("already_here");
    expect(server.rows.get(`key-old/${LANE}`)!.restoredByMachineKey).toBe("key-new");

    write(source, "feature.ts", "export const a = 3; // newer than the backup\n");
    const before = treeOf(source);
    expect(await restore()).toBe("kept_newer_local_work");
    expect(treeOf(source)).toEqual(before);
  });

  it("a branch never pushed is made on the new computer from the backup, without a push, and its work is put back", async () => {
    const { origin, source } = seedOrigin();
    git(source, "checkout", "-q", "-b", "ade/never-pushed", "main");
    makeUnpushedWork(source);
    const originBefore = git(origin, "for-each-ref");
    const server = fakeServer();
    await save(server, source);
    const project = path.join(root, "project");
    git(root, "clone", "-q", origin, project);

    // The desktop's restart names `origin/<branch>`; the server's continue names the branch.
    const made = await prepareLaneBranchFromBackup({ api: server.api, machineKey: "key-new", laneId: LANE, branchRef: "origin/ade/never-pushed", projectRoot: project, logger });

    expect(made).toEqual({ created: true, branch: "ade/never-pushed" });
    expect(git(project, "rev-parse", "refs/heads/ade/never-pushed")).toBe(git(source, "rev-parse", "HEAD"));
    git(project, "checkout", "-q", "ade/never-pushed");
    expect(await restoreLaneBackupIfNeeded({ api: server.api, instanceId: "box2", machineKey: "key-new", laneId: LANE, worktreePath: project, projectRoot: project, logger })).toBe("applied");
    const expected = treeOf(source);
    delete expected["secret.env"];
    expect(treeOf(project)).toEqual(expected);
    expect(git(origin, "for-each-ref")).toBe(originBefore);
  });

  it("a lane too large to save keeps the report from being current", async () => {
    const { source } = seedOrigin();
    // Untracked bytes far past the cap: refused before anything is hashed or sent.
    write(source, "huge.bin", Buffer.alloc(210 * 1024 * 1024, 1));
    const server = fakeServer();

    const saved = await save(server, source);

    expect(saved).toMatchObject({ state: "failed", failed: 1 });
    expect(server.reports.at(-1)!.lanes).toEqual([expect.objectContaining({ state: "too_large", reason: expect.stringContaining("The computer is kept until then.") })]);
    expect(server.rows.size).toBe(0);
  });
});
