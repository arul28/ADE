import { describe, expect, it } from "vitest";

import { PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES } from "../../../shared/plugins/sdk";
import type { BuiltinGateInput } from "../plugins/builtinTabs";
import {
  issueTargetFromPluginDeeplink,
  resolveIssueDeeplinkRouting,
  resolvePluginDeeplinkRouting,
} from "./pluginDeeplinkRoute";

function gateInput(overrides: Partial<BuiltinGateInput> = {}): BuiltinGateInput {
  return {
    pluginSupport: true,
    pluginsLoaded: true,
    plugins: [],
    ...overrides,
  };
}

function installed(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "ade-graph",
    displayName: "Graph",
    version: "1.0.0",
    enabled: true,
    icon: null,
    accent: null,
    status: "running",
    tabs: [],
    theme: null,
    ...overrides,
  } as unknown as BuiltinGateInput["plugins"][number];
}

function tab(id: string) {
  return { id, title: id, panelId: id };
}

function jira(overrides: Record<string, unknown> = {}) {
  return installed({
    pluginId: "ade-jira",
    displayName: "Jira",
    tabs: [tab("issue")],
    ...overrides,
  });
}

function searchOf(routing: { kind: string } & Record<string, unknown>): URLSearchParams {
  return new URL(String(routing.path ?? ""), "https://x.invalid").searchParams;
}

describe("resolvePluginDeeplinkRouting", () => {
  it("opens the panel route when the plugin is installed and enabled", () => {
    expect(
      resolvePluginDeeplinkRouting(
        { pluginId: "ade-graph", panelId: "overview" },
        gateInput({ plugins: [installed()] }),
      ),
    ).toEqual({ kind: "open", path: "/plugin/ade-graph?panel=overview" });
  });

  it("carries the context as a single-encoded ctx param", () => {
    const routing = resolvePluginDeeplinkRouting(
      { pluginId: "ade-graph", panelId: "overview", context: { issue: "ISS-14" } },
      gateInput({ plugins: [installed()] }),
    );
    expect(routing.kind).toBe("open");
    const search = new URL(
      routing.kind === "open" ? routing.path : "",
      "https://x.invalid",
    ).searchParams;
    expect(search.get("panel")).toBe("overview");
    expect(JSON.parse(search.get("ctx") ?? "null")).toEqual({ issue: "ISS-14" });
  });

  it("drops a context that will not serialize rather than failing the link", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      resolvePluginDeeplinkRouting(
        { pluginId: "ade-graph", panelId: "overview", context: cyclic },
        gateInput({ plugins: [installed()] }),
      ),
    ).toEqual({ kind: "open", path: "/plugin/ade-graph?panel=overview" });
  });

  it("refuses under the plugin's name when the registry knows it but it is off", () => {
    expect(
      resolvePluginDeeplinkRouting(
        { pluginId: "ade-graph", panelId: "overview" },
        gateInput({ plugins: [installed({ enabled: false })] }),
      ),
    ).toEqual({ kind: "refuse", title: "Graph" });
  });

  it("refuses under the plugin id when it is not installed", () => {
    expect(
      resolvePluginDeeplinkRouting({ pluginId: "ade-graph", panelId: "overview" }, gateInput()),
    ).toEqual({ kind: "refuse", title: "ade-graph" });
  });

  it("drops a context over the 2 KiB ceiling rather than routing with one no link could carry", () => {
    const routing = resolvePluginDeeplinkRouting(
      {
        pluginId: "ade-graph",
        panelId: "overview",
        context: { blob: "x".repeat(PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES) },
      },
      gateInput({ plugins: [installed()] }),
    );
    expect(routing).toEqual({ kind: "open", path: "/plugin/ade-graph?panel=overview" });
  });

  it("refuses while the registry is unresolved or the host has no plugins at all", () => {
    // Both are the hide-everything default: an unresolved registry must not
    // read as "installed", and it must not read differently from "absent".
    expect(
      resolvePluginDeeplinkRouting(
        { pluginId: "ade-graph", panelId: "overview" },
        gateInput({ pluginsLoaded: false, plugins: [installed()] }),
      ),
    ).toEqual({ kind: "refuse", title: "ade-graph" });
    expect(
      resolvePluginDeeplinkRouting(
        { pluginId: "ade-graph", panelId: "overview" },
        gateInput({ pluginSupport: false, plugins: [installed()] }),
      ),
    ).toEqual({ kind: "refuse", title: "ade-graph" });
  });
});

