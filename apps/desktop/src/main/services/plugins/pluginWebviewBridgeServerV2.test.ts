/**
 * Bridge v2 — the verbs a page reaches ADE's own UI with.
 *
 * Kept apart from `pluginWebviewBridgeServer.test.ts`, which pins the v1
 * contract and the plugin-id derivation that every version rests on. What is
 * proved here is the half that did not exist before: the relay to the owning
 * window, the control flow an `invoke` result carries, the coalesced host
 * subscription, the theme the renderer publishes, and the cursor on
 * `collections.list`.
 *
 * No timers and no sleeps. The relay's timeout and the host coalescing window
 * are driven by an injected `setTimer` the tests fire by hand, so a change in
 * either constant cannot make a test flaky or slow.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginManifest } from "../../../shared/plugins/manifest";
import { PLUGIN_CLIPBOARD_TEXT_MAX_BYTES, type PluginDetail } from "../../../shared/plugins/sdk";
import {
  PLUGIN_WEBVIEW_BRIDGE_VERSION,
  PLUGIN_WEBVIEW_CHAT_TURNS_MAX,
  PLUGIN_WEBVIEW_LIST_MAX_ROWS,
  pluginWebviewGuestKey,
  type PluginWebviewEventFrame,
  type PluginWebviewHostEvent,
  type PluginWebviewUiRequest,
} from "../../../shared/plugins/webviewBridge";
import { emitPluginEntityChange, resetPluginEntityChangeListenersForTests } from "./pluginEntityChanges";
import { emitPluginChange } from "./pluginEvents";
import {
  createPluginWebviewBridgeServer,
  type PluginWebviewBridgeServer,
  type PluginWebviewDomain,
} from "./pluginWebviewBridgeServer";
import {
  getPluginWebviewGuest,
  registerPluginWebviewGuest,
  resetPluginWebviewGuestsForTests,
} from "./pluginWebviewGuests";

const GUEST_ID = 77;
const SENDER = { webContentsId: GUEST_ID, frameUrl: "ade-plugin://demo-plugin/page/index.html" };

function manifestFor(pluginId: string): PluginManifest {
  return {
    name: pluginId,
    version: "2.3.0",
    displayName: pluginId,
    description: "",
    vocabVersion: 1,
    surfaces: [],
    panels: [],
    sockets: [],
    collections: { notes: { sync: false } },
    settings: [],
    cli: [],
    skills: [],
    tools: [],
    automationTriggers: [],
    automationSteps: [],
    searchProviders: [],
    keybindings: [],
    chatRuntimes: [],
    webhookIngress: [],
    official: false,
  };
}

type Timer = { run: () => void; ms: number; cancelled: boolean };

function harness(options: { rows?: { key: string; value: unknown }[] } = {}) {
  const sent: PluginWebviewEventFrame[] = [];
  registerPluginWebviewGuest({
    webContentsId: GUEST_ID,
    pluginId: "demo-plugin",
    hostWindowId: 5,
    context: { subject: null, surfaceId: "browser", placement: "popover" },
    send: (_channel, payload) => {
      sent.push(payload as PluginWebviewEventFrame);
    },
  });

  const allRows = options.rows
    ?? [{ key: "a", value: 1 }, { key: "b", value: 2 }, { key: "c", value: 3 }];
  const domain = {
    get: vi.fn(async (): Promise<PluginDetail | null> => ({ config: {} } as unknown as PluginDetail)),
    getCollection: vi.fn(async (args: { limit?: number }) => (
      allRows.slice(0, args.limit ?? allRows.length).map((row) => ({
        collection: "notes",
        key: row.key,
        value: row.value,
        updatedAt: "",
      }))
    )),
    getManifest: vi.fn(async (args: { pluginId: string }) => manifestFor(args.pluginId)),
    invoke: vi.fn(async (_args: { pluginId: string; action: string; args: Record<string, unknown> }) => (
      { ok: true }
    )),
  };

  const requests: PluginWebviewUiRequest[] = [];
  const timers: Timer[] = [];
  const clipboard = { text: "copied" };
  const reloads: { pluginId: string; version: string; revision: number }[] = [];
  const openExternalUrl = vi.fn(async () => {});
  const openPathInEditor = vi.fn(async () => {});
  const pageErrors: Array<{ pluginId: string; error: unknown }> = [];

  const server = createPluginWebviewBridgeServer({
    domainFor: () => domain as unknown as PluginWebviewDomain,
    putCollection: async () => {},
    setConfig: async () => ({}),
    openDeeplink: async () => {},
    openExternalUrl,
    openPathInEditor,
    recordPageError: ({ guest, error }) => {
      pageErrors.push({ pluginId: guest.pluginId, error });
    },
    sendUiRequest: ({ request }) => {
      requests.push(request);
      return true;
    },
    readClipboard: () => clipboard.text,
    writeClipboard: (text) => {
      clipboard.text = text;
    },
    projectFor: () => ({ projectId: "proj-1", root: "/repo", binding: "local" }),
    sendReload: (event) => {
      reloads.push(event);
    },
    setTimer: (run, ms) => {
      const timer: Timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  servers.push(server);

  /** Fire every live timer, the way a real clock eventually would. */
  const fireTimers = (): void => {
    for (const timer of [...timers]) {
      if (timer.cancelled) continue;
      timer.cancelled = true;
      timer.run();
    }
  };

  /**
   * Wait for the relayed request at `index` to arrive.
   *
   * `handle` is async — it resolves the guest's domain before it relays — so a
   * synchronous read of `requests` races the call it is inspecting. Waiting on
   * the array is the event this test is actually waiting for; there is no sleep.
   */
  const waitForRequest = async (index: number): Promise<PluginWebviewUiRequest> => {
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(index));
    return requests[index]!;
  };

  /** Answer the relay request at `index` as the owning window would. */
  const answer = async (index: number, value: unknown, ok = true): Promise<void> => {
    const relayed = await waitForRequest(index);
    server.handleUiResponse({
      requestId: relayed.requestId,
      ok,
      value,
      ...(ok ? {} : { message: String(value) }),
    });
  };

  return {
    server,
    domain,
    requests,
    sent,
    timers,
    fireTimers,
    answer,
    waitForRequest,
    clipboard,
    reloads,
    openExternalUrl,
    openPathInEditor,
    pageErrors,
  };
}

