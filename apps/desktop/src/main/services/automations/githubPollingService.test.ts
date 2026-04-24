import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubPollingService } from "./githubPollingService";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

type DispatchCall = Parameters<
  Parameters<typeof createGithubPollingService>[0]["automationService"]["dispatchIngressTrigger"]
>[0];

/**
 * Build a test harness with in-memory cursor storage and a recording dispatch
 * stub. Lets us drive `pollNow()` directly and assert on what got emitted.
 */
function makeHarness(overrides?: {
  detectRepo?: () => Promise<{ owner: string; name: string } | null>;
  issuesByCall?: Array<Array<Parameters<typeof makeIssue>[0]>>;
  pullsByCall?: Array<Array<Parameters<typeof makePull>[0]>>;
  commentsByCall?: Array<Array<Parameters<typeof makeComment>[0]> | Error>;
  reviewsByCall?: Array<Array<Parameters<typeof makeReview>[0]>>;
  extraRepos?: Array<{ owner: string; name: string }>;
  initialCursor?: string;
}) {
  const cursors = new Map<string, string>();
  if (overrides?.initialCursor) {
    cursors.set("github-polling", overrides.initialCursor);
  }
  const dispatchCalls: DispatchCall[] = [];

  let issuesIdx = 0;
  let pullsIdx = 0;
  let commentsIdx = 0;
  let reviewsIdx = 0;
  const issuesByCall = overrides?.issuesByCall ?? [];
  const pullsByCall = overrides?.pullsByCall ?? [];
  const commentsByCall = overrides?.commentsByCall ?? [];
  const reviewsByCall = overrides?.reviewsByCall ?? [];

  const automationService = {
    getIngressCursor: (source: string) => cursors.get(source) ?? null,
    setIngressCursor: ({ source, cursor }: { source: string; cursor: string | null }) => {
      if (cursor == null) cursors.delete(source);
      else cursors.set(source, cursor);
    },
    dispatchIngressTrigger: async (args: DispatchCall) => {
      dispatchCalls.push(args);
      return undefined;
    },
  };

  const githubService = {
    detectRepo: overrides?.detectRepo ?? (async () => ({ owner: "acme", name: "ade" })),
    listRepoIssues: vi.fn(async () => {
      const batch = issuesByCall[issuesIdx] ?? [];
      issuesIdx += 1;
      return batch.map((spec) => makeIssue(spec));
    }),
    listRepoPulls: vi.fn(async () => {
      const batch = pullsByCall[pullsIdx] ?? [];
      pullsIdx += 1;
      return batch.map((spec) => makePull(spec));
    }),
    listIssueComments: vi.fn(async () => {
      const batch = commentsByCall[commentsIdx] ?? [];
      commentsIdx += 1;
      if (batch instanceof Error) throw batch;
      return batch.map((spec) => makeComment(spec));
    }),
    listPullRequestReviews: vi.fn(async () => {
      const batch = reviewsByCall[reviewsIdx] ?? [];
      reviewsIdx += 1;
      return batch.map((spec) => makeReview(spec));
    }),
  } as any;

  const service = createGithubPollingService({
    logger: makeLogger(),
    githubService,
    automationService,
    ...(overrides?.extraRepos ? { extraRepos: overrides.extraRepos } : {}),
    // Force a large interval; all tests drive pollNow() directly.
    pollIntervalMs: 10_000,
  });

  return { service, dispatchCalls, cursors, githubService };
}

type IssueSpec = {
  number: number;
  title?: string;
  body?: string | null;
  state?: "open" | "closed";
  updatedAt: string;
  createdAt?: string;
  labels?: Array<string | { name: string }>;
  user?: { login: string } | null;
  comments?: number;
  pull_request?: unknown;
};

