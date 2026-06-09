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
      },
      lanes: {
        dismissRebaseSuggestion: vi.fn(),
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
      },
      lanes: {
        dismissRebaseSuggestion: vi.fn(),
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

  it("hides the banner without dismissing the active rebase need", async () => {
    const dismissRebaseSuggestion = vi.fn(async () => undefined);
    const onRefresh = vi.fn(async () => undefined);
    (window as any).ade = {
      rebase: {
        execute: vi.fn(async () => undefined),
        dismiss: vi.fn(),
      },
      lanes: {
        dismissRebaseSuggestion,
      },
    };

    render(
      <PrRebaseBanner
        laneId="lane-1"
        rebaseNeeds={[makeNeed()]}
        onTabChange={() => {}}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /HIDE BANNER/i }));

    await waitFor(() => expect(dismissRebaseSuggestion).toHaveBeenCalledWith({ laneId: "lane-1" }));
    expect((window as any).ade.rebase.dismiss).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/2 commits behind main/i)).toBeNull();
  });
});
