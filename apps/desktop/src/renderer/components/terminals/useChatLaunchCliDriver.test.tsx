/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatLaunchSnapshot, OpenProjectBinding } from "../../../shared/types";
import {
  applyChatLaunchSnapshot,
  buildOptimisticChatLaunchSnapshot,
  getChatLaunchOriginClientId,
  registerChatLaunchLocalRecord,
  resetChatLaunchStoreForTests,
} from "../../state/chatLaunchStore";
import { resetChatLaunchCliDriverForTests, useChatLaunchCliDriver } from "./useChatLaunchCliDriver";
import type { WorkPtyLaunchArgs, WorkPtyLaunchResult } from "./cliLaunch";

const BINDING: OpenProjectBinding = { kind: "local", key: "local:/p", rootPath: "/p", displayName: "p" };

function cliLaunch(overrides: Partial<ChatLaunchSnapshot> = {}): ChatLaunchSnapshot {
  return {
    ...buildOptimisticChatLaunchSnapshot({
      launch: {
        kind: "cli",
        mode: "foreground",
        launchId: "cli-launch-1",
        laneId: "lane-new",
        laneName: "Fix Flaky Test",
        prompt: "Fix the flaky test",
        originClientId: getChatLaunchOriginClientId(),
      },
      includeFetch: false,
    }),
    sequence: 1,
    ...overrides,
  };
}

function Harness({ launch }: { launch: (args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult> }) {
  useChatLaunchCliDriver(launch);
  return null;
}

let completeClient: ReturnType<typeof vi.fn>;
let disposePty: ReturnType<typeof vi.fn>;

beforeEach(() => {
  completeClient = vi.fn(async () => null);
  disposePty = vi.fn(async () => undefined);
  (window as unknown as { ade: unknown }).ade = { chatLaunch: { completeClient }, pty: { dispose: disposePty } };
});

afterEach(() => {
  cleanup();
  resetChatLaunchStoreForTests();
  resetChatLaunchCliDriverForTests();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("useChatLaunchCliDriver", () => {
  it("starts the PTY in the new lane once the host is awaiting the client, then reports it", async () => {
    const launch = vi.fn(async () => ({ ptyId: "pty-1", sessionId: "term-1" }) as WorkPtyLaunchResult);
    completeClient.mockImplementation(async () => cliLaunch({
      phase: "completed",
      laneCreated: true,
      sessionId: "term-1",
      sessionCreated: true,
      agentStarted: true,
      sequence: 4,
    }));
    registerChatLaunchLocalRecord("cli-launch-1", {
      args: { kind: "cli", mode: "foreground", launchId: "cli-launch-1", prompt: "Fix the flaky test" },
      pin: BINDING,
      draftSnapshot: null,
      cli: { profile: "claude", title: "Fix flaky test", tracked: true },
    });
    applyChatLaunchSnapshot(BINDING, cliLaunch());
    render(<Harness launch={launch} />);
    expect(launch).not.toHaveBeenCalled();

    act(() => {
      applyChatLaunchSnapshot(BINDING, cliLaunch({ phase: "awaiting-client", laneCreated: true, sequence: 2 }));
    });
    await waitFor(() => {
      expect(launch).toHaveBeenCalledWith({
        profile: "claude",
        title: "Fix flaky test",
        tracked: true,
        laneId: "lane-new",
        disposition: "foreground",
        pin: BINDING,
      });
      expect(completeClient).toHaveBeenCalledWith({ launchId: "cli-launch-1", sessionId: "term-1" }, BINDING);
    });
    // A re-render with the same awaiting launch does not start a second PTY.
    act(() => {
      applyChatLaunchSnapshot(BINDING, cliLaunch({ phase: "awaiting-client", laneCreated: true, sequence: 3, laneName: "Renamed" }));
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(disposePty).not.toHaveBeenCalled();
  });

  it("closes the PTY it just started when the launch was cancelled meanwhile", async () => {
    const launch = vi.fn(async () => ({ ptyId: "pty-1", sessionId: "term-1" }) as WorkPtyLaunchResult);
    // The host no longer awaits this client: it answers with the cancelled launch.
    completeClient.mockImplementation(async () => cliLaunch({ phase: "cancelled", laneCreated: true, sequence: 5 }));
    registerChatLaunchLocalRecord("cli-launch-1", {
      args: { kind: "cli", mode: "foreground", launchId: "cli-launch-1", prompt: "Fix the flaky test" },
      pin: BINDING,
      draftSnapshot: null,
      cli: { profile: "claude", tracked: true },
    });
    applyChatLaunchSnapshot(BINDING, cliLaunch({ phase: "awaiting-client", laneCreated: true, sequence: 2 }));
    render(<Harness launch={launch} />);
    await waitFor(() => {
      expect(disposePty).toHaveBeenCalledWith({ ptyId: "pty-1", sessionId: "term-1" }, BINDING);
    });
  });

  it("reports a PTY start failure to the host", async () => {
    const launch = vi.fn(async () => {
      throw new Error("claude is not installed");
    });
    registerChatLaunchLocalRecord("cli-launch-1", {
      args: { kind: "cli", mode: "background", launchId: "cli-launch-1", prompt: "p" },
      pin: BINDING,
      draftSnapshot: null,
      cli: { profile: "claude", tracked: true },
    });
    applyChatLaunchSnapshot(BINDING, cliLaunch({ phase: "awaiting-client", mode: "background" }));
    render(<Harness launch={launch} />);
    await waitFor(() => {
      expect(completeClient).toHaveBeenCalledWith({ launchId: "cli-launch-1", error: "claude is not installed" }, BINDING);
    });
  });

  it("ignores launches another window started and fails ones this window can no longer start", async () => {
    const launch = vi.fn();
    applyChatLaunchSnapshot(BINDING, cliLaunch({ launchId: "phone", originClientId: "phone", phase: "awaiting-client" }));
    applyChatLaunchSnapshot(BINDING, cliLaunch({ launchId: "orphan", phase: "awaiting-client" }));
    render(<Harness launch={launch} />);
    await waitFor(() => {
      expect(completeClient).toHaveBeenCalledWith(
        { launchId: "orphan", error: expect.stringContaining("can no longer start") },
        BINDING,
      );
    });
    expect(completeClient).not.toHaveBeenCalledWith(expect.objectContaining({ launchId: "phone" }), expect.anything());
    expect(launch).not.toHaveBeenCalled();
  });
});
