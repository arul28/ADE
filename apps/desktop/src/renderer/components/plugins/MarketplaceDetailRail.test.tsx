/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";

import { ContributionsRail, WebhooksRail, WhereItShowsUpRail } from "./MarketplaceDetailRail";
import type { PluginManifest } from "../../../shared/plugins/manifest";
import type { PluginWebhookIngressStatus } from "../../../shared/plugins/sdk";

/**
 * "Installed" and "visible on my phone" are different facts, and this section
 * is the only place on the page that says so. The tests below are about the
 * resting state carrying an honest answer without the socket vocabulary: a
 * reader who never opens the disclosure should still learn that one of the
 * things this plugin adds does not reach their phone.
 */

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "ade-tipsy",
    version: "0.3.0",
    displayName: "Tipsy",
    description: "A drink counter.",
    vocabVersion: 1,
    entry: "index.js",
    surfaces: [],
    panels: [],
    sockets: [
      { socket: "composer-action", surface: "work", id: "drink", label: "Take a drink", actionId: "drink" },
      { socket: "slash-command", surface: "work", id: "sober", command: "sober-up", actionId: "sober" },
    ],
    collections: {},
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
    ...overrides,
  };
}

afterEach(cleanup);

describe("WhereItShowsUpRail", () => {
  it("answers for every device, and counts the partial one", () => {
    render(<WhereItShowsUpRail manifest={manifest()} showSkillTiming={false} />);

    expect(screen.getByText("Where it shows up")).toBeTruthy();
    for (const device of ["desktop", "web", "iPhone", "terminal"]) {
      expect(screen.getByText(device)).toBeTruthy();
    }
    // Desktop draws both; the phone draws one of the two; the terminal neither.
    expect(screen.getAllByText("everything it adds").length).toBeGreaterThan(0);
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getByText("nothing it adds")).toBeTruthy();
  });

  it("names the missing addition by the plugin's own label, behind the disclosure", () => {
    render(<WhereItShowsUpRail manifest={manifest()} showSkillTiming={false} />);
    // The slash command declares no label, so it falls back to its socket id.
    expect(screen.getByText("Not drawn on iPhone: sober")).toBeTruthy();
    expect(screen.getByText("Not drawn on terminal: Take a drink, sober")).toBeTruthy();
  });

  it("says nothing at all when every device draws everything", () => {
    const { container } = render(
      <WhereItShowsUpRail
        manifest={manifest({
          sockets: [{ socket: "row-badge", surface: "lanes", id: "level", label: "Level" }],
        })}
        showSkillTiming={false}
      />,
    );
    expect(screen.queryByText("Details")).toBeNull();
    expect(container.textContent).toContain("everything it adds");
  });

  it("carries the next-turn timing for an installed plugin that ships a skill", () => {
    render(<WhereItShowsUpRail manifest={manifest({ skills: ["skills/tipsy"] })} showSkillTiming />);
    expect(screen.getByText(/running turns keep their current behavior/)).toBeTruthy();
  });

  it("is the timing note alone for a skill-only plugin, and absent for neither", () => {
    const skillOnly = render(
      <WhereItShowsUpRail manifest={manifest({ sockets: [], skills: ["skills/tipsy"] })} showSkillTiming />,
    );
    expect(screen.getByText(/next turn/)).toBeTruthy();
    expect(screen.queryByText("desktop")).toBeNull();
    skillOnly.unmount();

    const { container } = render(
      <WhereItShowsUpRail manifest={manifest({ sockets: [] })} showSkillTiming />,
    );
    expect(container.textContent).toBe("");
  });
});

/**
 * The webhook rail is a SETUP surface: the person reading it is about to paste
 * a URL into a third party. The tests below hold that shape — the URL is
 * readable and copyable, a missing signing secret is named, and the health line
 * never invents a delivery that has not happened.
 */
