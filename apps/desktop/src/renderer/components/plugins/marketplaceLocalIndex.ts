/**
 * The bundled plugin index.
 *
 * ADE's directory lives in a public repository whose index is rebuilt by a
 * scheduled job (design decision D16). That is the right home for it and the
 * wrong thing to depend on at first paint: it is a network fetch, it can be
 * unreachable, and until the registry is populated it has nothing in it. So the
 * official set ships inside the app and the live index is layered on top —
 * `mergeMarketplaceCatalogue` compares versions for the same id and keeps the
 * higher one, breaking a tie in the directory's favour. So a published entry
 * that is ahead of this file replaces it, and one that is behind it does not:
 * an index generated before this build lists these same ids at older versions,
 * and letting it win would offer the user a downgrade.
 *
 * What is deliberately NOT here: install counts and stars. Those are facts the
 * directory measures, and inventing plausible-looking numbers for the bundled
 * copy would poison the one signal the gallery has. They stay null, the stats
 * column renders nothing, and the popularity sorts push these entries down to
 * the unranked tail — which is exactly where an unmeasured plugin belongs.
 *
 * The manifests below are the real shapes these plugins ship, so the install
 * modal's "Adds" list is derived rather than written by hand. They are copies —
 * this module is bundled into the renderer by Vite and `plugins/` sits outside
 * the Vite root, so there is no import that could read the real file — and a
 * copy drifts silently: the install still works, but `describeManifestAdds`
 * under-reports what the package adds on exactly the path where this file is
 * what the reader sees (offline, or before the directory has the entry).
 * `marketplaceLocalIndex.test.ts` deep-equals every literal below against its
 * `plugins/<id>/plugin.json`, so keep them complete and let that test pin them.
 */

import type { PluginManifest } from "../../../shared/plugins/manifest";
import type { MarketplaceListing } from "./marketplaceModel";
import { derivePluginKind, surfacesFromManifest } from "./marketplaceModel";
import { MARKETPLACE_OFFICIAL_THEMES } from "./marketplaceThemeCatalog";

/**
 * Where the official packages are published.
 *
 * One constant, never spelled out at a call site: the organisation moved once
 * already (from `ade-plugins` to `arul28`, which is where the directory
 * repository actually lives), and the only reason that rename was a one-line
 * change is that nothing below knows the org exists. Every official plugin's
 * repository is `${REGISTRY_ORG}/<pluginId>`.
 */
const REGISTRY_ORG = "https://github.com/arul28";

/**
 * Fills the fields every manifest has but most official plugins leave empty.
 *
 * Exported below as `withBundledManifestDefaults` for one caller: the mirror
 * test, which has to run a parsed `plugin.json` through the identical defaults
 * before it can compare. A `plugin.json` omits everything defaulted here, so a
 * test that normalised only one side would report a dozen phantom differences
 * and drown the real one.
 */
function manifest(partial: Partial<PluginManifest> & Pick<PluginManifest,
  "name" | "version" | "displayName" | "description">): PluginManifest {
  return {
    vocabVersion: 1,
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
    chatRuntimes: [],
    webhookIngress: [],
    official: true,
    ...partial,
  };
}

/**
 * Graph, as the real product rather than a gate.
 *
 * The gate is gone. `graph` is a SUPERSEDED surface now, so the plugin may not
 * name it with `builtin` at all — it draws its own panels and ADE's compiled
 * Graph tab steps aside. The React Flow engine stays in core; this package is
 * the UI, the lane list on phone and terminal, and the `workspace` canvas.
 */
const GRAPH = manifest({
  name: "ade-graph",
  version: "2.0.2",
  displayName: "Graph",
  description: "Lanes, commits and PR overlays on one canvas — the same Graph ADE already ships, as a plugin.",
  icon: "graph",
  accent: "#6366F1",
  entry: "index.js",
  surfaces: [
    { kind: "webview", id: "graph", title: "Graph", icon: "graph", entryHtml: "dist/index.html", panelId: "graph", order: 50, mobile: false },
    { kind: "webview", id: "lane", title: "Lane", icon: "git-branch", entryHtml: "dist/index.html", panelId: "lane", popover: { width: 720, height: 520 }, mobile: false },
  ],
  panels: [
    { id: "graph", schemaFile: "panels/graph.json", title: "Graph", icon: "graph", refreshAction: "refreshGraph" },
    { id: "lane", schemaFile: "panels/lane.json", title: "Lane", icon: "git-branch", refreshAction: "openLane" },
  ],
  sockets: [
    { socket: "command-palette-action", surface: "app", id: "palette-graph", label: "Graph", icon: "graph", actionId: "openGraph", webviewSurfaceId: "graph" },
  ],
  collections: {
    lanes: { sync: true },
  },
  tools: [
    {
      name: "list_lanes",
      description: "List the project's open lanes, the same rows the Graph canvas binds.",
      action: "listLanesTool",
      input: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_lane",
      description: "Fetch one lane the Graph canvas can open.",
      action: "getLaneTool",
      input: {
        type: "object",
        properties: {
          laneId: { type: "string", description: "The lane id to fetch." },
        },
        required: ["laneId"],
      },
    },
  ],
  cli: [],
  skills: ["skills"],
});

/**
 * Review, as the real product rather than a gate.
 *
 * The gate is gone. `review` is a SUPERSEDED surface now, so the plugin may not
 * name it with `builtin` at all — it draws its own page and ADE's compiled
 * Review tab steps aside. The engine stays in core; this package is the UI,
 * the PR toolbar, the agent tools and `ade review`.
 *
 * At 2.0.0 the UI is the plugin's own HTML page: `runs` draws the run list, the
 * run detail and the learnings, and `launch` is the anchored popover the PR
 * toolbar button opens. Both keep a `panelId`, which is what the terminal and
 * a client that cannot draw the page render in its place.
 */
