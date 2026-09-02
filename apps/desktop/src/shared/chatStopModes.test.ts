import { describe, expect, it } from "vitest";
import {
  AGENT_CHAT_STOP_MODES,
  CLAUDE_PER_TASK_STOP_CONTROLS_REACHABLE,
  DEFAULT_AGENT_CHAT_STOP_MODE,
  SETTLE_TEARDOWN_STOP_MODE,
  chatStopModeCopy,
  formatBackgroundJobCount,
  isAgentChatStopMode,
  parseAgentChatStopMode,
  resolveAgentChatStopModeAlias,
  shouldDeclarePerTaskStopAffordance,
  stopModeClearsQueue,
  stopModeStopsBackground,
} from "./chatStopModes";

describe("chat stop matrix", () => {
  it("names all four queue × background combinations", () => {
    expect(AGENT_CHAT_STOP_MODES).toEqual([
      "stop_only",
      "stop_and_clear",
      "stop_and_background",
      "stop_and_clear_and_background",
    ]);
  });

  it("keeps stop_and_clear as the default so existing Stop-means-stop callers stay on the queue axis", () => {
    expect(DEFAULT_AGENT_CHAT_STOP_MODE).toBe("stop_and_clear");
    expect(stopModeClearsQueue("stop_and_clear")).toBe(true);
    expect(stopModeStopsBackground("stop_and_clear")).toBe(false);
  });

  it("keeps the user's queue on settle while still stopping background work", () => {
    expect(SETTLE_TEARDOWN_STOP_MODE).toBe("stop_and_background");
    expect(stopModeClearsQueue(SETTLE_TEARDOWN_STOP_MODE)).toBe(false);
    expect(stopModeStopsBackground(SETTLE_TEARDOWN_STOP_MODE)).toBe(true);
  });

  it("parses unknown stored modes back to the default instead of inventing a fifth axis", () => {
    expect(parseAgentChatStopMode("stop_only")).toBe("stop_only");
    expect(parseAgentChatStopMode("stop_and_clear_and_background")).toBe("stop_and_clear_and_background");
    expect(parseAgentChatStopMode("nope")).toBe("stop_and_clear");
    expect(parseAgentChatStopMode(undefined)).toBe("stop_and_clear");
    expect(isAgentChatStopMode("stop_and_background")).toBe(true);
    expect(isAgentChatStopMode("stop")).toBe(false);
  });

  it("spells live job count into the wireframe labels", () => {
    expect(formatBackgroundJobCount(0)).toBe("0 jobs");
    expect(formatBackgroundJobCount(1)).toBe("1 job");
    expect(formatBackgroundJobCount(3)).toBe("3 jobs");
    expect(chatStopModeCopy("stop_only", 3).label).toBe("Turn only");
    expect(chatStopModeCopy("stop_and_clear", 3).label).toBe("Turn + queue");
    expect(chatStopModeCopy("stop_and_background", 3).label).toBe("Turn + background (3 jobs)");
    expect(chatStopModeCopy("stop_and_clear_and_background", 1).label).toBe(
      "Turn + queue + background (1 job)",
    );
  });

  it("declares perTaskStopAffordance only when stopTask is exposed and the UI can reach it", () => {
    expect(shouldDeclarePerTaskStopAffordance({
      stopTaskExposed: false,
      stopControlsReachable: true,
    })).toBe(false);
    expect(shouldDeclarePerTaskStopAffordance({
      stopTaskExposed: true,
      stopControlsReachable: false,
    })).toBe(false);
    expect(shouldDeclarePerTaskStopAffordance({
      stopTaskExposed: true,
      stopControlsReachable: true,
    })).toBe(true);
    expect(CLAUDE_PER_TASK_STOP_CONTROLS_REACHABLE).toBe(true);
  });

  it("resolves hyphen, underscore, and flag aliases to the four-mode matrix", () => {
    expect(resolveAgentChatStopModeAlias("keep-queue")).toBe("stop_only");
    expect(resolveAgentChatStopModeAlias("clear-queue")).toBe("stop_and_clear");
    expect(resolveAgentChatStopModeAlias("background")).toBe("stop_and_background");
    expect(resolveAgentChatStopModeAlias("clear-and-background")).toBe("stop_and_clear_and_background");
    expect(resolveAgentChatStopModeAlias("stop_and_clear")).toBe("stop_and_clear");
    expect(resolveAgentChatStopModeAlias("nope")).toBeNull();
  });
});
