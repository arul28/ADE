/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  entityMatchesPluginFilters,
  PluginDetailSections,
  PluginFilterChips,
  pluginAutomationContext,
  pluginPrContext,
  pluginSessionContext,
  usePluginSurfaceContributions,
} from ".";

/**
 * The coverage half of Wave 2: two socket kinds that already existed but only
 * ever had one or two call-sites.
 *
 * `filter-chip` had exactly one (Lanes) and `detail-section` had two (PRs, CTO).
 * Both are now mounted on Work, PRs and Automations as well. The renderers are
 * unchanged, so what needs proving is not how they draw — that is covered where
 * they were first written — but that they SELECT correctly per surface, which
 * is the thing a copy-pasted mount gets wrong: a chip declared for Automations
 * showing up on Work, or a chip filtering nothing because the entity it was
 * published against does not match the context the new host builds.
 */

const ROW_UPDATED_AT = "2026-08-13T00:00:00.000Z";

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "triage",
          displayName: "Triage",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "triage",
        version: "1.0.0",
        sockets: [
          { socket: "filter-chip", surface: "work", id: "w-chip", label: "Needs triage", filterKey: "triage" },
          { socket: "filter-chip", surface: "prs", id: "p-chip", label: "Risky", filterKey: "risky" },
          { socket: "filter-chip", surface: "automations", id: "a-chip", label: "Noisy", filterKey: "noisy" },
          { socket: "detail-section", surface: "work", id: "w-detail", label: "Session risk", panelId: "risk" },
          { socket: "detail-section", surface: "automations", id: "a-detail", label: "Rule history", panelId: "history" },
        ],
      }),
      // The rows that TAG entities into a chip. A chip with no rows behind it
      // is a button that selects and filters nothing, which reads as a broken
      // product feature rather than a missing plugin one.
      listContributions: async (args: { surface: string }) => {
        if (args.surface === "work") {
          return [{
            pluginId: "triage",
            socket: "row-badge",
            socketId: "tag",
            surface: "work",
            entityKind: "session",
            entityId: "chat-1",
            payload: { text: "Triage", tone: "warning", filterKey: "triage" },
            updatedAt: ROW_UPDATED_AT,
          }];
        }
        if (args.surface === "prs") {
          return [{
            pluginId: "triage",
            socket: "row-badge",
            socketId: "tag",
            surface: "prs",
            entityKind: "pr",
            entityId: "42",
            payload: { text: "Risky", tone: "warning", filterKey: "risky" },
            updatedAt: ROW_UPDATED_AT,
          }];
        }
        if (args.surface === "automations") {
          return [{
            pluginId: "triage",
            socket: "row-badge",
            socketId: "tag",
            surface: "automations",
            entityKind: "automation",
            entityId: "rule-1",
            payload: { text: "Noisy", tone: "warning", filterKey: "noisy" },
            updatedAt: ROW_UPDATED_AT,
          }];
        }
        return [];
      },
      invoke: async () => ({}),
      readPanel: async () => null,
    },
  };
});

afterEach(() => cleanup());

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("filter-chip coverage on work, prs and automations", () => {
  it("offers each surface only its own chips", async () => {
    for (const [surface, mine, theirs] of [
      ["work", "Needs triage", "Risky"],
      ["prs", "Risky", "Noisy"],
      ["automations", "Noisy", "Needs triage"],
    ] as const) {
      const view = render(
        <PluginFilterChips surface={surface} selected={[]} onToggle={vi.fn()} />,
      );
      await waitFor(() => expect(screen.getByText(mine)).toBeTruthy());
      expect(screen.queryByText(theirs)).toBeNull();
      view.unmount();
    }
  });

  it("filters the entity the new host's context names", async () => {
    // The pairing each new mount had to get right: the chip's `filterKey` and
    // the entity id the surface's context builder produces. A mismatch here is
    // invisible — the chip highlights and the list simply empties.
    const seen: Record<string, { tagged: boolean; other: boolean }> = {};

    function Probe({ surface }: { surface: "work" | "prs" | "automations" }) {
      const set = usePluginSurfaceContributions(surface, true);
      const [tagged, other] = surface === "work"
        ? [pluginSessionContext({ id: "chat-1" }), pluginSessionContext({ id: "chat-2" })]
        : surface === "prs"
          ? [pluginPrContext({ number: 42 }), pluginPrContext({ number: 7 })]
          : [pluginAutomationContext({ id: "rule-1" }), pluginAutomationContext({ id: "rule-9" })];
      const key = surface === "work" ? "triage" : surface === "prs" ? "risky" : "noisy";
      seen[surface] = {
        tagged: entityMatchesPluginFilters(set, tagged, [key]),
        other: entityMatchesPluginFilters(set, other, [key]),
      };
      return null;
    }

    for (const surface of ["work", "prs", "automations"] as const) {
      const view = render(<Probe surface={surface} />);
      await waitFor(() => expect(seen[surface]?.tagged).toBe(true));
      expect(seen[surface]?.other).toBe(false);
      view.unmount();
    }
  });

  it("hides nothing when no chip is selected", async () => {
    let matched: boolean | null = null;
    function Probe() {
      const set = usePluginSurfaceContributions("work", true);
      matched = entityMatchesPluginFilters(set, pluginSessionContext({ id: "chat-2" }), []);
      return null;
    }
    render(<Probe />);
    // An untagged session survives an empty selection — every one of the three
    // new hosts calls this unconditionally, so an empty selection that filtered
    // would empty three lists at once.
    await waitFor(() => expect(matched).toBe(true));
  });
});

describe("detail-section coverage on work and automations", () => {
  it("renders the section its surface declared, and not the other surface's", async () => {
    const work = render(
      <PluginDetailSections
        surface="work"
        context={pluginSessionContext({ id: "chat-1", title: "A chat" })}
      />,
    );
    await waitFor(() => expect(screen.getByText("Session risk")).toBeTruthy());
    expect(screen.queryByText("Rule history")).toBeNull();
    work.unmount();

    render(
      <PluginDetailSections
        surface="automations"
        context={pluginAutomationContext({ id: "rule-1", name: "Nightly", enabled: true })}
      />,
    );
    await waitFor(() => expect(screen.getByText("Rule history")).toBeTruthy());
    expect(screen.queryByText("Session risk")).toBeNull();
  });
});
