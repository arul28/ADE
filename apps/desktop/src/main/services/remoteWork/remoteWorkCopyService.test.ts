import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRemoteWorkCopyService,
  registerRemoteWorkShellCheck,
  releaseChatRemoteWork,
  remoteWorkCopiesInRepo,
} from "./remoteWorkCopyService";
import { createRemoteWorkFiles } from "./remoteWorkFiles";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "ADE Test",
  GIT_AUTHOR_EMAIL: "test@ade.invalid",
  GIT_COMMITTER_NAME: "ADE Test",
  GIT_COMMITTER_EMAIL: "test@ade.invalid",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

describe("remote work copy", () => {
  it("never syncs over work made in the copy that is not pushed, and syncs once it is", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-work-"));
    const origin = path.join(root, "origin.git");
    const projectRoot = path.join(root, "project");
    try {
      git(root, "init", "--bare", "-b", "main", origin);
      git(root, "clone", origin, projectRoot);
      fs.writeFileSync(path.join(projectRoot, "app.txt"), "v1\n");
      git(projectRoot, "add", "-A");
      git(projectRoot, "commit", "-m", "first");
      git(projectRoot, "push", "origin", "HEAD:main");
      const head = git(projectRoot, "rev-parse", "HEAD");

      const service = createRemoteWorkCopyService({ projectRoot, adeHome: path.join(root, "ade-home"), freeBytes: () => null });
      const owner = "remote:machine-a:chat-1";
      const source = { head, fetchRef: "main", branch: "main" };
      const first = await service.prepare(owner, source);
      first.done();
      expect(first.created).toBe(true);

      // A file made there that git does not track (an xcodegen project) is
      // not work to protect from a sync: it stays, and the sync goes ahead.
      fs.writeFileSync(path.join(first.path, "generated.txt"), "made by a tool\n");
      const kept = await service.prepare(owner, source);
      kept.done();
      expect(kept.synced).toBe(true);
      expect(kept.keptFiles).toEqual(["generated.txt"]);
      expect(fs.readFileSync(path.join(first.path, "generated.txt"), "utf8")).toBe("made by a tool\n");

      // The chat's next commit has a file of the same name: the sync is
      // refused, naming it, and the file made there is left as it was.
      fs.writeFileSync(path.join(projectRoot, "generated.txt"), "the chat's own\n");
      git(projectRoot, "add", "-A");
      git(projectRoot, "commit", "-m", "same name");
      const clashing = { ...source, head: git(projectRoot, "rev-parse", "HEAD") };
      await expect(service.prepare(owner, clashing)).rejects.toMatchObject({
        code: "copy_has_unsynced_work",
        message: expect.stringContaining("generated.txt"),
      });
      expect(fs.readFileSync(path.join(first.path, "generated.txt"), "utf8")).toBe("made by a tool\n");
      expect(git(first.path, "rev-parse", "HEAD")).toBe(head);

      // An agent edits a tracked file in the copy and commits it there, without a push.
      fs.writeFileSync(path.join(first.path, "app.txt"), "work\n");
      await expect(service.prepare(owner, source)).rejects.toMatchObject({
        code: "copy_has_unsynced_work",
        message: expect.stringContaining("app.txt"),
      });
      git(first.path, "add", "-A");
      git(first.path, "commit", "-m", "made there");
      await expect(service.prepare(owner, source)).rejects.toMatchObject({ code: "copy_has_unsynced_work" });
      // An automatic cleanup keeps it too.
      await expect(service.release(owner, { keepUnsynced: true })).resolves.toBe(false);
      expect(fs.readFileSync(path.join(first.path, "app.txt"), "utf8")).toBe("work\n");

      // Pushed, the work is safe on origin: the sync goes ahead and resets the copy.
      git(first.path, "push", "origin", "HEAD:refs/heads/made-there");
      const synced = await service.prepare(owner, source);
      synced.done();
      expect(synced).toMatchObject({ created: false, synced: true, path: first.path });
      expect(git(first.path, "rev-parse", "HEAD")).toBe(head);
      // trimEnd: a Windows checkout writes it back with CRLF.
      expect(fs.readFileSync(path.join(first.path, "app.txt"), "utf8").trimEnd()).toBe("v1");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A chat on another machine deleting its own copies here: `ade shell clean
 * --machine` (only in checkouts of the repository the call landed in), or its
 * brain saying the chat was archived or deleted (`ended`: every copy it has
 * here). Never another chat's copy, never work nobody pushed when asked to
 * keep it, and a busy copy is kept without failing the rest.
 */
describe("a chat on another machine releasing its copies here", () => {
  const owner = "remote:machine-a:chat-1";
  const otherOwner = "remote:machine-a:chat-2";
  let root = "";
  let adeHome = "";
  const offShellChecks: Array<() => void> = [];

  /** A bare origin and `checkouts` clones of it, each pushed to once. */
  const makeRepo = (name: string, checkouts: string[]) => {
    const origin = path.join(root, `${name}.git`);
    git(root, "init", "--bare", "-b", "main", origin);
    const roots = checkouts.map((checkout) => {
      const projectRoot = path.join(root, checkout);
      git(root, "clone", "-q", origin, projectRoot);
      return projectRoot;
    });
    fs.writeFileSync(path.join(roots[0]!, "app.txt"), "v1\n");
    git(roots[0]!, "add", "-A");
    git(roots[0]!, "commit", "-m", "first");
    git(roots[0]!, "push", "-q", "origin", "HEAD:main");
    for (const other of roots.slice(1)) git(other, "pull", "-q", "origin", "main");
    return { roots, head: git(roots[0]!, "rev-parse", "HEAD") };
  };
  const serviceFor = (projectRoot: string) => createRemoteWorkCopyService({ projectRoot, adeHome, freeBytes: () => null });
  const makeCopy = async (projectRoot: string, copyOwner: string, head: string): Promise<string> => {
    const prepared = await serviceFor(projectRoot).prepare(copyOwner, { head, fetchRef: "main", branch: "main" });
    prepared.done();
    return prepared.path;
  };
  const roots = (copies: ReadonlyArray<{ projectRoot: string }>) => copies.map((copy) => copy.projectRoot).sort();

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-work-release-")));
    adeHome = path.join(root, "ade-home");
  });
  afterEach(() => {
    for (const off of offShellChecks.splice(0)) off();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("`ade shell clean` removes the chat's copies in every checkout of the repository, and nothing else", async () => {
    const repo = makeRepo("repo", ["main-checkout", "sandbox-checkout"]);
    const [here, sandbox] = repo.roots as [string, string];
    const other = makeRepo("other", ["other-checkout"]);
    const [elsewhere] = other.roots as [string];
    const mineHere = await makeCopy(here, owner, repo.head);
    const mineInSandbox = await makeCopy(sandbox, owner, repo.head);
    const mineInOtherRepo = await makeCopy(elsewhere, owner, other.head);
    const theirsInSandbox = await makeCopy(sandbox, otherOwner, repo.head);

    // What `find_remote_work_copy` answers: this repository's checkouts holding this chat's copy, this one first.
    expect(remoteWorkCopiesInRepo(here, owner, adeHome).map((copy) => copy.projectRoot)).toEqual([here, sandbox]);

    const { removed, kept } = await releaseChatRemoteWork({ projectRoot: here, owner, ended: false, keepUnsynced: false, adeHome });

    expect(roots(removed)).toEqual([here, sandbox].sort());
    expect(kept).toEqual([]);
    expect(fs.existsSync(mineHere)).toBe(false);
    expect(fs.existsSync(mineInSandbox)).toBe(false);
    // Another repository's copy, and another chat's, are not this call's to delete.
    expect(fs.existsSync(mineInOtherRepo)).toBe(true);
    expect(serviceFor(elsewhere).get(owner)).not.toBeNull();
    expect(fs.existsSync(theirsInSandbox)).toBe(true);
    expect(serviceFor(sandbox).get(otherOwner)).not.toBeNull();
  });

  it("an ended chat's copies go from every project, its shells there stopped, keeping unpushed work and a copy still busy", async () => {
    const repo = makeRepo("repo", ["main-checkout", "sandbox-checkout", "busy-checkout"]);
    const [here, sandbox, busy] = repo.roots as [string, string, string];
    const other = makeRepo("other", ["other-checkout"]);
    const [elsewhere] = other.roots as [string];
    const clean = await makeCopy(here, owner, repo.head);
    const withShell = await makeCopy(sandbox, owner, repo.head);
    const withUnpushedWork = await makeCopy(elsewhere, owner, other.head);
    const stillBusy = await makeCopy(busy, owner, repo.head);
    const theirs = await makeCopy(here, otherOwner, repo.head);
    fs.writeFileSync(path.join(withUnpushedWork, "app.txt"), "work\n");

    // The sandbox runtime runs the chat's shell and can stop it; the busy one's shell does not stop.
    let shellRuns = true;
    offShellChecks.push(registerRemoteWorkShellCheck(
      sandbox,
      (shellOwner) => shellRuns && shellOwner === owner,
      (shellOwner) => { if (shellOwner === owner) shellRuns = false; },
    ));
    offShellChecks.push(registerRemoteWorkShellCheck(busy, (shellOwner) => shellOwner === owner));

    const { removed, kept } = await releaseChatRemoteWork({ projectRoot: here, owner, ended: true, keepUnsynced: true, adeHome });

    expect(roots(removed)).toEqual([here, sandbox].sort());
    expect(roots(kept)).toEqual([busy, elsewhere].sort());
    expect(shellRuns).toBe(false);
    expect(fs.existsSync(clean)).toBe(false);
    expect(fs.existsSync(withShell)).toBe(false);
    expect(fs.readFileSync(path.join(withUnpushedWork, "app.txt"), "utf8")).toBe("work\n");
    expect(fs.existsSync(stillBusy)).toBe(true);
    expect(fs.existsSync(theirs)).toBe(true);
    expect(serviceFor(here).get(otherOwner)).not.toBeNull();
  });
});

describe("files pushed into a work copy", () => {
  const owner = "remote:machine-a:chat-1";
  let root = "";
  let copy = "";
  const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
  /** Every file under the temp root with its content, so any stray write shows. */
  const snapshot = (): Record<string, string> => {
    const files: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) files[path.relative(root, full)] = `-> ${fs.readlinkSync(full)}`;
        else if (entry.isDirectory()) walk(full);
        else files[path.relative(root, full)] = fs.readFileSync(full, "utf8");
      }
    };
    walk(root);
    return files;
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-work-files-")));
    copy = path.join(root, "copy");
    fs.mkdirSync(path.join(copy, ".git"), { recursive: true });
    fs.writeFileSync(path.join(copy, ".git", "config"), "[core]\n");
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), path.join(copy, "out"), process.platform === "win32" ? "junction" : "dir");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    "../x",
    "/abs/x",
    "C:\\x",
    ".git/config",
    ".git./config",
    "dir/NUL",
    "a:b",
    "out/x",
  ])("refuses a push to %s and writes nothing anywhere", (requested) => {
    const files = createRemoteWorkFiles();
    const bytes = Buffer.from("payload");
    const before = snapshot();

    let refusal: unknown;
    try {
      files.beginPush({ owner, copyRoot: copy, path: requested, size: bytes.length, sha256: sha(bytes) });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toMatchObject({ code: "invalid_path" });
    expect(snapshot()).toEqual(before);
    expect(fs.readdirSync(path.join(root, "outside"))).toEqual([]);
  });

  it("lands a nested push byte-identical, and writes nothing when the hash does not match", () => {
    const files = createRemoteWorkFiles();
    const bytes = randomBytes(4096);

    const push = files.beginPush({ owner, copyRoot: copy, path: "in\\dir/file.bin", size: bytes.length, sha256: sha(bytes) });
    files.writeChunk(owner, push.transferId, 0, bytes.toString("base64"));
    expect(files.commitPush(owner, push.transferId)).toMatchObject({ path: "in/dir/file.bin", bytes: bytes.length });
    expect(fs.readFileSync(path.join(copy, "in", "dir", "file.bin")).equals(bytes)).toBe(true);

    const other = randomBytes(4096);
    const bad = files.beginPush({ owner, copyRoot: copy, path: "in/dir/bad.bin", size: other.length, sha256: sha(bytes) });
    files.writeChunk(owner, bad.transferId, 0, other.toString("base64"));
    expect(() => files.commitPush(owner, bad.transferId)).toThrow(expect.objectContaining({ code: "hash_mismatch" }));
    // Neither the file nor its temp is left behind; only the good push is there.
    expect(fs.readdirSync(path.join(copy, "in", "dir"))).toEqual(["file.bin"]);
    expect(fs.readFileSync(path.join(copy, "in", "dir", "file.bin")).equals(bytes)).toBe(true);
  });
});
