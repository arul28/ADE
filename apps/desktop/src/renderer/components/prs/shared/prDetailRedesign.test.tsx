// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { PrDetail, PrReview, PrReviewThread, PrStatus, PrTimelineEvent, PrWithConflicts } from "../../../../shared/types/prs";
import { usePrActionsMenu, type PrActionsTarget } from "./PrActionsMenu";
import { PrMarkdown } from "./PrMarkdown";
import { PrMarkdownEnvContext, resolveInlineFile } from "./prMarkdownContext";
import { buildDigestTimelineModel } from "./prDigestTimelineModel";
import { buildPrChatPrompt, handPromptToChat, prFailingCheckNames, prOpenFindings } from "./prChatActions";
import { PrCommentCard, collectPrReviewers } from "./PrFloatingDock";
import { PrShippedSummary } from "./PrShippedSummary";
import { formatTimestampShort } from "./prFormatters";

vi.mock("./CodeHighlighter", () => ({}));
vi.mock("../../chat/CodeHighlighter", () => ({
  HighlightedCode: ({ code }: { code: string }) => <pre data-testid="highlighted">{code}</pre>,
}));
vi.mock("../../../lib/openExternal", () => ({ navigateToAppTarget: vi.fn() }));
vi.mock("../../../lib/agentChatDraftHandoff", () => ({ queueAgentChatDraftHandoff: vi.fn() }));
const prsMock = vi.hoisted(() => ({ markPrTerminalLocally: vi.fn(), clearPrTerminalLocally: vi.fn() }));
vi.mock("../state/PrsContext", () => ({ useOptionalPrs: () => prsMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const target: PrActionsTarget = {
  id: "pr-1",
  laneId: "lane-1",
  githubPrNumber: 1285,
  repoOwner: "arul28",
  repoName: "ADE",
  headBranch: "feat/model",
  baseBranch: "main",
  title: "Update the model directory",
  githubUrl: "https://github.com/arul28/ADE/pull/1285",
  state: "open",
  chatSessionIds: [],
};

function ids(sections: ReturnType<typeof usePrActionsMenu>["sections"]): string[] {
  return sections.flatMap((section) => section.items.map((item) => item.id));
}

describe("usePrActionsMenu", () => {
  it("offers chat actions only for a PR with a lane, and findings only when there are some", () => {
    const withLane = renderHook(() => usePrActionsMenu({ pr: target, findings: [{ author: "devin", path: "a.ts", line: 1, body: "x", url: null }] }));
    expect(ids(withLane.result.current.sections)).toEqual(expect.arrayContaining(["ask", "explain", "fix_findings", "update_description"]));
    const noLane = renderHook(() => usePrActionsMenu({ pr: { ...target, laneId: "" } }));
    expect(ids(noLane.result.current.sections)).not.toContain("ask");
    expect(ids(noLane.result.current.sections)).toEqual(expect.arrayContaining(["open", "copy-link", "copy-number", "close"]));
  });

  it("shows auto-merge from the repo setting, and points an admin at settings when it is off", () => {
    const status = (over: Partial<PrStatus>): PrStatus => ({
      prId: "pr-1", state: "open", checksStatus: "pending", reviewStatus: "none", isMergeable: false,
      mergeConflicts: false, behindBaseBy: 0, ...over,
    });
    const allowed = renderHook(() => usePrActionsMenu({ pr: target, status: status({ autoMergeAllowed: true }) }));
    expect(ids(allowed.result.current.sections)).toContain("auto-merge-on");
    const armed = renderHook(() => usePrActionsMenu({ pr: target, status: status({ autoMergeAllowed: true, autoMergeEnabled: true }) }));
    expect(ids(armed.result.current.sections)).toContain("auto-merge-off");
    const offAdmin = renderHook(() => usePrActionsMenu({ pr: target, status: status({ autoMergeAllowed: false, canBypass: true }) }));
    expect(ids(offAdmin.result.current.sections)).toContain("auto-merge-settings");
    const offMember = renderHook(() => usePrActionsMenu({ pr: target, status: status({ autoMergeAllowed: false }) }));
    expect(ids(offMember.result.current.sections).some((id) => id.startsWith("auto-merge"))).toBe(false);
  });

  it("swaps Convert to draft for Ready for review on a draft, and Close for Reopen when closed", () => {
    expect(ids(renderHook(() => usePrActionsMenu({ pr: target })).result.current.sections)).toContain("draft");
    expect(ids(renderHook(() => usePrActionsMenu({ pr: { ...target, state: "draft" } })).result.current.sections)).toContain("ready");
    const closed = ids(renderHook(() => usePrActionsMenu({ pr: { ...target, state: "closed" } })).result.current.sections);
    expect(closed).toContain("reopen");
    expect(closed).not.toContain("close");
  });

  it("offers a chat submenu when several chats are linked", async () => {
    (window as unknown as { ade: unknown }).ade = {
      agentChat: {
        list: vi.fn(async () => [
          { sessionId: "a", laneId: "lane-1", title: "First", lastActivityAt: "2026-01-02T00:00:00Z", archivedAt: null },
          { sessionId: "b", laneId: "lane-1", title: "Second", lastActivityAt: "2026-01-03T00:00:00Z", archivedAt: null },
        ]),
      },
    };
    const hook = renderHook(() => usePrActionsMenu({ pr: { ...target, chatSessionIds: ["a", "b"] } }));
    hook.result.current.ensureChats();
    await waitFor(() => {
      const ask = hook.result.current.sections[0]!.items.find((item) => item.id === "ask");
      expect(ask?.submenu?.map((child) => child.label)).toEqual(["Second", "First", "New chat in lane"]);
    });
  });

  it("uses lane chats the caller passes and does not fetch them again", () => {
    const list = vi.fn(async () => []);
    (window as unknown as { ade: unknown }).ade = { agentChat: { list } };
    const laneChats = [
      { sessionId: "a", laneId: "lane-1", title: "First", lastActivityAt: "2026-01-02T00:00:00Z", archivedAt: null },
      { sessionId: "b", laneId: "lane-1", title: "Second", lastActivityAt: "2026-01-03T00:00:00Z", archivedAt: null },
    ] as unknown as NonNullable<Parameters<typeof usePrActionsMenu>[0]["laneChats"]>;
    const hook = renderHook(() => usePrActionsMenu({ pr: { ...target, chatSessionIds: ["a", "b"] }, laneChats }));
    hook.result.current.ensureChats();
    expect(list).not.toHaveBeenCalled();
    const ask = hook.result.current.sections[0]!.items.find((item) => item.id === "ask");
    expect(ask?.submenu?.map((child) => child.label)).toEqual(["Second", "First", "New chat in lane"]);
  });

  it("shows Manage lane only when the caller can open it and the PR has a lane", () => {
    const onManageLane = vi.fn();
    const withLane = renderHook(() => usePrActionsMenu({ pr: target, onManageLane }));
    const item = withLane.result.current.sections.flatMap((section) => section.items).find((entry) => entry.id === "manage-lane");
    expect(item?.label).toBe("Manage lane…");
    item?.onSelect?.();
    expect(onManageLane).toHaveBeenCalledTimes(1);
    expect(ids(renderHook(() => usePrActionsMenu({ pr: target })).result.current.sections)).not.toContain("manage-lane");
    expect(ids(renderHook(() => usePrActionsMenu({ pr: { ...target, laneId: "" }, onManageLane })).result.current.sections)).not.toContain("manage-lane");
  });

  it("paints a close and a reopen in the list at once, before the refetch", async () => {
    const close = vi.fn(async () => undefined);
    const reopen = vi.fn(async () => undefined);
    (window as unknown as { ade: unknown }).ade = { prs: { close, reopen } };
    const find = (hook: { result: { current: ReturnType<typeof usePrActionsMenu> } }, id: string) =>
      hook.result.current.sections.flatMap((section) => section.items).find((entry) => entry.id === id);

    const open = renderHook(() => usePrActionsMenu({ pr: target }));
    find(open, "close")?.onSelect?.();
    // Close asks first; the list must not change until the user confirms.
    await waitFor(() => expect(open.result.current.dialog.props.state?.open).toBe(true));
    expect(close).not.toHaveBeenCalled();
    open.result.current.dialog.props.state.onConfirm();
    await waitFor(() => expect(prsMock.markPrTerminalLocally).toHaveBeenCalledWith(target, "closed"));
    expect(close).toHaveBeenCalledWith({ prId: "pr-1" });

    const closedTarget = { ...target, state: "closed" as const };
    const closed = renderHook(() => usePrActionsMenu({ pr: closedTarget }));
    find(closed, "reopen")?.onSelect?.();
    await waitFor(() => expect(prsMock.clearPrTerminalLocally).toHaveBeenCalledWith(closedTarget));
    expect(reopen).toHaveBeenCalledWith({ prId: "pr-1" });
  });

  it("enables auto-merge with the merge method the user picked last", async () => {
    const setAutoMerge = vi.fn(async () => undefined);
    (window as unknown as { ade: unknown }).ade = { prs: { setAutoMerge } };
    window.localStorage.setItem("ade:prs:lastMergeMethod", "rebase");
    try {
      const hook = renderHook(() => usePrActionsMenu({ pr: target, status: {
        prId: "pr-1", state: "open", checksStatus: "pending", reviewStatus: "none", isMergeable: false,
        mergeConflicts: false, behindBaseBy: 0, autoMergeAllowed: true,
      } }));
      hook.result.current.sections.flatMap((section) => section.items).find((entry) => entry.id === "auto-merge-on")?.onSelect?.();
      await waitFor(() => expect(setAutoMerge).toHaveBeenCalledWith({ prId: "pr-1", enabled: true, method: "rebase" }));
    } finally {
      window.localStorage.removeItem("ade:prs:lastMergeMethod");
    }
  });
});

describe("chat hand-off", () => {
  it("writes the prompt into a new lane chat when none is linked", async () => {
    const { queueAgentChatDraftHandoff } = await import("../../../lib/agentChatDraftHandoff");
    handPromptToChat({ laneId: "lane-1", sessionId: null, prompt: "hello" });
    expect(queueAgentChatDraftHandoff).toHaveBeenCalledWith({ draftTargetId: "work:draft:lane-1:chat" }, "hello");
  });

  it("names the PR and lists each open finding with where it is", () => {
    const prompt = buildPrChatPrompt("fix_findings", target, {
      findings: [{ author: "devin-ai-integration", path: "apps/x/usagePricing.ts", line: 307, body: "**Stale rates kept.** More.", url: "https://x" }],
    });
    expect(prompt).toContain("arul28/ADE PR #1285");
    expect(prompt).toContain("1. [devin-ai-integration] apps/x/usagePricing.ts:307 — Stale rates kept. (https://x)");
  });
});

describe("PR markdown in the Overview", () => {
  const env = {
    prFiles: ["apps/desktop/src/shared/modelManifest.ts", "apps/desktop/src/shared/model-manifest.json"],
    onOpenFile: vi.fn(),
    prStateByNumber: new Map([[1284, "merged" as const]]),
    onOpenPr: vi.fn(),
  };
  const renderMd = (body: string) => render(
    <PrMarkdownEnvContext.Provider value={env}>
      <PrMarkdown repoOwner="arul28" repoName="ADE" variant="document">{body}</PrMarkdown>
    </PrMarkdownEnvContext.Provider>,
  );

  it("turns inline code that names a PR file into a chip that opens it", () => {
    renderMd("Model manifest (`modelManifest.ts`) and `npx vitest run`.");
    const chip = screen.getByTestId("pr-md-file-chip");
    expect(chip.textContent).toContain("modelManifest.ts");
    expect(chip.textContent).toContain("src/shared");
    fireEvent.click(chip);
    expect(env.onOpenFile).toHaveBeenCalledWith("apps/desktop/src/shared/modelManifest.ts", true);
    // A command stays code.
    expect(screen.getByText("npx vitest run").tagName).toBe("CODE");
  });

  it("renders #123 as a pill in the other PR's state and opens it in ADE", () => {
    renderMd("Builds on #1284.");
    const pill = screen.getByTestId("pr-md-ref-pill");
    expect(pill.getAttribute("data-state")).toBe("merged");
    fireEvent.click(pill);
    expect(env.onOpenPr).toHaveBeenCalledWith(1284);
  });

  it("makes a pill only for a link into this repo, not a same-numbered link to another repo", () => {
    renderMd("See [#77](https://github.com/other/fork/pull/77) and [#1284](https://github.com/ARUL28/ade/pull/1284).");
    const pills = screen.getAllByTestId("pr-md-ref-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0]!.getAttribute("data-state")).toBe("merged");
    const foreign = screen.getByText("#77").closest("a");
    expect(foreign?.getAttribute("href")).toBe("https://github.com/other/fork/pull/77");
    expect(foreign?.getAttribute("data-testid")).not.toBe("pr-md-ref-pill");
  });

  it("renders GitHub alert syntax as a callout without the marker", () => {
    renderMd("> [!WARNING]\n> Do not merge before the release.");
    const alert = screen.getByTestId("pr-md-alert");
    expect(alert.getAttribute("data-kind")).toBe("warning");
    expect(alert.textContent).toContain("Do not merge before the release.");
    expect(alert.textContent).not.toContain("[!WARNING]");
  });

  it("gives a fenced block with a file name a header", () => {
    renderMd("```ts apps/desktop/src/foo.ts\nconst a = 1;\n```");
    expect(screen.getByTestId("pr-md-code-file").textContent).toContain("apps/desktop/src/foo.ts");
  });

  it("resolves only unambiguous files", () => {
    expect(resolveInlineFile("model-manifest.json", env.prFiles)?.inPr).toBe(true);
    expect(resolveInlineFile("docs/guide.md", env.prFiles)).toEqual({ path: "docs/guide.md", line: null, inPr: false });
    expect(resolveInlineFile("~/.ade/model-manifest.json", env.prFiles)).toBeNull();
    expect(resolveInlineFile("claude-opus-5-5", env.prFiles)).toBeNull();
  });
});

describe("buildDigestTimelineModel", () => {
  const push = (id: string, sha: string, timestamp: string, forcePushed = false): PrTimelineEvent => ({
    id, type: "commit_push", timestamp, author: "dev", avatarUrl: null, sha, shortSha: sha.slice(0, 7), subject: `commit ${sha}`, commitCount: 1, forcePushed,
  });
  const comment = (id: string, author: string, timestamp: string, isBot: boolean): PrTimelineEvent => ({
    id, type: "issue_comment", timestamp, author, avatarUrl: null, commentId: id, body: "hi", isBot,
  });

  it("joins back-to-back commits into one push, splits on conversation and on force-push", () => {
    const model = buildDigestTimelineModel([
      push("c1", "aaaaaaa1", "2026-01-01T00:00:00Z"),
      push("c2", "bbbbbbb2", "2026-01-01T01:00:00Z"),
      comment("k1", "vercel[bot]", "2026-01-01T02:00:00Z", true),
      push("c3", "ccccccc3", "2026-01-01T03:00:00Z"),
      push("f1", "ddddddd4", "2026-01-01T04:00:00Z", true),
    ]);
    expect(model.ticks.map((tick) => [tick.id, tick.commitCount])).toEqual([["c1", 2], ["c3", 1], ["f1", 1]]);
    expect(model.items.map((item) => item.kind)).toEqual(["push", "bot-group", "push", "push"]);
  });

  it("keeps people as full rows and lifecycle events in their section", () => {
    const model = buildDigestTimelineModel([
      push("c1", "aaaaaaa1", "2026-01-01T00:00:00Z"),
      comment("h1", "octocat", "2026-01-01T01:00:00Z", false),
      { id: "l1", type: "label_change", timestamp: "2026-01-01T02:00:00Z", author: "octocat", avatarUrl: null, action: "added", label: "bug", color: null },
    ]);
    expect(model.items.map((item) => (item.kind === "event" ? item.event.id : item.kind))).toEqual(["push", "h1", "l1"]);
  });
});

function reviewFixture(reviewer: string, state: PrReview["state"], submittedAt: string | null): PrReview {
  return { reviewer, reviewerAvatarUrl: null, state, body: null, submittedAt };
}

describe("collectPrReviewers", () => {
  it("shows a dismissed approval as dismissed, not approved — the same rule as the Merge card", () => {
    const entries = collectPrReviewers(null, [
      reviewFixture("octocat", "approved", "2026-01-02T00:00:00Z"),
      reviewFixture("octocat", "dismissed", "2026-01-03T00:00:00Z"),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe("dismissed");
  });

  it("keeps an opinion over later comments, and shows commented for a comment-only reviewer", () => {
    const entries = collectPrReviewers(null, [
      reviewFixture("octocat", "changes_requested", "2026-01-02T00:00:00Z"),
      reviewFixture("octocat", "commented", "2026-01-03T00:00:00Z"),
      reviewFixture("hubot", "commented", "2026-01-03T00:00:00Z"),
    ]);
    const byLogin = new Map(entries.map((entry) => [entry.login, entry.state]));
    expect(byLogin.get("octocat")).toBe("changes_requested");
    expect(byLogin.get("hubot")).toBe("commented");
  });

  it("merges a requested bot with its review by normalized login, and survives undated reviews", () => {
    const detail = {
      requestedReviewers: [{ login: "CodeRabbitAI[bot]", avatarUrl: null, isBot: true }],
    } as unknown as PrDetail;
    const entries = collectPrReviewers(detail, [
      reviewFixture("coderabbitai", "approved", null),
      reviewFixture("alice", "approved", "2026-01-02T00:00:00Z"),
    ]);
    expect(entries.map((entry) => entry.login)).toEqual(["CodeRabbitAI[bot]", "alice"]);
    expect(entries[0]!.state).toBe("approved");
    expect(entries[0]!.requested).toBe(true);
  });
});

describe("PrCommentCard", () => {
  const pr = { state: "open", repoOwner: "acme", repoName: "repo" } as PrWithConflicts;

  it("keeps the review draft on submit so a rejected review can be sent again", () => {
    const setDraft = vi.fn();
    const onSubmitReview = vi.fn();
    render(
      <PrCommentCard
        pr={pr}
        draft="Looks good"
        setDraft={setDraft}
        busy={false}
        onComment={() => {}}
        onSubmitReview={onSubmitReview}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "review" }));
    fireEvent.click(screen.getByTestId("pr-comment-card-send"));
    expect(onSubmitReview).toHaveBeenCalledWith("APPROVE", "Looks good");
    expect(setDraft).not.toHaveBeenCalledWith("");
  });
});

function mergedPr(overrides: Partial<PrWithConflicts> = {}): PrWithConflicts {
  return {
    id: "pr-1",
    state: "merged",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as PrWithConflicts;
}

describe("PrShippedSummary", () => {
  it("records how a merged PR shipped, including the lane it outlived", () => {
    render(
      <PrShippedSummary
        pr={mergedPr({
          mergedAt: "2026-01-03T04:00:00.000Z",
          mergedBy: { login: "arul", avatarUrl: null },
          commitCount: 12,
          changedFiles: 9,
          detached: {
            at: "2026-01-04T00:00:00.000Z",
            laneName: "auto-naming",
            laneColor: "#4ADE80",
            chats: 3,
            artifacts: 2,
            checkpoints: 5,
          },
        })}
      />,
    );

    const summary = screen.getByTestId("pr-shipped-summary");
    // Attribution: who merged it, and when.
    expect(summary.textContent).toContain("arul");
    expect(summary.textContent).toContain(formatTimestampShort("2026-01-03T04:00:00.000Z"));
    // Figures: each fact keeps its own value + noun rather than a run-on line.
    expect(summary.textContent).toContain("12 commits");
    expect(summary.textContent).toContain("9 files");
    expect(summary.textContent).toContain("2d 4h open");
    // The lane is gone, but what happened in it is not — and it is marked as ADE's.
    const lane = screen.getByTestId("pr-shipped-lane");
    expect(lane.textContent).toContain("ADE lane");
    expect(lane.textContent).toContain("auto-naming");
    expect(lane.textContent).toContain("3 chats · 2 proof");
  });

  it("omits shipped facts that were never recorded rather than showing blanks", () => {
    render(<PrShippedSummary pr={mergedPr({ mergedAt: null })} />);
    expect(screen.queryByTestId("pr-shipped-summary")).toBeNull();
  });
});

describe("prFailingCheckNames", () => {
  it("names every check the pipeline counts as failed, and nothing it does not", () => {
    const names = prFailingCheckNames([
      { name: "lint", displayName: "Lint", status: "completed", conclusion: "failure" },
      { name: "e2e", status: "completed", conclusion: "cancelled" },
      { name: "deploy", status: "completed", conclusion: "action_required" },
      { name: "build", status: "completed", conclusion: "success" },
      { name: "docs", status: "completed", conclusion: "skipped" },
      { name: "unit", status: "in_progress", conclusion: null },
    ]);
    expect(names).toEqual(["Lint", "e2e", "deploy"]);
  });
});

describe("prOpenFindings", () => {
  it("keeps unresolved, current threads and points at their first comment", () => {
    const thread = (id: string, patch: Partial<PrReviewThread>): PrReviewThread => ({
      id,
      isResolved: false,
      isOutdated: false,
      path: "src/a.ts",
      line: null,
      originalLine: 7,
      url: `https://example.test/${id}`,
      comments: [{ author: "devin", body: "Fix this" }],
      ...patch,
    }) as PrReviewThread;
    const findings = prOpenFindings([
      thread("open", {}),
      thread("resolved", { isResolved: true }),
      thread("outdated", { isOutdated: true }),
    ]);
    expect(findings).toEqual([
      { author: "devin", path: "src/a.ts", line: 7, body: "Fix this", url: "https://example.test/open" },
    ]);
  });
});