function makeIssue(spec: IssueSpec) {
  return {
    id: 1000 + spec.number,
    number: spec.number,
    title: spec.title ?? `Issue ${spec.number}`,
    body: spec.body ?? null,
    state: spec.state ?? "open",
    updated_at: spec.updatedAt,
    created_at: spec.createdAt ?? spec.updatedAt,
    labels: spec.labels ?? [],
    user: spec.user ?? { login: "alice" },
    comments: spec.comments ?? 0,
    html_url: `https://github.com/acme/ade/issues/${spec.number}`,
    ...(spec.pull_request !== undefined ? { pull_request: spec.pull_request } : {}),
  };
}

type PullSpec = {
  number: number;
  title?: string;
  body?: string | null;
  state?: "open" | "closed";
  updatedAt: string;
  createdAt?: string;
  merged?: boolean;
  mergedAt?: string | null;
  draft?: boolean;
  labels?: Array<string | { name: string }>;
  user?: { login: string } | null;
  baseRef?: string;
  baseSha?: string;
  headRef?: string;
  headSha?: string;
  comments?: number;
};

function makePull(spec: PullSpec) {
  return {
    id: 2000 + spec.number,
    number: spec.number,
    title: spec.title ?? `PR ${spec.number}`,
    body: spec.body ?? null,
    state: spec.state ?? "open",
    draft: spec.draft,
    merged: spec.merged,
    merged_at: spec.mergedAt ?? null,
    created_at: spec.createdAt ?? spec.updatedAt,
    updated_at: spec.updatedAt,
    user: spec.user ?? { login: "alice" },
    labels: spec.labels ?? [],
    base: { ref: spec.baseRef ?? "main", sha: spec.baseSha ?? "base-sha" },
    head: { ref: spec.headRef ?? "feat/demo", sha: spec.headSha ?? "head-sha" },
    comments: spec.comments ?? 0,
    html_url: `https://github.com/acme/ade/pull/${spec.number}`,
  };
}

type CommentSpec = {
  id: number;
  body: string;
  createdAt: string;
  login?: string;
};

function makeComment(spec: CommentSpec) {
  return {
    id: spec.id,
    body: spec.body,
    user: { login: spec.login ?? "bob" },
    created_at: spec.createdAt,
    updated_at: spec.createdAt,
  };
}

type ReviewSpec = {
  id: number;
  body?: string | null;
  state?: string;
  submittedAt: string;
  login?: string;
};

function makeReview(spec: ReviewSpec) {
  return {
    id: spec.id,
    body: spec.body ?? null,
    state: spec.state ?? "COMMENTED",
    user: { login: spec.login ?? "reviewer" },
    submitted_at: spec.submittedAt,
    html_url: `https://github.com/acme/ade/pull/42#pullrequestreview-${spec.id}`,
  };
}

describe("githubPollingService — first poll", () => {
  it("treats pre-existing issues as known without emitting issue_opened retroactively", async () => {
    // First poll has cursor=undefined. Everything returned must be silently
    // snapshotted — otherwise we'd spam rule runs on startup.
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [
        [
          { number: 10, updatedAt: "2026-04-23T10:00:00Z", createdAt: "2026-04-23T10:00:00Z" },
          { number: 11, updatedAt: "2026-04-22T09:00:00Z", createdAt: "2026-04-22T08:00:00Z" },
        ],
      ],
      pullsByCall: [[]],
    });

    await service.pollNow();

    expect(dispatchCalls).toEqual([]);
  });

  it("treats pre-existing PRs as known without emitting pr_opened retroactively", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [[]],
      pullsByCall: [
        [{ number: 1, updatedAt: "2026-04-23T10:00:00Z", createdAt: "2026-04-23T10:00:00Z" }],
      ],
    });

    await service.pollNow();

    expect(dispatchCalls).toEqual([]);
  });

  it("writes a cursor after the first poll so subsequent polls get a `since` filter", async () => {
    const { service, cursors } = makeHarness({
      issuesByCall: [[{ number: 10, updatedAt: "2026-04-23T10:00:00Z" }]],
      pullsByCall: [[]],
    });

    await service.pollNow();

    const cursor = cursors.get("github-polling");
    expect(cursor).toBeTruthy();
    // Single-repo format is just the ISO stamp (multi-repo adds a slug prefix).
    expect(cursor).toContain("2026-04-23");
  });
});

