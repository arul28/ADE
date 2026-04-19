/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { playAgentTurnCompletionSound } from "./agentTurnCompletionSound";
describe("playAgentTurnCompletionSound", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("no-ops when AudioContext is unavailable", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    expect(() => playAgentTurnCompletionSound("chime")).not.toThrow();
  });

  it("resumes suspended context then schedules close", async () => {
    const resume = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    class MockAudioContext {
      state = "suspended";
      currentTime = 0;
      destination = {} as AudioDestinationNode;
      resume = resume;
      close = close;
      createOscillator() {
        const osc = {
          type: "sine",
          frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        return osc as unknown as OscillatorNode;
      }
      createGain() {
        const gain = {
          gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
        };
        return gain as unknown as GainNode;
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext as unknown as typeof AudioContext);
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: TimerHandler) => {
      if (typeof fn === "function") fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    playAgentTurnCompletionSound("ping");
    await vi.waitFor(() => {
      expect(resume).toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    });
  });
});
