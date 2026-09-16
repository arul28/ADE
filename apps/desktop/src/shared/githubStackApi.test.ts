import { describe, expect, it } from "vitest";
import {
  githubHttpStatusFromError,
  githubStackApiErrorKind,
} from "./githubStackApi";

describe("githubHttpStatusFromError", () => {
  it("reads GitHub Not Found copy and HTTP status wrappers", () => {
    expect(githubHttpStatusFromError(new Error("Not Found"))).toBe(404);
    expect(githubHttpStatusFromError(new Error("GitHub API request failed (HTTP 403)"))).toBe(403);
    expect(githubHttpStatusFromError(new Error("GitHub API request failed (HTTP 405)"))).toBe(405);
    expect(githubHttpStatusFromError(new Error("Method Not Allowed"))).toBe(405);
    expect(githubHttpStatusFromError(new Error("file not found in the tree"))).toBeNull();
  });

  it("does not treat a merge timeout on PR #405 as HTTP 405", () => {
    expect(githubHttpStatusFromError(
      new Error("GitHub did not finish merging #405 in stack #4."),
    )).toBeNull();
    expect(githubStackApiErrorKind(
      new Error("GitHub did not finish merging #405 in stack #4."),
    )).toBe("other");
  });

  it("classifies GitHub App preview denials as forbidden", () => {
    expect(githubHttpStatusFromError(new Error("Resource not accessible by integration"))).toBe(403);
    expect(githubStackApiErrorKind(new Error("Resource not accessible by integration"))).toBe("forbidden");
  });

  it("classifies stacked update-branch rejection as a missing stack-rebase API", () => {
    expect(githubStackApiErrorKind(
      new Error("Updating a stacked PR's branch via this endpoint is not supported."),
    )).toBe("missing");
  });
});
