import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveKnownProjectRoot } from "./knownProjectRoots";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-known-roots-"));
const openProject = path.join(tempRoot, "open-project");
const recentProject = path.join(tempRoot, "recent-project");
const stranger = path.join(tempRoot, "someone-elses-folder");
for (const dir of [openProject, recentProject, stranger]) {
  fs.mkdirSync(dir, { recursive: true });
}

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const sources = {
  openProjectRoot: openProject,
  recentProjectRoots: [recentProject],
};

describe("resolveKnownProjectRoot", () => {
  it("accepts the open project and a recent project", () => {
    expect(resolveKnownProjectRoot(openProject, sources)).toBe(openProject);
    expect(resolveKnownProjectRoot(recentProject, sources)).toBe(recentProject);
  });

  // Regression: the diagnostics and recovery IPC handlers only trimmed the
  // renderer's string, so any directory on the machine could be diagnosed
  // (logs and volume space read) or repaired (on-disk state mutated).
  it("rejects a directory that is not a project this machine knows", () => {
    expect(resolveKnownProjectRoot(stranger, sources)).toBeNull();
    expect(resolveKnownProjectRoot("/etc", sources)).toBeNull();
  });

  it("rejects traversal that lands outside a known project", () => {
    expect(resolveKnownProjectRoot(path.join(openProject, "..", "someone-elses-folder"), sources)).toBeNull();
    expect(resolveKnownProjectRoot(`${openProject}/../../..`, sources)).toBeNull();
  });

  it("accepts a non-canonical spelling of a known project and returns the canonical one", () => {
    const noisy = path.join(openProject, ".", "sub", "..");
    expect(resolveKnownProjectRoot(noisy, sources)).toBe(openProject);
    expect(resolveKnownProjectRoot(`${openProject}${path.sep}`, sources)).toBe(openProject);
  });

  it("rejects empty and non-string input", () => {
    expect(resolveKnownProjectRoot("", sources)).toBeNull();
    expect(resolveKnownProjectRoot("   ", sources)).toBeNull();
    expect(resolveKnownProjectRoot(null, sources)).toBeNull();
    expect(resolveKnownProjectRoot(undefined, sources)).toBeNull();
  });

  it("accepts nothing when no project is open and there are no recents", () => {
    expect(resolveKnownProjectRoot(openProject, {})).toBeNull();
    expect(resolveKnownProjectRoot(openProject, { openProjectRoot: null, recentProjectRoots: [] })).toBeNull();
  });

  it("resolves a symlink to a known project", () => {
    const link = path.join(tempRoot, "link-to-open");
    try {
      fs.symlinkSync(openProject, link, "dir");
    } catch {
      return; // No symlink privilege (Windows without developer mode).
    }
    expect(resolveKnownProjectRoot(link, sources)).toBe(openProject);
  });
});
