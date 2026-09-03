import { describe, expect, it } from "vitest";

import type { AutomationTrigger } from "../../../shared/types";
import { triggerMatches, type TriggerContext } from "./automationService";

/**
 * The declarative filters an `automation-trigger-tile` writes onto a rule, at
 * the moment they decide whether it runs.
 *
 * They are matched HOST-side, and this file is the proof that the code agrees
 * with that claim. The alternative — leaving them to the plugin's own emission —
 * is not reachable: `ade.automations.emitTrigger` says only THAT something
 * happened, and a plugin has no way to read the user's rules, so filters left
 * to it would narrow nothing while looking like they did.
 *
 * The fail-closed cases are the point. A filter the payload does not carry
 * refuses the event, for the same reason the identity check above it does: a
 * rule that fires on events its own filter says to ignore is one a user cannot
 * debug from the rule in front of them.
 */

function pluginEvent(payload?: Record<string, unknown>): TriggerContext {
  return {
    triggerType: "plugin",
    plugin: {
      pluginId: "graph",
      triggerId: "issueMoved",
      ...(payload ? { payload } : {}),
    },
  } as TriggerContext;
}

function rule(pluginFilters?: Record<string, string>): AutomationTrigger {
  return {
    type: "plugin",
    pluginId: "graph",
    pluginTrigger: "issueMoved",
    ...(pluginFilters ? { pluginFilters } : {}),
  };
}

const matches = (ruleTrigger: AutomationTrigger, event: TriggerContext): boolean =>
  triggerMatches(ruleTrigger, event, undefined, undefined);

describe("plugin trigger tile filters", () => {
  it("runs the rule when the payload carries the value the filter asked for", () => {
    expect(matches(rule({ teamId: "team-1" }), pluginEvent({ teamId: "team-1" }))).toBe(true);
  });

  it("refuses an event whose value differs", () => {
    expect(matches(rule({ teamId: "team-1" }), pluginEvent({ teamId: "team-2" }))).toBe(false);
  });

  it("refuses an event that does not carry the key at all", () => {
    expect(matches(rule({ teamId: "team-1" }), pluginEvent({ projectId: "p1" }))).toBe(false);
    expect(matches(rule({ teamId: "team-1" }), pluginEvent())).toBe(false);
  });

  it("requires every filter, not any", () => {
    const both = rule({ teamId: "team-1", projectId: "p1" });
    expect(matches(both, pluginEvent({ teamId: "team-1", projectId: "p1" }))).toBe(true);
    expect(matches(both, pluginEvent({ teamId: "team-1", projectId: "p2" }))).toBe(false);
  });

  it("reads a list payload as membership — the shape a `labels` filter needs", () => {
    expect(matches(rule({ labels: "bug" }), pluginEvent({ labels: ["chore", "bug"] }))).toBe(true);
    expect(matches(rule({ labels: "bug" }), pluginEvent({ labels: ["chore"] }))).toBe(false);
    expect(matches(rule({ labels: "bug" }), pluginEvent({ labels: [] }))).toBe(false);
  });

  it("compares non-string payload values by their text, since a filter is text", () => {
    expect(matches(rule({ number: "42" }), pluginEvent({ number: 42 }))).toBe(true);
  });

  it("ignores a filter whose value is blank — an empty expectation is no filter", () => {
    expect(matches(rule({ teamId: "  " }), pluginEvent({ projectId: "p1" }))).toBe(true);
  });

  it("still refuses another plugin's event before it ever looks at filters", () => {
    const other = { ...pluginEvent({ teamId: "team-1" }) };
    other.plugin = { pluginId: "costguard", triggerId: "issueMoved", payload: { teamId: "team-1" } };
    expect(matches(rule({ teamId: "team-1" }), other)).toBe(false);
  });

  it("leaves a rule with no filters matching every one of its plugin's events", () => {
    expect(matches(rule(), pluginEvent({ teamId: "anything" }))).toBe(true);
  });
});