const REVIEW = manifest({
  name: "ade-review",
  version: "2.0.2",
  displayName: "Review",
  description: "Run AI review passes over a lane, a commit range, uncommitted changes, or a pull request, and act on the findings.",
  icon: "git-pull-request",
  accent: "#22A06B",
  entry: "index.js",
  surfaces: [
    { kind: "webview", id: "runs", title: "Review", icon: "git-pull-request", entryHtml: "dist/index.html", panelId: "runs", order: 45, mobile: false },
    { kind: "webview", id: "launch", title: "Launch a review", icon: "play", entryHtml: "dist/index.html", panelId: "launch", popover: { width: 560, height: 640 }, mobile: false },
  ],
  panels: [
    { id: "runs", schemaFile: "panels/runs.json", title: "Review", icon: "git-pull-request", refreshAction: "refreshRuns" },
    { id: "run", schemaFile: "panels/run.json", title: "Review run", icon: "git-pull-request", refreshAction: "refreshRun" },
    { id: "launch", schemaFile: "panels/launch.json", title: "Launch a review", icon: "play" },
    { id: "learnings", schemaFile: "panels/learnings.json", title: "Review learnings", icon: "sparkle", refreshAction: "refreshLearnings" },
  ],
  sockets: [
    { socket: "toolbar-action", surface: "prs", id: "request-review", label: "ADE review", icon: "sparkle", actionId: "openLaunchFromPr", webviewSurfaceId: "launch" },
    // No `webviewSurfaceId`: `sockets.ts` does not read one on a `row-menu-item`,
    // and a field the parser ignores would fail the zero-warnings gate.
    { socket: "row-menu-item", surface: "prs", id: "request-review-row", label: "ADE review…", icon: "sparkle", actionId: "openLaunchFromPr" },
    { socket: "command-palette-action", surface: "app", id: "palette-runs", label: "Review runs", icon: "git-pull-request", actionId: "openRuns", webviewSurfaceId: "runs" },
    { socket: "command-palette-action", surface: "app", id: "palette-launch", label: "Launch a review", icon: "play", actionId: "openLaunch", webviewSurfaceId: "launch" },
  ],
  collections: {
    runs: { sync: true },
    findings: { sync: true },
    suppressions: { sync: true },
    // The page's own filters and route state. Per-machine, so never synced.
    "ui-state": { sync: false },
  },
  tools: [
    {
      name: "list_runs",
      description: "List ADE AI review runs for this project, newest first.",
      action: "listRunsTool",
      input: {
        type: "object",
        properties: {
          laneId: { type: "string", description: "Limit to this lane." },
          status: {
            type: "string",
            description: "queued, running, completed, failed, cancelled, or all.",
          },
          limit: { type: "integer", description: "How many runs to return. Defaults to 50." },
        },
        required: [],
      },
    },
    {
      name: "start_run",
      description: "Start an AI review of a lane, commit range, working tree, or pull request.",
      action: "startRun",
      input: {
        type: "object",
        properties: {
          laneId: { type: "string", description: "The lane to review." },
          targetMode: {
            type: "string",
            description: "lane_diff, commit_range, working_tree, or pr.",
          },
          compareKind: {
            type: "string",
            description: "default_branch or lane. Only for lane_diff.",
          },
          compareLaneId: { type: "string", description: "The other lane, when compareKind is lane." },
          baseCommit: { type: "string", description: "Excluded base SHA for commit_range." },
          headCommit: { type: "string", description: "Included head SHA for commit_range." },
          prId: { type: "string", description: "ADE pull-request id for pr mode." },
          modelId: { type: "string" },
          reasoningEffort: { type: "string" },
          fastMode: { type: "boolean" },
          publishBehavior: {
            type: "string",
            description: "local_only or auto_publish.",
          },
        },
        required: ["laneId"],
      },
    },
    {
      name: "get_run",
      description: "Fetch one review run with its findings, artifacts, and publication status.",
      action: "getRunTool",
      input: {
        type: "object",
        properties: {
          runId: { type: "string", description: "The review run id." },
        },
        required: ["runId"],
      },
    },
    {
      name: "record_feedback",
      description: "Acknowledge, dismiss, snooze, or suppress a review finding.",
      action: "recordFeedback",
      input: {
        type: "object",
        properties: {
          findingId: { type: "string" },
          kind: {
            type: "string",
            description: "acknowledge, dismiss, snooze, or suppress.",
          },
          reason: { type: "string" },
          note: { type: "string" },
          snoozeDurationMs: { type: "integer" },
          suppressionScope: {
            type: "string",
            description: "repo, path, or global. Only for suppress.",
          },
        },
        required: ["findingId", "kind"],
      },
    },
  ],
  cli: ["runs", "launch", "learnings"],
  skills: ["skills"],
});

/**
 * History, as the real product rather than a gate.
 *
 * The gate is gone. `history` is a SUPERSEDED surface now, so the plugin may not
 * name it with `builtin` at all — it draws its own page and panels and ADE's
 * compiled History tab steps aside. The git and operation engines stay in core;
 * this package is the UI and `ade history activity`.
 *
 * ONE webview surface and ONE palette row, because that is what the compiled
 * product was: a `/history` route with a Commits / Activity toggle in its
 * toolbar, and a "Go to History" row in ⌘K that navigated to it. The palette
 * row deliberately declares no `webviewSurfaceId` — a row that declares one
 * opens the page as an overlay instead of invoking, and History is a tab.
 */
const HISTORY = manifest({
  name: "ade-history",
  version: "2.0.2",
  displayName: "History",
  description: "Browse commits and lane operations — the same History ADE already ships, as a plugin.",
  icon: "clock-counter-clockwise",
  accent: "#E0932F",
  entry: "index.js",
  surfaces: [
    { kind: "webview", id: "commits", title: "History", icon: "clock-counter-clockwise", entryHtml: "dist/index.html", panelId: "commits", order: 55, mobile: false },
  ],
  panels: [
    { id: "commits", schemaFile: "panels/commits.json", title: "History", icon: "clock-counter-clockwise", refreshAction: "refreshCommits" },
    { id: "commit", schemaFile: "panels/commit.json", title: "Commit", icon: "git-commit", refreshAction: "refreshCommit" },
    { id: "activity", schemaFile: "panels/activity.json", title: "Activity", icon: "list", refreshAction: "refreshActivity" },
    { id: "event", schemaFile: "panels/event.json", title: "Operation", icon: "clock-counter-clockwise", refreshAction: "openEvent" },
  ],
  sockets: [
    { socket: "command-palette-action", surface: "app", id: "palette-commits", label: "Go to History", icon: "clock-counter-clockwise", actionId: "openCommits" },
  ],
  collections: {
    commits: { sync: true },
    operations: { sync: true },
    files: { sync: true },
    lanes: { sync: true },
    "ui-state": { sync: false },
  },
  tools: [
    {
      name: "list_commits",
      description: "List recent commits for a lane, newest first.",
      action: "listCommitsTool",
      input: {
        type: "object",
        properties: {
          laneId: { type: "string", description: "The lane whose git history to read." },
          limit: { type: "integer", description: "How many commits to return. Defaults to 50." },
        },
        required: ["laneId"],
      },
    },
    {
      name: "get_commit",
      description: "Fetch one commit summary for a lane.",
      action: "getCommitTool",
      input: {
        type: "object",
        properties: {
          laneId: { type: "string" },
          sha: { type: "string", description: "The full commit SHA." },
        },
        required: ["laneId", "sha"],
      },
    },
    {
      name: "list_operations",
      description: "List persisted lane operations, newest first.",
      action: "listOperationsTool",
      input: {
        type: "object",
        properties: {
          laneId: { type: "string" },
          kind: { type: "string" },
          status: { type: "string", description: "running, succeeded, failed, canceled, or all." },
          limit: { type: "integer" },
        },
        required: [],
      },
    },
    {
      name: "get_operation",
      description: "Fetch one persisted lane operation.",
      action: "getOperationTool",
      input: {
        type: "object",
        properties: {
          operationId: { type: "string" },
        },
        required: ["operationId"],
      },
    },
  ],
  cli: ["activity"],
  skills: ["skills"],
});

