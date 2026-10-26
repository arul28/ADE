import { describe, expect, it } from "vitest";
import type { TerminalSessionSummary } from "../../shared/types/sessions";
import { sessionStatusChangeModel } from "./sessionStatusChange";

/**
 * The status menu's contract: it must never offer a move the row cannot hold.
 *
 * The case that produced this menu: a live chat with a stale `ade chat ask`
 * marker reads "Needs you" while the model is working, and the only offered
 * fix used to be dragging a board card. Working is the honest answer there —
 * and it is the one case where it is.
 */

function row(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    title: "Chat",
    status: "running",
    startedAt: "2026-10-26T12:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    // A chat row (`isChatToolType`) so the canonical state machine treats
    // "running" as a between-turns chat status rather than a live PTY.
    toolType: "claude-chat",
    runtimeState: "running",
    ...overrides,
  } as TerminalSessionSummary;
}

function option(model: ReturnType<typeof sessionStatusChangeModel>, target: string) {
  const found = model.options.find((entry) => entry.target === target);
  if (!found) throw new Error(`missing ${target}`);
  return found;
}

describe("sessionStatusChangeModel", () => {
  it("offers Working for a live row that is only being held by a stale ask", () => {
    const model = sessionStatusChangeModel({
      session: row({
        runtimeState: "running",
        attentionRequestedAt: "2026-10-26T12:45:51.379Z",
        attentionSource: "agent_explicit",
      }),
      nowMs: Date.parse("2026-10-26T13:30:00.000Z"),
    });

    expect(option(model, "working")).toMatchObject({ enabled: true, reason: null, current: false });
    expect(option(model, "needs_you")).toMatchObject({ current: true, enabled: true });
    expect(model.currentLabel).toBe("Needs you");
  });

  it("refuses Working for an idle row instead of moving it somewhere it cannot stay", () => {
    const model = sessionStatusChangeModel({
      session: row({ runtimeState: "idle" }),
      nowMs: Date.parse("2026-10-26T13:30:00.000Z"),
    });

    expect(option(model, "working")).toMatchObject({
      enabled: false,
      reason: "Nothing is running — send a message to start it",
    });
  });

  it.each([
    [
      "a live provider card",
      row({ runtimeState: "running", pendingInputItemId: "item-1" }),
      "Answer the open question first",
      { working: false, done: false },
    ],
    [
      "a failed turn at rest",
      row({ runtimeState: "idle", lastTurnFailedAt: "2026-10-26T12:00:00.000Z" }),
      "The last turn failed — send a message to retry",
      { working: false, done: true },
    ],
    [
      "a detached chat",
      row({ runtimeState: "exited", status: "detached" }),
      "The session has ended",
      { working: false, done: true },
    ],
    [
      // ADE's idle-prompt guess can be a false alarm, so its hand stays dismissable.
      "a tracked CLI whose idle-prompt hand ADE recorded",
      row({
        toolType: "codex",
        runtimeState: "waiting-input",
        attentionSource: "cli_prompt",
        attentionRequestedAt: "2026-10-26T13:00:00.000Z",
      }),
      "Nothing is running — send a message to start it",
      { working: false, done: true },
    ],
  ])("refuses the moves %s cannot hold", (_label, session, reason, expected) => {
    const model = sessionStatusChangeModel({
      session,
      nowMs: Date.parse("2026-10-26T13:30:00.000Z"),
    });
    expect(option(model, "working")).toMatchObject({ enabled: expected.working, reason });
    expect(option(model, "done").enabled).toBe(expected.done);
  });

  it("names the derived wait rather than offering a move that files straight back", () => {
    const model = sessionStatusChangeModel({
      session: row({ runtimeState: "running" }),
      waitingReason: "ci",
      nowMs: Date.parse("2026-10-26T13:30:00.000Z"),
    });

    expect(option(model, "working")).toMatchObject({
      enabled: false,
      reason: "CI running — it files back here until that clears",
    });
    expect(model.currentLabel).toBe("Waiting · CI running");
  });

  it("marks a settled row Done and leaves Working refused", () => {
    const model = sessionStatusChangeModel({
      session: row({ runtimeState: "idle", settledAt: "2026-10-26T12:00:00.000Z" }),
      nowMs: Date.parse("2026-10-26T13:30:00.000Z"),
    });

    expect(option(model, "done")).toMatchObject({ current: true, enabled: true });
    expect(option(model, "working").enabled).toBe(false);
  });

  it("keeps Working available for a snoozed row that is genuinely live", () => {
    const model = sessionStatusChangeModel({
      session: row({
        runtimeState: "running",
        snoozedUntil: "2026-10-26T18:00:00.000Z",
        snoozedAt: "2026-10-26T13:00:00.000Z",
      }),
      nowMs: Date.parse("2026-10-26T13:30:00.000Z"),
    });

    expect(model.snoozed).toBe(true);
    expect(option(model, "working")).toMatchObject({ enabled: true, current: false });
    expect(model.currentLabel).toBe("Snoozed");
  });
});
