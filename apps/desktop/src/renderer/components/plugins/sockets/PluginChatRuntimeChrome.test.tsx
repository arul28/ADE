/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  parsePluginChatHeader,
  PluginChatHeaderChips,
  readPluginChatRuntimeCapabilities,
  usePluginChatRuntimeCapabilities,
  PLUGIN_CHAT_HEADER_CHIP_MAX,
} from "./PluginChatRuntimeChrome";

/**
 * The chrome a plugin-owned chat wears.
 *
 * Both halves are read defensively on purpose: the capabilities come off an
 * UNPARSED manifest and the header comes off a session row that crossed the
 * host, the database and the sync wire. The tests below are mostly about what
 * happens when either is wrong.
 */

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [{
        pluginId: "cloudy",
        displayName: "Cloudy",
        enabled: true,
        accent: null,
        icon: null,
        disabledContributions: [],
      }],
      getManifest: async () => ({
        name: "cloudy",
        version: "1.0.0",
        sockets: [],
        chatRuntimes: [
          {
            id: "one-shot",
            displayName: "Cloudy one-shot",
            capabilities: { followUp: false, interrupt: false, hydrate: true, artifacts: true },
          },
          {
            id: "agent",
            displayName: "Cloudy agent",
            capabilities: { followUp: true, interrupt: true, hydrate: true, artifacts: true },
          },
        ],
      }),
      listContributions: async () => [],
      invoke: async () => ({}),
    },
  };
});

afterEach(() => cleanup());

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("readPluginChatRuntimeCapabilities", () => {
  const manifest = {
    chatRuntimes: [
      { id: "strict", capabilities: { followUp: false, interrupt: false, hydrate: false, artifacts: false } },
      { id: "loose", capabilities: {} },
    ],
  };

  it("reads the four booleans off the named runtime", () => {
    expect(readPluginChatRuntimeCapabilities(manifest, "strict")).toEqual({
      followUp: false,
      interrupt: false,
      hydrate: false,
      artifacts: false,
    });
  });

  it("treats a missing capability as ON", () => {
    // A manifest older than the field must not lose its Stop button. Only a
    // literal `false` takes a control away.
    expect(readPluginChatRuntimeCapabilities(manifest, "loose")).toEqual({
      followUp: true,
      interrupt: true,
      hydrate: true,
      artifacts: true,
    });
  });

  it("answers null for anything it cannot resolve", () => {
    expect(readPluginChatRuntimeCapabilities(manifest, "renamed")).toBeNull();
    expect(readPluginChatRuntimeCapabilities({ chatRuntimes: "nope" }, "strict")).toBeNull();
    expect(readPluginChatRuntimeCapabilities(null, "strict")).toBeNull();
    expect(readPluginChatRuntimeCapabilities({}, "strict")).toBeNull();
  });
});

function CapabilityProbe({ pluginId, runtimeId }: { pluginId: string | null; runtimeId: string }) {
  const caps = usePluginChatRuntimeCapabilities(pluginId ? { pluginId, runtimeId } : null);
  return <span data-testid="caps">{caps ? `${caps.followUp}/${caps.interrupt}` : "none"}</span>;
}

describe("usePluginChatRuntimeCapabilities", () => {
  it("resolves the runtime that owns the session", async () => {
    render(<CapabilityProbe pluginId="cloudy" runtimeId="one-shot" />);
    await waitFor(() => expect(screen.getByTestId("caps").textContent).toBe("false/false"));
  });

  it("answers none for a session no plugin owns", async () => {
    render(<CapabilityProbe pluginId={null} runtimeId="one-shot" />);
    await waitFor(() => expect(screen.getByTestId("caps").textContent).toBe("none"));
  });

  it("answers none for a plugin that is not installed here", async () => {
    render(<CapabilityProbe pluginId="ghost" runtimeId="one-shot" />);
    await waitFor(() => expect(screen.getByTestId("caps").textContent).toBe("none"));
  });
});

describe("parsePluginChatHeader", () => {
  it("keeps well-formed chips and folds an absent tone to neutral", () => {
    expect(parsePluginChatHeader({ label: "Cloudy", chips: [{ label: "queued" }, { label: "3 files", tone: "success" }] }))
      .toEqual({
        label: "Cloudy",
        chips: [{ label: "queued", tone: "neutral" }, { label: "3 files", tone: "success" }],
      });
  });

  it("trims the list at the cap", () => {
    const chips = Array.from({ length: PLUGIN_CHAT_HEADER_CHIP_MAX + 3 }, (_, i) => ({ label: `c${i}` }));
    expect(parsePluginChatHeader({ chips })?.chips).toHaveLength(PLUGIN_CHAT_HEADER_CHIP_MAX);
  });

  it("refuses an over-long label rather than cutting it mid-word", () => {
    const parsed = parsePluginChatHeader({
      chips: [{ label: "x".repeat(25) }, { label: "fits" }],
    });
    expect(parsed?.chips).toEqual([{ label: "fits", tone: "neutral" }]);
  });

  it("draws nothing for a malformed header", () => {
    expect(parsePluginChatHeader(undefined)).toBeNull();
    expect(parsePluginChatHeader(null)).toBeNull();
    expect(parsePluginChatHeader("queued")).toBeNull();
    expect(parsePluginChatHeader({ chips: "queued" })).toBeNull();
    expect(parsePluginChatHeader({ chips: [1, null, { label: "" }] })).toBeNull();
    expect(parsePluginChatHeader({ label: "x".repeat(40) })).toBeNull();
  });

  it("folds an unknown tone rather than dropping the chip", () => {
    expect(parsePluginChatHeader({ chips: [{ label: "hot", tone: "nonsense" }] })?.chips)
      .toEqual([{ label: "hot", tone: "neutral" }]);
    expect(parsePluginChatHeader({ chips: [{ label: "bad", tone: "error" }] })?.chips)
      .toEqual([{ label: "bad", tone: "destructive" }]);
  });
});

describe("PluginChatHeaderChips", () => {
  it("renders the label and every surviving chip", () => {
    render(<PluginChatHeaderChips header={parsePluginChatHeader({
      label: "Cloudy",
      chips: [{ label: "queued" }, { label: "2 files", tone: "accent" }],
    })} />);

    expect(screen.getByText("Cloudy")).toBeTruthy();
    expect(screen.getByText("queued")).toBeTruthy();
    expect(screen.getByText("2 files")).toBeTruthy();
  });

  it("renders nothing at all with no header", () => {
    const { container } = render(<PluginChatHeaderChips header={null} />);
    expect(container.innerHTML).toBe("");
  });
});
