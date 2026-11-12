/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../shared/types";
import { WOKEN_MACHINE_CONNECT_WAIT_MS } from "../../shared/wokenMachine";
import { useAppStore } from "./appStore";
import { SAVED_CHATS_MACHINE_PREFIX } from "../../shared/cloudSavedChats";
import { markCloudWakeForSend, refreshCloudSavedChats, sendWithCloudWakeMark } from "./cloudSavedChatsSync";

const originalAde = globalThis.window.ade;

const bindingOf = (targetId: string) => ({
  kind: "remote",
  key: `${targetId}:proj`,
  targetId,
  runtimeName: targetId,
  transport: "paired",
  projectId: "proj",
  rootPath: "/repo",
  displayName: "repo",
}) as OpenProjectBinding;

const ASLEEP = bindingOf("target-asleep");
const CONNECTED = bindingOf("target-connected");
const DELETED_MACHINE_ID = `${SAVED_CHATS_MACHINE_PREFIX}key-deleted`;
const TIMEOUT = new Error("Remote ADE service timed out waiting for method agentChat.send");

const waking = (sessionId = "chat-asleep") => useAppStore.getState().cloudWakingSinceBySessionId[sessionId];

/** The woken computer's own row for the chat, with a turn started at `turnStartedAt`. */
function putLiveRow(turnStartedAt: string, lastActivityAt: string): void {
  useAppStore.getState().mergeCrossMachineLanes({
    machineId: "target-new",
    machineName: "New computer",
    targetId: "target-new",
    online: false,
    lanes: [],
    sessions: [{
      id: "chat-asleep",
      laneId: "lane-1",
      toolType: "claude-chat",
      status: "running",
      runtimeState: "running",
      currentTurnStartedAt: turnStartedAt,
      chatIdleSinceAt: null,
      endedAt: null,
      lastActivityAt,
    } as TerminalSessionSummary],
  });
}

