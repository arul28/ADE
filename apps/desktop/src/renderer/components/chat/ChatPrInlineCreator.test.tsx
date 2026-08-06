/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

// Render motion elements as plain DOM so assertions don't depend on animation
// timing / requestAnimationFrame in jsdom (the error block animates height).
vi.mock("motion/react", () => {
  const ReactLib = require("react");
  const strip = (props: Record<string, unknown>) => {
    const { initial: _i, animate: _a, exit: _e, transition: _t, ...rest } = props;
    return rest;
  };
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        ReactLib.forwardRef((props: Record<string, unknown>, ref: unknown) => {
          const { children, ...rest } = strip(props);
          return ReactLib.createElement(tag, { ...rest, ref }, children as React.ReactNode);
        }),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
  };
});

import { ChatPrInlineCreator } from "./ChatPrInlineCreator";
import { useAppStore } from "../../state/appStore";

const originalAde = (globalThis.window as { ade?: unknown }).ade;

function makeLane(over: Record<string, unknown> = {}) {
  return {
    id: "lane-1",
    name: "PR pane redesign",
    color: "#22c55e",
    laneType: "worktree",
    branchRef: "refs/heads/pr-pane-redesign",
    worktreePath: "/tmp/project/.ade/worktrees/pr-pane-redesign",
    archivedAt: null,
    linearIssue: null,
    ...over,
  };
}

const primaryLane = {
  id: "lane-main",
  name: "Primary",
  color: "#8b5cf6",
  laneType: "primary",
  branchRef: "refs/heads/main",
  worktreePath: "/tmp/project",
  archivedAt: null,
  linearIssue: null,
};

function setLanes(sourceOver: Record<string, unknown> = {}) {
  useAppStore.setState({
    lanes: [makeLane(sourceOver), primaryLane] as any,
  });
}

function installAde(createFromLane?: unknown) {
  (globalThis.window as { ade?: unknown }).ade = {
    prs: {
      createFromLane: createFromLane ?? vi.fn().mockResolvedValue({ id: "pr-1" }),
    },
  };
}

function renderCreator(props: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <ChatPrInlineCreator laneId="lane-1" branchName="pr-pane-redesign" onCreated={() => undefined} {...props} />
    </MemoryRouter>,
  );
}

function titleInput(): HTMLInputElement {
  return screen.getByLabelText("Pull request title") as HTMLInputElement;
}

beforeEach(() => {
  installAde();
  setLanes();
});

afterEach(() => {
  cleanup();
  (globalThis.window as { ade?: unknown }).ade = originalAde;
  vi.clearAllMocks();
});

describe("ChatPrInlineCreator title default", () => {
  it("seeds the PR title from the chat's own title", async () => {
    renderCreator({ sessionTitle: "Redesign the in-chat PR panel" });
    await waitFor(() => expect(titleInput().value).toBe("Redesign the in-chat PR panel"));
  });

  it("falls back to the lane -> target derivation when there is no session title", async () => {
    renderCreator();
    await waitFor(() => expect(titleInput().value).toBe("PR pane redesign -> Primary"));
  });

  it("falls back when the session is still the 'New chat' placeholder", async () => {
    renderCreator({ sessionTitle: "New chat" });
    await waitFor(() => expect(titleInput().value).toBe("PR pane redesign -> Primary"));
  });

  it("keeps a user edit when a real session title arrives late", async () => {
    const { rerender } = render(
      <MemoryRouter>
        <ChatPrInlineCreator laneId="lane-1" branchName="pr-pane-redesign" sessionTitle="New chat" onCreated={() => undefined} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(titleInput().value).toBe("PR pane redesign -> Primary"));

    fireEvent.change(titleInput(), { target: { value: "My hand-written title" } });

    rerender(
      <MemoryRouter>
        <ChatPrInlineCreator laneId="lane-1" branchName="pr-pane-redesign" sessionTitle="Background-renamed chat" onCreated={() => undefined} />
      </MemoryRouter>,
    );

    expect(titleInput().value).toBe("My hand-written title");
  });
});

describe("ChatPrInlineCreator flow layout", () => {
  it("renders no uppercase section labels", () => {
    const { container } = renderCreator();
    for (const label of ["Source lane and branch", "Target lane and branch", "Description", "(optional)"]) {
      expect(container.textContent).not.toContain(label);
    }
    // The old captions were the only uppercase-tracked spans in this form.
    expect(container.querySelectorAll("[class*='uppercase']").length).toBe(0);
  });

  it("shows the source lane, its branch, and a lock glyph", () => {
    const { container } = renderCreator();
    expect(screen.getByTitle("PR pane redesign")).toBeTruthy();
    expect(screen.getByTitle("pr-pane-redesign")).toBeTruthy();
    expect(container.textContent).toContain("pr-pane-redesign");
  });

  it("renders a muted 'comparing…' connector while lane.status is absent", () => {
    renderCreator();
    expect(screen.getByText("comparing…")).toBeTruthy();
  });

  it("renders ahead / behind / clean on the connector once lane.status arrives", async () => {
    setLanes({
      status: { dirty: false, ahead: 3, behind: 1, remoteBehind: 0, rebaseInProgress: false },
    });
    renderCreator();
    expect(await screen.findByText(/3 ahead · 1 behind/)).toBeTruthy();
    expect(screen.getByText("clean")).toBeTruthy();
    expect(screen.queryByText("comparing…")).toBeNull();
  });

  it("marks a dirty lane on the connector", async () => {
    setLanes({
      status: { dirty: true, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    });
    renderCreator();
    expect(await screen.findByText("dirty")).toBeTruthy();
  });
});

describe("ChatPrInlineCreator create", () => {
  it("sends the resolved title, body, and base branch to createFromLane", async () => {
    const createFromLane = vi.fn().mockResolvedValue({ id: "pr-1" });
    installAde(createFromLane);
    const onCreated = vi.fn();
    renderCreator({ sessionTitle: "Redesign the in-chat PR panel", sessionId: "chat-1", onCreated });

    await waitFor(() => expect(titleInput().value).toBe("Redesign the in-chat PR panel"));
    fireEvent.change(screen.getByLabelText("Pull request description"), {
      target: { value: "Flow layout for the inline creator." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create pull request/ }));

    await waitFor(() => expect(createFromLane).toHaveBeenCalledTimes(1));
    expect(createFromLane).toHaveBeenCalledWith({
      laneId: "lane-1",
      title: "Redesign the in-chat PR panel",
      body: "Flow layout for the inline creator.",
      draft: false,
      baseBranch: "main",
      sessionId: "chat-1",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "pr-1" }));
  });

  it("surfaces a create failure and re-enables the button", async () => {
    const createFromLane = vi.fn().mockRejectedValue(
      new Error("Error invoking remote method 'ade.prs.createFromLane': Error: no upstream branch"),
    );
    installAde(createFromLane);
    renderCreator();

    fireEvent.click(screen.getByRole("button", { name: /Create pull request/ }));

    expect(await screen.findByText("no upstream branch")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Create pull request/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
