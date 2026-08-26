// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PrReactionBar } from "./PrReactionBar";

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

describe("PrReactionBar", () => {
  it("keeps a sibling optimistic chip when a concurrent reaction fails", async () => {
    const user = userEvent.setup();
    let rejectFirst: ((error: Error) => void) | undefined;
    let resolveSecond: ((value?: unknown) => void) | undefined;
    reactToComment
      .mockImplementationOnce(() => new Promise((_, reject) => {
        rejectFirst = reject;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecond = resolve;
      }));

    render(
      <PrReactionBar
        prId="pr-1"
        subjectId="IC_1"
        viewerLogin="octocat"
        reactions={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add reaction/i }));
    await user.click(screen.getByRole("button", { name: /react \+1/i }));
    await user.click(screen.getByRole("button", { name: /add reaction/i }));
    await user.click(screen.getByRole("button", { name: /react heart/i }));

    expect(screen.getByRole("button", { name: /react \+1/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /react heart/i })).toBeTruthy();

    rejectFirst?.(new Error("reaction denied"));
    resolveSecond?.();

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /react \+1/i })).toBeNull();
    });
    expect(screen.getByRole("button", { name: /react heart/i })).toBeTruthy();
  });
});
