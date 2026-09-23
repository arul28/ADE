import { describe, expect, it } from "vitest";
import type { AgentChatSession } from "../../../shared/types";
import {
  buildContextCompactEvent,
  createCompactionEmitterState,
  isContextCompactProvider,
  mapLegacyCompactionEvent,
} from "./contextCompactionEmitter";
import { createCursorSdkEventMapperState, mapCursorSdkMessageToChatEvents } from "./cursorSdkEventMapper";

const session = (provider: string) => ({ id: "s1", provider }) as unknown as AgentChatSession;

describe("buildContextCompactEvent", () => {
  it("keeps the pre-compaction size and detection on a started event", () => {
    const state = createCompactionEmitterState();
    const started = buildContextCompactEvent(state, session("cursor"), {
      trigger: "auto",
      state: "started",
      compactionId: "c1",
      preTokens: 180_000,
      detection: "provider",
      completedAtMs: 1_000,
    });
    expect(started).toMatchObject({ state: "started", preTokens: 180_000, detection: "provider", provider: "cursor" });

    const completed = buildContextCompactEvent(state, session("cursor"), {
      trigger: "auto",
      state: "completed",
      compactionId: "c1",
      postTokens: 40_000,
      detection: "provider",
      completedAtMs: 4_000,
    });
    expect(completed).toMatchObject({ state: "completed", postTokens: 40_000, durationMs: 3_000, detection: "provider" });
  });

  it("names the ACP providers", () => {
    const state = createCompactionEmitterState();
    for (const provider of ["qwen", "kimi", "grok", "copilot"]) {
      expect(buildContextCompactEvent(state, session(provider), { trigger: "auto" }).provider).toBe(provider);
    }
  });

  it("names no provider for a runtime that does not report compactions", () => {
    expect(isContextCompactProvider("claude")).toBe(true);
    expect(isContextCompactProvider("copilot")).toBe(true);
    expect(isContextCompactProvider("toString")).toBe(false);
    expect(isContextCompactProvider(null)).toBe(false);
    const state = createCompactionEmitterState();
    expect(buildContextCompactEvent(state, session("gemini"), { trigger: "auto" })).not.toHaveProperty("provider");
  });
});

describe("mapLegacyCompactionEvent", () => {
  it("counts each Cursor hook compaction and closes its started entry", () => {
    const state = createCompactionEmitterState();
    const cursor = session("cursor");
    const hook = (phase: "started" | "completed", seq: number) => mapCursorSdkMessageToChatEvents({
      type: "ade_cursor_compaction",
      phase,
      seq,
      trigger: "auto",
      contextTokens: 150_000,
      ...(phase === "completed" ? { durationMs: 2_500 } : {}),
    }, { turnId: "turn-1", cwd: "/repo", state: createCursorSdkEventMapperState() })
      .filter((event) => event.type === "context_compact");
    const counts: number[] = [];
    for (const seq of [1, 2]) {
      for (const phase of ["started", "completed"] as const) {
        const [event] = hook(phase, seq);
        const mapped = mapLegacyCompactionEvent(state, cursor, event!);
        expect(mapped).toMatchObject({ provider: "cursor", detection: "provider", preTokens: 150_000 });
        if (phase === "completed") {
          expect(mapped?.durationMs).toBe(2_500);
          counts.push(state.sessionCompactionCount);
        }
      }
    }
    expect(counts).toEqual([1, 2]);
    expect(state.startedAtByKey.size).toBe(0);
  });


  it("passes an inferred detection through", () => {
    const state = createCompactionEmitterState();
    const mapped = mapLegacyCompactionEvent(state, session("qwen"), {
      type: "context_compact",
      trigger: "auto",
      state: "completed",
      preTokens: 90_000,
      postTokens: 20_000,
      detection: "inferred",
    });
    expect(mapped).toMatchObject({ detection: "inferred", preTokens: 90_000, postTokens: 20_000, provider: "qwen" });
  });
});
