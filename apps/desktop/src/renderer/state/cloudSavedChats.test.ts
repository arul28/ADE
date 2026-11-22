import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../shared/types";
import type { AgentChatApi } from "../components/chat/agentChatApi";
import { CLOUD_SEND_ANSWER_WAIT_MS, replaceCloudConnectionTargets, replaceSavedChatLocations, withSavedChatReads } from "./cloudSavedChats";

const PIN = {
  kind: "remote",
  key: "env-cloud:proj",
  targetId: "env-cloud",
  runtimeName: "ADE Cloud",
  transport: "paired",
  projectId: "proj",
  rootPath: "/repo",
  displayName: "repo",
} as OpenProjectBinding;

const ARGS = { sessionId: "chat-1", text: "hello", clientSendId: "send-1" };
const DEAD_LINK = new Error("Timed out waiting for remote command result.");
const RECONNECTING = new Error("Reconnecting to this computer. Try again when connected.");
const TURN_RUNNING = new Error("A turn is already running in this chat.");

type Direct = "answers" | "hangs" | "dead link" | "reconnecting" | "turn running";

function directSend(kind: Direct): () => Promise<void> {
  switch (kind) {
    case "answers": return () => Promise.resolve();
    case "hangs": return () => new Promise<void>(() => {});
    case "dead link": return () => Promise.reject(DEAD_LINK);
    case "reconnecting": return () => Promise.reject(RECONNECTING);
    case "turn running": return () => Promise.reject(TURN_RUNNING);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  // A live chat on an ADE Cloud connection: the saved list holds no copy of it.
  replaceCloudConnectionTargets([["env-cloud", "machine-key-1"]]);
  replaceSavedChatLocations([]);
});

afterEach(() => {
  vi.useRealTimers();
  replaceCloudConnectionTargets([]);
});

describe("a send to a chat on an ADE Cloud computer that may have just gone to sleep", () => {
  it.each<{ direct: Direct; queued: boolean; outcome: "resolves" | Error }>([
    // Answered in time: the queue is never asked.
    { direct: "answers", queued: false, outcome: "resolves" },
    // No answer on a link that still reads connected: the queue takes it once the wait is over.
    { direct: "hangs", queued: true, outcome: "resolves" },
    // A lost answer or a refusal before it left: the queue takes it at once.
    { direct: "dead link", queued: true, outcome: "resolves" },
    { direct: "reconnecting", queued: true, outcome: "resolves" },
    // Refused by the chat itself: queueing would change nothing.
    { direct: "turn running", queued: false, outcome: TURN_RUNNING },
  ])("direct send $direct → queued: $queued", async ({ direct, queued, outcome }) => {
    const send = vi.fn(directSend(direct));
    const queueSend = vi.fn(async () => "sent" as const);
    const api = withSavedChatReads(
      { send } as unknown as AgentChatApi,
      {} as never,
      () => true,
      { pinFor: async () => null, reached: () => {}, queueSend },
    );
    const result = api.send(ARGS, PIN).then(() => "resolves" as const, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(CLOUD_SEND_ANSWER_WAIT_MS - 1);
    if (direct === "hangs") expect(queueSend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(outcome);
    expect(send).toHaveBeenCalledTimes(1);
    // The queue sends the same id the direct send carried, so the computer runs it once.
    expect(queueSend.mock.calls).toEqual(queued
      ? [[{ machineKey: "machine-key-1", chatId: "chat-1", row: { provider: null, model: null } }, ARGS]]
      : []);
  });

  it("keeps the direct answer when the queue refuses while the direct call is still out", async () => {
    let answer: () => void = () => {};
    const send = vi.fn(() => new Promise<void>((resolve) => { answer = resolve; }));
    const queueSend = vi.fn(async () => { throw new Error("You are out of ADE Cloud hours."); });
    const api = withSavedChatReads({ send } as unknown as AgentChatApi, {} as never, () => true, { pinFor: async () => null, reached: () => {}, queueSend });
    const result = api.send(ARGS, PIN).then(() => "resolves" as const, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(CLOUD_SEND_ANSWER_WAIT_MS);
    expect(queueSend).toHaveBeenCalledTimes(1);
    answer();
    expect(await result).toBe("resolves");
  });
});
