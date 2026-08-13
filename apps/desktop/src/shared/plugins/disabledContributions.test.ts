import { describe, expect, it } from "vitest";

import {
  isPluginRegistrationDisabled,
  pluginActionIsFullyDisabled,
  pluginRegistrationContributionKey,
} from "./disabledContributions";
import type { PluginManifest } from "./manifest";

/**
 * The user's per-contribution switch, as every consumer resolves it.
 *
 * Two failures this guards, both of them silent: a toggle that reaches the menu
 * but not the invoke path (the switch looks obeyed and is not), and a toggle
 * that reaches too far because a registration id happened to match a socket id
 * (the user hides a badge and their keyboard shortcut stops working).
 */

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "tracker",
    version: "1.0.0",
    displayName: "Tracker",
    description: "",
    vocabVersion: 1,
    entry: "index.js",
    surfaces: [],
    panels: [],
    sockets: [],
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
    ...over,
  } as PluginManifest;
}

const badge = (id: string, actionId: string) => ({
  socket: "row-badge",
  surface: "lanes",
  id,
  label: id,
  actionId,
}) as unknown as PluginManifest["sockets"][number];

describe("pluginActionIsFullyDisabled", () => {
  it("refuses only when EVERY contribution offering the action is off", () => {
    const declared = manifest({
      sockets: [badge("badge", "openIssue"), badge("menu", "openIssue")],
    });

    expect(pluginActionIsFullyDisabled(declared, [], "openIssue")).toBe(false);
    expect(pluginActionIsFullyDisabled(declared, ["badge"], "openIssue")).toBe(false);
    expect(pluginActionIsFullyDisabled(declared, ["badge", "menu"], "openIssue")).toBe(true);
  });

  it("never refuses an action no contribution declares", () => {
    // Reached from a schedule, an automation or a CLI word, all of which have
    // their own gates. There is no toggle for it to disobey.
    const declared = manifest({ sockets: [badge("badge", "openIssue")] });
    expect(pluginActionIsFullyDisabled(declared, ["badge"], "syncNow")).toBe(false);
  });

  it("counts engine registrations, under their kind-qualified keys", () => {
    const declared = manifest({
      searchProviders: [{ id: "issues", label: "Issues", action: "openIssue" }],
      keybindings: [{ action: "openIssue", binding: "Mod+Shift+I", label: "Open issue" }],
      automationSteps: [{ id: "open", label: "Open", action: "openIssue" }],
    });

    // The bare id is a SOCKET key and must not silence a provider.
    expect(pluginActionIsFullyDisabled(declared, ["issues"], "openIssue")).toBe(false);

    const allOff = [
      pluginRegistrationContributionKey("search", "issues"),
      pluginRegistrationContributionKey("keybinding", "openIssue"),
      pluginRegistrationContributionKey("automationStep", "open"),
    ];
    expect(pluginActionIsFullyDisabled(declared, allOff, "openIssue")).toBe(true);
    expect(pluginActionIsFullyDisabled(declared, allOff.slice(1), "openIssue")).toBe(false);
  });

  it("leaves agent tools out of the join", () => {
    // A tool is not a rail row. If it were counted, switching off the badge
    // would withdraw a tool the agent was already told it had.
    const declared = manifest({
      sockets: [badge("badge", "openIssue")],
      tools: [{ name: "open_issue", description: "", input: { type: "object" }, action: "openIssue" }] as PluginManifest["tools"],
    });
    expect(pluginActionIsFullyDisabled(declared, ["badge"], "openIssue")).toBe(true);
  });

  it("is a no-op without a manifest or without any disabled ids", () => {
    expect(pluginActionIsFullyDisabled(null, ["badge"], "openIssue")).toBe(false);
    expect(pluginActionIsFullyDisabled(manifest(), [], "openIssue")).toBe(false);
  });
});

describe("isPluginRegistrationDisabled", () => {
  it("matches its own kind only", () => {
    const off = ["search:issues"];
    expect(isPluginRegistrationDisabled(off, "search", "issues")).toBe(true);
    expect(isPluginRegistrationDisabled(off, "automationTrigger", "issues")).toBe(false);
    expect(isPluginRegistrationDisabled(["issues"], "search", "issues")).toBe(false);
  });
});
