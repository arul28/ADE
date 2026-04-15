// @vitest-environment jsdom

import { createRef } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PrReviewThread } from "../../../../shared/types";
import { PrReviewThreadCard, type PrReviewThreadCardHandle } from "./PrReviewThreadCard";

vi.mock("../../chat/CodeHighlighter.tsx", () => ({
  HighlightedCode: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function makeThread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "src/foo.ts",
    line: 42,
    originalLine: 42,
    startLine: null,
    originalStartLine: null,
    diffSide: "RIGHT",
    url: null,
    createdAt: "2026-04-14T10:00:00.000Z",
    updatedAt: "2026-04-14T10:00:00.000Z",
    comments: [
      {
        id: "comment-1",
        author: "reviewer",
        authorAvatarUrl: null,
        body: "Please tighten this logic.",
        url: null,
        createdAt: "2026-04-14T10:00:00.000Z",
        updatedAt: null,
      },
    ],
    ...overrides,
  };
}

const BASE_PROPS = {
  prId: "pr-1",
  laneId: "lane-1",
  repoOwner: "acme",
  repoName: "ade",
  viewerLogin: "octocat",
  modelId: "claude-opus-4-6",
};

let postReviewComment: ReturnType<typeof vi.fn>;
let setReviewThreadResolved: ReturnType<typeof vi.fn>;
let reactToComment: ReturnType<typeof vi.fn>;
let launchIssueResolutionFromThread: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockNavigate.mockClear();
  postReviewComment = vi.fn().mockResolvedValue({ id: "new-comment", author: "octocat" });
  setReviewThreadResolved = vi
    .fn()
    .mockImplementation(async ({ resolved }: { resolved: boolean }) => ({ threadId: "thread-1", isResolved: resolved }));
  reactToComment = vi.fn().mockResolvedValue(undefined);
  launchIssueResolutionFromThread = vi
    .fn()
    .mockResolvedValue({ sessionId: "s-1", laneId: "lane-1", href: "/work?laneId=lane-1" });

  (window as unknown as { ade?: unknown }).ade = {
    app: { openExternal: vi.fn() },
    prs: {
      postReviewComment,
      setReviewThreadResolved,
      reactToComment,
      launchIssueResolutionFromThread,
    },
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

function renderCard(overrides: Partial<PrReviewThread> = {}, extraProps: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <PrReviewThreadCard thread={makeThread(overrides)} {...BASE_PROPS} {...extraProps} />
    </MemoryRouter>,
  );
}

describe("PrReviewThreadCard", () => {
  it("renders expanded by default when unresolved and not outdated", () => {
    renderCard();
    expect(screen.getByText(/please tighten this logic/i)).toBeTruthy();
    expect(screen.getByText(/src\/foo\.ts:42/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /resolve/i })).toBeTruthy();
  });

  it("collapses resolved threads behind a one-line summary", () => {
    const { container } = renderCard({ isResolved: true });
    const card = container.querySelector("[data-pr-review-thread-card]");
    expect(card?.getAttribute("data-expanded")).toBe("false");
    expect(screen.getByText(/Resolved/)).toBeTruthy();
    expect(screen.getByText(/1 comment/)).toBeTruthy();
  });

  it("expands collapsed summary when clicked", () => {
    const { container } = renderCard({ isResolved: true });
    const card = container.querySelector("[data-pr-review-thread-card]") as HTMLElement;
    fireEvent.click(card);
    expect(card.getAttribute("data-expanded")).toBe("true");
  });

  it("posts a reply via IPC and clears the textarea", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: /^reply$/i }));
    const textarea = screen.getByPlaceholderText(/reply as @octocat/i);
    await user.type(textarea, "ack — will fix");
    await user.click(screen.getByRole("button", { name: /post reply/i }));

    await waitFor(() => {
      expect(postReviewComment).toHaveBeenCalledWith({
        prId: "pr-1",
        threadId: "thread-1",
        body: "ack — will fix",
      });
    });
  });

  it("toggles resolve state via setReviewThreadResolved", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /^resolve$/i }));
    await waitFor(() => {
      expect(setReviewThreadResolved).toHaveBeenCalledWith({
        prId: "pr-1",
        threadId: "thread-1",
        resolved: true,
      });
    });
    expect(await screen.findByRole("button", { name: /unresolve/i })).toBeTruthy();
  });

  it("navigates to /files with diff state when View file diff clicked", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /view file diff/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/files", {
      state: { openFilePath: "src/foo.ts", laneId: "lane-1", mode: "diff", startLine: 42 },
    });
  });

  it("launches issue resolution with modelId and navigates to returned href", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /ask ai to fix/i }));
    await waitFor(() => {
      expect(launchIssueResolutionFromThread).toHaveBeenCalledWith(
        expect.objectContaining({
          prId: "pr-1",
          threadId: "thread-1",
          modelId: "claude-opus-4-6",
          fileContext: expect.objectContaining({ path: "src/foo.ts", line: 42 }),
        }),
      );
      expect(mockNavigate).toHaveBeenCalledWith("/work?laneId=lane-1");
    });
  });

  it("responds to 'r' by opening reply, and 'x' by toggling resolve", async () => {
    const { container } = renderCard();
    const card = container.querySelector("[data-pr-review-thread-card]") as HTMLElement;

    fireEvent.keyDown(card, { key: "r" });
    expect(screen.getByPlaceholderText(/reply as @octocat/i)).toBeTruthy();

    fireEvent.keyDown(card, { key: "x" });
    await waitFor(() => {
      expect(setReviewThreadResolved).toHaveBeenCalled();
    });
  });

  it("delegates ] and n to onNext", () => {
    const onNext = vi.fn();
    const { container } = renderCard({}, { onNext });
    const card = container.querySelector("[data-pr-review-thread-card]") as HTMLElement;
    fireEvent.keyDown(card, { key: "]" });
    fireEvent.keyDown(card, { key: "n" });
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it("exposes focus() via imperative handle", () => {
    const ref = createRef<PrReviewThreadCardHandle>();
    render(
      <MemoryRouter>
        <PrReviewThreadCard ref={ref} thread={makeThread()} {...BASE_PROPS} />
      </MemoryRouter>,
    );
    expect(ref.current).toBeTruthy();
    expect(typeof ref.current?.focus).toBe("function");
    ref.current?.focus();
    const card = document.querySelector("[data-pr-review-thread-card]");
    expect(document.activeElement).toBe(card);
  });

  it("sends a reaction via reactToComment", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /add reaction/i }));
    await user.click(screen.getByRole("button", { name: /react \+1/i }));
    await waitFor(() => {
      expect(reactToComment).toHaveBeenCalledWith({
        prId: "pr-1",
        commentId: "comment-1",
        content: "+1",
      });
    });
  });

  it("renders a focus ring when focused is true", () => {
    const { container } = renderCard({}, { focused: true });
    const card = container.querySelector("[data-pr-review-thread-card]") as HTMLElement;
    expect(card.style.outline).toContain("2px solid");
  });
});
