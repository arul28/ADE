// The three panel schemas, built on this machine.
//
// Every sentence a reader sees is here rather than in four renderers, which is
// the point of the vocabulary: desktop, the web client, iOS and the TUI draw
// the same words. The copy is ported from the built-in fleet
// (`CursorCloudFleetModal.tsx`, `useCursorCloudDraftState.ts`) so the
// extraction does not quietly reword the product.

"use strict";

const { ALL_AGENTS_URL } = require("./format");

/**
 * The three panel-state keys the fleet's filter row declares.
 *
 * `where` compares a row field against the live value of one of these, on the
 * client, with no round trip to this plugin (`shared/plugins/vocabularyState.ts`).
 * An option whose `value` is `""` means UNSET, which makes every clause reading
 * that key inactive and keeps every row — that is how "All" is spelled, and why
 * the archived control's second option is empty rather than `"show"`.
 */
const STATE_STATUS = "status";
const STATE_LANE = "lane";
const STATE_ARCHIVED = "archived";

/** The vocabulary allows eight options on one control, and "All" is one of them. */
const MAX_LANE_OPTIONS = 7;

const DEEPLINK_FLEET = "ade://plugin/ade-cursor-cloud/fleet";
const DEEPLINK_AGENT = "ade://plugin/ade-cursor-cloud/agent";
const DEEPLINK_LAUNCH = "ade://plugin/ade-cursor-cloud/launch";

/**
 * The action ids a bound fleet row may name.
 *
 * The panel author chooses every action a reader can press; the row decides
 * only which of those it offers. A row naming anything else is coerced to no
 * action, which is the invariant this list exists to keep.
 */
const FLEET_ROW_ACTIONS = [
  "openAgentDetail",
  "openInAde",
  "stopRun",
  "pullIntoLane",
  "archiveAgent",
  "unarchiveAgent",
  "openPr",
  "openAgentWeb",
  "deleteAgent",
];

/** Panel-fatal damage draws this instead. Every panel needs one. */
function fallback(text, deeplink) {
  return { title: "Cursor Cloud", text, deeplink };
}

/**
 * The predicate every fleet list carries.
 *
 * One `where` rather than three different ones, so a reader who picks "Failed"
 * sees the same rule applied in each group instead of having to learn which
 * control reaches which section. Three clauses, under the vocabulary's ceiling
 * of four, and each goes inactive on its own when its control sits on "All".
 */
function fleetWhere() {
  return [
    { field: "status", in: { $state: STATE_STATUS } },
    { field: "laneId", in: { $state: STATE_LANE } },
    { field: "archivedFlag", in: { $state: STATE_ARCHIVED } },
  ];
}

function boundList(keyPrefix, emptyText) {
  return {
    component: "list",
    bind: {
      collection: "fleet",
      keyPrefix,
      limit: 100,
      allowActions: FLEET_ROW_ACTIONS,
      where: fleetWhere(),
    },
    emptyText,
  };
}

/**
 * When the drain last received a delivery, as a line a fleet row can print.
 *
 * The ledger stores ISO-8601. A schema cannot format dates, so this is
 * pre-formatted the same way Linear's settings strip is.
 */
