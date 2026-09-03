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
import { surfacesFromManifest } from "./marketplaceModel";

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
  version: "1.1.0",
  displayName: "Graph",
  description: "Lanes, commits and PR overlays on one canvas — the same Graph ADE already ships, as a plugin.",
  icon: "graph",
  accent: "#6366F1",
  entry: "index.js",
  surfaces: [{ kind: "tab", id: "graph", title: "Graph", icon: "graph", panelId: "graph", order: 50, mobile: true }],
  panels: [
    { id: "graph", schemaFile: "panels/graph.json", title: "Graph", icon: "graph", refreshAction: "refreshGraph" },
    { id: "lane", schemaFile: "panels/lane.json", title: "Lane", icon: "git-branch", refreshAction: "openLane" },
  ],
  sockets: [
    { socket: "command-palette-action", surface: "app", id: "palette-graph", label: "Graph", icon: "graph", actionId: "openGraph" },
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
 * name it with `builtin` at all — it draws its own panels and ADE's compiled
 * Review tab steps aside. The engine stays in core; this package is the UI,
 * the PR toolbar, the agent tools and `ade review`.
 */
const REVIEW = manifest({
  name: "ade-review",
  version: "1.1.0",
  displayName: "Review",
  description: "Run AI review passes over a lane, a commit range, uncommitted changes, or a pull request, and act on the findings.",
  icon: "git-pull-request",
  accent: "#22A06B",
  entry: "index.js",
  surfaces: [{ kind: "tab", id: "runs", title: "Review", icon: "git-pull-request", panelId: "runs", order: 45, mobile: true }],
  panels: [
    { id: "runs", schemaFile: "panels/runs.json", title: "Review", icon: "git-pull-request", refreshAction: "refreshRuns" },
    { id: "run", schemaFile: "panels/run.json", title: "Review run", icon: "git-pull-request", refreshAction: "refreshRun" },
    { id: "launch", schemaFile: "panels/launch.json", title: "Launch a review", icon: "play" },
    { id: "learnings", schemaFile: "panels/learnings.json", title: "Review learnings", icon: "sparkle", refreshAction: "refreshLearnings" },
  ],
  sockets: [
    { socket: "work-rail-pane", surface: "work", id: "runs-pane", label: "Review", icon: "git-pull-request", panelId: "runs" },
    { socket: "toolbar-action", surface: "prs", id: "request-review", label: "ADE review", icon: "sparkle", actionId: "openLaunchFromPr" },
    { socket: "row-menu-item", surface: "prs", id: "request-review-row", label: "ADE review…", icon: "sparkle", actionId: "openLaunchFromPr" },
    { socket: "command-palette-action", surface: "app", id: "palette-runs", label: "Review runs", icon: "git-pull-request", actionId: "openRuns" },
    { socket: "command-palette-action", surface: "app", id: "palette-launch", label: "Launch a review", icon: "play", actionId: "openLaunch" },
  ],
  collections: {
    runs: { sync: true },
    findings: { sync: true },
    suppressions: { sync: true },
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
 * name it with `builtin` at all — it draws its own panels and ADE's compiled
 * History tab steps aside. The git and operation engines stay in core; this
 * package is the UI, the Work pane and `ade history activity`.
 */
const HISTORY = manifest({
  name: "ade-history",
  version: "1.1.0",
  displayName: "History",
  description: "Browse commits and lane operations — the same History ADE already ships, as a plugin.",
  icon: "clock-counter-clockwise",
  accent: "#E0932F",
  entry: "index.js",
  surfaces: [{ kind: "tab", id: "commits", title: "History", icon: "clock-counter-clockwise", panelId: "commits", order: 55, mobile: true }],
  panels: [
    { id: "commits", schemaFile: "panels/commits.json", title: "History", icon: "clock-counter-clockwise", refreshAction: "refreshCommits" },
    { id: "commit", schemaFile: "panels/commit.json", title: "Commit", icon: "git-commit", refreshAction: "refreshCommit" },
    { id: "activity", schemaFile: "panels/activity.json", title: "Activity", icon: "list", refreshAction: "refreshActivity" },
    { id: "event", schemaFile: "panels/event.json", title: "Operation", icon: "clock-counter-clockwise", refreshAction: "openEvent" },
  ],
  sockets: [
    { socket: "work-rail-pane", surface: "work", id: "commits-pane", label: "History", icon: "clock-counter-clockwise", panelId: "commits" },
    { socket: "command-palette-action", surface: "app", id: "palette-commits", label: "History commits", icon: "clock-counter-clockwise", actionId: "openCommits" },
    { socket: "command-palette-action", surface: "app", id: "palette-activity", label: "History activity", icon: "list", actionId: "openActivity" },
  ],
  collections: {
    commits: { sync: true },
    operations: { sync: true },
    files: { sync: true },
    lanes: { sync: true },
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
  version: "2.0.0",
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
    description: "Paste this URL into Linear's webhook settings so an issue that changes wakes ADE.",
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
  // Seven webview surfaces, one page. Linear ships its own HTML now
  // (`plugins/ade-linear/dist/`), and each placement is a `webview` surface
  // pointing at the same `entryHtml`; the page reads the host's injected
  // `surfaceId` to know which of the seven it is drawing. Every one keeps a
  // `panelId`, which is what the phone, the terminal and an older desktop
  // render in its place.
  surfaces: [
    { kind: "webview", id: "issues", title: "Linear", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issues", order: 55, mobile: false },
    { kind: "webview", id: "quickview", title: "Linear", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issues", popover: { width: 560, height: 640 }, mobile: false },
    { kind: "webview", id: "settings", title: "Linear connection", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "settings", mobile: false },
    { kind: "webview", id: "picker", title: "Attach a Linear issue", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issues", popover: { width: 520, height: 560 }, mobile: false },
    { kind: "webview", id: "dialog-picker", title: "Link a Linear issue", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issues", mobile: false },
    { kind: "webview", id: "badge-card", title: "Linear issue", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issue", popover: { width: 300, height: 280 }, mobile: false },
    { kind: "webview", id: "issue-context", title: "Linear issue", icon: "brand:linear", entryHtml: "dist/index.html", panelId: "issue", mobile: false },
  ],
  // `webviewSurfaceId` is the upgrade, never the replacement: a client that can
  // host a plugin page draws the page, and every other client draws the
  // `panelId` or invokes the `actionId` beside it, exactly as before.
  sockets: [
    { socket: "work-rail-pane", surface: "work", id: "issues-pane", label: "Linear", icon: "brand:linear", panelId: "issues", webviewSurfaceId: "issues" },
    { socket: "composer-action", surface: "work", id: "attach-issue", label: "Attach a Linear issue", icon: "brand:linear", actionId: "openIssuePicker", webviewSurfaceId: "picker" },
    {
      socket: "chat-header-action",
      surface: "work",
      id: "chat-issue",
      label: "Linear issue",
      icon: "brand:linear",
      actionId: "openSessionIssue",
      menu: [
        { label: "Open in Linear", actionId: "openInLinear", icon: "link" },
        { label: "Comment progress on the issue", actionId: "commentProgress", icon: "chat" },
      ],
      webviewSurfaceId: "picker",
    },
    { socket: "row-badge", surface: "lanes", id: "lane-issue", label: "Linear issue", icon: "brand:linear", webviewSurfaceId: "badge-card" },
    // The Create-lane and Create-PR issue pickers, drawn as `dialog-picker`
    // guests inside ADE's own dialogs and answering them with `dialog.submit`.
    { socket: "dialog-section", surface: "lanes", id: "create-lane-issue", label: "Linear issue", icon: "brand:linear", panelId: "issues", dialog: "create-lane", webviewSurfaceId: "dialog-picker" },
    { socket: "dialog-section", surface: "prs", id: "create-pr-issue", label: "Linear issue", icon: "brand:linear", panelId: "issues", dialog: "create-pr", webviewSurfaceId: "dialog-picker" },
    { socket: "graph-node", surface: "lanes", id: "graph-issue", label: "Linear issue", icon: "brand:linear" },
    // `section` puts the card on Settings > Integrations rather than on
    // General, which is where an unnamed section lands.
    { socket: "settings-section", surface: "settings", id: "connection", label: "Linear", icon: "brand:linear", panelId: "settings", section: "integrations", webviewSurfaceId: "settings" },
    { socket: "command-palette-action", surface: "app", id: "palette-issues", label: "Linear issues", icon: "brand:linear", actionId: "openIssues" },
    // The top bar's trailing cluster. Its action opens the plugin's own quick
    // view as a popover under the button, and answers a `navigate` beside it for
    // the clients that host no page.
    { socket: "toolbar-action", surface: "app", id: "top-bar-issues", label: "Linear", icon: "brand:linear", actionId: "openIssuesQuickView", webviewSurfaceId: "quickview" },
    // The transcript's issue context, as a card in the chat.
    { socket: "chat-card", surface: "work", id: "issue-context", label: "Linear issue", icon: "brand:linear", panelId: "issue", webviewSurfaceId: "issue-context" },
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
    viewer: { sync: true },
    deliveries: { sync: false },
    // The page's own filters and selection. Per-machine reading preferences, so
    // syncing them would put one machine's sort order on another.
    "ui-state": { sync: false },
  },
  settings: [
    {
      key: "moveToDoneOnMerge",
      kind: "toggle",
      label: "Move the issue to Done when its pull request merges",
      description: "Only issues linked to the lane with \"close on merge\" are moved.",
      default: false,
    },
    {
      key: "moveToStartedOnLaunch",
      kind: "toggle",
      label: "Move the issue to In Progress when an agent starts on it",
      description: "Uses the team's first started workflow state.",
      default: false,
    },
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
      description: "Saves the kickoff prompt before Linear starts an agent on the issue.",
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

const IOS_SIM = manifest({
  name: "ade-ios-sim",
  version: "1.1.0",
  displayName: "iOS Simulator",
  description: "Drive an iOS Simulator from ADE — the same simulator pane ADE already ships, as a plugin.",
  icon: "device-mobile",
  accent: "#8A8F98",
  entry: "index.js",
  panels: [{
    id: "main",
    schemaFile: "panels/main.json",
    title: "iOS Simulator",
    icon: "device-mobile",
    refreshAction: "refreshStatus",
  }],
  sockets: [
    { socket: "work-rail-pane", surface: "work", id: "sim-pane", label: "iOS Sim", icon: "device-mobile", panelId: "main" },
    { socket: "command-palette-action", surface: "app", id: "palette-sim", label: "iOS Simulator", icon: "device-mobile", actionId: "openSimulator" },
  ],
  collections: {
    status: { sync: true },
  },
  tools: [
    {
      name: "get_status",
      description: "Read iOS Simulator status on this machine — whether it is a Mac, the live device, and the attached chat.",
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

const APP_CONTROL = manifest({
  name: "ade-app-control",
  version: "1.1.0",
  displayName: "Electron Control",
  description: "Drive and inspect Electron apps — the same Electron Control ADE already ships, as a plugin.",
  icon: "desktop",
  accent: "#47848F",
  entry: "index.js",
  panels: [{
    id: "main",
    schemaFile: "panels/main.json",
    title: "Electron Control",
    icon: "desktop",
    refreshAction: "refreshStatus",
  }],
  sockets: [
    { socket: "work-rail-pane", surface: "work", id: "control-pane", label: "Electron Control", icon: "desktop", panelId: "main" },
    { socket: "command-palette-action", surface: "app", id: "palette-control", label: "Electron Control", icon: "desktop", actionId: "openControl" },
  ],
  collections: {
    status: { sync: true },
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
 * vertical: a tab, a pane, a chat runtime, a webhook channel and a brokered
 * provider key, none of them reserved for packages ADE publishes. If any part
 * of it ever needs a `builtin` binding or an official-only capability, the
 * extraction it was built to prove has regressed.
 */
const CURSOR_CLOUD = manifest({
  name: "ade-cursor-cloud",
  version: "1.1.0",
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
  }],
  surfaces: [{
    kind: "tab",
    id: "fleet",
    title: "Cursor Cloud",
    panelId: "fleet",
    icon: "brand:cursor",
    order: 60,
    mobile: true,
  }],
  panels: [
    { id: "fleet", schemaFile: "panels/fleet.json", title: "Cursor Cloud", icon: "cloud", refreshAction: "refreshFleet", viewAction: "ackTabBadge" },
    { id: "agent", schemaFile: "panels/agent.json", title: "Agent", icon: "cloud", refreshAction: "refreshAgent" },
    { id: "launch", schemaFile: "panels/launch.json", title: "Launch in Cursor Cloud", icon: "cloud" },
  ],
  sockets: [
    {
      socket: "composer-action",
      surface: "work",
      id: "send-to-cloud",
      label: "Cursor Cloud",
      icon: "cloud",
      actionId: "openLaunch",
      ownsSend: true,
      menu: [
        { label: "Advanced launch…", actionId: "openLaunch", icon: "cloud" },
      ],
    },
    {
      socket: "chat-header-action",
      surface: "work",
      id: "open-fleet",
      label: "Cursor Cloud fleet",
      icon: "cloud",
      actionId: "openFleet",
      menu: [
        { label: "Pull this run into the lane", actionId: "pullIntoLaneFromChat", icon: "git-branch" },
        { label: "Stop this cloud run", actionId: "stopRunFromChat", icon: "cloud" },
      ],
    },
    {
      socket: "work-rail-pane",
      surface: "work",
      id: "fleet-pane",
      label: "Cursor Cloud",
      icon: "cloud",
      panelId: "fleet",
    },
    {
      socket: "command-palette-action",
      surface: "app",
      id: "palette-fleet",
      label: "Cursor Cloud fleet",
      icon: "cloud",
      actionId: "openFleet",
    },
    {
      socket: "row-badge",
      surface: "app",
      id: "tab-badge",
      label: "Unread finished agents",
    },
  ],
  // `laneSecrets` and `deliveries` stay local: one holds per-machine secrets
  // and the other webhook deliveries, and syncing either would replay a
  // delivery through a second machine's plugin child.
  collections: {
    fleet: { sync: true },
    sessions: { sync: true },
    deliveries: { sync: false },
    laneSecrets: { sync: false },
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
const PAPER = manifest({
  name: "ade-theme-paper",
  version: "1.0.1",
  displayName: "Paper",
  description: "Warm paper and ink, with a clay accent. For working in daylight.",
  icon: "palette",
  accent: "#A05C36",
  theme: {
    tokens: {
      light: {
        "--color-bg": "#F7F3EC",
        "--color-fg": "#23201B",
        "--color-surface": "#FBF8F2",
        "--color-surface-raised": "#FFFFFF",
        "--color-surface-recessed": "#EFE9DE",
        "--color-surface-overlay": "#FFFDF8",
        "--color-card": "#FFFFFF",
        "--color-card-fg": "#23201B",
        "--color-card-rgb": "255, 255, 255",
        "--color-secondary": "#EDE7DC",
        "--color-secondary-fg": "#57503F",
        "--color-muted": "#F0EAE0",
        "--color-muted-fg": "#6B6455",
        "--color-border": "#DED6C8",
        "--color-separator": "#E4DCCE",
        "--color-separator-active": "#A05C36",
        "--color-accent": "#A05C36",
        "--color-accent-fg": "#FFFFFF",
        "--color-accent-muted": "color-mix(in srgb, #A05C36 14%, transparent)",
        "--color-accent-bright": "#C0724A",
        "--color-accent-deep": "#7C4425",
        "--color-glow": "color-mix(in srgb, #A05C36 12%, transparent)",
        "--color-popup-bg": "#FFFDF8",
        "--color-modal-bg": "#FFFFFF",
        "--color-composer-bg": "#FBF7F0",
        "--color-glass-card": "#FBF7F0",
        "--color-card-solid": "#FFFFFF",
        "--pane-bg": "#FBF8F2",
        "--pane-border": "#DED6C8",
        "--chat-canvas-bg": "#F5F0E6",

        "--shell-header-bg": "#EFE8DA",
        "--shell-header-fg": "#23201B",
        "--shell-header-border": "#D8CDB9",
        "--shell-header-divider": "#DED4C2",
        "--shell-surface": "#FFFDF8",

        "--shell-sidebar-bg": "linear-gradient(180deg, #F4EEE3 0%, #E8DFCE 100%)",
        "--shell-sidebar-border": "#D8CDB9",
        "--shell-sidebar-separator": "#DED4C2",
        "--shell-sidebar-item-fg": "#7A7263",
        "--shell-sidebar-item-hover-fg": "#23201B",
        "--shell-sidebar-item-hover-bg": "color-mix(in srgb, #A05C36 10%, transparent)",
        "--shell-sidebar-item-active-fg": "#7C4425",
        "--shell-sidebar-item-active-bg": "color-mix(in srgb, #A05C36 18%, transparent)",
        "--shell-sidebar-item-active-rail": "#A05C36",

        "--shell-project-tab-fg": "#7A7263",
        "--shell-project-tab-hover-fg": "#23201B",
        "--shell-project-tab-hover-bg": "color-mix(in srgb, #A05C36 10%, transparent)",
        "--shell-project-tab-hover-border": "color-mix(in srgb, #A05C36 30%, transparent)",

        "--shell-control-bg": "#FBF7F0",
        "--shell-control-fg": "#6B6455",
        "--shell-control-border": "#D8CDB9",
        "--shell-control-hover-bg": "#FFFFFF",
        "--shell-control-hover-fg": "#23201B",
        "--shell-control-hover-border": "color-mix(in srgb, #A05C36 40%, transparent)",
        "--shell-control-open-bg": "color-mix(in srgb, #A05C36 14%, #FBF7F0)",
        "--shell-control-open-fg": "#23201B",
        "--shell-control-open-border": "color-mix(in srgb, #A05C36 46%, transparent)",
        "--shell-control-kbd-bg": "#EFE8DA",
        "--shell-control-kbd-fg": "#8A8172",

        "--shell-status-running": "#4F7A46",
        "--shell-status-attention": "#B0761C",
        "--shell-attention-fg": "#8A5A12",
        "--shell-attention-edge": "#C08A2A",
        "--shell-pressure-1": "#B0761C",
        "--shell-pressure-2": "#B05F22",
        "--shell-pressure-3": "#A8452F",
        "--shell-pressure-4": "#93302B",

        "--work-sidebar-bg": "#F1EADE",
        "--work-session-sidebar-bg": "#EDE5D6",
        "--work-pane-border": "#DED4C2",
        "--work-pane-header-bg": "color-mix(in srgb, #A05C36 6%, transparent)",
        "--work-popover-bg": "#FFFDF8",
        "--work-popover-border": "#DED4C2",

        "--work-rail-terminal": "#8E5F3C",
        "--work-rail-git": "#4F7A46",
        "--work-rail-files": "#A8791F",
        "--work-rail-ios": "#3F6E85",
        "--work-rail-app-control": "#7C4F70",
        "--work-rail-browser": "#2F7368",
      },
      dark: {
        "--color-bg": "#14110E",
        "--color-fg": "#EFE9DF",
        "--color-surface": "#1A1713",
        "--color-surface-raised": "#201C17",
        "--color-surface-recessed": "#100D0B",
        "--color-surface-overlay": "#201C17",
        "--color-card": "#201C17",
        "--color-card-fg": "#EFE9DF",
        "--color-card-rgb": "32, 28, 23",
        "--color-secondary": "#272219",
        "--color-secondary-fg": "#B6AC9C",
        "--color-muted": "#1D1915",
        "--color-muted-fg": "#9A9081",
        "--color-border": "#2E2820",
        "--color-separator": "#2E2820",
        "--color-separator-active": "#C98A5E",
        "--color-accent": "#C98A5E",
        "--color-accent-fg": "#14110E",
        "--color-accent-muted": "color-mix(in srgb, #C98A5E 20%, transparent)",
        "--color-accent-bright": "#E0A87D",
        "--color-accent-deep": "#8E5B34",
        "--color-glow": "color-mix(in srgb, #C98A5E 18%, transparent)",
        "--color-popup-bg": "#1B1712",
        "--color-modal-bg": "#201C17",
        "--color-composer-bg": "#191510",
        "--color-glass-card": "#191510",
        "--color-card-solid": "#201C17",
        "--pane-bg": "#1A1713",
        "--pane-border": "#2E2820",
        "--chat-canvas-bg": "#171310",

        "--shell-header-bg": "#1C1813",
        "--shell-header-fg": "#EFE9DF",
        "--shell-header-border": "#332B22",
        "--shell-header-divider": "#2E2820",
        "--shell-surface": "#1B1712",

        "--shell-sidebar-bg": "linear-gradient(180deg, #201C17 0%, #14110E 100%)",
        "--shell-sidebar-border": "#332B22",
        "--shell-sidebar-separator": "#2E2820",
        "--shell-sidebar-item-fg": "#9A9081",
        "--shell-sidebar-item-hover-fg": "#EFE9DF",
        "--shell-sidebar-item-hover-bg": "color-mix(in srgb, #C98A5E 12%, transparent)",
        "--shell-sidebar-item-active-fg": "#E0A87D",
        "--shell-sidebar-item-active-bg": "color-mix(in srgb, #C98A5E 18%, transparent)",
        "--shell-sidebar-item-active-rail": "#C98A5E",

        "--shell-project-tab-fg": "#9A9081",
        "--shell-project-tab-hover-fg": "#EFE9DF",
        "--shell-project-tab-hover-bg": "color-mix(in srgb, #C98A5E 12%, transparent)",
        "--shell-project-tab-hover-border": "color-mix(in srgb, #C98A5E 28%, transparent)",

        "--shell-control-bg": "color-mix(in srgb, #C98A5E 7%, transparent)",
        "--shell-control-fg": "#B6AC9C",
        "--shell-control-border": "#332B22",
        "--shell-control-hover-bg": "color-mix(in srgb, #C98A5E 14%, transparent)",
        "--shell-control-hover-fg": "#EFE9DF",
        "--shell-control-hover-border": "color-mix(in srgb, #C98A5E 34%, transparent)",
        "--shell-control-open-bg": "color-mix(in srgb, #C98A5E 20%, transparent)",
        "--shell-control-open-fg": "#F6F1E8",
        "--shell-control-open-border": "color-mix(in srgb, #C98A5E 44%, transparent)",
        "--shell-control-kbd-bg": "#241F19",
        "--shell-control-kbd-fg": "#8E8578",

        "--shell-status-running": "#8FBF7A",
        "--shell-status-attention": "#E0A87D",
        "--shell-attention-fg": "#E8B98C",
        "--shell-attention-edge": "#C98A5E",
        "--shell-pressure-1": "#D9A05E",
        "--shell-pressure-2": "#D08350",
        "--shell-pressure-3": "#C56A50",
        "--shell-pressure-4": "#BE5450",

        "--work-sidebar-bg": "#1A1612",
        "--work-session-sidebar-bg": "#151210",
        "--work-pane-border": "color-mix(in srgb, #C98A5E 14%, transparent)",
        "--work-pane-header-bg": "color-mix(in srgb, #C98A5E 7%, transparent)",
        "--work-popover-bg": "#1F1B16",
        "--work-popover-border": "#3A3128",

        "--work-rail-terminal": "#D6A277",
        "--work-rail-git": "#8FBF7A",
        "--work-rail-files": "#D9B45E",
        "--work-rail-ios": "#7FA8BE",
        "--work-rail-app-control": "#BE8FB4",
        "--work-rail-browser": "#6FBDAF",
      },
    },
  },
});

const INK = manifest({
  name: "ade-theme-ink",
  version: "1.0.1",
  displayName: "Ink",
  description: "Deep blue-black with a steel accent. Quiet under long sessions.",
  icon: "palette",
  accent: "#6FA8C7",
  theme: {
    tokens: {
      dark: {
        "--color-bg": "#0B0E13",
        "--color-fg": "#E6EAF0",
        "--color-surface": "#11151C",
        "--color-surface-raised": "#161B24",
        "--color-surface-recessed": "#080A0E",
        "--color-surface-overlay": "#161B24",
        "--color-card": "#161B24",
        "--color-card-fg": "#E6EAF0",
        "--color-card-rgb": "22, 27, 36",
        "--color-secondary": "#1C222C",
        "--color-secondary-fg": "#A9B3C0",
        "--color-muted": "#141922",
        "--color-muted-fg": "#8C97A6",
        "--color-border": "#232A35",
        "--color-separator": "#232A35",
        "--color-separator-active": "#6FA8C7",
        "--color-accent": "#6FA8C7",
        "--color-accent-fg": "#0B0E13",
        "--color-accent-muted": "color-mix(in srgb, #6FA8C7 20%, transparent)",
        "--color-accent-bright": "#93C4DE",
        "--color-accent-deep": "#3E7695",
        "--color-glow": "color-mix(in srgb, #6FA8C7 18%, transparent)",
        "--color-popup-bg": "#121721",
        "--color-modal-bg": "#161B24",
        "--color-composer-bg": "#0F131A",
        "--color-glass-card": "#0F131A",
        "--color-card-solid": "#161B24",
        "--pane-bg": "#11151C",
        "--pane-border": "#232A35",
        "--chat-canvas-bg": "#0E1219",

        "--shell-header-bg": "#0E131B",
        "--shell-header-fg": "#E6EAF0",
        "--shell-header-border": "#28313D",
        "--shell-header-divider": "#232A35",
        "--shell-surface": "#121721",

        "--shell-sidebar-bg": "linear-gradient(180deg, #161B24 0%, #0B0E13 100%)",
        "--shell-sidebar-border": "#28313D",
        "--shell-sidebar-separator": "#232A35",
        "--shell-sidebar-item-fg": "#8C97A6",
        "--shell-sidebar-item-hover-fg": "#E6EAF0",
        "--shell-sidebar-item-hover-bg": "color-mix(in srgb, #6FA8C7 12%, transparent)",
        "--shell-sidebar-item-active-fg": "#93C4DE",
        "--shell-sidebar-item-active-bg": "color-mix(in srgb, #6FA8C7 18%, transparent)",
        "--shell-sidebar-item-active-rail": "#6FA8C7",

        "--shell-project-tab-fg": "#8C97A6",
        "--shell-project-tab-hover-fg": "#E6EAF0",
        "--shell-project-tab-hover-bg": "color-mix(in srgb, #6FA8C7 12%, transparent)",
        "--shell-project-tab-hover-border": "color-mix(in srgb, #6FA8C7 28%, transparent)",

        "--shell-control-bg": "color-mix(in srgb, #6FA8C7 7%, transparent)",
        "--shell-control-fg": "#A9B3C0",
        "--shell-control-border": "#28313D",
        "--shell-control-hover-bg": "color-mix(in srgb, #6FA8C7 14%, transparent)",
        "--shell-control-hover-fg": "#E6EAF0",
        "--shell-control-hover-border": "color-mix(in srgb, #6FA8C7 34%, transparent)",
        "--shell-control-open-bg": "color-mix(in srgb, #6FA8C7 20%, transparent)",
        "--shell-control-open-fg": "#F1F5FA",
        "--shell-control-open-border": "color-mix(in srgb, #6FA8C7 44%, transparent)",
        "--shell-control-kbd-bg": "#181E28",
        "--shell-control-kbd-fg": "#7F8A99",

        "--shell-status-running": "#5EC8B0",
        "--shell-status-attention": "#E2B457",
        "--shell-attention-fg": "#E7C273",
        "--shell-attention-edge": "#C79A3E",
        "--shell-pressure-1": "#D9B45E",
        "--shell-pressure-2": "#D2905C",
        "--shell-pressure-3": "#C97F8E",
        "--shell-pressure-4": "#C96A6A",

        "--work-sidebar-bg": "#10141B",
        "--work-session-sidebar-bg": "#0C1016",
        "--work-pane-border": "color-mix(in srgb, #6FA8C7 14%, transparent)",
        "--work-pane-header-bg": "color-mix(in srgb, #6FA8C7 7%, transparent)",
        "--work-popover-bg": "#141A24",
        "--work-popover-border": "#2C3541",

        "--work-rail-terminal": "#9FB6D6",
        "--work-rail-git": "#5EBFA2",
        "--work-rail-files": "#C2A96B",
        "--work-rail-ios": "#6E9BE0",
        "--work-rail-app-control": "#A98FD6",
        "--work-rail-browser": "#5FC0D0",
      },
      light: {
        "--color-bg": "#F2F4F7",
        "--color-fg": "#161B24",
        "--color-surface": "#F8F9FB",
        "--color-surface-raised": "#FFFFFF",
        "--color-surface-recessed": "#E8EBF0",
        "--color-surface-overlay": "#FFFFFF",
        "--color-card": "#FFFFFF",
        "--color-card-fg": "#161B24",
        "--color-card-rgb": "255, 255, 255",
        "--color-secondary": "#E5E9EF",
        "--color-secondary-fg": "#4A5462",
        "--color-muted": "#EBEEF3",
        "--color-muted-fg": "#5C6673",
        "--color-border": "#D3D9E1",
        "--color-separator": "#DFE3EA",
        "--color-separator-active": "#2E6C8E",
        "--color-accent": "#2E6C8E",
        "--color-accent-fg": "#FFFFFF",
        "--color-accent-muted": "color-mix(in srgb, #2E6C8E 14%, transparent)",
        "--color-accent-bright": "#4A88AA",
        "--color-accent-deep": "#1F4E68",
        "--color-glow": "color-mix(in srgb, #2E6C8E 12%, transparent)",
        "--color-popup-bg": "#FFFFFF",
        "--color-modal-bg": "#FFFFFF",
        "--color-composer-bg": "#F6F8FA",
        "--color-glass-card": "#F6F8FA",
        "--color-card-solid": "#FFFFFF",
        "--pane-bg": "#F8F9FB",
        "--pane-border": "#D3D9E1",
        "--chat-canvas-bg": "#EEF1F5",

        "--shell-header-bg": "#E9EDF3",
        "--shell-header-fg": "#161B24",
        "--shell-header-border": "#CBD3DD",
        "--shell-header-divider": "#D8DEE7",
        "--shell-surface": "#FFFFFF",

        "--shell-sidebar-bg": "linear-gradient(180deg, #F0F3F7 0%, #E3E8EF 100%)",
        "--shell-sidebar-border": "#CBD3DD",
        "--shell-sidebar-separator": "#D8DEE7",
        "--shell-sidebar-item-fg": "#5C6673",
        "--shell-sidebar-item-hover-fg": "#161B24",
        "--shell-sidebar-item-hover-bg": "color-mix(in srgb, #2E6C8E 10%, transparent)",
        "--shell-sidebar-item-active-fg": "#1F4E68",
        "--shell-sidebar-item-active-bg": "color-mix(in srgb, #2E6C8E 16%, transparent)",
        "--shell-sidebar-item-active-rail": "#2E6C8E",

        "--shell-project-tab-fg": "#5C6673",
        "--shell-project-tab-hover-fg": "#161B24",
        "--shell-project-tab-hover-bg": "color-mix(in srgb, #2E6C8E 10%, transparent)",
        "--shell-project-tab-hover-border": "color-mix(in srgb, #2E6C8E 30%, transparent)",

        "--shell-control-bg": "#F6F8FA",
        "--shell-control-fg": "#4A5462",
        "--shell-control-border": "#CBD3DD",
        "--shell-control-hover-bg": "#FFFFFF",
        "--shell-control-hover-fg": "#161B24",
        "--shell-control-hover-border": "color-mix(in srgb, #2E6C8E 40%, transparent)",
        "--shell-control-open-bg": "color-mix(in srgb, #2E6C8E 12%, #F6F8FA)",
        "--shell-control-open-fg": "#161B24",
        "--shell-control-open-border": "color-mix(in srgb, #2E6C8E 46%, transparent)",
        "--shell-control-kbd-bg": "#E9EDF3",
        "--shell-control-kbd-fg": "#6B7583",

        "--shell-status-running": "#0F7A66",
        "--shell-status-attention": "#8A6210",
        "--shell-attention-fg": "#7A5610",
        "--shell-attention-edge": "#B08A2A",
        "--shell-pressure-1": "#8A6210",
        "--shell-pressure-2": "#9A5320",
        "--shell-pressure-3": "#A03A4E",
        "--shell-pressure-4": "#9A2130",

        "--work-sidebar-bg": "#EDF0F5",
        "--work-session-sidebar-bg": "#E7EBF2",
        "--work-pane-border": "#D3D9E1",
        "--work-pane-header-bg": "color-mix(in srgb, #2E6C8E 6%, transparent)",
        "--work-popover-bg": "#FFFFFF",
        "--work-popover-border": "#D3D9E1",

        "--work-rail-terminal": "#3F5E8C",
        "--work-rail-git": "#0F7A66",
        "--work-rail-files": "#8A6210",
        "--work-rail-ios": "#2E6C8E",
        "--work-rail-app-control": "#6B4C9A",
        "--work-rail-browser": "#0E6E80",
      },
    },
  },
});

const CONTRAST = manifest({
  name: "ade-theme-contrast",
  version: "1.0.1",
  displayName: "High contrast",
  description: "Maximum separation between text, edges and background. For bad light and tired eyes.",
  icon: "palette",
  accent: "#FFD54A",
  theme: {
    tokens: {
      dark: {
        "--color-bg": "#000000",
        "--color-fg": "#FFFFFF",
        "--color-surface": "#000000",
        "--color-surface-raised": "#101010",
        "--color-surface-recessed": "#000000",
        "--color-surface-overlay": "#101010",
        "--color-card": "#0A0A0A",
        "--color-card-fg": "#FFFFFF",
        "--color-card-rgb": "10, 10, 10",
        "--color-secondary": "#1A1A1A",
        "--color-secondary-fg": "#F2F2F2",
        "--color-muted": "#141414",
        "--color-muted-fg": "#D6D6D6",
        "--color-border": "#8A8A8A",
        "--color-separator": "#6E6E6E",
        "--color-separator-active": "#FFD54A",
        "--color-accent": "#FFD54A",
        "--color-accent-fg": "#000000",
        "--color-accent-muted": "color-mix(in srgb, #FFD54A 26%, transparent)",
        "--color-accent-bright": "#FFE685",
        "--color-accent-deep": "#C9A32E",
        "--color-glow": "color-mix(in srgb, #FFD54A 22%, transparent)",
        "--color-popup-bg": "#0A0A0A",
        "--color-modal-bg": "#0A0A0A",
        "--color-composer-bg": "#0A0A0A",
        "--color-glass-card": "#0A0A0A",
        "--color-success": "#5BE38A",
        "--color-warning": "#FFB020",
        "--color-error": "#FF7A7A",
        "--color-info": "#7FC4FF",
        "--color-card-solid": "#000000",
        "--pane-bg": "#000000",
        "--pane-border": "#8A8A8A",
        "--chat-canvas-bg": "#000000",

        "--shell-header-bg": "#000000",
        "--shell-header-fg": "#FFFFFF",
        "--shell-header-border": "#FFFFFF",
        "--shell-header-divider": "#8A8A8A",
        "--shell-surface": "#000000",

        "--shell-sidebar-bg": "#000000",
        "--shell-sidebar-border": "#FFFFFF",
        "--shell-sidebar-separator": "#8A8A8A",
        "--shell-sidebar-item-fg": "#D6D6D6",
        "--shell-sidebar-item-hover-fg": "#000000",
        "--shell-sidebar-item-hover-bg": "#FFFFFF",
        "--shell-sidebar-item-active-fg": "#000000",
        "--shell-sidebar-item-active-bg": "#FFD54A",
        "--shell-sidebar-item-active-rail": "#FFD54A",

        "--shell-project-tab-fg": "#D6D6D6",
        "--shell-project-tab-hover-fg": "#000000",
        "--shell-project-tab-hover-bg": "#FFFFFF",
        "--shell-project-tab-hover-border": "#FFFFFF",
        "--shell-project-tab-active-fg": "#000000",
        "--shell-project-tab-active-bg": "#FFD54A",
        "--shell-project-tab-active-border": "#FFD54A",

        "--shell-control-bg": "#000000",
        "--shell-control-fg": "#FFFFFF",
        "--shell-control-border": "#8A8A8A",
        "--shell-control-hover-bg": "#FFFFFF",
        "--shell-control-hover-fg": "#000000",
        "--shell-control-hover-border": "#FFFFFF",
        "--shell-control-open-bg": "#FFD54A",
        "--shell-control-open-fg": "#000000",
        "--shell-control-open-border": "#FFD54A",
        "--shell-control-kbd-bg": "#000000",
        "--shell-control-kbd-fg": "#D6D6D6",

        "--shell-status-running": "#5BE38A",
        "--shell-status-attention": "#FFD54A",
        "--shell-attention-fg": "#FFD54A",
        "--shell-attention-edge": "#FFD54A",
        "--shell-pressure-1": "#FFD54A",
        "--shell-pressure-2": "#FFA23C",
        "--shell-pressure-3": "#FF7A9E",
        "--shell-pressure-4": "#FF5C5C",

        "--work-sidebar-bg": "#000000",
        "--work-session-sidebar-bg": "#000000",
        "--work-pane-border": "#8A8A8A",
        "--work-pane-header-bg": "#101010",
        "--work-popover-bg": "#000000",
        "--work-popover-border": "#FFFFFF",
        "--work-popover-item-hover": "#333333",
        "--work-popover-item-active": "#4A4A4A",

        "--work-rail-terminal": "#C9A0FF",
        "--work-rail-git": "#5BE38A",
        "--work-rail-files": "#FFD54A",
        "--work-rail-ios": "#7FC4FF",
        "--work-rail-app-control": "#FF9AF0",
        "--work-rail-browser": "#59F0E0",
      },
      light: {
        "--color-bg": "#FFFFFF",
        "--color-fg": "#000000",
        "--color-surface": "#FFFFFF",
        "--color-surface-raised": "#FFFFFF",
        "--color-surface-recessed": "#F0F0F0",
        "--color-surface-overlay": "#FFFFFF",
        "--color-card": "#FFFFFF",
        "--color-card-fg": "#000000",
        "--color-card-rgb": "255, 255, 255",
        "--color-secondary": "#EBEBEB",
        "--color-secondary-fg": "#141414",
        "--color-muted": "#F2F2F2",
        "--color-muted-fg": "#2E2E2E",
        "--color-border": "#4A4A4A",
        "--color-separator": "#6E6E6E",
        "--color-separator-active": "#0B4FD0",
        "--color-accent": "#0B4FD0",
        "--color-accent-fg": "#FFFFFF",
        "--color-accent-muted": "color-mix(in srgb, #0B4FD0 16%, transparent)",
        "--color-accent-bright": "#2A6BE8",
        "--color-accent-deep": "#07379A",
        "--color-glow": "color-mix(in srgb, #0B4FD0 14%, transparent)",
        "--color-popup-bg": "#FFFFFF",
        "--color-modal-bg": "#FFFFFF",
        "--color-composer-bg": "#FFFFFF",
        "--color-glass-card": "#FFFFFF",
        "--color-success": "#0A7A34",
        "--color-warning": "#8A5200",
        "--color-error": "#B3001B",
        "--color-info": "#0B4FD0",
        "--color-card-solid": "#FFFFFF",
        "--pane-bg": "#FFFFFF",
        "--pane-border": "#4A4A4A",
        "--chat-canvas-bg": "#FFFFFF",

        "--shell-header-bg": "#FFFFFF",
        "--shell-header-fg": "#000000",
        "--shell-header-border": "#000000",
        "--shell-header-divider": "#4A4A4A",
        "--shell-surface": "#FFFFFF",

        "--shell-sidebar-bg": "#FFFFFF",
        "--shell-sidebar-border": "#000000",
        "--shell-sidebar-separator": "#4A4A4A",
        "--shell-sidebar-item-fg": "#2E2E2E",
        "--shell-sidebar-item-hover-fg": "#FFFFFF",
        "--shell-sidebar-item-hover-bg": "#000000",
        "--shell-sidebar-item-active-fg": "#FFFFFF",
        "--shell-sidebar-item-active-bg": "#0B4FD0",
        "--shell-sidebar-item-active-rail": "#0B4FD0",

        "--shell-project-tab-fg": "#2E2E2E",
        "--shell-project-tab-hover-fg": "#FFFFFF",
        "--shell-project-tab-hover-bg": "#000000",
        "--shell-project-tab-hover-border": "#000000",
        "--shell-project-tab-active-fg": "#FFFFFF",
        "--shell-project-tab-active-bg": "#0B4FD0",
        "--shell-project-tab-active-border": "#0B4FD0",

        "--shell-control-bg": "#FFFFFF",
        "--shell-control-fg": "#000000",
        "--shell-control-border": "#4A4A4A",
        "--shell-control-hover-bg": "#000000",
        "--shell-control-hover-fg": "#FFFFFF",
        "--shell-control-hover-border": "#000000",
        "--shell-control-open-bg": "#0B4FD0",
        "--shell-control-open-fg": "#FFFFFF",
        "--shell-control-open-border": "#0B4FD0",
        "--shell-control-kbd-bg": "#FFFFFF",
        "--shell-control-kbd-fg": "#2E2E2E",

        "--shell-status-running": "#0A7A34",
        "--shell-status-attention": "#8A5200",
        "--shell-attention-fg": "#8A5200",
        "--shell-attention-edge": "#8A5200",
        "--shell-pressure-1": "#8A5200",
        "--shell-pressure-2": "#A34200",
        "--shell-pressure-3": "#B3001B",
        "--shell-pressure-4": "#8A0014",

        "--work-sidebar-bg": "#FFFFFF",
        "--work-session-sidebar-bg": "#F0F0F0",
        "--work-pane-border": "#4A4A4A",
        "--work-pane-header-bg": "#F0F0F0",
        "--work-popover-bg": "#FFFFFF",
        "--work-popover-border": "#000000",
        "--work-popover-item-hover": "#E0E0E0",
        "--work-popover-item-active": "#C8C8C8",

        "--work-rail-terminal": "#5B21B6",
        "--work-rail-git": "#0A7A34",
        "--work-rail-files": "#8A5200",
        "--work-rail-ios": "#0B4FD0",
        "--work-rail-app-control": "#A1006E",
        "--work-rail-browser": "#00666E",
      },
    },
  },
});

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
    featured: true,
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
    readme: [
      "## iOS Simulator",
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
      "- The simctl/idb engine stays in ADE. Desktop mounts the host Simulator pane;",
      "  phone and terminal list a status row pointing at the Mac.",
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
      "- The CDP engine stays in ADE. Desktop mounts the host Control pane; phone and",
      "  terminal list a status row pointing at the attached computer.",
      "- Agents keep using `ade app-control`. Those verbs stay on the host.",
    ].join("\n"),
  }),
  listing(LOG_VIEWER, {
    author: "ADE",
    featured: true,
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
    featured: true,
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
    readme: [
      "## Cursor Cloud",
      "",
      "Launch Cursor Cloud agents from ADE, watch them from any client, and answer",
      "them in an ordinary ADE chat.",
      "",
      "A cloud agent clones your lane's branch, works on it on Cursor's machines and",
      "pushes back. This gives that a rail tab, a pane beside your chat, a button in",
      "the composer, and — the part that matters — a real conversation: open a cloud",
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
      "- Uninstalling takes the tab, the pane, the composer button, the chat runtime,",
      "  the automation triggers and the CLI words with it. Chats already bound to a",
      "  cloud agent keep their transcripts.",
    ].join("\n"),
  }),
  listing(PAPER, {
    author: "ADE",
    featured: true,
    readme: [
      "## Paper",
      "",
      "Warm paper and ink, with a clay accent — the palette of something printed",
      "rather than something emitted. Made for working in daylight, where ADE's",
      "default dark surfaces go flat.",
      "",
      "Ships both a light and a dark set, so switching between them keeps the theme.",
    ].join("\n"),
  }),
  listing(INK, {
    author: "ADE",
    readme: [
      "## Ink",
      "",
      "Deep blue-black with a steel accent. Lower saturation than the default palette",
      "and no violet, for people who spend the whole day in one window and want the",
      "interface to stop asking for attention.",
    ].join("\n"),
  }),
  listing(CONTRAST, {
    author: "ADE",
    readme: [
      "## High contrast",
      "",
      "Black on white and white on black, with edges you can actually see: borders",
      "and separators are raised well above ADE's default whisper, and muted text",
      "stops being muted. For bad light, glare, and eyes at the end of a long day.",
      "",
      "Coverage is as good as ADE's own design tokens — surfaces that still carry",
      "hard-coded colours are unchanged by any theme, this one included.",
    ].join("\n"),
  }),
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