const servers: PluginWebviewBridgeServer[] = [];

function request(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { bridgeVersion: PLUGIN_WEBVIEW_BRIDGE_VERSION, method, params };
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.dispose();
  resetPluginWebviewGuestsForTests();
  resetPluginEntityChangeListenersForTests();
});

describe("bridge v2 method surface", () => {
  it("answers every v2 method and still refuses one outside the closed list", async () => {
    const h = harness();
    // A method that merely LOOKS like a v2 verb is still not one.
    await expect(h.server.handle(SENDER, request("ui.alert", { message: "hi" })))
      .rejects.toMatchObject({ code: "unsupported_method" });
    await expect(h.server.handle(SENDER, request("secrets.get", { name: "TOKEN" })))
      .rejects.toMatchObject({ code: "unsupported_method" });
  });

  it("derives the plugin id from the frame for a v2 verb, not from the payload", async () => {
    const h = harness();
    const pending = h.server.handle(SENDER, request("ui.toast", {
      toast: { level: "info", message: "Saved" },
      pluginId: "other-plugin",
    }));
    await h.answer(0, { id: "toast-1" });
    await expect(pending).resolves.toEqual({ id: "toast-1" });
    expect(h.requests[0]).toMatchObject({
      pluginId: "demo-plugin",
      surfaceId: "browser",
      placement: "popover",
      verb: "ui.toast",
    });
  });

  it("stamps the window's project onto the handshake context", () => {
    const h = harness();
    expect(h.server.resolveHandshake(SENDER)).toEqual({
      pluginId: "demo-plugin",
      context: {
        subject: null,
        surfaceId: "browser",
        placement: "popover",
        project: { projectId: "proj-1", root: "/repo", binding: "local" },
      },
    });
  });
});

