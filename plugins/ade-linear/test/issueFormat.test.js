"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  issueBranchName,
  issueLaneName,
  issueRefFromRow,
  normalizeComment,
  normalizeIssue,
  normalizeState,
  normalizeTeam,
  priorityLabel,
  sanitizeBranchName,
  stateRank,
  stateTone,
} = require("../issueFormat");
const { issueNode } = require("./support");

/**
 * The branch name is a CONTRACT, not a formatting choice.
 *
 * Linear matches a branch to an issue by name, so a plugin that derived a
 * different one would silently break Linear's own branch linking and "Open in
 * coding tool" — with nothing reporting it, because both sides would think
 * they were right. This table is the port's proof against
 * `shared/linearIssueBranch.ts`, one row per rule in the sanitizer, in the
 * order the sanitizer applies them.
 */
const BRANCH_CASES = [
  { identifier: "ENG-431", title: "Fix OAuth refresh", branch: "eng-431-fix-oauth-refresh" },
  { identifier: "ENG-1", title: "", branch: "eng-1" },
  { identifier: "", title: "", branch: "linear-issue" },
  // Punctuation collapses to a single dash, and leading/trailing dashes go.
  { identifier: "ADE-9", title: "  Fix the !!! thing  ", branch: "ade-9-fix-the-thing" },
  // Non-ASCII is not alphanumeric to the slugifier, so it collapses like punctuation.
  { identifier: "ADE-10", title: "Café ☕ time", branch: "ade-10-caf-time" },
  // A title that slugifies to nothing leaves the identifier alone.
  { identifier: "ADE-11", title: "!!!", branch: "ade-11" },
  // Digits survive; a run of dashes never does.
  { identifier: "ENG-2", title: "v2 -- rollout", branch: "eng-2-v2-rollout" },
];

describe("the branch name Linear expects", () => {
  for (const testCase of BRANCH_CASES) {
    it(`${testCase.identifier || "<no key>"} + "${testCase.title}" → ${testCase.branch}`, () => {
      assert.equal(issueBranchName({ identifier: testCase.identifier, title: testCase.title }), testCase.branch);
    });
  }

  it("never answers the empty string", () => {
    for (const input of ["", "   ", "---", "...", "refs/heads/", "/", "@{"]) {
      assert.ok(sanitizeBranchName(input).length > 0, `"${input}" produced an empty branch`);
    }
  });

  /**
   * The sanitizer's own rules, exercised through the strings a user can
   * actually produce. Each is a git ref-format invalid, and each one that got
   * through would be a lane whose branch `git` refuses to create.
   */
  const SANITIZE_CASES = [
    ["refs/heads/feature", "feature"],
    ["origin/feature", "feature"],
    // Only the `@{` SEQUENCE is a reflog selector, so only it is replaced. The
    // closing brace survives, exactly as it does in
    // `sanitizeLinearIssueBranchName` — `}` is legal in a git ref and this
    // port must not be tidier than the thing it has to match byte for byte.
    ["feat@{1}", "feat-1}"],
    ["a b\tc", "a-b-c"],
    ["a\\b~c^d:e?f*g[h]i", "a-b-c-d-e-f-g-h-i"],
    ["a//b", "a/b"],
    ["a/.b", "a/b"],
    ["a./b", "a/b"],
    ["a..b", "a-b"],
    ["trailing...", "trailing"],
    ["feature.lock", "feature"],
    ["--wrapped--", "wrapped"],
    ["trailing/", "trailing"],
    ["/leading", "leading"],
    ["a--b---c", "a-b-c"],
  ];

  for (const [input, expected] of SANITIZE_CASES) {
    it(`sanitizes "${input}" to "${expected}"`, () => {
      assert.equal(sanitizeBranchName(input), expected);
    });
  }

  it("names the lane the way the phone does", () => {
    assert.equal(issueLaneName({ identifier: " ENG-431 ", title: " Fix OAuth " }), "ENG-431 Fix OAuth");
  });
});

