import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE,
  resolveWithinAllowedDirs,
} from "./allowedRendererPath";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-allowed-renderer-path-"));
const allowedDir = path.join(tempRoot, "allowed");
const secondAllowedDir = path.join(tempRoot, "second-allowed");
const outsideDir = path.join(tempRoot, "outside");
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
afterEach(() => {
  vi.restoreAllMocks();
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
    // A window with no project open has a blank root. It allows nothing, not
    // the working directory ("/" for an app opened from Finder).
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tempRoot);
    for (const blank of ["", "  "]) {
      expect(() => resolveWithinAllowedDirs([blank, allowedDir], outsideFile))
        .toThrow(PATH_OUTSIDE_ALLOWED_DIRS_MESSAGE);
    }
    expect(cwd).not.toHaveBeenCalled();
  });
});
