import { describe, expect, it } from "vitest";
import { deriveCtoAvatarState, type CtoAvatarStateInput } from "./ctoAvatarState";

describe("deriveCtoAvatarState", () => {
  it.each<[string, CtoAvatarStateInput, ReturnType<typeof deriveCtoAvatarState>]>([
    ["an idle chat", { status: "idle" }, "idle"],
    ["no status at all", {}, "idle"],
    ["a running turn", { status: "active" }, "working"],
    ["a work-row running status", { status: "running" }, "working"],
    ["a running turn writing its reply", { status: "active", streamingText: true }, "thinking"],
    ["streaming text on a settled chat", { status: "idle", streamingText: true }, "idle"],
    ["a question for the person", { status: "active", awaitingInput: true }, "waiting"],
    ["an awaiting-input status", { status: "awaiting-input" }, "waiting"],
    ["a failed last turn", { status: "idle", lastTurnFailed: true }, "error"],
    ["a failed status", { status: "failed" }, "error"],
    ["a new turn after a failure", { status: "active", lastTurnFailed: true }, "working"],
    ["no model picked", { status: "active", noModel: true }, "asleep"],
    ["an offline machine, even mid-question", { awaitingInput: true, offline: true }, "asleep"],
    ["status spelled in upper case", { status: " Active " }, "working"],
  ])("%s", (_label, input, expected) => {
    expect(deriveCtoAvatarState(input)).toBe(expected);
  });
});