/**
 * Linear, as the real integration rather than a gate.
 *
 * The gate is gone. `linear` is a SUPERSEDED surface now, so the plugin may not
 * name it with `builtin` at all — it draws its own panels and ADE's compiled
 * Linear steps aside. What is left is an ordinary package, and the biggest one
 * ADE ships: a `tab`, eight sockets, five panels, eight collections, three
 * settings, five automation triggers, four automation steps, a search provider,
 * a keybinding, nine agent tools, a CLI word, a skills directory and its own
 * OAuth flow. It declares NO credential handoff: it signs in the way a
 * community plugin does, so an install on a machine that never connected ADE's
 * compiled Linear is the same install as any other. The one official-only thing
 * is the `urlMatchers` entry claiming `linear.app`, present below, which only
 * the plugin that OWNS the `linear` built-in surface may declare — and
 * ownership, not the `builtin` field, is what unlocks it.
 */
const LINEAR = manifest({
  name: "ade-linear",
  version: "2.1.2",
  displayName: "Linear",
  description: "Browse Linear issues, start a lane and an agent on one, and keep the issue moving — from ADE, on every device.",
  icon: "brand:linear",
  accent: "#5E6AD2",
  entry: "index.js",
  brandIcons: {
    linear: "icons/linear.svg",
  },
  network: { hosts: ["api.linear.app"] },
  // Declared, not optional: the install card has to be able to say "signs you
  // in to Linear" before any of the plugin's code runs, and `authorizeUrl` is
  // the one value a runtime argument may never choose.
  authSessions: [{
    id: "linear",
    provider: "Linear",
    authorizeUrl: "https://linear.app/oauth/authorize",
    callbacks: ["loopback", "app"],
    loopback: { port: 19837, path: "/oauth/callback" },
  }],
  webhookIngress: [{
    id: "linear",
    label: "Linear issue events",
    description: "Where Linear posts an issue that changed. Automations → Linear registers it for you.",
    // Linear signs with its OWN secret, so the relay's per-plugin check is not
    // the only one that has to pass — the host verifies this signature itself,
    // constant-time, before a delivery goes anywhere near the plugin child.
    verify: { kind: "hmac-sha256", secretRef: "LINEAR_WEBHOOK_SECRET", header: "linear-signature" },
  }],
  // The official-only claim on `linear.app`. See the block comment above: it is
  // ownership of the superseded `linear` built-in surface that unlocks this,
  // and it is why the plugin needs no `builtin` field to replace it.
  urlMatchers: [{
    id: "issue",
    hosts: ["linear.app"],
    pathPattern: "/{workspace}/issue/{key}/**",
    chip: { label: "{key}", icon: "brand:linear" },
    panelId: "issue",
  }],
  // Six webview surfaces, one page. Linear ships its own HTML now
  // (`plugins/ade-linear/dist/`), and each placement is a `webview` surface
  // pointing at the same `entryHtml`; the page reads the host's injected
  // `surfaceId` to know which of the six it is drawing. Every one keeps a
  // `panelId`, which is what the phone, the terminal and an older desktop
  // render in its place.
  //
  // The seventh was `quickview`, the top bar's popover, and it went with the
  // `toolbar-action` that opened it. `issue-context` gained a popover size in
  // its place: it is drawn both as a card inside the transcript and as the
  // anchored popover the chat menu's Issue context row opens.
  surfaces: [
    { kind: "webview", id: "issues", title: "Linear", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issues", order: 55, mobile: false },
    { kind: "webview", id: "settings", title: "Linear connection", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "settings", mobile: false },
    { kind: "webview", id: "picker", title: "Attach a Linear issue", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issues", popover: { width: 940, height: 640 }, mobile: false },
    { kind: "webview", id: "dialog-picker", title: "Link a Linear issue", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issues", mobile: false },
    { kind: "webview", id: "badge-card", title: "Linear issue", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issue", popover: { width: 300, height: 280 }, mobile: false },
    { kind: "webview", id: "issue-context", title: "Linear issue", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issue", mobile: false, popover: { width: 360, height: 420 } },
  ],
  // `webviewSurfaceId` is the upgrade, never the replacement: a client that can
  // host a plugin page draws the page, and every other client draws the
  // `panelId` or invokes the `actionId` beside it, exactly as before.
  sockets: [
    { socket: "work-rail-pane", surface: "work", id: "issues-pane", label: "Linear", icon: "brand:linear", panelId: "issues", webviewSurfaceId: "issues" },
    // A row in the composer's three-dot menu, not a button on its bar. The bar
    // has room for a handful of affordances for every plugin ever installed,
    // and attach is not the one this plugin gets to spend it on.
    { socket: "composer-menu-item", surface: "work", id: "attach-issue", label: "Attach a Linear issue", icon: "brand:linear", actionId: "openIssuePicker", webviewSurfaceId: "picker" },
    // The chat's own Linear row, nested under the menu's Issue context submenu.
    // It replaces the chat-header button and its dropdown; the page it opens
    // carries all four verbs the header offered — open, detach, attach and the
    // progress comment.
    { socket: "chat-menu-item", surface: "work", id: "chat-issue", label: "Linear", icon: "brand:linear", submenu: "issue-context", actionId: "openSessionIssue", webviewSurfaceId: "issue-context" },
    { socket: "row-badge", surface: "lanes", id: "lane-issue", label: "Linear issue", icon: "brand:linear", webviewSurfaceId: "badge-card" },
    // The Create-lane and Create-PR issue pickers, drawn as `dialog-picker`
    // guests inside ADE's own dialogs and answering them with `dialog.submit`.
    { socket: "dialog-section", surface: "lanes", id: "create-lane-issue", label: "Linear issue", icon: "brand:linear", panelId: "issues", dialog: "create-lane", webviewSurfaceId: "dialog-picker" },
    { socket: "dialog-section", surface: "prs", id: "create-pr-issue", label: "Linear issue", icon: "brand:linear", panelId: "issues", dialog: "create-pr", webviewSurfaceId: "dialog-picker" },
    // `section` puts the card on Settings > Integrations rather than on
    // General, which is where an unnamed section lands.
    { socket: "settings-section", surface: "settings", id: "connection", label: "Linear", icon: "brand:linear", panelId: "settings", section: "integrations", webviewSurfaceId: "settings" },
    { socket: "command-palette-action", surface: "app", id: "palette-issues", label: "Linear issues", icon: "brand:linear", actionId: "openIssues" },
    // The transcript's issue context, as a card in the chat.
    { socket: "chat-card", surface: "work", id: "issue-context", label: "Linear issue", icon: "brand:linear", panelId: "issue", webviewSurfaceId: "issue-context" },
    // The Automations trigger grid's Linear tile: the five triggers, the five
    // filters bound to this plugin's own collections, and the webhook block
    // whose two actions the tile presses by name. `registerWebhook` creates the
    // hook through the Linear API and stores its signing secret itself, which
    // is what removed the paste box.
    {
      socket: "automation-trigger-tile",
      surface: "automations",
      id: "linear-triggers",
      label: "Linear",
      icon: "brand:linear",
      triggers: [
        { id: "issue_created", label: "A Linear issue is created" },
        { id: "issue_updated", label: "A Linear issue is updated" },
        { id: "issue_assigned", label: "A Linear issue is assigned" },
        { id: "issue_status_changed", label: "A Linear issue changes state" },
        { id: "issue_labeled", label: "A Linear issue is labeled" },
      ],
      filters: [
        { key: "project", label: "Project", kind: "select", collection: "projects", hint: "Only issues in this Linear project." },
        { key: "team", label: "Team", kind: "select", collection: "teams", hint: "Only issues owned by this team." },
        { key: "assignee", label: "Assignee", kind: "select", collection: "people", hint: "Only issues assigned to this person." },
        { key: "label", label: "Label", kind: "select", collection: "labels", hint: "Only issues carrying this label." },
        { key: "state", label: "State", kind: "select", collection: "states", hint: "Only issues in this workflow state." },
      ],
      webhook: { statusAction: "webhookStatus", registerAction: "registerWebhook" },
    },
    // The two settings toggles that used to do this, as rules the reader can
    // see, name and switch off. A checkbox two screens away that rewrites
    // tickets other people read is the shape this replaces.
    {
      socket: "automation-template",
      surface: "automations",
      id: "linear-start-on-lane",
      // `label` is what the manifest requires of every socket; `name` is what
      // the gallery card prints. Same words, two contracts.
      label: "Linear issue → In Progress when work starts",
      name: "Linear issue → In Progress when work starts",
      icon: "brand:linear",
      description: "Opening a lane on a Linear issue moves that issue to the team's first started state.",
      template: {
        enabled: true,
        mode: "monitor",
        executor: { mode: "automation-bot" },
        reviewProfile: "quick",
        toolPalette: ["linear"],
        contextSources: [],
        outputs: { disposition: "comment-only", createArtifact: false },
        verification: { verifyBeforePublish: false, mode: "intervention" },
        name: "Linear issue → In Progress when work starts",
        triggers: [{ type: "lane.created" }],
        trigger: { type: "lane.created" },
        guardrails: { maxDurationMin: 5 },
        billingCode: "auto:linear-start-on-lane",
        actions: [{
          type: "plugin",
          pluginStep: { pluginId: "ade-linear", action: "stepStartIssueOnLane", args: { laneId: "{{trigger.laneId}}" } },
        }],
      },
    },
    {
      socket: "automation-template",
      surface: "automations",
      id: "linear-done-on-merge",
      label: "Linear issue → Done when its pull request merges",
      name: "Linear issue → Done when its pull request merges",
      icon: "brand:linear",
      description: "Merging a lane's pull request moves the issues that lane linked with “close on merge” to the team's first completed state.",
      template: {
        enabled: true,
        mode: "monitor",
        executor: { mode: "automation-bot" },
        reviewProfile: "quick",
        toolPalette: ["linear"],
        contextSources: [],
        outputs: { disposition: "comment-only", createArtifact: false },
        verification: { verifyBeforePublish: false, mode: "intervention" },
        name: "Linear issue → Done when its pull request merges",
        triggers: [{ type: "lane.merged" }],
        trigger: { type: "lane.merged" },
        guardrails: { maxDurationMin: 5 },
        billingCode: "auto:linear-done-on-merge",
        actions: [{
          type: "plugin",
          pluginStep: { pluginId: "ade-linear", action: "stepCloseIssueOnMerge", args: { laneId: "{{trigger.laneId}}" } },
        }],
      },
    },
  ],
  panels: [
    { id: "main", schemaFile: "panels/main.json", title: "Linear", icon: "brand:linear" },
    { id: "issues", schemaFile: "panels/issues.json", title: "Linear", icon: "brand:linear", refreshAction: "refreshIssues" },
    { id: "issue", schemaFile: "panels/issue.json", title: "Issue", icon: "brand:linear", refreshAction: "refreshIssue" },
    { id: "settings", schemaFile: "panels/settings.json", title: "Linear connection", icon: "brand:linear", refreshAction: "refreshConnection" },
    { id: "launch", schemaFile: "panels/launch.json", title: "Launch", icon: "rocket" },
  ],
  // `sync: false` is a decision, not an omission. Comments and webhook
  // deliveries are per-machine working state — replaying them to every device
  // would put the same delivery through the plugin twice.
  collections: {
    issues: { sync: true },
    comments: { sync: false },
    teams: { sync: true },
    states: { sync: true },
    projects: { sync: true },
    people: { sync: true },
    // The workspace's issue labels, for the Automations tile's label filter.
    // Same reason `projects` and `people` exist: a filter cannot be a picker
    // over rows nothing stores.
    labels: { sync: true },
    viewer: { sync: true },
    deliveries: { sync: false },
    // The page's own filters and selection. Per-machine reading preferences, so
    // syncing them would put one machine's sort order on another.
    "ui-state": { sync: false },
    // Which webhook this machine registered. Per-machine for the same reason
    // `deliveries` is: the endpoint belongs to the machine that hosts it.
    webhook: { sync: false },
  },
  // Two settings, down from four. The issue-transition toggles are automation
  // templates now, so the rule that moves a ticket is one the reader can see
  // and switch off rather than a checkbox on another screen.
  settings: [
    {
      key: "defaultTeamKey",
      kind: "text",
      label: "Default team key",
      description: "Used when a command does not name a team, e.g. ENG.",
    },
    {
      key: "launchPromptClipboard",
      kind: "toggle",
      label: "Copy the launch prompt to the clipboard",
      description: "Saves the kickoff prompt before Linear starts an agent on the issue. Its switch is in the launch form, beside the prompt it copies.",
      default: true,
    },
  ],
  automationTriggers: [
    { id: "issue_created", label: "A Linear issue is created", description: "Fires when Linear reports a new issue." },
    { id: "issue_updated", label: "A Linear issue is updated", description: "Fires when any field of an issue changes." },
    { id: "issue_assigned", label: "A Linear issue is assigned", description: "Fires when an issue's assignee changes." },
    { id: "issue_status_changed", label: "A Linear issue changes state", description: "Fires when an issue moves to another workflow state." },
    { id: "issue_labeled", label: "A Linear issue is labeled", description: "Fires when a label is added to an issue." },
  ],
  automationSteps: [
    { id: "set_issue_state", label: "Move a Linear issue to a state", action: "stepSetIssueState" },
    { id: "comment_on_issue", label: "Comment on a Linear issue", action: "stepCommentOnIssue" },
    { id: "assign_issue", label: "Assign a Linear issue", action: "stepAssignIssue" },
    { id: "close_issue_on_merge", label: "Move a merged lane's Linear issue to Done", action: "stepCloseIssueOnMerge" },
    { id: "start_issue_on_lane", label: "Move a lane's Linear issues to In Progress", action: "stepStartIssueOnLane" },
  ],
  searchProviders: [
    { id: "issues", label: "Linear", action: "searchIssuesProvider" },
  ],
  keybindings: [
    { action: "openIssues", binding: "Mod+Shift+L", label: "Open Linear issues" },
  ],
  // Nine tools, spelled out rather than summarised, because the install
  // disclosure names each one: "an agent can call these" is the widest thing on
  // the card, and a copy that lists four of nine understates it.
  tools: [
    {
      name: "get_issue",
      description: "Fetch a Linear issue by its id or identifier (e.g. 'ABC-42'), with state, labels, assignee and description.",
      action: "getIssueTool",
      input: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The issue id (UUID) or identifier (e.g. 'PROJ-123')." },
        },
        required: ["issueId"],
      },
    },
    {
      name: "search_issues",
      description: "Search Linear issues by text, team, project, assignee, priority or state type.",
      action: "searchIssuesTool",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text matched against title and description." },
          teamKey: { type: "string", description: "Team key, e.g. 'ENG'." },
          projectId: { type: "string", description: "Linear project id." },
          assigneeId: { type: "string", description: "Assignee user id." },
          priority: { type: "integer", description: "Priority 0 (none) to 4 (low)." },
          stateTypes: {
            type: "array",
            description: "State types to include.",
            items: {
              type: "string",
              enum: ["triage", "backlog", "unstarted", "started", "completed", "canceled"],
            },
          },
          limit: { type: "integer", description: "How many issues to return. Defaults to 50, at most 100." },
        },
        required: [],
      },
    },
    {
      name: "add_comment",
      description: "Post a comment on a Linear issue. Use it to report progress or document findings on the issue you are working on.",
      action: "addCommentTool",
      input: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The issue id or identifier." },
          body: { type: "string", description: "The comment body, in markdown." },
        },
        required: ["issueId", "body"],
      },
    },
    {
      name: "update_issue_state",
      description: "Move a Linear issue to another workflow state. Call list_states first to find the state id.",
      action: "updateIssueStateTool",
      input: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The issue id or identifier." },
          stateId: { type: "string", description: "The target workflow state id (UUID)." },
        },
        required: ["issueId", "stateId"],
      },
    },
    {
      name: "list_states",
      description: "List the workflow states of a Linear team. Use it to look up a state id before update_issue_state.",
      action: "listStatesTool",
      input: {
        type: "object",
        properties: {
          teamKey: { type: "string", description: "Team key, e.g. 'ENG'. Omit for every team." },
        },
        required: [],
      },
    },
    {
      name: "assign_issue",
      description: "Assign a Linear issue to a user, or clear its assignee.",
      action: "assignIssueTool",
      input: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The issue id or identifier." },
          assigneeId: { type: "string", description: "The user id, or omit to clear the assignee." },
        },
        required: ["issueId"],
      },
    },
    {
      name: "add_label",
      description: "Add an existing label to a Linear issue, by label name.",
      action: "addLabelTool",
      input: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The issue id or identifier." },
          labelName: { type: "string", description: "The label name, which must already exist." },
        },
        required: ["issueId", "labelName"],
      },
    },
    {
      name: "create_lane_for_issue",
      description: "Create an ADE lane for a Linear issue, on the branch name Linear expects, and link the issue to it.",
      action: "createLaneForIssueTool",
      input: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The issue id or identifier." },
          baseRef: { type: "string", description: "Branch to cut from. Defaults to the project's base branch." },
        },
        required: ["issueId"],
      },
    },
    {
      name: "graphql",
      description: "Run a raw GraphQL query or mutation against the Linear API, for anything the other tools do not cover.",
      action: "graphqlTool",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "The GraphQL query or mutation." },
          variables: { type: "object", description: "Variables for the operation.", properties: {}, required: [] },
        },
        required: ["query"],
      },
    },
  ],
  cli: ["linear"],
  skills: ["skills"],
});

