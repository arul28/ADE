import { VOCAB_VERSION } from "../../../shared/plugins/vocabulary";

/**
 * Fixture panels for `/plugins-dev`.
 *
 * These are the acceptance surface for the vocabulary renderer: between them
 * they exercise every v1 component, both degradation paths, and every
 * panel-fatal failure. Anything a plugin can send, one of these sends.
 *
 * Keep them literal. A fixture that computes its own content stops being a
 * fixture the moment the computation is where the bug is.
 */

export type PluginFixture = {
  id: string;
  label: string;
  /** Why this fixture exists — rendered under its heading on the dev page. */
  note: string;
  /** Raw, exactly as a plugin would store it in `plugin_panels.schema_json`. */
  schema: unknown;
};

const fallback = {
  title: "Fixture panel",
  text: "This panel could not be rendered natively.",
  deeplink: "ade://lane/fixture",
};

export const PLUGIN_FIXTURES: PluginFixture[] = [
  {
    id: "typography",
    label: "Text, badges, dividers",
    note: "The type scale and the four tones. No monospace outside `code`.",
    schema: {
      v: VOCAB_VERSION,
      title: "Typography",
      fallback,
      body: [
        { component: "text", text: "Panel title", variant: "title" },
        { component: "text", text: "A subtitle line", variant: "subtitle" },
        {
          component: "text",
          text: "Body copy sets the default reading size for a panel. It wraps, it keeps its line height, and it never turns into a wall of monospace.",
          variant: "body",
        },
        { component: "text", text: "Caption — the quietest line.", variant: "caption" },
        { component: "text", text: "npm run dev -- --port 5173", variant: "code" },
        { component: "divider", label: "Tones" },
        {
          component: "stack",
          direction: "horizontal",
          gap: "sm",
          wrap: true,
          children: [
            { component: "badge", text: "Neutral" },
            { component: "badge", text: "Accent", tone: "accent", icon: "sparkle" },
            { component: "badge", text: "Passing", tone: "success", icon: "shield" },
            { component: "badge", text: "Failed", tone: "danger", icon: "bug" },
          ],
        },
        { component: "divider" },
      ],
    },
  },
  {
    id: "lists",
    label: "List and key/value",
    note: "Rows with an icon, a subtitle and a meta column; a definition grid beside it.",
    schema: {
      v: VOCAB_VERSION,
      title: "Lists",
      fallback,
      body: [
        {
          component: "list",
          items: [
            { title: "feature/plugin-platform", subtitle: "12 commits ahead", meta: "2m", icon: "git-branch" },
            { title: "fix/theme-scope", subtitle: "Conflicts with main", meta: "1h", tone: "warning", icon: "git-branch" },
            { title: "chore/deps", subtitle: "Merged", meta: "yesterday", tone: "success", icon: "git-commit" },
          ],
        },
        { component: "divider", label: "Details" },
        {
          component: "keyValue",
          rows: [
            { key: "Branch", value: "feature/plugin-platform" },
            { key: "Machine", value: "studio" },
            { key: "State", value: "Running", tone: "success" },
            { key: "Last error", value: "" },
          ],
        },
      ],
    },
  },
  {
    id: "rich-rows",
    label: "Rich list rows",
    note: "A fleet row: status chip, monospace branch, two trailing buttons and an overflow menu. One node for the whole list.",
    schema: {
      v: VOCAB_VERSION,
      title: "Rich rows",
      fallback,
      body: [
        {
          component: "list",
          items: [
            {
              title: "bc-1f4a",
              subtitle: "Fix the login redirect on the marketing site",
              mono: "origin/fix-login-redirect",
              badge: { text: "Running", tone: "accent", icon: "play" },
              onPress: { action: "open-agent", args: { id: "bc-1f4a" } },
              actions: [
                { action: "pull-into-lane", label: "Pull", kind: "primary", icon: "git-branch" },
                { action: "stop-agent", label: "Stop", confirm: "Stop this agent?" },
              ],
              overflow: [
                { action: "open-on-cursor", label: "Open on cursor.com", icon: "globe" },
                { action: "archive-agent", label: "Archive", icon: "package" },
              ],
            },
            {
              title: "bc-90de",
              subtitle: "Add the plugin refresh contract",
              mono: "origin/plugin-refresh",
              badge: { text: "Finished", tone: "success" },
              meta: "4m",
              actions: [{ action: "pull-into-lane", label: "Pull", kind: "primary", icon: "git-branch" }],
            },
            {
              title: "bc-77b2",
              subtitle: "Could not resolve the repository",
              mono: "origin/unknown",
              badge: { text: "Error", tone: "warning", icon: "bug" },
              tone: "warning",
              meta: "1h",
              overflow: [{ action: "archive-agent", label: "Archive", icon: "package" }],
            },
          ],
        },
      ],
    },
  },
  {
    id: "table",
    label: "Table",
    note: "Right-aligned numerics get tabular figures. A missing cell reads as an em dash.",
    schema: {
      v: VOCAB_VERSION,
      title: "Table",
      fallback,
      body: [
        {
          component: "table",
          columns: [
            { key: "lane", label: "Lane" },
            { key: "commits", label: "Commits", align: "right" },
            { key: "state", label: "State" },
          ],
          rows: [
            { lane: "plugin-platform", commits: 12, state: "Open" },
            { lane: "theme-scope", commits: 3, state: "Conflict" },
            { lane: "deps", commits: 1 },
          ],
        },
      ],
    },
  },
  {
    id: "form",
    label: "Form",
    note: "All five field kinds. The secret masks by default and says when one is already stored.",
    schema: {
      v: VOCAB_VERSION,
      title: "Form",
      fallback,
      body: [
        {
          component: "form",
          fields: [
            { kind: "text", id: "name", label: "Display name", placeholder: "Graph", help: "Shown in the tab rail." },
            { kind: "secret", id: "token", label: "API token" },
            {
              kind: "select",
              id: "lane",
              label: "Default lane",
              options: [
                { value: "main", label: "main" },
                { value: "plugin-platform", label: "plugin-platform" },
              ],
              value: "main",
            },
            { kind: "toggle", id: "auto", label: "Refresh automatically", value: true },
            { kind: "number", id: "interval", label: "Interval (minutes)", min: 1, max: 60, value: 5 },
          ],
          submit: { label: "Save settings", onPress: { action: "saveSettings" } },
        },
      ],
    },
  },
  {
    id: "charts",
    label: "Charts",
    note: "Sparse line and bar. Strokes stay 1.5px at any panel width; labels live in HTML, not the SVG.",
    schema: {
      v: VOCAB_VERSION,
      title: "Charts",
      fallback,
      body: [
        {
          component: "chart",
          kind: "line",
          title: "Commits per day",
          series: [
            {
              id: "commits",
              tone: "accent",
              points: [
                { x: "Mon", y: 4 },
                { x: "Tue", y: 9 },
                { x: "Wed", y: 2 },
                { x: "Thu", y: 12 },
                { x: "Fri", y: 7 },
              ],
            },
          ],
        },
        { component: "divider" },
        {
          component: "chart",
          kind: "bar",
          title: "Checks",
          series: [
            {
              id: "checks",
              tone: "success",
              points: [
                { x: "lint", y: 12 },
                { x: "test", y: 34 },
                { x: "build", y: 6 },
              ],
            },
          ],
        },
        { component: "divider", label: "Two series" },
        {
          component: "chart",
          kind: "line",
          series: [
            { id: "opened", label: "Opened", tone: "accent", points: [{ x: 0, y: 2 }, { x: 1, y: 6 }, { x: 2, y: 4 }] },
            { id: "merged", label: "Merged", tone: "success", points: [{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }] },
          ],
        },
      ],
    },
  },
  {
    id: "media",
    label: "Media and empty state",
    note: "Video withholds its `src` until the surface is visible. The empty state is panel-local, not `ui/EmptyState`.",
    schema: {
      v: VOCAB_VERSION,
      title: "Media",
      fallback,
      body: [
        {
          component: "video",
          src: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
          title: "A capture from the plugin",
        },
        { component: "divider" },
        {
          component: "emptyState",
          title: "Nothing to review",
          description: "New results appear here as soon as the plugin publishes them.",
          icon: "kanban",
          action: { label: "Run now", onPress: { action: "run" } },
        },
      ],
    },
  },
  {
    id: "actions",
    label: "Buttons",
    note: "Three kinds. Every press shows pending, then either succeeds or prints the host's error inline.",
    schema: {
      v: VOCAB_VERSION,
      title: "Actions",
      fallback,
      body: [
        {
          component: "stack",
          direction: "horizontal",
          gap: "sm",
          wrap: true,
          children: [
            { component: "button", label: "Primary", kind: "primary", onPress: { action: "primary" } },
            { component: "button", label: "Default", onPress: { action: "default" }, icon: "lightning" },
            { component: "button", label: "Quiet", kind: "quiet", onPress: { action: "quiet" } },
            {
              component: "button",
              label: "With confirm",
              onPress: { action: "destructive", confirm: "Remove every cached result?" },
            },
            { component: "button", label: "Disabled", onPress: { action: "noop" }, disabled: true },
          ],
        },
      ],
    },
  },
  {
    id: "degradation",
    label: "Degradation — node level",
    note: "An unknown component and a malformed one. Both stay inline; their siblings render normally.",
    schema: {
      v: VOCAB_VERSION,
      title: "Degradation",
      fallback,
      body: [
        { component: "text", text: "Before", variant: "subtitle" },
        { component: "hologram", projection: "3d" },
        { component: "button", label: "Missing its action" },
        { component: "list", bind: { keyPrefix: "no-collection-named" } },
        { component: "text", text: "After — still rendered.", variant: "subtitle" },
      ],
    },
  },
  {
    id: "fatal-version",
    label: "Degradation — unsupported version",
    note: "Panel-fatal. The card leads with the plugin's own fallback text, with the reason behind Details.",
    schema: { v: 99, fallback, body: [{ component: "text", text: "never rendered" }] },
  },
  {
    id: "fatal-no-fallback",
    label: "Degradation — no fallback declared",
    note: "Panel-fatal with nothing to recover. This is the floor: generic copy, never a blank panel.",
    schema: { v: VOCAB_VERSION, body: [{ component: "text", text: "never rendered" }] },
  },
  {
    id: "fatal-not-json",
    label: "Degradation — malformed JSON",
    note: "What a truncated or corrupted `schema_json` row looks like.",
    schema: '{"v":1,"fallback":{"title":"Truncated"',
  },
  {
    id: "bound",
    label: "Bound data",
    note: "Reads from `plugin_collections`. On this page no host answers, so each node shows its empty text.",
    schema: {
      v: VOCAB_VERSION,
      title: "Bound",
      fallback,
      body: [
        { component: "list", bind: { collection: "issues", keyPrefix: "open:" }, emptyText: "No open issues." },
        {
          component: "table",
          columns: [{ key: "name", label: "Name" }],
          bind: { collection: "runs", limit: 20 },
          emptyText: "No runs recorded.",
        },
        { component: "keyValue", bind: { collection: "meta" }, emptyText: "No metadata published." },
      ],
    },
  },
];
