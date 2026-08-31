import { describe, expect, it } from "vitest";
import {
  CORE_ISSUE_PLUGIN_ID,
  ISSUE_REF_KEY,
  canPluginUnlinkIssueRef,
  embedIssueRef,
  isLinkableIssueRef,
  issueRefFromGitHubIssue,
  issueRefFromLinearIssue,
  issueRefIdentity,
  issueRefRowKey,
  issueRefToLinearIssue,
  issueRefToStoredLinearIssue,
  parseIssueRefValue,
  readLinearIssueRef,
  type IssueRef,
} from "./issueRef";
import { parseLaneLinearIssueValue, finalizeLaneLinearIssue } from "./laneLinearIssue";
import type { LaneGitHubIssue, LaneLinearIssue } from "./types";

function linearIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
  return {
    id: "issue-uuid-1",
    identifier: "ADE-123",
    title: "Fix the thing",
    description: "A description",
    url: "https://linear.app/ade/issue/ADE-123",
    projectId: "project-uuid",
    projectSlug: "ade",
    projectName: "ADE",
    teamId: "team-uuid",
    teamKey: "ADE",
    teamName: "ADE Team",
    stateId: "state-uuid",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: ["bug"],
    assigneeId: "user-uuid",
    assigneeName: "Ada",
    creatorId: "creator-uuid",
    creatorName: "Grace",
    dueDate: "2026-09-01",
    estimate: 3,
    branchName: "ade-123-fix-the-thing",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function jiraRef(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    pluginId: "ade-jira",
    provider: "jira",
    issueId: "10042",
    key: "OPS-42",
    title: "Rotate the certificates",
    url: "https://example.atlassian.net/browse/OPS-42",
    state: { id: "3", name: "In Review", category: "started" },
    container: { id: "10000", key: "OPS", name: "Operations" },
    branchName: "ops-42-rotate-the-certificates",
    assignee: { id: "acct-1", name: "Ada" },
    priority: { rank: 1, label: "high" },
    labels: ["security"],
    description: "The certs expire in October.",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    extra: { sprint: "2026-33" },
    ...overrides,
  };
}

