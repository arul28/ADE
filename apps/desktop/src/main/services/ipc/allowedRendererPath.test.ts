import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE,
  resolveWithinAllowedDirs,
} from "./allowedRendererPath";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-allowed-renderer-path-"));
const allowedDir = path.join(tempRoot, "allowed");
const secondAllowedDir = path.join(tempRoot, "second-allowed");
const outsideDir = path.join(tempRoot, "outside");
const missingAllowedDir = path.join(tempRoot, "allowed-but-not-there");
for (const dir of [allowedDir, secondAllowedDir, outsideDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
const presentFile = path.join(allowedDir, "present.png");
fs.writeFileSync(presentFile, "png");
const outsideFile = path.join(outsideDir, "secret.txt");
fs.writeFileSync(outsideFile, "secret");

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const allowedDirs = [allowedDir, secondAllowedDir];

describe("resolveWithinAllowedDirs", () => {
  it("accepts a file inside an allowed directory, in canonical form", () => {
    expect(resolveWithinAllowedDirs(allowedDirs, presentFile)).toBe(fs.realpathSync.native(presentFile));
    // The second root is a candidate too, not just the first one tried.
    const inSecond = path.join(secondAllowedDir, "note.txt");
    fs.writeFileSync(inSecond, "note");
    expect(resolveWithinAllowedDirs(allowedDirs, inSecond)).toBe(fs.realpathSync.native(inSecond));
  });

  it("rejects a path outside every allowed directory with the allowlist message", () => {
    expect(() => resolveWithinAllowedDirs(allowedDirs, outsideFile))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(() => resolveWithinAllowedDirs([], presentFile))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
  });

  // Regression: the allowlist loop swallowed every failure and reported
  // "outside allowed directories" for all of them, so a file that is simply
  // gone — a screenshot cleaned up while a chat still shows it — told the user
  // their path was not permitted. The two cases must stay distinguishable.
  it("reports a missing file as missing, not as a path outside the allowlist", () => {
    const gone = path.join(allowedDir, "cleaned-up.png");
    let missing: Error | null = null;
    try {
      resolveWithinAllowedDirs(allowedDirs, gone);
    } catch (error) {
      missing = error as Error;
    }
    expect(missing?.message).toBe(`Path does not exist: ${gone}`);
    expect(missing?.message).not.toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);

    let outside: Error | null = null;
    try {
      resolveWithinAllowedDirs(allowedDirs, outsideFile);
    } catch (error) {
      outside = error as Error;
    }
    expect(outside?.message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(missing?.message).not.toBe(outside?.message);
  });

  // The existence oracle: a missing path outside every allowed directory must
  // read exactly like an existing one. The resolver reports a missing component
  // before it checks containment, so without the lexical gate a probe for
  // `/outside/<name>` said "Path does not exist" and leaked what was on disk.
  it("gives a missing path outside the allowlist the allowlist message, not a missing-file one", () => {
    const gone = path.join(outsideDir, "not-there.png");
    expect(() => resolveWithinAllowedDirs(allowedDirs, gone))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(() => resolveWithinAllowedDirs(allowedDirs, path.join(tempRoot, "nowhere", "x.png")))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(() => resolveWithinAllowedDirs(allowedDirs, path.join(allowedDir, "..", "outside", "gone.png")))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
  });

  // A dangling symlink resolves to nothing, so it is a missing target rather
  // than a containment failure — but it must still be a rejection.
  it("does not call a dangling symlink an allowlist violation", (ctx) => {
    const dangling = path.join(allowedDir, "dangling-link.png");
    try {
      fs.symlinkSync(path.join(allowedDir, "no-such-target.png"), dangling, "file");
    } catch {
      ctx.skip();
      return;
    }
    expect(fs.lstatSync(dangling).isSymbolicLink(), "symlink setup").toBe(true);
    let failure: Error | null = null;
    try {
      resolveWithinAllowedDirs(allowedDirs, dangling);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).not.toBeNull();
    expect(failure?.message).not.toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
  });

  // The security half: a symlink that escapes the allowlist is still refused,
  // and refused with the allowlist message, however many other roots were tried.
  it("still refuses a symlink that leaves the allowed directories", (ctx) => {
    const escapeLink = path.join(allowedDir, "escape-link.txt");
    try {
      fs.symlinkSync(outsideFile, escapeLink, "file");
    } catch {
      ctx.skip();
      return;
    }
    expect(fs.lstatSync(escapeLink).isSymbolicLink(), "symlink setup").toBe(true);
    expect(() => resolveWithinAllowedDirs(allowedDirs, escapeLink))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
  });

  // The existence oracle through a symlink: an in-root link that points outside
  // the allowlist. A name that really exists under it is refused as outside the
  // allowlist, but a name that does not exist fails on the missing component
  // before containment is checked, so it said "Path does not exist" and told the
  // renderer what was on disk outside the allowlist. Both must read the same.
  // A missing name under an in-root link to an in-root folder keeps its reason.
  it("gives a missing name under a symlink that leaves the allowlist the allowlist message", (ctx) => {
    const escapeDir = path.join(allowedDir, "escape-dir");
    const innerDir = path.join(allowedDir, "inner-dir");
    try {
      fs.symlinkSync(outsideDir, escapeDir, "dir");
      fs.symlinkSync(allowedDir, innerDir, "dir");
    } catch {
      ctx.skip();
      return;
    }
    expect(fs.lstatSync(escapeDir).isSymbolicLink(), "symlink setup").toBe(true);
    expect(() => resolveWithinAllowedDirs(allowedDirs, path.join(escapeDir, "not-there.png")))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(() => resolveWithinAllowedDirs(allowedDirs, path.join(escapeDir, "secret.txt")))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(() => resolveWithinAllowedDirs(allowedDirs, path.join(innerDir, "not-there.png")))
      .toThrow(`Path does not exist: ${path.join(innerDir, "not-there.png")}`);
  });

  // A link from one allowed directory into another stays inside the allowlist,
  // so a missing name under it keeps its own reason, and a file that exists
  // there still resolves through the link.
  it("keeps the missing-file reason for a name under a symlink into another allowed directory", (ctx) => {
    const intoSecond = path.join(allowedDir, "into-second");
    const linked = path.join(secondAllowedDir, "linked.txt");
    fs.writeFileSync(linked, "linked");
    try {
      fs.symlinkSync(secondAllowedDir, intoSecond, "dir");
    } catch {
      ctx.skip();
      return;
    }
    expect(fs.lstatSync(intoSecond).isSymbolicLink(), "symlink setup").toBe(true);
    expect(() => resolveWithinAllowedDirs(allowedDirs, path.join(intoSecond, "not-there.png")))
      .toThrow(`Path does not exist: ${path.join(intoSecond, "not-there.png")}`);
    expect(resolveWithinAllowedDirs(allowedDirs, path.join(intoSecond, "linked.txt")))
      .toBe(fs.realpathSync.native(linked));
  });

  // A root that is itself missing fails for a reason that has nothing to do
  // with the candidate; it must not downgrade a real containment rejection
  // into that root's error.
  it("keeps the allowlist verdict when another root is missing from disk", () => {
    expect(() => resolveWithinAllowedDirs([missingAllowedDir, allowedDir], outsideFile))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
  });
});
