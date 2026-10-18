import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
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

function maskLeaves(text: string, leaves: readonly string[]): string {
  return leaves.reduce((masked, leaf) => masked.split(leaf).join("<leaf>"), text);
}

// The refusal a candidate gets, and every filesystem call made while producing
// it, in order. The candidate's own name and each name in `maskNames` are
// masked, because the present, missing and dangling cases each use a different
// name; nothing else may differ. `denyRealpathOf` makes `realpath` fail with
// EACCES for matching paths.
function refusalOf(
  candidate: string,
  opts: { denyRealpathOf?: string; maskNames?: string[] } = {},
): { message: string; calls: string[] } {
  const leaves = [path.basename(candidate), ...(opts.maskNames ?? [])];
  const realpathNative = fs.realpathSync.native;
  const spies = {
    lstat: vi.spyOn(fs, "lstatSync"),
    stat: vi.spyOn(fs, "statSync"),
    readlink: vi.spyOn(fs, "readlinkSync"),
    realpath: vi.spyOn(fs.realpathSync, "native"),
  };
  if (opts.denyRealpathOf !== undefined) {
    const denied = opts.denyRealpathOf;
    spies.realpath.mockImplementation(((filePath: fs.PathLike) => {
      if (String(filePath).includes(denied)) {
        throw Object.assign(new Error(`EACCES: permission denied, realpath '${String(filePath)}'`), { code: "EACCES" });
      }
      return realpathNative(filePath);
    }) as typeof realpathNative);
  }
  try {
    let message = "";
    try {
      resolveWithinAllowedDirs(allowedDirs, candidate);
    } catch (error) {
      message = (error as Error).message;
    }
    const seen: Array<{ order: number; text: string }> = [];
    for (const [name, spy] of Object.entries(spies)) {
      spy.mock.calls.forEach((args, index) => {
        seen.push({
          order: spy.mock.invocationCallOrder[index],
          text: `${name}(${maskLeaves(String((args as unknown[])[0]), leaves)})`,
        });
      });
    }
    seen.sort((a, b) => a.order - b.order);
    return { message, calls: seen.map((call) => call.text) };
  } finally {
    for (const spy of Object.values(spies)) spy.mockRestore();
  }
}

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

  // Outside targets must look the same from outside. A present and a missing
  // name behind a link that leaves the allowlist get the same filesystem calls,
  // in the same order, and the same message, so neither can show which one
  // exists. Following a link costs more than a plain name, so a present and a
  // dangling link are compared with each other, not with a plain file. This is a
  // call-sequence check, not a timing one.
  it("refuses a present, a missing and a dangling name behind a symlink that leaves the allowlist the same way", (ctx) => {
    const walkEscapeDir = path.join(allowedDir, "walk-escape-dir");
    // The link targets are spelled canonically, the way the walk sees the outside
    // folder. A spelling through another link (macOS's /var is one) adds that
    // link's calls to the walk. The link is fixed on disk, so that is not an
    // existence signal, but both sides of a comparison must use the same spelling.
    const outsideCanonical = fs.realpathSync.native(outsideDir);
    const viaTmpSpelling = path.join(allowedDir, "dangling-via-tmp-spelling.png");
    try {
      fs.symlinkSync(outsideDir, walkEscapeDir, "dir");
      fs.symlinkSync(path.join(outsideCanonical, "no-such.png"), path.join(outsideDir, "dangling.png"), "file");
      fs.symlinkSync(path.join(outsideDir, "no-such.png"), viaTmpSpelling, "file");
      fs.symlinkSync(path.join(outsideCanonical, "secret.txt"), path.join(outsideDir, "linked.png"), "file");
    } catch {
      ctx.skip();
      return;
    }
    const present = refusalOf(path.join(walkEscapeDir, "secret.txt"));
    const missing = refusalOf(path.join(walkEscapeDir, "not-there.png"));
    const linked = refusalOf(path.join(walkEscapeDir, "linked.png"), { maskNames: ["secret.txt"] });
    const dangling = refusalOf(path.join(walkEscapeDir, "dangling.png"), { maskNames: ["no-such.png"] });
    expect(present.message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(missing.message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(linked.message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(dangling.message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(refusalOf(viaTmpSpelling).message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(present.calls.length, "the spies saw the walk").toBeGreaterThan(0);
    expect(missing.calls).toEqual(present.calls);
    expect(dangling.calls).toEqual(linked.calls);
  });

  // An in-root link is the other way an outside target is reached. Whether its
  // target exists or dangles, the link is walked the same way and refused with
  // the same message, so the link cannot be used to tell the two apart.
  it("refuses an in-root link to an outside target the same way whether the target exists or not", (ctx) => {
    const toPresent = path.join(allowedDir, "to-present.txt");
    const toMissing = path.join(allowedDir, "to-missing.txt");
    try {
      fs.symlinkSync(outsideFile, toPresent, "file");
      fs.symlinkSync(path.join(outsideDir, "not-there.txt"), toMissing, "file");
    } catch {
      ctx.skip();
      return;
    }
    const present = refusalOf(toPresent, { maskNames: [path.basename(outsideFile)] });
    const missing = refusalOf(toMissing, { maskNames: ["not-there.txt"] });
    expect(present.message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(missing.message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(missing.calls).toEqual(present.calls);
  });

  // A name that cannot be read (here a realpath EACCES) behind an outside link is
  // the same refusal as one that exists, with the same calls and no path in the
  // message.
  it("refuses an unreadable name behind a symlink that leaves the allowlist the same way", (ctx) => {
    const escapeDir = path.join(allowedDir, "locked-escape-dir");
    try {
      fs.symlinkSync(outsideDir, escapeDir, "dir");
    } catch {
      ctx.skip();
      return;
    }
    fs.writeFileSync(path.join(outsideDir, "locked.png"), "locked");
    const present = refusalOf(path.join(escapeDir, "secret.txt"));
    const denied = refusalOf(path.join(escapeDir, "locked.png"), { denyRealpathOf: "locked.png" });
    expect(denied.message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(denied.message).not.toContain(outsideDir);
    expect(denied.calls).toEqual(present.calls);
  });

  // A root that is itself missing fails for a reason that has nothing to do
  // with the candidate; it must not downgrade a real containment rejection
  // into that root's error.
  it("keeps the allowlist verdict when another root is missing from disk", () => {
    expect(() => resolveWithinAllowedDirs([missingAllowedDir, allowedDir], outsideFile))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
  });

  // The two-link oracle: an in-root link to another in-root link to an outside
  // target. The walk must keep following the chain past its first link. A present
  // end and a dangling end refuse with the same message and make the same calls.
  it("refuses a two-link chain out of the allowlist the same way whether its end exists or not", (ctx) => {
    const presentStart = path.join(allowedDir, "chain-present-a.png");
    const presentHop = path.join(allowedDir, "chain-present-b.png");
    const danglingStart = path.join(allowedDir, "chain-dangling-a.png");
    const danglingHop = path.join(allowedDir, "chain-dangling-b.png");
    try {
      fs.symlinkSync(outsideFile, presentHop, "file");
      fs.symlinkSync(presentHop, presentStart, "file");
      fs.symlinkSync(path.join(outsideDir, "no-such.png"), danglingHop, "file");
      fs.symlinkSync(danglingHop, danglingStart, "file");
    } catch {
      ctx.skip();
      return;
    }
    const present = refusalOf(presentStart, { maskNames: ["chain-present-b.png", "secret.txt"] });
    const dangling = refusalOf(danglingStart, { maskNames: ["chain-dangling-b.png", "no-such.png"] });
    expect(present.message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(dangling.message).toBe(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    expect(dangling.calls).toEqual(present.calls);
  });

  // A chain that stays inside the allowlist resolves to its canonical end when that
  // end exists, and keeps its own missing reason when it does not.
  it("accepts a two-link chain that ends inside an allowed directory, and reports a missing end as missing", (ctx) => {
    const insideStart = path.join(allowedDir, "chain-inside-a.png");
    const insideHop = path.join(allowedDir, "chain-inside-b.png");
    const missingStart = path.join(allowedDir, "chain-inside-missing-a.png");
    const missingHop = path.join(allowedDir, "chain-inside-missing-b.png");
    try {
      fs.symlinkSync(presentFile, insideHop, "file");
      fs.symlinkSync(insideHop, insideStart, "file");
      fs.symlinkSync(path.join(allowedDir, "no-such-inside.png"), missingHop, "file");
      fs.symlinkSync(missingHop, missingStart, "file");
    } catch {
      ctx.skip();
      return;
    }
    expect(resolveWithinAllowedDirs(allowedDirs, insideStart))
      .toBe(fs.realpathSync.native(presentFile));
    expect(() => resolveWithinAllowedDirs(allowedDirs, missingStart))
      .toThrow(`Path does not exist: ${missingStart}`);
  });

  // A root that is not on disk fails with its own realpath error. When another
  // root contains the name beneath it, that error is the one reported, as it was
  // before the walk was shared; with no such root the refusal is the same
  // allowlist message as any other outside path.
  it("reports a directory that is not on disk by its own realpath error when another root contains the name", () => {
    const beneath = path.join(missingAllowedDir, "child.png");
    expect(() => resolveWithinAllowedDirs([missingAllowedDir, tempRoot], beneath))
      .toThrow(/^ENOENT: no such file or directory, realpath '.*allowed-but-not-there'$/);
    expect(() => resolveWithinAllowedDirs([missingAllowedDir, tempRoot], missingAllowedDir))
      .toThrow(/^ENOENT: no such file or directory, realpath '.*allowed-but-not-there'$/);
    expect(() => resolveWithinAllowedDirs([missingAllowedDir], beneath))
      .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
  });
});