describe("githubPollingService — issue diffing", () => {
  it("emits github.issue_opened for a new issue seen on a subsequent poll", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [
        // First poll — snapshot only.
        [{ number: 10, updatedAt: "2026-04-23T10:00:00Z" }],
        // Second poll — a brand-new issue #11 (created_at === updated_at).
        [
          { number: 10, updatedAt: "2026-04-23T10:00:00Z" },
          { number: 11, updatedAt: "2026-04-23T11:00:00Z", createdAt: "2026-04-23T11:00:00Z", title: "Shiny new" },
        ],
      ],
      pullsByCall: [[], []],
    });

    await service.pollNow();
    await service.pollNow();

    const opened = dispatchCalls.filter((c) => c.triggerType === "github.issue_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.issue?.number).toBe(11);
    expect(opened[0]?.summary).toContain("Shiny new");
    expect(opened[0]?.source).toBe("github-polling");
    expect(opened[0]?.repo).toBe("acme/ade");
  });

  it("emits github.issue_labeled with the added labels on a label diff", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [
        [
          { number: 10, updatedAt: "2026-04-23T10:00:00Z", labels: [{ name: "bug" }] },
        ],
        [
          {
            number: 10,
            updatedAt: "2026-04-23T11:00:00Z",
            labels: [{ name: "bug" }, { name: "triage" }],
          },
        ],
      ],
      pullsByCall: [[], []],
    });

    await service.pollNow();
    await service.pollNow();

    const labeled = dispatchCalls.filter((c) => c.triggerType === "github.issue_labeled");
    expect(labeled).toHaveLength(1);
    expect(labeled[0]?.issue?.labels).toContain("triage");
    expect(labeled[0]?.rawPayload).toEqual({ addedLabels: ["triage"] });
  });

  it("emits github.issue_closed on open → closed transition", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [
        [{ number: 10, updatedAt: "2026-04-23T10:00:00Z", state: "open" }],
        [{ number: 10, updatedAt: "2026-04-23T11:00:00Z", state: "closed", title: "Payment bug" }],
      ],
      pullsByCall: [[], []],
    });

    await service.pollNow();
    await service.pollNow();

    const closed = dispatchCalls.filter((c) => c.triggerType === "github.issue_closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.summary).toContain("Payment bug");
  });

  it("emits github.issue_edited when only updatedAt changes (no state/label diff)", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [
        [{ number: 10, updatedAt: "2026-04-23T10:00:00Z", title: "Old title" }],
        [{ number: 10, updatedAt: "2026-04-23T11:00:00Z", title: "New title" }],
      ],
      pullsByCall: [[], []],
    });

    await service.pollNow();
    await service.pollNow();

    const edited = dispatchCalls.filter((c) => c.triggerType === "github.issue_edited");
    expect(edited).toHaveLength(1);
    expect(edited[0]?.summary).toContain("New title");
  });

  it("does not emit github.issue_edited when updatedAt only changed because comments grew", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [
        [{ number: 10, updatedAt: "2026-04-23T10:00:00Z", comments: 0 }],
        [{ number: 10, updatedAt: "2026-04-23T11:00:00Z", comments: 1 }],
      ],
      pullsByCall: [[], []],
      commentsByCall: [[{ id: 101, body: "new comment", createdAt: "2026-04-23T10:30:00Z" }]],
    });

    await service.pollNow();
    await service.pollNow();

    expect(dispatchCalls.filter((c) => c.triggerType === "github.issue_edited")).toHaveLength(0);
    expect(dispatchCalls.filter((c) => c.triggerType === "github.issue_commented")).toHaveLength(1);
  });

  it("does not emit issue_edited when a label change already triggered issue_labeled", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [
        [{ number: 10, updatedAt: "2026-04-23T10:00:00Z", labels: [] }],
        [{ number: 10, updatedAt: "2026-04-23T11:00:00Z", labels: [{ name: "bug" }] }],
      ],
      pullsByCall: [[], []],
    });

    await service.pollNow();
    await service.pollNow();

    expect(dispatchCalls.filter((c) => c.triggerType === "github.issue_labeled")).toHaveLength(1);
    expect(dispatchCalls.filter((c) => c.triggerType === "github.issue_edited")).toHaveLength(0);
  });

  it("filters out PR rows returned by the /issues endpoint", async () => {
    const { service, dispatchCalls, githubService } = makeHarness({
      issuesByCall: [
        [],
        [
          // A PR masquerading as an issue row (GitHub mixes them).
          {
            number: 55,
            updatedAt: "2026-04-23T11:00:00Z",
            createdAt: "2026-04-23T11:00:00Z",
            pull_request: { url: "https://api.github.com/repos/acme/ade/pulls/55" },
          },
        ],
      ],
      pullsByCall: [[], []],
    });

    await service.pollNow();
    await service.pollNow();

    // Not routed to issue_opened — the `pull_request` marker should have
    // filtered it out before diffing.
    expect(dispatchCalls.filter((c) => c.triggerType === "github.issue_opened")).toHaveLength(0);
    // Sanity: the issues endpoint was still queried twice.
    expect(githubService.listRepoIssues).toHaveBeenCalledTimes(2);
  });
});

