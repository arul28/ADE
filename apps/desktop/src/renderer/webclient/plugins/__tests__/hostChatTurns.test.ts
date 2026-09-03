/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/"}

/**
 * The chat-turn mapping both page hosts read one copy of.
 *
 * The functions under test are exported from the desktop relay host
 * (`components/plugins/sockets/PluginWebviewRelayHost.tsx`) because that is the
 * producer they were written for; the hosted web client's page host is their
 * second consumer, which is why the test lives beside it. They are pure, so
 * nothing here renders anything — which is the point of extracting them.
 */

import { describe, expect, it } from "vitest";

import {
  PLUGIN_WEBVIEW_CHAT_TURN_DEDUPE_MAX,
  createPluginWebviewChatTurnDedupe,
  pluginWebviewChatTurnFromEvent,
} from "../../../components/plugins/sockets/PluginWebviewRelayHost";
import {
  PLUGIN_WEBVIEW_CHAT_MESSAGE_MAX_CHARS,
  PLUGIN_WEBVIEW_CHAT_TURNS_MAX,
  PLUGIN_WEBVIEW_HOST_IDS_MAX,
  type PluginWebviewHostEvent,
} from "../../../../shared/plugins/webviewBridge";
import { coalesceHostEvents } from "../pageBridgeHost";

/** One chat event envelope, in the shape `agentChat.onEvent` delivers. */
function envelope(event: Record<string, unknown>, sessionId = "sess-1"): unknown {
  return { sessionId, timestamp: "2026-09-03T00:00:00.000Z", event };
}

describe("pluginWebviewChatTurnFromEvent", () => {
  it("maps a started status onto a started turn", () => {
    expect(pluginWebviewChatTurnFromEvent(envelope({ type: "status", turnStatus: "started", turnId: "t1" })))
      .toEqual({ sessionId: "sess-1", state: "started", turnId: "t1" });
  });

  it("maps done onto completed, and both bad endings onto failed", () => {
    expect(pluginWebviewChatTurnFromEvent(envelope({ type: "done", turnId: "t1", status: "completed" })))
      .toEqual({ sessionId: "sess-1", state: "completed", turnId: "t1" });
    expect(pluginWebviewChatTurnFromEvent(envelope({ type: "done", turnId: "t1", status: "failed" })))
      .toEqual({ sessionId: "sess-1", state: "failed", turnId: "t1" });
    // An interruption the reader caused is still not "Ready", so a page draws
    // it on the one error path it has.
    expect(pluginWebviewChatTurnFromEvent(envelope({ type: "done", turnId: "t1", status: "interrupted" })))
      .toEqual({ sessionId: "sess-1", state: "failed", turnId: "t1" });
  });

  it("carries the host's own sentence on an error", () => {
    expect(pluginWebviewChatTurnFromEvent(envelope({ type: "error", message: "The model refused." })))
      .toEqual({ sessionId: "sess-1", state: "failed", message: "The model refused." });
  });

  it("caps an error sentence at the shared ceiling", () => {
    const turn = pluginWebviewChatTurnFromEvent(
      envelope({ type: "error", message: "x".repeat(PLUGIN_WEBVIEW_CHAT_MESSAGE_MAX_CHARS + 50) }),
    );
    expect(turn?.message?.length).toBe(PLUGIN_WEBVIEW_CHAT_MESSAGE_MAX_CHARS);
  });

  it("publishes nothing for a delta, a non-started status, or a malformed envelope", () => {
    expect(pluginWebviewChatTurnFromEvent(envelope({ type: "delta", text: "hello" }))).toBeNull();
    // `done` is the authoritative end of a turn; reading the ending twice under
    // two event types would publish it twice.
    expect(pluginWebviewChatTurnFromEvent(envelope({ type: "status", turnStatus: "completed" }))).toBeNull();
    expect(pluginWebviewChatTurnFromEvent(envelope({ type: "status", turnStatus: "failed" }))).toBeNull();
    expect(pluginWebviewChatTurnFromEvent(envelope({ type: "done", turnId: "t1", status: "weird" }))).toBeNull();
    expect(pluginWebviewChatTurnFromEvent({ sessionId: "", event: { type: "status", turnStatus: "started" } })).toBeNull();
    expect(pluginWebviewChatTurnFromEvent({ sessionId: "sess-1" })).toBeNull();
    expect(pluginWebviewChatTurnFromEvent(null)).toBeNull();
    expect(pluginWebviewChatTurnFromEvent("nope")).toBeNull();
  });
});

