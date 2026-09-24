// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PrActivityEvent, PrCommit, PrReview, PrReviewThread, PrStatus, PrWithConflicts } from "../../../../shared/types/prs";
import { parsePrsRouteState } from "../prsRouteState";
import {
  PrDetailTimelineRails,
  buildCommitRailCommits,
  buildTimelineEvents,
  buildTimelineVisibleEventHash,
  buildTimelineVisibleEventSearch,
} from "./PrDetailTimelineRails";
import type { ComponentProps } from "react";
import { PrDetailHeader } from "./PrDetailHeader";

vi.mock("react-resizable-panels", () => {
  type PaneProps = React.HTMLAttributes<HTMLDivElement> & {
    id?: string;
    defaultSize?: unknown;
    minSize?: unknown;
    maxSize?: unknown;
    orientation?: unknown;
    groupResizeBehavior?: unknown;
    onResize?: unknown;
  };
  // Sizes are surfaced as data attributes rather than dropped: the split ratio
  // between thread and right rail is a product decision worth asserting, and
  // the real Group needs layout the jsdom environment cannot supply.
  const strip = ({
    defaultSize,
    minSize,
    maxSize,
    orientation: _orientation,
    groupResizeBehavior: _groupResizeBehavior,
    onResize: _onResize,
    ...rest
  }: PaneProps) => ({
    ...rest,
    "data-default-size": defaultSize as number | undefined,
    "data-min-size": minSize as number | undefined,
    "data-max-size": maxSize as number | undefined,
  });
  return {
    Group: (props: PaneProps) => <div {...strip(props)} />,
    Panel: (props: PaneProps) => <div {...strip(props)} />,
    Separator: (props: PaneProps) => <div role="separator" {...strip(props)} />,
  };
});

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/prs", search: "?tab=normal&prId=pr-1" }),
}));

vi.mock("../shared/PrTimeline", () => ({
  PrTimeline: React.forwardRef(function PrTimeline(
    props: { digest?: { items: Array<{ kind: string }> } | null; onFixInChat?: unknown },
    _ref: unknown,
  ) {
    // The digest model is the contract between the rails and the thread, so
    // surface its shape rather than rendering the virtualized list.
    return (
      <div
        data-testid="pr-timeline"
        data-digest-kinds={(props.digest?.items ?? []).map((item) => item.kind).join(",")}
        data-fix-in-chat={props.onFixInChat ? "yes" : "no"}
      />
    );
  }),
}));
vi.mock("../shared/PrMergeDialog", () => ({
  PrMergeDialog: (props: { open: boolean; skips?: string[]; preferBypass?: boolean }) =>
    props.open ? (
      <div data-testid="pr-merge-dialog" data-skips={(props.skips ?? []).join("|")} data-prefer-bypass={props.preferBypass ? "yes" : "no"} />
    ) : null,
}));
vi.mock("../state/PrsContext", () => ({
  usePrs: () => ({ prs: [] }),
  useOptionalPrs: () => null,
}));
vi.mock("../shared/PrCommandPalettes", () => ({
  PrCommandPalettes: () => null,
}));

afterEach(cleanup);

describe("buildTimelineVisibleEventSearch", () => {
  it("preserves the selected detail tab when replacing the visible event", () => {
    const current = parsePrsRouteState({
      search: "?tab=normal&prId=pr-1&eventId=comment-old&detailTab=overview",
    });

    expect(buildTimelineVisibleEventSearch({
      current,
      prId: "pr-1",
      eventId: "comment-new",
    })).toBe("?tab=normal&prId=pr-1&eventId=comment-new&detailTab=overview");
  });

  it("keeps coordinate-only routes coordinate-based while replacing the visible event", () => {
    const current = parsePrsRouteState({
      search: "?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade&detailTab=overview",
    });

    expect(buildTimelineVisibleEventSearch({
      current,
      prId: "gh:ade-dev/ade#123",
      eventId: "comment-new",
    })).toBe("?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade&eventId=comment-new&detailTab=overview");
  });

  it("preserves a hash-based coordinate PR route when the visible event changes", () => {
    const current = parsePrsRouteState({
      hash: "#/prs?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade&eventId=comment-old",
    });
    const nextSearch = buildTimelineVisibleEventSearch({
      current,
      prId: "gh:ade-dev/ade#123",
      eventId: "comment-new",
    });

    expect(buildTimelineVisibleEventHash({
      currentHash: "#/prs?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade&eventId=comment-old",
      nextSearch,
    })).toBe("#/prs?tab=normal&pr=123&repoOwner=ade-dev&repoName=ade&eventId=comment-new");
  });
});

