/* @vitest-environment jsdom */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ADE_NAVIGATE_TARGET_EVENT } from "../../../lib/openExternal";
import {
  CHAT_CARD_ACTION_EVENT,
  ensurePluginChatCardActionBridge,
  handlePluginChatCardAction,
} from "./pluginChatCardBridge";

/**
 * A press on a plugin-emitted card's button, all the way to `plugin.invoke`.
 *
 * The card action row broadcasts a window event and has always done so; what
 * this covers is the half that did not exist — a listener that turns the
 * broadcast into a call on the plugin that WROTE the card, and only that
 * plugin. The routing key is the host-stamped `pluginId` in the detail, so the
 * test that matters most is the negative one: a detail without it belongs to
 * some other host and must fall through untouched.
 */

const invoked: { pluginId: string; action: string; args: unknown }[] = [];
let invokeResult: unknown = {};
let navigations: unknown[] = [];

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      invoke: async (args: { pluginId: string; action: string; args: unknown }) => {
        invoked.push({ pluginId: args.pluginId, action: args.action, args: args.args });
        return invokeResult;
      },
    },
  };
  window.addEventListener(ADE_NAVIGATE_TARGET_EVENT, (event) => {
    navigations.push((event as CustomEvent).detail?.target);
  });
});

beforeEach(() => {
  invoked.length = 0;
  invokeResult = {};
  navigations = [];
});

afterEach(() => {
  invoked.length = 0;
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("chat-card action bridge", () => {
  it("runs the owning plugin's action with the card and the chat context", async () => {
    await handlePluginChatCardAction({
      actionId: "fix",
      cardId: "lint-run",
      variant: "lint_report",
      pluginId: "lint",
      sessionId: "chat-1",
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.pluginId).toBe("lint");
    expect(invoked[0]?.action).toBe("fix");
    expect(invoked[0]?.args).toMatchObject({
      context: { kind: "session", id: "chat-1" },
      card: { cardId: "lint-run", variant: "lint_report" },
    });
  });

  it("ignores a card ADE emitted, so another host can still claim it", async () => {
    await handlePluginChatCardAction({ actionId: "retry", cardId: "pr-ci", sessionId: "chat-1" });
    expect(invoked).toHaveLength(0);
  });

  it("ignores a detail with no action or no card identity", async () => {
    await handlePluginChatCardAction({ pluginId: "lint", cardId: "lint-run", sessionId: "chat-1" });
    await handlePluginChatCardAction({ pluginId: "lint", actionId: "fix", sessionId: "chat-1" });
    await handlePluginChatCardAction(null);
    expect(invoked).toHaveLength(0);
  });

  it("honours the action's navigate verb, the same as any other socket", async () => {
    invokeResult = { navigate: { panelId: "report" } };

    await handlePluginChatCardAction({
      actionId: "open-report",
      cardId: "lint-run",
      pluginId: "lint",
      sessionId: "chat-1",
    });

    expect(navigations).toEqual([
      expect.objectContaining({ kind: "plugin", pluginId: "lint", panelId: "report" }),
    ]);
  });

  it("installs exactly one window listener however many times it is asked", async () => {
    ensurePluginChatCardActionBridge();
    ensurePluginChatCardActionBridge();
    ensurePluginChatCardActionBridge();

    window.dispatchEvent(new CustomEvent(CHAT_CARD_ACTION_EVENT, {
      detail: { actionId: "fix", cardId: "lint-run", pluginId: "lint", sessionId: "chat-1" },
    }));
    // The invoke is async; the dispatch itself is not, so drain a tick.
    await Promise.resolve();

    expect(invoked).toHaveLength(1);
  });
});
