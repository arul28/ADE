/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CenteredWorkSurfaceHeader, WorkSurfaceHeader } from "./WorkSurfaceHeader";
import { setSessionMetadataGenerating } from "../../state/sessionMetadataGeneratingStore";

vi.mock("../chat/ChatGitToolbar", () => ({
  ChatGitToolbar: ({ laneId }: { laneId: string }) => (
    <div data-testid="chat-git-toolbar" data-lane-id={laneId} />
  ),
}));

vi.mock("../terminals/LaneChip", () => ({
  LaneChip: ({ laneName, onClick }: { laneName: string; onClick?: () => void }) => (
    <button data-testid="lane-chip" onClick={onClick}>
      {laneName}
    </button>
  ),
}));

vi.mock("../shared/ClaudeCacheTtlBadge", () => ({
  ClaudeCacheTtlBadge: ({ idleSinceAt }: { idleSinceAt: string | null }) => (
    <span data-testid="cache-badge" data-idle-since={idleSinceAt ?? "null"} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSessionMetadataGenerating("sess-header", null);
});

describe("WorkSurfaceHeader", () => {
  it("renders the title and skips lane chip / git toolbar / cache badge when their flags are off", () => {
    render(<WorkSurfaceHeader title="Some surface" />);
    expect(screen.getByText("Some surface")).toBeTruthy();
    expect(screen.queryByTestId("lane-chip")).toBeNull();
    expect(screen.queryByTestId("chat-git-toolbar")).toBeNull();
    expect(screen.queryByTestId("cache-badge")).toBeNull();
  });

  it("renders lane chip when showLaneChip + laneId + laneChipName are all provided", () => {
    const onLaneChipClick = vi.fn();
    render(
      <WorkSurfaceHeader
        title="Chat A"
        laneId="lane-1"
        laneChipName="fix-login"
        showLaneChip
        onLaneChipClick={onLaneChipClick}
      />,
    );
    const chip = screen.getByTestId("lane-chip");
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe("fix-login");
    fireEvent.click(chip);
    expect(onLaneChipClick).toHaveBeenCalledTimes(1);
  });

  it("renders the git toolbar when showGitToolbar + laneId are set", () => {
    render(<WorkSurfaceHeader title="Chat" laneId="lane-9" showGitToolbar />);
    const toolbar = screen.getByTestId("chat-git-toolbar");
    expect(toolbar.getAttribute("data-lane-id")).toBe("lane-9");
  });

  it("renders the cache badge when showCacheBadge is true", () => {
    render(
      <WorkSurfaceHeader
        title="Claude chat"
        showCacheBadge
        cacheIdleSinceAt="2026-05-27T12:00:00Z"
      />,
    );
    const badge = screen.getByTestId("cache-badge");
    expect(badge.getAttribute("data-idle-since")).toBe("2026-05-27T12:00:00Z");
  });

  it("renders trailing actions on the right side", () => {
    render(
      <WorkSurfaceHeader
        title="Chat"
        trailingActions={<button data-testid="trail">Run</button>}
      />,
    );
    expect(screen.getByTestId("trail")).toBeTruthy();
  });

  it("applies a custom data-testid when passed", () => {
    render(<WorkSurfaceHeader title="X" testId="work-surface-header-cli" />);
    expect(screen.getByTestId("work-surface-header-cli")).toBeTruthy();
  });

  it("shows a provider title after a real title arrives", () => {
    const { rerender } = render(<WorkSurfaceHeader title="Claude Chat" />);
    expect(screen.getByText("Claude Chat")).toBeTruthy();

    rerender(<WorkSurfaceHeader title="Fix the login redirect" />);
    expect(screen.getByText("Fix the login redirect")).toBeTruthy();
    expect(screen.queryByText("Claude Chat")).toBeNull();
  });

  it("masks the title with the naming shimmer while metadata regenerates", () => {
    setSessionMetadataGenerating("sess-header", {
      fields: ["title"],
      laneId: "lane-1",
    });
    render(
      <WorkSurfaceHeader
        title="Stop Haiku default"
        lifecycleSessionId="sess-header"
      />,
    );
    expect(screen.getByLabelText("Naming chat…")).toBeTruthy();
    expect(screen.getByText("Naming chat").closest("[data-title-generating]")?.getAttribute("data-title-generating")).toBe("true");
    expect(screen.queryByText("Stop Haiku default")).toBeNull();
  });

  it("shows the updated title when metadata regeneration finishes", () => {
    setSessionMetadataGenerating("sess-header", {
      fields: ["title"],
      laneId: "lane-1",
    });
    const { rerender } = render(
      <WorkSurfaceHeader
        title="Stop Haiku default"
        lifecycleSessionId="sess-header"
      />,
    );
    act(() => {
      setSessionMetadataGenerating("sess-header", null);
      rerender(
        <WorkSurfaceHeader
          title="Skip first available model"
          lifecycleSessionId="sess-header"
        />,
      );
    });
    expect(screen.getByText("Skip first available model")).toBeTruthy();
    expect(screen.queryByText("Stop Haiku default")).toBeNull();
  });

  it("renders an optional title accessory after the title", () => {
    render(
      <WorkSurfaceHeader
        title="Cursor Chat"
        titleAccessory={<button type="button">Cursor Cloud</button>}
      />,
    );
    const accessory = screen.getByRole("button", { name: "Cursor Cloud" });
    expect(accessory.previousSibling?.textContent).toBe("Cursor Chat");
  });

  it("calls the Tools pane toggle action", () => {
    const onToggle = vi.fn();
    render(
      <WorkSurfaceHeader
        title="Chat"
        onToggleToolsPane={onToggle}
        toolsPaneOpen={false}
      />,
    );
    const button = screen.getByRole("button", { name: "Open Tools pane" });
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("centered header puts the git toolbar in the right cluster, next to the tools toggle", () => {
    render(
      <CenteredWorkSurfaceHeader
        title="Centered chat"
        laneId="lane-2"
        showGitToolbar
        onToggleToolsPane={() => {}}
        testId="centered-header"
      />,
    );
    expect(screen.getByText("Centered chat")).toBeTruthy();
    // The chat header is plain; only the top bar carries the window gradient.
    expect(document.querySelector("[data-backdrop]")).toBeNull();
    expect(screen.queryByTestId("lane-chip")).toBeNull();
    const toolbar = screen.getByTestId("chat-git-toolbar");
    const toggle = screen.getByRole("button", { name: "Open Tools pane" });
    expect(toolbar.parentElement).toBe(toggle.parentElement);
  });
});