/**
 * iOS Sim Control.
 *
 * At 2.0.0 the plugin draws its own page — the device picker, the launch-target
 * picker, the Control/Inspect toolbar, Preview Lab, zoom and the ownership
 * cards — and reserves a rect the host paints the `simulator` engine into.
 * simctl and the stream stay in core. The `main` panel is what the phone and
 * the TUI render in the page's place, and it says a Mac is required.
 */
const IOS_SIM = manifest({
  name: "ade-ios-sim",
  version: "2.0.1",
  displayName: "iOS Sim Control",
  description: "iOS Sim Control — pick a simulator, build and launch your app on it, then tap, type and inspect the running screen without leaving ADE.",
  icon: "device-mobile",
  accent: "#8A8F98",
  entry: "index.js",
  surfaces: [{
    kind: "webview",
    id: "sim",
    title: "iOS Sim Control",
    icon: "device-mobile",
    entryHtml: "dist/index.html",
    panelId: "main",
    railTab: false,
    mobile: false,
  }],
  panels: [{
    id: "main",
    schemaFile: "panels/main.json",
    title: "iOS Sim Control",
    icon: "device-mobile",
    refreshAction: "refreshStatus",
  }],
  sockets: [
    // The rail label is capped at 24 characters by `sockets.ts`, and it sits
    // beside ADE's own one-word entries, so the short form stays.
    { socket: "work-rail-pane", surface: "work", id: "sim-pane", label: "iOS Sim Control", icon: "device-mobile", panelId: "main", webviewSurfaceId: "sim" },
    { socket: "command-palette-action", surface: "app", id: "palette-sim", label: "iOS Sim Control", icon: "device-mobile", actionId: "openSimulator", webviewSurfaceId: "sim" },
  ],
  collections: {
    status: { sync: true },
    "ui-state": { sync: false },
  },
  tools: [
    {
      name: "get_status",
      description: "Read iOS Sim Control status on this machine — whether it is a Mac, the live device, and the attached chat.",
      action: "getStatusTool",
      input: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  ],
  cli: [],
  skills: ["skills"],
});

/**
 * Electron Control.
 *
 * At 2.0.0 the plugin draws its own page — the launch/connect toolbar, the
 * target picker, the status line, the blockers card, the inspect list and the
 * type-text field — and reserves a rect the host paints the `electron-control`
 * engine into. CDP stays in core. The `main` panel is what the phone and the
 * TUI render in the page's place, and it says a desktop is required.
 */
const APP_CONTROL = manifest({
  name: "ade-app-control",
  version: "2.0.1",
  displayName: "Electron Control",
  description: "Drive and inspect Electron apps — the same Electron Control ADE already ships, as a plugin.",
  icon: "desktop",
  accent: "#47848F",
  entry: "index.js",
  surfaces: [{
    kind: "webview",
    id: "control",
    title: "Electron Control",
    icon: "desktop",
    entryHtml: "dist/index.html",
    panelId: "main",
    railTab: false,
    mobile: false,
  }],
  panels: [{
    id: "main",
    schemaFile: "panels/main.json",
    title: "Electron Control",
    icon: "desktop",
    refreshAction: "refreshStatus",
  }],
  sockets: [
    { socket: "work-rail-pane", surface: "work", id: "control-pane", label: "Electron Control", icon: "desktop", panelId: "main", webviewSurfaceId: "control" },
    { socket: "command-palette-action", surface: "app", id: "palette-control", label: "Electron Control", icon: "desktop", actionId: "openControl", webviewSurfaceId: "control" },
  ],
  collections: {
    status: { sync: true },
    "ui-state": { sync: false },
  },
  tools: [
    {
      name: "get_status",
      description: "Read Electron Control status on this machine — attached session, CDP port, and whether this host can drive an app.",
      action: "getStatusTool",
      input: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  ],
  cli: [],
  skills: ["skills"],
});

const LOG_VIEWER = manifest({
  name: "ade-log-viewer",
  version: "1.0.1",
  displayName: "Log viewer",
  description: "Reads the end of .log and .ndjson files in Files, with levels picked out.",
  icon: "rows",
  accent: "#4C9AFF",
  entry: "index.js",
  panels: [{ id: "viewer", schemaFile: "panels/viewer.json", title: "Log" }],
  sockets: [
    {
      socket: "file-viewer",
      surface: "files",
      id: "viewer",
      panelId: "viewer",
      extensions: [".log", ".ndjson"],
    },
  ],
  settings: [
    {
      key: "tailLines",
      kind: "number",
      label: "Lines to show",
      description: "How many of the most recent lines the panel lists. Up to 100.",
      default: 100,
    },
  ],
});

/**
 * Voice, which gates nothing.
 *
 * Dictation is a `composer-action` socket, a `captureClip` SDK call and an
 * `{composer:{insertText}}` response — three public primitives, no `builtin`
 * binding, nothing an author outside this repository could not have written.
 * If that ever stops being true, the extraction it proves has regressed.
 */
const VOICE = manifest({
  name: "ade-voice",
  version: "1.0.0",
  displayName: "Voice",
  description: "Voice dictation for the composer, on-device. Downloads a 141 MB speech model on first use.",
  icon: "microphone",
  accent: "#C2508B",
  entry: "index.js",
  panels: [{ id: "main", schemaFile: "panels/main.json", title: "Voice" }],
  sockets: [
    {
      socket: "composer-action",
      surface: "work",
      id: "dictate",
      label: "Dictate",
      icon: "microphone",
      actionId: "dictate",
    },
  ],
  // The one thing dictation reaches off the machine for: the speech model, on
  // first use. Declared because the install card's network line is derived from
  // it, and a plugin that says "on-device" while fetching 141 MB from a host
  // the card never named is the disclosure failure this field exists to stop.
  //
  // Its sibling `extraDownloads` — the 141 MB itself — is a registry-index
  // field rather than a manifest one, so it has no place in this literal; the
  // mirror test names it as the single allowed exception.
  network: { hosts: ["huggingface.co", "*.huggingface.co", "*.hf.co"] },
});

/**
 * Cursor Cloud, which gates nothing either — and owns a conversation.
 *
 * The largest thing a plugin can be. Voice above proves a `composer-action` and
 * an SDK call are enough for a feature; this one proves the same for a whole
 * vertical: a tab, a chat runtime, a webhook channel and a brokered provider
 * key, none of them reserved for packages ADE publishes. If any part
 * of it ever needs a `builtin` binding or an official-only capability, the
 * extraction it was built to prove has regressed.
 */
const CURSOR_CLOUD = manifest({
  name: "ade-cursor-cloud",
  version: "2.0.3",
  displayName: "Cursor Cloud",
  description: "Launch, watch and adopt Cursor Cloud agents from ADE. Needs a Cursor API key.",
  icon: "brand:cursor",
  accent: "#A78BFA",
  entry: "index.js",
  network: { hosts: ["api.cursor.com"] },
  providerKeys: ["cursor"],
  webhookIngress: [{
    id: "cursor",
    label: "Cursor Cloud status events",
    description: "Paste this URL into Cursor's webhook settings so a finished run wakes ADE.",
  }],
  chatRuntimes: [{
    id: "cloud-agent",
    displayName: "Cursor Cloud",
    icon: "brand:cursor",
    capabilities: { followUp: true, interrupt: true, hydrate: true, artifacts: true },
    ownsName: true,
  }],
  surfaces: [
    {
      kind: "webview",
      id: "fleet",
      title: "Cursor Cloud",
      icon: "brand:cursor",
      entryHtml: "dist/index.html",
      panelId: "fleet",
      order: 60,
      mobile: true,
    },
    {
      kind: "webview",
      id: "agent",
      title: "Agent",
      icon: "brand:cursor",
      entryHtml: "dist/index.html",
      panelId: "agent",
      mobile: true,
    },
    {
      kind: "webview",
      id: "launch",
      title: "Launch in Cursor Cloud",
      icon: "brand:cursor",
      entryHtml: "dist/index.html",
      panelId: "launch",
      popover: { width: 560, height: 620 },
      mobile: true,
    },
  ],
  panels: [
    { id: "fleet", schemaFile: "panels/fleet.json", title: "Cursor Cloud", icon: "cloud", refreshAction: "refreshFleet", viewAction: "ackTabBadge" },
    { id: "agent", schemaFile: "panels/agent.json", title: "Agent", icon: "cloud", refreshAction: "refreshAgent" },
    { id: "launch", schemaFile: "panels/launch.json", title: "Launch in Cursor Cloud", icon: "cloud" },
  ],
  sockets: [
    {
      socket: "machine-entry",
      surface: "work",
      id: "cursor-cloud",
      label: "Cursor Cloud",
      icon: "cloud",
      actionId: "launchFromComposer",
      ownsSend: true,
      advancedSurfaceId: "launch",
      webviewSurfaceId: "launch",
      runtimeId: "cloud-agent",
      modelsAction: "listCloudModels",
    },
    {
      socket: "row-badge",
      surface: "app",
      id: "tab-badge",
      label: "Unread finished agents",
    },
    {
      socket: "automation-trigger-tile",
      surface: "automations",
      id: "cloud-triggers",
      label: "Cursor Cloud",
      icon: "brand:cursor",
      triggers: [
        { id: "cloud_finished", label: "A Cursor Cloud agent finishes", description: "Fires when Cursor reports a run FINISHED." },
        { id: "cloud_error", label: "A Cursor Cloud agent errors", description: "Fires when Cursor reports a run ERROR." },
      ],
      filters: [
        { key: "laneId", label: "Lane", kind: "select", collection: "fleet", hint: "Only agents working on this lane's branch." },
        { key: "repo", label: "Repository", kind: "text", placeholder: "owner/repo", hint: "Match the repository Cursor cloned." },
        { key: "agentName", label: "Agent name contains", kind: "text", placeholder: "sync", hint: "Match the agent's name, which is its first prompt line." },
      ],
      webhook: {
        statusAction: "webhookStatus",
        registerAction: "copyWebhookUrl",
      },
    },
  ],
  // `laneSecrets` and `deliveries` stay local: one holds per-machine secrets
  // and the other webhook deliveries, and syncing either would replay a
  // delivery through a second machine's plugin child. `ui-state` is the page's
  // own filters and stays on this machine.
  collections: {
    fleet: { sync: true },
    sessions: { sync: true },
    deliveries: { sync: false },
    laneSecrets: { sync: false },
    "ui-state": { sync: false },
  },
  settings: [
    { key: "autoOpenPr", kind: "toggle", label: "Open a PR when a run finishes", default: false },
  ],
  automationTriggers: [
    { id: "cloud_finished", label: "A Cursor Cloud agent finishes", description: "Fires when Cursor reports a run FINISHED." },
    { id: "cloud_error", label: "A Cursor Cloud agent errors", description: "Fires when Cursor reports a run ERROR." },
  ],
  automationSteps: [
    { id: "stop_agent", label: "Stop a Cursor Cloud agent", action: "stopRun" },
    { id: "pull_into_lane", label: "Pull the agent's branch into its lane", action: "pullIntoLane" },
  ],
  searchProviders: [
    { id: "agents", label: "Cursor Cloud", action: "searchAgents" },
  ],
  tools: [
    {
      name: "list_agents",
      description: "List this project's Cursor Cloud agents, newest first.",
      action: "listAgents",
      input: {
        type: "object",
        properties: {
          includeArchived: { type: "boolean", description: "Include archived agents." },
          limit: { type: "integer", description: "How many agent rows to walk. Defaults to 100, at most 200." },
        },
        required: [],
      },
    },
    {
      name: "launch_agent",
      description: "Start a Cursor Cloud agent on this lane's branch.",
      action: "createRun",
      input: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What the agent should do." },
          laneId: { type: "string", description: "The lane whose branch the agent works on." },
          model: { type: "string", description: "Cursor model id. Omit for Cursor's default." },
          openPr: { type: "boolean", description: "Open a pull request when the run finishes." },
        },
        required: ["prompt"],
      },
    },
    {
      name: "stop_agent",
      description: "Stop a running Cursor Cloud agent.",
      action: "stopRun",
      input: {
        type: "object",
        properties: { agentId: { type: "string", description: "The agent id." } },
        required: ["agentId"],
      },
    },
    {
      name: "pull_into_lane",
      description: "Fetch a finished Cursor Cloud agent's branch into its lane.",
      action: "pullIntoLane",
      input: {
        type: "object",
        properties: { agentId: { type: "string", description: "The agent id." } },
        required: ["agentId"],
      },
    },
  ],
  cli: ["agents", "runs", "artifacts", "repos", "me"],
  skills: ["skills"],
});