describe("createPluginWebviewChatTurnDedupe", () => {
  it("lets a turn state through once and never twice", () => {
    const isNew = createPluginWebviewChatTurnDedupe();
    const started = { sessionId: "sess-1", state: "started", turnId: "t1" } as const;
    expect(isNew(started)).toBe(true);
    expect(isNew({ ...started })).toBe(false);
  });

  it("lets a new state of the same turn through", () => {
    const isNew = createPluginWebviewChatTurnDedupe();
    expect(isNew({ sessionId: "sess-1", state: "started", turnId: "t1" })).toBe(true);
    expect(isNew({ sessionId: "sess-1", state: "completed", turnId: "t1" })).toBe(true);
  });

  it("keeps two turns of one session apart, and two sessions apart", () => {
    const isNew = createPluginWebviewChatTurnDedupe();
    expect(isNew({ sessionId: "sess-1", state: "started", turnId: "t1" })).toBe(true);
    expect(isNew({ sessionId: "sess-1", state: "started", turnId: "t2" })).toBe(true);
    expect(isNew({ sessionId: "sess-2", state: "started", turnId: "t1" })).toBe(true);
  });

  it("stays bounded, evicting the oldest key first", () => {
    const isNew = createPluginWebviewChatTurnDedupe(3);
    for (const turnId of ["t1", "t2", "t3"]) {
      expect(isNew({ sessionId: "sess-1", state: "started", turnId })).toBe(true);
    }
    // Still remembered while it fits.
    expect(isNew({ sessionId: "sess-1", state: "started", turnId: "t3" })).toBe(false);
    // Two more evict t1 then t2; t1 is therefore new again, which is the cost
    // the bound buys and is bounded memory rather than a correctness claim.
    expect(isNew({ sessionId: "sess-1", state: "started", turnId: "t4" })).toBe(true);
    expect(isNew({ sessionId: "sess-1", state: "started", turnId: "t1" })).toBe(true);
  });

  it("ships a ceiling well above a batch launch", () => {
    expect(PLUGIN_WEBVIEW_CHAT_TURN_DEDUPE_MAX).toBeGreaterThan(PLUGIN_WEBVIEW_CHAT_TURNS_MAX);
  });
});

describe("coalesceHostEvents — chat frames", () => {
  /** Resolves with the frames one flush emitted, driven by the flush itself. */
  function collect(windowMs: number): {
    deliver: (event: PluginWebviewHostEvent) => void;
    flushed: Promise<PluginWebviewHostEvent[]>;
    cancel: () => void;
  } {
    const frames: PluginWebviewHostEvent[] = [];
    let resolve: (value: PluginWebviewHostEvent[]) => void = () => undefined;
    const flushed = new Promise<PluginWebviewHostEvent[]>((r) => {
      resolve = r;
    });
    const coalesced = coalesceHostEvents((event) => {
      frames.push(event);
      // The emit IS the signal: the test waits on the flush rather than on a
      // sleep longer than the window.
      queueMicrotask(() => resolve(frames));
    }, windowMs);
    return { deliver: coalesced.deliver, flushed, cancel: coalesced.cancel };
  }

  it("keeps the last state of a turn within one window", async () => {
    const { deliver, flushed } = collect(1);
    deliver({ kind: "chat", ids: ["sess-1"], overflow: false, turns: [{ sessionId: "sess-1", state: "started", turnId: "t1" }] });
    deliver({ kind: "chat", ids: ["sess-1"], overflow: false, turns: [{ sessionId: "sess-1", state: "failed", turnId: "t1", message: "boom" }] });
    const frames = await flushed;
    expect(frames).toEqual([
      {
        kind: "chat",
        ids: ["sess-1"],
        overflow: false,
        turns: [{ sessionId: "sess-1", state: "failed", turnId: "t1", message: "boom" }],
      },
    ]);
  });

  it("keeps two turns of one session side by side", async () => {
    const { deliver, flushed } = collect(1);
    deliver({ kind: "chat", ids: ["sess-1"], overflow: false, turns: [{ sessionId: "sess-1", state: "started", turnId: "t1" }] });
    deliver({ kind: "chat", ids: ["sess-1"], overflow: false, turns: [{ sessionId: "sess-1", state: "started", turnId: "t2" }] });
    const frames = await flushed;
    expect(frames[0]?.turns).toEqual([
      { sessionId: "sess-1", state: "started", turnId: "t1" },
      { sessionId: "sess-1", state: "started", turnId: "t2" },
    ]);
  });

  it("says overflow instead of carrying more turns than the cap", async () => {
    const { deliver, flushed } = collect(1);
    for (let index = 0; index < PLUGIN_WEBVIEW_CHAT_TURNS_MAX + 5; index += 1) {
      deliver({
        kind: "chat",
        // Ids stay under their own cap so this test is about the turn cap only.
        ids: [`sess-${index % PLUGIN_WEBVIEW_HOST_IDS_MAX}`],
        overflow: false,
        turns: [{ sessionId: `sess-${index}`, state: "started", turnId: `t${index}` }],
      });
    }
    const frames = await flushed;
    expect(frames[0]?.turns?.length).toBe(PLUGIN_WEBVIEW_CHAT_TURNS_MAX);
    expect(frames[0]?.overflow).toBe(true);
  });

  it("leaves an entity frame without a turns field at all", async () => {
    const { deliver, flushed } = collect(1);
    deliver({ kind: "lane", ids: ["lane-1"], overflow: false });
    const frames = await flushed;
    expect(frames[0]).toEqual({ kind: "lane", ids: ["lane-1"], overflow: false });
    expect("turns" in (frames[0] ?? {})).toBe(false);
  });
});
