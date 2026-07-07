import { describe, expect, it } from "vitest";
import type { DeeplinkTarget } from "../../../../shared/deeplinks";
import { parseOpenTarget, parseWebPath, targetToWebPath } from "../webRoutes";

const targets: Array<{ name: string; target: DeeplinkTarget }> = [
  { name: "lane", target: { kind: "lane", laneId: "11111111-2222-3333-4444-555555555555" } },
  { name: "session", target: { kind: "session", sessionId: "sess-abc123" } },
  {
    name: "session with lane",
    target: { kind: "session", sessionId: "sess-abc123", laneId: "11111111-2222-3333-4444-555555555555" },
  },
  { name: "pr", target: { kind: "pr", repoOwner: "arul", repoName: "ade", prNumber: 708 } },
  { name: "branch", target: { kind: "branch", repoOwner: "arul", repoName: "ade", branch: "feature/web-shell" } },
  {
    name: "branch with pr",
    target: { kind: "branch", repoOwner: "arul", repoName: "ade", branch: "feature/web-shell", prNumber: 42 },
  },
  { name: "linear-issue", target: { kind: "linear-issue", issueIdentifier: "ADE-123" } },
  { name: "linear-issue with branch", target: { kind: "linear-issue", issueIdentifier: "ADE-123", branch: "arul/ade-123" } },
];

describe("targetToWebPath <-> parseWebPath round-trips", () => {
  for (const { name, target } of targets) {
    it(name, () => {
      const path = targetToWebPath(target);
      expect(parseWebPath(path)).toEqual(target);
    });
  }
});

describe("targetToWebPath produces the shared App routes", () => {
  it("routes sessions to /work", () => {
    expect(targetToWebPath({ kind: "session", sessionId: "s1" })).toBe("/work?sessionId=s1");
  });
  it("routes lanes to /lanes", () => {
    expect(targetToWebPath({ kind: "lane", laneId: "11111111-2222-3333-4444-555555555555" }))
      .toBe("/lanes?laneId=11111111-2222-3333-4444-555555555555");
  });
  it("routes prs to /prs with repo identity", () => {
    const path = targetToWebPath({ kind: "pr", repoOwner: "arul", repoName: "ade", prNumber: 708 });
    const url = new URL(path, "https://x.invalid");
    expect(url.pathname).toBe("/prs");
    expect(url.searchParams.get("pr")).toBe("708");
    expect(url.searchParams.get("repoOwner")).toBe("arul");
    expect(url.searchParams.get("repoName")).toBe("ade");
  });
});

describe("parseWebPath ignores extra desktop params", () => {
  it("maps /lanes?laneId=&sessionId= to a lane target", () => {
    expect(parseWebPath("/lanes?laneId=11111111-2222-3333-4444-555555555555&sessionId=s9")).toEqual({
      kind: "lane",
      laneId: "11111111-2222-3333-4444-555555555555",
    });
  });
  it("maps /prs?pr=&repoOwner=&repoName=&prId= to a pr target", () => {
    expect(parseWebPath("/prs?pr=708&repoOwner=arul&repoName=ade&prId=abc&laneId=x")).toEqual({
      kind: "pr",
      repoOwner: "arul",
      repoName: "ade",
      prNumber: 708,
    });
  });
});

describe("parseWebPath returns null for non-addressable routes", () => {
  for (const path of ["/work", "/lanes", "/prs", "/files", "/settings", "/", "/prs?pr=abc&repoOwner=a&repoName=b"]) {
    it(path, () => {
      expect(parseWebPath(path)).toBeNull();
    });
  }
});

describe("parseOpenTarget over the /open query grammar", () => {
  it("parses a lane /open URL", () => {
    expect(parseOpenTarget("/open?type=lane&id=11111111-2222-3333-4444-555555555555")).toEqual({
      kind: "lane",
      laneId: "11111111-2222-3333-4444-555555555555",
    });
  });
  it("parses a bare query string", () => {
    expect(parseOpenTarget("?type=pr&repo=arul/ade&number=708")).toEqual({
      kind: "pr",
      repoOwner: "arul",
      repoName: "ade",
      prNumber: 708,
    });
  });
  it("parses a full hosted URL regardless of host", () => {
    expect(parseOpenTarget("https://app.ade-app.dev/open?type=session&id=sess-1")).toEqual({
      kind: "session",
      sessionId: "sess-1",
    });
  });
  it("returns null for unknown types and empty input", () => {
    expect(parseOpenTarget("?type=bogus&id=1")).toBeNull();
    expect(parseOpenTarget("")).toBeNull();
  });
});

describe("open target feeds the shared App route", () => {
  it("bridges /open -> target -> web path", () => {
    const target = parseOpenTarget("/open?type=lane&id=11111111-2222-3333-4444-555555555555");
    expect(target).not.toBeNull();
    expect(targetToWebPath(target!)).toBe("/lanes?laneId=11111111-2222-3333-4444-555555555555");
  });
});
