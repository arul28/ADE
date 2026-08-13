/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PluginChatCard } from "./PluginChatCard";
import type { AdeCardPayload } from "../../../../shared/adeCard";
import type { PluginChangeEvent } from "../../../../main/services/plugins/pluginEvents";

/**
 * The `chat-card` socket end to end.
 *
 * Two assertions carry the design. The panel renders only when the plugin
 * DECLARED it — the emit places the card, the manifest grants the panel — and
 * the panel follows the plugin's data rather than the card's, so a plugin that
 * writes a new panel schema updates a card already in the transcript without
 * re-emitting anything.
 */

let panelTitle = "0 problems";
const changeListeners: ((event: PluginChangeEvent) => void)[] = [];
const invoked: { pluginId: string; action: string; args?: Record<string, unknown> }[] = [];
/** Set to a promise a test resolves itself, to hold an invoke in flight. */
let pendingInvoke: Promise<unknown> | null = null;

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "lint",
          displayName: "Lint",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "lint",
        version: "1.0.0",
        sockets: [
          { socket: "chat-card", surface: "work", id: "report", panelId: "report", label: "Lint report" },
        ],
      }),
      listContributions: async () => [],
      getPanel: async ({ panelId }: { panelId: string }) => ({
        pluginId: "lint",
        panelId,
        title: "Lint",
        schema: {
          v: 1,
          title: "Lint",
          fallback: { title: "Lint", text: "Lint report" },
          body: [{ component: "text", text: panelTitle }],
        },
        vocabVersion: 1,
        updatedAt: "2026-08-13T00:00:00.000Z",
      }),
      getCollection: async () => [],
      invoke: async (args: { pluginId: string; action: string; args?: Record<string, unknown> }) => {
        invoked.push(args);
        return await (pendingInvoke ?? Promise.resolve({}));
      },
      onChanged: (listener: (event: PluginChangeEvent) => void) => {
        changeListeners.push(listener);
        return () => {
          const index = changeListeners.indexOf(listener);
          if (index >= 0) changeListeners.splice(index, 1);
        };
      },
    },
  };
});

beforeEach(() => {
  panelTitle = "0 problems";
  invoked.length = 0;
  pendingInvoke = null;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

function card(over: Partial<AdeCardPayload> = {}): AdeCardPayload {
  return {
    cardId: "lint-run",
    variant: "lint_report",
    state: "terminal",
    title: "Lint clean",
    fallbackText: "Lint clean — 0 problems",
    authoredBy: { pluginId: "lint", displayName: "Lint" },
    panel: { panelId: "report" },
    ...over,
  };
}

describe("chat-card socket", () => {
  it("draws the plugin's panel inside the card frame, attributed", async () => {
    render(<PluginChatCard card={card()} sessionId="chat-1" />);

    await waitFor(() => expect(screen.getByText("0 problems")).toBeTruthy());
    // ADE's frame is still ADE's: the card's own title and the byline are there
    // around the plugin's content, not replaced by it.
    expect(screen.getByText("Lint clean")).toBeTruthy();
    expect(screen.getByTestId("ade-card-attribution").textContent).toContain("Lint");
  });

  it("re-renders the panel when the plugin's data changes, with no new emit", async () => {
    render(<PluginChatCard card={card()} sessionId="chat-1" />);
    await waitFor(() => expect(screen.getByText("0 problems")).toBeTruthy());

    panelTitle = "3 problems";
    await act(async () => {
      for (const listener of [...changeListeners]) listener({ kind: "panels", pluginId: "lint", panelId: "report" });
    });

    await waitFor(() => expect(screen.getByText("3 problems")).toBeTruthy());
  });

  it("renders the card without a panel when the plugin never declared that panelId", async () => {
    render(<PluginChatCard card={card({ panel: { panelId: "undeclared" } })} sessionId="chat-1" />);

    // The card is still real content — its fallback text and its byline — which
    // is the point: an undeclared panel degrades the row, it does not blank it.
    await waitFor(() => expect(screen.getByText("Lint clean — 0 problems")).toBeTruthy());
    expect(screen.getByTestId("ade-card-attribution").textContent).toContain("Lint");
    expect(screen.queryByText("0 problems")).toBeNull();
  });

  it("renders an ordinary card when nothing stamped an author", async () => {
    render(<PluginChatCard card={card({ authoredBy: null })} sessionId="chat-1" />);

    await waitFor(() => expect(screen.getByText("Lint clean — 0 problems")).toBeTruthy());
    expect(screen.queryByTestId("ade-card-attribution")).toBeNull();
    expect(screen.queryByText("0 problems")).toBeNull();
  });

  /**
   * The button press. A card's action is the plugin's, wherever the card was
   * drawn — including the plugin cards with no panel, which used to take the
   * plain path and lose both the session context and the busy state.
   */
  describe("card actions", () => {
    const withAction = (over: Partial<AdeCardPayload> = {}) => card({
      actions: [{ id: "fix", label: "Fix", kind: "primary" }],
      ...over,
    });

    it("invokes the card's plugin with the chat's real title and runtime", async () => {
      render(
        <PluginChatCard
          card={withAction()}
          sessionId="chat-1"
          sessionTitle="Fix the flaky test"
          provider="claude-chat"
        />,
      );

      fireEvent.click(await screen.findByText("Fix"));

      await waitFor(() => expect(invoked).toHaveLength(1));
      expect(invoked[0]).toMatchObject({
        pluginId: "lint",
        action: "fix",
        args: {
          context: {
            kind: "session",
            id: "chat-1",
            title: "Fix the flaky test",
            provider: "claude-chat",
          },
          card: { cardId: "lint-run" },
        },
      });
    });

    it("invokes from a plugin card that has no panel at all", async () => {
      // A known variant, so the card renders its frame (and therefore its
      // action row) rather than degrading to fallback text — this test is about
      // the dispatch, not about unknown-variant degradation.
      render(
        <PluginChatCard
          card={withAction({ panel: null, variant: "proof_artifact" })}
          sessionId="chat-1"
        />,
      );

      fireEvent.click(await screen.findByText("Fix"));

      await waitFor(() => expect(invoked).toHaveLength(1));
    });

    // "Approve" pressed twice is two approvals. The guard is per button, so the
    // card's other actions stay live while this one runs.
    it("refuses a second press while the same action is in flight, and says so", async () => {
      let release: (() => void) | null = null;
      pendingInvoke = new Promise((resolve) => {
        release = () => resolve({});
      });
      render(
        <PluginChatCard
          card={withAction({
            actions: [
              { id: "fix", label: "Fix", kind: "primary" },
              { id: "ignore", label: "Ignore", kind: "default" },
            ],
          })}
          sessionId="chat-1"
        />,
      );

      const fix = await screen.findByText("Fix");
      fireEvent.click(fix);
      await waitFor(() => expect(invoked).toHaveLength(1));
      expect(fix.closest("button")?.getAttribute("aria-busy")).toBe("true");
      // The other button is untouched: one action running is not a frozen card.
      expect(screen.getByText("Ignore").closest("button")?.hasAttribute("disabled")).toBe(false);

      fireEvent.click(fix);
      expect(invoked).toHaveLength(1);

      await act(async () => {
        release?.();
        await Promise.resolve();
      });
      await waitFor(() => expect(fix.closest("button")?.hasAttribute("disabled")).toBe(false));

      fireEvent.click(fix);
      await waitFor(() => expect(invoked).toHaveLength(2));
    });
  });
});
