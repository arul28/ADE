/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { PendingInputRequest } from "../../../shared/types";
import {
  PendingInputAskerMark,
  PendingInputMarketplaceLink,
  pendingInputAskerLabel,
  pendingInputMarketplaceRoute,
} from "./pendingInputAsker";
import { PluginIconTile } from "../plugins/marketplaceUi";
import { pluginIdentity } from "../plugins/pluginIcons";
import { ADE_NAVIGATE_TARGET_EVENT, type NavigateTargetDetail } from "../../lib/openExternal";

/**
 * The card's identity row.
 *
 * The defect these cover: every gate the host raises for a plugin — install,
 * remove, turn off, turn on — travels as `source: "ade"`, so the header drew
 * ADE's mark and the word "ADE" above a decision about somebody else's code.
 */

const request = (overrides: Partial<PendingInputRequest> = {}): PendingInputRequest => ({
  requestId: "req-1",
  itemId: "item-1",
  source: "ade",
  kind: "approval",
  title: "Install Focus 1.0.0?",
  description: "Adds: Focus tab",
  questions: [{
    id: "plugin_install",
    header: "Plugin install",
    question: "Install Focus 1.0.0?",
    options: [
      { label: "Install", value: "install", decision: "accept" },
      { label: "Don't install", value: "deny", decision: "decline" },
    ],
  }],
  allowsFreeform: false,
  blocking: true,
  canProceedWithoutAnswer: false,
  ...overrides,
});

const pluginRequest = (overrides: Partial<PendingInputRequest> = {}): PendingInputRequest => request({
  origin: { kind: "plugin", pluginId: "ade-focus", displayName: "Focus", icon: "timer" },
  providerMetadata: {
    pluginInstall: true,
    pluginId: "ade-focus",
    source: "/Users/someone/plugins/focus",
    sourceKind: "path",
    trust: "community",
  },
  ...overrides,
});

beforeEach(() => {
  cleanup();
});

describe("pendingInputAskerLabel", () => {
  it("names the plugin and keeps the kind word", () => {
    expect(pendingInputAskerLabel(pluginRequest())).toBe("Focus · Approval");
  });

  it("leaves a card with no plugin origin exactly as it was", () => {
    expect(pendingInputAskerLabel(request())).toBe("ADE · Approval");
    expect(pendingInputAskerLabel(request({ source: "claude", kind: "question" }))).toBe("Claude asks");
  });
});

describe("PendingInputAskerMark", () => {
  it("draws the plugin the way the Marketplace draws it", () => {
    // Compared against a real `PluginIconTile` render rather than against a
    // hard-coded path: the assertion is "one plugin, one face", and a brittle
    // svg-path expectation would pass while the two drifted.
    const { container } = render(<PendingInputAskerMark request={pluginRequest()} size={17} />);
    const expected = render(
      <PluginIconTile
        identity={pluginIdentity({ pluginId: "ade-focus", icon: "timer", accent: null })}
        size={17}
        label="Focus"
      />,
      { container: document.body.appendChild(document.createElement("div")) },
    );
    const drawn = container.querySelector("[data-testid='pending-input-plugin-mark']");
    expect(drawn).toBeTruthy();
    expect(drawn?.querySelector("svg")?.innerHTML)
      .toBe(expected.container.querySelector("svg")?.innerHTML);
  });

  it("resolves a brand token to the vendor's mark, not the puzzle default", () => {
    const brand = render(
      <PendingInputAskerMark
        request={pluginRequest({
          origin: {
            kind: "plugin",
            pluginId: "ade-cursor-cloud",
            displayName: "Cursor Cloud",
            icon: "brand:cursor",
          },
        })}
        size={17}
      />,
    );
    const unknown = render(
      <PendingInputAskerMark
        request={pluginRequest({
          origin: {
            kind: "plugin",
            pluginId: "ade-cursor-cloud",
            displayName: "Cursor Cloud",
            icon: "brand:not-a-vendor",
          },
        })}
        size={17}
      />,
    );
    const html = (result: ReturnType<typeof render>) =>
      result.container.querySelector("[data-testid='pending-input-plugin-mark']")?.innerHTML ?? "";
    expect(html(brand).length).toBeGreaterThan(0);
    expect(html(brand)).not.toBe(html(unknown));
  });

  it("draws ADE's real mark, not a letter, when no plugin is named", () => {
    const { container } = render(<PendingInputAskerMark request={request()} size={12} />);
    expect(container.querySelector("[data-testid='pending-input-plugin-mark']")).toBeNull();
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toContain("ade-icon.webp");
    expect(image?.getAttribute("alt")).toBe("ADE");
    // The placeholder this replaced: a grey circle with the family's first
    // letter in it.
    expect(container.textContent).toBe("");
  });
});

describe("View in Marketplace", () => {
  it("hands a local-folder candidate to the install dialog, prefilled", () => {
    expect(pendingInputMarketplaceRoute(pluginRequest()))
      .toBe(`/marketplace?install=${encodeURIComponent("/Users/someone/plugins/focus")}`);
  });

  it("deep-links an official candidate to its own page", () => {
    expect(pendingInputMarketplaceRoute(pluginRequest({
      providerMetadata: {
        pluginInstall: true,
        pluginId: "ade-linear",
        source: "ade-linear",
        sourceKind: "builtin",
        trust: "official",
      },
      origin: { kind: "plugin", pluginId: "ade-linear", displayName: "Linear" },
    }))).toBe("/marketplace/ade-linear");
  });

  it("deep-links a removal card, whose plugin is installed and has a page", () => {
    expect(pendingInputMarketplaceRoute(pluginRequest({
      providerMetadata: { pluginLifecycle: "uninstall", pluginId: "ade-focus" },
    }))).toBe("/marketplace/ade-focus");
  });

  it("offers nothing on a card that names no plugin", () => {
    expect(pendingInputMarketplaceRoute(request())).toBeNull();
    const { container } = render(<PendingInputMarketplaceLink request={request()} />);
    expect(container.innerHTML).toBe("");
  });

  it("navigates without answering the card", () => {
    // The whole point of the affordance: it is a link, not a decision. If it
    // resolved the pending input, the agent's blocked call would be answered by
    // somebody who only wanted to read the disclosure.
    const seen: NavigateTargetDetail[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<NavigateTargetDetail>).detail);
    };
    window.addEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);
    try {
      render(<PendingInputMarketplaceLink request={pluginRequest()} />);
      fireEvent.click(screen.getByTestId("pending-input-marketplace-link"));
    } finally {
      window.removeEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.target).toEqual({
      kind: "route",
      route: `/marketplace?install=${encodeURIComponent("/Users/someone/plugins/focus")}`,
    });
    // Navigation is ALL it did. The component takes no decision callback at
    // all, so there is no branch in which reading the disclosure answers the
    // gate; `type="button"` keeps it out of any enclosing form's submit too.
    expect(screen.getByTestId("pending-input-marketplace-link").getAttribute("type")).toBe("button");
  });
});