describe("githubPollingService — PR diffing", () => {
  it("emits github.pr_merged (not pr_closed) on open → merged", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [[], []],
      pullsByCall: [
        [{ number: 42, updatedAt: "2026-04-23T10:00:00Z", state: "open" }],
        [
          {
            number: 42,
            updatedAt: "2026-04-23T11:00:00Z",
            state: "closed",
            merged: true,
            mergedAt: "2026-04-23T11:00:00Z",
            title: "Ship feature",
          },
        ],
      ],
    });

    await service.pollNow();
    await service.pollNow();

    expect(dispatchCalls.filter((c) => c.triggerType === "github.pr_merged")).toHaveLength(1);
    expect(dispatchCalls.filter((c) => c.triggerType === "github.pr_closed")).toHaveLength(0);
    const merged = dispatchCalls.find((c) => c.triggerType === "github.pr_merged");
    expect(merged?.summary).toContain("Ship feature");
    expect(merged?.targetBranch).toBe("main");
  });

  it("emits github.pr_closed (not merged) on open → closed without merge", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [[], []],
      pullsByCall: [
        [{ number: 42, updatedAt: "2026-04-23T10:00:00Z", state: "open" }],
        [
          {
            number: 42,
            updatedAt: "2026-04-23T11:00:00Z",
            state: "closed",
            merged: false,
            mergedAt: null,
          },
        ],
      ],
    });

    await service.pollNow();
    await service.pollNow();

    expect(dispatchCalls.filter((c) => c.triggerType === "github.pr_closed")).toHaveLength(1);
    expect(dispatchCalls.filter((c) => c.triggerType === "github.pr_merged")).toHaveLength(0);
  });

  it("emits github.pr_updated when PR content changes on an open PR", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [[], []],
      pullsByCall: [
        [{ number: 42, updatedAt: "2026-04-23T10:00:00Z", state: "open", title: "Old" }],
        [{ number: 42, updatedAt: "2026-04-23T11:00:00Z", state: "open", title: "New" }],
      ],
    });

    await service.pollNow();
    await service.pollNow();

    expect(dispatchCalls.filter((c) => c.triggerType === "github.pr_updated")).toHaveLength(1);
  });

  it("maps draft=true to draftState \"draft\" in the dispatch payload", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [[], []],
      pullsByCall: [
        [{ number: 42, updatedAt: "2026-04-23T10:00:00Z", state: "open", draft: true }],
        [{ number: 42, updatedAt: "2026-04-23T11:00:00Z", state: "open", draft: true, title: "Changed" }],
      ],
    });

    await service.pollNow();
    await service.pollNow();

    const updated = dispatchCalls.find((c) => c.triggerType === "github.pr_updated");
    expect(updated?.draftState).toBe("draft");
  });

  it("emits github.pr_commented when a polled PR comment count increases", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [[], []],
      pullsByCall: [
        [{ number: 42, updatedAt: "2026-04-23T10:00:00Z", comments: 1 }],
        [{ number: 42, updatedAt: "2026-04-23T11:00:00Z", comments: 2 }],
      ],
      commentsByCall: [
        [{ id: 100, body: "existing", createdAt: "2026-04-23T10:00:00Z" }],
        [
          { id: 100, body: "existing", createdAt: "2026-04-23T10:00:00Z" },
          { id: 101, body: "new comment", createdAt: "2026-04-23T11:00:00Z", login: "reviewer" },
        ],
      ],
    });

    await service.pollNow();
    await service.pollNow();

    const commented = dispatchCalls.filter((c) => c.triggerType === "github.pr_commented");
    expect(commented).toHaveLength(1);
    expect(commented[0]?.pr?.number).toBe(42);
    expect(commented[0]?.rawPayload).toMatchObject({ commentId: 101, body: "new comment" });
    expect(dispatchCalls.filter((c) => c.triggerType === "github.pr_updated")).toHaveLength(0);
  });

  it("emits github.pr_review_submitted for new reviews seen after the initial snapshot", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [[], []],
      pullsByCall: [
        [{ number: 42, updatedAt: "2026-04-23T10:00:00Z" }],
        [{ number: 42, updatedAt: "2026-04-23T11:00:00Z" }],
      ],
      reviewsByCall: [
        [{ id: 200, submittedAt: "2026-04-23T10:00:00Z", state: "COMMENTED" }],
        [
          { id: 200, submittedAt: "2026-04-23T10:00:00Z", state: "COMMENTED" },
          { id: 201, submittedAt: "2026-04-23T11:00:00Z", state: "APPROVED", body: "ship it" },
        ],
      ],
    });

    await service.pollNow();
    await service.pollNow();

    const reviewed = dispatchCalls.filter((c) => c.triggerType === "github.pr_review_submitted");
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]?.pr?.number).toBe(42);
    expect(reviewed[0]?.rawPayload).toMatchObject({ reviewId: 201, state: "APPROVED" });
    expect(dispatchCalls.filter((c) => c.triggerType === "github.pr_updated")).toHaveLength(0);
  });
});