/**
 * The starter themes.
 *
 * Each ships both palettes, because a theme that only defines dark tokens
 * silently reverts half of itself the moment someone switches to light — the
 * failure the engine's two-block stylesheet exists to make visible.
 */
/*
 * Paper, Ink and High contrast used to be hand-written literals here.
 *
 * They now come from `marketplaceThemeCatalog.ts` with every other official
 * theme, because the completeness spec is enforced against ONE generator: a
 * literal restated in this file is a theme that can quietly fall behind the
 * spec while the gallery still calls it official. The catalogue's manifests
 * are folded in below, and `plugins/themes/<id>/plugin.json` is generated
 * from the same manifests, so the mirror test still pins both.
 */

function listing(
  source: PluginManifest,
  extra: { author: string; featured?: boolean; readme: string },
): MarketplaceListing {
  return {
    pluginId: source.name,
    displayName: source.displayName,
    author: extra.author,
    description: source.description,
    version: source.version,
    icon: source.icon ?? null,
    accent: source.accent ?? null,
    // Bundled packages publish no image and no gallery: they are drawn from
    // their glyph, and the app is not going to fetch a screenshot of itself.
    iconUrl: null,
    media: [],
    // The repository page, which is display-only here — `source` below is what
    // an install actually resolves against. It is what the author link and the
    // star button point at, and both of those want the project's page rather
    // than the bytes.
    repo: `${REGISTRY_ORG}/${source.name}`,
    links: {
      repository: `${REGISTRY_ORG}/${source.name}`,
      homepage: null,
      changelog: `${REGISTRY_ORG}/${source.name}/releases`,
      license: null,
      docs: null,
    },
    official: true,
    featured: extra.featured === true,
    isTheme: source.theme !== undefined,
    kind: derivePluginKind({ manifest: source, isTheme: source.theme !== undefined }),
    installs: null,
    stars: null,
    publishedAt: null,
    // The install source is the plugin ID, not a URL. These packages ship inside
    // the app, so the install resolves against what ADE already bundles and
    // records itself as a builtin — which is also the only way back after
    // someone removes one. The repository links below are display only; that
    // organisation is planned, not published, and sending its URL here made
    // every bundled install fail against a repository that does not exist.
    source: source.name,
    changelogUrl: `${REGISTRY_ORG}/${source.name}/releases`,
    readme: extra.readme,
    manifest: source,
    addsSummary: [],
    surfaces: surfacesFromManifest(source),
    themeTokens: source.theme?.tokens ?? null,
    origin: "bundled",
  };
}

