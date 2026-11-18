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
