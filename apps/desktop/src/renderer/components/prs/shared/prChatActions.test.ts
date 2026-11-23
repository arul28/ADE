// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prConflictsUrl,
  prHasConflicts,
  runPrResolveConflicts,
} from "./prChatActions";

const pr = {
  githubPrNumber: 42,
  repoOwner: "acme",
  repoName: "demo",
  headBranch: "feature/x",
  baseBranch: "main",
  title: "Fix it",
  githubUrl: "https://github.com/acme/demo/pull/42",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prHasConflicts", () => {
  it("reads either live signal, and stays false without one", () => {
    expect(prHasConflicts({ mergeConflicts: true })).toBe(true);
    expect(prHasConflicts({ mergeStateStatus: "dirty" })).toBe(true);
    expect(prHasConflicts({ mergeConflicts: false, mergeStateStatus: "clean" })).toBe(false);
    expect(prHasConflicts(null)).toBe(false);
    expect(prHasConflicts(undefined)).toBe(false);
  });
});

describe("runPrResolveConflicts", () => {
  it("hands the shared prompt to a chat when one can take it", () => {
    const handOff = vi.fn();
    runPrResolveConflicts(pr, handOff);
    expect(handOff).toHaveBeenCalledTimes(1);
    expect(handOff.mock.calls[0]?.[0]).toContain("Resolve the merge conflicts between feature/x and main");
  });

  it("opens GitHub's conflict page when no chat can take it", () => {
    const openExternal = vi.fn();
    vi.stubGlobal("ade", { app: { openExternal } });
    runPrResolveConflicts(pr);
    expect(prConflictsUrl(pr)).toBe("https://github.com/acme/demo/pull/42/conflicts");
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/demo/pull/42/conflicts");
  });
});
