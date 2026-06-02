import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeLaunchedLanesHighlight,
  rememberLaunchedLanes,
  subscribeLaunchedLanesHighlight,
} from "./launchedLanesHighlight";

describe("rememberLaunchedLanes", () => {
  afterEach(() => {
    consumeLaunchedLanesHighlight();
  });

  it("does not publish lane-only creates into the agent-loading highlight path", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLaunchedLanesHighlight(listener);
    try {
      rememberLaunchedLanes({ laneIds: ["lane-only"], sessionIds: [] });

      expect(listener).not.toHaveBeenCalled();
      expect(consumeLaunchedLanesHighlight()).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it("keeps lane ids when launched agent sessions are expected", () => {
    rememberLaunchedLanes({ laneIds: ["lane-agent"], sessionIds: ["session-agent"] });

    expect(consumeLaunchedLanesHighlight()).toMatchObject({
      laneIds: ["lane-agent"],
      sessionIds: ["session-agent"],
    });
  });
});
