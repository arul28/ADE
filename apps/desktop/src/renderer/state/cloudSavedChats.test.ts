import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeAgentChatHistorySnapshot } from "../../shared/chatHistoryMerge";
import type { CloudSavedChatPage, CloudSavedChatRow } from "../../shared/cloudSavedChats";
import type { AgentChatEventEnvelope, OpenProjectBinding } from "../../shared/types";
import type { AgentChatApi } from "../components/chat/agentChatApi";
import { readOlderHistoryBatch, resolveMergedSnapshotHistoryCursor, resolveSnapshotHistoryCursor } from "../components/chat/chatHistoryWindow";
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

describe("a chat's older history while its ADE Cloud computer sleeps and wakes", () => {
  it("pages the saved copy after the computer wakes, so the older turns still load", async () => {
    // Six saved parts, one turn each; a page holds two parts.
    const turn = (n: number): AgentChatEventEnvelope[] => [
      { sessionId: "chat-1", timestamp: `2026-11-26T00:0${n}:00.000Z`, sequence: n * 2 - 1, event: { type: "user_message", text: `ask ${n}` } },
      { sessionId: "chat-1", timestamp: `2026-11-26T00:0${n}:30.000Z`, sequence: n * 2, event: { type: "text", text: `answer ${n}` } },
    ];
    const row = { chatId: "chat-1", machineKey: "machine-key-1", lastSeq: 6 } as CloudSavedChatRow;
    const read = vi.fn(async ({ before }: { before?: number | null }): Promise<CloudSavedChatPage> => {
      const newest = before ? before - 1 : 6;
      const oldest = Math.max(1, newest - 1);
      const parts = [];
      for (let seq = newest; seq >= oldest; seq -= 1) parts.push({ seq, text: `${turn(seq).map((event) => JSON.stringify(event)).join("\n")}\n` });
      return { chat: row, parts, hasMore: oldest > 1, nextBefore: oldest > 1 ? oldest : null };
    });
    replaceSavedChatLocations([{
      pinKey: PIN.key,
      location: { machineKey: "machine-key-1", readMachineKey: "machine-key-1", chatId: "chat-1", machineId: "env-cloud", computerGone: false, row },
    }]);
    let awake = false;
    // The awake computer's own transcript: its newest window is the last turn, at a byte offset.
    const live = {
      getEventHistory: vi.fn(async () => ({ sessionId: "chat-1", events: turn(6), truncated: true, sessionFound: true, hasOlderHistory: true, tailStartOffset: 2_400_000 })),
      getEventHistoryPage: vi.fn(async ({ beforeOffset }: { beforeOffset: number }) => (
        beforeOffset < 2_400_000
          ? { sessionId: "chat-1", events: [], startOffset: 0, hasMore: false, sessionFound: true }
          : { sessionId: "chat-1", events: turn(5), startOffset: 1_200_000, hasMore: true, sessionFound: true }
      )),
    };
    const api = withSavedChatReads(live as unknown as AgentChatApi, { read } as never, () => awake);
    const texts = (events: AgentChatEventEnvelope[]) => events.map((event) => (event.event as { text: string }).text);

    // Opened while the computer rests: the saved copy's newest page.
    const resting = await api.getEventHistory({ sessionId: "chat-1" }, PIN);
    expect(texts(resting.events)).toEqual(["ask 5", "answer 5", "ask 6", "answer 6"]);
    let cursor = resolveSnapshotHistoryCursor(resting);

    // The computer wakes, and the chat reads its history again from it.
    awake = true;
    const woke = await api.getEventHistory({ sessionId: "chat-1" }, PIN);
    const onScreen = mergeAgentChatHistorySnapshot(woke.events, resting.events);
    cursor = resolveMergedSnapshotHistoryCursor({
      snapshotCursor: resolveSnapshotHistoryCursor(woke),
      currentCursor: cursor,
      snapshotEvents: woke.events,
      existingEvents: resting.events,
      mergedEvents: onScreen,
      detached: false,
    });

    // Scrolling up loads the turns before the saved page, from the saved copy.
    const older = await readOlderHistoryBatch({
      sessionId: "chat-1",
      beforeOffset: cursor,
      isCurrent: () => true,
      readPage: (beforeOffset) => api.getEventHistoryPage({ sessionId: "chat-1", beforeOffset }, PIN),
    });
    expect(texts(older?.events ?? [])).toEqual(["ask 3", "answer 3", "ask 4", "answer 4"]);
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ before: 5 }));
    expect(live.getEventHistoryPage).not.toHaveBeenCalled();
    expect(older?.nextCursor).toBeGreaterThan(0);
  });
});