describe("resolveIssueDeeplinkRouting", () => {
  const jiraIssue = {
    kind: "issue" as const,
    provider: "jira",
    issueKey: "PROJ-9",
    branch: "arul/proj-9",
  };

  it("opens the owning plugin's panel with the issue as its context", () => {
    const routing = resolveIssueDeeplinkRouting(
      jiraIssue,
      gateInput({ plugins: [jira()] }),
      [{ provider: "jira", pluginId: "ade-jira", panelId: "issue" }],
    );
    expect(routing.kind).toBe("open");
    const search = searchOf(routing as never);
    expect(search.get("panel")).toBe("issue");
    expect(JSON.parse(search.get("ctx") ?? "null")).toEqual({
      issue: { provider: "jira", key: "PROJ-9", branch: "arul/proj-9" },
    });
  });

  it("prefers the plugin the link names over the provider's registered owner", () => {
    // The link was minted by a specific plugin. Someone else claiming the
    // provider on this machine must not silently take over the destination.
    const routing = resolveIssueDeeplinkRouting(
      { ...jiraIssue, pluginId: "ade-jira" },
      gateInput({ plugins: [jira(), installed({ pluginId: "other-jira", tabs: [tab("main")] })] }),
      [{ provider: "jira", pluginId: "other-jira", panelId: "main" }],
    );
    expect((routing as { path?: string }).path?.startsWith("/plugin/ade-jira?")).toBe(true);
  });

  it("falls back to the local owner when the plugin the link names is not here", () => {
    // The link was minted on another machine, where the same tracker is served
    // by a plugin with a different id. Refusing would strand a link whose
    // destination is installed and enabled right here.
    const routing = resolveIssueDeeplinkRouting(
      { ...jiraIssue, pluginId: "someone-elses-jira" },
      gateInput({ plugins: [jira()] }),
      [{ provider: "jira", pluginId: "ade-jira", panelId: "issue" }],
    );
    expect((routing as { path?: string }).path?.startsWith("/plugin/ade-jira?panel=issue")).toBe(true);
  });

  it("falls back to the plugin's own panel when no owner entry names one", () => {
    const routing = resolveIssueDeeplinkRouting(
      { ...jiraIssue, pluginId: "ade-jira" },
      gateInput({ plugins: [jira({ tabs: [tab("board")] })] }),
    );
    expect(searchOf(routing as never).get("panel")).toBe("board");
  });

  it("refuses an unknown or disabled plugin through the same gate as a panel link", () => {
    // Not installed, disabled, registry unresolved, and no plugin support all
    // answer the same — the hide-everything rule, applied to issue links.
    expect(resolveIssueDeeplinkRouting({ ...jiraIssue, pluginId: "ade-jira" }, gateInput()))
      .toEqual({ kind: "refuse", title: "ade-jira" });
    expect(resolveIssueDeeplinkRouting(
      { ...jiraIssue, pluginId: "ade-jira" },
      gateInput({ plugins: [jira({ enabled: false })] }),
    )).toEqual({ kind: "refuse", title: "Jira" });
    expect(resolveIssueDeeplinkRouting(
      { ...jiraIssue, pluginId: "ade-jira" },
      gateInput({ pluginsLoaded: false, plugins: [jira()] }),
    )).toEqual({ kind: "refuse", title: "ade-jira" });
    expect(resolveIssueDeeplinkRouting(
      { ...jiraIssue, pluginId: "ade-jira" },
      gateInput({ pluginSupport: false, plugins: [jira()] }),
    )).toEqual({ kind: "refuse", title: "ade-jira" });
  });

  it("refuses a tracker nobody on this machine speaks for", () => {
    expect(resolveIssueDeeplinkRouting(jiraIssue, gateInput({ plugins: [installed()] })))
      .toEqual({ kind: "refuse", title: "jira" });
  });

  it("refuses an installed plugin that publishes no panel to draw the issue in", () => {
    expect(resolveIssueDeeplinkRouting(
      { ...jiraIssue, pluginId: "ade-jira" },
      gateInput({ plugins: [jira({ tabs: [] })] }),
    )).toEqual({ kind: "refuse", title: "Jira" });
  });

  it("falls through to the built-in Linear surface when no plugin owns linear", () => {
    expect(resolveIssueDeeplinkRouting(
      { kind: "issue", provider: "linear", issueKey: "ADE-123", branch: "feat" },
      gateInput(),
    )).toEqual({ kind: "builtin-linear", issueIdentifier: "ADE-123", branch: "feat" });
    // `core` names ADE itself, not a plugin, so it does not divert the link.
    expect(resolveIssueDeeplinkRouting(
      { kind: "issue", provider: "linear", issueKey: "ADE-123", pluginId: "core" },
      gateInput(),
    )).toEqual({ kind: "builtin-linear", issueIdentifier: "ADE-123", branch: null });
  });

  it("lets a plugin take over linear when one is installed for it", () => {
    const routing = resolveIssueDeeplinkRouting(
      { kind: "issue", provider: "linear", issueKey: "ADE-123" },
      gateInput({ plugins: [installed({ pluginId: "ade-linear", displayName: "Linear", tabs: [tab("issue")] })] }),
      [{ provider: "linear", pluginId: "ade-linear" }],
    );
    expect((routing as { path?: string }).path?.startsWith("/plugin/ade-linear?panel=issue")).toBe(true);
  });

  it("holds the same 2 KiB ctx ceiling as the panel path", () => {
    const routing = resolveIssueDeeplinkRouting(
      { kind: "issue", provider: "jira", issueKey: "PROJ-9", branch: "b".repeat(PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES) },
      gateInput({ plugins: [jira()] }),
      [{ provider: "jira", pluginId: "ade-jira", panelId: "issue" }],
    );
    expect(routing).toEqual({ kind: "open", path: "/plugin/ade-jira?panel=issue" });
  });

  it("matches the provider case-insensitively on both sides", () => {
    const routing = resolveIssueDeeplinkRouting(
      { kind: "issue", provider: "JIRA", issueKey: "PROJ-9" },
      gateInput({ plugins: [jira()] }),
      [{ provider: "Jira", pluginId: "ade-jira", panelId: "issue" }],
    );
    expect(searchOf(routing as never).get("panel")).toBe("issue");
    expect(JSON.parse(searchOf(routing as never).get("ctx") ?? "null"))
      .toEqual({ issue: { provider: "jira", key: "PROJ-9" } });
  });
});

