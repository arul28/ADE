import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IssueInventoryItem,
  PrCheck,
  PrComment,
  PrReviewThread,
} from "../../../shared/types";
import { createIssueInventoryService } from "./issueInventoryService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDb() {
  return {
    get: vi.fn(() => null),
    all: vi.fn(() => []),
    run: vi.fn(),
    getJson: vi.fn(() => null),
    setJson: vi.fn(),
    sync: { getSiteId: vi.fn(), getDbVersion: vi.fn(), exportChangesSince: vi.fn(), applyChanges: vi.fn() },
    flushNow: vi.fn(),
    close: vi.fn(),
  } as any;
}

const PR_ID = "pr-42";

function makeCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "ci / unit",
    status: "completed",
    conclusion: "failure",
    detailsUrl: "https://example.com/check/1",
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeReviewThread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "src/main.ts",
    line: 42,
    originalLine: 42,
    startLine: null,
    originalStartLine: null,
    diffSide: "RIGHT",
    url: "https://example.com/thread/1",
    createdAt: "2026-03-23T12:00:00.000Z",
    updatedAt: "2026-03-23T12:05:00.000Z",
    comments: [
      {
        id: "comment-1",
        author: "reviewer",
        authorAvatarUrl: null,
        body: "**Fix the null check.** This will crash at runtime.",
        url: "https://example.com/comment/1",
        createdAt: "2026-03-23T12:00:00.000Z",
        updatedAt: "2026-03-23T12:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function makeComment(overrides: Partial<PrComment> = {}): PrComment {
  return {
    id: "issue-comment-1",
    author: "coderabbitai[bot]",
    authorAvatarUrl: null,
    body: "**Major** Consider simplifying this branch for better readability.",
    source: "issue",
    url: "https://example.com/issue-comment/1",
    path: null,
    line: null,
    createdAt: "2026-03-23T12:00:00.000Z",
    updatedAt: "2026-03-23T12:00:00.000Z",
    ...overrides,
  };
}

/** Makes a fake InventoryRow as returned by db.all / db.get */
function makeFakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    pr_id: PR_ID,
    source: "human",
    type: "review_thread",
    external_id: "thread:thread-1",
    state: "new",
    round: 0,
    file_path: "src/main.ts",
    line: 42,
    severity: "major",
    headline: "Fix the null check",
    body: "This will crash at runtime.",
    author: "reviewer",
    url: "https://example.com/thread/1",
    dismiss_reason: null,
    agent_session_id: null,
    thread_comment_count: 1,
    thread_latest_comment_id: "comment-1",
    thread_latest_comment_author: "reviewer",
    thread_latest_comment_at: "2026-03-23T12:00:00.000Z",
    thread_latest_comment_source: "unknown",
    created_at: "2026-03-23T12:00:00.000Z",
    updated_at: "2026-03-23T12:00:00.000Z",
    ...overrides,
  };
}

