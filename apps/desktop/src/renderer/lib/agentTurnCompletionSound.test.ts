/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAgentTurnCompletionSoundDebounce,
  playAgentTurnCompletionSound,
} from "./agentTurnCompletionSound";

describe("playAgentTurnCompletionSound", () => {
  beforeEach(() => {
    __resetAgentTurnCompletionSoundDebounce();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("no-ops when AudioContext is unavailable", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    expect(() => playAgentTurnCompletionSound("chime")).not.toThrow();
  });

  it("resumes suspended context then schedules close after the audio tail", async () => {
    vi.useFakeTimers();
    try {
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

      playAgentTurnCompletionSound("ping");
      await vi.waitFor(() => {
        expect(resume).toHaveBeenCalled();
      });
      await Promise.resolve();
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(449);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scales the gain node's peak target by volume", () => {
    const rampCalls: Array<[unknown, unknown]> = [];
    class MockAudioContext {
      state = "running";
      currentTime = 0;
      destination = {} as AudioDestinationNode;
      resume = vi.fn(() => Promise.resolve());
      close = vi.fn(() => Promise.resolve());
      createOscillator() {
        return {
          type: "sine",
          frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        } as unknown as OscillatorNode;
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn((value: unknown, time: unknown) => rampCalls.push([value, time])),
          },
          connect: vi.fn(),
        } as unknown as GainNode;
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext as unknown as typeof AudioContext);

    playAgentTurnCompletionSound("ping", { volume: 0.25 });

    // Ping schedules one oscillator + gain. The first ramp is the peak (duration 0.12, peak target 0.12 * volume).
    expect(rampCalls.length).toBeGreaterThan(0);
    const [peakValue] = rampCalls[0];
    expect(peakValue).toBeCloseTo(0.12 * 0.25, 4);
  });

  it("returns without playing when volume is 0", () => {
    const ctor = vi.fn();
    vi.stubGlobal("AudioContext", ctor as unknown as typeof AudioContext);

    playAgentTurnCompletionSound("chime", { volume: 0 });

    expect(ctor).not.toHaveBeenCalled();
  });

  it("drops the second call inside the 1.5s debounce window", () => {
    const ctor = vi.fn(function (this: { state: string; currentTime: number; destination: unknown; resume: () => Promise<void>; close: () => Promise<void>; createOscillator: () => unknown; createGain: () => unknown }) {
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
      this.resume = () => Promise.resolve();
      this.close = () => Promise.resolve();
      this.createOscillator = () => ({
        type: "sine",
        frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
        start: () => {},
        stop: () => {},
      });
      this.createGain = () => ({
        gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
      });
    });
    vi.stubGlobal("AudioContext", ctor as unknown as typeof AudioContext);

    playAgentTurnCompletionSound("ping");
    playAgentTurnCompletionSound("ping");

    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when skipWhenFocused=true and the document has focus", () => {
    const ctor = vi.fn();
    vi.stubGlobal("AudioContext", ctor as unknown as typeof AudioContext);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    playAgentTurnCompletionSound("ping", { skipWhenFocused: true });

    expect(ctor).not.toHaveBeenCalled();
  });
});
