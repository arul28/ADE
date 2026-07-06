import { describe, expect, it } from "vitest";
import {
  canonicalSessionState,
  SESSION_STALE_AFTER_MS,
  type CanonicalSessionInputs,
} from "./sessionCanonicalState";

const NOW = Date.parse("2026-07-06T12:00:00.000Z");
const promptLikePreview = (preview: string | null | undefined) =>
  Boolean(preview && /\(y\/n\)/i.test(preview));
const chatTools = new Set(["claude-chat", "cursor"]);
const isChatTool = (toolType: string | null | undefined) => Boolean(toolType && chatTools.has(toolType));

function state(overrides: Partial<CanonicalSessionInputs>) {
  return canonicalSessionState({
    status: "running",
    runtimeState: "running",
    toolType: "claude",
    nowMs: NOW,
    previewSuggestsNeedsInput: promptLikePreview,
    isChatTool,
    ...overrides,
  });
}

describe("canonicalSessionState precedence", () => {
  const silentSince = new Date(NOW - SESSION_STALE_AFTER_MS - 1_000).toISOString();

  // Table: deterministic signals must outrank everything below them, and the
  // preview heuristic must never outvote a deterministic runtime state.
  const cases: Array<[string, Partial<CanonicalSessionInputs>, string, string | null]> = [
    ["pendingInputItemId wins over stale silence", { pendingInputItemId: "i-1", lastActivityAt: silentSince }, "needs_you", "Needs you"],
    ["waiting-input wins over stale silence", { runtimeState: "waiting-input", lastActivityAt: silentSince }, "needs_you", "Needs you"],
    ["waiting-input wins even when preview looks calm", { runtimeState: "waiting-input", lastOutputPreview: "compiling..." }, "needs_you", "Needs you"],
    ["pendingInputItemId wins on an ended session", { pendingInputItemId: "i-1", status: "detached", exitCode: 1 }, "needs_you", "Needs you"],
    ["non-zero exit is failed", { status: "detached", exitCode: 2 }, "failed", "Failed"],
    ["persisted failed status with null exit is failed (spawn failure)", { status: "failed", exitCode: null, runtimeState: "exited" }, "failed", "Failed"],
    ["killed runtime is failed", { status: "detached", runtimeState: "killed", exitCode: null }, "failed", "Failed"],
    ["running + silent past threshold is stale", { lastActivityAt: silentSince }, "stale", "Stale"],
    ["stale wins over a prompt-looking preview", { lastActivityAt: silentSince, lastOutputPreview: "continue? (y/n)" }, "stale", "Stale"],
    ["heuristic upgrades plain running LAST", { lastOutputPreview: "continue? (y/n)" }, "needs_you", "Needs you"],
    ["plain running stays running (no badge)", { lastOutputPreview: "compiling..." }, "running", null],
    ["idle chat is ready (no badge)", { runtimeState: "idle", toolType: "claude-chat" }, "ready", null],
    ["idle CLI is idle (no badge)", { runtimeState: "idle" }, "idle", null],
    ["heuristic does NOT fire on idle sessions", { runtimeState: "idle", lastOutputPreview: "continue? (y/n)" }, "idle", null],
    ["clean exit is ended (no badge)", { status: "detached", exitCode: 0 }, "ended", null],
    ["ended chat is ready (no badge)", { status: "detached", toolType: "claude-chat", exitCode: null }, "ready", null],
  ];

  it.each(cases)("%s", (_name, overrides, phase, label) => {
    const result = state(overrides);
    expect(result.phase).toBe(phase);
    expect(result.badge?.label ?? null).toBe(label);
    // Attention states and ONLY attention states carry a badge.
    expect(result.badge !== null).toBe(["needs_you", "failed", "stale"].includes(phase));
  });
});

describe("stale boundary", () => {
  it("flips exactly at the threshold, not before", () => {
    const justUnder = new Date(NOW - SESSION_STALE_AFTER_MS + 1_000).toISOString();
    const exactly = new Date(NOW - SESSION_STALE_AFTER_MS).toISOString();
    expect(state({ lastActivityAt: justUnder }).phase).toBe("running");
    expect(state({ lastActivityAt: exactly }).phase).toBe("stale");
  });

  it("never goes stale without an activity timestamp or with garbage", () => {
    expect(state({ lastActivityAt: null }).phase).toBe("running");
    expect(state({ lastActivityAt: "not-a-date" }).phase).toBe("running");
  });
});