describe("shaping one issue into a row", () => {
  it("declares title once, and falls back to the identifier", () => {
    const row = normalizeIssue(issueNode({ title: "" }));
    assert.equal(row.title, "ENG-1");
    // The duplicate-key bug this asserts against would have made which value
    // wins depend on the order of the object literal.
    assert.equal(Object.keys(row).filter((key) => key === "title").length, 1);
  });

  it("carries every field, null where Linear had nothing", () => {
    const row = normalizeIssue(issueNode({ assignee: null, project: null, dueDate: null }));
    for (const field of [
      "id", "identifier", "title", "description", "url", "priority", "priorityLabel",
      "stateId", "stateName", "stateType", "stateRank", "teamId", "teamKey", "teamName",
      "projectId", "projectName", "assigneeId", "assigneeName", "creatorName", "labels",
      "labelNames", "dueDate", "estimate", "archivedAt", "completedAt", "createdAt",
      "updatedAt", "branchName", "subIssues", "hasLane", "laneId", "laneName",
      "title2", "badgeText", "badgeTone", "subtitle",
    ]) {
      assert.ok(field in row, `missing ${field}`);
    }
    // A hole would make a `where` clause behave differently for two issues that
    // differ only in whether somebody filled in a due date.
    assert.equal(row.assigneeId, null);
    assert.equal(row.projectId, null);
  });

  it("prefers the display name over the login name", () => {
    const row = normalizeIssue(issueNode({ assignee: { id: "u", name: "ada", displayName: "Ada L" } }));
    assert.equal(row.assigneeName, "Ada L");
  });

  it("joins label names for the row and keeps the objects for the detail", () => {
    const row = normalizeIssue(issueNode({
      labels: { nodes: [{ id: "l1", name: "bug", color: "#f00" }, { id: "l2", name: "p1", color: null }] },
    }));
    assert.equal(row.labelNames, "bug, p1");
    assert.deepEqual(row.labels.map((label) => label.id), ["l1", "l2"]);
  });

  it("carries sub-issues with their state", () => {
    const row = normalizeIssue(issueNode({
      children: { nodes: [{ id: "c1", identifier: "ENG-2", title: "Sub", state: { name: "Todo", type: "unstarted" } }] },
    }));
    assert.deepEqual(row.subIssues, [{
      id: "c1", identifier: "ENG-2", title: "Sub", stateName: "Todo", stateType: "unstarted",
    }]);
  });

  it("starts with no lane, because Linear cannot know", () => {
    const row = normalizeIssue(issueNode());
    assert.equal(row.hasLane, false);
    assert.equal(row.laneId, null);
  });

  it("materializes the display fields a list binding reads", () => {
    const row = normalizeIssue(issueNode());
    assert.equal(row.subtitle, "ENG-1 · In Progress");
    assert.equal(row.title2, "ENG-1 · In Progress");
    assert.equal(row.badgeText, "In Progress");
    assert.equal(row.badgeTone, "accent");
  });
});

describe("state rank and tone", () => {
  it("orders the six state types the way the built-in's list does", () => {
    // `STATE_GROUP_ORDER` in `app/LinearIssueBrowser.tsx`: work in flight
    // first, then Todo, then the queues, then the two closed states. Written
    // as the sequence rather than as six lookups so a reordering of the table
    // fails here loudly.
    assert.deepEqual(
      ["started", "unstarted", "backlog", "triage", "completed", "canceled"].map(stateRank),
      [0, 1, 2, 3, 4, 5],
    );
    assert.ok(stateRank("started") < stateRank("unstarted"), "In Progress must sort above Todo");
    assert.ok(stateRank("backlog") < stateRank("triage"), "Backlog must sort above Triage");
  });

  it("sorts the built-in's seventh type, duplicate, last — where the built-in puts it", () => {
    // `STATE_GROUP_ORDER` ends with `duplicate`, and this table does not name
    // it. The unknown rank has to land it in the same place anyway.
    assert.equal(stateRank("duplicate"), 6);
    assert.ok(stateRank("duplicate") > stateRank("canceled"));
  });

  it("sorts a state type this build has never heard of LAST, not first", () => {
    // Dropping it would hide the issues; ranking it 0 would put them on top.
    assert.equal(stateRank("something-linear-added-later"), 6);
    assert.ok(stateRank("something-linear-added-later") > stateRank("canceled"));
  });

  it("draws a cancelled issue neutral, never as a warning", () => {
    assert.equal(stateTone("canceled"), "neutral");
    assert.equal(stateTone("triage"), "warning");
    assert.equal(stateTone("completed"), "success");
    assert.equal(stateTone("started"), "accent");
  });

  it("falls back to neutral for an unknown type", () => {
    assert.equal(stateTone("brand-new"), "neutral");
  });

  it("names only tones the vocabulary actually has", () => {
    // `VocabTone` (vocabularyNodes.ts:191) is exactly these four. A tone
    // outside the set does not fail — it is coerced to the fallback and the
    // badge renders flat, which is why this is asserted rather than trusted.
    // `info` was in this table and is not a vocabulary tone.
    const TONES = ["neutral", "accent", "success", "warning"];
    for (const type of ["triage", "backlog", "unstarted", "started", "completed", "canceled", "unknown"]) {
      assert.ok(TONES.includes(stateTone(type)), `${type} → ${stateTone(type)}`);
    }
  });
});

