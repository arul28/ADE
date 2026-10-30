import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRemoteWorkCopyService } from "./remoteWorkCopyService";

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

      // An agent edits a file in the copy and commits it there, without a push.
      fs.writeFileSync(path.join(first.path, "made-there.txt"), "work\n");
      await expect(service.prepare(owner, source)).rejects.toMatchObject({
        code: "copy_has_unsynced_work",
        message: expect.stringContaining("made-there.txt"),
      });
      git(first.path, "add", "-A");
      git(first.path, "commit", "-m", "made there");
      await expect(service.prepare(owner, source)).rejects.toMatchObject({ code: "copy_has_unsynced_work" });
      // An automatic cleanup keeps it too.
      await expect(service.release(owner, { keepUnsynced: true })).resolves.toBe(false);
      expect(fs.readFileSync(path.join(first.path, "made-there.txt"), "utf8")).toBe("work\n");

      // Pushed, the work is safe on origin: the sync goes ahead and resets the copy.
      git(first.path, "push", "origin", "HEAD:refs/heads/made-there");
      const synced = await service.prepare(owner, source);
      synced.done();
      expect(synced).toMatchObject({ created: false, synced: true, path: first.path });
      expect(git(first.path, "rev-parse", "HEAD")).toBe(head);
      expect(fs.existsSync(path.join(first.path, "made-there.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
