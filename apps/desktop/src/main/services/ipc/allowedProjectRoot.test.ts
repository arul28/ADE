import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => {
  vi.restoreAllMocks();
});

const allowedRoots = [allowedRoot, secondAllowedRoot];

// Fs calls made refusing `candidate`, in order, with its leaf name masked.
function probesOf(candidate: string): string[] {
  const spies = {
    lstatSync: vi.spyOn(fs, "lstatSync"), statSync: vi.spyOn(fs, "statSync"),
    readlinkSync: vi.spyOn(fs, "readlinkSync"), realpathSync: vi.spyOn(fs.realpathSync, "native"),
  };
  expect(() => resolveWithinAllowedProjectRoots(allowedRoots, candidate), candidate)
    .toThrow(new Error(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE));
  return Object.entries(spies)
    .flatMap(([name, spy]) => spy.mock.calls.map((args, i) => ({
      order: spy.mock.invocationCallOrder[i],
      text: `${name}(${String(args[0]).split(path.basename(candidate)).join("<leaf>")})`,
    })))
    .sort((a, b) => a.order - b.order).map((call) => call.text);
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

  // A root that is itself missing fails for a reason that has nothing to do
  // with the candidate; it must not downgrade a real containment rejection
  // into that root's error.
  it("keeps the allowlist verdict when another root is missing from disk", () => {
    expect(() => resolveWithinAllowedProjectRoots([missingAllowedRoot, allowedRoot], outsideFile))
      .toThrow(ROOT_OUTSIDE_ALLOWED_PROJECT_ROOTS_MESSAGE);
  });

  // An outside target must refuse with the same text whether it exists, is
  // missing, or is reached through a link out of the roots. Otherwise the text
  // shows which of them exists.
  it("refuses a present, a missing and a linked outside target with the same message and calls", (ctx) => {
    const escapeDir = path.join(allowedRoot, "table-escape-dir");
    try {
      fs.symlinkSync(outsideRoot, escapeDir, "dir");
    } catch {
      ctx.skip();
      return;
    }
    const candidates = [
      outsideFile,
      path.join(outsideRoot, "not-there.txt"),
      path.join(escapeDir, "secret.txt"),
      path.join(escapeDir, "not-there.txt"),
    ];
    const probes = candidates.map((candidate) => probesOf(candidate));
    expect([probes[1], probes[3]]).toEqual([probes[0], probes[2]]);
  });
});
