import { describe, expect, it } from "vitest";
import {
  PI_APPROVAL_ALLOW,
  PI_APPROVAL_ALLOW_SESSION,
  PI_UI_ANSWER_ID,
  piExtensionLoadNotice,
  piUiNoticeToChatEvents,
  piUiRequestToPendingInput,
  piUiResponseFromAnswer,
} from "./piSdkEventMapper";
import type { PiSdkUiRequestPayload } from "./piSdkProtocol";

const question: PiSdkUiRequestPayload = {
  origin: "tool",
  kind: "select",
  title: "Database",
  message: "Which database?",
  options: [{ value: "0", label: "Postgres", description: "Managed" }, { value: "1", label: "SQLite" }],
};
const freeform: PiSdkUiRequestPayload = { origin: "tool", kind: "text", title: "Why", message: "Why that one?" };
const approval: PiSdkUiRequestPayload = { origin: "approval", kind: "confirm", title: "Run bash?", message: "npm test" };

describe("piUiRequestToPendingInput", () => {
  it("builds a pick-only card for a choice prompt", () => {
    const request = piUiRequestToPendingInput("req-1", question, "turn-1");
    expect(request).toMatchObject({ requestId: "req-1", itemId: "req-1", source: "pi", kind: "structured_question", turnId: "turn-1" });
    // Free text cannot map back to an option id, which is what Pi expects.
    expect(request.allowsFreeform).toBe(false);
    expect(request.questions[0]).toMatchObject({ id: PI_UI_ANSWER_ID, header: "Database", allowsFreeform: false });
    expect(request.questions[0]!.options).toEqual([
      { label: "Postgres", value: "0", description: "Managed" },
      { label: "SQLite", value: "1" },
    ]);
  });

  it("builds a freeform card when the prompt has no options", () => {
    const request = piUiRequestToPendingInput("req-2", freeform, null);
    expect(request.kind).toBe("question");
    expect(request.allowsFreeform).toBe(true);
    expect(request.questions[0]!.options).toBeUndefined();
  });

  it("carries an editor's starting text onto the card", () => {
    // A Pi extension's `editor` prefill is the document being edited, so the
    // card has to surface it rather than dropping it.
    const request = piUiRequestToPendingInput("req-5", { ...freeform, defaultValue: "existing draft" }, null);
    expect(request.questions[0]!.defaultAssumption).toBe("existing draft");
  });

  it("marks a secret prompt so the answer is not echoed", () => {
    const request = piUiRequestToPendingInput("req-3", { ...freeform, kind: "secret" }, null);
    expect(request.questions[0]!.isSecret).toBe(true);
  });

  it("renders an approval as an approval card", () => {
    expect(piUiRequestToPendingInput("req-4", approval, null).kind).toBe("approval");
  });
});

describe("piUiResponseFromAnswer", () => {
  it("returns the chosen option value", () => {
    expect(piUiResponseFromAnswer(question, { decision: "accept", answers: { [PI_UI_ANSWER_ID]: "1" } }))
      .toEqual({ ok: true, value: "1" });
  });

  it("unwraps a multi-select answer and falls back to free text", () => {
    expect(piUiResponseFromAnswer(question, { decision: "accept", answers: { [PI_UI_ANSWER_ID]: ["0"] } }))
      .toEqual({ ok: true, value: "0" });
    expect(piUiResponseFromAnswer(freeform, { decision: "accept", responseText: "because it is simple" }))
      .toEqual({ ok: true, value: "because it is simple" });
  });

  it("reports a dismissed or declined card as unanswered", () => {
    expect(piUiResponseFromAnswer(question, { decision: "cancel" })).toEqual({ ok: false });
    expect(piUiResponseFromAnswer(question, { decision: "decline" })).toEqual({ ok: false });
  });

  it("keeps an approval an allow even when the surface attaches a comment", () => {
    expect(piUiResponseFromAnswer(approval, { decision: "accept", responseText: "looks fine" }))
      .toEqual({ ok: true, value: PI_APPROVAL_ALLOW });
  });

  it("maps an approval decision onto the value the gate reads", () => {
    expect(piUiResponseFromAnswer(approval, { decision: "accept" })).toEqual({ ok: true, value: PI_APPROVAL_ALLOW });
    expect(piUiResponseFromAnswer(approval, { decision: "accept_for_session" }))
      .toEqual({ ok: true, value: PI_APPROVAL_ALLOW_SESSION });
    // An approval with no decision at all is a denial, never a silent allow.
    expect(piUiResponseFromAnswer(approval, {})).toEqual({ ok: false });
  });
});

describe("piUiNoticeToChatEvents", () => {
  it("renders progress as transient activity and anything else as a notice", () => {
    expect(piUiNoticeToChatEvents({ origin: "extension", level: "progress", message: "indexing" }, "turn-1"))
      .toEqual([{ type: "activity", activity: "working", detail: "indexing", turnId: "turn-1" }]);
    expect(piUiNoticeToChatEvents({ origin: "extension", level: "warn", message: "skipped" }))
      .toEqual([{ type: "system_notice", noticeKind: "warning", message: "skipped" }]);
  });

  it("drops an empty message rather than emitting a blank row", () => {
    expect(piUiNoticeToChatEvents({ origin: "tool", level: "info", message: "   " })).toEqual([]);
  });
});

describe("piExtensionLoadNotice", () => {
  it("names the extensions that loaded", () => {
    const [notice] = piExtensionLoadNotice([{ id: "/x/git-info/index.ts", name: "git-info" }], null);
    expect(notice).toMatchObject({ type: "system_notice", noticeKind: "info" });
    expect((notice as { message: string }).message).toContain("git-info");
  });

  it("says which tools this Pi build cannot gate", () => {
    const [notice] = piExtensionLoadNotice(undefined, null, ["bash", "write"]);
    expect(notice).toMatchObject({ noticeKind: "warning" });
    expect((notice as { message: string }).message).toContain("bash, write");
  });

  it("reports a load failure separately from a clean empty list", () => {
    expect(piExtensionLoadNotice([], null)).toEqual([]);
    const events = piExtensionLoadNotice([], "bad.ts: boom");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ noticeKind: "warning" });
  });
});
