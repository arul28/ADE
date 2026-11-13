import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRemoteWorkCopyService } from "./remoteWorkCopyService";
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
      expect(fs.readFileSync(path.join(first.path, "generated.txt"), "utf8")).toBe("made by a tool\n");

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
