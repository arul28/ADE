/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatActionsDrawerPanel } from "./ChatActionsDrawerPanel";

afterEach(cleanup);

describe("ChatActionsDrawerPanel", () => {
  it("stacks progress, proof, and extra provider sections in one scroll", () => {
    render(
      <ChatActionsDrawerPanel
        agentsContent={<div>Agents body</div>}
        proofContent={<div>Proof body</div>}
        extras={<div>Sources body</div>}
      />,
    );

    const agents = screen.getByText("Agents body");
    const proof = screen.getByText("Proof body");
    const sources = screen.getByText("Sources body");
    expect(agents.compareDocumentPosition(proof) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(proof.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Proof" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Handoff" })).toBeNull();
  });

  it("omits proof when there is nothing to show", () => {
    render(
      <ChatActionsDrawerPanel
        agentsContent={<div>Agents body</div>}
        proofContent={null}
      />,
    );

    expect(screen.getByText("Agents body")).toBeTruthy();
    expect(screen.queryByText("Proof body")).toBeNull();
  });
});
