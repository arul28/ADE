import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { restoreCloudChat, restoreLaneChats, type CloudChatRestoreDeps } from "./cloudChatRestore";

/**
 * A deleted computer's CLI continues on a new computer. The account API is
 * faked (the network boundary); the order of the restore and the move is the
 * contract: the saved address moves only once the CLI runs here.
 */
describe("restoreCloudChat for a CLI", () => {
  const capsuleBytes = gzipSync(Buffer.from(JSON.stringify({
    v: 1,
    capsule: { version: 1, source: { provider: "claude", title: "Fix the login page" }, cli: { toolType: "claude" } },
  })));

  const setup = (saved: { copy: boolean; moveFails?: boolean }) => {
    const steps: string[] = [];
    const warnings: string[] = [];
    const api = {
      savedSession: async (machineKey: string) => (saved.copy && machineKey === "key-old"
        ? { session: { kind: "cli", toolType: "claude", title: "Fix the login page" }, format: "text", text: "$ ready\n" }
        : null),
      capsuleManifest: async (machineKey: string) => (machineKey === "key-old"
        ? { sessionKind: "cli", bytes: capsuleBytes.byteLength, parts: 1 }
        : null),
      readCapsulePart: async () => capsuleBytes,
      moveSavedSession: async (fromMachineKey: string, sessionId: string, move: { toMachineKey: string; instanceId: string }) => {
        steps.push(`move ${fromMachineKey}/${sessionId} -> ${move.toMachineKey} by ${move.instanceId}`);
        if (saved.moveFails) throw new Error("ADE Cloud is busy.");
        return { moved: true };
      },
    };
    const deps = {
      api: api as never,
      instanceId: "newbox1234",
      machineKey: "key-new",
      logger: { info: () => {}, warn: (event: string) => warnings.push(event), error: () => {}, debug: () => {} } as never,
      restore: async () => { throw new Error("a CLI never restores as a chat"); },
      adopt: async () => true,
      hold: () => {},
      release: () => {},
      restoreCli: async (args: { sessionId: string; capsule: unknown }) => {
        steps.push(`restore ${args.sessionId} ${args.capsule ? "with capsule" : "fresh"}`);
        return { sessionId: args.sessionId, restoredWith: "capsule" as const };
      },
    } satisfies CloudChatRestoreDeps;
    const args = { fromMachineKey: "key-old", chatId: "cli-1", laneId: "lane-1", modelId: null, prompt: "Go on.", clientMessageId: "m1", kind: "cli" as const };
    return { steps, warnings, run: () => restoreCloudChat(deps, args) };
  };

  it("moves the saved copy only after the CLI runs here, moves nothing for a capsule-only CLI, and keeps a running CLI when the move fails", async () => {
    const withCopy = setup({ copy: true });
    expect(await withCopy.run()).toMatchObject({ sessionId: "cli-1", promptSent: true, moved: true });
    expect(withCopy.steps).toEqual(["restore cli-1 with capsule", "move key-old/cli-1 -> key-new by newbox1234"]);

    // Its screen copy was pruned: the capsule alone restores it, and there is no copy to move.
    const capsuleOnly = setup({ copy: false });
    expect(await capsuleOnly.run()).toMatchObject({ sessionId: "cli-1", moved: false });
    expect(capsuleOnly.steps).toEqual(["restore cli-1 with capsule"]);

    // The CLI already runs: a refused move is logged, and the continue stands.
    const moveFails = setup({ copy: true, moveFails: true });
    expect(await moveFails.run()).toMatchObject({ sessionId: "cli-1", promptSent: true, moved: false });
    expect(moveFails.steps).toHaveLength(2);
    expect(moveFails.warnings).toEqual(["cloud.restore_move_failed"]);
  });
});

/**
 * A deleted computer's chat continues on a new computer with its fork
 * capsule only when the capsule is as new as the saved transcript, and the
 * capsule outlives a restore that fails: the move keeps it, and it goes
 * only once a restore used it.
 */