/**
 * The official set, as shipped. Ordering here is irrelevant — the gallery sorts
 * — but the featured flags are the curated hero row and are deliberately few.
 */
export const MARKETPLACE_LOCAL_INDEX: readonly MarketplaceListing[] = [
  listing(GRAPH, {
    author: "ADE",
    readme: [
      "## Graph",
      "",
      "Lanes, commits, PR overlays, conflict risk and sync presence, drawn on one",
      "canvas. Selecting a node opens that lane.",
      "",
      "This plugin replaces ADE's compiled Graph tab. Install it and the rail talks",
      "to these panels. Disable it and the compiled Graph page comes back unchanged.",
      "",
      "### Notes",
      "",
      "- The canvas engine stays in ADE. Desktop mounts the host workspace Graph;",
      "  phone and terminal list the same bound lane rows.",
      "- Phone: there was never a compiled Graph screen. These panels are the first",
      "  Graph UI on iOS and in the terminal.",
    ].join("\n"),
  }),
  listing(REVIEW, {
    author: "ADE",
    readme: [
      "## Review",
      "",
      "Run AI review passes over a lane, a commit range, uncommitted changes, or a",
      "pull request, then act on the findings — acknowledge, dismiss, snooze, or",
      "suppress similar ones.",
      "",
      "This plugin replaces ADE's compiled Review tab. Install it and the rail, the",
      "PR \"ADE review\" button, and `ade review` talk to these panels. Disable it and",
      "the compiled Review page comes back unchanged.",
      "",
      "### Notes",
      "",
      "- The review engine stays in ADE. This plugin shapes rows and calls `review.*`.",
      "- Phone: there was never a compiled Review screen. These panels are the first",
      "  Review UI on iOS and in the terminal.",
    ].join("\n"),
  }),
  listing(HISTORY, {
    author: "ADE",
    readme: [
      "## History",
      "",
      "Commits and lane operations for this project. The same History ADE already",
      "ships, drawn as vocabulary panels every client can show.",
      "",
      "This plugin replaces ADE's compiled History tab. Install it and the rail,",
      "the Work pane, and `ade history activity` talk to these panels. Disable it",
      "and the compiled History page comes back unchanged.",
      "",
      "### Notes",
      "",
      "- The git and operation engines stay in ADE. This plugin shapes rows and",
      "  calls `git.*` and `operation.*`.",
      "- Phone: there was never a compiled History screen. These panels are the first",
      "  History UI on iOS and in the terminal.",
    ].join("\n"),
  }),
  listing(LINEAR, {
    author: "ADE",
    featured: true,
    readme: [
      "## Linear",
      "",
      "Read and update the Linear issue you are working on without leaving ADE: open",
      "it beside your work, change its state, comment, and pick up the next one.",
      "",
      "Install it and the Linear pane and its buttons are there; remove it and they",
      "are gone, links included.",
      "",
      "### Notes",
      "",
      "- Needs a Linear connection, which lives in Settings and is separate from this",
      "  plugin — installing it does not connect an account.",
      "- The issue view is drawn by the desktop app rather than published as a panel.",
      "- Linear links open only while the plugin is installed and on, on the machine",
      "  you are attached to.",
    ].join("\n"),
  }),
  listing(IOS_SIM, {
    author: "ADE",
    featured: true,
    readme: [
      "## iOS Sim Control",
      "",
      "Run an iOS Simulator beside your work: launch a build, tap and type in it,",
      "take screenshots, and hand what you see to a chat.",
      "",
      "This plugin replaces ADE's compiled Simulator pane. Install it and the Work",
      "tools talk to this package. Disable it and the compiled pane comes back.",
      "",
      "### Notes",
      "",
      "- Macs only, and it needs Xcode. On anything else the compiled pane stays",
      "  hidden even with the plugin installed.",
      "- The plugin draws the chrome on its own page and reserves a rect. The",
      "  simctl/idb engine and the live stream stay in ADE, which paints them into",
      "  that rect; phone and terminal list a status row pointing at the Mac.",
      "- Agents keep using `ade ios-sim`. Those verbs stay on the host.",
    ].join("\n"),
  }),
  listing(APP_CONTROL, {
    author: "ADE",
    readme: [
      "## Electron Control",
      "",
      "Point ADE at an Electron app and watch it work: click and type in it, read its",
      "logs, answer its prompts, and pull a screenshot back into a chat.",
      "",
      "This plugin replaces ADE's compiled Electron Control pane. Install it and the",
      "Work tools talk to this package. Disable it and the compiled pane comes back.",
      "",
      "### Notes",
      "",
      "- It drives over the Chrome DevTools Protocol, so the app has to be Electron or",
      "  Chromium — a native desktop app has nothing to attach to.",
      "- The plugin draws the chrome on its own page and reserves a rect. The CDP",
      "  engine and the live view stay in ADE, which paints them into that rect;",
      "  phone and terminal list a status row pointing at the attached computer.",
      "- Agents keep using `ade app-control`. Those verbs stay on the host.",
    ].join("\n"),
  }),
  listing(LOG_VIEWER, {
    author: "ADE",
    readme: [
      "## Log viewer",
      "",
      "Opens `.log` and `.ndjson` files in the Files tab as lines rather than as a",
      "wall of text: levels are picked out, errors and warnings are counted, and you",
      "can filter to one level without leaving the file.",
      "",
      "### How it reads",
      "",
      "Logs get large, so it reads the last 128 KiB of a file rather than the whole",
      "thing, and only when you press Load. The panel says which part it read and how",
      "big the file actually is, so a truncated view never looks like a complete one.",
      "",
      "Reading goes through ADE's own file action on the machine that holds the file,",
      "and the parsing happens there too — what reaches your screen is the rows.",
      "",
      "### Settings",
      "",
      "- **Lines to show** — how many of the most recent lines the panel lists, up to",
      "  100.",
    ].join("\n"),
  }),
  listing(VOICE, {
    author: "ADE",
    readme: [
      "## Voice",
      "",
      "Dictate into the composer instead of typing. Press the microphone, speak, and",
      "the words arrive as text — transcribed on this computer, so no audio is",
      "uploaded anywhere and dictation keeps working with the network off.",
      "",
      "Dictation was part of ADE itself until plugins existed. All of it moved out —",
      "the microphone button, the recording, the speech model and the transcribing —",
      "and it moved out through the same doors any plugin has: a composer button, an",
      "SDK call for the recording, and a response that types into your draft.",
      "",
      "### The one-time download",
      "",
      "The speech model is about 141 MB and is fetched the first time you dictate,",
      "then kept in ADE's application-support folder — not in the plugin, so",
      "updating it never downloads the model again. If you dictated in ADE before",
      "voice became a plugin, it is already there.",
      "",
      "A download that size cannot finish inside one request, so the first recording",
      "starts it and says so; every recording after that is immediate. An interrupted",
      "download resumes, and the file is only used once its checksum matches.",
      "",
      "### Notes",
      "",
      "- macOS only. The engine is a universal build, so both Apple Silicon and Intel",
      "  Macs work; there is no Linux or Windows build in this package, and on those",
      "  the plugin says so rather than failing quietly.",
      "- English. The bundled model is `base.en`.",
      "- On iPhone, use the keyboard's own dictation key — iOS has it built in, so",
      "  this plugin does not ship a mobile surface.",
    ].join("\n"),
  }),

  listing(CURSOR_CLOUD, {
    author: "ADE",
    featured: true,
    readme: [
      "## Cursor Cloud",
      "",
      "Launch Cursor Cloud agents from ADE, watch them from any client, and answer",
      "them in an ordinary ADE chat.",
      "",
      "A cloud agent clones your lane's branch, works on it on Cursor's machines and",
      "pushes back. This gives that a rail tab, a row in the composer's machine",
      "picker, and — the part that matters — a real conversation: open a cloud",
      "agent as an ADE chat and its history is backfilled, your follow-ups go to",
      "Cursor, and its replies stream back where you already read everything else.",
      "",
      "### Before it works",
      "",
      "- **Connect a Cursor API key** in Settings → AI connections. ADE holds it and",
      "  lends it to this plugin one call at a time; the plugin never stores a copy.",
      "- **Connect the repository to Cursor.** Cursor clones from its own GitHub",
      "  connection, not from your machine, so a repository it has never seen cannot",
      "  be worked on. The launch form checks first and says which half is missing.",
      "- **Paste the webhook URL into Cursor** for live status. `ade plugin doctor",
      "  ade-cursor-cloud` prints it. Without it everything still works — an open",
      "  chat polls while you are reading it — but a run that finishes while nothing",
      "  is on screen is only noticed the next time you look.",
      "",
      "### Notes",
      "",
      "- It calls exactly one host, `api.cursor.com`, declared in its manifest and",
      "  enforced by the plugin child's network guard.",
      "- Polling follows your attention: a 3s → 45s ladder while a chat is on screen,",
      "  and nothing at all when it is not.",
      "- Uninstalling takes the tab, the composer row, the chat runtime, the",
      "  automation triggers and the CLI words with it. Chats already bound to a",
      "  cloud agent keep their transcripts.",
    ].join("\n"),
  }),
  ...MARKETPLACE_OFFICIAL_THEMES.map((theme) => listing(theme.manifest, {
    author: "ADE",
    readme: theme.readme,
  })),
];

