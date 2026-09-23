/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatLaunchSnapshot, OpenProjectBinding } from "../../../../shared/types";
import { UnsupportedRemoteCommandError } from "../../../webclient/adapter/infra/commandCaller";
import {
  applyChatLaunchSnapshot,
  buildOptimisticChatLaunchSnapshot,
  getChatLaunchEntry,
  insertOptimisticChatLaunch,
  registerChatLaunchLocalRecord,
  removeChatLaunch,
  resetChatLaunchStoreForTests,
} from "../../../state/chatLaunchStore";
import { isChatLaunchUnsupportedError, queueChatLaunchMessage, startChatLaunch } from "./chatLaunchActions";

describe("isChatLaunchUnsupportedError", () => {
  it("recognises the rejections an older runtime actually sends", () => {
    for (const message of [
      "Remote ADE service method ade/actions/call failed (code -32602): action_not_callable: Action 'chat.startLaunch' is not callable.",
      "Error invoking remote method 'ade.remoteRuntime.callAction': Error: action_not_exposed: Action 'chat.startLaunch' is not exposed through ADE actions.",
      "Action 'chat.startLaunch' is not callable.",
      "Remote ADE service method run_ade_action failed (code -32601): Unknown ADE action: chat.startLaunch",
      "New-lane launch action 'chat.startLaunch' is unavailable on the connected ADE host.",
    ]) {
      expect(isChatLaunchUnsupportedError(new Error(message)), message).toBe(true);
    }
    expect(isChatLaunchUnsupportedError(new UnsupportedRemoteCommandError("chat.startLaunch"))).toBe(true);
  });

  it("treats every other rejection as a real launch failure", () => {
    for (const message of [
      "The ADE runtime on this machine stopped responding.",
      "Remote ADE service method ade/actions/call failed (code -32000): Creating lanes is not allowed while the project is read-only.",
      "Model 'x' is not supported by this provider.",
      "Unsupported attachment type.",
      "New-lane launches need a connected ADE runtime. Reconnect the machine and try again.",
    ]) {
      expect(isChatLaunchUnsupportedError(new Error(message)), message).toBe(false);
    }
  });
});

describe("queueChatLaunchMessage", () => {
  const BINDING: OpenProjectBinding = { kind: "local", key: "local:/p", rootPath: "/p", displayName: "p" };
  const ARGS = { kind: "chat" as const, mode: "foreground" as const, launchId: "launch-q", prompt: "Fix the login redirect" };

  function hostSnapshot(overrides: Partial<ChatLaunchSnapshot> = {}): ChatLaunchSnapshot {
    return {
      ...buildOptimisticChatLaunchSnapshot({
        launch: { ...ARGS, laneId: "lane-q", laneName: "Fix Login Redirect" },
        includeFetch: false,
      }),
      sequence: 1,
      ...overrides,
    };
  }

  function queuedTexts(): string[] {
    return getChatLaunchEntry("launch-q")?.snapshot.queuedMessages.map((message) => message.text) ?? [];
  }

  let resolveStart: (snapshot: ChatLaunchSnapshot) => void;
  let api: { start: ReturnType<typeof vi.fn>; queueMessage: ReturnType<typeof vi.fn> };
  let hostQueue: ChatLaunchSnapshot["queuedMessages"];

  beforeEach(() => {
    hostQueue = [];
    api = {
      start: vi.fn(() => new Promise<ChatLaunchSnapshot>((resolve) => { resolveStart = resolve; })),
      queueMessage: vi.fn(async (args: { text: string }) => {
        hostQueue = [...hostQueue, { id: `host-${hostQueue.length + 1}`, text: args.text, createdAt: "2026-09-22T10:00:05.000Z" }];
        return hostSnapshot({ sequence: 2 + hostQueue.length, queuedMessages: hostQueue });
      }),
    };
    (window as unknown as { ade: unknown }).ade = { chatLaunch: api };
    registerChatLaunchLocalRecord("launch-q", { args: ARGS, pin: BINDING, draftSnapshot: null, cli: null });
    insertOptimisticChatLaunch(BINDING, hostSnapshot({ sequence: 0 }));
  });

  afterEach(() => {
    resetChatLaunchStoreForTests();
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("holds messages typed before the host accepted the launch, then sends them in order", async () => {
    const started = startChatLaunch("launch-q");
    const first = queueChatLaunchMessage("launch-q", { text: "first" });
    const second = queueChatLaunchMessage("launch-q", { text: "second" });
    await Promise.resolve();
    // Nothing reaches the host yet (it would answer "Launch not found"); the bubbles show.
    expect(api.queueMessage).not.toHaveBeenCalled();
    expect(queuedTexts()).toEqual(["first", "second"]);

    resolveStart(hostSnapshot({ sequence: 1 }));
    await Promise.all([started, first, second]);

    expect(api.queueMessage.mock.calls.map((call) => (call[0] as { text: string }).text)).toEqual(["first", "second"]);
    expect(api.queueMessage).toHaveBeenCalledWith(expect.objectContaining({ launchId: "launch-q" }), BINDING);
    // The host's copies replaced the stand-ins.
    expect(getChatLaunchEntry("launch-q")?.snapshot.queuedMessages.map((message) => message.id)).toEqual(["host-1", "host-2"]);
  });

  it("keeps a held bubble through host snapshots that do not carry it yet", async () => {
    const started = startChatLaunch("launch-q");
    const pending = queueChatLaunchMessage("launch-q", { text: "held" });
    // A launch event lands before `start` answers: the held message stays on screen.
    applyChatLaunchSnapshot(BINDING, hostSnapshot({ sequence: 1 }));
    expect(queuedTexts()).toEqual(["held"]);
    resolveStart(hostSnapshot({ sequence: 1 }));
    await Promise.all([started, pending]);
    expect(queuedTexts()).toEqual(["held"]);
    expect(api.queueMessage).toHaveBeenCalledTimes(1);
  });

  it("drops the bubble and rejects when the host refuses the message", async () => {
    applyChatLaunchSnapshot(BINDING, hostSnapshot({ sequence: 1 }));
    api.queueMessage.mockRejectedValueOnce(new Error("Launch not found"));
    await expect(queueChatLaunchMessage("launch-q", { text: "lost?" })).rejects.toThrow("Launch not found");
    expect(queuedTexts()).toEqual([]);
  });

  it("rejects a held message when the launch is deleted before the host accepted it", async () => {
    const pending = queueChatLaunchMessage("launch-q", { text: "held" });
    removeChatLaunch("launch-q");
    await expect(pending).rejects.toThrow(/cancelled before the message could be sent/);
    expect(api.queueMessage).not.toHaveBeenCalled();
  });
});
