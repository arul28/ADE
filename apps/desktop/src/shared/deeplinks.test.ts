import { describe, expect, it } from "vitest";

import {
  buildDeeplink,
  describeTarget,
  looksLikeAdeDeeplink,
  parseDeeplink,
  type DeeplinkTarget,
} from "./deeplinks";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

function expectOk(result: ReturnType<typeof parseDeeplink>): DeeplinkTarget {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.kind}: ${(result.error as { reason?: string }).reason ?? ""}`);
  }
  return result.target;
}

describe("parseDeeplink — ade:// scheme", () => {
  it("parses lane links", () => {
    const target = expectOk(parseDeeplink(`ade://lane/${UUID}`));
    expect(target).toEqual({ kind: "lane", laneId: UUID });
  });

  it("rejects lane links with non-UUID ids", () => {
    const result = parseDeeplink("ade://lane/not-a-uuid");
    expect(result.ok).toBe(false);
  });

  it("parses work session links", () => {
    const target = expectOk(parseDeeplink(`ade://session/session-123?lane=${UUID}`));
    expect(target).toEqual({ kind: "session", sessionId: "session-123", laneId: UUID });
  });

  it("rejects work session links with control characters", () => {
    const result = parseDeeplink("ade://session/session%0A123");
    expect(result.ok).toBe(false);
  });

  it("parses repo/branch links with simple branches", () => {
    const target = expectOk(parseDeeplink("ade://repo/anthropics/claude-code/branch/feat-deeplinks"));
    expect(target).toEqual({
      kind: "branch",
      repoOwner: "anthropics",
      repoName: "claude-code",
      branch: "feat-deeplinks",
    });
  });

  it("parses repo/branch links with slash-containing branches", () => {
    const target = expectOk(parseDeeplink("ade://repo/anthropics/claude-code/branch/users/arul/feat-x"));
    expect(target).toEqual({
      kind: "branch",
      repoOwner: "anthropics",
      repoName: "claude-code",
      branch: "users/arul/feat-x",
    });
  });

  it("parses pr-number on branch link", () => {
    const target = expectOk(parseDeeplink("ade://repo/anthropics/claude-code/branch/feat-x?pr=1234"));
    expect(target).toEqual({
      kind: "branch",
      repoOwner: "anthropics",
      repoName: "claude-code",
      branch: "feat-x",
      prNumber: 1234,
    });
  });

  it("rejects branch links with traversal segments", () => {
    const result = parseDeeplink("ade://repo/anthropics/claude-code/branch/../etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("parses pr links", () => {
    const target = expectOk(parseDeeplink("ade://pr/anthropics/claude-code/1234"));
    expect(target).toEqual({
      kind: "pr",
      repoOwner: "anthropics",
      repoName: "claude-code",
      prNumber: 1234,
    });
  });

  it("rejects pr links with non-integer numbers", () => {
    const result = parseDeeplink("ade://pr/anthropics/claude-code/notanumber");
    expect(result.ok).toBe(false);
  });

  it("rejects unknown ade:// hosts", () => {
    const result = parseDeeplink("ade://surprise/anything");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unknown_type");
  });
});

