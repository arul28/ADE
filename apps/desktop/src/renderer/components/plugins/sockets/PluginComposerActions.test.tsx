/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS,
  PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS,
} from "../../../../shared/plugins/sockets";
import { PluginComposerActions } from "./PluginComposerActions";
import {
  registerPluginComposerTarget,
  resetPluginComposerTargets,
} from "./composerTarget";

/**
 * The composer socket end to end, from a manifest declaration to a draft edit.
 *
 * The load-bearing assertion is the one about WHEN the draft is read: a plugin
 * receives the text on screen at the moment of the click, not at the moment the
 * button rendered, because a composer's draft changes on every keystroke.
 */

const invoked: { pluginId: string; action: string; args: unknown }[] = [];

let invokeResult: unknown = {};

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "prompts",
          displayName: "Prompts",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "prompts",
        version: "1.0.0",
        sockets: [
          { socket: "composer-action", surface: "work", id: "bug", label: "Bug report", actionId: "bug", order: 1 },
          { socket: "composer-action", surface: "work", id: "spec", label: "Spec", actionId: "spec", order: 2 },
          { socket: "composer-action", surface: "work", id: "extra", label: "Extra", actionId: "extra", order: 3 },
          // Another surface's socket must not leak into the composer row.
          { socket: "toolbar-action", surface: "work", id: "tool", label: "Toolbar", actionId: "tool", order: 1 },
        ],
      }),
      listContributions: async () => [],
      invoke: async (args: { pluginId: string; action: string; args: unknown }) => {
        invoked.push({ pluginId: args.pluginId, action: args.action, args: args.args });
        return invokeResult;
      },
    },
  };
});

beforeEach(() => {
  invoked.length = 0;
  invokeResult = {};
  resetPluginComposerTargets();
});

