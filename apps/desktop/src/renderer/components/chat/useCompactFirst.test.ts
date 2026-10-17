/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ClaudePromptCache } from "../../../shared/claudePromptCache";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { useCompactFirst } from "./useCompactFirst";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const MIN = 60_000;
const doneAt = (sessionId: string, minutesAgo: number): AgentChatEventEnvelope => ({
  sessionId,
  timestamp: new Date(NOW - minutesAgo * MIN).toISOString(),
  event: { type: "done", turnId: `turn-${minutesAgo}`, status: "completed" },
}) as AgentChatEventEnvelope;

type Props = { events: AgentChatEventEnvelope[]; sessionId: string; cache?: ClaudePromptCache | null };
const mount = (initialProps: Props) =>
  renderHook(({ events, sessionId, cache }: Props) => useCompactFirst(events, sessionId, cache), { initialProps });

describe("useCompactFirst", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens the offer when the chat's own cache lifetime has passed, counted from the last request", () => {
    // A 5-minute cache: the turn ended 2 minutes ago, its last request started 4 minutes ago.
    const chat = { events: [doneAt("a", 2)], sessionId: "a", cache: { ttl: "5m" as const, since: new Date(NOW - 4 * MIN).toISOString() } };
    const view = mount(chat);
    expect(view.result.current.idleWindowOpen).toBe(false);
    act(() => {
      vi.advanceTimersByTime(MIN + 1);
    });
    expect(view.result.current.idleWindowOpen).toBe(true);

    // The same idle time is nowhere near enough for a 1-hour cache, or for an unknown one.
    view.rerender({ ...chat, cache: { ttl: "1h" } });
    expect(view.result.current.idleWindowOpen).toBe(false);
    view.rerender({ ...chat, cache: null });
    expect(view.result.current.idleWindowOpen).toBe(false);
  });

  it("keeps a chat's choice through a visit to another chat and drops it when that chat's next turn ends", () => {
    const chatA = { events: [doneAt("a", 90)], sessionId: "a" };
    const chatB = { events: [doneAt("b", 80)], sessionId: "b" };
    const view = mount(chatA);
    expect(view.result.current.choice).toBeNull();

    act(() => view.result.current.setChoice({ sessionId: "a", value: false, dismissed: true }));
    expect(view.result.current.choice).toMatchObject({ value: false, dismissed: true });

    // Another chat has no choice of its own, and coming back finds the dismissal still in force.
    view.rerender(chatB);
    expect(view.result.current.choice).toBeNull();
    view.rerender(chatA);
    expect(view.result.current.choice).toMatchObject({ value: false, dismissed: true });

    // A new turn ended in that chat: the choice covered one send and is gone.
    view.rerender({ ...chatA, events: [...chatA.events, doneAt("a", 1)] });
    expect(view.result.current.choice).toBeNull();
  });
});
