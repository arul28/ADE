/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";

import { WhereItShowsUpRail } from "./MarketplaceDetailRail";
import type { PluginManifest } from "../../../shared/plugins/manifest";

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
