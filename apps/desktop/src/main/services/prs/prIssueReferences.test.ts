import { describe, expect, it } from "vitest";
import type {
  IssueLink,
  LaneGitHubIssue,
  LaneLinearIssue,
  LaneLinearIssueLink,
  LaneSummary,
} from "../../../shared/types";
import {
  CORE_ISSUE_PLUGIN_ID,
  ISSUE_PROVIDER_GITHUB,
  ISSUE_PROVIDER_LINEAR,
  issueRefFromGitHubIssue,
  readLinearIssueRef,
  type IssueRef,
} from "../../../shared/issueRef";
import {
  ensureLinearPrIssueLinkSection,
  ensureLinearPrReferences,
} from "../../../shared/linearMagicWords";
import {
  applyLinearPrLinkage,
  applyOtherProviderPrLinkage,
  collectLanePrIssueRefs,
  collectLinearPrIssueReferences,
  collectOtherProviderPrIssueReferences,
  lanePrimaryIssueClosesOnMerge,
} from "./prService";

/**
 * The lane half of `applyIssuePrLinkage`: Linear, then every other tracker.
 * The GitHub pass reads session rows off the lane service, which a plain lane
 * fixture cannot supply, so it is not part of this composition.
 */
function applyLanePrLinkage(body: string, laneSummary: LaneSummary, closePrimaryOnMerge: boolean): string {
  const withLinear = applyLinearPrLinkage(body, laneSummary, closePrimaryOnMerge);
  return applyOtherProviderPrLinkage(
    withLinear,
    collectOtherProviderPrIssueReferences(laneSummary, closePrimaryOnMerge),
  );
}

function linearIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
  const identifier = overrides.identifier ?? "ADE-123";
  return {
    id: "issue-1",
    identifier,
    title: "Link Linear issues deeply",
    description: null,
    url: `https://linear.app/ade/issue/${identifier}`,
    projectId: "project-1",
    projectSlug: "ade",
    teamId: "team-1",
    teamKey: "ADE",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 0,
    priorityLabel: "none",
    labels: [],
    assigneeId: null,
    assigneeName: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

function githubIssue(overrides: Partial<LaneGitHubIssue> = {}): LaneGitHubIssue {
  return {
    id: "gh-1",
    number: 42,
    owner: "ade",
    repo: "app",
    title: "Fix the thing",
    url: "https://github.com/ade/app/issues/42",
    state: "open",
    labels: [],
    assignees: [],
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

function lane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "ADE-123 Link Linear issues deeply",
    laneType: "worktree",
    baseRef: "refs/heads/main",
    branchRef: "refs/heads/ade-123-link-linear-issues-deeply",
    worktreePath: "/tmp/lane-1",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: 0,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

function linearLink(overrides: Partial<LaneLinearIssueLink> = {}): LaneLinearIssueLink {
  return {
    id: "link-1",
    laneId: "lane-1",
    issue: linearIssue(),
    role: "primary",
    source: "lane_create",
    includeInPr: true,
    closeOnMerge: true,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

function issueLink(issue: IssueRef, overrides: Partial<IssueLink> = {}): IssueLink {
  return {
    id: "link-1",
    laneId: "lane-1",
    sessionId: null,
    issue,
    role: "primary",
    source: "lane_create",
    includeInPr: true,
    closeOnMerge: true,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

/** The body today's code produced, written out by hand from the same renderers. */
function expectedLinearBody(
  body: string,
  references: Array<{ issue: LaneLinearIssue; closeOnMerge: boolean }>,
): string {
  return ensureLinearPrIssueLinkSection(
    ensureLinearPrReferences(body, references, { preserveExisting: false }),
    references,
  );
}

const PRIMARY = linearIssue();
const SECONDARY = linearIssue({
  id: "issue-2",
  identifier: "OPS-9",
  title: "Update ops hooks",
});

describe("collectLinearPrIssueReferences", () => {
  it("reads a legacy lane that has only linearIssue and linearIssueLinks", () => {
    // The old-row fallback: nothing populated `issueLinks` or `primaryIssue`.
    const legacyLane = lane({
      linearIssue: PRIMARY,
      linearIssueLinks: [
        linearLink({ id: "link-1", issue: PRIMARY, role: "primary", closeOnMerge: true }),
        linearLink({
          id: "link-2",
          issue: SECONDARY,
          role: "worked",
          closeOnMerge: false,
        }),
      ],
    });

    const refs = collectLinearPrIssueReferences(legacyLane, true);
    expect(refs).toEqual([
      { issue: PRIMARY, closeOnMerge: true, role: "primary" },
      { issue: SECONDARY, closeOnMerge: false, role: "worked" },
    ]);
    // Object identity: the legacy row itself is handed to the renderer, not a
    // round trip through IssueRef.
    expect(refs[0]?.issue).toBe(PRIMARY);
    expect(refs[1]?.issue).toBe(SECONDARY);

    expect(applyLinearPrLinkage("Summary\n", legacyLane, true)).toBe(expectedLinearBody("Summary\n", [
      { issue: PRIMARY, closeOnMerge: true },
      { issue: SECONDARY, closeOnMerge: false },
    ]));
    // Pinned verbatim: this exact string is what the pre-IssueRef collector
    // emitted for this lane, captured by running it from git HEAD.
    expect(applyLinearPrLinkage("Summary\n", legacyLane, true)).toBe(
      "Fixes ADE-123\n"
      + "\n"
      + "Refs OPS-9\n"
      + "\n"
      + "Summary\n"
      + "\n"
      + "<!-- ade:linear-links v=1 -->\n"
      + "### Linked Linear issues\n"
      + "\n"
      + "- [ADE-123: Link Linear issues deeply](https://linear.app/ade/issue/ADE-123) - closes on merge\n"
      + "- [OPS-9: Update ops hooks](https://linear.app/ade/issue/OPS-9) - referenced\n"
      + "<!-- /ade:linear-links -->\n",
    );
  });

  it("produces an identical PR body from the generic shape and from the legacy fields", () => {
    const legacyLane = lane({
      linearIssue: PRIMARY,
      linearIssueLinks: [
        linearLink({ id: "link-1", issue: PRIMARY, role: "primary", closeOnMerge: true }),
        linearLink({ id: "link-2", issue: SECONDARY, role: "worked", closeOnMerge: false }),
      ],
    });
    const genericLane = lane({
      ...legacyLane,
      primaryIssue: readLinearIssueRef(PRIMARY),
      issueLinks: [
        issueLink(readLinearIssueRef(PRIMARY), { id: "link-1", role: "primary", closeOnMerge: true }),
        issueLink(readLinearIssueRef(SECONDARY), {
          id: "link-2",
          role: "worked",
          closeOnMerge: false,
        }),
      ],
    });

    const body = "Summary line\n\nMore detail.\n";
    expect(applyLinearPrLinkage(body, genericLane, true))
      .toBe(applyLinearPrLinkage(body, legacyLane, true));
    expect(applyLinearPrLinkage(body, genericLane, true)).toBe(expectedLinearBody(body, [
      { issue: PRIMARY, closeOnMerge: true },
      { issue: SECONDARY, closeOnMerge: false },
    ]));
  });

  it("honors the generic link flags: includeInPr, closeOnMerge and the primary skip", () => {
    const excluded = linearIssue({ id: "issue-3", identifier: "ADE-3", title: "Not in the PR" });
    const genericLane = lane({
      linearIssue: PRIMARY,
      primaryIssue: readLinearIssueRef(PRIMARY),
      issueLinks: [
        // A duplicate of the primary, which must not be emitted twice.
        issueLink(readLinearIssueRef(PRIMARY), { id: "link-1", role: "worked" }),
        issueLink(readLinearIssueRef(excluded), {
          id: "link-2",
          role: "referenced",
          includeInPr: false,
        }),
        issueLink(readLinearIssueRef(SECONDARY), {
          id: "link-3",
          role: "referenced",
          closeOnMerge: false,
        }),
      ],
    });

    const refs = collectLinearPrIssueReferences(genericLane, false);
    expect(refs.map((entry) => entry.issue.identifier)).toEqual(["ADE-123", "OPS-9"]);
    expect(refs[0]).toMatchObject({ closeOnMerge: false, role: "primary" });
    expect(refs[1]).toMatchObject({ closeOnMerge: false, role: "referenced" });
  });

  it("never drops a legacy Linear link the generic projection missed", () => {
    // A half-migrated lane: the generic list carries the primary only.
    const halfMigrated = lane({
      linearIssue: PRIMARY,
      primaryIssue: readLinearIssueRef(PRIMARY),
      issueLinks: [issueLink(readLinearIssueRef(PRIMARY), { role: "primary" })],
      linearIssueLinks: [
        linearLink({ id: "link-2", issue: SECONDARY, role: "worked", closeOnMerge: false }),
      ],
    });
    expect(collectLinearPrIssueReferences(halfMigrated, true).map((entry) => entry.issue.identifier))
      .toEqual(["ADE-123", "OPS-9"]);
  });

  it("carries a non-Linear ref through the generic collector and out of the Linear one", () => {
    const github = issueRefFromGitHubIssue(githubIssue());
    const jira: IssueRef = {
      pluginId: "jira-plugin",
      provider: "jira",
      issueId: "10001",
      key: "ABC-12",
      title: "Third party issue",
      url: "https://example.atlassian.net/browse/ABC-12",
    };
    const mixedLane = lane({
      linearIssue: PRIMARY,
      primaryIssue: readLinearIssueRef(PRIMARY),
      issueLinks: [
        issueLink(readLinearIssueRef(PRIMARY), { id: "link-1", role: "primary" }),
        issueLink(github, { id: "link-2", role: "worked", closeOnMerge: true }),
        issueLink(jira, { id: "link-3", role: "referenced", closeOnMerge: true }),
      ],
    });

    expect(collectLanePrIssueRefs(mixedLane, true).map((entry) => entry.issue.provider))
      .toEqual([ISSUE_PROVIDER_LINEAR, ISSUE_PROVIDER_GITHUB, "jira"]);
    // Only Linear has a renderer today, so the Linear collector emits Linear.
    expect(collectLinearPrIssueReferences(mixedLane, true).map((entry) => entry.issue.identifier))
      .toEqual(["ADE-123"]);
    const body = applyLinearPrLinkage("Summary\n", mixedLane, true);
    expect(body).toContain("Fixes ADE-123");
    expect(body).not.toContain("ABC-12");
    expect(body).not.toContain("ade/app#42");
  });

  it("keeps two trackers that mint the same issue id apart", () => {
    const github = issueRefFromGitHubIssue(githubIssue({ id: "42" }));
    const jira: IssueRef = {
      pluginId: "jira-plugin",
      provider: "jira",
      issueId: "42",
      key: "ABC-42",
      title: "Same id, other tracker",
      url: null,
    };
    const collidingLane = lane({
      issueLinks: [
        issueLink(github, { id: "link-1", role: "worked" }),
        issueLink(jira, { id: "link-2", role: "worked" }),
      ],
    });
    expect(collectLanePrIssueRefs(collidingLane, true).map((entry) => entry.issue.key))
      .toEqual(["ade/app#42", "ABC-42"]);
  });

  it("emits nothing for a lane with no issues at all", () => {
    expect(collectLinearPrIssueReferences(lane(), true)).toEqual([]);
    expect(applyLinearPrLinkage("Summary\n", lane(), true)).toBe("Summary\n");
  });
});

const JIRA: IssueRef = {
  pluginId: "jira-plugin",
  provider: "jira",
  issueId: "10001",
  key: "ABC-12",
  title: "Third party issue",
  url: "https://example.atlassian.net/browse/ABC-12",
};

describe("non-Linear providers in the PR body", () => {
  it("gives a Linear and a Jira ref one section and one magic-word line each", () => {
    const mixedLane = lane({
      linearIssue: PRIMARY,
      primaryIssue: readLinearIssueRef(PRIMARY),
      issueLinks: [
        issueLink(readLinearIssueRef(PRIMARY), { id: "link-1", role: "primary", closeOnMerge: true }),
        issueLink(JIRA, { id: "link-2", role: "worked", closeOnMerge: true }),
      ],
    });

    const body = applyLanePrLinkage("Summary\n", mixedLane, true);
    // The Jira pass prepends after the Linear one, so its line lands on top.
    expect(body).toBe(
      "Refs ABC-12\n"
      + "\n"
      + "Fixes ADE-123\n"
      + "\n"
      + "Summary\n"
      + "\n"
      + "<!-- ade:linear-links v=1 -->\n"
      + "### Linked Linear issues\n"
      + "\n"
      + "- [ADE-123: Link Linear issues deeply](https://linear.app/ade/issue/ADE-123) - closes on merge\n"
      + "<!-- /ade:linear-links -->\n"
      + "\n"
      + "<!-- ade:jira-links v=1 -->\n"
      + "### Linked Jira issues\n"
      + "\n"
      + "- [ABC-12: Third party issue](https://example.atlassian.net/browse/ABC-12) - referenced\n"
      + "<!-- /ade:jira-links -->\n",
    );
    // `closeOnMerge` was true on the Jira link, and it still says `Refs` and
    // `referenced`: nothing closes a Jira issue when this PR merges.
    expect(body).not.toContain("Fixes ABC-12");
  });

  it("rewrites both sections in place on a second write", () => {
    const mixedLane = lane({
      linearIssue: PRIMARY,
      primaryIssue: readLinearIssueRef(PRIMARY),
      issueLinks: [
        issueLink(readLinearIssueRef(PRIMARY), { id: "link-1", role: "primary", closeOnMerge: true }),
        issueLink(JIRA, { id: "link-2", role: "worked", closeOnMerge: false }),
      ],
    });
    const once = applyLanePrLinkage("Summary\n", mixedLane, true);
    const twice = applyLanePrLinkage(once, mixedLane, true);
    const thrice = applyLanePrLinkage(twice, mixedLane, true);
    expect(twice.match(/<!-- ade:linear-links/g)).toHaveLength(1);
    expect(twice.match(/<!-- ade:jira-links/g)).toHaveLength(1);
    expect(twice.match(/^Refs ABC-12$/gm)).toHaveLength(1);
    expect(twice.match(/^Fixes ADE-123$/gm)).toHaveLength(1);
    // Both sections and both magic-word lines are replaced in place, never
    // appended again, and the body reaches a fixpoint.
    expect(thrice).toBe(twice);
    // The generic pass leaves the blank line after its own reference alone.
    // The Linear pass eats one there on a rewrite — a pre-existing `\s*$` in
    // `ensureLinearPrReference`, not introduced here and not changed here.
    expect(twice).toContain("Refs ABC-12\n\n");
  });

  it("writes the body for a plugin-only primary that has no legacy linearIssue row", () => {
    // A plugin linking with role "primary" writes only the link table, so the
    // lane has a generic primary and no `lane_linear_issues` row at all.
    const pluginLane = lane({
      primaryIssue: JIRA,
      issueLinks: [issueLink(JIRA, { id: "link-1", role: "primary", closeOnMerge: true })],
    });

    expect(collectLinearPrIssueReferences(pluginLane, true)).toEqual([]);
    expect(collectOtherProviderPrIssueReferences(pluginLane, true))
      .toEqual([{ issue: JIRA, closeOnMerge: true }]);
    expect(lanePrimaryIssueClosesOnMerge(pluginLane)).toBe(true);

    const body = applyLanePrLinkage("Summary\n", pluginLane, true);
    expect(body).toBe(
      "Refs ABC-12\n"
      + "\n"
      + "Summary\n"
      + "\n"
      + "<!-- ade:jira-links v=1 -->\n"
      + "### Linked Jira issues\n"
      + "\n"
      + "- [ABC-12: Third party issue](https://example.atlassian.net/browse/ABC-12) - referenced\n"
      + "<!-- /ade:jira-links -->\n",
    );
  });

  it("leaves a Linear-only lane's body untouched by the generic pass", () => {
    const linearOnly = lane({
      linearIssue: PRIMARY,
      linearIssueLinks: [
        linearLink({ id: "link-1", issue: PRIMARY, role: "primary", closeOnMerge: true }),
        linearLink({ id: "link-2", issue: SECONDARY, role: "worked", closeOnMerge: false }),
      ],
    });
    expect(collectOtherProviderPrIssueReferences(linearOnly, true)).toEqual([]);
    // The byte-identical body pinned above, unchanged by the new pass.
    expect(applyLanePrLinkage("Summary\n", linearOnly, true))
      .toBe(applyLinearPrLinkage("Summary\n", linearOnly, true));
  });

  it("does not route GitHub refs through the generic renderer", () => {
    // `ensureGitHubPrIssueLinkSection` owns the `ade:github-links` markers and
    // merges lane and session links into one section; a second writer aiming at
    // those markers would replace it and drop the other's rows.
    const githubLane = lane({
      issueLinks: [issueLink(issueRefFromGitHubIssue(githubIssue()), { id: "link-1", role: "worked" })],
    });
    expect(collectOtherProviderPrIssueReferences(githubLane, true)).toEqual([]);
    expect(applyLanePrLinkage("Summary\n", githubLane, true)).toBe("Summary\n");
  });
});

describe("lanePrimaryIssueClosesOnMerge", () => {
  it("reads the legacy primary link when the lane predates issueLinks", () => {
    expect(lanePrimaryIssueClosesOnMerge(lane({
      linearIssue: PRIMARY,
      linearIssueLinks: [linearLink({ role: "primary", closeOnMerge: true })],
    }))).toBe(true);
    expect(lanePrimaryIssueClosesOnMerge(lane({
      linearIssue: PRIMARY,
      linearIssueLinks: [linearLink({ role: "primary", closeOnMerge: false })],
    }))).toBe(false);
    // No primary link at all: today's code returned false, and so does this.
    expect(lanePrimaryIssueClosesOnMerge(lane({ linearIssue: PRIMARY }))).toBe(false);
    expect(lanePrimaryIssueClosesOnMerge(lane())).toBe(false);
  });

  it("reads the generic primary link when the lane has one", () => {
    const primaryRef = readLinearIssueRef(PRIMARY);
    expect(lanePrimaryIssueClosesOnMerge(lane({
      primaryIssue: primaryRef,
      issueLinks: [issueLink(primaryRef, { role: "primary", closeOnMerge: true })],
      // The legacy link disagrees; the generic one wins.
      linearIssue: PRIMARY,
      linearIssueLinks: [linearLink({ role: "primary", closeOnMerge: false })],
    }))).toBe(true);
  });

  it("reads a plugin-owned primary issue that has no legacy row", () => {
    const jira: IssueRef = {
      pluginId: "jira-plugin",
      provider: "jira",
      issueId: "10001",
      key: "ABC-12",
      title: "Third party issue",
      url: null,
    };
    expect(lanePrimaryIssueClosesOnMerge(lane({
      primaryIssue: jira,
      issueLinks: [issueLink(jira, { role: "primary", closeOnMerge: true })],
    }))).toBe(true);
  });
});

describe("issue ref plumbing", () => {
  it("stamps core-owned refs derived from legacy rows", () => {
    expect(readLinearIssueRef(PRIMARY).pluginId).toBe(CORE_ISSUE_PLUGIN_ID);
  });
});