function makeRuntimeRow(overrides: Record<string, unknown> = {}) {
  return {
    pr_id: PR_ID,
    auto_converge_enabled: 1,
    status: "running",
    poller_status: "waiting_for_comments",
    current_round: 2,
    active_session_id: "session-1",
    active_lane_id: "lane-1",
    active_href: "/work?laneId=lane-1&sessionId=session-1",
    pause_reason: null,
    error_message: null,
    last_started_at: "2026-03-23T12:00:00.000Z",
    last_polled_at: "2026-03-23T12:01:00.000Z",
    last_paused_at: null,
    last_stopped_at: null,
    created_at: "2026-03-23T11:59:00.000Z",
    updated_at: "2026-03-23T12:01:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — syncFromPrData
// ---------------------------------------------------------------------------

describe("issueInventoryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("syncFromPrData", () => {
    it("inserts failing checks as inventory items", () => {
      const db = makeMockDb();
      // db.get returns null (no existing row) for upsert checks
      db.get.mockReturnValue(null);
      // db.all returns empty (no existing items) for buildSnapshot
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      const result = service.syncFromPrData(
        PR_ID,
        [makeCheck({ name: "ci / lint", conclusion: "failure" })],
        [],
        [],
      );

      // Should have called db.run to insert the failing check
      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(1);

      // Verify the inserted values contain expected data
      const insertArgs = insertCalls[0][1] as unknown[];
      // [uuid, prId, source, type, externalId, filePath, line, severity, headline, body, author, url, createdAt, updatedAt]
      expect(insertArgs[1]).toBe(PR_ID); // prId
      expect(insertArgs[2]).toBe("unknown"); // source (checks have unknown source)
      expect(insertArgs[3]).toBe("check_failure"); // type
      expect(insertArgs[4]).toBe('check:ci / lint'); // externalId
      expect(insertArgs[9]).toBe("major"); // severity

      // Result snapshot
      expect(result.prId).toBe(PR_ID);
      expect(result.convergence).toBeDefined();
    });

    it("skips passing checks", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [makeCheck({ name: "ci / lint", conclusion: "success" })],
        [],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(0);
    });

    it("inserts unresolved, non-outdated review threads", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({ id: "thread-99", isResolved: false, isOutdated: false })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(1);

      const args = insertCalls[0][1] as unknown[];
      expect(args[4]).toBe("thread:thread-99"); // externalId
      expect(args[3]).toBe("review_thread"); // type
    });

    it("tracks the latest reply in a review thread", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          id: "thread-latest",
          comments: [
            {
              id: "comment-1",
              author: "reviewer",
              authorAvatarUrl: null,
              body: "**Minor** Initial concern.",
              url: null,
              createdAt: "2026-03-23T12:00:00.000Z",
              updatedAt: "2026-03-23T12:00:00.000Z",
            },
            {
              id: "comment-2",
              author: "coderabbitai[bot]",
              authorAvatarUrl: null,
              body: "**Major** This still needs a fix.",
              url: "https://example.com/comment/2",
              createdAt: "2026-03-23T12:02:00.000Z",
              updatedAt: "2026-03-23T12:02:00.000Z",
            },
          ],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(1);
      const args = insertCalls[0][1] as unknown[];
      expect(args[11]).toContain("This still needs a fix.");
      expect(args[12]).toBe("coderabbitai[bot]");
      expect(args[16]).toBe(2);
      expect(args[17]).toBe("comment-2");
      expect(args[20]).toBe("coderabbit");
    });

    it("skips resolved review threads", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({ isResolved: true })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(0);
    });

    it("skips outdated review threads", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({ isOutdated: true })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(0);
    });

    it("marks previously tracked resolved threads as fixed", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(makeFakeRow({
        id: "existing-thread-item",
        external_id: "thread:thread-resolved",
        state: "sent_to_agent",
        round: 2,
        thread_comment_count: 1,
        thread_latest_comment_id: "comment-1",
      }));
      db.all.mockReturnValue([makeFakeRow({
        id: "existing-thread-item",
        external_id: "thread:thread-resolved",
        state: "fixed",
        round: 2,
        thread_comment_count: 1,
        thread_latest_comment_id: "comment-1",
      })]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          id: "thread-resolved",
          isResolved: true,
          comments: [{
            id: "comment-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "Resolved in code.",
            url: null,
            createdAt: "2026-03-23T12:00:00.000Z",
            updatedAt: "2026-03-23T12:00:00.000Z",
          }],
        })],
        [],
      );

      const updateCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("update pr_issue_inventory"),
      );
      expect(updateCalls.length).toBe(1);
      const params = updateCalls[0][1] as unknown[];
      expect(params[8]).toBe("fixed");
    });

    it("reopens a thread as new when a new reply appears", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(makeFakeRow({
        id: "existing-thread-item",
        external_id: "thread:thread-reopened",
        state: "sent_to_agent",
        round: 2,
        thread_comment_count: 1,
        thread_latest_comment_id: "comment-1",
      }));
      db.all.mockReturnValue([makeFakeRow({
        id: "existing-thread-item",
        external_id: "thread:thread-reopened",
        state: "new",
        round: 2,
        thread_comment_count: 2,
        thread_latest_comment_id: "comment-2",
      })]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          id: "thread-reopened",
          comments: [
            {
              id: "comment-1",
              author: "reviewer",
              authorAvatarUrl: null,
              body: "Initial thread comment.",
              url: null,
              createdAt: "2026-03-23T12:00:00.000Z",
              updatedAt: "2026-03-23T12:00:00.000Z",
            },
            {
              id: "comment-2",
              author: "coderabbitai[bot]",
              authorAvatarUrl: null,
              body: "This still needs attention.",
              url: null,
              createdAt: "2026-03-23T12:03:00.000Z",
              updatedAt: "2026-03-23T12:03:00.000Z",
            },
          ],
        })],
        [],
      );

      const updateCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("update pr_issue_inventory"),
      );
      expect(updateCalls.length).toBe(1);
      const params = updateCalls[0][1] as unknown[];
      expect(params[8]).toBe("new");
      expect(params[11]).toBeNull();
      expect(params[12]).toBe(2);
    });

    it("detects coderabbit bot as source from review thread author", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "coderabbitai[bot]",
            authorAvatarUrl: null,
            body: "**Minor** Use const here.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(1);
      const args = insertCalls[0][1] as unknown[];
      expect(args[2]).toBe("coderabbit"); // source
    });

    it("detects codex bot source", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "codex[bot]",
            authorAvatarUrl: null,
            body: "P1 Fix the bug.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[2]).toBe("codex"); // source
    });

    it("detects copilot bot source", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "github-copilot[bot]",
            authorAvatarUrl: null,
            body: "Suggestion: simplify this.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[2]).toBe("copilot"); // source
    });

    it("maps unmatched human authors as human source", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "some-developer",
            authorAvatarUrl: null,
            body: "Fix this logic error.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[2]).toBe("human"); // source
    });

    it("maps unrecognized bot authors as unknown source", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "thread-comment-1",
            author: "greptile-review[bot]",
            authorAvatarUrl: null,
            body: "Potential issue in this block.",
            url: null,
            createdAt: "2026-03-23T12:00:00.000Z",
            updatedAt: "2026-03-23T12:00:00.000Z",
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[2]).toBe("unknown"); // source
    });

    it("extracts severity from bold keywords (Critical/Major/Minor)", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "**Critical** This is a security vulnerability.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBe("critical"); // severity
    });

    it("extracts severity from P1/P2/P3 labels", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });

      // P2 -> major
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          id: "t-p2",
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "P2 refactor the error handling",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBe("major"); // severity from P2
    });

    it("extracts severity from emoji indicators", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "🔴 This is a critical issue.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBe("critical");
    });

    it("extracts severity from bracket patterns like [bug]", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "[warning] Check for off-by-one error.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBe("major"); // [warning] -> major
    });

    it("extracts headline from bold title in body", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "_⚠️ Potential issue_ | _🟡 Minor_\n\n**Derive `assistantLabel` from the effective provider.**\n\nThis can drift.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      // The headline should be the extracted bold title, cleaned of emoji noise
      const headline = args[10] as string;
      expect(headline).toContain("Derive");
      expect(headline).toContain("assistantLabel");
    });

    it("falls back to first line when no bold title", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "Consider using a Map instead of an object here for performance.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      const headline = args[10] as string;
      expect(headline).toContain("Consider using a Map");
    });

    it("syncs issue comments that are not noisy", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [],
        [makeComment({
          id: "ic-1",
          author: "coderabbitai[bot]",
          body: "**Major** Consider simplifying this branch for better readability.",
          source: "issue",
        })],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(1);
      const args = insertCalls[0][1] as unknown[];
      expect(args[3]).toBe("issue_comment"); // type
      expect(args[4]).toBe("comment:ic-1"); // externalId
    });

    it("filters noisy vercel bot comments", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [],
        [makeComment({
          id: "ic-vercel",
          author: "vercel[bot]",
          body: "[vc]: deployment details here",
          source: "issue",
        })],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(0);
    });

    it("filters noisy body patterns like auto-generated summaries", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [],
        [makeComment({
          id: "ic-noisy",
          author: "coderabbitai[bot]",
          body: "This is an auto-generated comment: release notes by coderabbit.ai --> huge summary",
          source: "issue",
        })],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(0);
    });

    it("skips comments with source !== issue", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [],
        [makeComment({
          id: "ic-review",
          source: "review",
          body: "This is a review comment.",
        })],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(0);
    });

    it("updates existing items instead of duplicating on re-sync", () => {
      const db = makeMockDb();
      // Simulate existing row found for the external_id
      db.get.mockReturnValue(makeFakeRow({ id: "existing-item-1", external_id: "check:ci / lint" }));
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [makeCheck({ name: "ci / lint", conclusion: "failure" })],
        [],
        [],
      );

      // Should have called UPDATE not INSERT
      const updateCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("update pr_issue_inventory"),
      );
      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(updateCalls.length).toBe(1);
      expect(insertCalls.length).toBe(0);
    });

    it("returns a valid snapshot with convergence status", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      // After sync, buildSnapshot calls db.all — return some items
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "new", round: 0 }),
        makeFakeRow({ id: "i-2", state: "fixed", round: 1 }),
      ]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.syncFromPrData(PR_ID, [], [], []);

      expect(snapshot.prId).toBe(PR_ID);
      expect(snapshot.items.length).toBe(2);
      expect(snapshot.convergence.totalNew).toBe(1);
      expect(snapshot.convergence.totalFixed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — getInventory / getNewItems
  // ---------------------------------------------------------------------------

  describe("getInventory", () => {
    it("returns snapshot for the given prId", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "new", round: 0 }),
        makeFakeRow({ id: "i-2", state: "sent_to_agent", round: 1 }),
      ]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      expect(snapshot.prId).toBe(PR_ID);
      expect(snapshot.items.length).toBe(2);
      expect(snapshot.convergence).toBeDefined();
      expect(snapshot.convergence.totalNew).toBe(1);
      expect(snapshot.convergence.totalSentToAgent).toBe(1);
    });

    it("returns empty snapshot when no items exist", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      expect(snapshot.items).toEqual([]);
      expect(snapshot.convergence.currentRound).toBe(0);
      expect(snapshot.convergence.totalNew).toBe(0);
      expect(snapshot.convergence.canAutoAdvance).toBe(false);
    });
  });

  describe("getNewItems", () => {
    it("returns only items in 'new' state", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "new" }),
        makeFakeRow({ id: "i-2", state: "new" }),
      ]);

      const service = createIssueInventoryService({ db });
      const items = service.getNewItems(PR_ID);

      expect(items.length).toBe(2);
      expect(items[0].state).toBe("new");
      // Verify the DB query was called with 'new' state filter
      expect(db.all).toHaveBeenCalledWith(
        expect.stringContaining("state = ?"),
        [PR_ID, "new"],
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — state transition methods
  // ---------------------------------------------------------------------------

  describe("markSentToAgent", () => {
    it("updates items to sent_to_agent state with round and session", () => {
      const db = makeMockDb();
      const service = createIssueInventoryService({ db });

      service.markSentToAgent(PR_ID, ["item-1", "item-2"], "session-99", 2);

      expect(db.run).toHaveBeenCalledTimes(2);
      for (const call of db.run.mock.calls) {
        const sql = call[0] as string;
        const params = call[1] as unknown[];
        expect(sql).toContain("state = 'sent_to_agent'");
        expect(params[0]).toBe(2); // round
        expect(params[1]).toBe("session-99"); // sessionId
        expect(params[4]).toBe(PR_ID); // prId
      }
    });

    it("handles empty itemIds array gracefully", () => {
      const db = makeMockDb();
      const service = createIssueInventoryService({ db });

      service.markSentToAgent(PR_ID, [], "session-99", 1);
      expect(db.run).not.toHaveBeenCalled();
    });
  });

  describe("markFixed", () => {
    it("updates items to fixed state", () => {
      const db = makeMockDb();
      const service = createIssueInventoryService({ db });

      service.markFixed(PR_ID, ["item-1"]);

      expect(db.run).toHaveBeenCalledTimes(1);
      const sql = db.run.mock.calls[0][0] as string;
      expect(sql).toContain("state = 'fixed'");
      const params = db.run.mock.calls[0][1] as unknown[];
      expect(params[1]).toBe("item-1"); // id
      expect(params[2]).toBe(PR_ID); // prId
    });
  });

  describe("markDismissed", () => {
    it("updates items to dismissed state with reason", () => {
      const db = makeMockDb();
      const service = createIssueInventoryService({ db });

      service.markDismissed(PR_ID, ["item-1"], "Not applicable to this PR");

      expect(db.run).toHaveBeenCalledTimes(1);
      const sql = db.run.mock.calls[0][0] as string;
      expect(sql).toContain("state = 'dismissed'");
      const params = db.run.mock.calls[0][1] as unknown[];
      expect(params[0]).toBe("Not applicable to this PR"); // reason
      expect(params[2]).toBe("item-1"); // id
      expect(params[3]).toBe(PR_ID); // prId
    });
  });

  describe("markEscalated", () => {
    it("updates items to escalated state", () => {
      const db = makeMockDb();
      const service = createIssueInventoryService({ db });

      service.markEscalated(PR_ID, ["item-1", "item-2"]);

      expect(db.run).toHaveBeenCalledTimes(2);
      const sql = db.run.mock.calls[0][0] as string;
      expect(sql).toContain("state = 'escalated'");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — convergence computation (tested indirectly through getInventory)
  // ---------------------------------------------------------------------------

  describe("convergence computation", () => {
    it("computes currentRound as max round across all items", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "sent_to_agent", round: 1 }),
        makeFakeRow({ id: "i-2", state: "sent_to_agent", round: 3 }),
        makeFakeRow({ id: "i-3", state: "new", round: 0 }),
      ]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      expect(snapshot.convergence.currentRound).toBe(3);
    });

    it("builds per-round stats correctly", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "fixed", round: 1 }),
        makeFakeRow({ id: "i-2", state: "fixed", round: 1 }),
        makeFakeRow({ id: "i-3", state: "sent_to_agent", round: 2 }),
        makeFakeRow({ id: "i-4", state: "dismissed", round: 2 }),
      ]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      expect(snapshot.convergence.issuesPerRound.length).toBe(2);
      const round1 = snapshot.convergence.issuesPerRound.find((r) => r.round === 1);
      expect(round1).toBeDefined();
      expect(round1!.fixedCount).toBe(2);
      const round2 = snapshot.convergence.issuesPerRound.find((r) => r.round === 2);
      expect(round2).toBeDefined();
      expect(round2!.newCount).toBe(1); // sent_to_agent counts as new
      expect(round2!.dismissedCount).toBe(1);
    });

    it("isConverging = true when last round has fixes or dismissals", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "fixed", round: 1 }),
        makeFakeRow({ id: "i-2", state: "new", round: 0 }),
      ]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      expect(snapshot.convergence.isConverging).toBe(true);
    });

    it("isConverging = false when last round has no fixes or dismissals", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "sent_to_agent", round: 1 }),
        makeFakeRow({ id: "i-2", state: "new", round: 0 }),
      ]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      expect(snapshot.convergence.isConverging).toBe(false);
    });

    it("canAutoAdvance = true when there are new items and round < max", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "new", round: 0 }),
        makeFakeRow({ id: "i-2", state: "fixed", round: 1 }),
      ]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      expect(snapshot.convergence.canAutoAdvance).toBe(true);
    });

    it("canAutoAdvance = false when no new items remain", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "fixed", round: 1 }),
        makeFakeRow({ id: "i-2", state: "dismissed", round: 1 }),
      ]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      expect(snapshot.convergence.canAutoAdvance).toBe(false);
    });

    it("canAutoAdvance = false when at max rounds", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "new", round: 0 }),
        makeFakeRow({ id: "i-2", state: "sent_to_agent", round: 5 }),
      ]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      // currentRound = 5 which equals DEFAULT_MAX_ROUNDS
      expect(snapshot.convergence.canAutoAdvance).toBe(false);
    });

    it("skips round 0 items from per-round stats", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "new", round: 0 }),
        makeFakeRow({ id: "i-2", state: "new", round: 0 }),
      ]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      expect(snapshot.convergence.issuesPerRound.length).toBe(0);
    });

    it("returns maxRounds = 5 (default)", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      const snapshot = service.getInventory(PR_ID);

      expect(snapshot.convergence.maxRounds).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — getConvergenceStatus
  // ---------------------------------------------------------------------------

  describe("getConvergenceStatus", () => {
    it("returns convergence status directly", () => {
      const db = makeMockDb();
      db.all.mockReturnValue([
        makeFakeRow({ id: "i-1", state: "new", round: 0 }),
        makeFakeRow({ id: "i-2", state: "escalated", round: 2 }),
      ]);

      const service = createIssueInventoryService({ db });
      const status = service.getConvergenceStatus(PR_ID);

      expect(status.totalNew).toBe(1);
      expect(status.totalEscalated).toBe(1);
      expect(status.currentRound).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — resetInventory
  // ---------------------------------------------------------------------------

  describe("resetInventory", () => {
    it("deletes all items for the prId", () => {
      const db = makeMockDb();
      const service = createIssueInventoryService({ db });

      service.resetInventory(PR_ID);

      expect(db.run).toHaveBeenCalledWith(
        "delete from pr_issue_inventory where pr_id = ?",
        [PR_ID],
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — convergence runtime state
  // ---------------------------------------------------------------------------

  describe("convergence runtime state", () => {
    it("returns convergence runtime state from the database", () => {
      const db = makeMockDb();
      db.get.mockImplementation((sql: string) => {
        if (sql.includes("from pr_convergence_state")) {
          return makeRuntimeRow({
            auto_converge_enabled: 0,
            status: "polling",
            poller_status: "waiting_for_checks",
          });
        }
        return null;
      });

      const service = createIssueInventoryService({ db });
      const runtime = service.getConvergenceRuntime(PR_ID);

      expect(runtime).toEqual(expect.objectContaining({
        prId: PR_ID,
        autoConvergeEnabled: false,
        status: "polling",
        pollerStatus: "waiting_for_checks",
      }));
    });

    it("upserts convergence runtime state", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);

      const service = createIssueInventoryService({ db });
      const runtime = service.saveConvergenceRuntime(PR_ID, {
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "scheduled",
        currentRound: 3,
        activeSessionId: "session-9",
        activeLaneId: "lane-9",
        activeHref: "/work?laneId=lane-9&sessionId=session-9",
        pauseReason: null,
        errorMessage: null,
      });

      expect(runtime.prId).toBe(PR_ID);
      expect(runtime.autoConvergeEnabled).toBe(true);
      expect(runtime.status).toBe("running");
      expect(db.run).toHaveBeenCalledTimes(1);
      const sql = db.run.mock.calls[0][0] as string;
      expect(sql).toContain("insert into pr_convergence_state");
      const params = db.run.mock.calls[0][1] as unknown[];
      expect(params[0]).toBe(PR_ID);
      expect(params[1]).toBe(1);
      expect(params[2]).toBe("running");
      expect(params[3]).toBe("scheduled");
      expect(params[4]).toBe(3);
      expect(params[5]).toBe("session-9");
    });

    it("reconciles active convergence sessions when a tracked chat exits", () => {
      const db = makeMockDb();
      db.all.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes("from pr_convergence_state where active_session_id = ?")) {
          expect(params).toEqual(["session-1"]);
          return [makeRuntimeRow()];
        }
        return [];
      });
      db.get.mockImplementation((sql: string) => {
        if (sql.includes("from pr_convergence_state")) {
          return makeRuntimeRow();
        }
        return null;
      });

      const service = createIssueInventoryService({ db });
      const reconciled = service.reconcileConvergenceSessionExit("session-1", { exitCode: 0 });

      expect(reconciled).toHaveLength(1);
      expect(reconciled[0]).toEqual(expect.objectContaining({
        prId: PR_ID,
        status: "paused",
        pollerStatus: "paused",
        activeSessionId: null,
        pauseReason: "Agent session ended. Refresh the PR to reconcile checks and continue.",
      }));
      expect(db.run).toHaveBeenCalledWith(
        expect.stringContaining("insert into pr_convergence_state"),
        expect.arrayContaining([PR_ID, 1, "paused", "paused", 2, null]),
      );
    });

    it("deletes convergence runtime state on reset", () => {
      const db = makeMockDb();
      const service = createIssueInventoryService({ db });

      service.resetConvergenceRuntime(PR_ID);

      expect(db.run).toHaveBeenCalledWith(
        "delete from pr_convergence_state where pr_id = ?",
        [PR_ID],
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — pipeline settings
  // ---------------------------------------------------------------------------

  describe("getPipelineSettings", () => {
    it("returns defaults when no row exists", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);

      const service = createIssueInventoryService({ db });
      const settings = service.getPipelineSettings(PR_ID);

      expect(settings).toEqual({
        autoMerge: false,
        mergeMethod: "repo_default",
        maxRounds: 5,
        onRebaseNeeded: "pause",
      });
    });

    it("maps DB row to PipelineSettings", () => {
      const db = makeMockDb();
      db.get.mockReturnValue({
        auto_merge: 1,
        merge_method: "squash",
        max_rounds: 3,
        on_rebase_needed: "auto_rebase",
      });

      const service = createIssueInventoryService({ db });
      const settings = service.getPipelineSettings(PR_ID);

      expect(settings).toEqual({
        autoMerge: true,
        mergeMethod: "squash",
        maxRounds: 3,
        onRebaseNeeded: "auto_rebase",
      });
    });
  });

  describe("savePipelineSettings", () => {
    it("upserts merged settings into DB", () => {
      const db = makeMockDb();
      // getPipelineSettings is called internally — no existing row
      db.get.mockReturnValue(null);

      const service = createIssueInventoryService({ db });
      service.savePipelineSettings(PR_ID, { autoMerge: true, maxRounds: 3 });

      expect(db.run).toHaveBeenCalledTimes(1);
      const sql = db.run.mock.calls[0][0] as string;
      expect(sql).toContain("insert into pr_pipeline_settings");
      expect(sql).toContain("on conflict(pr_id) do update");
      const params = db.run.mock.calls[0][1] as unknown[];
      expect(params[0]).toBe(PR_ID); // prId
      expect(params[1]).toBe(1); // auto_merge = true -> 1
      expect(params[2]).toBe("repo_default"); // mergeMethod (default since not overridden)
      expect(params[3]).toBe(3); // maxRounds (overridden)
      expect(params[4]).toBe("pause"); // onRebaseNeeded (default)
    });

    it("merges partial settings with existing ones", () => {
      const db = makeMockDb();
      // Simulate existing settings in DB
      db.get.mockReturnValue({
        auto_merge: 0,
        merge_method: "squash",
        max_rounds: 5,
        on_rebase_needed: "auto_rebase",
      });

      const service = createIssueInventoryService({ db });
      service.savePipelineSettings(PR_ID, { autoMerge: true });

      const params = db.run.mock.calls[0][1] as unknown[];
      expect(params[1]).toBe(1); // auto_merge overridden to true
      expect(params[2]).toBe("squash"); // preserved from existing
      expect(params[3]).toBe(5); // preserved from existing
      expect(params[4]).toBe("auto_rebase"); // preserved from existing
    });
  });

  describe("deletePipelineSettings", () => {
    it("deletes pipeline settings for the prId", () => {
      const db = makeMockDb();
      const service = createIssueInventoryService({ db });

      service.deletePipelineSettings(PR_ID);

      expect(db.run).toHaveBeenCalledWith(
        "delete from pr_pipeline_settings where pr_id = ?",
        [PR_ID],
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — stripEmojiNoise / extractHeadline edge cases (via syncFromPrData)
  // ---------------------------------------------------------------------------

  describe("headline extraction edge cases", () => {
    it("strips emoji noise from bold titles", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "**⚠️ Fix the race condition** This is important.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const headline = insertCalls[0][1][10] as string;
      // Should have stripped "⚠️" emoji but kept the useful text
      expect(headline).not.toContain("⚠️");
      expect(headline).toContain("Fix the race condition");
    });

    it("uses fallback headline when body is empty", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          path: "src/utils.ts",
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const headline = insertCalls[0][1][10] as string;
      expect(headline).toContain("Review thread at src/utils.ts");
    });

    it("truncates very long first-line headlines to 120 chars", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const longLine = "A".repeat(200);
      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: longLine,
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const headline = insertCalls[0][1][10] as string;
      expect(headline.length).toBeLessThanOrEqual(120);
      expect(headline).toContain("...");
    });

    it("handles null body in thread comment gracefully", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          path: "src/main.ts",
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: null as any,
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(1);
      const headline = insertCalls[0][1][10] as string;
      expect(headline).toBe("Review thread at src/main.ts");
    });

    it("handles thread with no comments gracefully", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          path: "src/foo.ts",
          comments: [],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      expect(insertCalls.length).toBe(1);
      // author null, headline should use fallback
      const args = insertCalls[0][1] as unknown[];
      expect(args[12]).toBeNull(); // author
    });

    it("detects ade-review bot source", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "ade-review[bot]",
            authorAvatarUrl: null,
            body: "Clean up imports.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[2]).toBe("ade"); // source
    });

    it("returns unknown source for null/empty author", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "",
            authorAvatarUrl: null,
            body: "Fix something.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[2]).toBe("unknown"); // source for empty author
    });

    it("returns null severity when no severity markers found", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "Consider refactoring this function.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBeNull(); // severity
    });

    it("extracts P1 as critical severity", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "P1 Security issue here.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBe("critical");
    });

    it("extracts P3 as minor severity", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "P3 Cosmetic: extra whitespace.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBe("minor");
    });

    it("extracts [nit] bracket as minor severity", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "[nit] Variable name could be clearer.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBe("minor");
    });

    it("extracts [error] bracket as critical severity", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "[error] Unhandled exception possible here.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBe("critical");
    });

    it("extracts 🟠 emoji as major severity", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "🟠 Performance issue detected.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBe("major");
    });

    it("extracts 🟡 emoji as minor severity", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);
      db.all.mockReturnValue([]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          comments: [{
            id: "c-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "🟡 Minor style issue.",
            url: null,
            createdAt: null,
            updatedAt: null,
          }],
        })],
        [],
      );

      const insertCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("insert into pr_issue_inventory"),
      );
      const args = insertCalls[0][1] as unknown[];
      expect(args[9]).toBe("minor");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — validateConvergenceRuntimeState (Issue 1)
  // ---------------------------------------------------------------------------

  describe("convergence runtime validation", () => {
    it("rejects an unknown status value", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);

      const service = createIssueInventoryService({ db });
      expect(() =>
        service.saveConvergenceRuntime(PR_ID, { status: "bogus" as any }),
      ).toThrow(/Invalid convergence runtime status/);
    });

    it("rejects an unknown pollerStatus value", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);

      const service = createIssueInventoryService({ db });
      expect(() =>
        service.saveConvergenceRuntime(PR_ID, { pollerStatus: "made_up" as any }),
      ).toThrow(/Invalid convergence poller status/);
    });

    it("rejects a negative currentRound", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);

      const service = createIssueInventoryService({ db });
      expect(() =>
        service.saveConvergenceRuntime(PR_ID, { currentRound: -1 }),
      ).toThrow(/Invalid currentRound/);
    });

    it("rejects a non-integer currentRound", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);

      const service = createIssueInventoryService({ db });
      expect(() =>
        service.saveConvergenceRuntime(PR_ID, { currentRound: 2.5 }),
      ).toThrow(/Invalid currentRound/);
    });

    it("rejects NaN currentRound", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);

      const service = createIssueInventoryService({ db });
      expect(() =>
        service.saveConvergenceRuntime(PR_ID, { currentRound: NaN }),
      ).toThrow(/Invalid currentRound/);
    });

    it("accepts valid runtime state fields", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(null);

      const service = createIssueInventoryService({ db });
      expect(() =>
        service.saveConvergenceRuntime(PR_ID, {
          status: "running",
          pollerStatus: "polling",
          currentRound: 3,
        }),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — reopen on latest-comment edits (Issue 2)
  // ---------------------------------------------------------------------------

  describe("thread reopen on comment edit", () => {
    it("reopens a fixed thread when the latest comment is edited in place", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(makeFakeRow({
        id: "existing-thread-item",
        external_id: "thread:thread-edited",
        state: "fixed",
        round: 1,
        thread_comment_count: 1,
        thread_latest_comment_id: "comment-1",
        thread_latest_comment_at: "2026-03-23T12:00:00.000Z",
      }));
      db.all.mockReturnValue([makeFakeRow({
        id: "existing-thread-item",
        external_id: "thread:thread-edited",
        state: "new",
        round: 1,
      })]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          id: "thread-edited",
          comments: [{
            id: "comment-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "**Critical** Actually this is worse than I thought.",
            url: null,
            createdAt: "2026-03-23T12:00:00.000Z",
            // Same comment ID, but updatedAt is newer than stored thread_latest_comment_at
            updatedAt: "2026-03-23T14:00:00.000Z",
          }],
        })],
        [],
      );

      const updateCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("update pr_issue_inventory"),
      );
      expect(updateCalls.length).toBe(1);
      const params = updateCalls[0][1] as unknown[];
      // state should be "new" (reopened) because the comment was edited
      expect(params[8]).toBe("new");
      // agentSessionId should be cleared
      expect(params[11]).toBeNull();
    });

    it("does not reopen when the latest comment has not been edited", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(makeFakeRow({
        id: "existing-thread-item",
        external_id: "thread:thread-unchanged",
        state: "fixed",
        round: 1,
        thread_comment_count: 1,
        thread_latest_comment_id: "comment-1",
        thread_latest_comment_at: "2026-03-23T12:00:00.000Z",
      }));
      db.all.mockReturnValue([makeFakeRow({
        id: "existing-thread-item",
        external_id: "thread:thread-unchanged",
        state: "fixed",
        round: 1,
      })]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          id: "thread-unchanged",
          comments: [{
            id: "comment-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "Fix the null check.",
            url: null,
            createdAt: "2026-03-23T12:00:00.000Z",
            // Same updatedAt as stored — no edit
            updatedAt: "2026-03-23T12:00:00.000Z",
          }],
        })],
        [],
      );

      const updateCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("update pr_issue_inventory"),
      );
      expect(updateCalls.length).toBe(1);
      const params = updateCalls[0][1] as unknown[];
      // state should remain "fixed" because nothing changed
      expect(params[8]).toBe("fixed");
    });

    it("reopens a dismissed thread when the latest comment is edited", () => {
      const db = makeMockDb();
      db.get.mockReturnValue(makeFakeRow({
        id: "existing-thread-item",
        external_id: "thread:thread-dismissed-edited",
        state: "dismissed",
        dismiss_reason: "Not relevant",
        round: 1,
        thread_comment_count: 1,
        thread_latest_comment_id: "comment-1",
        thread_latest_comment_at: "2026-03-23T12:00:00.000Z",
      }));
      db.all.mockReturnValue([makeFakeRow({
        id: "existing-thread-item",
        external_id: "thread:thread-dismissed-edited",
        state: "new",
        round: 1,
      })]);

      const service = createIssueInventoryService({ db });
      service.syncFromPrData(
        PR_ID,
        [],
        [makeReviewThread({
          id: "thread-dismissed-edited",
          comments: [{
            id: "comment-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "Updated: this is actually a real problem.",
            url: null,
            createdAt: "2026-03-23T12:00:00.000Z",
            updatedAt: "2026-03-23T15:00:00.000Z",
          }],
        })],
        [],
      );

      const updateCalls = db.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("update pr_issue_inventory"),
      );
      expect(updateCalls.length).toBe(1);
      const params = updateCalls[0][1] as unknown[];
      expect(params[8]).toBe("new");
      // dismiss_reason should be cleared
      expect(params[10]).toBeNull();
    });
  });
});