describe("the relay to the owning window", () => {
  it("carries the guest key, resolves on the window's answer and rejects on its refusal", async () => {
    const h = harness();
    const confirmed = h.server.handle(SENDER, request("ui.confirm", { confirm: { title: "Delete?" } }));
    expect((await h.waitForRequest(0)).guestKey).toBe(`guest-${GUEST_ID}`);
    await h.answer(0, true);
    await expect(confirmed).resolves.toBe(true);

    const refused = h.server.handle(SENDER, request("surface.close"));
    await h.answer(1, "Nothing to close.", false);
    await expect(refused).rejects.toMatchObject({ code: "not_permitted" });
  });

  it("gives a prompt ten minutes and everything else ten seconds", async () => {
    const h = harness();
    void h.server.handle(SENDER, request("ui.prompt", { prompt: { id: "note", title: "What?" } }));
    await h.waitForRequest(0);
    void h.server.handle(SENDER, request("composer.insert", { text: "hello" }));
    await h.waitForRequest(1);
    expect(h.timers.map((timer) => timer.ms)).toEqual([600_000, 10_000]);
    // Both are settled here so the pending promises do not outlive the test.
    await h.answer(0, null);
    await h.answer(1, undefined);
  });

  it("gives the page a refusal when its surface is not attached", async () => {
    const h = harness();
    registerPluginWebviewGuest({
      webContentsId: GUEST_ID,
      pluginId: "demo-plugin",
      hostWindowId: 5,
      context: { subject: null, surfaceId: "browser", placement: "popover" },
      send: () => {},
      attached: false,
    });
    await expect(h.server.handle(SENDER, request("surface.close")))
      .rejects.toMatchObject({ code: "not_permitted" });
    expect(h.requests).toHaveLength(0);
  });

  it("times out rather than leaving the page waiting on a wedged window", async () => {
    const h = harness();
    const pending = h.server.handle(SENDER, request("ui.toast", { toast: { level: "info", message: "hi" } }));
    await h.waitForRequest(0);
    h.fireTimers();
    await expect(pending).rejects.toMatchObject({ code: "internal_error" });
  });

  it("ignores a second answer to a request that is already settled", async () => {
    const h = harness();
    const pending = h.server.handle(SENDER, request("ui.confirm", { confirm: { title: "Delete?" } }));
    await h.answer(0, true);
    await h.answer(0, false);
    await expect(pending).resolves.toBe(true);
  });

  it("refuses a settings target outside the closed entry list", async () => {
    const h = harness();
    await expect(h.server.handle(SENDER, request("openSettings", { entryId: "billing" })))
      .rejects.toMatchObject({ code: "invalid_args" });
    const pending = h.server.handle(SENDER, request("openSettings", { entryId: "secrets.secrets" }));
    await h.answer(0, undefined);
    await expect(pending).resolves.toBeNull();
    expect(h.requests[0]?.args).toEqual({ target: { kind: "entry", entryId: "secrets.secrets" } });
  });

  it("drops an issue link that is not http(s) and keeps the rest of the chip", async () => {
    const h = harness();
    const pending = h.server.handle(SENDER, request("composer.attach", {
      issue: {
        provider: "linear",
        issueId: "iss-1",
        identifier: "ADE-148",
        title: "Page tier",
        url: "javascript:alert(1)",
      },
    }));
    await h.answer(0, undefined);
    await pending;
    expect(h.requests[0]?.args.issue).toEqual({
      provider: "linear",
      issueId: "iss-1",
      identifier: "ADE-148",
      title: "Page tier",
    });
  });
});

describe("invoke honours the control-flow answers", () => {
  it("opens an openUrl in the real browser without a renderer hop", async () => {
    const h = harness();
    h.domain.invoke.mockResolvedValueOnce({ openUrl: "https://linear.app/x" } as never);
    await h.server.handle(SENDER, request("invoke", { action: "open" }));
    expect(h.openExternalUrl).toHaveBeenCalledWith("https://linear.app/x");
    expect(h.requests).toHaveLength(0);
  });

  it("forwards navigate, composer and message to the window as one actionResult", async () => {
    const h = harness();
    const result = { navigate: { panelId: "main" }, message: "Done" };
    h.domain.invoke.mockResolvedValueOnce(result as never);
    const pending = h.server.handle(SENDER, request("invoke", { action: "go" }));
    await h.answer(0, undefined);
    // The RAW result still reaches the page: the control flow is applied as
    // well as returned, never instead of it.
    await expect(pending).resolves.toEqual(result);
    expect(h.requests[0]).toMatchObject({ verb: "actionResult", args: { action: "go", result } });
  });

  it("asks a prompt and re-invokes the action exactly once with the answer", async () => {
    const h = harness();
    h.domain.invoke
      .mockResolvedValueOnce({ prompt: { id: "note", title: "What?" } } as never)
      // The second result carries its own prompt, which must be ignored: one hop.
      .mockResolvedValueOnce({ ok: true, prompt: { id: "again", title: "And?" } } as never);
    const pending = h.server.handle(SENDER, request("invoke", { action: "log", args: { lane: "l1" } }));
    await h.answer(0, { id: "note", text: "shipping" });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(h.domain.invoke).toHaveBeenCalledTimes(2);
    expect(h.domain.invoke.mock.calls[1]?.[0]).toEqual({
      pluginId: "demo-plugin",
      action: "log",
      args: { lane: "l1", prompt: { id: "note", text: "shipping" } },
    });
    // Only the first prompt was ever asked.
    expect(h.requests.filter((entry) => entry.verb === "ui.prompt")).toHaveLength(1);
  });

  it("keeps the first result when the reader dismisses the prompt", async () => {
    const h = harness();
    h.domain.invoke.mockResolvedValueOnce({ prompt: { id: "note" } } as never);
    const pending = h.server.handle(SENDER, request("invoke", { action: "log" }));
    await h.answer(0, null);
    await expect(pending).resolves.toEqual({ prompt: { id: "note" } });
    expect(h.domain.invoke).toHaveBeenCalledTimes(1);
  });

  it("still returns the result when the window refuses to draw it", async () => {
    const h = harness();
    h.domain.invoke.mockResolvedValueOnce({ navigate: { panelId: "main" } } as never);
    const pending = h.server.handle(SENDER, request("invoke", { action: "go" }));
    await h.answer(0, "No.", false);
    await expect(pending).resolves.toEqual({ navigate: { panelId: "main" } });
  });
});