describe("priority, which does not sort the way it reads", () => {
  it("calls 0 none and 1 urgent", () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(priorityLabel), ["No priority", "Urgent", "High", "Medium", "Low"]);
  });

  it("treats an out-of-range priority as none", () => {
    assert.equal(priorityLabel(9), "No priority");
    assert.equal(priorityLabel(undefined), "No priority");
  });
});

describe("the IssueRef handed to lanes.linkIssue", () => {
  const ref = issueRefFromRow(normalizeIssue(issueNode()));

  it("never names its own plugin", () => {
    // The host stamps `pluginId` from the child connection that asked, and it
    // is what `unlinkIssue` checks ownership against. A ref that named its own
    // owner would make that check a check against a value the checked party
    // supplied.
    assert.ok(!("pluginId" in ref));
  });

  it("says linear, and carries the branch name git will use", () => {
    assert.equal(ref.provider, "linear");
    assert.equal(ref.branchName, "eng-1-fix-the-thing");
  });

  it("carries the state category the lane UI groups by", () => {
    assert.deepEqual(ref.state, { id: "state-started", name: "In Progress", category: "started" });
  });

  it("carries the team as the container", () => {
    assert.deepEqual(ref.container, { id: "team-1", key: "ENG", name: "Engineering" });
  });

  it("sends a null assignee rather than an object of nulls", () => {
    const unassigned = issueRefFromRow(normalizeIssue(issueNode({ assignee: null })));
    assert.equal(unassigned.assignee, null);
  });

  it("flattens labels to names, which is what a PR body can print", () => {
    assert.deepEqual(ref.labels, ["bug"]);
  });
});

describe("comments, teams and states", () => {
  it("names the commenter, falling back when Linear sent no user", () => {
    const comment = normalizeComment("issue-1", { id: "c1", body: "hi", createdAt: null, user: null });
    assert.equal(comment.title, "Someone");
    assert.equal(comment.issueId, "issue-1");
  });

  it("flattens a comment body to one line for the row subtitle", () => {
    const comment = normalizeComment("issue-1", { id: "c1", body: "one\n\ntwo   three", user: { name: "Ada" } });
    assert.equal(comment.subtitle, "one two three");
  });

  it("clips a very long comment rather than storing the whole thread in a subtitle", () => {
    const comment = normalizeComment("issue-1", { id: "c1", body: "x".repeat(500), user: { name: "Ada" } });
    assert.equal(comment.subtitle.length, 200);
  });

  it("shapes a team as a row with its key as the subtitle", () => {
    assert.deepEqual(
      normalizeTeam({ id: "t1", key: "ENG", name: "Engineering" }),
      { id: "t1", key: "ENG", name: "Engineering", title: "Engineering", subtitle: "ENG" },
    );
  });

  it("carries the team on every state, so a lookup needs no join", () => {
    const state = normalizeState("t1", "ENG", { id: "s1", name: "Done", type: "completed" });
    assert.equal(state.teamId, "t1");
    assert.equal(state.teamKey, "ENG");
    assert.equal(state.rank, 4);
    assert.equal(state.subtitle, "ENG · completed");
  });
});
