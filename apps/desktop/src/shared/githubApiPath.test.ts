import { describe, expect, it, vi } from "vitest";
import {
  classifyGitHubRepositoryApiPath,
  createGithubRepositoryRequestFallback,
} from "./githubApiPath";

describe("githubApiPath", () => {
  it("classifies repository roots and nested paths", () => {
    expect(classifyGitHubRepositoryApiPath("/repos/acme/ade")).toEqual({
      owner: "acme",
      name: "ade",
      isRepositoryRoot: true,
    });
    expect(classifyGitHubRepositoryApiPath("/repos/acme%20org/ade/issues?state=open"))
      .toEqual({ owner: "acme org", name: "ade", isRepositoryRoot: false });
    expect(classifyGitHubRepositoryApiPath("/user/emails")).toBeNull();
  });

  it("persists root misses without poisoning a repo after a nested 404", () => {
    const candidate = { token: "app" };
    const access = new Map<string, boolean>();
    const readAccess = vi.fn(() => access.get(candidate.token) ?? null);
    const recordAccess = vi.fn((_candidate, _repo, accessible: boolean) => {
      access.set(candidate.token, accessible);
    });
    const nested = createGithubRepositoryRequestFallback({
      path: classifyGitHubRepositoryApiPath("/repos/acme/ade/issues/404"),
      readAccess,
      recordAccess,
    });
    expect(nested.classifyFailure(candidate, 404)).toEqual({
      repositoryNotFound: true,
      ambiguousRepositoryNotFound: true,
    });
    expect(recordAccess).not.toHaveBeenCalled();
    expect(nested.shouldSkip(candidate)).toBe(false);

    const root = createGithubRepositoryRequestFallback({
      path: classifyGitHubRepositoryApiPath("/repos/acme/ade"),
      readAccess,
      recordAccess,
    });
    root.classifyFailure(candidate, 404);
    expect(recordAccess).toHaveBeenLastCalledWith(
      candidate,
      expect.objectContaining({ owner: "acme", name: "ade" }),
      false,
    );
    expect(root.shouldSkip(candidate)).toBe(true);
  });
});
