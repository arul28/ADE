/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorCloudInlineLaunch } from "./CursorCloudInlineLaunch";

const originalAde = globalThis.window.ade;

function installAdeMocks() {
  globalThis.window.ade = {
    ai: {
      cursorCloudListRepositories: vi.fn().mockResolvedValue([
        { url: "https://github.com/acme/project.git", name: "project" },
      ]),
      cursorCloudCreateRun: vi.fn().mockResolvedValue({
        agent: { agentId: "agent-1" },
      }),
    },
    git: {
      listBranches: vi.fn().mockResolvedValue([
        { name: "main", isRemote: false },
        { name: "feature/work", isRemote: false },
      ]),
      getOpenPrForBranch: vi.fn().mockResolvedValue(null),
    },
  } as any;
}

describe("CursorCloudInlineLaunch", () => {
  beforeEach(() => {
    installAdeMocks();
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("cancels Cursor Cloud launch setup without creating a run", async () => {
    const onClose = vi.fn();

    render(
      <CursorCloudInlineLaunch
        cursorModelIds={["cursor/auto"]}
        defaultRepoUrl="https://github.com/acme/project.git"
        defaultBranch="feature/work"
        defaultModelSdkId="auto"
        laneGitRemote="https://github.com/acme/project.git"
        laneId="lane-1"
        onClose={onClose}
      />,
    );

    expect(await screen.findByText("Send to Cursor Cloud")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel cloud send" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.ade.ai.cursorCloudCreateRun).not.toHaveBeenCalled();
  });
});
