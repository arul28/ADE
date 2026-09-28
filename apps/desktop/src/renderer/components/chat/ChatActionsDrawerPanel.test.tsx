/* @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_ACTIONS_DRAWER_EMPTY_COPY, ChatActionsDrawerPanel } from "./ChatActionsDrawerPanel";
import { ChatSubagentsPanel } from "./ChatSubagentsPanel";
import { MissionControlPanel } from "./MissionControlPanel";

afterEach(cleanup);

/** The regions a section actually occupies, i.e. every non-empty one. */
function visibleRegions(): HTMLElement[] {
  return screen.queryAllByTestId("chat-actions-drawer-region")
    .filter((region) => !region.className.split(/\s+/).includes("hidden"));
}

function emptyLineShowing(): boolean {
  const line = screen.getByTestId("chat-actions-drawer-empty");
  // Plain when no section was passed; otherwise `hidden only:block`, which
  // shows only while it is the sole child left.
  return !line.className.split(/\s+/).includes("hidden") || line.matches(":only-child");
}

describe("ChatActionsDrawerPanel", () => {
  it("gives each present section its own region, in order, with a divider between siblings", () => {
    render(
      <ChatActionsDrawerPanel
        sections={[
          { key: "agents", content: <div>Agents body</div> },
          { key: "proof", content: <div>Proof body</div> },
          { key: "sources", content: <div>Sources body</div> },
        ]}
      />,
    );

    const agents = screen.getByText("Agents body");
    const proof = screen.getByText("Proof body");
    const sources = screen.getByText("Sources body");
    expect(agents.compareDocumentPosition(proof) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(proof.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const regions = visibleRegions();
    expect(regions).toHaveLength(3);
    expect(regions[0]!.className).not.toContain("border-t");
    expect(regions[1]!.className).toContain("border-t");
    expect(regions[2]!.className).toContain("border-t");
    expect(emptyLineShowing()).toBe(false);
    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Proof" })).toBeNull();
  });

  it("with only proof, shows only the proof region and no agents box", () => {
    render(
      <ChatActionsDrawerPanel
        sections={[
          { key: "agents", content: <ChatSubagentsPanel snapshots={[]} events={[]} variant="pane" /> },
          { key: "proof", content: <div data-testid="proof-section">Proof body</div> },
          false,
          null,
        ]}
      />,
    );

    const regions = visibleRegions();
    expect(regions).toHaveLength(1);
    expect(within(regions[0]!).getByTestId("proof-section")).toBeTruthy();
    expect(screen.queryByTestId("chat-subagents-pane")).toBeNull();
    expect(screen.queryByText(/No agent activity|Single-agent|No sources yet/i)).toBeNull();
    expect(emptyLineShowing()).toBe(false);
  });

  it("with only tasks, shows just the agents panel region", () => {
    render(
      <ChatActionsDrawerPanel
        sections={[
          {
            key: "agents",
            content: (
              <ChatSubagentsPanel
                snapshots={[]}
                events={[]}
                variant="pane"
                taskList={{ source: "todo", label: "Tasks", turnId: null, items: [{ id: "todo-1", label: "Wire the drawer", status: "running" }] }}
              />
            ),
          },
          false,
        ]}
      />,
    );

    const regions = visibleRegions();
    expect(regions).toHaveLength(1);
    expect(within(regions[0]!).getByTestId("chat-subagents-pane")).toBeTruthy();
    expect(screen.getByText("Wire the drawer")).toBeTruthy();
    expect(emptyLineShowing()).toBe(false);
  });

  it("shows one short line when no section was passed", () => {
    render(<ChatActionsDrawerPanel sections={[false, null, undefined]} />);

    expect(visibleRegions()).toHaveLength(0);
    expect(screen.getByText(CHAT_ACTIONS_DRAWER_EMPTY_COPY)).toBeTruthy();
    expect(emptyLineShowing()).toBe(true);
  });

  it("shows the line when every passed section renders nothing", () => {
    render(
      <ChatActionsDrawerPanel
        sections={[{ key: "agents", content: <ChatSubagentsPanel snapshots={[]} events={[]} variant="pane" /> }]}
      />,
    );

    expect(visibleRegions()).toHaveLength(0);
    expect(emptyLineShowing()).toBe(true);
  });

  it("scrolls each section inside its own region, under the one drawer scroll", () => {
    render(
      <ChatActionsDrawerPanel
        sections={[
          {
            key: "agents",
            content: (
              <ChatSubagentsPanel
                snapshots={[]}
                events={[]}
                variant="pane"
                taskList={{ source: "todo", label: "Tasks", turnId: null, items: [{ id: "todo-1", label: "Wire the drawer", status: "pending" }] }}
              />
            ),
          },
          { key: "proof", content: <div className="px-4 py-3">Proof body</div> },
        ]}
      />,
    );

    expect(screen.getByTestId("chat-actions-drawer-scroll").className).toContain("overflow-y-auto");
    const regions = visibleRegions();
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region.querySelector("[class*='overflow-y-auto']")).toBeTruthy();
    }
  });
});

describe("MissionControlPanel", () => {
  it("has no Features placeholder before Droid proposes features", () => {
    render(
      <MissionControlPanel
        mission={{
          state: "running",
          features: [],
          progress: [{ timestamp: "2026-09-23T00:00:00.000Z", type: "worker_started", text: "Worker up" }],
        }}
      />,
    );

    expect(screen.queryByText(/No features yet/i)).toBeNull();
    expect(screen.queryByText("Features")).toBeNull();
  });
});
