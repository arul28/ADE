// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PrRebaseBanner } from "./PrRebaseBanner";
import type { RebaseNeed } from "../../../shared/types";

afterEach(() => {
  cleanup();
  delete (window as any).ade;
});

function makeNeed(overrides: Partial<RebaseNeed> = {}): RebaseNeed {
  return {
    laneId: "lane-1",
    laneName: "Lane 1",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 2,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: null,
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
    ...overrides,
  };
}

describe("PrRebaseBanner", () => {
  it("reports rebase failures instead of swallowing them", async () => {
    (window as any).ade = {
      rebase: {
        execute: vi.fn(async () => {
          throw new Error("rebase failed");
        }),
        dismiss: vi.fn(),
      },
    };

    render(
      <PrRebaseBanner
        laneId="lane-1"
        rebaseNeeds={[makeNeed()]}
        onTabChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /REBASE NOW/i }));

    expect(await screen.findByText("rebase failed")).toBeTruthy();
  });

  it("refreshes after a successful banner rebase", async () => {
    const onRefresh = vi.fn(async () => undefined);
    const onRebaseDone = vi.fn(async () => undefined);
    (window as any).ade = {
      rebase: {
        execute: vi.fn(async () => undefined),
        dismiss: vi.fn(),
      },
    };

    render(
      <PrRebaseBanner
        laneId="lane-1"
        rebaseNeeds={[makeNeed()]}
        onTabChange={() => {}}
        onRefresh={onRefresh}
        onRebaseDone={onRebaseDone}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /REBASE NOW/i }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(onRebaseDone).toHaveBeenCalledTimes(1);
  });
});
