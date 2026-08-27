// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PrTimelineEvent } from "../../../../shared/types/prs";
import { DescriptionContent } from "./PrTimelineCommentCards";

vi.mock("./PrMarkdown", () => ({
  PrMarkdown: ({ children }: { children: string }) => <div data-testid="pr-markdown">{children}</div>,
}));

let reactToComment: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reactToComment = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { ade?: unknown }).ade = {
    prs: { reactToComment },
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

const DESCRIPTION: Extract<PrTimelineEvent, { type: "description" }> = {
  id: "desc-1",
  type: "description",
  timestamp: "2026-01-01T00:00:00.000Z",
  author: "octocat",
  avatarUrl: null,
  body: "PR body",
  subjectId: "PR_1",
  reactions: [],
};

describe("DescriptionContent", () => {
  it("surfaces a rejected description reaction", async () => {
    const user = userEvent.setup();
    reactToComment.mockRejectedValue(new Error("reaction denied"));
    render(
      <DescriptionContent
        event={DESCRIPTION}
        prId="pr-1"
        viewerLogin="octocat"
        repoOwner="acme"
        repoName="ade"
      />,
    );

    await user.click(screen.getByRole("button", { name: /add reaction/i }));
    await user.click(screen.getByRole("button", { name: /react \+1/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("reaction denied");
    });
  });
});
