import { describe, expect, it } from "vitest";

import {
  PLUGIN_ISSUE_PANEL_ID,
  buildDeeplink,
  deeplinkToNavigationTarget,
  describeTarget,
  issueDeeplinkContext,
  linearIssueTargetToIssueTarget,
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

  it("preserves exact account ownership for a work session", () => {
    const target = expectOk(parseDeeplink(
      "ade://session/session-123?accountMachineKey=machine-b&projectId=project-b",
    ));
    expect(target).toEqual({
      kind: "session",
      sessionId: "session-123",
      ownership: {
        accountMachineKey: "machine-b",
        projectId: "project-b",
      },
    });
  });

  it("parses the legacy projectRoot param without ever re-emitting it", () => {
    // ADE stopped minting `projectRoot` (it leaked the publisher's home
    // directory into every pasted link), but links already in PRs and Linear
    // issues still carry it, and it is the only thing that resolves a link
    // whose projectId is the publishing machine's private uuid.
    const target = expectOk(parseDeeplink(
      "ade://session/session-123?accountMachineKey=machine-b&projectId=project-b"
      + "&projectRoot=%2FUsers%2Farul%2FProjects%2FADE",
    ));
    expect(target).toEqual({
      kind: "session",
      sessionId: "session-123",
      ownership: {
        accountMachineKey: "machine-b",
        projectId: "project-b",
        projectRoot: "/Users/arul/Projects/ADE",
      },
    });
    // Re-minting the parsed target must not put the path back on the wire.
    const rebuilt = buildDeeplink(target);
    expect(rebuilt).not.toContain("projectRoot");
    expect(rebuilt).not.toContain("arul");
    expect(rebuilt).toContain("projectId=project-b");
  });

  it("drops an over-long projectRoot rather than failing the whole link", () => {
    const target = expectOk(parseDeeplink(
      "ade://session/session-123?accountMachineKey=machine-b&projectId=project-b"
      + `&projectRoot=${"a".repeat(5_000)}`,
    ));
    expect(target).toEqual({
      kind: "session",
      sessionId: "session-123",
      ownership: { accountMachineKey: "machine-b", projectId: "project-b" },
    });
  });

  it("rejects partial destination ownership instead of routing ambiguously", () => {
    const result = parseDeeplink(
      "ade://session/session-123?accountMachineKey=machine-b",
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "malformed",
        reason: "accountMachineKey and projectId must be provided together",
      },
      rawUrl: "ade://session/session-123?accountMachineKey=machine-b",
    });
  });

  it("parses session anchors and envelope params", () => {
    const target = expectOk(parseDeeplink(
      `ade://session/session-123?lane=${UUID}&event=4&offset=12&repo=owner%2Frepo&branch=feat&pr=42&linear=ADE-123`,
    ));
    expect(target).toEqual({
      kind: "session",
      sessionId: "session-123",
      laneId: UUID,
      event: 4,
      offset: 12,
      envelope: {
        repoOwner: "owner",
        repoName: "repo",
        branch: "feat",
        prNumber: 42,
        linearIssue: "ADE-123",
        // A link minted before the neutral params existed still fills both
        // fields, so a reader that only knows the new shape sees the fallback.
        issue: { provider: "linear", key: "ADE-123" },
      },
    });
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

  it("parses a PR detail tab and drops unknown future tabs", () => {
    expect(expectOk(parseDeeplink("ade://pr/anthropics/claude-code/1234?tab=checks"))).toEqual({
      kind: "pr",
      repoOwner: "anthropics",
      repoName: "claude-code",
      prNumber: 1234,
      detailTab: "checks",
    });
    expect(expectOk(parseDeeplink("ade://pr/anthropics/claude-code/1234?tab=future"))).toEqual({
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

  it("parses file, commit, and artifact links", () => {
    expect(expectOk(parseDeeplink(`ade://file/src/index.ts?line=10&lane=${UUID}`))).toEqual({
      kind: "file",
      path: "src/index.ts",
      line: 10,
      laneId: UUID,
    });
    expect(expectOk(parseDeeplink(`ade://commit/ABC1234?lane=${UUID}&repo=a%2Fb`))).toEqual({
      kind: "commit",
      sha: "abc1234",
      laneId: UUID,
      envelope: { repoOwner: "a", repoName: "b" },
    });
    expect(expectOk(parseDeeplink("ade://artifact/proof-123"))).toEqual({
      kind: "artifact",
      artifactId: "proof-123",
    });
  });

  it("rejects malformed session anchors", () => {
    expect(parseDeeplink("ade://session/session-123?event=abc").ok).toBe(false);
    expect(parseDeeplink("ade://session/session-123?offset=-5").ok).toBe(false);
  });

  it("rejects file links with traversal, absolute paths, or bad lines", () => {
    // Raw AND percent-encoded `..` segments are collapsed by WHATWG URL
    // normalization before the parser sees them — the ade:// path form can
    // never escape the root. (The validator still guards the https form.)
    const normalized = expectOk(parseDeeplink("ade://file/src/../../etc/passwd"));
    expect(normalized).toEqual({ kind: "file", path: "etc/passwd" });
    const encoded = expectOk(parseDeeplink("ade://file/src/%2E%2E/secret"));
    expect(encoded).toEqual({ kind: "file", path: "secret" });
    expect(parseDeeplink("ade://file/src/app.ts?line=0").ok).toBe(false);
    expect(parseDeeplink("ade://file/src/app.ts?line=abc").ok).toBe(false);
    // The https form carries the path as a query param (no URL normalization).
    expect(parseDeeplink("https://ade-app.dev/open?type=file&path=../etc/passwd").ok).toBe(false);
    expect(parseDeeplink("https://ade-app.dev/open?type=file&path=/etc/passwd").ok).toBe(false);
    expect(parseDeeplink("https://ade-app.dev/open?type=file&path=C:/windows").ok).toBe(false);
  });

  it("rejects malformed commit shas", () => {
    expect(parseDeeplink("ade://commit/xyz").ok).toBe(false);
    expect(parseDeeplink("ade://commit/abc12").ok).toBe(false);
  });

  it("drops malformed envelope components without failing the link", () => {
    const target = expectOk(
      parseDeeplink(`ade://lane/${UUID}?repo=notaslash&branch=..%2Fbad&pr=0&linear=nope!`),
    );
    expect(target).toEqual({ kind: "lane", laneId: UUID });
    const partial = expectOk(
      parseDeeplink(`ade://session/s-1?repo=anthropics/claude-code&pr=abc`),
    );
    expect(partial).toEqual({
      kind: "session",
      sessionId: "s-1",
      envelope: { repoOwner: "anthropics", repoName: "claude-code" },
    });
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

  it("parses a PR detail tab from the HTTPS form", () => {
    const target = expectOk(
      parseDeeplink("https://ade-app.dev/open?type=pr&repo=a/b&number=99&tab=files"),
    );
    expect(target).toEqual({
      kind: "pr",
      repoOwner: "a",
      repoName: "b",
      prNumber: 99,
      detailTab: "files",
    });
  });

  it("parses file, commit, artifact mirror links", () => {
    expect(expectOk(parseDeeplink(`https://ade-app.dev/open?type=file&path=src%2Findex.ts&line=2&lane=${UUID}`))).toEqual({
      kind: "file",
      path: "src/index.ts",
      line: 2,
      laneId: UUID,
    });
    expect(expectOk(parseDeeplink(`https://ade-app.dev/open?type=commit&sha=abc1234&lane=${UUID}&repo=a%2Fb`))).toEqual({
      kind: "commit",
      sha: "abc1234",
      laneId: UUID,
      envelope: { repoOwner: "a", repoName: "b" },
    });
    expect(expectOk(parseDeeplink("https://ade-app.dev/open?type=artifact&id=proof-123"))).toEqual({
      kind: "artifact",
      artifactId: "proof-123",
    });
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
    const target = {
      kind: "session",
      sessionId: "session-123",
      laneId: UUID,
      event: 7,
      offset: 20,
      envelope: { repoOwner: "a", repoName: "b", branch: "feat" },
    } as const;
    const ade = buildDeeplink(target, { form: "ade" });
    expect(expectOk(parseDeeplink(ade))).toEqual(target);

    const https = buildDeeplink(target);
    expect(expectOk(parseDeeplink(https))).toEqual(target);
  });

  it("round-trips exact account ownership for session and PR links", () => {
    const ownership = {
      accountMachineKey: "machine-b",
      projectId: "project-b",
    };
    const session = {
      kind: "session",
      sessionId: "session-123",
      ownership,
    } as const;
    expect(expectOk(parseDeeplink(
      buildDeeplink(session, { form: "ade" }),
    ))).toEqual(session);
    expect(expectOk(parseDeeplink(buildDeeplink(session)))).toEqual(session);

    const pr = {
      kind: "pr",
      repoOwner: "openai",
      repoName: "ade",
      prNumber: 42,
      detailTab: "checks",
      ownership,
    } as const;
    expect(expectOk(parseDeeplink(
      buildDeeplink(pr, { form: "ade" }),
    ))).toEqual(pr);
    expect(expectOk(parseDeeplink(buildDeeplink(pr)))).toEqual(pr);
  });

  it("accepts an owner-scoped PR without portable repo identity", () => {
    const target = {
      kind: "pr",
      prNumber: 42,
      ownership: {
        accountMachineKey: "machine-b",
        projectId: "project-b",
      },
    } as const;
    const url = buildDeeplink(target, { form: "ade" });
    expect(url).toBe(
      "ade://pr/42?accountMachineKey=machine-b&projectId=project-b",
    );
    expect(expectOk(parseDeeplink(url))).toEqual(target);
    expect(parseDeeplink("ade://pr/42").ok).toBe(false);
  });

  it("round-trips file, commit, and artifact links", () => {
    const file = { kind: "file", path: "src/app.ts", line: 3, laneId: UUID } as const;
    expect(expectOk(parseDeeplink(buildDeeplink(file, { form: "ade" })))).toEqual(file);
    expect(expectOk(parseDeeplink(buildDeeplink(file)))).toEqual(file);

    const commit = {
      kind: "commit",
      sha: "abc1234",
      laneId: UUID,
      envelope: { repoOwner: "a", repoName: "b", branch: "feat", prNumber: 7 },
    } as const;
    expect(expectOk(parseDeeplink(buildDeeplink(commit, { form: "ade" })))).toEqual(commit);
    expect(expectOk(parseDeeplink(buildDeeplink(commit)))).toEqual(commit);

    const artifact = { kind: "artifact", artifactId: "proof-123" } as const;
    expect(expectOk(parseDeeplink(buildDeeplink(artifact, { form: "ade" })))).toEqual(artifact);
    expect(expectOk(parseDeeplink(buildDeeplink(artifact)))).toEqual(artifact);
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

  it("round-trips a PR checks-tab target in both forms", () => {
    const target = {
      kind: "pr",
      repoOwner: "a",
      repoName: "b",
      prNumber: 100,
      detailTab: "checks",
    } as const;
    expect(buildDeeplink(target, { form: "ade" })).toBe("ade://pr/a/b/100?tab=checks");
    expect(expectOk(parseDeeplink(buildDeeplink(target, { form: "ade" })))).toEqual(target);
    expect(expectOk(parseDeeplink(buildDeeplink(target)))).toEqual(target);
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

describe("parseDeeplink — issue", () => {
  it("parses ade://issue/<provider>/<key>", () => {
    expect(expectOk(parseDeeplink("ade://issue/jira/PROJ-9"))).toEqual({
      kind: "issue",
      provider: "jira",
      issueKey: "PROJ-9",
    });
  });

  it("parses the branch and plugin hints in both forms", () => {
    expect(expectOk(parseDeeplink("ade://issue/jira/PROJ-9?branch=arul%2Fproj-9&plugin=ade-jira"))).toEqual({
      kind: "issue",
      provider: "jira",
      issueKey: "PROJ-9",
      branch: "arul/proj-9",
      pluginId: "ade-jira",
    });
    expect(expectOk(parseDeeplink(
      "https://ade-app.dev/open?type=issue&provider=jira&issue=PROJ-9&branch=arul%2Fproj-9&plugin=ade-jira",
    ))).toEqual({
      kind: "issue",
      provider: "jira",
      issueKey: "PROJ-9",
      branch: "arul/proj-9",
      pluginId: "ade-jira",
    });
  });

  it("round-trips through buildDeeplink in both forms", () => {
    const target = {
      kind: "issue" as const,
      provider: "jira",
      issueKey: "PROJ-9",
      branch: "arul/proj-9",
      pluginId: "ade-jira",
    };
    const ade = buildDeeplink(target, { form: "ade" });
    expect(ade).toBe("ade://issue/jira/PROJ-9?branch=arul%2Fproj-9&plugin=ade-jira");
    expect(expectOk(parseDeeplink(ade))).toEqual(target);

    const https = buildDeeplink(target);
    expect(https).toBe(
      "https://ade-app.dev/open?type=issue&provider=jira&issue=PROJ-9&branch=arul%2Fproj-9&plugin=ade-jira",
    );
    expect(expectOk(parseDeeplink(https))).toEqual(target);
  });

  it("round-trips a key that carries another tracker's punctuation", () => {
    // `owner/repo#42` is a real GitHub key. The slash and the hash must survive
    // encoding rather than becoming a second path segment and a fragment.
    const target = { kind: "issue" as const, provider: "github", issueKey: "owner/repo#42" };
    for (const form of ["ade", "https"] as const) {
      expect(expectOk(parseDeeplink(buildDeeplink(target, { form })))).toEqual(target);
    }
  });

  it("normalizes the provider but never the key", () => {
    expect(expectOk(parseDeeplink("ade://issue/JIRA/proj-9"))).toEqual({
      kind: "issue",
      provider: "jira",
      issueKey: "proj-9",
    });
  });

  it("rejects a provider, key, branch or plugin id it could not mint", () => {
    expect(parseDeeplink("ade://issue/ji ra/PROJ-9").ok).toBe(false);
    expect(parseDeeplink("ade://issue/jira/").ok).toBe(false);
    expect(parseDeeplink("ade://issue/jira").ok).toBe(false);
    expect(parseDeeplink(`ade://issue/jira/${"K".repeat(129)}`).ok).toBe(false);
    expect(parseDeeplink("ade://issue/jira/PROJ-9?branch=..%2Fbad").ok).toBe(false);
    expect(parseDeeplink("ade://issue/jira/PROJ-9?plugin=Ade%20Jira").ok).toBe(false);
    expect(parseDeeplink("https://ade-app.dev/open?type=issue&issue=PROJ-9").ok).toBe(false);
    expect(parseDeeplink("https://ade-app.dev/open?type=issue&provider=jira").ok).toBe(false);
  });

  it("keeps a Linear issue key loose here and strict in the envelope", () => {
    // The generic key rule admits anything a tracker might mint; the `?linear=`
    // envelope param keeps the strict Linear rule, because an older peer reads
    // that param and can only interpret a real Linear identifier.
    expect(expectOk(parseDeeplink("ade://issue/linear/not-a-linear-id"))).toEqual({
      kind: "issue",
      provider: "linear",
      issueKey: "not-a-linear-id",
    });
    expect(expectOk(parseDeeplink(`ade://lane/${UUID}?linear=not-a-linear-id`)))
      .toEqual({ kind: "lane", laneId: UUID });
  });

  it("maps a Linear issue to the same navigation target as the alias", () => {
    expect(deeplinkToNavigationTarget({
      kind: "issue",
      provider: "linear",
      issueKey: "ADE-123",
      branch: "feat",
    })).toEqual(deeplinkToNavigationTarget({
      kind: "linear-issue",
      issueIdentifier: "ADE-123",
      branch: "feat",
    }));
  });

  it("maps a plugin-owned issue to a plugin navigation target carrying the issue", () => {
    expect(deeplinkToNavigationTarget({
      kind: "issue",
      provider: "jira",
      issueKey: "PROJ-9",
      branch: "arul/proj-9",
      pluginId: "ade-jira",
    })).toEqual({
      kind: "plugin",
      pluginId: "ade-jira",
      panelId: PLUGIN_ISSUE_PANEL_ID,
      context: { issue: { provider: "jira", key: "PROJ-9", branch: "arul/proj-9" } },
    });
  });

  it("describes an issue exactly as it describes the alias", () => {
    const alias = { kind: "linear-issue" as const, issueIdentifier: "ADE-123", branch: "feat" };
    expect(describeTarget(linearIssueTargetToIssueTarget(alias))).toBe(describeTarget(alias));
  });
});

describe("linear-issue stays a permanent alias", () => {
  it("still parses to its own target on both forms", () => {
    // The compatibility promise: every link already minted says `linear-issue`,
    // and it must keep parsing to exactly what it parsed to before `issue`
    // existed — not to the new kind.
    expect(expectOk(parseDeeplink("ade://linear-issue/ADE-123?branch=feat"))).toEqual({
      kind: "linear-issue",
      issueIdentifier: "ADE-123",
      branch: "feat",
    });
    expect(expectOk(parseDeeplink(
      "https://ade-app.dev/open?type=linear-issue&issue=ADE-123&branch=feat",
    ))).toEqual({ kind: "linear-issue", issueIdentifier: "ADE-123", branch: "feat" });
  });

  it("keeps minting Linear links in the old spelling, byte for byte", () => {
    // A newer ADE must not mint links an older one cannot open, so nothing
    // routes Linear through the `issue` grammar on the way out.
    expect(buildDeeplink({ kind: "linear-issue", issueIdentifier: "ADE-123" }, { form: "ade" }))
      .toBe("ade://linear-issue/ADE-123");
    expect(buildDeeplink({ kind: "linear-issue", issueIdentifier: "ADE-123" }))
      .toBe("https://ade-app.dev/open?type=linear-issue&issue=ADE-123");
  });

  it("converts to the generic shape resolvers use", () => {
    expect(linearIssueTargetToIssueTarget({
      kind: "linear-issue",
      issueIdentifier: "ADE-123",
      branch: "feat",
    })).toEqual({ kind: "issue", provider: "linear", issueKey: "ADE-123", branch: "feat" });
    expect(linearIssueTargetToIssueTarget({ kind: "linear-issue", issueIdentifier: "ADE-123" }))
      .toEqual({ kind: "issue", provider: "linear", issueKey: "ADE-123" });
  });

  it("converts to a target that resolves to the same place", () => {
    const alias = { kind: "linear-issue" as const, issueIdentifier: "ADE-123", branch: "feat" };
    expect(deeplinkToNavigationTarget(linearIssueTargetToIssueTarget(alias)))
      .toEqual(deeplinkToNavigationTarget(alias));
  });

  it("builds the panel context from an issue target", () => {
    expect(issueDeeplinkContext({ kind: "issue", provider: "jira", issueKey: "PROJ-9" }))
      .toEqual({ issue: { provider: "jira", key: "PROJ-9" } });
  });
});

describe("deeplink envelope — issue fallback", () => {
  const laneWith = (envelope: Record<string, unknown>) =>
    buildDeeplink({ kind: "lane", laneId: UUID, envelope } as DeeplinkTarget, { form: "ade" });

  it("writes ?linear= and the neutral params together for a Linear issue", () => {
    const url = laneWith({ issue: { provider: "linear", key: "ADE-123" } });
    // `?linear=` is what a peer on an older build reads. Dropping it in favour
    // of the neutral params would silently lose the fallback on exactly the
    // machines that need one.
    expect(url).toContain("linear=ADE-123");
    expect(url).toContain("issueProvider=linear");
    expect(url).toContain("issueKey=ADE-123");
    expect(expectOk(parseDeeplink(url))).toEqual({
      kind: "lane",
      laneId: UUID,
      envelope: { linearIssue: "ADE-123", issue: { provider: "linear", key: "ADE-123" } },
    });
  });

  it("reads an old-style ?linear=-only envelope into both fields", () => {
    expect(expectOk(parseDeeplink(`ade://lane/${UUID}?linear=ADE-123`))).toEqual({
      kind: "lane",
      laneId: UUID,
      envelope: { linearIssue: "ADE-123", issue: { provider: "linear", key: "ADE-123" } },
    });
  });

  it("writes no ?linear= for a tracker an older peer could not interpret", () => {
    const url = laneWith({ issue: { provider: "jira", key: "PROJ-9" } });
    expect(url).not.toContain("linear=");
    expect(expectOk(parseDeeplink(url))).toEqual({
      kind: "lane",
      laneId: UUID,
      envelope: { issue: { provider: "jira", key: "PROJ-9" } },
    });
  });

  it("round-trips a full envelope on both forms", () => {
    const envelope = {
      repoOwner: "a",
      repoName: "b",
      branch: "feat",
      prNumber: 7,
      linearIssue: "ADE-123",
      issue: { provider: "linear", key: "ADE-123" },
    };
    const target = { kind: "commit" as const, sha: "abc1234", envelope };
    expect(expectOk(parseDeeplink(buildDeeplink(target, { form: "ade" })))).toEqual(target);
    expect(expectOk(parseDeeplink(buildDeeplink(target)))).toEqual(target);
  });

  it("drops a malformed issue fallback without failing the link", () => {
    expect(expectOk(parseDeeplink(`ade://lane/${UUID}?issueProvider=ji%20ra&issueKey=PROJ-9`)))
      .toEqual({ kind: "lane", laneId: UUID });
    expect(expectOk(parseDeeplink(`ade://lane/${UUID}?issueProvider=jira`)))
      .toEqual({ kind: "lane", laneId: UUID });
  });
});

describe("parseDeeplink — plugin", () => {
  it("parses ade://plugin/<pluginId>/<panelId>", () => {
    expect(expectOk(parseDeeplink("ade://plugin/ade-graph/main"))).toEqual({
      kind: "plugin",
      pluginId: "ade-graph",
      panelId: "main",
    });
  });

  it("carries a small context object", () => {
    const target = expectOk(
      parseDeeplink(`ade://plugin/jira/issue?ctx=${encodeURIComponent('{"issue":"ISS-14"}')}`),
    );
    expect(target).toEqual({
      kind: "plugin",
      pluginId: "jira",
      panelId: "issue",
      context: { issue: "ISS-14" },
    });
  });

  it("parses the https mirror", () => {
    expect(expectOk(parseDeeplink(
      "https://ade-app.dev/open?type=plugin&plugin=jira&panel=issue",
    ))).toEqual({ kind: "plugin", pluginId: "jira", panelId: "issue" });
  });

  // The ids name a directory and a manifest entry, so a bad one is fatal.
  it("rejects ids that could not be a plugin or a panel", () => {
    expect(parseDeeplink("ade://plugin/Ade-Graph/main").ok).toBe(false);
    expect(parseDeeplink("ade://plugin/ade%2Fgraph/main").ok).toBe(false);
    expect(parseDeeplink("ade://plugin/ade-graph").ok).toBe(false);
    expect(parseDeeplink("ade://plugin/ade-graph/main/extra").ok).toBe(false);
    expect(parseDeeplink("ade://plugin/ade-graph/not a panel").ok).toBe(false);
  });

  // A `..` never reaches the id check: the URL parser collapses it, so the link
  // names an ordinary plugin id that simply has to be installed. Asserted so a
  // future change to how the path is read cannot quietly turn it into traversal.
  it("collapses traversal in the path rather than honouring it", () => {
    expect(expectOk(parseDeeplink("ade://plugin/../ade-graph/main"))).toEqual({
      kind: "plugin",
      pluginId: "ade-graph",
      panelId: "main",
    });
  });

  // The context is a hint about what to look at. Losing it must never cost the
  // reader the page, so every bad shape drops it and the link still resolves.
  it.each([
    ["not JSON", "{oops"],
    ["not an object", '"just a string"'],
    ["an array", "[1,2,3]"],
    ["over the ceiling", JSON.stringify({ blob: "x".repeat(4096) })],
  ])("drops a context that is %s and still opens the panel", (_label, ctx) => {
    const target = expectOk(parseDeeplink(`ade://plugin/jira/issue?ctx=${encodeURIComponent(ctx)}`));
    expect(target).toEqual({ kind: "plugin", pluginId: "jira", panelId: "issue" });
  });

  // The ceiling is in BYTES on every other reader (`ade link --ctx`, iOS,
  // `readPluginActionNavigation`). Counting UTF-16 units here would let one
  // link be minted by the desktop and refused by the CLI that reads it.
  it("measures the context ceiling in utf-8 bytes, not string length", () => {
    // ~1.4k characters, ~4.2k bytes: under the ceiling by length, over it by
    // the measure every other reader uses.
    const wide = JSON.stringify({ note: "字".repeat(1400) });
    expect(wide.length).toBeLessThan(2048);
    const target = expectOk(parseDeeplink(`ade://plugin/jira/issue?ctx=${encodeURIComponent(wide)}`));
    expect(target).toEqual({ kind: "plugin", pluginId: "jira", panelId: "issue" });
    expect(buildDeeplink({
      kind: "plugin",
      pluginId: "jira",
      panelId: "issue",
      context: { note: "字".repeat(1400) },
    }, { form: "ade" })).toBe("ade://plugin/jira/issue");
  });

  it("round-trips through buildDeeplink in both forms", () => {
    const target = {
      kind: "plugin" as const,
      pluginId: "jira",
      panelId: "issue",
      context: { issue: "ISS-14" },
    };
    const ade = buildDeeplink(target, { form: "ade" });
    expect(ade.startsWith("ade://plugin/jira/issue?ctx=")).toBe(true);
    expect(expectOk(parseDeeplink(ade))).toEqual(target);
    expect(expectOk(parseDeeplink(buildDeeplink(target)))).toEqual(target);
  });

  it("maps to a navigation target", () => {
    expect(deeplinkToNavigationTarget({
      kind: "plugin",
      pluginId: "jira",
      panelId: "issue",
      context: { issue: "ISS-14" },
    })).toEqual({
      kind: "plugin",
      pluginId: "jira",
      panelId: "issue",
      context: { issue: "ISS-14" },
    });
    expect(deeplinkToNavigationTarget({ kind: "plugin", pluginId: "jira", panelId: "issue" }))
      .toEqual({ kind: "plugin", pluginId: "jira", panelId: "issue", context: null });
  });
});

describe("lane drawer + welcome", () => {
  it("parses a lane drawer from both forms", () => {
    expect(expectOk(parseDeeplink(`ade://lane/${UUID}?drawer=stack`)))
      .toEqual({ kind: "lane", laneId: UUID, drawer: "stack" });
    expect(expectOk(parseDeeplink(`https://ade-app.dev/open?type=lane&id=${UUID}&drawer=stack`)))
      .toEqual({ kind: "lane", laneId: UUID, drawer: "stack" });
  });

  it("round-trips a lane drawer in both forms", () => {
    const ade = buildDeeplink({ kind: "lane", laneId: UUID, drawer: "stack" }, { form: "ade" });
    expect(ade).toBe(`ade://lane/${UUID}?drawer=stack`);
    expect(expectOk(parseDeeplink(ade))).toEqual({ kind: "lane", laneId: UUID, drawer: "stack" });

    const https = buildDeeplink({ kind: "lane", laneId: UUID, drawer: "stack" });
    expect(https).toBe(`https://ade-app.dev/open?type=lane&id=${UUID}&drawer=stack`);
    expect(expectOk(parseDeeplink(https))).toEqual({ kind: "lane", laneId: UUID, drawer: "stack" });
  });

  it("drops a drawer this build does not know and still opens the lane", () => {
    // The `?tab=` leniency rule: a link minted by a newer ADE must not fail to
    // open a lane on an older one over a panel it cannot draw.
    expect(expectOk(parseDeeplink(`ade://lane/${UUID}?drawer=holodeck`)))
      .toEqual({ kind: "lane", laneId: UUID });
    expect(expectOk(parseDeeplink(`https://ade-app.dev/open?type=lane&id=${UUID}&drawer=`)))
      .toEqual({ kind: "lane", laneId: UUID });
  });

  it("carries the drawer beside an envelope", () => {
    expect(expectOk(parseDeeplink(`ade://lane/${UUID}?drawer=STACK&repo=arul/ade`)))
      .toEqual({ kind: "lane", laneId: UUID, drawer: "stack", envelope: { repoOwner: "arul", repoName: "ade" } });
  });

  it("parses and round-trips the project picker in both forms", () => {
    expect(expectOk(parseDeeplink("ade://welcome"))).toEqual({ kind: "welcome" });
    expect(expectOk(parseDeeplink("https://ade-app.dev/open?type=welcome"))).toEqual({ kind: "welcome" });
    expect(buildDeeplink({ kind: "welcome" }, { form: "ade" })).toBe("ade://welcome");
    expect(buildDeeplink({ kind: "welcome" })).toBe("https://ade-app.dev/open?type=welcome");
  });

  it("maps both onto the navigation targets the dispatcher reads", () => {
    expect(deeplinkToNavigationTarget({ kind: "lane", laneId: UUID, drawer: "stack" }))
      .toEqual({ kind: "lane", laneId: UUID, drawer: "stack", envelope: null });
    expect(deeplinkToNavigationTarget({ kind: "lane", laneId: UUID }))
      .toEqual({ kind: "lane", laneId: UUID, drawer: null, envelope: null });
    expect(deeplinkToNavigationTarget({ kind: "welcome" })).toEqual({ kind: "welcome" });
  });

  it("describes the project picker", () => {
    expect(describeTarget({ kind: "welcome" })).toBe("project picker");
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