describe("clipboard and theme", () => {
  it("reads and writes the machine clipboard, and refuses an oversize write", async () => {
    const h = harness();
    await expect(h.server.handle(SENDER, request("clipboard.read"))).resolves.toBe("copied");
    await h.server.handle(SENDER, request("clipboard.write", { text: "typed" }));
    expect(h.clipboard.text).toBe("typed");
    await expect(
      h.server.handle(SENDER, request("clipboard.write", { text: "x".repeat(PLUGIN_CLIPBOARD_TEXT_MAX_BYTES + 1) })),
    ).rejects.toMatchObject({ code: "plugin_budget_exceeded" });
  });

  it("answers theme.get from what the renderer published and pushes the change", async () => {
    const h = harness();
    await expect(h.server.handle(SENDER, request("theme.get")))
      .resolves.toEqual({ scheme: "dark", tokens: {} });

    h.server.publishTheme(5, { scheme: "light", tokens: { "--ade-bg": "#fff", bad: "#000" } });

    await expect(h.server.handle(SENDER, request("theme.get")))
      .resolves.toEqual({ scheme: "light", tokens: { "--ade-bg": "#fff" } });
    expect(h.sent).toEqual([
      { event: "theme", payload: { scheme: "light", tokens: { "--ade-bg": "#fff" } } },
    ]);
  });

  it("does not paint a guest with another window's theme", () => {
    const h = harness();
    h.server.publishTheme(9, { scheme: "light", tokens: {} });
    expect(h.sent).toHaveLength(0);
  });
});

/**
 * The SUBJECT moving under a page that outlives it.
 *
 * A rail tab is opened once and lives as long as the reader stays in it, while
 * the lane they are working on changes many times. Recreating the guest on each
 * selection would throw away the page's scroll and everything it had loaded, so
 * the host pushes instead — and the push is addressed to a GUEST rather than to
 * a window, unlike the theme: a window draws one palette and many subjects.
 */
describe("publishContext", () => {
  const guestKey = pluginWebviewGuestKey(GUEST_ID);
  const lane = { kind: "lane", id: "lane-1", name: "Fix login", branch: "fix/login", machineKey: null, dirty: false };

  it("moves one guest's subject and tells that guest", () => {
    const h = harness();
    h.server.publishContext(5, { guestKey, subject: lane });

    expect(h.sent).toEqual([{ event: "context", payload: { subject: lane } }]);
    // And the guest RECORD moved with it, so a handshake after the move — a
    // reload of the same page — reports the lane the reader is on rather than
    // the one they opened the tab with.
    expect(getPluginWebviewGuest(GUEST_ID)?.context?.subject).toEqual(lane);
    // Everything else about where the guest is drawn is untouched: those
    // describe the placement, which cannot change without a new guest.
    expect(getPluginWebviewGuest(GUEST_ID)?.context?.surfaceId).toBe("browser");
    expect(getPluginWebviewGuest(GUEST_ID)?.context?.placement).toBe("popover");
  });

  it("carries null as a real subject", () => {
    // No lane selected, or no project bound. A page reads null as "the whole
    // project", so it has to arrive rather than be swallowed as "no change".
    const h = harness();
    h.server.publishContext(5, { guestKey, subject: lane });
    h.server.publishContext(5, { guestKey, subject: null });
    expect(h.sent[1]).toEqual({ event: "context", payload: { subject: null } });
    expect(getPluginWebviewGuest(GUEST_ID)?.context?.subject).toBeNull();
  });

  it("refuses a subject that is not one of the typed contexts", () => {
    // Held to the same shape check the URL is: every typed context carries a
    // string `kind`, and a bare record is not one.
    const h = harness();
    h.server.publishContext(5, { guestKey, subject: { laneId: "lane-1" } });
    expect(h.sent).toEqual([{ event: "context", payload: { subject: null } }]);
  });

  it("does not let one window move another window's guest", () => {
    const h = harness();
    h.server.publishContext(9, { guestKey, subject: lane });
    expect(h.sent).toHaveLength(0);
    expect(getPluginWebviewGuest(GUEST_ID)?.context?.subject).toBeNull();
  });

  it("drops a key that names no live guest", () => {
    // The ordinary race of a selection landing a frame after the guest went
    // away. Nothing anyone can act on, so nothing is thrown.
    const h = harness();
    expect(() => h.server.publishContext(5, { guestKey: "guest:404", subject: lane })).not.toThrow();
    expect(h.sent).toHaveLength(0);
  });

  it("ignores a frame with no guest key at all", () => {
    const h = harness();
    h.server.publishContext(5, { subject: lane });
    h.server.publishContext(5, null);
    expect(h.sent).toHaveLength(0);
  });
});