describe("githubPollingService — cursor format", () => {
  it("promotes single-repo cursor to multi-repo when a second repo joins", async () => {
    const { service, cursors } = makeHarness({
      detectRepo: async () => ({ owner: "acme", name: "ade" }),
      extraRepos: [{ owner: "acme", name: "other" }],
      issuesByCall: [
        [{ number: 10, updatedAt: "2026-04-23T10:00:00Z" }],
        [{ number: 20, updatedAt: "2026-04-23T09:00:00Z" }],
      ],
      pullsByCall: [[], []],
    });

    await service.pollNow();

    const stored = cursors.get("github-polling") ?? "";
    // Two repos polled → multi-repo encoding `slug=ts|slug=ts`.
    expect(stored).toContain("acme/ade=");
    expect(stored).toContain("acme/other=");
    expect(stored).toContain("|");
  });

  it("reads back its own single-repo cursor so successive polls see `since` correctly", async () => {
    // Regression: writeCursor stores `<slug>=<iso>` when only one repo exists.
    // readCursor must strip the slug off, otherwise `since` gets passed to the
    // API/filter as a non-timestamp string and downstream diffs silently break.
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [
        [{ number: 10, updatedAt: "2026-04-23T10:00:00Z" }],
        [
          {
            number: 10,
            updatedAt: "2026-04-23T11:00:00Z",
            state: "closed",
            title: "Shipped",
          },
        ],
      ],
      pullsByCall: [[], []],
    });

    await service.pollNow();
    await service.pollNow();

    // Second-poll diff fired because readCursor returned a usable timestamp.
    expect(dispatchCalls.filter((c) => c.triggerType === "github.issue_closed")).toHaveLength(1);
  });

  it("preserves cursors for other repos when only one repo advances", async () => {
    const { service, cursors } = makeHarness({
      detectRepo: async () => ({ owner: "acme", name: "ade" }),
      extraRepos: [{ owner: "acme", name: "other" }],
      issuesByCall: [
        [{ number: 10, updatedAt: "2026-04-23T10:00:00Z" }],
        [{ number: 20, updatedAt: "2026-04-23T09:00:00Z" }],
        [{ number: 10, updatedAt: "2026-04-23T12:00:00Z", title: "Advanced", createdAt: "2026-04-22T00:00:00Z" }],
        [{ number: 20, updatedAt: "2026-04-23T09:00:00Z" }],
      ],
      pullsByCall: [[], [], [], []],
    });

    await service.pollNow();
    await service.pollNow();

    const stored = cursors.get("github-polling") ?? "";
    const parts = new Map(stored.split("|").map((p) => p.split("=") as [string, string]));
    // acme/ade advanced to 12:00; acme/other stayed at 09:00.
    expect(parts.get("acme/ade")).toContain("2026-04-23T12");
    expect(parts.get("acme/other")).toContain("2026-04-23T09");
  });

  it("keeps cursor values intact when they contain equals signs", async () => {
    const { service, githubService } = makeHarness({
      initialCursor: "acme/ade=2026-04-23T10:00:00Z=opaque",
      issuesByCall: [[]],
      pullsByCall: [[]],
    });

    await service.pollNow();

    expect(githubService.listRepoIssues.mock.calls[0]?.[2]?.since).toBe("2026-04-23T10:00:00Z=opaque");
  });

  it("uses the repo polling cursor as the initial comment since filter", async () => {
    const { service, githubService } = makeHarness({
      initialCursor: "acme/ade=2026-04-23T10:00:00Z",
      issuesByCall: [
        [{ number: 10, updatedAt: "2026-04-23T10:15:00Z", createdAt: "2026-04-22T09:00:00Z", comments: 0 }],
        [{ number: 10, updatedAt: "2026-04-23T10:30:00Z", createdAt: "2026-04-22T09:00:00Z", comments: 1 }],
      ],
      pullsByCall: [[], []],
      commentsByCall: [[{ id: 101, body: "new comment", createdAt: "2026-04-23T10:20:00Z" }]],
    });

    await service.pollNow();
    await service.pollNow();

    expect(githubService.listIssueComments.mock.calls[0]?.[3]?.since).toBe("2026-04-23T10:15:00Z");
  });

  it("does not skip comments that share the same created_at timestamp", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [
        [{ number: 10, updatedAt: "2026-04-23T10:00:00Z", comments: 1 }],
        [{ number: 10, updatedAt: "2026-04-23T11:00:00Z", comments: 2 }],
      ],
      pullsByCall: [[], []],
      commentsByCall: [
        [{ id: 100, body: "first", createdAt: "2026-04-23T10:00:00Z" }],
        [
          { id: 100, body: "first", createdAt: "2026-04-23T10:00:00Z" },
          { id: 101, body: "same second", createdAt: "2026-04-23T10:00:00Z" },
        ],
      ],
    });

    await service.pollNow();
    await service.pollNow();

    const comments = dispatchCalls.filter((c) => c.triggerType === "github.issue_commented");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.rawPayload).toMatchObject({ commentId: 101, body: "same second" });
  });
});

