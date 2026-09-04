import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import { parsePluginManifestJson, type PluginManifest } from "../../../shared/plugins/manifest";
import { parsePluginPanel, vocabSchemaBytes } from "../../../shared/plugins/vocabulary";
import { VOCAB_LIMITS, coerceBoundListItem } from "../../../shared/plugins/vocabularyNodes";
import {
  PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN,
  PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN,
  PLUGIN_COLLECTION_VALUE_MAX_BYTES,
} from "../../../shared/plugins/sdk";
import {
  PLUGIN_SESSION_CONTEXT_FILE_NAME_PATTERN,
  PLUGIN_SESSION_ENV_KEY_PATTERN,
  RESERVED_PLUGIN_SESSION_ENV_KEYS,
} from "../../../shared/plugins/sessionSetup";
import { CORE_SMART_LINK_HOST_BUILTINS, coreSmartLinkHostOwner } from "../../../shared/plugins/urlMatchers";
import { createPluginInstallService } from "./pluginInstallService";

/**
 * `ade-linear` against the REAL parsers and budgets it has to satisfy.
 *
 * `pilotPackages.test.ts` proves the manifest on disk parses with no warnings.
 * What it cannot prove is the half this plugin computes at RUNTIME on a machine
 * nobody is watching: the row it materializes three times per issue, the schema
 * it publishes with 250 of them behind it, the session env it injects into a
 * launched agent, and the URL matcher only this package is allowed to have.
 * Every one of those is checked here against the same code four clients run.
 *
 * The plugin's own logic is covered by `plugins/ade-linear/test/*.test.js` under
 * `node --test` — CommonJS, exactly as the child bootstrap loads it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const pluginRoot = path.join(repoRoot, "plugins/ade-linear");
const require_ = createRequire(import.meta.url);

// Loaded through `require` on purpose: this is CommonJS plugin code, exactly as
// the child bootstrap loads it, so a syntax error or a missing export fails
// here rather than at install time.
const issueFormat = require_(path.join(pluginRoot, "issueFormat.js")) as {
  normalizeIssue: (node: unknown) => Record<string, unknown>;
  issueBranchName: (issue: { identifier: string; title: string }) => string;
  issueRefFromRow: (row: Record<string, unknown>) => Record<string, unknown>;
};
const flows = require_(path.join(pluginRoot, "flows.js")) as {
  sessionSetupFor: (rows: unknown[], nowIso: string) => {
    env: Record<string, string>;
    contextFile: { name: string; content: string };
  };
};
const contract = require_(path.join(pluginRoot, "panels/contract.js")) as {
  flatIssueKey: (rank: number, issueId: string) => string;
  groupIssueKey: (stateId: string, rank: number, issueId: string) => string;
  commentKey: (issueId: string, rank: number, commentId: string) => string;
  ACTIONS: Record<string, string>;
  ISSUE_ROW_ACTIONS: string[];
};
const panels = require_(path.join(pluginRoot, "panels.js")) as {
  build: (panelId: string, model?: unknown, context?: unknown) => unknown;
};

function manifest(): PluginManifest {
  const parsed = parsePluginManifestJson(fs.readFileSync(path.join(pluginRoot, "plugin.json"), "utf8"));
  expect(parsed.errors).toEqual([]);
  expect(parsed.warnings).toEqual([]);
  expect(parsed.manifest).not.toBeNull();
  return parsed.manifest!;
}

function issueNode(index: number, over: Record<string, unknown> = {}) {
  return {
    id: `issue-${index}`,
    identifier: `ENG-${index}`,
    title: `Fix the flaky sync test number ${index}`,
    description: "A paragraph of context that a reader would actually have written.\n\nAnd a second one.",
    url: `https://linear.app/acme/issue/ENG-${index}/fix-the-flaky-sync-test`,
    priority: index % 5,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    dueDate: null,
    estimate: null,
    archivedAt: null,
    completedAt: null,
    project: { id: "proj-1", name: "Platform" },
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    state: { id: `state-${index % 4}`, name: "In Progress", type: "started" },
    assignee: { id: "user-1", name: "ada", displayName: "Ada Lovelace" },
    creator: { id: "user-2", name: "grace", displayName: "Grace Hopper" },
    labels: { nodes: [{ id: "label-1", name: "bug", color: "#f00" }] },
    children: { nodes: [] },
    ...over,
  };
}

describe("the row ade-linear materializes", () => {
  it("survives the vocabulary's own list coercion with its display fields intact", () => {
    const row = issueFormat.normalizeIssue(issueNode(1));
    const item = coerceBoundListItem(row, undefined, "issue:issue-1");
    expect(item).not.toBeNull();
    expect(item?.title).toBe(row.title);
    expect(item?.subtitle).toBe("ENG-1 · In Progress");
  });

  it("fits a single collection value many times over", () => {
    // A row that blew the cap would fail its `put` and vanish from the list —
    // the reader would lose the ROW because of the BODY.
    const row = issueFormat.normalizeIssue(issueNode(1, { description: "x".repeat(8_000) }));
    expect(Buffer.byteLength(JSON.stringify(row), "utf8")).toBeLessThan(PLUGIN_COLLECTION_VALUE_MAX_BYTES);
  });

  it("fits the whole plugin budget at the ceiling it writes to", () => {
    // 250 issues, each stored three times: by id, by sort rank, and inside its
    // state group. This is the arithmetic `data.js`'s header claims.
    const rows = Array.from({ length: 250 }, (_, index) => issueFormat.normalizeIssue(issueNode(index)));
    const bytes = rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row), "utf8"), 0) * 3;
    expect(rows.length * 3).toBeLessThan(PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN);
    expect(bytes).toBeLessThan(PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN);
  });

  it("keys the three copies so each sorts the way its panel draws", () => {
    const flat = [3, 1, 2].map((rank) => contract.flatIssueKey(rank, `i${rank}`)).sort();
    expect(flat).toEqual([
      contract.flatIssueKey(1, "i1"),
      contract.flatIssueKey(2, "i2"),
      contract.flatIssueKey(3, "i3"),
    ]);
    // Six digits, so a workspace bigger than five would order still sorts.
    expect(contract.flatIssueKey(12, "x") < contract.flatIssueKey(101, "x")).toBe(true);
    expect(contract.groupIssueKey("s1", 2, "x").startsWith("group:s1:")).toBe(true);
    expect(contract.commentKey("a", 1, "c1") < contract.commentKey("a", 2, "c2")).toBe(true);
  });
});

describe("the panels ade-linear publishes at runtime", () => {
  it("every declared schema file parses as a panel", () => {
    for (const panel of manifest().panels) {
      if (!panel.schemaFile) continue;
      const parsed = parsePluginPanel(
        JSON.parse(fs.readFileSync(path.join(pluginRoot, panel.schemaFile), "utf8")),
      );
      expect(parsed.ok, panel.schemaFile).toBe(true);
    }
  });

  it("every runtime-built panel parses and fits the schema cap", () => {
    // The static files above are the fallback a client draws with no plugin
    // process. These are what the plugin actually publishes, and nothing else
    // checks them.
    const issue = issueFormat.normalizeIssue(issueNode(1));
    const cases: Array<[string, unknown, unknown]> = [
      ["main", {}, null],
      ["issues", { state: "loading" }, null],
      ["issues", { state: "empty", groups: [] }, null],
      ["issues", {
        state: "list",
        groups: [{ stateId: "state-0", stateName: "In Progress", stateType: "started", rank: 3, count: 40 }],
        statePreset: "all",
        sort: "updated_desc",
        hasProjects: true,
        hasPeople: true,
        workspace: "Acme",
        age: "just now",
      }, null],
      ["issue", { state: "detail", issue: null, error: "gone" }, { issueId: "issue-1" }],
      ["issue", {
        state: "detail",
        issue,
        subIssues: [],
        comments: [{ id: "c1", title: "Ada", subtitle: "Looks right to me.", body: "Looks right to me." }],
        commentsState: "loaded",
      }, { issueId: "issue-1" }],
      ["launch", { state: "form", issue: null, error: "gone" }, { issueId: "issue-1" }],
      ["launch", {
        state: "form",
        issue,
        models: [{ id: "codex/gpt", label: "GPT" }],
        permissionModes: [{ value: "full-auto", label: "Full auto" }],
        reasoningEfforts: [{ value: "high", label: "High" }],
        laneName: "ENG-1 Fix the flaky sync test number 1",
        branchName: "eng-1-fix-the-flaky-sync-test-number-1",
        kickoff: "Pick up ENG-1.",
      }, { issueId: "issue-1" }],
      ["settings", { state: "disconnected", connection: null }, null],
      ["settings", {
        state: "connected",
        connection: { connected: true, authMode: "apiKey", viewerName: "Ada", oauthAvailable: false },
        ingress: { status: "Waiting for the signing secret", tone: "warning", url: "https://relay.example/x", secretStored: false },
      }, null],
      ["settings", {
        state: "connected",
        connection: {
          connected: true,
          authMode: "oauth",
          viewerName: "Ada Lovelace",
          organizationName: "Acme",
          organizationUrlKey: "acme",
          webhookUrl: "https://relay.example/plugin/ade-linear/linear",
        },
        settings: { moveToDoneOnMerge: true },
        teams: [{ id: "t1", key: "ENG", name: "Engineering" }],
        showAutolinks: true,
        autolinks: [{ id: "ENG", teamKey: "ENG", keyPrefix: "ENG-", title: "ENG-<num>", subtitle: "Engineering" }],
        githubRepo: "acme/app",
        ingress: { url: "https://relay.example/plugin/ade-linear/linear" },
      }, null],
    ];

    for (const [panelId, model, context] of cases) {
      const schema = panels.build(panelId, model, context);
      const parsed = parsePluginPanel(schema);
      expect(parsed.ok, `${panelId} ${JSON.stringify(model).slice(0, 60)}`).toBe(true);
      expect(vocabSchemaBytes(schema)).toBeLessThanOrEqual(VOCAB_LIMITS.maxSchemaBytes);
    }
  });

  it("names a panel for every id the manifest declares", () => {
    for (const panel of manifest().panels) {
      expect(panels.build(panel.id, {}, null), panel.id).not.toBeNull();
    }
  });
});

describe("the IssueRef ade-linear hands to lanes.linkIssue", () => {
  const ref = issueFormat.issueRefFromRow(issueFormat.normalizeIssue(issueNode(1)));

  it("never names its own plugin, which the host stamps", () => {
    expect("pluginId" in ref).toBe(false);
  });

  it("carries the branch name git will actually use", () => {
    expect(ref.branchName).toBe(issueFormat.issueBranchName({ identifier: "ENG-1", title: "Fix the flaky sync test number 1" }));
  });
});

describe("the session setup ade-linear injects into a launched agent", () => {
  const setup = flows.sessionSetupFor(
    [issueFormat.normalizeIssue(issueNode(1))],
    "2026-08-31T00:00:00.000Z",
  );

  it("uses only keys the host's own pattern accepts", () => {
    for (const key of Object.keys(setup.env)) {
      expect(PLUGIN_SESSION_ENV_KEY_PATTERN.test(key), key).toBe(true);
    }
  });

  it("shadows none of the names the host reserves inside that prefix", () => {
    for (const key of Object.keys(setup.env)) {
      expect(RESERVED_PLUGIN_SESSION_ENV_KEYS.includes(key), key).toBe(false);
    }
  });

  it("writes a context file the host will accept and an agent can parse", () => {
    expect(PLUGIN_SESSION_CONTEXT_FILE_NAME_PATTERN.test(setup.contextFile.name)).toBe(true);
    expect(() => JSON.parse(setup.contextFile.content)).not.toThrow();
  });
});

describe("the URL matcher only this package may have", () => {
  it("claims linear.app, which every other plugin is refused", () => {
    // The refusal exists to stop a plugin drawing over ADE's own links. It says
    // nothing useful to the one plugin that IS the surface.
    expect(coreSmartLinkHostOwner("linear.app")).toBe("Linear");
    expect(coreSmartLinkHostOwner("linear.app", new Set(["linear"]))).toBeNull();
    expect(CORE_SMART_LINK_HOST_BUILTINS["linear.app"]).toBe("linear");
  });

  it("does not unlock a wildcard, for the owner or for anyone", () => {
    // `*.linear.app` claims names core never parsed, and `*.app` would reach
    // the same door through the suffix rule.
    expect(coreSmartLinkHostOwner("*.linear.app", new Set(["linear"]))).toBe("Linear");
    expect(coreSmartLinkHostOwner("*.app", new Set(["linear"]))).toBe("Linear");
  });

  it("does not unlock a host with no gateable built-in behind it", () => {
    expect(coreSmartLinkHostOwner("github.com", new Set(["linear", "github"]))).toBe("GitHub");
  });

  it("is declared on the manifest and parsed without a warning", () => {
    const matcher = manifest().urlMatchers?.find((entry) => entry.id === "issue");
    expect(matcher?.hosts).toEqual(["linear.app"]);
    expect(matcher?.panelId).toBe("issue");
  });
});

// The relay's own allowlist is asserted where the relay is typechecked:
// `apps/webhook-relay/test/pluginIngress.test.ts` proves `linear-signature` is
// stored. Importing `relay.ts` here would pull the Workers ambient types into
// the desktop program, which is a boundary this test is not worth crossing.

describe("the dressed row the panels bind", () => {
  const rows = require_(path.join(pluginRoot, "panels/rows.js")) as {
    issueListRow: (issue: unknown) => Record<string, unknown>;
    issueIdFromRowKey: (key: string) => string | null;
  };

  it("coerces to a list item with its chip, its press and its bare-id key", () => {
    // The undressed row carried `badgeText`/`badgeTone`, which `readListItem`
    // ignores — it drew as a bare title with no chip and no press.
    const row = rows.issueListRow(issueFormat.normalizeIssue(issueNode(1)));
    const item = coerceBoundListItem(row, contract.ISSUE_ROW_ACTIONS, "flat:000001:issue-1");
    expect(item).not.toBeNull();
    expect(item?.key).toBe("issue-1");
    expect(item?.badge?.text).toBe("In Progress");
    expect(item?.onPress).not.toBeUndefined();
  });

  it("presses NOTHING when the binding declares no allowlist", () => {
    // `allowActions` is an allowlist, and an absent one allows nothing: a
    // stored row can only ever press a verb the PANEL declared. That is the
    // property that stops a collection row from naming `disconnect`.
    const row = rows.issueListRow(issueFormat.normalizeIssue(issueNode(1)));
    const item = coerceBoundListItem(row, undefined, "flat:000001:issue-1");
    expect(item?.onPress).toBeUndefined();
    expect(item?.actions ?? []).toEqual([]);
  });

  it("names only verbs inside ISSUE_ROW_ACTIONS", () => {
    // The audit: a row that could press `disconnect` because a collection said
    // so is exactly what the allowlist exists to prevent.
    const row = rows.issueListRow(issueFormat.normalizeIssue(issueNode(1)));
    const named = [
      (row.onPress as { action: string }).action,
      ...((row.actions ?? []) as Array<{ action: string }>).map((entry) => entry.action),
      ...((row.overflow ?? []) as Array<{ action: string }>).map((entry) => entry.action),
    ];
    for (const action of named) {
      expect(contract.ISSUE_ROW_ACTIONS, action).toContain(action);
    }
  });

  it("names only tones the vocabulary has", () => {
    // `VocabTone` is neutral | accent | success | warning. `info` is not one,
    // and a tone outside the set is coerced to the fallback rather than
    // failing — so the badge renders flat and nothing reports it.
    const tones = new Set(["neutral", "accent", "success", "warning"]);
    for (const type of ["triage", "backlog", "unstarted", "started", "completed", "canceled"]) {
      const row = rows.issueListRow(issueFormat.normalizeIssue(issueNode(1, {
        state: { id: "s", name: "S", type },
      })));
      expect(tones.has(String(row.tone)), `${type} → ${row.tone}`).toBe(true);
      expect(tones.has(String((row.badge as Record<string, unknown>).tone)), `${type} badge`).toBe(true);
    }
  });

  it("strips a sort prefix off a selection key", () => {
    // A bulk handler that took the collection key would create a lane named
    // after a sort rank.
    expect(rows.issueIdFromRowKey("flat:000012:issue-9")).toBe("issue-9");
    expect(rows.issueIdFromRowKey("group:state-0:000003:issue-9")).toBe("issue-9");
    expect(rows.issueIdFromRowKey("issue-9")).toBe("issue-9");
  });
});

describe("installing ade-linear from the bundled directory", () => {
  const roots: string[] = [];
  const scratchRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-install-"));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  });

  const logger = (): Logger =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger);

  it("installs with every surface, socket and registration intact", async () => {
    const root = scratchRoot();
    const install = createPluginInstallService({
      logger: logger(),
      pluginsRoot: root,
      builtinPluginsRoot: path.join(repoRoot, "plugins"),
    });

    const installed = await install.install({ source: "ade-linear" });

    expect(installed.errors).toEqual([]);
    expect(installed.warnings).toEqual([]);
    expect(installed.record.pluginId).toBe("ade-linear");
    expect(installed.record.source.kind).toBe("builtin");
    expect(installed.record.enabled).toBe(true);

    // Six surfaces, one page. Every placement Linear draws is a `webview`
    // surface pointing at the same `dist/index.html`; the page reads the host's
    // injected `surfaceId` to know which of the six it is. `issues` keeps its
    // id from the tab it replaced, because a tab badge is addressed by
    // `"<pluginId>/<surfaceId>"`.
    //
    // The seventh was `quickview`, the top bar's popover, and it went with the
    // `toolbar-action` that opened it.
    expect(installed.manifest?.surfaces.map((surface) => surface.id)).toEqual([
      "issues",
      "settings",
      "picker",
      // The Create-lane and Create-PR picker, drawn inside ADE's own dialogs.
      // Its own surface rather than a reuse of `picker`: the composer picker
      // answers with `composer.attach` and this one with `dialog.submit`.
      "dialog-picker",
      "badge-card",
      "issue-context",
    ]);
    expect(installed.manifest?.surfaces.every((surface) => surface.kind === "webview")).toBe(true);
    expect(installed.manifest?.surfaces.every((surface) => surface.entryHtml === "dist/index.html")).toBe(true);
    // Every one still names a panel. That panel is what the phone, the terminal
    // and an older desktop draw, which is the whole reason a page may be added
    // without taking the plugin away from three clients.
    expect(installed.manifest?.surfaces.every((surface) => Boolean(surface.panelId))).toBe(true);
    expect(installed.manifest?.sockets.map((socket) => socket.socket)).toEqual([
      "work-rail-pane",
      // Menu rows, not chrome buttons. The composer's bar and the chat header
      // are permanent slots shared by every plugin ever installed, and neither
      // is one Linear spends now.
      "composer-menu-item",
      "chat-menu-item",
      "row-badge",
      // The two dialog pickers. Both name the same page and the same panel;
      // `dialog` is what tells them apart, and it is why the payload carries it.
      "dialog-section",
      "dialog-section",
      "settings-section",
      "command-palette-action",
      // The transcript's issue context.
      "chat-card",
      // The Automations grid: one tile with the five triggers and the webhook
      // block, then the two rules that used to be settings toggles.
      "automation-trigger-tile",
      "automation-template",
      "automation-template",
    ]);
    // Eight of the thirteen sockets name a page to draw instead of their panel,
    // and each names one this manifest actually declares — an unresolvable id
    // would silently fall back to the panel forever.
    const surfaceIds = new Set(installed.manifest?.surfaces.map((surface) => surface.id) ?? []);
    const upgraded = (installed.manifest?.sockets ?? []).filter((socket) => socket.webviewSurfaceId);
    expect(upgraded.map((socket) => socket.id)).toEqual([
      "issues-pane",
      "attach-issue",
      "chat-issue",
      "lane-issue",
      "create-lane-issue",
      "create-pr-issue",
      "connection",
      "issue-context",
    ]);
    for (const socket of upgraded) {
      expect(surfaceIds.has(socket.webviewSurfaceId!), socket.id).toBe(true);
    }

    // No `builtin` anywhere, and there cannot be one: `linear` supersedes, so
    // the parser refuses the field on any surface that names it. The plugin
    // draws its own issues tab and ADE's compiled Linear steps aside. Nothing
    // official-only is left on the surfaces at all — the one remaining
    // official-only declaration is the `linear.app` URL matcher below, which is
    // unlocked by OWNERSHIP rather than by `builtin`.
    expect(installed.manifest?.surfaces.every((surface) => surface.builtin === undefined)).toBe(true);
    expect(installed.manifest?.urlMatchers?.map((matcher) => matcher.hosts)).toEqual([["linear.app"]]);

    expect(installed.manifest?.network?.hosts).toEqual(["api.linear.app"]);
    // NO credential handoff. The plugin used to inherit the compiled
    // integration's Linear token on install day, which made a real sign-in the
    // second-best path and left the plugin's own OAuth flow untested on the
    // only machines anyone ran it on. It signs in like any other plugin now.
    expect(installed.manifest?.credentialHandoff).toBeUndefined();
    expect(installed.manifest?.webhookIngress.map((channel) => channel.id)).toEqual(["linear"]);
    // Declared, so the channel fails closed without the signing secret. It
    // costs no installed base: the built-in's webhooks run through
    // `linearIngressService`, never through this channel.
    expect(installed.manifest?.webhookIngress[0]?.verify).toMatchObject({
      kind: "hmac-sha256",
      secretRef: "LINEAR_WEBHOOK_SECRET",
      header: "linear-signature",
    });
    expect(installed.manifest?.authSessions?.map((session) => session.id)).toEqual(["linear"]);
    expect(installed.manifest?.tools.map((tool) => tool.name).sort()).toEqual([
      "add_comment", "add_label", "assign_issue", "create_lane_for_issue", "get_issue",
      "graphql", "list_states", "search_issues", "update_issue_state",
    ]);
    expect(installed.manifest?.automationTriggers.map((trigger) => trigger.id)).toEqual([
      "issue_created", "issue_updated", "issue_assigned", "issue_status_changed", "issue_labeled",
    ]);

    // The entry, every panel schema and the skill all have to be on disk.
    const installedRoot = path.join(root, "ade-linear");
    expect(fs.existsSync(path.join(installedRoot, "index.js"))).toBe(true);
    for (const panel of installed.manifest?.panels ?? []) {
      if (!panel.schemaFile) continue;
      expect(fs.existsSync(path.join(installedRoot, panel.schemaFile)), panel.schemaFile).toBe(true);
    }
    expect(fs.existsSync(path.join(installedRoot, "skills/ade-linear/SKILL.md"))).toBe(true);
  });

  it("copies every module the entry point requires", async () => {
    // A missing sibling is an install that succeeds and a child that dies on
    // its first `require`, which reads as a crash loop rather than as a
    // packaging mistake.
    const root = scratchRoot();
    const install = createPluginInstallService({
      logger: logger(),
      pluginsRoot: root,
      builtinPluginsRoot: path.join(repoRoot, "plugins"),
    });
    await install.install({ source: "ade-linear" });

    // Derived from the source tree rather than listed, so a module added to
    // either half of the package is covered without editing this test — which
    // is the only way a list like this stays true.
    const installedRoot = path.join(root, "ade-linear");
    const sourceModules = [
      ...fs.readdirSync(pluginRoot).filter((name) => name.endsWith(".js")),
      ...fs.readdirSync(path.join(pluginRoot, "panels"))
        .filter((name) => name.endsWith(".js"))
        .map((name) => path.join("panels", name)),
    ];
    expect(sourceModules.length).toBeGreaterThan(10);
    for (const file of sourceModules) {
      expect(fs.existsSync(path.join(installedRoot, file)), file).toBe(true);
    }
  });

  it("ships no dependencies", () => {
    // The house rule from `plugins/README.md`. A `node_modules` in a published
    // package is a supply chain nobody reviewed.
    expect(fs.existsSync(path.join(pluginRoot, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(pluginRoot, "package.json"))).toBe(false);
  });
});
