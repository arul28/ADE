import assert from "node:assert/strict";
import test from "node:test";

import { parseOutsideDiffFindings, summarizePoll } from "./ship-poll.mjs";

// A CodeRabbit review body as GitHub returns it, cut to the finding it carries.
const CODERABBIT_REVIEW_BODY = [
  "**Actionable comments posted: 1**",
  "",
  "> [!CAUTION]",
  "> Some comments are outside the diff and can’t be posted inline due to GitHub limitations.",
  "> ",
  "> **⚠️ Outside diff range comments (1)**",
  "> ",
  "> <details>",
  "> <summary><em>🟡 Minor</em> · Invalidate the PR summary cache when a PR changes during a pass. · <code>searchService.ts:948</code></summary><blockquote>",
  "> ",
  "> `apps/desktop/src/main/services/search/searchService.ts:948`",
  "> _🎯 Functional Correctness_ | _🟡 Minor_ | _⚡ Quick win_",
  "> ",
  "> **Invalidate the PR summary cache when a PR changes during a pass.**",
  "> ",
  "> If a pass has read the PR list and a later queued PR changes, `processPr` can index that PR from the old list.",
  "> ",
  "> <details>",
  "> <summary>🤖 Prompt for AI Agents</summary>",
  "> ",
  "> ```",
  "> Review comment at @apps/desktop/src/main/services/search/searchService.ts at",
  "> line 948:",
  "> ```",
  "> ",
  "> </details>",
  "> ",
  "> <!-- cr-comment:v1:f1685e92a4e564f3b6f98c88 -->",
  "> ",
  "> </blockquote></details>",
  "",
  "---",
  "",
  "**Included review availability:** This review used your included allowance. Your plan provides up to 2 included reviews per hour; 0 remain after this review.",
].join("\n");

const PUSHED_AT = "2026-10-05T17:30:00Z";

function poll(overrides = {}) {
  return summarizePoll({
    pr: { state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", headRefOid: "abc1234567", baseRefName: "main" },
    checks: [{ name: "test-desktop (1)", state: "SUCCESS", bucket: "pass" }],
    issueComments: [],
    reviews: [],
    threads: [],
    behindBy: 0,
    localAhead: false,
    state: { lastPushAt: PUSHED_AT, addressedCommentIds: [], addressedReviewFindings: [] },
    ...overrides,
  });
}

const thread = (commentId, isResolved = false) => ({
  id: `PRRT_${commentId}`,
  isResolved,
  isOutdated: true,
  comments: { nodes: [{ databaseId: commentId, author: { login: "coderabbitai" }, path: "a.ts" }] },
});

test("reads a finding a bot could only put in its review body", () => {
  const [finding, ...rest] = parseOutsideDiffFindings(CODERABBIT_REVIEW_BODY, 5417808988);
  assert.equal(rest.length, 0);
  assert.equal(finding.key, "cr:f1685e92a4e564f3b6f98c88");
  assert.equal(finding.path, "apps/desktop/src/main/services/search/searchService.ts");
  assert.equal(finding.line, 948);
  assert.equal(finding.title, "Invalidate the PR summary cache when a PR changes during a pass.");
  assert.deepEqual(parseOutsideDiffFindings("**Actionable comments posted: 2**", 1), []);

  // Other nested blocks inside a finding are part of it, not findings of their own.
  const withChain = CODERABBIT_REVIEW_BODY.replace(
    "> <details>\n> <summary>🤖 Prompt",
    "> <details>\n> <summary>🧩 Analysis chain</summary>\n> </details>\n> <details>\n> <summary>🤖 Prompt",
  );
  assert.equal(parseOutsideDiffFindings(withChain, 1).length, 1);
});

test("a review-body finding is fix work until it is recorded as handled, whatever its age", () => {
  // The review predates the last push, as one does when it lands while CI runs.
  const review = {
    id: 5417808988,
    user: { login: "coderabbitai[bot]" },
    state: "COMMENTED",
    submitted_at: "2026-10-05T16:42:07Z",
    body: CODERABBIT_REVIEW_BODY,
  };
  // A later review repeats the same finding; it is one item of work.
  const repeated = { ...review, id: 5418258614, submitted_at: "2026-10-05T17:24:40Z" };
  const open = poll({ reviews: [review, repeated] });
  assert.equal(open.next, "fix");
  assert.equal(open.reviewFindings.length, 1);
  assert.match(open.botNotices[0].notice, /0 remain/);

  // A bot that could not run, then reviewed, has no standing notice.
  const ranLater = poll({
    issueComments: [{ id: 8, user: { login: "cursor[bot]" }, created_at: "2026-10-05T16:00:00Z", body: "Bugbot couldn't run - usage limit reached" }],
    reviews: [{ id: 9, user: { login: "cursor[bot]" }, state: "COMMENTED", submitted_at: "2026-10-05T17:00:00Z", body: "Bugbot reviewed your changes and found no bugs." }],
  });
  assert.deepEqual(ranLater.botNotices, []);

  const handled = poll({
    reviews: [review],
    state: { lastPushAt: PUSHED_AT, addressedReviewFindings: ["cr:f1685e92a4e564f3b6f98c88"] },
  });
  assert.equal(handled.reviewFindings.length, 0);
  assert.equal(handled.next, "merge");
});

test("routes the loop from every surface, never from CI alone", () => {
  const cases = [
    ["an open thread from before the last push is fix work", { threads: [thread(41)] }, "fix"],
    [
      "a thread fixed in code still blocks merge until it is answered and resolved",
      { threads: [thread(41)], state: { lastPushAt: PUSHED_AT, addressedCommentIds: [41] } },
      "resolve-threads",
    ],
    ["a resolved thread is done", { threads: [thread(41, true)] }, "merge"],
    [
      "a review bot still running holds the loop",
      { checks: [{ name: "CodeRabbit", state: "PENDING", bucket: "pending" }] },
      "wait",
    ],
    [
      "a failed CI job is fix work",
      { checks: [{ name: "windows-foundation", state: "FAILURE", bucket: "fail" }] },
      "fix",
    ],
    ["a base that moved needs a rebase first", { behindBy: 1, threads: [thread(41)] }, "rebase"],
    ["held local commits are fix work", { localAhead: true }, "fix"],
    [
      "a person's comment since the last push is fix work",
      { issueComments: [{ id: 7, user: { login: "arul28" }, created_at: "2026-10-05T17:40:00Z", body: "also check X" }] },
      "fix",
    ],
    [
      "a bot that could not run is a notice, not fix work",
      { issueComments: [{ id: 8, user: { login: "cursor[bot]" }, created_at: "2026-10-05T17:40:00Z", body: "<h3>Bugbot couldn't run - usage limit reached</h3>" }] },
      "merge",
    ],
  ];
  for (const [label, overrides, expected] of cases) {
    assert.equal(poll(overrides).next, expected, label);
  }
});