describe("githubPollingService — lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("dispose stops the interval and ignores further poll calls", async () => {
    const { service, githubService } = makeHarness({
      issuesByCall: [[], []],
      pullsByCall: [[], []],
    });

    await service.pollNow();
    const callsBefore = githubService.listRepoIssues.mock.calls.length;
    service.dispose();

    // pollOnce is gated by the `stopped` flag — should early-return.
    await service.pollNow();
    expect(githubService.listRepoIssues.mock.calls.length).toBe(callsBefore);
  });

  it("skips overlapping invocations (no re-entrancy)", async () => {
    // Arrange a listRepoIssues that resolves after a tick so two pollNow
    // calls overlap. The second one should short-circuit via the `running` flag.
    let resolveFirst: (value: unknown[]) => void = () => undefined;
    const firstInFlight = new Promise<unknown[]>((r) => {
      resolveFirst = r;
    });

    const cursors = new Map<string, string>();
    const automationService = {
      getIngressCursor: (s: string) => cursors.get(s) ?? null,
      setIngressCursor: ({ source, cursor }: { source: string; cursor: string | null }) => {
        if (cursor == null) cursors.delete(source);
        else cursors.set(source, cursor);
      },
      dispatchIngressTrigger: async () => undefined,
    };
    const listRepoIssues = vi.fn()
      .mockImplementationOnce(() => firstInFlight)
      .mockResolvedValue([]);

    const service = createGithubPollingService({
      logger: makeLogger(),
      githubService: {
        detectRepo: async () => ({ owner: "acme", name: "ade" }),
        listRepoIssues,
        listRepoPulls: vi.fn(async () => []),
        listIssueComments: vi.fn(async () => []),
        listPullRequestReviews: vi.fn(async () => []),
      } as any,
      automationService,
      pollIntervalMs: 30_000,
    });

    const firstPromise = service.pollNow();
    // Second call fires while first is still in-flight.
    const secondPromise = service.pollNow();

    resolveFirst([]);
    await firstPromise;
    await secondPromise;

    // Only the first call actually ran listRepoIssues.
    expect(listRepoIssues).toHaveBeenCalledTimes(1);
  });
});

