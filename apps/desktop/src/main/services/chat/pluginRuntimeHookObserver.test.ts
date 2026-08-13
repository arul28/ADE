import { afterEach, describe, expect, it } from "vitest";

import type { AgentChatEvent } from "../../../shared/types";
import {
  resetPluginRuntimeHookListenersForTests,
  subscribeToPluginRuntimeHooks,
  type PluginRuntimeHookEmission,
} from "../plugins/pluginRuntimeHooks";
import { createPluginRuntimeHookObserver } from "./pluginRuntimeHookObserver";

/**
 * The observe-only runtime hooks, at the chat runtime's end.
 *
 * These pin the two things the tier is defined by — which lifecycle points
 * produce a hook, and what a hook is allowed to carry — because both are
 * promises to plugin authors rather than implementation details. The payload
 * shape assertions are deliberately exact (`toEqual`, not `toMatchObject`): the
 * whole argument for the observe tier is that a plugin sees metadata and never
 * content, and a test that only checked for the presence of the metadata would
 * pass just as happily on the day someone attaches the tool's arguments.
 */

function collect(): { seen: PluginRuntimeHookEmission[]; stop: () => void } {
  const seen: PluginRuntimeHookEmission[] = [];
  const stop = subscribeToPluginRuntimeHooks((emission) => seen.push(emission));
  return { seen, stop };
}

afterEach(resetPluginRuntimeHookListenersForTests);