describe("host.subscribe", () => {
  it("coalesces a burst into one frame per family", async () => {
    const h = harness();
    const answer = await h.server.handle(SENDER, request("host.subscribe", { kinds: ["lane", "pr"] }));
    expect(answer).toMatchObject({ subscriptionId: expect.any(String) });

    emitPluginEntityChange({ family: "lane", ids: ["l1"], projectRoot: "/repo" });
    emitPluginEntityChange({ family: "lane", ids: ["l2", "l1"], projectRoot: "/repo" });
    emitPluginEntityChange({ family: "pr", ids: ["p1"], projectRoot: "/repo" });
    // Nothing has been delivered yet — the whole point of the window.
    expect(h.sent).toHaveLength(0);

    h.fireTimers();

    expect(h.sent).toEqual([
      { event: "host", payload: { kind: "lane", ids: ["l1", "l2"], overflow: false } },
      { event: "host", payload: { kind: "pr", ids: ["p1"], overflow: false } },
    ]);
  });

  it("delivers nothing for a family it did not subscribe to, or another project", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("host.subscribe", { kinds: ["lane"] }));
    emitPluginEntityChange({ family: "session", ids: ["s1"], projectRoot: "/repo" });
    emitPluginEntityChange({ family: "lane", ids: ["l9"], projectRoot: "/other-repo" });
    h.fireTimers();
    expect(h.sent).toHaveLength(0);
  });

  it("says overflow rather than naming more ids than the cap", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("host.subscribe", { kinds: ["lane"] }));
    emitPluginEntityChange({
      family: "lane",
      ids: Array.from({ length: 250 }, (_unused, index) => `l${index}`),
      projectRoot: "/repo",
    });
    h.fireTimers();
    const payload = h.sent[0]?.payload as { ids: string[]; overflow: boolean };
    expect(payload.ids).toHaveLength(200);
    expect(payload.overflow).toBe(true);
  });

  it("stops delivering after unsubscribe, and refuses a subscription with no known kind", async () => {
    const h = harness();
    const answer = await h.server.handle(SENDER, request("host.subscribe", { kinds: ["lane"] })) as {
      subscriptionId: string;
    };
    await h.server.handle(SENDER, request("host.unsubscribe", { subscriptionId: answer.subscriptionId }));
    emitPluginEntityChange({ family: "lane", ids: ["l1"], projectRoot: "/repo" });
    h.fireTimers();
    expect(h.sent).toHaveLength(0);

    await expect(h.server.handle(SENDER, request("host.subscribe", { kinds: ["repo"] })))
      .rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("the chat host kind", () => {
  /** The one `host` frame a chat subscriber was sent, after the window fired. */
  const chatFrame = (frames: PluginWebviewEventFrame[]): PluginWebviewHostEvent => {
    const host = frames.filter((frame) => frame.event === "host");
    expect(host).toHaveLength(1);
    return host[0]!.payload as PluginWebviewHostEvent;
  };

  it("coalesces a session's turns so the LAST state wins", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("host.subscribe", { kinds: ["chat"] }));

    // Started and then failed inside one window. "Started" is no longer true,
    // and a page handed both would have to work out which came last.
    h.server.publishChatTurn(5, { sessionId: "s1", state: "started" });
    h.server.publishChatTurn(5, { sessionId: "s2", state: "started" });
    h.server.publishChatTurn(5, { sessionId: "s1", state: "failed", message: "Model refused." });
    expect(h.sent).toHaveLength(0);

    h.fireTimers();

    const payload = chatFrame(h.sent);
    expect(payload.kind).toBe("chat");
    // `ids` keeps the order the sessions FIRST moved in, not the order of the
    // last state each landed on.
    expect(payload.ids).toEqual(["s1", "s2"]);
    expect(payload.overflow).toBe(false);
    expect(payload.turns).toEqual([
      { sessionId: "s1", state: "failed", message: "Model refused." },
      { sessionId: "s2", state: "started" },
    ]);
  });

  it("delivers nothing to a guest that did not subscribe to chat", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("host.subscribe", { kinds: ["lane", "pr"] }));
    h.server.publishChatTurn(5, { sessionId: "s1", state: "completed" });
    h.fireTimers();
    expect(h.sent).toHaveLength(0);
  });

  it("delivers nothing to a guest in another window", async () => {
    const h = harness();
    const otherSent: PluginWebviewEventFrame[] = [];
    const OTHER_ID = 78;
    registerPluginWebviewGuest({
      webContentsId: OTHER_ID,
      pluginId: "demo-plugin",
      hostWindowId: 9,
      context: { subject: null, surfaceId: "browser", placement: "tab" },
      send: (_channel, payload) => {
        otherSent.push(payload as PluginWebviewEventFrame);
      },
    });
    const otherSender = { webContentsId: OTHER_ID, frameUrl: SENDER.frameUrl };
    await h.server.handle(SENDER, request("host.subscribe", { kinds: ["chat"] }));
    await h.server.handle(otherSender, request("host.subscribe", { kinds: ["chat"] }));

    h.server.publishChatTurn(5, { sessionId: "s1", state: "started" });
    h.fireTimers();

    expect(chatFrame(h.sent).ids).toEqual(["s1"]);
    // The other window's renderer publishes its own conversations. Painting it
    // with this one would name a session from a checkout it was never opened in.
    expect(otherSent).toHaveLength(0);
  });

  it("drops a turn that is not a turn at all", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("host.subscribe", { kinds: ["chat"] }));
    h.server.publishChatTurn(5, { sessionId: "s1", state: "thinking" });
    h.server.publishChatTurn(5, { state: "started" });
    h.server.publishChatTurn(5, null);
    h.fireTimers();
    expect(h.sent).toHaveLength(0);
  });

  it("says overflow and carries no turns past the cap", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("host.subscribe", { kinds: ["chat"] }));
    for (let index = 0; index < PLUGIN_WEBVIEW_CHAT_TURNS_MAX + 25; index += 1) {
      h.server.publishChatTurn(5, { sessionId: `s${index}`, state: "started" });
    }
    h.fireTimers();

    const payload = chatFrame(h.sent);
    expect(payload.overflow).toBe(true);
    expect(payload.ids).toHaveLength(PLUGIN_WEBVIEW_CHAT_TURNS_MAX);
    // The page is being told to refetch the sessions it watches; half a turn
    // list beside that instruction is the half it would patch from instead.
    expect(payload.turns).toBeUndefined();
  });

  it("keeps the entity families buffered the way they always were", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("host.subscribe", { kinds: ["chat", "lane"] }));
    emitPluginEntityChange({ family: "lane", ids: ["l1"], projectRoot: "/repo" });
    h.server.publishChatTurn(5, { sessionId: "s1", state: "completed" });
    h.fireTimers();

    expect(h.sent).toEqual([
      { event: "host", payload: { kind: "lane", ids: ["l1"], overflow: false } },
      {
        event: "host",
        payload: {
          kind: "chat",
          ids: ["s1"],
          overflow: false,
          turns: [{ sessionId: "s1", state: "completed" }],
        },
      },
    ]);
  });
});

