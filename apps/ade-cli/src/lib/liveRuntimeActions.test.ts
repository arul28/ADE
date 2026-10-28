import { describe, expect, it } from "vitest";
import { liveOnlyCallLabel } from "./liveRuntimeActions";

const action = (domain: string, name: string) => ({ name: "run_ade_action", arguments: { domain, action: name, args: {} } });

// With no brain, the CLI's in-process runtime answers chats from a stub that
// reports success for a chat that never runs (#48, #49). Those calls must be
// refused there; project state on disk must still work.
describe("liveOnlyCallLabel", () => {
  it.each([
    [action("chat", "createSession"), "chat.createSession"],
    [action("chat", "listSessions"), "chat.listSessions"],
    [action("terminal", "read"), "terminal.read"],
    [action("automations", "saveRule"), "automations.saveRule"],
    [{ name: "start_cli_session", arguments: {} }, "start_cli_session"],
    [action("lane", "list"), null],
    [action("automations", "list"), null],
    [action("git", "status"), null],
  ])("%j -> %s", (params, expected) => {
    expect(liveOnlyCallLabel("ade/actions/call", params)).toBe(expected);
  });

  it("leaves every other method alone", () => {
    expect(liveOnlyCallLabel("projects.add", action("chat", "createSession"))).toBeNull();
  });
});
