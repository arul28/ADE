/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkSurfaceHeader } from "./WorkSurfaceHeader";

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
});

describe("WorkSurfaceHeader", () => {
  it("uses the canonical 32px work-surface rail", () => {
    render(<WorkSurfaceHeader title="Some surface" testId="surface-header" />);
    const header = screen.getByTestId("surface-header");
    expect(header.className).toContain("h-8");
    expect(header.firstElementChild?.className).toContain("w-full");
  });

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

  it("shimmers the title when it lands from a provider default to a real title", () => {
    const { rerender } = render(<WorkSurfaceHeader title="Claude Chat" />);
    const initial = screen.getByText("Claude Chat");
    expect(initial.getAttribute("data-title-landed")).toBeNull();

    rerender(<WorkSurfaceHeader title="Fix the login redirect" />);
    const landed = screen.getByText("Fix the login redirect");
    expect(landed.getAttribute("data-title-landed")).toBe("true");
    expect(landed.className).toContain("ade-title-landed");

    fireEvent.animationEnd(landed);
    expect(landed.getAttribute("data-title-landed")).toBeNull();
    expect(landed.className).not.toContain("ade-title-landed");
    expect(landed.className).toContain("text-white");
  });

  it("keeps a landed title plain when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const { rerender } = render(<WorkSurfaceHeader title="Claude Chat" />);

    rerender(<WorkSurfaceHeader title="Fix the login redirect" />);

    const title = screen.getByText("Fix the login redirect");
    expect(title.getAttribute("data-title-landed")).toBeNull();
    expect(title.className).not.toContain("ade-title-landed");
    expect(title.className).toContain("text-white");
  });

  it("does not shimmer when the title changes between two real titles", () => {
    const { rerender } = render(<WorkSurfaceHeader title="Fix the login redirect" />);
    rerender(<WorkSurfaceHeader title="Fix the logout redirect" />);
    const el = screen.getByText("Fix the logout redirect");
    expect(el.getAttribute("data-title-landed")).toBeNull();
  });
});
