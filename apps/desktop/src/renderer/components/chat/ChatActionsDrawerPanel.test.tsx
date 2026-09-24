/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_ACTIONS_DRAWER_EMPTY_COPY, ChatActionsDrawerPanel } from "./ChatActionsDrawerPanel";
import { ChatSubagentsPanel } from "./ChatSubagentsPanel";
import { MissionControlPanel } from "./MissionControlPanel";

afterEach(cleanup);

function sectionsRoot(): HTMLElement {
  return screen.getByTestId("chat-actions-drawer-sections");
}

/** Real sections, i.e. every drawer child except the empty line. */
function renderedSections(): Element[] {
  return [...sectionsRoot().children].filter((child) => child.getAttribute("data-testid") !== "chat-actions-drawer-empty");
}

function emptyLineShowing(): boolean {
  const line = screen.getByTestId("chat-actions-drawer-empty");
  // Plain when no section was passed; otherwise `hidden only:block`, which
  // shows only while it is the sole child left.
  return !line.className.split(/\s+/).includes("hidden") || line.matches(":only-child");
}

describe("ChatActionsDrawerPanel", () => {
  it("stacks sections in order in one scroll with dividers only between siblings", () => {
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
    expect(sectionsRoot().className).toContain("[&>*+*]:border-t");
    expect(emptyLineShowing()).toBe(false);
    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Proof" })).toBeNull();
  });

  it("with only proof, shows proof at the top and no agents or sources box", () => {
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

    expect(renderedSections().map((el) => el.getAttribute("data-testid"))).toEqual(["proof-section"]);
    expect(sectionsRoot().firstElementChild?.getAttribute("data-testid")).toBe("proof-section");
    expect(screen.queryByTestId("chat-subagents-pane")).toBeNull();
    expect(screen.queryByText(/No agent activity|Single-agent|No sources yet/i)).toBeNull();
    expect(emptyLineShowing()).toBe(false);
  });

  it("with only tasks, shows just the agents panel section", () => {
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

    expect(renderedSections().map((el) => el.getAttribute("data-testid"))).toEqual(["chat-subagents-pane"]);
    expect(screen.getByText("Wire the drawer")).toBeTruthy();
    expect(emptyLineShowing()).toBe(false);
  });

  it("shows one short line when no section was passed", () => {
    render(<ChatActionsDrawerPanel sections={[false, null, undefined]} />);

    expect(renderedSections()).toHaveLength(0);
    expect(screen.getByText(CHAT_ACTIONS_DRAWER_EMPTY_COPY)).toBeTruthy();
    expect(emptyLineShowing()).toBe(true);
  });

  it("shows the line when every passed section renders nothing", () => {
    render(
      <ChatActionsDrawerPanel
        sections={[{ key: "agents", content: <ChatSubagentsPanel snapshots={[]} events={[]} variant="pane" /> }]}
      />,
    );

    expect(renderedSections()).toHaveLength(0);
    expect(emptyLineShowing()).toBe(true);
  });

  it("owns the only scroll: no nested scroller or full-height box inside", () => {
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

    expect(screen.getByTestId("chat-actions-drawer-scroll").className).toContain("overflow-auto");
    expect(sectionsRoot().querySelector("[class*='overflow-y-auto'], [class*='overflow-auto'], [class*='min-h-full'], .h-full")).toBeNull();
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
