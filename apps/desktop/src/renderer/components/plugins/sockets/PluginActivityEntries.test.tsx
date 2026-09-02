/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PluginActivityEntries } from "./PluginActivityEntries";

/**
 * The `activity-entry` socket.
 *
 * The assertion that matters most is about `entryId`. An activity list is the
 * one surface where a plugin routinely places several rows that share one
 * action — "three files failed the lint" is three rows and one `openFinding` —
 * so the context has to say WHICH row was pressed, and it is the only thing
 * the handler cannot work out for itself.
 *
 * The other is attribution. These rows sit among ADE's own claims about the
 * user's pull requests and failing checks, so one that did not name its plugin
 * would read as the product's own.
 */

const invoked: { pluginId: string; action: string; args: unknown }[] = [];

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "costguard",
          displayName: "Cost Guard",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({ name: "costguard", version: "1.0.0", sockets: [] }),
      listContributions: async () => [
        {
          pluginId: "costguard",
          socket: "activity-entry",
          socketId: "over-budget",
          surface: "app",
          entityKind: "surface",
          entityId: "app",
          payload: {
            title: "Spend cap reached",
            body: "This week's budget is spent",
            tone: "warning",
            actionId: "review",
            actionLabel: "Review spend",
          },
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
        {
          pluginId: "costguard",
          socket: "activity-entry",
          socketId: "trend",
          surface: "app",
          entityKind: "surface",
          entityId: "app",
          // No action: a status line, not a control.
          payload: { title: "Spend is trending up", tone: "neutral" },
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      invoke: async (args: { pluginId: string; action: string; args: unknown }) => {
        invoked.push({ pluginId: args.pluginId, action: args.action, args: args.args });
        return {};
      },
    },
  };
});

beforeEach(() => {
  invoked.length = 0;
});

afterEach(() => cleanup());

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("contributed activity entries", () => {
  it("draws each row with its body and the plugin that owns it", async () => {
    render(<PluginActivityEntries />);

    await waitFor(() => expect(screen.getByText("Spend cap reached")).toBeTruthy());
    expect(screen.getByText("This week's budget is spent · Cost Guard")).toBeTruthy();
    // A row with no body still carries the attribution on its own.
    expect(screen.getByText("Cost Guard")).toBeTruthy();
    expect(screen.getByText("Spend is trending up")).toBeTruthy();
  });

  it("carries the tone into the pane's own colour vocabulary", async () => {
    const { container } = render(<PluginActivityEntries />);

    await waitFor(() => expect(screen.getByText("Spend cap reached")).toBeTruthy());
    // `warning` is the pane's amber. `destructive` is its red — a different
    // tone, not a louder warning.
    expect(container.querySelector(".activity-tone-amber")).toBeTruthy();
    expect(container.querySelector(".activity-tone-red")).toBeNull();
  });

  it("presses only the row that has an action, and says which row it was", async () => {
    render(<PluginActivityEntries />);
    await waitFor(() => expect(screen.getByText("Spend cap reached")).toBeTruthy());

    // The actionless row is not a button — a status line drawn as a control
    // that does nothing reads as a control that stopped working.
    expect(screen.getByText("Spend is trending up").closest("button")).toBeNull();

    const pressable = screen.getByText("Spend cap reached").closest("button");
    if (!pressable) throw new Error("expected the actionable row to be a button");
    await act(async () => {
      fireEvent.click(pressable);
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.pluginId).toBe("costguard");
    expect(invoked[0]?.action).toBe("review");
    // `entryId` is the contribution id, not the action id: two rows sharing
    // one action are told apart by nothing else.
    expect((invoked[0]?.args as { context: unknown }).context).toEqual({
      kind: "activity",
      entryId: "over-budget",
      projectKey: null,
      laneId: null,
    });
  });
});
