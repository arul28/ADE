import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE,
  resolveWithinAllowedProjectRoots,
} from "./allowedProjectRoot";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-allowed-project-root-"));
const allowedRoot = path.join(tempRoot, "allowed");
const secondAllowedRoot = path.join(tempRoot, "second-allowed");
const outsideRoot = path.join(tempRoot, "outside");
const missingAllowedRoot = path.join(tempRoot, "allowed-but-not-there");
for (const dir of [allowedRoot, secondAllowedRoot, outsideRoot]) {
  fs.mkdirSync(dir, { recursive: true });
}
const insideFirst = path.join(allowedRoot, "child");
const insideSecond = path.join(secondAllowedRoot, "child");
for (const dir of [insideFirst, insideSecond]) {
  fs.mkdirSync(dir, { recursive: true });
}
const outsideFile = path.join(outsideRoot, "secret.txt");
fs.writeFileSync(outsideFile, "secret");

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const allowedRoots = [allowedRoot, secondAllowedRoot];

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
      resolveWithinAllowedProjectRoots(allowedRoots, candidate);
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

describe("resolveWithinAllowedProjectRoots", () => {
  it("accepts a folder inside an allowed root, in canonical form", () => {
    expect(resolveWithinAllowedProjectRoots(allowedRoots, insideFirst))
      .toBe(fs.realpathSync.native(insideFirst));
    // The second root is a candidate too, not just the first one tried.
    expect(resolveWithinAllowedProjectRoots(allowedRoots, insideSecond))
      .toBe(fs.realpathSync.native(insideSecond));
  });

  it("rejects a path outside every allowed root with the allowlist message", () => {
    expect(() => resolveWithinAllowedProjectRoots(allowedRoots, outsideFile))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(() => resolveWithinAllowedProjectRoots([], insideFirst))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
  });

  // Regression: the allowlist loop swallowed every failure and reported
  // "outside known project roots" for all of them, so a recent project whose
  // folder is gone — an unmounted volume, a deleted checkout — read as a root
  // the renderer was never allowed to name. The two cases must stay
  // distinguishable.
  it("reports a folder that is gone as missing, not as outside the known project roots", () => {
    const gone = path.join(allowedRoot, "gone-project");
    let missing: Error | null = null;
    try {
      resolveWithinAllowedProjectRoots(allowedRoots, gone);
    } catch (error) {
      missing = error as Error;
    }
    expect(missing?.message).toBe(`Path does not exist: ${gone}`);
    expect(missing?.message).not.toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);

    let outside: Error | null = null;
    try {
      resolveWithinAllowedProjectRoots(allowedRoots, outsideFile);
    } catch (error) {
      outside = error as Error;
    }
    expect(outside?.message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(missing?.message).not.toBe(outside?.message);
  });

  // The existence oracle: a missing folder outside every allowed root must read
  // exactly like an existing one. The resolver reports a missing component
  // before it checks containment, so without the lexical gate a probe for
  // `/outside/<name>` said "does not exist" and leaked what was on disk.
  it("gives a missing folder outside the allowed roots the allowlist message, not a missing one", () => {
    const gone = path.join(outsideRoot, "not-there");
    expect(() => resolveWithinAllowedProjectRoots(allowedRoots, gone))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(() => resolveWithinAllowedProjectRoots(allowedRoots, path.join(tempRoot, "nowhere", "x")))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(() => resolveWithinAllowedProjectRoots(allowedRoots, path.join(allowedRoot, "..", "outside", "gone")))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
  });

  // A dangling symlink resolves to nothing, so it is a missing target rather
  // than a containment failure — but it must still be a rejection.
  it("does not call a dangling symlink an allowlist violation", (ctx) => {
    const dangling = path.join(allowedRoot, "dangling-link");
    try {
      fs.symlinkSync(path.join(allowedRoot, "no-such-target"), dangling, "dir");
    } catch {
      ctx.skip();
      return;
    }
    expect(fs.lstatSync(dangling).isSymbolicLink(), "symlink setup").toBe(true);
    let failure: Error | null = null;
    try {
      resolveWithinAllowedProjectRoots(allowedRoots, dangling);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).not.toBeNull();
    expect(failure?.message).not.toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
  });

  // The security half: a symlink that escapes the allowlist is still refused,
  // and refused with the allowlist message, however many other roots were tried.
  it("still refuses a symlink that leaves the allowed roots", (ctx) => {
    const escapeLink = path.join(allowedRoot, "escape-link");
    try {
      fs.symlinkSync(outsideRoot, escapeLink, "dir");
    } catch {
      ctx.skip();
      return;
    }
    expect(fs.lstatSync(escapeLink).isSymbolicLink(), "symlink setup").toBe(true);
    expect(() => resolveWithinAllowedProjectRoots(allowedRoots, escapeLink))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
  });

  // The existence oracle through a symlink: an in-root link that points outside
  // the allowed roots. A folder that really exists under it is refused as outside
  // the roots, but a folder that does not exist fails on the missing component
  // before containment is checked, so it said "does not exist" and told the
  // renderer what was on disk outside the roots. Both must read the same.
  // A missing folder under an in-root link to an in-root folder keeps its reason.
  it("gives a missing folder under a symlink that leaves the allowed roots the allowlist message", (ctx) => {
    const escapeDir = path.join(allowedRoot, "escape-dir");
    const innerDir = path.join(allowedRoot, "inner-dir");
    try {
      fs.symlinkSync(outsideRoot, escapeDir, "dir");
      fs.symlinkSync(insideFirst, innerDir, "dir");
    } catch {
      ctx.skip();
      return;
    }
    expect(fs.lstatSync(escapeDir).isSymbolicLink(), "symlink setup").toBe(true);
    expect(() => resolveWithinAllowedProjectRoots(allowedRoots, path.join(escapeDir, "not-there")))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(() => resolveWithinAllowedProjectRoots(allowedRoots, path.join(escapeDir, "secret.txt")))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(() => resolveWithinAllowedProjectRoots(allowedRoots, path.join(innerDir, "not-there")))
      .toThrow(`Path does not exist: ${path.join(innerDir, "not-there")}`);
  });

  // A link from one allowed root into another stays inside the allowed roots, so
  // a missing folder under it keeps its own reason, and a folder that exists
  // there still resolves through the link.
  it("keeps the missing-folder reason for a folder under a symlink into another allowed root", (ctx) => {
    const intoSecond = path.join(allowedRoot, "into-second");
    try {
      fs.symlinkSync(secondAllowedRoot, intoSecond, "dir");
    } catch {
      ctx.skip();
      return;
    }
    expect(fs.lstatSync(intoSecond).isSymbolicLink(), "symlink setup").toBe(true);
    expect(() => resolveWithinAllowedProjectRoots(allowedRoots, path.join(intoSecond, "not-there")))
      .toThrow(`Path does not exist: ${path.join(intoSecond, "not-there")}`);
    expect(resolveWithinAllowedProjectRoots(allowedRoots, path.join(intoSecond, "child")))
      .toBe(fs.realpathSync.native(insideSecond));
  });

  // Outside targets must look the same from outside. A present and a missing
  // name behind a link that leaves the roots get the same filesystem calls, in
  // the same order, and the same message, so neither can show which one exists.
  // Following a link costs more than a plain name, so a present and a dangling
  // link are compared with each other, not with a plain file. This is a
  // call-sequence check, not a timing one.
  it("refuses a present, a missing and a dangling name behind a symlink that leaves the roots the same way", (ctx) => {
    const escapeDir = path.join(allowedRoot, "walk-escape-dir");
    // The link targets are spelled canonically, the way the walk sees the outside
    // folder. A spelling through another link (macOS's /var is one) adds that
    // link's calls to the walk. The link is fixed on disk, so that is not an
    // existence signal, but both sides of a comparison must use the same spelling.
    const outsideCanonical = fs.realpathSync.native(outsideRoot);
    const viaTmpSpelling = path.join(allowedRoot, "dangling-via-tmp-spelling.txt");
    try {
      fs.symlinkSync(outsideRoot, escapeDir, "dir");
      fs.symlinkSync(path.join(outsideCanonical, "no-such.txt"), path.join(outsideRoot, "dangling.txt"), "file");
      fs.symlinkSync(path.join(outsideRoot, "no-such.txt"), viaTmpSpelling, "file");
      fs.symlinkSync(path.join(outsideCanonical, "secret.txt"), path.join(outsideRoot, "linked.txt"), "file");
    } catch {
      ctx.skip();
      return;
    }
    const present = refusalOf(path.join(escapeDir, "secret.txt"));
    const missing = refusalOf(path.join(escapeDir, "not-there.txt"));
    const linked = refusalOf(path.join(escapeDir, "linked.txt"), { maskNames: ["secret.txt"] });
    const dangling = refusalOf(path.join(escapeDir, "dangling.txt"), { maskNames: ["no-such.txt"] });
    expect(present.message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(missing.message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(linked.message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(dangling.message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(refusalOf(viaTmpSpelling).message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(present.calls.length, "the spies saw the walk").toBeGreaterThan(0);
    expect(missing.calls).toEqual(present.calls);
    expect(dangling.calls).toEqual(linked.calls);
  });

  // An in-root link is the other way an outside target is reached. Whether its
  // target exists or dangles, the link is walked the same way and refused with
  // the same message, so the link cannot be used to tell the two apart.
  it("refuses an in-root link to an outside target the same way whether the target exists or not", (ctx) => {
    const toPresent = path.join(allowedRoot, "to-present");
    const toMissing = path.join(allowedRoot, "to-missing");
    try {
      fs.symlinkSync(outsideFile, toPresent, "file");
      fs.symlinkSync(path.join(outsideRoot, "not-there.txt"), toMissing, "file");
    } catch {
      ctx.skip();
      return;
    }
    const present = refusalOf(toPresent, { maskNames: [path.basename(outsideFile)] });
    const missing = refusalOf(toMissing, { maskNames: ["not-there.txt"] });
    expect(present.message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(missing.message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(missing.calls).toEqual(present.calls);
  });

  // A name that cannot be read (here a realpath EACCES) behind an outside link is
  // the same refusal as one that exists, with the same calls and no path in the
  // message.
  it("refuses an unreadable name behind a symlink that leaves the roots the same way", (ctx) => {
    const escapeDir = path.join(allowedRoot, "locked-escape-dir");
    try {
      fs.symlinkSync(outsideRoot, escapeDir, "dir");
    } catch {
      ctx.skip();
      return;
    }
    fs.writeFileSync(path.join(outsideRoot, "locked.txt"), "locked");
    const present = refusalOf(path.join(escapeDir, "secret.txt"));
    const denied = refusalOf(path.join(escapeDir, "locked.txt"), { denyRealpathOf: "locked.txt" });
    expect(denied.message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(denied.message).not.toContain(outsideRoot);
    expect(denied.calls).toEqual(present.calls);
  });

  // A root that is itself missing fails for a reason that has nothing to do
  // with the candidate; it must not downgrade a real containment rejection
  // into that root's error.
  it("keeps the allowlist verdict when another root is missing from disk", () => {
    expect(() => resolveWithinAllowedProjectRoots([missingAllowedRoot, allowedRoot], outsideFile))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
  });

  // The two-link oracle: an in-root link to another in-root link to an outside
  // target. The walk must keep following the chain past its first link. A present
  // end and a dangling end refuse with the same message and make the same calls.
  it("refuses a two-link chain out of the roots the same way whether its end exists or not", (ctx) => {
    const presentStart = path.join(allowedRoot, "chain-present-a");
    const presentHop = path.join(allowedRoot, "chain-present-b");
    const danglingStart = path.join(allowedRoot, "chain-dangling-a");
    const danglingHop = path.join(allowedRoot, "chain-dangling-b");
    try {
      fs.symlinkSync(outsideFile, presentHop, "file");
      fs.symlinkSync(presentHop, presentStart, "file");
      fs.symlinkSync(path.join(outsideRoot, "no-such.txt"), danglingHop, "file");
      fs.symlinkSync(danglingHop, danglingStart, "file");
    } catch {
      ctx.skip();
      return;
    }
    const present = refusalOf(presentStart, { maskNames: ["chain-present-b", "secret.txt"] });
    const dangling = refusalOf(danglingStart, { maskNames: ["chain-dangling-b", "no-such.txt"] });
    expect(present.message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(dangling.message).toBe(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
    expect(dangling.calls).toEqual(present.calls);
  });

  // A chain that stays inside the roots resolves to its canonical end when that
  // end exists, and keeps its own missing reason when it does not.
  it("accepts a two-link chain that ends inside an allowed root, and reports a missing end as missing", (ctx) => {
    const insideStart = path.join(allowedRoot, "chain-inside-a");
    const insideHop = path.join(allowedRoot, "chain-inside-b");
    const missingStart = path.join(allowedRoot, "chain-inside-missing-a");
    const missingHop = path.join(allowedRoot, "chain-inside-missing-b");
    try {
      fs.symlinkSync(insideFirst, insideHop, "dir");
      fs.symlinkSync(insideHop, insideStart, "dir");
      fs.symlinkSync(path.join(allowedRoot, "no-such-inside"), missingHop, "dir");
      fs.symlinkSync(missingHop, missingStart, "dir");
    } catch {
      ctx.skip();
      return;
    }
    expect(resolveWithinAllowedProjectRoots(allowedRoots, insideStart))
      .toBe(fs.realpathSync.native(insideFirst));
    expect(() => resolveWithinAllowedProjectRoots(allowedRoots, missingStart))
      .toThrow(`Path does not exist: ${missingStart}`);
  });

  // A root that is not on disk fails with its own realpath error. When another
  // root contains the folder beneath it, that error is the one reported, as it
  // was before the walk was shared; with no such root the refusal is the same
  // allowlist message as any other outside path.
  it("reports a root that is not on disk by its own realpath error when another root contains the folder", () => {
    const beneath = path.join(missingAllowedRoot, "child");
    expect(() => resolveWithinAllowedProjectRoots([missingAllowedRoot, tempRoot], beneath))
      .toThrow(/^ENOENT: no such file or directory, realpath '.*allowed-but-not-there'$/);
    expect(() => resolveWithinAllowedProjectRoots([missingAllowedRoot, tempRoot], missingAllowedRoot))
      .toThrow(/^ENOENT: no such file or directory, realpath '.*allowed-but-not-there'$/);
    expect(() => resolveWithinAllowedProjectRoots([missingAllowedRoot], beneath))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
  });
});