function formatWebhookLastEvent(iso) {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso.trim();
  return new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * The Automations strip: relay health, last event, the URL to paste.
 *
 * Cursor's channel has no `verify`, so there is no signing-secret row. The
 * URL is drawn as `code` as well as offered on a copy button, because a copy
 * that silently fails on a surface with no clipboard would leave a reader
 * with no way to get the string at all.
 */
function webhookStrip(webhook) {
  if (!webhook) return [];
  const rows = [
    { key: "Webhook", value: webhook.status ?? "Unknown", ...(webhook.tone ? { tone: webhook.tone } : {}) },
  ];
  if (webhook.lastEvent) rows.push({ key: "Last event", value: webhook.lastEvent });
  if (Number(webhook.pendingDeliveries) > 0) {
    rows.push({
      key: "Pending",
      value: String(webhook.pendingDeliveries),
      tone: "warning",
    });
  }
  if (webhook.drainError) {
    rows.push({ key: "Drain", value: webhook.drainError, tone: "danger" });
  }
  const block = [
    { component: "divider", label: "Automations" },
    { component: "keyValue", rows },
  ];
  if (webhook.url) {
    block.push({
      component: "text",
      variant: "caption",
      text: "Paste this URL into Cursor's webhook settings so a finished run wakes ADE.",
    });
    block.push({ component: "text", variant: "code", text: webhook.url });
    block.push({
      component: "button",
      label: "Copy the webhook URL",
      kind: "quiet",
      icon: "link",
      onPress: { action: "copyWebhookUrl" },
    });
  }
  return block;
}

/**
 * The filter row: status, lane, archived.
 *
 * Every option value is a string the plugin already wrote onto each row, so
 * changing one re-runs a string compare on the client and nothing else. The
 * lane control is omitted when there is at most one lane to choose between —
 * a control with one real option is a filter stuck where the author left it,
 * and the vocabulary refuses it anyway.
 */
function fleetFilterRow(input = {}) {
  const lanes = Array.isArray(input.laneOptions) ? input.laneOptions : [];
  const children = [
    {
      component: "segmented",
      stateKey: STATE_STATUS,
      label: "Status",
      default: "",
      options: [
        { value: "", label: "All" },
        { value: "active", label: "Active", ...(input.counts?.active ? { badge: String(input.counts.active) } : {}) },
        { value: "finished", label: "Finished" },
        { value: "failed", label: "Failed" },
      ],
    },
  ];

  if (lanes.length >= 1) {
    children.push({
      component: "segmented",
      stateKey: STATE_LANE,
      label: "Lane",
      default: "",
      options: [
        { value: "", label: "All lanes" },
        ...lanes.slice(0, MAX_LANE_OPTIONS).map((lane) => ({ value: lane.id, label: lane.name })),
      ],
    });
  }

  if (input.counts?.archived > 0) {
    children.push({
      component: "segmented",
      stateKey: STATE_ARCHIVED,
      label: "Archived",
      style: "toggle",
      default: "hide",
      options: [
        // `""` is unset, so this option turns the clause off and shows both
        // archived and live rows. "Show archived" means as well as, not instead.
        { value: "hide", label: "Hide archived" },
        { value: "", label: `Show archived (${input.counts.archived})` },
      ],
    });
  }

  return { component: "stack", direction: "horizontal", gap: "sm", wrap: true, align: "center", children };
}

/**
 * The fleet panel.
 *
 * `state` decides which of five bodies renders: `loading`, `no-key`, `error`,
 * `empty` or the list. They are the same five the built-in modal drew, in the
 * same words.
 */
function buildFleetPanel(input = {}) {
  const {
    state = "list",
    error = null,
    counts = { active: 0, lanes: 0, unlinked: 0, total: 0, archived: 0 },
    footer = null,
    relay = null,
    webhook = null,
  } = input;

  const body = [];

  if (state === "loading") {
    body.push({
      component: "emptyState",
      title: "Loading cloud agents…",
      description: "Reading your Cursor Cloud fleet.",
      icon: "cloud",
    });
    return { v: 1, title: "Cursor Cloud", fallback: fallback(
      "Open ADE on the Mac that holds this plugin to see your cloud agents.",
      DEEPLINK_FLEET,
    ), body };
  }

  if (state === "no-key") {
    body.push({
      component: "emptyState",
      title: "Connect Cursor first",
      description: "Add a Cursor API key in Settings → Agents → Cursor, then refresh this panel.",
      icon: "key",
      action: { label: "Open Cursor settings", onPress: { action: "openCursorSettings" } },
    });
    body.push({
      component: "button",
      label: "All agents on cursor.com",
      kind: "quiet",
      onPress: { action: "openAllAgents" },
    });
    body.push(...webhookStrip(webhook));
    return { v: 1, title: "Cursor Cloud", fallback: fallback(
      "Add a Cursor API key in ADE's Settings → AI connections to see your cloud agents.",
      DEEPLINK_FLEET,
    ), body };
  }

  if (state === "error") {
    body.push({
      component: "emptyState",
      title: "Could not load your cloud agents",
      description: error ?? "Cursor Cloud request failed.",
      icon: "cloud",
      action: { label: "Retry", onPress: { action: "refreshFleet" } },
    });
    return { v: 1, title: "Cursor Cloud", fallback: fallback(
      "Open ADE on the Mac that holds this plugin to see your cloud agents.",
      DEEPLINK_FLEET,
    ), body };
  }

  if (!webhook && relay === "error") {
    body.push({
      component: "text",
      variant: "caption",
      tone: "warning",
      text: "Live updates hit an error — statuses may be stale. Use refresh.",
    });
  } else if (!webhook && relay === "unconfigured") {
    body.push({
      component: "text",
      variant: "caption",
      text: "Live updates not configured yet — this list updates on refresh and when agents finish.",
    });
  }

  if (state === "empty") {
    body.push({
      component: "emptyState",
      title: "No cloud agents for this project",
      description:
        "Agents you launch from any chat composer with a Cursor model — and anything on cursor.com for this repo — will show up here.",
      icon: "cloud",
      action: { label: "Launch in Cursor Cloud", onPress: { action: "openLaunch" } },
    });
  } else {
    body.push(fleetFilterRow({ counts, laneOptions: input.laneOptions }));
    body.push({ component: "divider", label: `Active runs (${counts.active})` });
    body.push(boundList("active:", "No active runs match this filter."));
    body.push({ component: "divider", label: `By lane (${counts.lanes})` });
    body.push(boundList("lane:", "No agents linked to a lane match this filter."));
    body.push({ component: "divider", label: `Unlinked (${counts.unlinked})` });
    body.push(boundList("unlinked:", "Nothing unlinked matches this filter."));
  }

  body.push(...webhookStrip(webhook));
  body.push({ component: "divider" });
  body.push({
    component: "stack",
    direction: "horizontal",
    align: "center",
    gap: "md",
    wrap: true,
    children: [
      { component: "text", variant: "caption", text: footer ?? "" },
      {
        component: "button",
        label: "All agents on cursor.com",
        kind: "quiet",
        onPress: { action: "openAllAgents" },
      },
    ],
  });

  return {
    v: 1,
    title: "Cursor Cloud",
    fallback: fallback(
      "Open ADE on the Mac that holds this plugin to see your cloud agents.",
      DEEPLINK_FLEET,
    ),
    body,
  };
}

/** The count line under the fleet, pre-formatted because rule 3 forbids maths. */
function fleetFooter(input = {}) {
  const shown = input.shown ?? 0;
  const costCents = input.costCents;
  const age = input.age;
  const parts = [`${shown} agent${shown === 1 ? "" : "s"}`];
  if (costCents != null && Number.isFinite(costCents)) {
    parts.push(`$${(costCents / 100).toFixed(2)} shown`);
  }
  if (age) parts.push(`updated ${age}`);
  return parts.join(" · ");
}

/**
 * One agent's detail panel.
 *
 * A facts block, the agent's own summary, and a row of buttons that read the
 * agent id out of the panel's context — so the same panel serves every agent
 * and nothing is baked into the schema.
 */
function buildAgentPanel(input = {}) {
  const { entry = null, agentId = null, usage = null, error = null } = input;

  // The schema on disk, before the child has read anything. Every panel ships
  // one so a client that opens the pane draws a sentence rather than a blank.
  if (input.state === "loading") {
    return {
      v: 1,
      title: "Agent",
      fallback: fallback("Open the Cursor Cloud fleet to pick an agent.", DEEPLINK_AGENT),
      body: [{
        component: "emptyState",
        title: "Loading this cloud agent…",
        description: "Reading it from Cursor.",
        icon: "cloud",
      }],
    };
  }

  if (!entry) {
    return {
      v: 1,
      title: "Agent",
      fallback: fallback("Open the Cursor Cloud fleet to pick an agent.", DEEPLINK_AGENT),
      body: [{
        component: "emptyState",
        title: "That cloud agent could not be found.",
        description: error ?? "It may have been deleted on cursor.com.",
        icon: "cloud",
        action: { label: "Back to the fleet", onPress: { action: "openFleet" } },
      }],
    };
  }

  const id = agentId ?? entry.agent.agentId;
  const rows = [
    { key: "Status", value: String(input.status ?? "unknown") },
    { key: "Agent", value: id },
  ];
  if (entry.latestRunId) rows.push({ key: "Run", value: entry.latestRunId });
  if (entry.branch) rows.push({ key: "Branch", value: entry.branch });
  if (entry.modelId) rows.push({ key: "Model", value: entry.modelId });
  if (entry.agent.repos[0]) rows.push({ key: "Repository", value: entry.agent.repos[0] });
  if (entry.ownership.laneName) rows.push({ key: "Lane", value: entry.ownership.laneName });
  if (entry.ownership.linearIssueId) rows.push({ key: "Issue", value: entry.ownership.linearIssueId });
  if (usage?.totalTokens != null) {
    rows.push({ key: "Tokens", value: String(usage.totalTokens) });
  }
  if (usage?.costCents != null) {
    rows.push({ key: "Cost", value: `$${(usage.costCents / 100).toFixed(2)}` });
  }

  const buttons = [];
  if (!entry.agent.archived) {
    buttons.push({
      component: "button",
      label: "Open in ADE",
      kind: "primary",
      onPress: { action: "openInAde", args: { agentId: id } },
    });
  }
  if (input.active) {
    buttons.push({
      component: "button",
      label: "Stop",
      kind: "quiet",
      onPress: { action: "stopRun", args: { agentId: id } },
    });
  }
  if (input.status === "finished" && !entry.agent.archived) {
    buttons.push({
      component: "button",
      label: "Pull into lane",
      onPress: { action: "pullIntoLane", args: { agentId: id } },
    });
  }
  if (entry.prUrl) {
    buttons.push({
      component: "button",
      label: "Open PR",
      kind: "quiet",
      onPress: { action: "openPr", args: { agentId: id } },
    });
  }
  buttons.push({
    component: "button",
    label: "Open on cursor.com",
    kind: "quiet",
    onPress: { action: "openAgentWeb", args: { agentId: id } },
  });

  const body = [
    { component: "text", variant: "title", text: entry.agent.name },
    { component: "keyValue", rows },
  ];
  if (entry.agent.summary && entry.agent.summary !== entry.agent.name) {
    body.push({ component: "text", variant: "body", text: entry.agent.summary });
  }
  body.push({ component: "divider" });
  body.push({ component: "stack", direction: "horizontal", gap: "sm", wrap: true, children: buttons });

  return {
    v: 1,
    title: entry.agent.name,
    fallback: fallback("Open ADE on your Mac to act on this cloud agent.", DEEPLINK_AGENT),
    body,
  };
}

/**
 * The launch form.
 *
 * The built-in path put a "Cursor Cloud" row in the composer's machine picker.
 * There is no socket for a machine-picker row and inventing one is a parity
 * cost on four clients, so this is the platform's own answer to the same
 * gesture: a `composer-action` that opens this form.
 */
function buildLaunchPanel(input = {}) {
  const { lanes = [], models = [], secretNames = [], unavailable = null, draft = "" } = input;
  const reasoningOptions = Array.isArray(input.reasoningOptions) ? input.reasoningOptions : [];
  const showSpeed = input.showSpeed === true;

  if (input.state === "loading") {
    return {
      v: 1,
      title: "Launch in Cursor Cloud",
      fallback: fallback(
        "Cursor Cloud agents launch from the Mac that holds this plugin.",
        DEEPLINK_LAUNCH,
      ),
      body: [{
        component: "emptyState",
        title: "Checking Cursor Cloud…",
        description: "Reading this lane's remote and your connected repositories.",
        icon: "cloud",
      }],
    };
  }

  if (unavailable) {
    return {
      v: 1,
      title: "Launch in Cursor Cloud",
      fallback: fallback(unavailable, DEEPLINK_LAUNCH),
      body: [{
        component: "emptyState",
        title: "Cursor Cloud is not available here",
        description: unavailable,
        icon: "cloud",
        action: { label: "Check again", onPress: { action: "openLaunch" } },
      }],
    };
  }

  const fields = [
    {
      kind: "text",
      id: "prompt",
      label: "What should the agent do?",
      placeholder: "Fix the flaky sync test and open a PR.",
      value: draft,
    },
    {
      kind: "select",
      id: "laneId",
      label: "Lane",
      help: "The agent works on this lane's branch.",
      options: lanes.slice(0, 40).map((lane) => ({ value: lane.id, label: lane.name })),
      ...(lanes[0] ? { value: lanes[0].id } : {}),
    },
  ];

  if (models.length) {
    fields.push({
      kind: "select",
      id: "model",
      label: "Model",
      options: [
        { value: "", label: "Cursor's default" },
        ...models.slice(0, 39).map((model) => ({ value: model, label: model })),
      ],
      value: "",
    });
  }

  if (reasoningOptions.length) {
    fields.push({
      kind: "select",
      id: "reasoningEffort",
      label: "Reasoning",
      help: "Left on default, Cursor picks the variant. A pick this catalog cannot express fails the launch rather than running a different model.",
      options: [
        { value: "", label: "Cursor's default" },
        ...reasoningOptions.slice(0, 7).map((entry) => ({ value: entry.value, label: entry.label })),
      ],
      value: "",
    });
  }

  if (showSpeed) {
    fields.push({
      kind: "select",
      id: "fastMode",
      label: "Speed",
      help: "Left on default, Cursor picks the tier. Fast and standard are sent as model params, not as a guess.",
      options: [
        { value: "", label: "Cursor's default" },
        { value: "fast", label: "Fast" },
        { value: "standard", label: "Standard" },
      ],
      value: "",
    });
  }

  fields.push({
    kind: "toggle",
    id: "openPr",
    label: "Open a PR when the run finishes",
    help: "Creation-time only — it cannot be added later. A branch that already has a PR attaches to that one instead.",
    value: input.autoOpenPr === true,
  });

  // One toggle per remembered secret name. The vocabulary has no multi-select,
  // and a toggle each is honest: the reader sees every name they are attaching.
  // Names only — a value never enters a panel schema. Cap so the form stays
  // inside maxFormFields (24) after the reasoning/speed controls.
  const secretBudget = Math.max(0, 24 - fields.length - (secretNames.length ? 1 : 0));
  for (const name of secretNames.slice(0, Math.min(18, secretBudget))) {
    fields.push({
      kind: "toggle",
      id: `secret:${name}`,
      label: `Attach ${name}`,
      value: input.selectedSecrets?.includes(name) === true,
    });
  }

  if (secretNames.length) {
    fields.push({
      kind: "toggle",
      id: "rememberSecretNames",
      label: "Remember for this lane",
      value: input.rememberSecretNames === true,
    });
  }

  return {
    v: 1,
    title: "Launch in Cursor Cloud",
    fallback: fallback(
      "Cursor Cloud agents launch from the Mac that holds this plugin.",
      DEEPLINK_LAUNCH,
    ),
    body: [
      {
        component: "text",
        variant: "caption",
        text: "Cursor clones this lane's branch, works on it in the cloud, and pushes back.",
      },
      {
        component: "form",
        fields: fields.slice(0, 24),
        submit: { label: "Launch in Cursor Cloud", onPress: { action: "createRun" } },
      },
      {
        component: "button",
        label: "Manage project secrets",
        kind: "quiet",
        onPress: { action: "openSecretsSettings" },
      },
    ],
  };
}

/**
 * The four sentences the built-in composer showed when Cursor Cloud could not
 * take the work. Ported verbatim so the reason reads the same as it always did.
 */
function unavailableReason(input = {}) {
  if (input.probe === "loading") return "Checking Cursor Cloud…";
  if (input.probe === "error") return input.message ?? "Cursor Cloud request failed.";
  if (!input.laneRemote) {
    return "This lane has no GitHub remote, so there is nothing for Cursor Cloud to clone.";
  }
  if (!input.repoConnected) {
    return "This repo is not connected to Cursor. Connect it in Cursor, then try again.";
  }
  return null;
}

module.exports = {
  DEEPLINK_AGENT,
  DEEPLINK_FLEET,
  DEEPLINK_LAUNCH,
  FLEET_ROW_ACTIONS,
  MAX_LANE_OPTIONS,
  STATE_ARCHIVED,
  STATE_LANE,
  STATE_STATUS,
  fleetFilterRow,
  fleetWhere,
  buildAgentPanel,
  buildFleetPanel,
  buildLaunchPanel,
  fleetFooter,
  formatWebhookLastEvent,
  unavailableReason,
};