beforeEach(async () => {
  useAppStore.setState({ crossMachineLanesByMachineId: {}, cloudWakingSinceBySessionId: {} });
  // A sleeping computer and a connected one keep their connections; the
  // deleted computer has none, so its chats stay as saved copies.
  for (const [binding, online] of [[ASLEEP, false], [CONNECTED, true]] as const) {
    useAppStore.getState().mergeCrossMachineLanes({
      machineId: binding.kind === "remote" ? binding.targetId : "",
      machineName: "Computer",
      targetId: binding.kind === "remote" ? binding.targetId : null,
      projectId: "proj",
      binding,
      online,
      lanes: [],
      sessions: [],
    });
  }
  const row = (machineKey: string, chatId: string) => ({
    machineKey,
    chatId,
    instanceId: null,
    lastSeq: 1,
    updatedAt: 1,
    title: "Chat",
    laneId: "lane-1",
    laneName: "Lane One",
    status: null,
    toolType: "claude-chat",
    provider: null,
    model: null,
    projectKey: "repo-key",
    projectId: "proj",
    projectRoot: "/repo",
    lastActivityAt: null,
  });
  window.ade = {
    cloud: {
      savedChats: {
        list: async () => ({
          nextCursor: null,
          chats: [row("key-asleep", "chat-asleep"), row("key-connected", "chat-connected"), row("key-deleted", "chat-deleted")],
        }),
      },
    },
  } as unknown as typeof window.ade;
  const connection = (targetId: string, machineKey: string, state: string) => ({
    target: { id: targetId, name: targetId, hostname: null, pairedMachine: { machineKey } },
    state,
    projects: [{ projectId: "proj", rootPath: "/repo", displayName: "repo" }],
  });
  await refreshCloudSavedChats({
    projectKey: "repo-key",
    isActive: () => true,
    connections: [
      connection("target-asleep", "key-asleep", "disconnected"),
      connection("target-connected", "key-connected", "connected"),
    ] as never,
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalAde === undefined) delete (globalThis.window as { ade?: unknown }).ade;
  else globalThis.window.ade = originalAde;
});

describe("the waking mark of a send that wakes a cloud computer", () => {
  // The submit path settles in its catch, then again in `finally`: the second
  // call must not undo what the first decided.
  it.each<{ name: string; failure: unknown; messageLeft: boolean; keptUntilTimeout: boolean }>([
    { name: "a send that went through ends it", failure: undefined, messageLeft: true, keptUntilTimeout: false },
    { name: "a refusal ends it", failure: new Error("over_plan_disk: Your disk is above the free plan."), messageLeft: true, keptUntilTimeout: false },
    { name: "a timeout before the message left ends it", failure: TIMEOUT, messageLeft: false, keptUntilTimeout: false },
    { name: "a timeout after the message left keeps it until the wake's time is up", failure: TIMEOUT, messageLeft: true, keptUntilTimeout: true },
  ])("$name", ({ failure, messageLeft, keptUntilTimeout }) => {
    const mark = markCloudWakeForSend("chat-asleep", ASLEEP);
    expect(waking()).toEqual(expect.any(String));
    mark!.settle(failure, messageLeft);
    mark!.settle();
    expect(waking() !== undefined).toBe(keptUntilTimeout);
    vi.advanceTimersByTime(WOKEN_MACHINE_CONNECT_WAIT_MS - 1);
    expect(waking() !== undefined).toBe(keptUntilTimeout);
    vi.advanceTimersByTime(1);
    expect(waking()).toBeUndefined();
  });

  it("marks only a sleeping computer, holds through overlapping sends, ends on a new turn only, and never outlives its backstop", async () => {
    // A connected computer wakes nothing; a deleted one can't wake.
    const deletedPin = useAppStore.getState().crossMachineLanesByMachineId[DELETED_MACHINE_ID]?.binding;
    expect(deletedPin).toBeTruthy();
    expect(markCloudWakeForSend("chat-connected", CONNECTED)).toBeNull();
    expect(markCloudWakeForSend("chat-deleted", deletedPin)).toBeNull();

    // Two sends at once: the mark lasts until the last one settles.
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = sendWithCloudWakeMark("chat-asleep", ASLEEP, () => new Promise<void>((resolve) => { finishFirst = resolve; }));
    const second = sendWithCloudWakeMark("chat-asleep", ASLEEP, () => new Promise<void>((resolve) => { finishSecond = resolve; }));
    const since = waking();
    expect(since).toEqual(expect.any(String));
    finishFirst();
    await first;
    expect(waking()).toBe(since);
    finishSecond();
    await second;
    expect(waking()).toBeUndefined();

    // A turn the woken machine showed before the send does not end the mark;
    // a new one does, before the send settles.
    putLiveRow("2026-11-10T10:00:00.000Z", "2026-11-10T10:00:00.000Z");
    const mark = markCloudWakeForSend("chat-asleep", ASLEEP);
    const before = useAppStore.getState().crossMachineLanesByMachineId;
    putLiveRow("2026-11-10T10:00:00.000Z", "2026-11-10T10:01:00.000Z");
    expect(useAppStore.getState().crossMachineLanesByMachineId).not.toBe(before);
    expect(waking()).toEqual(expect.any(String));
    putLiveRow("2026-11-10T10:02:00.000Z", "2026-11-10T10:02:00.000Z");
    expect(waking()).toBeUndefined();
    mark!.settle(TIMEOUT);
    vi.runOnlyPendingTimers();
    expect(waking()).toBeUndefined();

    // A send that never settles still ends its mark, at twice the wake's time.
    markCloudWakeForSend("chat-asleep", ASLEEP);
    vi.advanceTimersByTime(2 * WOKEN_MACHINE_CONNECT_WAIT_MS - 1);
    expect(waking()).toEqual(expect.any(String));
    vi.advanceTimersByTime(1);
    expect(waking()).toBeUndefined();
  });
});