describe("parseDeeplink — https://ade-app.dev/open", () => {
  it("parses lane links", () => {
    const target = expectOk(parseDeeplink(`https://ade-app.dev/open?type=lane&id=${UUID}`));
    expect(target).toEqual({ kind: "lane", laneId: UUID });
  });

  it("parses session links", () => {
    const target = expectOk(
      parseDeeplink(`https://ade-app.dev/open?type=session&id=session-123&lane=${UUID}`),
    );
    expect(target).toEqual({ kind: "session", sessionId: "session-123", laneId: UUID });
  });

  it("parses branch links", () => {
    const target = expectOk(
      parseDeeplink("https://ade-app.dev/open?type=branch&repo=anthropics/claude-code&branch=feat-x"),
    );
    expect(target).toEqual({
      kind: "branch",
      repoOwner: "anthropics",
      repoName: "claude-code",
      branch: "feat-x",
    });
  });

  it("parses branch links with pr query", () => {
    const target = expectOk(
      parseDeeplink("https://ade-app.dev/open?type=branch&repo=a/b&branch=f&pr=42"),
    );
    expect(target).toEqual({
      kind: "branch",
      repoOwner: "a",
      repoName: "b",
      branch: "f",
      prNumber: 42,
    });
  });

  it("parses pr links", () => {
    const target = expectOk(parseDeeplink("https://ade-app.dev/open?type=pr&repo=a/b&number=99"));
    expect(target).toEqual({ kind: "pr", repoOwner: "a", repoName: "b", prNumber: 99 });
  });

  it("parses legacy ade.app links for old PR bodies and Linear cards", () => {
    const target = expectOk(parseDeeplink("https://ade.app/open?type=pr&repo=a/b&number=99"));
    expect(target).toEqual({ kind: "pr", repoOwner: "a", repoName: "b", prNumber: 99 });
  });

  it("rejects http with wrong host", () => {
    const result = parseDeeplink("https://example.com/open?type=lane&id=" + UUID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unsupported_host");
  });

  it("rejects unknown scheme", () => {
    const result = parseDeeplink("javascript:alert(1)");
    expect(result.ok).toBe(false);
  });

  it("rejects empty input", () => {
    const result = parseDeeplink("");
    expect(result.ok).toBe(false);
  });

  it("rejects garbage", () => {
    const result = parseDeeplink("totally not a url");
    expect(result.ok).toBe(false);
  });
});

describe("buildDeeplink", () => {
  it("round-trips lane (ade)", () => {
    const url = buildDeeplink({ kind: "lane", laneId: UUID }, { form: "ade" });
    expect(url).toBe(`ade://lane/${UUID}`);
    expect(expectOk(parseDeeplink(url))).toEqual({ kind: "lane", laneId: UUID });
  });

  it("round-trips lane (https)", () => {
    const url = buildDeeplink({ kind: "lane", laneId: UUID });
    expect(url).toBe(`https://ade-app.dev/open?type=lane&id=${UUID}`);
    expect(expectOk(parseDeeplink(url))).toEqual({ kind: "lane", laneId: UUID });
  });

  it("round-trips session links", () => {
    const target = { kind: "session", sessionId: "session-123", laneId: UUID } as const;
    const ade = buildDeeplink(target, { form: "ade" });
    expect(ade).toBe(`ade://session/session-123?lane=${UUID}`);
    expect(expectOk(parseDeeplink(ade))).toEqual(target);

    const https = buildDeeplink(target);
    expect(https).toBe(`https://ade-app.dev/open?type=session&id=session-123&lane=${UUID}`);
    expect(expectOk(parseDeeplink(https))).toEqual(target);
  });

  it("round-trips branch (ade) with slash branches", () => {
    const target = { kind: "branch", repoOwner: "a", repoName: "b", branch: "users/me/x" } as const;
    const url = buildDeeplink(target, { form: "ade" });
    expect(url).toBe("ade://repo/a/b/branch/users/me/x");
    expect(expectOk(parseDeeplink(url))).toEqual(target);
  });

  it("round-trips branch with pr number (https)", () => {
    const target = { kind: "branch", repoOwner: "a", repoName: "b", branch: "feat", prNumber: 7 } as const;
    const url = buildDeeplink(target);
    expect(expectOk(parseDeeplink(url))).toEqual(target);
  });

  it("round-trips pr (ade)", () => {
    const target = { kind: "pr", repoOwner: "a", repoName: "b", prNumber: 100 } as const;
    const url = buildDeeplink(target, { form: "ade" });
    expect(url).toBe("ade://pr/a/b/100");
    expect(expectOk(parseDeeplink(url))).toEqual(target);
  });

  it("round-trips pr (https)", () => {
    const target = { kind: "pr", repoOwner: "a", repoName: "b", prNumber: 100 } as const;
    const url = buildDeeplink(target);
    expect(expectOk(parseDeeplink(url))).toEqual(target);
  });
});

describe("parseDeeplink — linear-issue", () => {
  it("parses ade://linear-issue/<id>", () => {
    const target = expectOk(parseDeeplink("ade://linear-issue/ADE-123"));
    expect(target).toEqual({ kind: "linear-issue", issueIdentifier: "ADE-123" });
  });

  it("parses ade://linear-issue/<id>?branch=<branch>", () => {
    const target = expectOk(parseDeeplink("ade://linear-issue/ADE-123?branch=arul/ade-123-feat"));
    expect(target).toEqual({
      kind: "linear-issue",
      issueIdentifier: "ADE-123",
      branch: "arul/ade-123-feat",
    });
  });

  it("parses https mirror", () => {
    const target = expectOk(
      parseDeeplink("https://ade-app.dev/open?type=linear-issue&issue=ADE-123&branch=feat-x"),
    );
    expect(target).toEqual({
      kind: "linear-issue",
      issueIdentifier: "ADE-123",
      branch: "feat-x",
    });
  });

  it("rejects bad identifier shapes", () => {
    expect(parseDeeplink("ade://linear-issue/not-a-real-id").ok).toBe(false);
    expect(parseDeeplink("ade://linear-issue/123-456").ok).toBe(false);
    expect(parseDeeplink("ade://linear-issue/").ok).toBe(false);
  });

  it("round-trips through buildDeeplink", () => {
    const target = { kind: "linear-issue" as const, issueIdentifier: "ADE-123", branch: "feat" };
    const ade = buildDeeplink(target, { form: "ade" });
    expect(ade).toBe("ade://linear-issue/ADE-123?branch=feat");
    expect(expectOk(parseDeeplink(ade))).toEqual(target);

    const https = buildDeeplink(target);
    expect(expectOk(parseDeeplink(https))).toEqual(target);
  });
});

describe("looksLikeAdeDeeplink", () => {
  it("matches ade:// urls", () => {
    expect(looksLikeAdeDeeplink("ade://lane/abc")).toBe(true);
  });

  it("matches https://ade-app.dev/open urls", () => {
    expect(looksLikeAdeDeeplink("https://ade-app.dev/open?type=lane&id=" + UUID)).toBe(true);
  });

  it("matches legacy https://ade.app/open urls", () => {
    expect(looksLikeAdeDeeplink("https://ade.app/open?type=lane&id=" + UUID)).toBe(true);
  });

  it("rejects http mirror urls", () => {
    expect(looksLikeAdeDeeplink("http://ade-app.dev/open?type=lane&id=" + UUID)).toBe(false);
  });

  it("rejects unrelated urls", () => {
    expect(looksLikeAdeDeeplink("https://github.com/foo")).toBe(false);
    expect(looksLikeAdeDeeplink("hello world")).toBe(false);
    expect(looksLikeAdeDeeplink("")).toBe(false);
  });

  it("rejects suspiciously long input", () => {
    expect(looksLikeAdeDeeplink("ade://lane/" + "a".repeat(4096))).toBe(false);
  });
});

describe("describeTarget", () => {
  it("summarizes branch targets", () => {
    expect(describeTarget({ kind: "branch", repoOwner: "a", repoName: "b", branch: "feat" })).toBe(
      "a/b@feat",
    );
  });
  it("summarizes pr targets", () => {
    expect(describeTarget({ kind: "pr", repoOwner: "a", repoName: "b", prNumber: 7 })).toBe("a/b#7");
  });
  it("summarizes lane targets", () => {
    expect(describeTarget({ kind: "lane", laneId: UUID })).toBe("lane link");
  });
});