describe("buildTimelineEvents fold", () => {
  // The fold only reads pr.id / pr.createdAt / pr.baseBranch and (when non-null)
  // detail.*; a minimal pr stub keeps fixtures honest without faking the world.
  const pr = { id: "pr-1", createdAt: "2026-01-01T00:00:00Z", baseBranch: "main" } as unknown as PrWithConflicts;
  function foldArgs(over: Partial<Parameters<typeof buildTimelineEvents>[0]>): Parameters<typeof buildTimelineEvents>[0] {
    return {
      pr,
      detail: null,
      activity: [],
      reviews: [],
      reviewThreads: [],
      comments: [],
      checks: [],
      deployments: [],
      commits: [],
      ...over,
    };
  }
  const forcePush: PrActivityEvent = {
    id: "fp1",
    type: "force_push",
    author: "octocat",
    avatarUrl: null,
    body: null,
    timestamp: "2026-01-02T00:00:00Z",
    metadata: { beforeSha: "1111111aaaa", afterSha: "2222222bbbb" },
  };

  it("keys a force-push event on afterSha and matches the commit-rail entry (rail→event scroll)", () => {
    const events = buildTimelineEvents(foldArgs({ activity: [forcePush] }));
    const fp = events.find((e) => e.type === "commit_push" && e.forcePushed);
    expect(fp).toBeTruthy();
    expect(fp && fp.type === "commit_push" ? fp.sha : null).toBe("2222222bbbb");

    // The rail entry must derive the SAME sha, else selecting it can't resolve
    // the timeline event (the force-push "nothing highlights" bug).
    const rail = buildCommitRailCommits([forcePush], []);
    const railFp = rail.find((c) => c.forcePushed);
    expect(railFp?.sha).toBe(fp && fp.type === "commit_push" ? fp.sha : "MISMATCH");
  });

  it("pins the PR description to the top even when its createdAt is newer than later events", () => {
    // An adopted/linked PR can carry a wrong (too-recent) createdAt; the
    // description must still render first (GitHub parity), not sink below the
    // force-push whose real timestamp is earlier.
    const latePr = { id: "pr-1", createdAt: "2026-12-31T00:00:00Z", baseBranch: "main" } as unknown as PrWithConflicts;
    const detail = {
      body: "PR description",
      author: { login: "octocat", avatarUrl: null },
    } as unknown as Parameters<typeof buildTimelineEvents>[0]["detail"];
    const events = buildTimelineEvents(foldArgs({ pr: latePr, detail, activity: [forcePush] }));
    expect(events[0]?.type).toBe("description");
    // The earlier-timestamped force-push is still present, just below.
    expect(events.some((e) => e.type === "commit_push")).toBe(true);
  });

  it("suppresses a bodyless 'commented' review but keeps one with a summary body", () => {
    const reviews: PrReview[] = [
      { reviewer: "bot", reviewerAvatarUrl: null, state: "commented", body: "   ", submittedAt: "2026-01-03T00:00:00Z" },
      { reviewer: "human", reviewerAvatarUrl: null, state: "commented", body: "Real summary", submittedAt: "2026-01-03T01:00:00Z" },
      { reviewer: "approver", reviewerAvatarUrl: null, state: "approved", body: null, submittedAt: "2026-01-03T02:00:00Z" },
    ];
    const reviewEvents = buildTimelineEvents(foldArgs({ reviews })).filter((e) => e.type === "review");
    expect(reviewEvents.map((e) => e.author).sort()).toEqual(["approver", "human"]);
  });

  it("enriches a commit event's avatar from the matching commit snapshot by sha", () => {
    const commitAct: PrActivityEvent = {
      id: "c1",
      type: "commit",
      author: "dev",
      avatarUrl: null,
      body: null,
      timestamp: "2026-01-04T00:00:00Z",
      metadata: { sha: "abc1234", subject: "fix things" },
    };
    const commits: PrCommit[] = [
      {
        sha: "abc1234",
        shortSha: "abc1234",
        message: "fix things",
        author: { login: "dev", name: "Dev", email: null, avatarUrl: "https://avatars.example/dev.png" },
        committedDate: "2026-01-04T00:00:00Z",
      },
    ];
    const commit = buildTimelineEvents(foldArgs({ activity: [commitAct], commits })).find(
      (e) => e.type === "commit_push" && e.sha === "abc1234",
    );
    expect(commit && commit.type === "commit_push" ? commit.avatarUrl : null).toBe("https://avatars.example/dev.png");
  });
});