describe("restoreCloudChat for a chat", () => {
  const T1 = "2026-11-20T10:00:00.000Z";
  const T2 = "2026-11-20T10:05:00.000Z";
  const transcript = [
    { sessionId: "c1", timestamp: T1, sequence: 1, event: { type: "user_message", text: "Fix the footer." } },
    { sessionId: "c1", timestamp: T2, sequence: 2, event: { type: "done", status: "completed" } },
  ].map((envelope) => JSON.stringify(envelope)).join("\n");

  const setup = (transcriptEnd: { at: string | null; sequence: number | null } | undefined, failFirst: boolean) => {
    const capsuleBytes = gzipSync(Buffer.from(JSON.stringify({
      v: 1,
      capsule: { version: 1, source: { provider: "claude", title: "Footer" }, target: { targetModelId: "claude-sonnet" }, forkTransport: { kind: "claude-jsonl" } },
      ...(transcriptEnd === undefined ? {} : { transcriptEnd }),
    })));
    const state = { copyAt: "key-old", capsuleAt: "key-old" as string | null, failures: failFirst ? 1 : 0 };
    const steps: string[] = [];
    const api = {
      savedChat: async ({ machineKey }: { machineKey: string }) => (machineKey === state.copyAt
        ? {
            chat: { chatId: "c1", machineKey, lastSeq: 2, model: "claude-sonnet", title: "Footer", forkedFrom: machineKey === "key-new" ? { machineKey: "key-old", chatId: "c1" } : null },
            parts: [{ seq: 1, text: transcript }], hasMore: false, nextBefore: null,
          }
        : null),
      capsuleManifest: async (machineKey: string) => (machineKey === state.capsuleAt ? { sessionKind: "chat", bytes: capsuleBytes.byteLength, parts: 1 } : null),
      readCapsulePart: async () => capsuleBytes,
      moveSavedChat: async (from: string, _chatId: string, move: { toMachineKey: string; keepCapsule?: boolean }) => {
        steps.push(`move ${from} -> ${move.toMachineKey}${move.keepCapsule ? ", capsule kept" : ""}`);
        state.copyAt = move.toMachineKey;
        return { moved: true, chat: { lastSeq: 2 } };
      },
      deleteCapsule: async (machineKey: string) => {
        steps.push(`delete capsule ${machineKey}`);
        state.capsuleAt = null;
        return { deleted: true };
      },
    };
    const deps = {
      api: api as never,
      instanceId: "newbox1234",
      machineKey: "key-new",
      logger: { info: () => {}, warn: () => {} },
      restore: async (args: { capsule: unknown }) => {
        steps.push(`restore with ${args.capsule ? "capsule" : "replay"}`);
        if (state.failures-- > 0) throw new Error("The chat could not be made.");
        return { sessionId: "c1", restoredWith: args.capsule ? "capsule" as const : "replay" as const };
      },
      adopt: async () => true,
      hold: () => {},
      release: () => {},
    } satisfies CloudChatRestoreDeps;
    const args = { fromMachineKey: "key-old", chatId: "c1", laneId: "lane-1", modelId: null, prompt: "Go on.", clientMessageId: "m1", kind: "chat" as const };
    return { steps, run: () => restoreCloudChat(deps, args) };
  };

  it.each<[string, { at: string | null; sequence: number | null } | undefined, boolean, string[]]>([
    ["a capsule as new as the transcript resumes the agent, and goes once used", { at: T2, sequence: 2 }, false,
      ["move key-old -> key-new, capsule kept", "restore with capsule", "delete capsule key-old"]],
    ["a capsule made before the chat's last turn is not used: the transcript replays", { at: T1, sequence: 1 }, false,
      ["move key-old -> key-new, capsule kept", "restore with replay", "delete capsule key-old"]],
    ["a capsule made before the chat had a turn is not used", { at: null, sequence: null }, false,
      ["move key-old -> key-new, capsule kept", "restore with replay", "delete capsule key-old"]],
    ["an older ADE's capsule with no mark is used as before", undefined, false,
      ["move key-old -> key-new, capsule kept", "restore with capsule", "delete capsule key-old"]],
    ["a restore that fails keeps the capsule: the next try reads it where the copy moved from", { at: T2, sequence: 2 }, true,
      ["move key-old -> key-new, capsule kept", "restore with capsule", "restore with capsule", "delete capsule key-old"]],
  ])("%s", async (_label, transcriptEnd, failFirst, expected) => {
    const chat = setup(transcriptEnd, failFirst);
    if (failFirst) await expect(chat.run()).rejects.toThrow("could not be made");
    expect(await chat.run()).toMatchObject({ sessionId: "c1", moved: true });
    expect(chat.steps).toEqual(expected);
  });
});

