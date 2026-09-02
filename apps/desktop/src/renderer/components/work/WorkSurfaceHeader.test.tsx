/* @vitest-environment jsdom */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkSurfaceHeader } from "./WorkSurfaceHeader";
import { pluginSessionContext } from "../plugins/sockets";
import { WorkHeaderToolsToggle } from "./WorkHeaderPaneToggles";
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

const invoked: { action: string; context: unknown }[] = [];

/**
 * Stubbed for the whole file, not for one describe.
 *
 * The socket layer's stores are module-level and settle on the FIRST read: a
 * build with no plugin namespace records "no plugins" and never asks again. A
 * stub installed halfway through the file would therefore be invisible, and the
 * mount test would pass for the wrong reason — which is exactly the class of
 * silent-nothing failure the socket taxonomy keeps producing.
 */
beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        { pluginId: "tipsy", displayName: "Tipsy", enabled: true, accent: null, icon: null, disabledContributions: [] },
      ],
      getManifest: async () => ({
        name: "tipsy",
        version: "1.0.0",
        sockets: [
          { socket: "chat-header-action", surface: "work", id: "drink", label: "Drink", actionId: "takeDrink" },
        ],
      }),
      listContributions: async () => [],
      invoke: async (args: { action: string; args: { context: unknown } }) => {
        invoked.push({ action: args.action, context: args.args.context });
        return {};
      },
    },
  };
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

afterEach(() => {
  invoked.length = 0;
  cleanup();
  vi.unstubAllGlobals();
  setSessionMetadataGenerating("sess-header", null);
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

  /**
   * The mount itself, rather than the socket component in isolation.
   *
   * This header is shared by ADE chats, CLI sessions and grid tiles, which is
   * why `chat-header-action` lives here: one declaration reaches all three. The
   * alpha test's complaint was that a plugin appeared only in a NEW pane, so
   * what has to be proven is that a header handed an existing chat draws it and
   * invokes against that chat.
   */
  it("mounts chat-header-action for the session it is given", async () => {
    render(
      <WorkSurfaceHeader
        title="Refactor the parser"
        pluginSession={pluginSessionContext({ id: "chat-1", title: "Refactor the parser", provider: "claude" })}
      />,
    );

    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("Drink"));
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.action).toBe("takeDrink");
    expect((invoked[0]?.context as { kind: string; id: string })).toMatchObject({
      kind: "session",
      id: "chat-1",
    });
  });

  // A header with no chat — a pane that has not started one — has no subject to
  // hand a plugin, so the socket stays absent rather than invoking against null.
  it("draws no chat-header contribution on a header with no session", async () => {
    render(<WorkSurfaceHeader title="New chat" />);
    // The other socket in this row would draw if anything were going to, so a
    // settled empty render is the real assertion, not an immediate one.
    await waitFor(() => expect(screen.getByText("New chat")).toBeTruthy());
    expect(screen.queryByText("Drink")).toBeNull();
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

  it("shimmers the title when regeneration lands a new name", () => {
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
    const landed = screen.getByText("Skip first available model");
    expect(landed.getAttribute("data-title-landed")).toBe("true");
    expect(landed.className).toContain("ade-title-landed");
  });

  it("does not shimmer the title when regeneration finishes without changing it", () => {
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
          title="Stop Haiku default"
          lifecycleSessionId="sess-header"
        />,
      );
    });
    const title = screen.getByText("Stop Haiku default");
    expect(title.getAttribute("data-title-landed")).toBeNull();
    expect(title.className).not.toContain("ade-title-landed");
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

  it("mirrors the sidebar glyph on the Tools pane toggle", () => {
    const onToggle = vi.fn();
    render(
      <WorkSurfaceHeader
        title="Chat"
        onToggleToolsPane={onToggle}
        toolsPaneOpen={false}
      />,
    );
    const button = screen.getByRole("button", { name: "Open Tools pane" });
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").toContain("-scale-x-100");
    expect(icon?.getAttribute("width")).toBe("16");
    expect(icon?.getAttribute("height")).toBe("16");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps the Tools toggle mirrored while the pane is open", () => {
    render(<WorkHeaderToolsToggle open onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: "Close Tools pane" });
    expect(button.querySelector("svg")?.getAttribute("class") ?? "").toContain("-scale-x-100");
  });
});
