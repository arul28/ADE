import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginComposerContext, PluginLaneContext } from "../../../../shared/plugins/context";
import {
  applyPluginComposerEdit,
  pluginComposerSessionId,
  registerPluginComposerTarget,
  resetPluginComposerTargets,
} from "./composerTarget";

/**
 * Routing an edit to the right draft, and refusing to invent one.
 *
 * The interesting cases are all about WHICH composer: an action invoked from a
 * chat row must not write into whichever pane happens to be frontmost, and an
 * action invoked with no composer anywhere must not silently succeed.
 */

function target(overrides: { sessionId?: string | null } = {}) {
  const insertText = vi.fn();
  const replaceText = vi.fn();
  return { sessionId: null, ...overrides, insertText, replaceText };
}

const LANE_CONTEXT: PluginLaneContext = {
  kind: "lane",
  id: "lane-1",
  name: "Feature",
  branch: "feature",
  machineKey: null,
  dirty: false,
};

function composerContext(sessionId: string | null): PluginComposerContext {
  return {
    kind: "composer",
    sessionId,
    projectKey: null,
    projectRoot: null,
    laneId: null,
    draft: "",
    cursor: null,
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetPluginComposerTargets();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  resetPluginComposerTargets();
});

describe("applying a composer edit", () => {
  it("routes each verb to its own handler", () => {
    const composer = target({ sessionId: "chat-1" });
    registerPluginComposerTarget("a", composer);

    applyPluginComposerEdit(
      { mode: "insert", text: "TODO: " },
      { context: composerContext("chat-1"), pluginId: "prompts", actionId: "todo" },
    );
    applyPluginComposerEdit(
      { mode: "replace", text: "all new" },
      { context: composerContext("chat-1"), pluginId: "prompts", actionId: "rewrite" },
    );

    expect(composer.insertText).toHaveBeenCalledWith("TODO: ");
    expect(composer.replaceText).toHaveBeenCalledWith("all new");
  });

  it("prefers the composer bound to the invoking chat over the frontmost one", () => {
    const first = target({ sessionId: "chat-1" });
    const second = target({ sessionId: "chat-2" });
    registerPluginComposerTarget("a", first);
    registerPluginComposerTarget("b", second);

    applyPluginComposerEdit(
      { mode: "insert", text: "x" },
      { context: composerContext("chat-1"), pluginId: "p", actionId: "a" },
    );

    expect(first.insertText).toHaveBeenCalledWith("x");
    expect(second.insertText).not.toHaveBeenCalled();
  });

  // The verb belongs to the response, not to the socket kind: a row menu item
  // on a chat row can return one, and it should reach that chat.
  it("routes a session-scoped invocation to that session's composer", () => {
    const chat = target({ sessionId: "chat-9" });
    registerPluginComposerTarget("a", target({ sessionId: "chat-1" }));
    registerPluginComposerTarget("b", chat);

    applyPluginComposerEdit(
      { mode: "insert", text: "y" },
      {
        context: { kind: "session", id: "chat-9", title: "", provider: null, status: null },
        pluginId: "p",
        actionId: "a",
      },
    );

    expect(chat.insertText).toHaveBeenCalledWith("y");
  });

  // A hero composer has no session to match on, and refusing the edit there
  // would make a prompt-template button dead on the screen it is most useful.
  it("falls back to the most recently registered composer", () => {
    const older = target({ sessionId: "chat-1" });
    const newer = target({ sessionId: null });
    registerPluginComposerTarget("a", older);
    registerPluginComposerTarget("b", newer);

    applyPluginComposerEdit(
      { mode: "replace", text: "z" },
      { context: composerContext(null), pluginId: "p", actionId: "a" },
    );

    expect(newer.replaceText).toHaveBeenCalledWith("z");
    expect(older.replaceText).not.toHaveBeenCalled();
  });

  it("re-registering moves a composer to the front of that fallback", () => {
    const first = target({ sessionId: null });
    const second = target({ sessionId: null });
    registerPluginComposerTarget("a", first);
    registerPluginComposerTarget("b", second);
    registerPluginComposerTarget("a", first);

    applyPluginComposerEdit(
      { mode: "insert", text: "q" },
      { context: null, pluginId: "p", actionId: "a" },
    );

    expect(first.insertText).toHaveBeenCalledWith("q");
    expect(second.insertText).not.toHaveBeenCalled();
  });

  // Dropped, never queued: a draft that surfaced under an unrelated chat
  // minutes later would be worse than nothing happening.
  it("drops the edit with a warning when no composer is on screen", () => {
    const landed = applyPluginComposerEdit(
      { mode: "insert", text: "x" },
      { context: LANE_CONTEXT, pluginId: "graph", actionId: "note" },
    );

    expect(landed).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("no composer");
  });

  it("stops routing to a composer that unregistered", () => {
    const composer = target({ sessionId: "chat-1" });
    const unregister = registerPluginComposerTarget("a", composer);
    unregister();

    expect(applyPluginComposerEdit(
      { mode: "insert", text: "x" },
      { context: composerContext("chat-1"), pluginId: "p", actionId: "a" },
    )).toBe(false);
    expect(composer.insertText).not.toHaveBeenCalled();
  });
});

describe("the session an edit is routed by", () => {
  it("reads a composer's own chat, a session row's chat, and nothing else", () => {
    expect(pluginComposerSessionId(composerContext("chat-1"))).toBe("chat-1");
    expect(pluginComposerSessionId({ kind: "session", id: "chat-2", title: "", provider: null, status: null }))
      .toBe("chat-2");
    expect(pluginComposerSessionId(LANE_CONTEXT)).toBeNull();
    expect(pluginComposerSessionId(null)).toBeNull();
  });
});