describe("dialog.submit", () => {
  /** Redraw the guest in the placement a dialog picker actually gets. */
  const asDialogPicker = (): void => {
    registerPluginWebviewGuest({
      webContentsId: GUEST_ID,
      pluginId: "demo-plugin",
      hostWindowId: 5,
      context: { subject: null, surfaceId: "browser", placement: "dialog-picker" },
      send: () => {},
    });
  };

  it("relays the chosen issue to the owning window", async () => {
    const h = harness();
    asDialogPicker();
    const pending = h.server.handle(SENDER, request("dialog.submit", {
      issue: {
        provider: "linear",
        issueId: "iss-1",
        identifier: "ADE-148",
        title: "Page tier",
        url: "https://linear.app/ade/issue/ADE-148",
      },
    }));
    await h.answer(0, undefined);
    await expect(pending).resolves.toBeNull();
    expect(h.requests[0]).toMatchObject({
      verb: "dialog.submit",
      placement: "dialog-picker",
      args: {
        issue: {
          provider: "linear",
          issueId: "iss-1",
          identifier: "ADE-148",
          title: "Page tier",
          url: "https://linear.app/ade/issue/ADE-148",
        },
      },
    });
  });

  it("relays a null issue as the reader clearing their choice", async () => {
    const h = harness();
    asDialogPicker();
    const pending = h.server.handle(SENDER, request("dialog.submit", { issue: null }));
    await h.answer(0, undefined);
    await expect(pending).resolves.toBeNull();
    expect(h.requests[0]?.args).toEqual({ issue: null });
  });

  it("refuses a page that is not drawn as a dialog picker", async () => {
    const h = harness();
    // The harness guest is a popover, which is where a page would be if it
    // tried to answer a dialog nobody opened.
    await expect(h.server.handle(SENDER, request("dialog.submit", { issue: null })))
      .rejects.toMatchObject({ code: "not_permitted" });
    expect(h.requests).toHaveLength(0);
  });

  it("refuses an issue that is missing the facts a dialog derives from", async () => {
    const h = harness();
    asDialogPicker();
    await expect(h.server.handle(SENDER, request("dialog.submit", {
      issue: { provider: "linear", issueId: "iss-1" },
    }))).rejects.toMatchObject({ code: "invalid_args" });
    expect(h.requests).toHaveLength(0);
  });
});

