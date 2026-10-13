import { describe, expect, it } from "vitest";
import type { ApprovalChoice, UserInputRequestParams } from "@muse-code/sdk/dist/src/msp.js";
import type { AgentChatControlSubagentArgs } from "../../../shared/types";
import {
  isAgentChatSubagentControlAction,
  museAnswersFor,
  museChoiceForAnswer,
  museSubagentControlRequest,
  parseMuseControlCommand,
  type MuseSubagentItemRef,
} from "./museSessionSupport";

const approveOnce: ApprovalChoice = { choiceId: "approve-once", label: "Allow once", decision: "approved", scope: "once" };
const approveSession: ApprovalChoice = { choiceId: "approve-session", label: "Always allow", decision: "approvedForSession", scope: "session" };
const denyOnce: ApprovalChoice = { choiceId: "deny-once", label: "Deny", decision: "denied", scope: "once" };
const CHOICES = [approveOnce, approveSession, denyOnce];

describe("museChoiceForAnswer", () => {
  it.each([
    ["an explicit choice id wins over the generic decision", { decision: "decline" as const, responseText: "approve-session" }, "approve-session"],
    ["accept picks the once-scoped approval", { decision: "accept" as const }, "approve-once"],
    ["accept_for_session picks the session-scoped approval", { decision: "accept_for_session" as const }, "approve-session"],
    ["a plain decline picks the once-scoped denial", { decision: "decline" as const }, "deny-once"],
  ])("%s", (_label, answer, expectedChoiceId) => {
    expect(museChoiceForAnswer(CHOICES, answer)?.choiceId).toBe(expectedChoiceId);
  });

  it("never fails open when the host offered no deny choice", () => {
    expect(museChoiceForAnswer([approveOnce], { decision: "decline" })).toBeNull();
  });
});

function questionRequest(): UserInputRequestParams {
  return {
    itemId: "item-1",
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "request_user_input",
    turnId: "turn-1",
    userInputId: "input-1",
    viewCursor: "cursor-1",
    questions: [
      { id: "q1", header: "Pick", question: "Which?", selection: { mode: "multiple" }, options: [{ label: "A", description: "ay" }, { label: "B", description: "" }] },
      { id: "q2", header: "Color", question: "Hue?", selection: { mode: "single" }, options: [{ label: "Red" }] },
    ],
  };
}

describe("museAnswersFor", () => {
  it("maps picked labels to selections and anything else to free text per question", () => {
    const answers = museAnswersFor(
      questionRequest(),
      { q1: ["A", "custom note"], q2: ["Blue"] },
      null,
    );

    expect(answers).toEqual([
      { questionId: "q1", selectedLabels: ["A"], note: "custom note" },
      { questionId: "q2", freeText: "Blue" },
    ]);
  });
});

describe("subagent control allowlist", () => {
  it.each([
    ["interrupt", true],
    ["resume", true],
    ["reopen", true],
    ["close", true],
    ["pause", true],
    ["skip_child", true],
    ["retry_child", true],
    ["mystery", false],
    ["", false],
  ])("%s → %s", (value, allowed) => {
    expect(isAgentChatSubagentControlAction(value)).toBe(allowed);
  });

  const subagent: MuseSubagentItemRef = { kind: "subagent", subagentId: "sub-1", childSessionId: null, workflowRunId: null, running: true, paused: false, children: [] };

  function args(overrides: Partial<AgentChatControlSubagentArgs>): AgentChatControlSubagentArgs {
    return { sessionId: "session-1", taskId: "task-1", action: "interrupt", ...overrides };
  }

  it("refuses an action that is not in the allowlist, never guessing a method", () => {
    expect(museSubagentControlRequest(subagent, args({ action: "mystery" as AgentChatControlSubagentArgs["action"] }), "session-1"))
      .toEqual({ refuse: "Unknown subagent control action: mystery." });
  });

  it("maps the actions Muse can serve and refuses the ones that item cannot", () => {
    expect(museSubagentControlRequest(subagent, args({ action: "interrupt", reason: "stop" }), "session-1"))
      .toEqual({ method: "subagent/interrupt", params: { sessionId: "session-1", subagentId: "sub-1", reason: "stop" } });
    expect(museSubagentControlRequest(subagent, args({ action: "pause" }), "session-1"))
      .toEqual({ refuse: "A Muse subagent cannot pause." });
    expect(museSubagentControlRequest({ ...subagent, subagentId: null }, args({}), "session-1"))
      .toEqual({ refuse: "Muse did not name this subagent." });
  });
});

describe("parseMuseControlCommand", () => {
  it.each([
    ["/compact now", { kind: "compact" }],
    ["/goal ship it", { kind: "goal", arg: "ship it" }],
    ["/recap", { kind: "recap" }],
    ["/tasks stop", { kind: "stopTasks" }],
    ["!ls -la", { kind: "shell", commandText: "ls -la" }],
    ["/skill-shortcut", null],
    ["tell me a story", null],
  ])("%s → %o", (text, expected) => {
    expect(parseMuseControlCommand(text)).toEqual(expected);
  });
});