/**
 * Tracker ownership, which was the missing half of `resolveIssueDeeplinkRouting`.
 *
 * The `owners` argument existed and defaulted to an empty list that nothing ever
 * filled, so step 2 of the resolution order was unreachable and a link into a
 * plugin's tracker resolved only when it happened to name that plugin's exact
 * id. It now defaults to the ownership the installed plugins' `urlMatchers`
 * declare — the same declarations that draw the tracker's smart-link chips.
 */
describe("tracker ownership from urlMatchers", () => {
  const jiraMatcher = {
    id: "issue",
    hosts: ["acme.atlassian.net"],
    pathPattern: "/browse/{key}",
    chip: { label: "JIRA {key}" },
    entity: { kind: "issue", provider: "jira", keyFrom: "key" },
  };

  function jiraOwner(overrides: Record<string, unknown> = {}) {
    return jira({ urlMatchers: [jiraMatcher], ...overrides });
  }

  it("routes a provider nobody names to the plugin that declares it", () => {
    // The link says `jira`; no plugin is called `jira`. Before this, the
    // candidate list held only the provider name and the link was refused.
    const routing = resolveIssueDeeplinkRouting(
      { kind: "issue", provider: "jira", issueKey: "ACME-12" },
      gateInput({ plugins: [jiraOwner()] }),
    );
    expect(routing.kind).toBe("open");
    expect(searchOf(routing as never).get("panel")).toBe("issue");
    expect(String((routing as { path: string }).path)).toContain("/plugin/ade-jira");
  });

  it("honours the local owner when the link names a plugin this machine lacks", () => {
    // A link minted on a machine whose Jira plugin has a different id. The local
    // owner is the second candidate, which is what makes such a link open at all.
    const routing = resolveIssueDeeplinkRouting(
      { kind: "issue", provider: "jira", issueKey: "ACME-12", pluginId: "someone-elses-jira" },
      gateInput({ plugins: [jiraOwner()] }),
    );
    expect(routing.kind).toBe("open");
    expect(String((routing as { path: string }).path)).toContain("/plugin/ade-jira");
  });

  it("refuses once the owning plugin is disabled", () => {
    expect(
      resolveIssueDeeplinkRouting(
        { kind: "issue", provider: "jira", issueKey: "ACME-12" },
        gateInput({ plugins: [jiraOwner({ enabled: false })] }),
      ),
    ).toEqual({ kind: "refuse", title: "Jira" });
  });

  it("leaves Linear to the compiled surface, which no plugin may claim", () => {
    // `urlMatchers` refuses `linear` as a provider at parse, so no registry can
    // produce an owner for it and step 3 stays reachable.
    expect(
      resolveIssueDeeplinkRouting(
        { kind: "issue", provider: "linear", issueKey: "ADE-1" },
        gateInput({ plugins: [jiraOwner()] }),
      ),
    ).toEqual({ kind: "builtin-linear", issueIdentifier: "ADE-1", branch: null });
  });

  it("still lets an explicit owners argument override the derived one", () => {
    const routing = resolveIssueDeeplinkRouting(
      { kind: "issue", provider: "jira", issueKey: "ACME-12" },
      gateInput({ plugins: [jiraOwner(), installed({ pluginId: "other", tabs: [tab("x")] })] }),
      [{ provider: "jira", pluginId: "other", panelId: "x" }],
    );
    expect(String((routing as { path: string }).path)).toContain("/plugin/other");
  });
});

describe("issueTargetFromPluginDeeplink", () => {
  it("reads back the issue that deeplinks.ts collapsed into a plugin target", () => {
    expect(
      issueTargetFromPluginDeeplink({
        pluginId: "jira",
        panelId: "issue",
        context: { issue: { provider: "jira", key: "ACME-12", branch: "feat/x" } },
      }),
    ).toEqual({
      kind: "issue",
      provider: "jira",
      issueKey: "ACME-12",
      branch: "feat/x",
      pluginId: "jira",
    });
  });

  it("leaves an ordinary panel link alone", () => {
    // Only the shape the collapse mints is recovered. A plugin link to some
    // other panel, or one carrying no issue, stays an ordinary plugin link.
    expect(
      issueTargetFromPluginDeeplink({ pluginId: "graph", panelId: "overview", context: null }),
    ).toBeNull();
    expect(
      issueTargetFromPluginDeeplink({ pluginId: "graph", panelId: "issue", context: {} }),
    ).toBeNull();
    expect(
      issueTargetFromPluginDeeplink({
        pluginId: "graph",
        panelId: "issue",
        context: { issue: { provider: "jira" } },
      }),
    ).toBeNull();
  });
});