describe("plugin runtime hook observer", () => {
  it("does nothing at all when no plugin is listening", () => {
    // The gate matters because this runs inside the chat service's commit path,
    // which is the hot path for every event of every turn on the machine. With
    // nobody subscribed — a headless CLI, a machine with no plugins — the cost
    // has to be one set-size read, not a payload built and thrown away.
    const observer = createPluginRuntimeHookObserver({ projectRoot: "/repo" });
    expect(() => {
      observer.observe({
        sessionId: "session-1",
        runtime: "claude",
        model: "sonnet",
        event: { type: "status", turnStatus: "started", turnId: "turn-1" },
      });
    }).not.toThrow();
  });

  it("emits turn.start with metadata only", () => {
    const { seen, stop } = collect();
    try {
      const observer = createPluginRuntimeHookObserver({ projectRoot: "/repo" });
      observer.observe({
        sessionId: "session-1",
        runtime: "claude",
        model: "claude-sonnet-4-5",
        event: { type: "status", turnStatus: "started", turnId: "turn-1" },
      });

      expect(seen).toEqual([{
        event: "turn.start",
        sessionId: "session-1",
        projectRoot: "/repo",
        runtime: "claude",
        model: "claude-sonnet-4-5",
      }]);
    } finally {
      stop();
    }
  });

  it("emits tool.before with the tool's NAME and nothing else", () => {
    const { seen, stop } = collect();
    try {
      const observer = createPluginRuntimeHookObserver({ projectRoot: "/repo" });
      observer.observe({
        sessionId: "session-1",
        runtime: "codex",
        model: null,
        event: {
          type: "tool_call",
          tool: "Bash",
          // A tool's arguments are the richest content in a turn — a shell
          // command, a patch, a path. The exact-match assertion below is what
          // keeps them on this side of the boundary.
          args: { command: "cat ~/.ssh/id_rsa", cwd: "/repo/secrets" },
          itemId: "item-1",
          turnId: "turn-1",
        },
      });

      expect(seen).toEqual([{
        event: "tool.before",
        sessionId: "session-1",
        projectRoot: "/repo",
        runtime: "codex",
        toolName: "Bash",
      }]);
      expect(JSON.stringify(seen)).not.toContain("id_rsa");
    } finally {
      stop();
    }
  });

  it("times a turn from its own start and maps the three outcomes", () => {
    const { seen, stop } = collect();
    try {
      let clock = 1_000;
      const observer = createPluginRuntimeHookObserver({ projectRoot: null, now: () => clock });

      const runTurn = (turnId: string, status: "completed" | "interrupted" | "failed"): void => {
        observer.observe({
          sessionId: "session-1",
          runtime: "cursor",
          model: null,
          event: { type: "status", turnStatus: "started", turnId },
        });
        clock += 250;
        observer.observe({
          sessionId: "session-1",
          runtime: "cursor",
          model: null,
          event: { type: "done", turnId, status },
        });
      };

      runTurn("turn-1", "completed");
      runTurn("turn-2", "interrupted");
      runTurn("turn-3", "failed");

      const ends = seen.filter((entry) => entry.event === "turn.end");
      expect(ends.map((entry) => entry.outcome)).toEqual(["completed", "cancelled", "error"]);
      // Every turn ran 250ms of the shared clock, and each one is timed from
      // ITS OWN start rather than from the last start the observer saw.
      expect(ends.map((entry) => entry.durationMs)).toEqual([250, 250, 250]);
      // No model on the session means no `model` key at all, rather than an
      // explicit null a plugin would have to test for separately.
      expect(seen.filter((entry) => entry.event === "turn.start").every((entry) => !("model" in entry))).toBe(true);
    } finally {
      stop();
    }
  });

  it("omits durationMs when the matching start was never seen", () => {
    const { seen, stop } = collect();
    try {
      const observer = createPluginRuntimeHookObserver({ projectRoot: null });
      // A turn already running when the plugin subscribed, or a runtime that
      // opened one without a turn id. Reporting a made-up duration would be
      // worse than reporting none.
      observer.observe({
        sessionId: "session-1",
        runtime: "droid",
        model: null,
        event: { type: "done", turnId: "turn-unseen", status: "completed" },
      });

      expect(seen).toEqual([{
        event: "turn.end",
        sessionId: "session-1",
        projectRoot: null,
        runtime: "droid",
        outcome: "completed",
      }]);
    } finally {
      stop();
    }
  });

  it("ignores every event that is not a turn boundary or a tool call", () => {
    const { seen, stop } = collect();
    try {
      const observer = createPluginRuntimeHookObserver({ projectRoot: "/repo" });
      const ignored: AgentChatEvent[] = [
        { type: "text", text: "the user's private draft" },
        { type: "reasoning", text: "chain of thought" },
        { type: "tool_result", tool: "Bash", result: "secret output", itemId: "item-1", status: "completed" },
        { type: "user_message", text: "a prompt" },
        { type: "error", message: "boom" },
        { type: "status", turnStatus: "completed", turnId: "turn-1" },
      ];
      for (const event of ignored) {
        observer.observe({ sessionId: "session-1", runtime: "claude", model: null, event });
      }

      expect(seen).toEqual([]);
    } finally {
      stop();
    }
  });

  it("reports one turn.start when a runtime announces the same turn twice", () => {
    const { seen, stop } = collect();
    try {
      let clock = 1_000;
      const observer = createPluginRuntimeHookObserver({ projectRoot: null, now: () => clock });

      // Codex's real sequence: ADE marks the turn live at dispatch before the
      // runtime has assigned an id, then the runtime answers with one. Two
      // transcript rows, one turn — and a plugin counting turns must see one.
      observer.observe({
        sessionId: "session-1",
        runtime: "codex",
        model: null,
        event: { type: "status", turnStatus: "started" },
      });
      clock += 40;
      observer.observe({
        sessionId: "session-1",
        runtime: "codex",
        model: null,
        event: { type: "status", turnStatus: "started", turnId: "turn-1" },
      });
      clock += 60;
      observer.observe({
        sessionId: "session-1",
        runtime: "codex",
        model: null,
        event: { type: "done", turnId: "turn-1", status: "completed" },
      });

      expect(seen.map((entry) => entry.event)).toEqual(["turn.start", "turn.end"]);
      // Timed from the FIRST announcement — the moment the turn actually went
      // live for the user, not the moment the runtime got around to naming it.
      expect(seen[1]).toMatchObject({ durationMs: 100 });
    } finally {
      stop();
    }
  });

  it("reports one turn.end when the same turn settles twice", () => {
    const { seen, stop } = collect();
    try {
      const observer = createPluginRuntimeHookObserver({ projectRoot: null });
      const done: AgentChatEvent = { type: "done", turnId: "turn-1", status: "completed" };
      observer.observe({
        sessionId: "session-1",
        runtime: "claude",
        model: null,
        event: { type: "status", turnStatus: "started", turnId: "turn-1" },
      });
      observer.observe({ sessionId: "session-1", runtime: "claude", model: null, event: done });
      observer.observe({ sessionId: "session-1", runtime: "claude", model: null, event: done });

      expect(seen.map((entry) => entry.event)).toEqual(["turn.start", "turn.end"]);
    } finally {
      stop();
    }
  });

  it("bounds its bookkeeping rather than growing it for turns that never end", () => {
    const { seen, stop } = collect();
    try {
      const observer = createPluginRuntimeHookObserver({ projectRoot: null });
      // A runtime that crashes mid-turn, or an abandoned session, leaves a
      // start with no end. 600 chats past the 512-entry cap: the oldest lose
      // their timing and nothing else — no unbounded map, no dropped hooks.
      for (let index = 0; index < 600; index += 1) {
        observer.observe({
          sessionId: `session-${index}`,
          runtime: "claude",
          model: null,
          event: { type: "status", turnStatus: "started", turnId: "turn-1" },
        });
      }
      for (const index of [0, 599]) {
        observer.observe({
          sessionId: `session-${index}`,
          runtime: "claude",
          model: null,
          event: { type: "done", turnId: "turn-1", status: "completed" },
        });
      }

      const ends = seen.filter((entry) => entry.event === "turn.end");
      expect(ends).toHaveLength(2);
      // Evicted: reported without a duration. Still held: reported with one.
      expect(ends[0]).not.toHaveProperty("durationMs");
      expect(ends[1]).toHaveProperty("durationMs");
    } finally {
      stop();
    }
  });

  it("survives a listener that throws", () => {
    const stop = subscribeToPluginRuntimeHooks(() => {
      throw new Error("plugin host blew up");
    });
    const { seen, stop: stopHealthy } = collect();
    try {
      const observer = createPluginRuntimeHookObserver({ projectRoot: null });
      // A hook is emitted from inside the commit that is writing the user's
      // transcript. A broken subscriber loses its notification; it does not
      // fail the turn, and it does not starve the subscribers after it.
      expect(() => {
        observer.observe({
          sessionId: "session-1",
          runtime: "claude",
          model: null,
          event: { type: "status", turnStatus: "started", turnId: "turn-1" },
        });
      }).not.toThrow();
      expect(seen).toHaveLength(1);
    } finally {
      stop();
      stopHealthy();
    }
  });
});
