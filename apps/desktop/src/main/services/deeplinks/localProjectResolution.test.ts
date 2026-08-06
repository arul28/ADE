import { describe, expect, it, vi } from "vitest";

import {
  resolveLocalProjectRoot,
  type LocalProjectCandidate,
} from "./localProjectResolution";

/** Stands in for `deriveProjectId`: a stable, root-derived canonical id. */
function fakeDerive(rootPath: string): string {
  if (!rootPath) throw new Error("empty root");
  return `project_${rootPath.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
}

function deps(
  candidates: LocalProjectCandidate[],
  overrides: Partial<Parameters<typeof resolveLocalProjectRoot>[2]> = {},
) {
  return {
    candidates: () => candidates,
    pathsEqual: (a: string, b: string) => a === b,
    deriveProjectId: fakeDerive,
    ...overrides,
  };
}

describe("resolveLocalProjectRoot", () => {
  const local: LocalProjectCandidate = { root: "/Users/me/ade", projectId: "uuid-local" };

  it("matches this machine's own uuid, the id an older deeplink carries", () => {
    expect(resolveLocalProjectRoot("uuid-local", null, deps([local]))).toBe("/Users/me/ade");
  });

  it("matches a canonical id directly once the registry agrees on the hash", () => {
    const registryKeyed: LocalProjectCandidate = {
      root: "/Users/me/ade",
      projectId: fakeDerive("/Users/me/ade"),
    };
    expect(
      resolveLocalProjectRoot(fakeDerive("/Users/me/ade"), null, deps([registryKeyed])),
    ).toBe("/Users/me/ade");
  });

  it("falls back to the link's root path when no id matches", () => {
    // The publishing machine's uuid is meaningless here; the path is not.
    expect(
      resolveLocalProjectRoot("uuid-from-another-machine", "/Users/me/ade", deps([local])),
    ).toBe("/Users/me/ade");
  });

  it("recomputes the canonical id when a canonical link carried no root path", () => {
    expect(resolveLocalProjectRoot(fakeDerive("/Users/me/ade"), null, deps([local]))).toBe(
      "/Users/me/ade",
    );
  });

  it("prefers an exact id match over a root-path match", () => {
    const other: LocalProjectCandidate = { root: "/Users/me/other", projectId: "uuid-wanted" };
    expect(
      resolveLocalProjectRoot("uuid-wanted", "/Users/me/ade", deps([local, other])),
    ).toBe("/Users/me/other");
  });

  it("returns null when this machine does not have the project", () => {
    // A real answer: the caller routes to the owning machine rather than
    // opening something that merely looks similar.
    expect(
      resolveLocalProjectRoot("uuid-elsewhere", "/Users/me/elsewhere", deps([local])),
    ).toBeNull();
  });

  it("ignores candidates with an empty root", () => {
    const blank: LocalProjectCandidate = { root: "", projectId: "uuid-blank" };
    expect(resolveLocalProjectRoot("uuid-blank", null, deps([blank]))).toBeNull();
  });

  it("ignores a blank root path rather than matching on empty string", () => {
    const pathsEqual = vi.fn(() => true);
    expect(resolveLocalProjectRoot("uuid-missing", "   ", deps([local], { pathsEqual })))
      .toBeNull();
    expect(pathsEqual).not.toHaveBeenCalled();
  });

  it("survives a root that deriveProjectId rejects", () => {
    const broken: LocalProjectCandidate = { root: "\u0000", projectId: "uuid-broken" };
    const deriveProjectId = (rootPath: string) => {
      if (rootPath === "\u0000") throw new Error("malformed root");
      return fakeDerive(rootPath);
    };
    expect(
      resolveLocalProjectRoot(fakeDerive("/Users/me/ade"), null, deps([broken, local], {
        deriveProjectId,
      })),
    ).toBe("/Users/me/ade");
  });

  it("defers path comparison to the injected platform-correct comparer", () => {
    // Windows hosts compare case-insensitively; this module must not decide.
    const pathsEqual = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const win: LocalProjectCandidate = { root: "C:\\Users\\Me\\ade", projectId: "uuid-win" };
    expect(
      resolveLocalProjectRoot("uuid-other", "c:\\users\\me\\ade", deps([win], { pathsEqual })),
    ).toBe("C:\\Users\\Me\\ade");
  });
});
