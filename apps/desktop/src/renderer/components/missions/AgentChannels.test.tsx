/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OrchestratorChatThread } from "../../../shared/types";
import { AgentChannels } from "./AgentChannels";

function findButtonByTextContent(matcher: RegExp): HTMLButtonElement {
  const match = screen.getAllByRole("button").find((button) => matcher.test(button.textContent ?? ""));
  if (!match) {
    throw new Error(`Unable to find button matching ${String(matcher)}`);
  }
  return match as HTMLButtonElement;
}

const originalAde = globalThis.window.ade;

const coordinatorThread: OrchestratorChatThread = {
  id: "thread-coordinator",
  missionId: "mission-1",
  threadType: "coordinator",
  title: "Coordinator",
  status: "active",
  unreadCount: 0,
  createdAt: "2026-03-17T10:00:00.000Z",
  updatedAt: "2026-03-17T10:00:00.000Z",
};

beforeEach(() => {
  globalThis.window.ade = {
    ...(originalAde ?? {}),
    orchestrator: {
      ...(originalAde?.orchestrator ?? {}),
      getThreadMessages: vi.fn().mockResolvedValue([
        {
          id: "msg-tool",
          missionId: "mission-1",
          role: "worker",
          content: "Tool call: functions.exec_command",
          timestamp: "2026-03-17T10:00:01.000Z",
          threadId: "thread-coordinator",
          metadata: {
            toolName: "functions.exec_command",
            toolArgs: { cmd: "pwd" },
          },
        },
        {
          id: "msg-file",
          missionId: "mission-1",
          role: "worker",
          content: "diff --git a/apps/desktop/src/foo.ts b/apps/desktop/src/foo.ts\n--- a/apps/desktop/src/foo.ts\n+++ b/apps/desktop/src/foo.ts\n+ const updated = true;\n",
          timestamp: "2026-03-17T10:00:02.000Z",
          threadId: "thread-coordinator",
          metadata: null,
        },
      ]),
      onThreadEvent: vi.fn(() => () => {}),
    },
  } as any;
});

afterEach(() => {
  cleanup();
  if (originalAde === undefined) {
    delete (globalThis.window as any).ade;
  } else {
    globalThis.window.ade = originalAde;
  }
});

describe("AgentChannels", () => {
  it("renders legacy tool and file transcript rows with the compact work-log presentation", async () => {
    render(
      <AgentChannels
        missionId="mission-1"
        threads={[coordinatorThread]}
        onSendMessage={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(globalThis.window.ade.orchestrator.getThreadMessages).toHaveBeenCalled();
    });

    expect(await screen.findByText("Run pwd")).toBeTruthy();
    expect((await waitFor(() => findButtonByTextContent(/foo\.ts/i))).textContent).toContain("Edited");
    expect(screen.queryByText("Tool Call")).toBeNull();
    expect(screen.queryByText("File Edit")).toBeNull();

    fireEvent.click(findButtonByTextContent(/pwd/i));
    fireEvent.click(findButtonByTextContent(/foo\.ts/i));

    const body = document.body.textContent ?? "";
    expect(body).toContain("pwd");
    expect(body).toContain("foo.ts");
  });
});