/* ── The mirror seam ────────────────────────────────────────────────────── */

/**
 * The bundled manifests, by plugin id.
 *
 * Derived from {@link MARKETPLACE_LOCAL_INDEX} rather than declared beside the
 * literals, so it cannot list a manifest the gallery does not offer or miss one
 * it does. Its reason to exist is the mirror test: every entry here is compared
 * field for field against `plugins/<id>/plugin.json`, which is the only thing
 * keeping a hand-copied manifest honest. `listing()` always passes a manifest,
 * so the cast below is reading a type that is `| null` for directory entries.
 */
export const BUNDLED_MANIFESTS_BY_ID: Readonly<Record<string, PluginManifest>> =
  Object.freeze(Object.fromEntries(
    MARKETPLACE_LOCAL_INDEX.map((entry) => [entry.pluginId, entry.manifest as PluginManifest]),
  ));

/**
 * The default-filling helper above, under a name that reads outside this file.
 *
 * Exported for the mirror test and nothing else: a `plugin.json` omits every
 * field defaulted here, so the test has to put the parsed file through the
 * identical defaults before it can compare the two. Re-exported rather than
 * renamed in place because `manifest({...})` is what the twelve literals above
 * read as, and spelling it out at each of them would bury them.
 */
export { manifest as withBundledManifestDefaults };
