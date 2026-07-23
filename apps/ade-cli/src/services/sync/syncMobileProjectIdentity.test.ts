import { describe, expect, it } from "vitest";
import { headlessMobileProjectSummary } from "./headlessMobileProjectSummary";
import type { ProjectRecord } from "../projects/projectRegistry";

const record = (gitOriginUrl: string | null): ProjectRecord => ({
  projectId: "project_123",
  rootPath: "/projects/ade",
  displayName: "ADE",
  addedAt: 1,
  lastOpenedAt: 1_700_000_000_000,
  gitOriginUrl,
  catalogVisibility: "recent",
  registrationSource: "test",
});

describe("headlessMobileProjectSummary", () => {
  it("emits canonical repository identity from a GitHub origin", () => {
    expect(headlessMobileProjectSummary(
      record("git@github.com:Owner-A/Foo.git"),
      "data:image/png;base64,abc",
      { isOpen: true, laneCount: 3 },
    )).toEqual({
      id: "project_123",
      displayName: "ADE",
      rootPath: "/projects/ade",
      repoOwner: "Owner-A",
      repoName: "Foo",
      defaultBaseRef: null,
      lastOpenedAt: "2023-11-14T22:13:20.000Z",
      iconDataUrl: "data:image/png;base64,abc",
      laneCount: 3,
      isAvailable: true,
      isCached: true,
      isOpen: true,
    });
  });

  it.each([null, undefined, "https://gitlab.com/owner/foo.git", "https://notgithub.com/owner/foo.git"])(
    "emits paired unavailable identity for %s",
    (origin) => {
      const summary = headlessMobileProjectSummary(record(origin ?? null), null);
      expect(summary.repoOwner).toBeNull();
      expect(summary.repoName).toBeNull();
      expect(summary.lastOpenedAt).toBe("2023-11-14T22:13:20.000Z");
      expect(summary.isOpen).toBe(false);
    },
  );
});