const layoutPr = {
  id: "pr-1",
  projectId: "proj-1",
  laneId: "lane-1",
  repoOwner: "acme",
  repoName: "ade",
  githubPrNumber: 42,
  githubUrl: "https://github.com/acme/ade/pull/42",
  title: "Add the thing",
  state: "open",
  baseBranch: "main",
  headBranch: "feature",
  createdAt: "2026-01-01T00:00:00Z",
} as unknown as PrWithConflicts;

function statusFor(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    prId: "pr-1",
    state: "open",
    checksStatus: "passing",
    reviewStatus: "none",
    isMergeable: true,
    mergeConflicts: false,
    behindBaseBy: 0,
    mergeStateStatus: "clean",
    ...overrides,
  };
}

type RailsOverrides = Partial<ComponentProps<typeof PrDetailTimelineRails>>;

function renderRails(overrides: RailsOverrides = {}) {
  return render(
    <PrDetailTimelineRails
      pr={layoutPr}
      detail={null}
      status={null}
      checks={[]}
      reviews={[]}
      comments={[]}
      activity={[]}
      commits={[]}
      files={[]}
      reviewThreads={[]}
      deployments={[]}
      viewerLogin="alice"
      commentDraft=""
      setCommentDraft={() => {}}
      actionBusy={false}
      onAddComment={() => {}}
      deepLink={{ eventId: null, threadId: null, commitSha: null }}
      actionRuns={[]}
      mergeMethod="squash"
      onMerge={() => {}}
      onRequestReviewers={() => {}}
      onSetLabels={() => {}}
      onSubmitReview={() => {}}
      {...overrides}
    />,
  );
}

const commit = (id: string, sha: string, timestamp: string): PrActivityEvent => ({
  id,
  type: "commit",
  author: "dev",
  avatarUrl: null,
  body: null,
  timestamp,
  metadata: { sha, subject: `commit ${sha}` },
});

function openThread(id: string, author: string, createdAt: string): PrReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/usage.ts",
    line: 307,
    originalLine: 307,
    startLine: null,
    originalStartLine: null,
    diffSide: "RIGHT",
    url: `https://github.com/acme/ade/pull/42#discussion_${id}`,
    createdAt,
    updatedAt: createdAt,
    comments: [{ id: `${id}-c`, author, authorAvatarUrl: null, authorIsBot: true, body: "Stale rates kept. More detail.", url: null, createdAt, updatedAt: createdAt }],
  };
}