function ingressStatus(
  overrides: Partial<PluginWebhookIngressStatus> = {},
): PluginWebhookIngressStatus {
  return {
    pluginId: "ade-tipsy",
    state: "ready",
    relayBaseUrl: "https://relay.example",
    channels: [
      {
        channelId: "default",
        label: "Drink events",
        url: "https://relay.example/plugin/ade-tipsy/webhook",
        verified: false,
        lastReceivedAt: null,
      },
    ],
    lastReceivedAt: null,
    lastPolledAt: null,
    lastError: null,
    pendingDeliveries: 0,
    abandonedDeliveries: 0,
    ...overrides,
  };
}

/**
 * The switches, and the sentence that tells two of them apart.
 *
 * HN adds a button to the chat header and a pane to the Work tools rail. Both
 * are labelled "HN" by their author and both are on the Work surface, so the
 * rows read "HN · in Work" twice — two identical switches with two different
 * effects, which is what the dogfood run met. The kind is the only thing that
 * separates them, so it is on the row and on the accessible name.
 */
describe("ContributionsRail", () => {
  const hn = manifest({
    name: "hn",
    displayName: "Hacker News",
    panels: [{ id: "stories", title: "Hacker News" }],
    sockets: [
      { socket: "chat-header-action", surface: "work", id: "hn", label: "HN", actionId: "openStories" },
      { socket: "work-rail-pane", surface: "work", id: "stories", label: "HN", panelId: "stories" },
    ],
  });

  function mount(overrides: { disabled?: string[] } = {}) {
    return render(
      <ContributionsRail
        manifest={hn}
        adds={[]}
        pluginId="hn"
        disabledContributions={overrides.disabled ?? []}
        canToggle
        onError={() => {}}
      />,
    );
  }

  it("names the socket kind, so two same-label rows are not the same row", () => {
    mount();

    expect(screen.getByText("Chat header button in Work")).toBeTruthy();
    expect(screen.getByText("Work tools pane in Work")).toBeTruthy();
    expect(screen.getAllByText("HN")).toHaveLength(2);
  });

  it("puts the same sentence on the accessible name of each switch", () => {
    mount();

    expect(screen.getByRole("switch", { name: "HN — Chat header button in Work" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "HN — Work tools pane in Work" })).toBeTruthy();
  });

  it("still reflects which of the two the reader switched off", () => {
    mount({ disabled: ["stories"] });

    expect(
      screen.getByRole("switch", { name: "HN — Chat header button in Work" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("switch", { name: "HN — Work tools pane in Work" }).getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("WebhooksRail", () => {
  it("shows the URL and copies it", async () => {
    const copied: string[] = [];
    Object.assign(navigator, {
      clipboard: { writeText: async (text: string) => { copied.push(text); } },
    });

    render(<WebhooksRail status={ingressStatus()} />);
    expect(screen.getByText("https://relay.example/plugin/ade-tipsy/webhook")).toBeTruthy();
    // Nothing has arrived, and the line says what to do about it rather than
    // reporting a failure that has not happened.
    expect(screen.getByText(/Paste the URL above/)).toBeTruthy();

    screen.getByRole("button", { name: "Copy" }).click();
    await Promise.resolve();
    expect(copied).toEqual(["https://relay.example/plugin/ade-tipsy/webhook"]);
  });

  it("names a signing secret the plugin still needs", () => {
    render(<WebhooksRail status={ingressStatus({
      channels: [{
        channelId: "billing",
        label: "Billing",
        url: "https://relay.example/plugin/ade-tipsy/webhook/billing",
        verified: true,
        missingSecretRef: "STRIPE_SIGNING_SECRET",
        lastReceivedAt: null,
      }],
    })} />);

    expect(screen.getByText(/STRIPE_SIGNING_SECRET/)).toBeTruthy();
  });

  it("reports a relay failure instead of silence", () => {
    render(<WebhooksRail status={ingressStatus({ state: "error", lastError: "relay unreachable" })} />);
    expect(screen.getByText(/relay unreachable/)).toBeTruthy();
  });

  it("draws nothing for a plugin with no channels", () => {
    const { container } = render(<WebhooksRail status={ingressStatus({ channels: [] })} />);
    expect(container.textContent).toBe("");
  });
});