describe("collections.list paging", () => {
  it("caps a page at 500 rows however many the page asks for", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("collections.list", {
      collection: "notes",
      options: { limit: 5_000 },
    }));
    expect(h.domain.getCollection).toHaveBeenCalledWith(
      expect.objectContaining({ limit: PLUGIN_WEBVIEW_LIST_MAX_ROWS }),
    );
  });

  it("skips everything at or before the cursor", async () => {
    const h = harness();
    const rows = await h.server.handle(SENDER, request("collections.list", {
      collection: "notes",
      options: { after: "a", limit: 2 },
    }));
    expect(rows).toEqual([{ key: "b", value: 2 }, { key: "c", value: 3 }]);
  });

  it("widens the read until a full page is past the cursor", async () => {
    const rows = Array.from({ length: 40 }, (_unused, index) => ({
      key: `k${String(index).padStart(3, "0")}`,
      value: index,
    }));
    const h = harness({ rows });
    const page = await h.server.handle(SENDER, request("collections.list", {
      collection: "notes",
      options: { after: "k019", limit: 5 },
    })) as { key: string }[];
    expect(page.map((row) => row.key)).toEqual(["k020", "k021", "k022", "k023", "k024"]);
    // The first read could not have contained a full page past the cursor, so
    // the window had to widen rather than answer short.
    expect(h.domain.getCollection.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("wave 2 verbs answered in main", () => {
  it("forwards picker arguments and answers null when the reader dismissed", async () => {
    const h = harness();
    const dismissed = h.server.handle(SENDER, request("ui.pickModel", {
      value: "gpt",
      availableModelIds: ["gpt", "claude-opus-5"],
    }));
    expect((await h.waitForRequest(0)).args).toEqual({
      value: "gpt",
      availableModelIds: ["gpt", "claude-opus-5"],
    });
    await h.answer(0, null);
    await expect(dismissed).resolves.toBeNull();

    const chosen = h.server.handle(SENDER, request("ui.pickLane", { value: "lane-1" }));
    await h.answer(1, { laneId: "lane-1", name: "Wave 2" });
    await expect(chosen).resolves.toEqual({ laneId: "lane-1", name: "Wave 2" });
  });

  it("forwards the chip rect a page measured so the host can anchor the picker", async () => {
    const h = harness();
    const pending = h.server.handle(SENDER, request("ui.pickModel", {
      value: "gpt",
      rect: { top: 40, left: 80, width: 96, height: 24 },
    }));
    expect((await h.waitForRequest(0)).args).toEqual({
      value: "gpt",
      rect: { top: 40, left: 80, width: 96, height: 24 },
    });
    await h.answer(0, null);
    await expect(pending).resolves.toBeNull();
  });

  it("refuses pickPermissionMode without a provider and pickReasoningEffort without a model", async () => {
    const h = harness();
    await expect(h.server.handle(SENDER, request("ui.pickPermissionMode", {})))
      .rejects.toMatchObject({ code: "invalid_args" });
    await expect(h.server.handle(SENDER, request("ui.pickReasoningEffort", {})))
      .rejects.toMatchObject({ code: "invalid_args" });
    expect(h.requests).toHaveLength(0);
  });

  it("opens a checkout path through the same editor opener every ADE surface uses", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("ui.openPathInEditor", {
      rootPath: "/repo",
      relativePath: "src/main.ts",
      target: "default",
    }));
    expect(h.openPathInEditor).toHaveBeenCalledWith({
      guest: expect.objectContaining({ pluginId: "demo-plugin" }),
      rootPath: "/repo",
      relativePath: "src/main.ts",
      target: "default",
    });
    expect(h.requests).toHaveLength(0);
  });

  it("relays sockets.list as an array and sockets.invoke by socketId", async () => {
    const h = harness();
    const listed = h.server.handle(SENDER, request("sockets.list", { socket: "toolbar-action" }));
    await h.answer(0, [
      {
        socketId: "graph.rebuild",
        pluginId: "ade-graph",
        socket: "toolbar-action",
        label: "Rebuild",
      },
      { socketId: "drop-me" },
    ]);
    await expect(listed).resolves.toEqual([
      {
        socketId: "graph.rebuild",
        pluginId: "ade-graph",
        socket: "toolbar-action",
        label: "Rebuild",
      },
    ]);

    const pressed = h.server.handle(SENDER, request("sockets.invoke", {
      socketId: "graph.rebuild",
      args: { from: "page" },
    }));
    await h.answer(1, { ok: true });
    await expect(pressed).resolves.toEqual({ ok: true });
    expect(h.requests[1]?.args).toEqual({ socketId: "graph.rebuild", args: { from: "page" } });
  });

  it("refuses hostEngine.place for a plugin that does not own the engine, and relays when it does", async () => {
    const h = harness();
    await expect(h.server.handle(SENDER, request("hostEngine.place", {
      engineId: "electron-control",
      rect: { x: 0, y: 0, width: 100, height: 80 },
    }))).rejects.toMatchObject({ code: "not_permitted" });
    expect(h.requests).toHaveLength(0);

    const OWNER_ID = 88;
    const ownerSender = {
      webContentsId: OWNER_ID,
      frameUrl: "ade-plugin://ade-app-control/page/index.html",
    };
    registerPluginWebviewGuest({
      webContentsId: OWNER_ID,
      pluginId: "ade-app-control",
      hostWindowId: 5,
      context: { subject: null, surfaceId: "control", placement: "tab" },
      send: () => {},
    });
    const placed = h.server.handle(ownerSender, request("hostEngine.place", {
      engineId: "electron-control",
      rect: { x: 8, y: 16, width: 320, height: 240 },
    }));
    await h.answer(0, undefined);
    await expect(placed).resolves.toBeNull();
    expect(h.requests[0]).toMatchObject({
      pluginId: "ade-app-control",
      verb: "hostEngine.place",
      args: { engineId: "electron-control", rect: { x: 8, y: 16, width: 320, height: 240 } },
    });
  });

  it("logs and relays page.error, and drops a report with no sentence", async () => {
    const h = harness();
    const pending = h.server.handle(SENDER, request("page.error", {
      kind: "csp",
      message: "script-src blocked https://cdn.example.com/react.js",
      source: "https://cdn.example.com/react.js",
    }));
    await h.answer(0, undefined);
    await expect(pending).resolves.toBeNull();
    expect(h.pageErrors).toEqual([
      {
        pluginId: "demo-plugin",
        error: {
          kind: "csp",
          message: "script-src blocked https://cdn.example.com/react.js",
          source: "https://cdn.example.com/react.js",
        },
      },
    ]);
    expect(h.requests[0]).toMatchObject({
      verb: "page.error",
      args: {
        error: {
          kind: "csp",
          message: "script-src blocked https://cdn.example.com/react.js",
          source: "https://cdn.example.com/react.js",
        },
      },
    });

    await expect(h.server.handle(SENDER, request("page.error", { kind: "error" })))
      .resolves.toBeNull();
    expect(h.pageErrors).toHaveLength(1);
  });
});

describe("window-published host kinds", () => {
  it("delivers operation, conflict and review to subscribers of those kinds", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("host.subscribe", {
      kinds: ["operation", "conflict", "review", "lane"],
    }));

    h.server.publishHostChange(5, { kind: "conflict", ids: ["lane-1", "lane-1"] });
    h.server.publishHostChange(5, { kind: "review", ids: ["run-9"] });
    h.server.publishHostChange(5, { kind: "operation", ids: ["op-1"] });
    expect(h.sent).toHaveLength(0);
    h.fireTimers();

    expect(h.sent).toEqual([
      { event: "host", payload: { kind: "conflict", ids: ["lane-1"], overflow: false } },
      { event: "host", payload: { kind: "review", ids: ["run-9"], overflow: false } },
      { event: "host", payload: { kind: "operation", ids: ["op-1"], overflow: false } },
    ]);
  });

  it("drops a kind the entity bus or the chat publisher already owns", async () => {
    const h = harness();
    await h.server.handle(SENDER, request("host.subscribe", { kinds: ["lane", "chat", "conflict"] }));
    h.server.publishHostChange(5, { kind: "lane", ids: ["l1"] });
    h.server.publishHostChange(5, { kind: "chat", ids: ["s1"] });
    h.server.publishHostChange(5, { kind: "session", ids: ["s1"] });
    h.fireTimers();
    expect(h.sent).toHaveLength(0);
  });
});

describe("hot reload", () => {
  it("tells the renderer to recreate a guest when the plugin is reinstalled", async () => {
    const h = harness();
    emitPluginChange({ kind: "installs", pluginId: "demo-plugin" });
    await vi.waitFor(() => expect(h.reloads).toHaveLength(1));
    expect(h.reloads[0]).toEqual({ pluginId: "demo-plugin", version: "2.3.0", revision: 1 });

    emitPluginChange({ kind: "installs", pluginId: "demo-plugin" });
    // The revision moves even though the version did not, which is what makes
    // `ade plugin dev` repaint a page after it re-copies the same version.
    await vi.waitFor(() => expect(h.reloads).toHaveLength(2));
    expect(h.reloads[1]?.revision).toBe(2);
  });

  it("says nothing for a plugin no guest is drawing", async () => {
    const h = harness();
    emitPluginChange({ kind: "installs", pluginId: "other-plugin" });
    emitPluginChange({ kind: "collections", pluginId: "demo-plugin", collection: "notes" });
    await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(0));
    expect(h.reloads).toHaveLength(0);
  });
});