describe("PrDetailTimelineRails — Overview layout", () => {
  it("is one thread with the tick rail and the dock laid over it, Merge open by default", () => {
    renderRails();
    const overview = screen.getByTestId("pr-detail-timeline-rails");
    expect(overview.contains(screen.getByTestId("pr-timeline"))).toBe(true);
    // No resizable rail and no separator any more.
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByTestId("pr-detail-right-rail")).toBeNull();
    for (const id of ["merge", "comment", "reviewers", "labels", "assignees"]) {
      expect(screen.getByTestId(`pr-dock-bubble-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId("pr-dock-card-merge")).toBeTruthy();
  });

  it("opens one card at a time and closes it on Escape", () => {
    renderRails();
    fireEvent.click(screen.getByTestId("pr-dock-bubble-comment"));
    expect(screen.getByTestId("pr-dock-card-comment")).toBeTruthy();
    expect(screen.queryByTestId("pr-dock-card-merge")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("pr-dock-card-comment")).toBeNull();
  });

  it("hands the thread a digest with one section per push and a tick for each", () => {
    renderRails({
      activity: [commit("c1", "aaaaaaa", "2026-01-02T00:00:00Z"), commit("c2", "bbbbbbb", "2026-01-04T00:00:00Z")],
      reviewThreads: [openThread("t1", "devin-ai-integration", "2026-01-03T00:00:00Z")],
    });
    const kinds = screen.getByTestId("pr-timeline").getAttribute("data-digest-kinds") ?? "";
    // The open thread lands between the two commits, so they are two pushes.
    expect(kinds.split(",")).toEqual(["attention", "push", "bot-group", "push"]);
    expect(screen.getAllByTestId("pr-push-tick")).toHaveLength(2);
  });

  it("offers Fix in chat on Needs attention only when the PR has a lane chat to hand to", () => {
    renderRails();
    expect(screen.getByTestId("pr-timeline").getAttribute("data-fix-in-chat")).toBe("no");
    cleanup();
    renderRails({ onHandPrompt: () => {} });
    expect(screen.getByTestId("pr-timeline").getAttribute("data-fix-in-chat")).toBe("yes");
  });

  it("leads a conflicting PR with Resolve in chat and keeps Merge anyway blocked", () => {
    const onHandPrompt = vi.fn();
    renderRails({
      status: statusFor({ mergeStateStatus: "dirty", mergeConflicts: true, canBypass: true }),
      onHandPrompt,
    });
    expect(screen.getByTestId("pr-merge-card-headline").textContent).toBe("Conflicts with main");
    expect((screen.getByTestId("pr-merge-anyway") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("pr-merge-blocked-reason").textContent).toContain("conflicts");
    fireEvent.click(screen.getByTestId("pr-merge-card-primary"));
    expect(onHandPrompt).toHaveBeenCalledWith(expect.stringContaining("Resolve the merge conflicts between feature and main"));
  });

  it("lets an admin bypass protection and tells the dialog what the merge skips", () => {
    renderRails({
      status: statusFor({ mergeStateStatus: "blocked", reviewDecision: "review_required", requiredApprovals: 1, approvalsCount: 0, canBypass: true }),
    });
    const anyway = screen.getByTestId("pr-merge-anyway");
    expect(anyway.getAttribute("data-bypass")).toBe("true");
    expect(anyway.textContent).toContain("Bypass & merge");
    fireEvent.click(anyway);
    const dialog = screen.getByTestId("pr-merge-dialog");
    expect(dialog.getAttribute("data-prefer-bypass")).toBe("yes");
    expect(dialog.getAttribute("data-skips")).toBe("1 required approval");
  });

  it("merges straight from the primary button when the PR is ready", () => {
    renderRails({ status: statusFor() });
    expect(screen.getByTestId("pr-merge-card-headline").textContent).toBe("Ready to merge");
    expect(screen.queryByTestId("pr-merge-anyway")).toBeNull();
    fireEvent.click(screen.getByTestId("pr-merge-card-primary"));
    expect(screen.getByTestId("pr-merge-dialog").getAttribute("data-skips")).toBe("");
  });

  it("passes the next-step action to the host for Ready for review, and hides it with no host", async () => {
    const onPrStateAction = vi.fn().mockResolvedValue(undefined);
    renderRails({ status: statusFor({ mergeStateStatus: "draft" }), onPrStateAction });
    const primary = screen.getByTestId("pr-merge-card-primary");
    expect(primary.textContent).toBe("Ready for review");
    fireEvent.click(primary);
    expect(onPrStateAction).toHaveBeenCalledWith("ready_for_review");
    await act(async () => {});
    cleanup();
    renderRails({ status: statusFor({ mergeStateStatus: "draft" }) });
    expect(screen.queryByTestId("pr-merge-card-primary")).toBeNull();
  });

  it("lists agent reviewers who were never requested — the old rail said None", () => {
    const reviews: PrReview[] = [
      { reviewer: "coderabbitai", reviewerAvatarUrl: null, reviewerIsBot: true, state: "commented", body: "Summary", submittedAt: "2026-01-02T00:00:00Z" },
      { reviewer: "octocat", reviewerAvatarUrl: null, state: "approved", body: null, submittedAt: "2026-01-03T00:00:00Z" },
    ];
    renderRails({ reviews });
    fireEvent.click(screen.getByTestId("pr-dock-bubble-reviewers"));
    const rows = screen.getAllByTestId("pr-reviewer-row");
    // People first, then agents; an agent shows its product name, not its login.
    expect(rows[0]!.textContent).toContain("octocat");
    expect(rows[1]!.textContent).toContain("CodeRabbit");
    expect(rows[1]!.textContent).not.toContain("coderabbitai");
    expect(rows[1]!.getAttribute("data-bot")).toBe("true");
  });

  it("replaces ADE merge controls with GitHub guidance for a stacked PR", () => {
    renderRails({
      pr: {
        ...layoutPr,
        stack: { id: "stack-18", number: 18, size: 3, position: 2, baseBranch: "main" },
      } as PrWithConflicts,
    });
    expect(screen.getByText("GitHub Stack 2 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Review and merge on GitHub/ })).toBeTruthy();
    expect(screen.queryByTestId("pr-merge-anyway")).toBeNull();
  });
});

/* -- The header card above the same Overview; one surface, one suite. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makePr(overrides: Partial<PrWithConflicts> = {}): PrWithConflicts {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 1180,
    githubUrl: "https://github.com/arul28/ADE/pull/1180",
    githubNodeId: null,
    title: "ADE UI clutter reduction",
    state: "open",
    baseBranch: "main",
    headBranch: "ade/ade-ui-clutter-reduction",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 1,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as PrWithConflicts;
}

function renderHeader(overrides: Partial<ComponentProps<typeof PrDetailHeader>> = {}) {
  const pr = overrides.pr ?? makePr();
  const props: ComponentProps<typeof PrDetailHeader> = {
    pr,
    provisional: false,
    activeTab: "overview",
    onSelectTab: vi.fn(),
    filesCount: 30,
    checksNote: { state: "running", passed: 3, total: 5 },
    author: { login: "arul28", avatarUrl: null },
    lane: { id: "lane-1", name: "Scope cuts", color: "#F97316" } as ComponentProps<typeof PrDetailHeader>["lane"],
    linkedChats: [],
    onOpenChat: vi.fn(),
    editingTitle: false,
    titleDraft: "",
    onTitleDraftChange: vi.fn(),
    onStartTitleEdit: vi.fn(),
    onCancelTitleEdit: vi.fn(),
    onSubmitTitle: vi.fn(),
    onReadyForReview: vi.fn(),
    readyForReviewBusy: false,
    actions: { pr, onRefresh: vi.fn(), refreshing: false },
    ...overrides,
  };
  return { props, ...render(<PrDetailHeader {...props} />) };
}

describe("PrDetailHeader", () => {
  it("is a card: number and author, the title, base ← head with the lane, then the tabs", () => {
    renderHeader();
    expect(screen.getByText("#1180")).toBeTruthy();
    expect(screen.getByText("arul28")).toBeTruthy();
    expect(screen.getByText(/opened/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ADE UI clutter reduction" })).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("ade/ade-ui-clutter-reduction")).toBeTruthy();
    expect(screen.getByTestId("pr-header-lane-chip").textContent).toContain("Scope cuts");
    expect(screen.getByRole("tab", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Checks" })).toBeTruthy();
    expect(screen.getByTestId("pr-actions-trigger")).toBeTruthy();
    expect(screen.getByLabelText("Refresh pull request")).toBeTruthy();
  });

  it("counts running checks live beside the Checks tab, then settles to a result", () => {
    renderHeader();
    expect(screen.getByTestId("pr-header-checks-note").textContent).toBe("3/5");
    cleanup();
    renderHeader({ checksNote: { state: "failing", passed: 3, total: 5 } });
    expect(screen.getByTestId("pr-header-checks-note").textContent).toBe("2 failing");
  });

  it("shows Ready for review only on a draft", () => {
    renderHeader();
    expect(screen.queryByTestId("pr-header-ready-for-review")).toBeNull();
    cleanup();
    const onReadyForReview = vi.fn();
    renderHeader({ pr: makePr({ state: "draft" }), onReadyForReview });
    fireEvent.click(screen.getByTestId("pr-header-ready-for-review"));
    expect(onReadyForReview).toHaveBeenCalledTimes(1);
  });

  it("links the chats working on this PR", () => {
    const onOpenChat = vi.fn();
    const session = { sessionId: "chat-1", laneId: "lane-1", title: "Fix the manifest" } as ComponentProps<typeof PrDetailHeader>["linkedChats"][number];
    renderHeader({ linkedChats: [session], onOpenChat });
    fireEvent.click(screen.getByTestId("pr-header-chat-chip"));
    expect(onOpenChat).toHaveBeenCalledWith(session);
  });

  it("keeps the edit pencil available for a PR with no lane", () => {
    const onStartTitleEdit = vi.fn();
    renderHeader({ pr: makePr({ laneId: null as unknown as string }), lane: null, onStartTitleEdit });
    const pencil = screen.getByLabelText("Edit title");
    expect(pencil.closest(".ade-pr-detail-header-identity")).not.toBeNull();
    fireEvent.click(pencil);
    expect(onStartTitleEdit).toHaveBeenCalledTimes(1);
  });

  it("commits the title on Enter and abandons it on Escape", () => {
    const onSubmitTitle = vi.fn();
    const onCancelTitleEdit = vi.fn();
    renderHeader({ editingTitle: true, titleDraft: "New title", onSubmitTitle, onCancelTitleEdit });
    const input = screen.getByLabelText("Pull request title");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmitTitle).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancelTitleEdit).toHaveBeenCalledTimes(1);
  });

  it("switches tabs and opens the PR's own GitHub URL from the number", () => {
    const openExternal = vi.fn();
    (window as unknown as { ade: unknown }).ade = { app: { openExternal }, prs: { openInGitHub: vi.fn() } };
    const onSelectTab = vi.fn();
    renderHeader({ onSelectTab });
    fireEvent.click(screen.getByRole("tab", { name: "Checks" }));
    expect(onSelectTab).toHaveBeenCalledWith("checks");
    fireEvent.click(screen.getByText("#1180"));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/arul28/ADE/pull/1180");
  });
});