afterEach(() => {
  cleanup();
  resetPluginComposerTargets();
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

function renderRow(readDraft: () => { draft: string; cursor: number | null }) {
  return render(
    <PluginComposerActions sessionId="chat-1" laneId="lane-1" readDraft={readDraft} />,
  );
}

describe("contributed composer buttons", () => {
  it("draws two and folds the rest behind the overflow", async () => {
    renderRow(() => ({ draft: "", cursor: null }));

    await waitFor(() => expect(screen.getByText("Bug report")).toBeTruthy());
    expect(screen.getByText("Spec")).toBeTruthy();
    expect(screen.queryByText("Extra")).toBeNull();
    expect(screen.getByRole("button", { name: "1 more plugin actions" })).toBeTruthy();
  });

  it("renders nothing for a socket kind that belongs to another slot", async () => {
    renderRow(() => ({ draft: "", cursor: null }));

    await waitFor(() => expect(screen.getByText("Bug report")).toBeTruthy());
    expect(screen.queryByText("Toolbar")).toBeNull();
  });

  it("hands the plugin the draft as it reads at click time, not at render time", async () => {
    let draft = "first";
    renderRow(() => ({ draft, cursor: draft.length }));

    await waitFor(() => expect(screen.getByText("Bug report")).toBeTruthy());
    draft = "typed some more";

    await act(async () => {
      fireEvent.click(screen.getByText("Bug report"));
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.pluginId).toBe("prompts");
    expect(invoked[0]?.action).toBe("bug");
    expect((invoked[0]?.args as { context: unknown }).context).toEqual({
      kind: "composer",
      sessionId: "chat-1",
      projectKey: null,
      projectRoot: null,
      laneId: "lane-1",
      draft: "typed some more",
      cursor: 15,
    });
  });

  it("applies the composer verb the action responds with", async () => {
    const insertText = vi.fn();
    const replaceText = vi.fn();
    registerPluginComposerTarget("composer", { sessionId: "chat-1", insertText, replaceText });
    invokeResult = { composer: { insertText: "Steps to reproduce:\n" } };

    renderRow(() => ({ draft: "", cursor: null }));
    await waitFor(() => expect(screen.getByText("Bug report")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("Bug report"));
    });

    await waitFor(() => expect(insertText).toHaveBeenCalledWith("Steps to reproduce:\n"));
    expect(replaceText).not.toHaveBeenCalled();
  });

  /**
   * A composer action can legitimately run for minutes (ade-voice's Dictate
   * button records until the user stops). For that whole time the button must
   * read as ON rather than dead, stay focusable, and refuse to fire again.
   */
  it("stays visibly active and enabled while a long action runs, and will not re-fire", async () => {
    const pending: { release: () => void } = { release: () => {} };
    const inFlight = new Promise<void>((resolve) => {
      pending.release = resolve;
    });
    const ade = (window as unknown as { ade: { plugins: { invoke: unknown } } }).ade;
    const original = ade.plugins.invoke;
    ade.plugins.invoke = async (args: { pluginId: string; action: string; args: unknown }) => {
      invoked.push({ pluginId: args.pluginId, action: args.action, args: args.args });
      await inFlight;
      return {};
    };

    try {
      renderRow(() => ({ draft: "", cursor: null }));
      await waitFor(() => expect(screen.getByText("Bug report")).toBeTruthy());

      const button = screen.getByText("Bug report").closest("button");
      if (!button) throw new Error("expected a contributed button");

      await act(async () => {
        fireEvent.click(button);
      });

      // Enabled, so it keeps focus and does not read as a broken control; the
      // active state is carried by aria-busy and the accent class instead.
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.dataset.busy).toBe("true");
      expect(button.className).toContain("var(--chat-accent)");
      // The label survives — a running action must still say what it is.
      expect(screen.getByText("Bug report")).toBeTruthy();

      fireEvent.click(button);
      fireEvent.click(button);
      expect(invoked).toHaveLength(1);

      await act(async () => {
        pending.release();
        await inFlight;
      });
      await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
      // Once finished it is pressable again.
      await act(async () => {
        fireEvent.click(button);
      });
      expect(invoked).toHaveLength(2);
    } finally {
      ade.plugins.invoke = original;
    }
  });

  /**
   * Started from the overflow popover, a minutes-long action would otherwise
   * run behind a "+N" that says nothing at all — the popover closes and the
   * only feedback is a menu row nobody is looking at.
   */
  it("promotes a running action out of the overflow so its busy state is visible", async () => {
    const pending: { release: () => void } = { release: () => {} };
    const inFlight = new Promise<void>((resolve) => {
      pending.release = resolve;
    });
    const ade = (window as unknown as { ade: { plugins: { invoke: unknown } } }).ade;
    const original = ade.plugins.invoke;
    ade.plugins.invoke = async () => {
      await inFlight;
      return {};
    };

    try {
      renderRow(() => ({ draft: "", cursor: null }));
      await waitFor(() => expect(screen.getByText("Bug report")).toBeTruthy());

      // "Extra" is third by host order, so it starts inside the overflow.
      expect(screen.queryByText("Extra")).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "1 more plugin actions" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByText("Extra"));
      });

      // Now it is a visible button in the row, wearing the running state.
      const promoted = await waitFor(() => {
        const button = screen.getByText("Extra").closest("button");
        if (!button || button.getAttribute("aria-busy") !== "true") {
          throw new Error("expected the running action to be promoted into the row");
        }
        return button;
      });
      expect(promoted.dataset.tour).toBe("plugin:work.composer-action");

      await act(async () => {
        pending.release();
        await inFlight;
      });
      // Finished, it returns to its declared place: an overflow menu row,
      // which carries no row `data-tour` of its own.
      await waitFor(() => {
        expect(screen.getByText("Extra").closest("button")?.dataset.tour).toBeUndefined();
      });
    } finally {
      ade.plugins.invoke = original;
    }
  });

  // A 60s cap would cut a dictation off mid-sentence and report it as a plugin
  // fault, so composer actions ask for the long budget on every invocation.
  it("asks for the composer-action round-trip budget, not the default", async () => {
    const seen: unknown[] = [];
    const ade = (window as unknown as { ade: { plugins: { invoke: unknown } } }).ade;
    const original = ade.plugins.invoke;
    ade.plugins.invoke = async (args: Record<string, unknown>) => {
      seen.push(args.timeoutMs);
      return {};
    };

    try {
      renderRow(() => ({ draft: "", cursor: null }));
      await waitFor(() => expect(screen.getByText("Bug report")).toBeTruthy());

      await act(async () => {
        fireEvent.click(screen.getByText("Bug report"));
      });

      expect(seen).toEqual([PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS]);
      expect(PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS)
        .toBeGreaterThan(PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS);
    } finally {
      ade.plugins.invoke = original;
    }
  });
});
