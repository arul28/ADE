import { describe, expect, it } from "vitest";
import { CommandCaller, UnsupportedRemoteCommandError } from "./commandCaller";
import type { AdeSyncClient } from "../../sync";
import type { AdapterProjectState } from "./projectState";

type FakeDescriptor = { action: string; scope: string; policy: Record<string, never> };

function callerWithActions(actions: string[], sent: string[] = []): {
  caller: CommandCaller;
  descriptors: FakeDescriptor[];
} {
  // The real client returns the array it holds, so the fake must too — see the
  // in-place-append test below.
  const descriptors: FakeDescriptor[] = actions.map((action) => ({ action, scope: "runtime", policy: {} }));
  const client = {
    getCommandDescriptors: () => descriptors,
    sendCommand: async (action: string) => {
      sent.push(action);
      return { ok: true };
    },
  } as unknown as AdeSyncClient;
  const projectState = { getProjectId: () => "project-1" } as unknown as AdapterProjectState;
  return { caller: new CommandCaller(client, projectState), descriptors };
}

describe("CommandCaller: actions the host does not advertise", () => {
  it("throws for a mutation instead of resolving its fallback", async () => {
    // The fallback exists to shape an offline READ. Applying it to a write
    // reports a mutation that was never sent — how web AI-settings saves and
    // PR writes reported success while changing nothing.
    const { caller } = callerWithActions(["lanes.list"]);
    await expect(
      caller.call("ai.updateConfig", {}, { fallback: undefined, idempotent: false }),
    ).rejects.toBeInstanceOf(UnsupportedRemoteCommandError);
  });

  it("names the missing action so a surface can explain itself", async () => {
    const { caller } = callerWithActions([]);
    await expect(
      caller.call("lanes.saveTemplate", {}, { fallback: undefined, idempotent: false }),
    ).rejects.toThrow(/lanes\.saveTemplate/);
  });

  it("still degrades a read to its fallback", async () => {
    const { caller } = callerWithActions([]);
    await expect(caller.call("lanes.list", {}, { fallback: [] })).resolves.toEqual([]);
  });

  it("sees an action appended to the descriptor array it was already given", async () => {
    // The client hands back the array it holds. A cache keyed only on array
    // identity would keep answering "unsupported" after an in-place append.
    const { caller, descriptors } = callerWithActions(["lanes.list"]);
    expect(caller.hasAction("personalChats.streamEvents")).toBe(false);
    descriptors.push({ action: "personalChats.streamEvents", scope: "runtime", policy: {} });
    expect(caller.hasAction("personalChats.streamEvents")).toBe(true);
  });

  it("dispatches normally once the host advertises the action", async () => {
    const sent: string[] = [];
    const { caller } = callerWithActions(["ai.updateConfig"], sent);
    await expect(
      caller.call("ai.updateConfig", {}, { fallback: undefined, idempotent: false }),
    ).resolves.toEqual({ ok: true });
    expect(sent).toEqual(["ai.updateConfig"]);
  });
});