describe("issueRef derivation from the legacy shapes", () => {
  it("derives a complete ref from a Linear issue that predates the key", () => {
    const ref = issueRefFromLinearIssue(linearIssue());
    expect(ref).toMatchObject({
      pluginId: CORE_ISSUE_PLUGIN_ID,
      provider: "linear",
      issueId: "issue-uuid-1",
      key: "ADE-123",
      title: "Fix the thing",
      url: "https://linear.app/ade/issue/ADE-123",
      branchName: "ade-123-fix-the-thing",
    });
    expect(ref.state).toEqual({ id: "state-uuid", name: "In Progress", category: "started" });
    expect(ref.container).toEqual({ id: "team-uuid", key: "ADE", name: "ADE Team" });
  });

  it("maps a closed GitHub issue to the right lifecycle category", () => {
    const base: LaneGitHubIssue = {
      id: "gh-1",
      number: 42,
      owner: "ade-app",
      repo: "ade",
      title: "Crash on launch",
      body: null,
      url: "https://github.com/ade-app/ade/issues/42",
      state: "closed",
      stateReason: "not_planned",
      labels: [],
      assignees: [],
      authorLogin: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    expect(issueRefFromGitHubIssue(base).state?.category).toBe("canceled");
    expect(issueRefFromGitHubIssue({ ...base, stateReason: "completed" }).state?.category)
      .toBe("completed");
    expect(issueRefFromGitHubIssue({ ...base, state: "open", stateReason: null }).state?.category)
      .toBe("started");
    expect(issueRefFromGitHubIssue(base).key).toBe("ade-app/ade#42");
  });

  it("reads the embedded ref in preference to deriving one", () => {
    const stored = issueRefToStoredLinearIssue(jiraRef());
    expect(readLinearIssueRef(stored).provider).toBe("jira");
    expect(readLinearIssueRef(linearIssue()).provider).toBe("linear");
  });
});

// The compatibility contract. These are the tests that stand between this
// change and a peer on an older build, so they assert the mechanism rather than
// the happy path.
describe("issueRef compatibility with a peer on an older build", () => {
  it("keeps every field an older parser demands, for a tracker that has none of them", () => {
    // `parseLaneLinearIssueValue` is what an older build runs on `issue_json`.
    // It REQUIRES ten non-empty fields and returns null without them. A null
    // there is not a cosmetic loss: the row vanishes from that peer's lane.
    const stored = issueRefToStoredLinearIssue(jiraRef());
    const asOldPeerSeesIt = parseLaneLinearIssueValue(JSON.parse(JSON.stringify(stored)));
    expect(asOldPeerSeesIt).not.toBeNull();
    expect(asOldPeerSeesIt).toMatchObject({
      id: "10042",
      identifier: "OPS-42",
      title: "Rotate the certificates",
      url: "https://example.atlassian.net/browse/OPS-42",
      stateName: "In Review",
      stateType: "started",
      teamKey: "OPS",
    });
    // Synthesised, not empty: the ten required fields are all non-empty
    // strings, which is the condition the older parser actually enforces.
    for (const field of [
      "id", "identifier", "title", "teamId", "teamKey",
      "stateId", "stateName", "stateType", "createdAt", "updatedAt",
    ] as const) {
      expect(String(asOldPeerSeesIt![field]).trim().length).toBeGreaterThan(0);
    }
  });

  it("survives a JSON round trip through the column, ref intact", () => {
    const stored = issueRefToStoredLinearIssue(jiraRef());
    const reread = parseLaneLinearIssueValue(JSON.parse(JSON.stringify(stored)));
    expect(readLinearIssueRef(reread!)).toMatchObject({
      pluginId: "ade-jira",
      provider: "jira",
      issueId: "10042",
      key: "OPS-42",
    });
    expect(readLinearIssueRef(reread!).extra).toMatchObject({ sprint: "2026-33" });
  });

  it("keeps a legacy Linear row working with no ref present at all", () => {
    const legacy = parseLaneLinearIssueValue(JSON.parse(JSON.stringify(linearIssue())));
    expect(legacy).not.toBeNull();
    expect((legacy as Record<string, unknown>)[ISSUE_REF_KEY]).toBeUndefined();
    // The reader still gets a ref, derived rather than stored. This is why no
    // migration and no backfill are needed.
    expect(readLinearIssueRef(legacy!)).toMatchObject({ provider: "linear", key: "ADE-123" });
  });

  it("an old build's re-link drops the ref stamp and heals on the next new-build link", () => {
    // An older build parses with a parser that has no `__issueRef` case, so it
    // rebuilds the object without the key. Re-writing that object loses the
    // tracker identity and the row falls back to its legacy projection. Only a
    // Linear link is reachable this way, because an older build has no plugin
    // that can create anything else, and it heals on the next new-build link.
    const stored = issueRefToStoredLinearIssue(jiraRef());
    const rebuiltByAnOldBuild = { ...stored } as Record<string, unknown>;
    delete rebuiltByAnOldBuild[ISSUE_REF_KEY];
    expect(readLinearIssueRef(rebuiltByAnOldBuild as LaneLinearIssue).provider).toBe("linear");
    // Heals: the next write from a build that knows the key restores the stamp,
    // because the ref is rebuilt from the plugin's own input, not from the row.
    const relinkedByANewBuild = issueRefToStoredLinearIssue(jiraRef());
    expect(readLinearIssueRef(relinkedByANewBuild)).toMatchObject({
      provider: "jira",
      pluginId: "ade-jira",
    });
  });

  it("preserves the ref through finalize, which every attach path runs", () => {
    // `finalizeLaneLinearIssue` spreads its input, so it must not drop the key.
    // If it ever stops spreading, the ref dies on every re-attach.
    const stored = issueRefToStoredLinearIssue(jiraRef());
    const finalized = finalizeLaneLinearIssue(stored, "ops-42-rotate-the-certificates");
    expect(readLinearIssueRef(finalized).provider).toBe("jira");
    expect(finalized.branchName).toBe("ops-42-rotate-the-certificates");
  });

  it("takes the live branch name from the legacy field, which ADE rewrites", () => {
    const stored = issueRefToStoredLinearIssue(jiraRef());
    const renamed = { ...stored, branchName: "ops-42-renamed" };
    expect(readLinearIssueRef(renamed).branchName).toBe("ops-42-renamed");
  });
});

describe("issueRef row keys and identity", () => {
  it("leaves a Linear row key bare so no existing row or older peer changes", () => {
    expect(issueRefRowKey(issueRefFromLinearIssue(linearIssue()))).toBe("issue-uuid-1");
  });

  it("namespaces every other tracker so two trackers cannot collide", () => {
    expect(issueRefRowKey(jiraRef({ issueId: "7" }))).toBe("jira:7");
    expect(issueRefRowKey(jiraRef({ provider: "github", issueId: "7" }))).toBe("github:7");
  });

  it("keeps two trackers that share an issue id apart", () => {
    const a = jiraRef({ provider: "jira", issueId: "7" });
    const b = jiraRef({ provider: "asana", issueId: "7" });
    expect(issueRefIdentity(a)).not.toBe(issueRefIdentity(b));
  });
});

describe("issueRef ownership", () => {
  it("lets a plugin remove only its own link", () => {
    const ref = jiraRef({ pluginId: "ade-jira" });
    expect(canPluginUnlinkIssueRef(ref, "ade-jira")).toBe(true);
    expect(canPluginUnlinkIssueRef(ref, "ade-linear")).toBe(false);
  });

  it("refuses every plugin for a link ADE itself made", () => {
    const ref = issueRefFromLinearIssue(linearIssue());
    expect(ref.pluginId).toBe(CORE_ISSUE_PLUGIN_ID);
    expect(canPluginUnlinkIssueRef(ref, "ade-linear")).toBe(false);
  });

  it("defaults an unowned parsed ref to core rather than to the caller", () => {
    const parsed = parseIssueRefValue({
      provider: "jira", issueId: "1", key: "OPS-1", title: "t",
    });
    expect(parsed?.pluginId).toBe(CORE_ISSUE_PLUGIN_ID);
  });
});

describe("issueRef validation", () => {
  it("rejects a ref that no reader could display or reference", () => {
    expect(parseIssueRefValue(null)).toBeNull();
    expect(parseIssueRefValue({ provider: "jira", issueId: "1", key: "OPS-1" })).toBeNull();
    expect(parseIssueRefValue({ provider: "", issueId: "1", key: "K", title: "t" })).toBeNull();
    expect(isLinkableIssueRef(jiraRef({ title: "  " }))).toBe(false);
    expect(isLinkableIssueRef(jiraRef())).toBe(true);
  });

  it("normalizes the provider so a mixed-case tracker name still matches", () => {
    expect(parseIssueRefValue({
      provider: "JIRA", issueId: "1", key: "OPS-1", title: "t",
    })?.provider).toBe("jira");
  });

  it("drops an unparseable ref instead of repairing it", () => {
    const poisoned = embedIssueRef(linearIssue(), { provider: "" } as unknown as IssueRef);
    const reread = parseLaneLinearIssueValue(JSON.parse(JSON.stringify(poisoned)));
    expect((reread as Record<string, unknown>)[ISSUE_REF_KEY]).toBeUndefined();
    // and the reader falls back to the legacy fields rather than failing.
    expect(readLinearIssueRef(reread!).provider).toBe("linear");
  });

  it("round-trips a Linear ref through the legacy projection without loss", () => {
    const ref = issueRefFromLinearIssue(linearIssue());
    const projected = issueRefToLinearIssue(ref);
    expect(projected).toMatchObject({
      id: "issue-uuid-1",
      identifier: "ADE-123",
      teamId: "team-uuid",
      teamKey: "ADE",
      stateId: "state-uuid",
      stateName: "In Progress",
      stateType: "started",
      priority: 2,
      priorityLabel: "high",
      projectSlug: "ade",
      creatorName: "Grace",
      dueDate: "2026-09-01",
      estimate: 3,
    });
  });
});