/**
 * Contract C3: a lane that comes back on a new computer brings its chats whose
 * computer is gone, each with its own id, and leaves every other chat where it is.
 */
describe("restoreLaneChats", () => {
  it("restores the lane's chats from gone computers (newest copy, read over pages), skips live, own, other-lane and unreadable ones", async () => {
    const gone = { state: "deleted", deletedAt: 1, reason: "freed" } as const;
    const row = (chatId: string, machineKey: string, laneId: string, updatedAt: number, computer: unknown) =>
      ({ chatId, machineKey, laneId, updatedAt, computer, model: "claude-sonnet", title: chatId, lastSeq: 1 });
    const pages = [
      { chats: [row("c1", "key-old", "lane-1", 10, gone), row("c1", "key-older", "lane-1", 5, gone), row("live", "key-live", "lane-1", 9, { state: "exists" })], nextCursor: "p2" },
      { chats: [row("mine", "key-new", "lane-1", 8, gone), row("other-lane", "key-old", "lane-2", 7, gone), row("cli", "key-old", "lane-1", 6, gone)], nextCursor: null },
    ];
    const steps: string[] = [];
    const warnings: string[] = [];
    const api = {
      savedChats: async (args: { projectKey: string; cursor: string | null }) => {
        steps.push(`list ${args.projectKey} ${args.cursor ?? "first"}`);
        return pages[args.cursor ? 1 : 0];
      },
      // The CLI row has no saved transcript: it isn't restored as a chat.
      savedChat: async ({ machineKey, chatId }: { machineKey: string; chatId: string }) => (chatId === "cli"
        ? null
        : { chat: row(chatId, machineKey, "lane-1", 10, gone), parts: [{ seq: 1, text: "" }], hasMore: false, nextBefore: null }),
      capsuleManifest: async () => null,
      moveSavedChat: async (from: string, chatId: string, move: { toMachineKey: string }) => {
        steps.push(`move ${from}/${chatId} -> ${move.toMachineKey}`);
        return { moved: true, chat: { lastSeq: 1 } };
      },
      savedSession: async () => { throw new Error("a lane's chats never restore as a CLI"); },
    };
    const deps = {
      api: api as never,
      instanceId: "newbox1234",
      machineKey: "key-new",
      logger: { info: () => {}, warn: (event: string) => warnings.push(event) } as never,
      restore: async (args: { sessionId: string; laneId: string }) => {
        steps.push(`restore ${args.sessionId} in ${args.laneId}`);
        return { sessionId: args.sessionId, restoredWith: "replay" as const };
      },
      adopt: async () => true,
      hold: () => {},
      release: () => {},
      restoreCli: async () => { throw new Error("a lane's chats never restore as a CLI"); },
    } satisfies CloudChatRestoreDeps;

    expect(await restoreLaneChats(deps, { laneId: "lane-1", projectKey: "github.com/acme/widgets" })).toBe(1);
    expect(steps).toEqual([
      "list github.com/acme/widgets first",
      "list github.com/acme/widgets p2",
      "move key-old/c1 -> key-new",
      "restore c1 in lane-1",
    ]);
    expect(warnings).toEqual(["cloud.lane_chat_restore_failed"]);
  });
});