describe("githubPollingService — error resilience", () => {
  it("does not advance issue comment snapshots until comment polling succeeds", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [
        [{ number: 10, updatedAt: "2026-04-23T10:00:00Z", comments: 0 }],
        [{ number: 10, updatedAt: "2026-04-23T11:00:00Z", comments: 1 }],
        [{ number: 10, updatedAt: "2026-04-23T11:00:00Z", comments: 1 }],
      ],
      pullsByCall: [[], []],
      commentsByCall: [
        new Error("comments API down"),
        [{ id: 101, body: "new comment", createdAt: "2026-04-23T10:30:00Z" }],
      ],
    });

    await service.pollNow();
    await service.pollNow();
    await service.pollNow();

    const comments = dispatchCalls.filter((c) => c.triggerType === "github.issue_commented");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.rawPayload).toMatchObject({ commentId: 101, body: "new comment" });
  });

  it("does not snapshot a first-seen PR until comment cursor initialization succeeds", async () => {
    const { service, dispatchCalls } = makeHarness({
      issuesByCall: [[], [], []],
      pullsByCall: [
        [{ number: 42, updatedAt: "2026-04-23T10:00:00Z", comments: 1 }],
        [{ number: 42, updatedAt: "2026-04-23T10:00:00Z", comments: 1 }],
        [{ number: 42, updatedAt: "2026-04-23T11:00:00Z", comments: 2 }],
      ],
      commentsByCall: [
        new Error("comments API down"),
        [{ id: 100, body: "existing", createdAt: "2026-04-23T10:00:00Z" }],
        [
          { id: 100, body: "existing", createdAt: "2026-04-23T10:00:00Z" },
          { id: 101, body: "new comment", createdAt: "2026-04-23T11:00:00Z" },
        ],
      ],
    });

    await service.pollNow();
    await service.pollNow();
    await service.pollNow();

    const comments = dispatchCalls.filter((c) => c.triggerType === "github.pr_commented");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.rawPayload).toMatchObject({ commentId: 101, body: "new comment" });
  });

  it("continues to other repos when one repo's poll throws", async () => {
    const dispatchCalls: DispatchCall[] = [];
    const cursors = new Map<string, string>();
    const listRepoIssues = vi.fn()
      // First repo (detected): throws.
      .mockRejectedValueOnce(new Error("network down"))
      // Second repo (extra): returns one issue.
      .mockResolvedValueOnce([
        makeIssue({ number: 99, updatedAt: "2026-04-23T10:00:00Z" }),
      ]);

    const service = createGithubPollingService({
      logger: makeLogger(),
      githubService: {
        detectRepo: async () => ({ owner: "acme", name: "ade" }),
        listRepoIssues,
        listRepoPulls: vi.fn(async () => []),
        listIssueComments: vi.fn(async () => []),
        listPullRequestReviews: vi.fn(async () => []),
      } as any,
      automationService: {
        getIngressCursor: (s: string) => cursors.get(s) ?? null,
        setIngressCursor: ({ source, cursor }: { source: string; cursor: string | null }) => {
          if (cursor == null) cursors.delete(source);
          else cursors.set(source, cursor);
        },
        dispatchIngressTrigger: async (args: DispatchCall) => {
          dispatchCalls.push(args);
          return undefined;
        },
      },
      extraRepos: [{ owner: "acme", name: "other" }],
      pollIntervalMs: 30_000,
    });

    await service.pollNow();

    expect(listRepoIssues).toHaveBeenCalledTimes(2);
    // First repo's cursor was never written (threw before maxUpdatedAt logic).
    const stored = cursors.get("github-polling") ?? "";
    expect(stored).toContain("acme/other=");
    expect(stored).not.toContain("acme/ade=");
  });

  it("swallows dispatchIngressTrigger failures and keeps polling", async () => {
    const cursors = new Map<string, string>();
    const dispatched = vi.fn(async () => {
      throw new Error("dispatch blew up");
    });

    const service = createGithubPollingService({
      logger: makeLogger(),
      githubService: {
        detectRepo: async () => ({ owner: "acme", name: "ade" }),
        listRepoIssues: vi.fn()
          // First poll: one pre-existing issue that snapshots.
          .mockResolvedValueOnce([
            makeIssue({ number: 10, updatedAt: "2026-04-23T10:00:00Z" }),
          ])
          // Second poll: state flips to closed → should attempt a dispatch that throws.
          .mockResolvedValueOnce([
            makeIssue({
              number: 10,
              updatedAt: "2026-04-23T11:00:00Z",
              state: "closed",
            }),
          ]),
        listRepoPulls: vi.fn(async () => []),
        listIssueComments: vi.fn(async () => []),
        listPullRequestReviews: vi.fn(async () => []),
      } as any,
      automationService: {
        getIngressCursor: (s: string) => cursors.get(s) ?? null,
        setIngressCursor: ({ source, cursor }: { source: string; cursor: string | null }) => {
          if (cursor == null) cursors.delete(source);
          else cursors.set(source, cursor);
        },
        dispatchIngressTrigger: dispatched,
      },
      pollIntervalMs: 30_000,
    });

    await service.pollNow();
    await expect(service.pollNow()).resolves.toBeUndefined();

    expect(dispatched).toHaveBeenCalled();
    // Cursor still advanced despite dispatch failure.
    expect(cursors.get("github-polling")).toContain("2026-04-23");
  });
});
