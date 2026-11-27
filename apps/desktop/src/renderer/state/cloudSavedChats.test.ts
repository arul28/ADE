import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeAgentChatHistorySnapshot, mergeAgentChatLiveEvents } from "../../shared/chatHistoryMerge";
import type { CloudSavedChatPage, CloudSavedChatRow } from "../../shared/cloudSavedChats";
import type { AgentChatEventEnvelope, OpenProjectBinding } from "../../shared/types";
import type { AgentChatApi } from "../components/chat/agentChatApi";
import { prependOlderChatHistoryPage, readOlderHistoryBatch, resolveMergedSnapshotHistoryCursor, resolveSnapshotHistoryCursor } from "../components/chat/chatHistoryWindow";
import { CLOUD_SEND_ANSWER_WAIT_MS, replaceCloudConnectionTargets, replaceSavedChatLocations, savedChatSnapshot, withSavedChatReads } from "./cloudSavedChats";

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

    // The computer wakes: the sidebar's next list read leaves its chats out
    // (the live list owns them), and the chat reads its history again from it.
    awake = true;
    replaceSavedChatLocations([]);
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

describe("a chat's saved rows and the live rows they were copied from", () => {
  // The computer's transcript, as the awake computer reads it.
  const at = (second: number) => `2026-11-26T01:00:0${second}.000Z`;
  const longOutput = `${"log line\n".repeat(30_000)}tail`;
  const live: AgentChatEventEnvelope[] = [
    { sessionId: "chat-1", timestamp: at(1), sequence: 1, event: { type: "user_message", text: "deploy with token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" } },
    { sessionId: "chat-1", timestamp: at(2), sequence: 2, event: { type: "tool_call", tool: "bash", args: { token: "abcd-1234", deep: { level: { list: [1, 2] } } }, itemId: "tool-1", turnId: "turn-1" } },
    { sessionId: "chat-1", timestamp: at(3), sequence: 3, event: { type: "command", command: "cat build.log", cwd: "/repo", output: longOutput, itemId: "cmd-1", turnId: "turn-1", status: "completed" } },
    { sessionId: "chat-1", timestamp: at(4), sequence: 4, event: { type: "text", text: "Deployed." } },
  ];
  // The same lines as the uploader saved them: a secret redacted, a
  // credential field replaced, a deep value and a long string cut. The plain
  // text line is unchanged.
  const savedLines: AgentChatEventEnvelope[] = [
    { ...live[0]!, event: { type: "user_message", text: "deploy with token=[REDACTED]" } },
    { ...live[1]!, event: { type: "tool_call", tool: "bash", args: { token: "[REDACTED]", deep: "[truncated]" }, itemId: "tool-1", turnId: "turn-1" } },
    { ...live[2]!, event: { type: "command", command: "cat build.log", cwd: "/repo", output: `${longOutput.slice(0, 1000)}\n[truncated]`, itemId: "cmd-1", turnId: "turn-1", status: "completed" } },
    live[3]!,
  ];
  const savedRead = (lines: AgentChatEventEnvelope[]) => savedChatSnapshot({
    chat: { chatId: "chat-1", machineKey: "machine-key-1", lastSeq: 1 } as CloudSavedChatRow,
    parts: [{ seq: 1, text: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n` }],
    hasMore: false,
    nextBefore: null,
  }, "chat-1").events;
  const saved = savedRead(savedLines);
  // A live row that already says `[REDACTED]`; its saved copy redacts more.
  const literal: AgentChatEventEnvelope = { sessionId: "chat-1", timestamp: at(5), sequence: 5, event: { type: "text", text: "Explain [REDACTED] in the header Bearer demo123" } };
  const [literalSaved] = savedRead([{ ...literal, event: { type: "text", text: "Explain [REDACTED] in the header [REDACTED]" } }]);
  // The same time, kind and number as the saved line, but a real difference
  // outside what the uploader marks: a different event, never hidden.
  const otherCommand: AgentChatEventEnvelope = { ...live[2]!, event: { type: "command", command: "cat other.log", cwd: "/repo", output: longOutput, itemId: "cmd-1", turnId: "turn-1", status: "completed" } };

  it.each<{ seam: string; merge: () => AgentChatEventEnvelope[]; shows: AgentChatEventEnvelope[] }>([
    {
      seam: "the computer wakes and the chat reads its history from it",
      merge: () => mergeAgentChatHistorySnapshot(live, saved),
      shows: live,
    },
    {
      seam: "the computer sleeps and the chat reads its saved copy",
      merge: () => mergeAgentChatHistorySnapshot(saved, live),
      shows: live,
    },
    {
      seam: "the woken computer streams events the saved copy holds",
      merge: () => mergeAgentChatLiveEvents(saved, live),
      shows: live,
    },
    {
      seam: "a live event that differs for real arrives over a saved row",
      merge: () => mergeAgentChatLiveEvents(saved, [otherCommand]),
      shows: [saved[0]!, saved[1]!, saved[2]!, otherCommand, saved[3]!],
    },
    {
      seam: "an older saved page loads above the computer's own rows",
      merge: () => prependOlderChatHistoryPage(saved, live.slice(2), true),
      shows: [saved[0]!, saved[1]!, live[2]!, live[3]!],
    },
    {
      seam: "an older page from the computer loads above saved rows",
      merge: () => prependOlderChatHistoryPage(live.slice(0, 2), saved),
      shows: [live[0]!, live[1]!, saved[2]!, saved[3]!],
    },
    {
      seam: "a saved page repeats a live row that already says [REDACTED]",
      merge: () => prependOlderChatHistoryPage([literalSaved!], [literal], true),
      shows: [literal],
    },
  ])("$seam: each event shows once, as the computer wrote it when it has it", ({ merge, shows }) => {
    expect(merge()).toEqual(shows);
  });
});
