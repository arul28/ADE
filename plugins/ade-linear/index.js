// ade-linear — Linear as an ADE plugin, built out of public parts.
//
// The Linear integration ADE ships today is roughly 5,400 lines of desktop
// renderer, 2,900 lines of iOS and 8,200 lines of main-process service, and it
// reaches every one of those surfaces by being compiled into them. This package
// is the same integration with nothing privileged left in it:
//
//   * the issue browser is a `tab` surface plus a `work-rail-pane`, drawn from
//     a vocabulary panel bound to this plugin's own `issues` collection;
//   * the connection is `authSessions` and nothing else — the host opens the
//     browser and owns the `state`, and the token is this plugin's from the
//     moment it exists. There is no credential handoff: this plugin signs in
//     the way any community plugin does, so a machine that never had ADE's
//     compiled Linear connection is not a second-class install;
//   * the webhook is a declared `webhookIngress` channel at ADE's relay, and
//     the events arrive as `webhook.received` with an ack;
//   * the lane and agent flows are `lane.create`, `chat.createSession` and
//     `ade.lanes.linkIssue`, which is the seam that makes a tracker plugin a
//     first-class one rather than a viewer;
//   * the nine agent tools, the five automation triggers, the four steps, the
//     search provider and the CLI word are all manifest registrations.
//
// `official: true` buys this package exactly one thing beyond the relaxation
// that lets it claim `linear.app` in a URL matcher: the official OAuth client
// broker, gated on ADE owning the `linear` builtin surface. The public client
// id it lends is not a credential, so nothing here depends on a connection the
// user already had. It does NOT buy a pane: the manifest declares a `tab` with
// no `builtin` field, and `parseSurfaces` would ignore one if it were there.
// Everything else a community author could write.
//
// ## Where the work happens
//
// On the machine that holds the credential, and nowhere else. Every client —
// the phone, the web client, the TUI — draws rows this process already shaped,
// which is what makes the whole integration appear on surfaces the built-in's
// 5,400 lines of renderer never reached.
//
// ## The two halves
//
// `panels.js` and `panelActions.js` own what a panel LOOKS like and what its
// buttons do. This file owns everything else and hands the panel half a `host`
// object at activate. The seam is deliberate: the panel half never calls
// Linear and never touches a collection key, and this half never builds a
// schema.

"use strict";

const { createLinearApi } = require("./linearApi");
const { createData } = require("./data");
const { createFlows } = require("./flows");
const { issueBranchName, issueLaneName } = require("./issueFormat");
const { createConnect, normalizeAuthOrigin } = require("./connect");
const { createAutomation } = require("./automation");
const { createWebhookHandler } = require("./webhook");
const panels = require("./panels");
const panelActions = require("./panelActions");
const { issueIdFromRowKey } = require("./panels/rows");
const { createOwnActions } = require("./actions");
const { createPageActions } = require("./pageActions");
// The comment key space, from the file that BUILDS it. A second spelling here
// renders as an empty comment list rather than as an error — which is the exact
// bug class `panels/contract.js` opens by naming.
const { COLLECTION_COMMENTS, PROMPT_LANE, commentKeyPrefix } = require("./panels/contract");
const { COPY, LIMITS } = require("./panels/common");

/** Attempts to publish a panel before giving up until the next action. */
const PUBLISH_ATTEMPTS = 5;
const PUBLISH_RETRY_MS = 3_000;

/**
 * How long an issue read is believed before an action refetches it.
 *
 * The built-in's own in-memory cache is 90 s (`LinearIssueBrowser.tsx:81`).
 * This is shorter because a plugin's refresh is cheaper — it writes rows every
 * client already has, rather than re-rendering a 1,874-line component — and
 * because a webhook usually gets there first anyway.
 */
const ISSUE_CACHE_MS = 30_000;

/**
 * The launch form's two provider pickers.
 *
 * Literal rather than read from ADE: `chat.createSession` validates both and
 * neither is discoverable through an action a plugin may call at agent role.
 * A value ADE later stops accepting is refused at launch with ADE's own
 * message, which is a better failure than a picker that silently offers
 * nothing.
 */
const PERMISSION_MODES = [
  { value: "default", label: "Ask before acting" },
  { value: "accept-edits", label: "Accept edits" },
  { value: "full-auto", label: "Full auto" },
];

/**
 * The reasoning-effort choices, with a SENTINEL for "whatever the model does".
 *
 * `"default"` and not `""`. An empty option value looks right — it is the
 * absence of a choice — and a `segmented` control does accept one. A form
 * SELECT does not: `vocabString("")` answers `undefined`, the option is
 * dropped, and `readSelect` then fails the WHOLE field, so the "Reasoning
 * effort" row silently did not render on any client.
 *
 * The sentinel is mapped back to "send nothing" in
 * {@link REASONING_EFFORT_DEFAULT}'s one reader, so what reaches the provider
 * is unchanged.
 */
const REASONING_EFFORT_DEFAULT = "default";

const REASONING_EFFORTS = [
  { value: REASONING_EFFORT_DEFAULT, label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

/** The reader's choice, or `null` for the sentinel and for nothing at all. */
function chosenReasoningEffort(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text !== REASONING_EFFORT_DEFAULT ? text : null;
}

let sdk = null;
let api = null;
let data = null;
let flows = null;
let connect = null;
let automation = null;
let webhook = null;
let disposed = false;
/** Unsubscribe functions for every event this plugin listens to. */
const subscriptions = [];
/** When the issue rows were last materialized. */
let lastIssueRefreshAt = 0;
/** The handler table `panelActions.bind` answered with, kept for `deactivate`. */
let panelHandlers = null;
/** `owner/repo` for the settings panel's autolink card, or null. */
let githubRepoSlug = null;

/**
 * The chain `activate` starts and does not await, as a promise a CALLER may.
 *
 * The host never waits on it — that is the whole point of {@link firstRead} —
 * but a test that asserted on the panels before it settled would be asserting
 * on a race. Exposed through `__internals.firstRead()` so a test waits on the
 * real work rather than on a timer.
 */
let firstReadPromise = Promise.resolve();

/**
 * Which issue the detail and launch panels are currently ABOUT.
 *
 * The panel half's host capability is `publish(panelId)` — one argument, no
 * context — so every republish it makes of the issue or launch panel arrives
 * here with nothing naming the issue. Without this, a handler that wrote a
 * comment and then redrew the panel would blank the very issue it just changed,
 * and the launch form would show "that issue is not in this view" the instant
 * it opened.
 *
 * The navigation `context` is still preferred when there IS one: it is the
 * client's own answer to "which issue is on screen", and it survives a plugin
 * restart in a way this does not. This is the fallback for the one caller that
 * structurally cannot pass it.
 */
let currentIssueId = null;
let currentLaunch = null;

function log(level, message, fields) {
  sdk?.log(level, message, fields);
}

/* ── Publishing ──────────────────────────────────────────────────────────── */

/**
 * Replace a panel's schema, retrying while no project is attached.
 *
 * Panel writes are project-scoped and the plugin host is machine-scoped, so at
 * cold start this can run before any project is open. Letting it throw out of
 * `activate` would read as a crash and start the restart backoff.
 */
async function publishSchema(panelId, schema, attempt = 1) {
  if (!sdk || disposed) return;
  try {
    await sdk.panels.update(panelId, schema);
  } catch (error) {
    if (attempt >= PUBLISH_ATTEMPTS) {
      log("warn", `Could not publish the ${panelId} panel: ${error?.message ?? error}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    await publishSchema(panelId, schema, attempt + 1);
  }
}

/**
 * Build and publish one panel by id.
 *
 * The panel half decides what the schema IS; this decides when it is written
 * and what it is written FROM. Each builder takes a per-panel view rather than
 * the whole model — an issue detail wants one issue and its thread, and handing
 * it the workspace would make every publish carry 250 rows the schema cannot
 * draw.
 */
async function publish(panelId, context = null) {
  if (!sdk || disposed) return;
  // Recorded here rather than at each call site, so a caller that knows which
  // issue it means records it exactly once and every later republish — from
  // either half — finds it. See `currentIssueId`.
  if (panelId === "issue" && context?.issueId) currentIssueId = context.issueId;
  if (panelId === "launch" && context?.issueId) {
    currentLaunch = { issueId: context.issueId, laneOnly: context.laneOnly === true };
  }
  let view;
  try {
    view = await viewFor(panelId, context);
  } catch (error) {
    log("warn", `Could not read the ${panelId} panel's data: ${error?.message ?? error}`);
    return;
  }
  let schema;
  try {
    schema = panels.build(panelId, view);
  } catch (error) {
    log("warn", `Could not build the ${panelId} panel: ${error?.message ?? error}`);
    return;
  }
  if (!schema) return;
  await publishSchema(panelId, schema);
}

/** The snapshot every action reads. Never handed to a builder unshaped. */
function model() {
  return data
    ? data.currentModel()
    : { connection: null, counts: { issues: 0, teams: 0 }, lanes: [], models: [], groups: [], autolinks: [] };
}

/** "4 minutes ago", for the list's footer. Absent rather than "never". */
function ago(iso) {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 45) return "just now";
  if (seconds < 5_400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * Whether any filter is away from its unset value.
 *
 * It decides one thing: whether the list offers `Reset filters`, which is
 * pointless when there is nothing to reset. Read from the STORED filters, not
 * from panel state — panel state belongs to the client and this plugin never
 * sees it — and spelled `stateTab`, which is the stored name.
 */
function filtersActive(filters = {}) {
  return Boolean(
    (filters.stateTab && filters.stateTab !== "all")
    || filters.projectId
    || filters.assigneeId
    || filters.teamKey
    || (filters.priority !== undefined && filters.priority !== null && filters.priority !== "")
    || filters.updated
    || (filters.sort && filters.sort !== "updated_desc")
    || filters.text,
  );
}

/**
 * The panel's state keys, in the filter names `data.js` stores.
 *
 * `panels/contract.js` names a control by what it selects (`state`, `project`)
 * and `data.js` names a filter by what it holds (`stateTab`, `projectId`).
 * Neither is wrong. `normalizeFilters` silently drops a key it does not know,
 * so the rename has to happen before the write or the control moves and
 * nothing changes — which is what the state tabs and the grouped/flat toggle
 * both did.
 *
 * `team` has no stored filter and no `IssueFilter` field behind it, so it is
 * not listed: it is a client-side control over rows already in memory.
 */
const STORED_FILTER_NAMES = Object.freeze({
  state: "stateTab",
  project: "projectId",
  assignee: "assigneeId",
  priority: "priority",
  sort: "sort",
  team: "teamKey",
  updated: "updated",
  view: "view",
});

/** One filter patch, renamed out of the panel's vocabulary into the store's. */
function storedFilterPatch(patch) {
  const frame = patch && typeof patch === "object" ? patch : {};
  const next = {};
  for (const [panelKey, storedKey] of Object.entries(STORED_FILTER_NAMES)) {
    if (frame[panelKey] !== undefined) next[storedKey] = frame[panelKey];
  }
  // The stored names pass through as themselves, so a caller that already
  // speaks the store's vocabulary — the CLI word, a tool — is not renamed
  // twice into nothing.
  for (const storedKey of Object.values(STORED_FILTER_NAMES)) {
    if (frame[storedKey] !== undefined) next[storedKey] = frame[storedKey];
  }
  if (typeof frame.text === "string") next.text = frame.text;
  return next;
}

/**
 * A stored issue's labels, as the names the detail panel draws chips from.
 *
 * The row stores `{id, name, color}` so a binding can filter on a field; the
 * panel half draws one badge per name and knows nothing else about a label.
 */
function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .filter((name) => typeof name === "string" && name.trim());
}

/**
 * The view one panel is drawn from — the ONE mapper between the two halves.
 *
 * Five shapes, because five panels answer five questions. Everything a builder
 * reads is produced here: the `state` word it branches on, the vocabulary it
 * words (`apiKey`, not the stored `manual`; `offered`, not the stored
 * `accepted`), and the shapes it draws (`labels` as names, not as rows).
 * `panels.build` hands what comes back STRAIGHT to a body builder and reshapes
 * nothing.
 *
 * That is the whole rule, and it is worth stating because breaking it is
 * silent: the panel half once re-derived `connected` from a `model.connection`
 * this function never produced, so `isConnected` was always false and the issue
 * list drew the "Connect Linear" card to a connected reader with no error
 * anywhere. One mapper cannot disagree with itself.
 */
async function viewFor(panelId, context) {
  const snapshot = model();
  const filters = snapshot.filters ?? {};

  if (panelId === "main") return {};

  if (panelId === "issues") {
    const connection = snapshot.connection;
    const groups = snapshot.groups ?? [];
    return {
      // The five bodies `panels/issues.js` draws, decided HERE and only here.
      // A reader with no credential gets the connect card rather than an empty
      // filter strip, which is the one state the panel half cannot work out
      // for itself: whether a credential exists is this half's fact.
      //
      // `connection === null` is NOT the same as "not connected": it means the
      // first read has not finished, and saying "Connect Linear" to somebody
      // whose credential is about to arrive is a worse answer than a spinner.
      state: connection == null
        ? "loading"
        : !connection.connected
          ? "disconnected"
          : snapshot.error
            ? "error"
            : snapshot.counts.issues === 0
              ? "empty"
              : "list",
      error: snapshot.error,
      groups,
      query: filters.text || null,
      title: "Linear",
      // `statePreset`, not the stored `stateTab`. The stored name is the one
      // the lead's contract fixed for `prefs:filters`; the builder reads the
      // other. Mapping at this boundary is cheaper than renaming a persisted
      // key that already exists on somebody's device.
      statePreset: filters.stateTab ?? "all",
      sort: filters.sort ?? "updated_desc",
      view: filters.view === "flat" ? "flat" : "grouped",
      viewerId: connection?.viewerId ?? null,
      assignedToMe: Boolean(filters.assigneeId && filters.assigneeId === connection?.viewerId),
      hasProjects: filters.hasProjects === true,
      hasPeople: filters.hasPeople === true,
      hasTeams: (snapshot.counts.teams ?? 0) > 1,
      teamKey: filters.teamKey || null,
      filtersActive: filtersActive(filters),
      workspace: connection?.organizationName ?? null,
      // The nav bar's Open-in-Linear destination. Built from the workspace's
      // own url key rather than from an issue's `url`, because this verb is
      // about the LIST: a page with nothing selected still has a workspace to
      // open. Absent until the identity read lands, and the builder then draws
      // two nav verbs instead of three rather than a link to nowhere.
      workspaceUrl: connection?.organizationUrlKey
        ? `https://linear.app/${connection.organizationUrlKey}`
        : null,
      age: ago(snapshot.updatedAt),
    };
  }

  if (panelId === "issue") {
    // Decided here for the same reason as the list's: no credential means the
    // connect card, not "that issue could not be found" for an issue that
    // exists in a workspace this machine has never been able to read. And a
    // connection not yet read is the loading body, not either of those.
    if (snapshot.connection == null) return { state: "loading" };
    if (!snapshot.connection.connected) return { state: "disconnected" };
    // `context` when the client sent one, the remembered issue when the panel
    // half republished with only a panel id. See `currentIssueId`.
    const issueId = context?.issueId ?? currentIssueId;
    const issue = issueId ? await data.issueRow(issueId) : null;
    if (!issue) {
      return { state: "detail", issue: null, error: snapshot.error ?? null };
    }
    const rows = await sdk.collections
      .list(COLLECTION_COMMENTS, { keyPrefix: commentKeyPrefix(issue.id), limit: 60 })
      .catch(() => []);
    return {
      state: "detail",
      // The row is passed with ONE field reshaped. `labels` is stored as
      // `{id, name, color}` because a binding's `where` compares fields, and
      // the detail panel draws a chip per NAME — so the panel half is handed
      // names and never learns the storage shape. Every other field of the row
      // is already the panel's.
      issue: { ...issue, labels: labelNames(issue.labels) },
      error: null,
      subIssues: issue.subIssues ?? [],
      // `{author, at, body}` — what `commentNodes` reads. The stored row also
      // carries the dressed list fields, and neither half has to know about
      // the other's names because the mapping is here.
      comments: rows
        .map((row) => row.value)
        .filter(Boolean)
        .map((comment) => ({
          author: comment.userDisplayName ?? comment.userName ?? null,
          at: comment.createdAt ?? null,
          body: comment.body ?? "",
        })),
      commentsState: "loaded",
      // The plugin stores at most `MAX_COMMENTS_PER_ISSUE`; a longer thread has
      // earlier comments only Linear can show.
      hasEarlierComments: rows.length >= 50,
    };
  }

  if (panelId === "launch") {
    const issueId = context?.issueId ?? currentLaunch?.issueId ?? null;
    const issue = issueId ? await data.issueRow(issueId) : null;
    if (!issue) return { state: "form", issue: null, error: "That issue is not in this project's Linear view." };
    // "Create lane only" and "Launch lane + agent" are one screen with the
    // agent half hidden, which is the phone's own flow. The flag reaches here
    // from the navigation context or from the press that opened the form.
    const laneOnly = context?.laneOnly === true || currentLaunch?.laneOnly === true;
    const models = (snapshot.models ?? []).map((entry) => ({ id: entry.value, label: entry.label }));
    return {
      state: "form",
      issue,
      // An empty list draws the form without the picker and the provider takes
      // its own default, which is the same launch one tap later rather than a
      // form that cannot submit.
      models,
      permissionModes: PERMISSION_MODES,
      reasoningEfforts: REASONING_EFFORTS,
      laneOnly,
      // `model`, the name the form's select reads. The picker opens on a real
      // choice rather than on its first option, which would silently be a
      // different model from the one the reader picked last time.
      model: models[0]?.id ?? null,
      // Absent, every select opens on its own first option, which is the same
      // default the provider would take — so `null` here is a choice, not a
      // hole.
      permissionMode: null,
      reasoningEffort: REASONING_EFFORT_DEFAULT,
      fastMode: false,
      sessionType: laneOnly ? "laneOnly" : "chat",
      // The two names derived from the issue, shown before the reader commits.
      // The branch is the one Linear matches on, so seeing it is the difference
      // between trusting the link and hoping for it.
      laneName: issueLaneName(issue),
      branchName: issueBranchName(issue),
      kickoff: flows.defaultKickoff(issue),
      fastModeSupported: false,
      error: null,
      unavailable: snapshot.connection?.connected ? null : "Connect Linear first.",
    };
  }

  if (panelId === "settings") {
    const connection = snapshot.connection;
    const settings = await sdk.config.get().catch(() => ({}));
    const status = await connect.connectStatus().catch(() => ({}));
    const secretStored = Boolean(await sdk.secrets.get("LINEAR_WEBHOOK_SECRET").catch(() => null));
    const webhooksPossible = webhooksReachable(status);
    const ledger = connection?.webhookUrl
      ? await sdk.webhooks.status().catch(() => null)
      : null;
    return {
      // Three bodies, and the third is real: before the first `refreshConnection`
      // there is no connection ROW at all, which is a different thing from a
      // machine that has read one and found no credential.
      state: connection == null ? "loading" : connection.connected ? "connected" : "disconnected",
      error: connection?.lastError ?? null,
      connection: connection
        ? {
          ...connection,
          // The builder words this as "OAuth" or "API key". The STORED
          // vocabulary is `oauth` | `manual`, which is what a stored credential
          // already says — so the rename happens here and nowhere else.
          authMode: connection.authMode === "manual" ? "apiKey" : connection.authMode,
          // Pre-formatted, because a schema cannot do date arithmetic.
          ...expiry(connection.tokenExpiresAt),
          oauthAvailable: status.canOAuth === true,
        }
        : null,
      settings,
      teams: (await data.teams().catch(() => [])).map((team) => ({ key: team.key, name: team.name })),
      showAutolinks: Boolean(connection?.organizationUrlKey),
      autolinks: (snapshot.autolinks ?? []).map((entry) => ({
        prefix: entry.keyPrefix,
        title: entry.title,
        description: entry.teamName,
        // Nothing reads back GitHub's existing autolinks yet, so every row
        // offers Create. Saying "configured" without checking would be worse
        // than offering a create that GitHub answers as already-existing.
        configured: false,
      })),
      githubRepo: githubRepoSlug,
      // `status` is the WEBHOOK row and `secretStored` drives a separate
      // Verification row beside it, so this must not be about the secret —
      // two adjacent rows saying the same thing in different words is worse
      // than one saying it well.
      //
      // It DOES have to be about whether events can arrive at all. Linear only
      // delivers data-change webhooks to an authorization carrying `admin`.
      // Both OAuth clients ask for it, but a personal API key carries no OAuth
      // grant of any kind — so on an API-key connection this endpoint is a URL
      // that will never be posted to. Saying "ready" there would be the same
      // failure the fail-closed copy exists to prevent.
      //
      // Nor may it say "ready" while the SECRET is missing. The manifest
      // declares `verify`, and the host fails closed on a channel whose secret
      // it cannot find — so with nothing stored, every delivery Linear sends is
      // dropped before this plugin sees it. "Endpoint ready" there was the
      // most misleading sentence on the screen: the endpoint exists, the
      // deliveries arrive, and none of them count.
      //
      // Whether deliveries are actually ARRIVING is the host's delivery ledger.
      // `webhooks.status` is that row, scoped to this plugin.
      ingress: connection?.webhookUrl
        ? {
          status: !webhooksPossible
            ? "Linear will not deliver to this connection"
            : secretStored
              ? "Endpoint ready"
              : "Waiting for the signing secret",
          tone: webhooksPossible && secretStored ? "neutral" : "warning",
          lastEvent: formatWebhookLastEvent(ledger?.lastReceivedAt),
          pendingDeliveries: Number(ledger?.pendingDeliveries) || 0,
          drainError: typeof ledger?.lastError === "string" && ledger.lastError.trim()
            ? ledger.lastError.trim()
            : null,
          url: connection.webhookUrl,
          secretStored,
          webhooksPossible,
        }
        : null,
      oauthBlockedReason: status.oauthBlockedReason ?? null,
    };
  }

  return snapshot;
}

/**
 * When the drain last received a delivery, as a line a settings row can print.
 *
 * The ledger stores ISO-8601. A schema cannot format dates, so this is the
 * same pre-format `expiry` does for the token.
 */
function formatWebhookLastEvent(iso) {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso.trim();
  return new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * The token's remaining life, pre-formatted.
 *
 * A schema has no date arithmetic, so "expires in 6 days" has to be a string by
 * the time it reaches a builder. An absent expiry is an API key or a token that
 * does not expire, and says nothing rather than "never".
 */
function expiry(tokenExpiresAt) {
  if (!tokenExpiresAt) return { expiresIn: null, expired: false };
  const at = Date.parse(String(tokenExpiresAt));
  if (Number.isNaN(at)) return { expiresIn: null, expired: false };
  const ms = at - Date.now();
  if (ms <= 0) return { expiresIn: "expired", expired: true };
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) return { expiresIn: `expires in ${days} ${days === 1 ? "day" : "days"}`, expired: false };
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return { expiresIn: `expires in ${hours} ${hours === 1 ? "hour" : "hours"}`, expired: false };
}

/**
 * Can a Linear webhook ever reach this connection?
 *
 * Linear delivers data-change webhooks only to an authorization carrying
 * `admin`, and BOTH OAuth clients ask for it — ADE's own registered app and a
 * client the user registered themselves (`connect.js:SCOPES_CUSTOM`). So the
 * test is not which app signed in; it is whether an OAuth grant exists at all.
 *
 * An API-key connection is the case that remains. A personal API key carries no
 * OAuth grant of any kind, so the reader can browse and write issues normally,
 * paste the relay URL into Linear, paste the signing secret — and never receive
 * one event. A webhook that never fires is indistinguishable from a workspace
 * where nothing happened, so every surface that reports on the ingress has to
 * say this, not just the panel.
 */
function webhooksReachable(status) {
  const source = status?.clientSource;
  return source === "official" || source === "custom";
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

/**
 * The whole issue read, then the two panels that show it.
 *
 * One function rather than three, because every entry point wants all of it —
 * the refresh gesture, the CLI word, the webhook that changed one issue, the
 * `activate` with nothing on screen — and a caller that refreshed the rows and
 * forgot the panel would leave the reader looking at a stale screen with fresh
 * data behind it.
 */
async function refreshIssues(options = {}) {
  if (!sdk || disposed) return { state: "loading" };
  const result = await data.refreshIssues(options);
  lastIssueRefreshAt = Date.now();
  await publish("issues");
  await publish("main");
  return result;
}

/** The rows, refreshed when they are older than the cache window. */
async function ensureIssues() {
  if (Date.now() - lastIssueRefreshAt > ISSUE_CACHE_MS) await refreshIssues();
}

/**
 * The chat models this project offers, for the launch form's picker.
 *
 * Best-effort: a project with no models configured draws the form without the
 * picker, and the provider picks its own default — which is the same launch one
 * tap later, not a failure.
 */
async function loadModels() {
  try {
    const listed = await sdk.actions.invoke("chat", "getAvailableModels", {});
    const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.models) ? listed.models : [];
    data.setModels(rows
      .map((entry) => (typeof entry === "string"
        ? { value: entry, label: entry }
        : { value: entry?.id ?? entry?.value ?? null, label: entry?.label ?? entry?.name ?? entry?.id ?? null }))
      .filter((entry) => entry.value && entry.label)
      .slice(0, 50));
  } catch (error) {
    log("debug", `Could not read the chat models: ${error?.message ?? error}`);
  }
}

/* ── Lane contributions ──────────────────────────────────────────────────── */

/**
 * The Linear badge on every lane that carries an issue.
 *
 * Published as a `row-badge` and a `graph-node`, which is how a lane row on the
 * desktop, on the phone and in the graph all draw the same thing without any of
 * them knowing what Linear is. Two socket KINDS on one surface, so each publish
 * names its `id` — a row keyed only by kind would let the second publish
 * replace the first.
 */
async function publishLaneBadges() {
  if (!sdk || disposed) return;
  const { rows } = await data.laneIndex();
  const byLane = new Map();
  for (const row of rows) {
    if (!byLane.has(row.laneId)) byLane.set(row.laneId, []);
    byLane.get(row.laneId).push(row);
  }
  for (const [laneId, links] of byLane) {
    const first = links[0];
    const stored = await data.issueRow(first.issueId);
    const payload = {
      id: "lane-issue",
      label: first.issueKey ?? stored?.identifier ?? "Linear",
      tone: stored?.badgeTone ?? "neutral",
      tooltip: stored?.title ?? null,
      url: stored?.url ?? null,
      count: links.length,
    };
    await sdk.contributions.publish("lane", laneId, "row-badge", payload).catch(() => {});
    await sdk.contributions.publish("lane", laneId, "graph-node", { ...payload, id: "graph-issue" }).catch(() => {});
  }
}

/* ── The adapter the panel half reaches ──────────────────────────────────── */

/**
 * The host object `panelActions.bind` is given.
 *
 * Every path in `panelActions.HOST_CAPABILITIES` is answered here, and the
 * argument shapes are the PANEL half's — positional ids where this half takes
 * option objects. A missing path is not an error over there (the reader gets
 * "that needs the plugin's data layer"), which is exactly why every one of them
 * is written out: a silently absent verb is a button that does nothing.
 */
function buildPanelHost() {
  return {
    publish,
    model,

    data: {
      /** The list's own refresh, and the "something changed" redraw. */
      reload: async () => await refreshIssues(),

      /**
       * A filter control moved.
       *
       * `{reset: true}` clears back to the defaults; anything else is merged.
       * Both re-read Linear, because the state preset changes which GROUPS
       * exist and a predicate cannot remove a section.
       *
       * The patch arrives keyed by PANEL STATE KEY — `state`, `project`,
       * `assignee`, `view` — because that is what a `segmented` control sends
       * back, and it is stored under the filter names `data.js` persists. This
       * is the inbound twin of `viewFor`, and it is the one place the rename
       * happens: `normalizeFilters` drops any key it does not know, so an
       * unmapped `state` was a state-tab control that moved and changed
       * nothing at all.
       */
      setFilters: async (patch) => {
        const next = patch?.reset === true
          ? await (async () => {
            await data.writeFilters(data.defaultFilters());
            return data.defaultFilters();
          })()
          : await data.updateFilters(storedFilterPatch(patch));
        await refreshIssues({ filters: next });
        return next;
      },

      /** The search box. An empty string is "clear", not "match nothing". */
      search: async (text) => {
        const next = await data.updateFilters({ text: typeof text === "string" ? text : "" });
        await refreshIssues({ filters: next });
        return next;
      },

      loadIssue: async (issueId) => {
        const result = await data.refreshIssue(issueId);
        await publish("issue", { issueId });
        if (!result.ok) throw new Error(result.error);
        return result.issue;
      },

      loadComments: async (issueId) => {
        const result = await data.refreshComments(issueId);
        await publish("issue", { issueId });
        return result;
      },
    },

    api: {
      setIssueState: async (issueId, stateId) => {
        await automation.updateIssueState({ issueId, stateId });
        await publish("issue", { issueId });
        await publish("issues");
      },
      setIssuePriority: async (issueId, priority) => {
        const row = await automation.resolveIssue(issueId);
        await api.updateIssuePriority(row.id, Number(priority));
        await data.refreshIssue(row.id, { comments: false });
        await publish("issue", { issueId: row.id });
        await publish("issues");
      },
      assignIssue: async (issueId, assigneeId) => {
        await automation.assignIssue({ issueId, assigneeId });
        await publish("issue", { issueId });
        await publish("issues");
      },
      createComment: async (issueId, body) => await automation.addComment({ issueId, body }),
    },

    flows: {
      /**
       * The two launch verbs.
       *
       * The panel sends `(issueId, args)` where `args` is the whole action
       * frame — a lane id when the reader pressed from inside one, and the
       * launch form's values when they came through the launch panel.
       */
      createLaneFromIssue: async (issueId, args) => {
        const result = await flows.createLaneFromIssue({
          issueId,
          ...(args?.baseRef ? { baseRef: args.baseRef } : {}),
        });
        if (!result.ok) throw new Error(result.message);
        await refreshIssues();
        return result;
      },

      spawnAgentOnIssue: async (issueId, args) => {
        const lane = await flows.createLaneFromIssue({
          issueId,
          ...(args?.baseRef ? { baseRef: args.baseRef } : {}),
        });
        if (!lane.ok) throw new Error(lane.message);
        const agent = await flows.spawnAgentOnIssue({
          issueId,
          laneId: lane.laneId,
          ...(args?.prompt ? { prompt: args.prompt } : {}),
          ...(args?.sessionType ? { sessionType: args.sessionType } : {}),
          ...(args?.provider ? { provider: args.provider } : {}),
          ...(args?.model ? { model: args.model } : {}),
          // Through `chosenReasoningEffort`, so the form's "Default" sentinel
          // becomes the absence of the field rather than a literal
          // `reasoningEffort: "default"` no provider knows.
          ...(chosenReasoningEffort(args?.reasoningEffort)
            ? { reasoningEffort: chosenReasoningEffort(args.reasoningEffort) }
            : {}),
          ...(args?.permissionMode ? { permissionMode: args.permissionMode } : {}),
          ...(typeof args?.fastMode === "boolean" ? { fastMode: args.fastMode } : {}),
        });
        // The LANE exists either way. Reporting only the agent's failure would
        // send the reader looking for work that has a branch waiting for it.
        if (!agent.ok) throw new Error(`Opened the lane, but could not start the agent: ${agent.message}`);
        await refreshIssues();
        return agent;
      },

      /** The bulk bar: attach several issues to a lane the reader picks. */
      linkIssueToLane: async (issueIds, laneId) => {
        // Through `issueIdFromRowKey` even though the panel half already
        // strips it. A tick carries the row's `key`, and a row that ever ships
        // without one inherits the COLLECTION key — `flat:000012:<uuid>` — so
        // the failure this guards is a lane named after a sort rank. Two
        // defences is the right number when the wrong id creates a lane.
        const ids = (Array.isArray(issueIds) ? issueIds : [issueIds])
          .map((entry) => issueIdFromRowKey(entry) ?? entry)
          .filter(Boolean);
        const chosen = typeof laneId === "string" && laneId.trim() ? laneId.trim() : null;
        if (!chosen) {
          const lanes = await sdk.lanes.list().catch(() => []);
          if (!Array.isArray(lanes) || lanes.length === 0) {
            throw new Error("Open a lane first.");
          }
          return {
            prompt: {
              id: PROMPT_LANE,
              title: COPY.linkLaneTitle,
              placeholder: COPY.linkLanePlaceholder,
              submitLabel: COPY.linkLaneSubmit,
              options: lanes.slice(0, LIMITS.maxSelectOptions).flatMap((lane) => {
                const value = lane && typeof lane === "object" ? String(lane.id ?? "").trim() : "";
                if (!value) return [];
                const label = String(lane.name ?? lane.title ?? value);
                return [{ value, label }];
              }),
            },
          };
        }
        for (const issueId of ids) {
          const result = await flows.linkIssueToLane({ issueId, laneId: chosen });
          if (!result.ok) throw new Error(result.message);
        }
        await refreshIssues();
        return { linked: ids.length };
      },

      /**
       * Draw the launch form for one issue.
       *
       * Its presence is what turns the two one-tap launch buttons into a form:
       * `panelActions.openLaunch` treats a missing `flows.openLaunch` as "this
       * build has no launch panel" and launches with the defaults instead. So
       * this and the manifest's `launch` panel go together, and neither is
       * useful without the other.
       */
      openLaunch: async (issueId, args) => {
        // The models are read lazily rather than at activate, because a project
        // that never opens the form should not pay for the round trip.
        if ((model().models ?? []).length === 0) await loadModels();
        const laneOnly = args?.laneOnly === true;
        await publish("launch", { issueId, laneOnly });
        return { issueId, laneOnly };
      },

      connectOAuth: async (origin) => {
        // The panel that was pressed names itself. It is the only half of this
        // that knows — `auth.completed` carries the flow and never the screen —
        // so the origin is recorded here, at the start, and read back at
        // completion rather than guessed then. See `connect.js:AUTH_ORIGINS`.
        const result = await connect.begin({ origin });
        if (!result.ok) throw new Error(result.message);
        // Returned verbatim so the host can fill in the live URL on the way to
        // whichever client the user is on.
        return { authSession: result.authSession };
      },

      connectApiKey: async (key) => {
        const result = await connect.saveApiKey(key);
        if (!result.ok) throw new Error(result.message);
        await refreshCatalogAndIssues();
        return result;
      },

      disconnect: async () => {
        const result = await connect.disconnect();
        await publish("issues");
        return result;
      },

      applySettings: async (values) => {
        const writable = {};
        for (const [key, value] of Object.entries(values ?? {})) {
          if (key === "moveToDoneOnMerge" || key === "moveToStartedOnLaunch") writable[key] = value === true;
          else if (key === "defaultTeamKey") writable[key] = typeof value === "string" ? value : null;
        }
        if (Object.keys(writable).length === 0) return {};
        return await sdk.config.set(writable);
      },

      createAutolink: async (prefix) => {
        const result = await flows.createAutolink({ teamKey: String(prefix ?? "").replace(/-$/, "") });
        if (!result.ok) throw new Error(result.message);
        return result;
      },
    },

    sdk: {
      clipboard: { write: async (text) => await sdk.clipboard.write(text) },
    },
  };
}

/* ── Lifecycle ───────────────────────────────────────────────────────────── */

exports.activate = async (ade) => {
  sdk = ade;
  disposed = false;

  api = createLinearApi({ secrets: sdk.secrets, log: (level, message) => log(level, message) });
  data = createData({ sdk, api, log: (level, message) => log(level, message) });
  flows = createFlows({ sdk, api, data, log: (level, message) => log(level, message) });
  connect = createConnect({ sdk, api, data, log: (level, message) => log(level, message) });
  automation = createAutomation({ api, data, flows, log: (level, message) => log(level, message) });
  webhook = createWebhookHandler({ sdk, data, log: (level, message) => log(level, message) });

  // The panel half is given everything it needs and nothing more. It reaches
  // this object by DOTTED PATH (`panelActions.HOST_CAPABILITIES`) and treats a
  // missing branch as "this host cannot do that yet" rather than as a crash —
  // which is why the adapter below is written out in full rather than passing
  // `data` and `flows` straight through. The argument shapes are the panel
  // half's, not this half's, and translating them here is the whole job of an
  // adapter: the two halves are allowed to disagree about what a verb's
  // arguments look like, and are not allowed to disagree silently.
  panelHandlers = panelActions.bind(buildPanelHost());
  Object.assign(exports.actions, panelHandlers, ownActions, pageActions);

  // A sign-in the host completed. Subscribed BEFORE anything can begin one, as
  // the SDK requires — a `beginSession` whose listener is not yet attached
  // would lose its own result.
  subscriptions.push(sdk.events.on("auth.completed", (payload) => {
    // RETURNED, though the host awaits nothing: the settle is the whole
    // observable effect of a sign-in, and a test that could not await it would
    // have to sleep on a chain that reaches Linear. The listener contract is
    // `void`, so handing one back costs the host nothing.
    return connect.complete(payload)
      .then(async (result) => {
        // A callback for another flow, or a late one from an attempt that was
        // cancelled and restarted: nothing began here, nobody is waiting on it,
        // and no panel changed.
        if (result?.ignored) return;
        await settleSignIn(result);
      })
      .catch((error) => log("warn", `Could not finish the Linear sign-in: ${error?.message ?? error}`));
  }));

  // A relay delivery is the only signal an issue nobody is watching ever gets.
  subscriptions.push(sdk.events.on("webhook.received", (payload) => {
    webhook.handle(payload)
      .then(async (result) => {
        // A duplicate changed nothing, so it costs no publish.
        if (result?.duplicate || result?.unreadable || result?.ignored) return;
        await publish("issues");
        await publishLaneBadges();
      })
      .catch((error) => log("warn", `Could not handle a Linear webhook: ${error?.message ?? error}`));
  }));

  // A lane that appeared or left changes which issues carry a `hasLane` badge.
  // `ensureIssues`, not `refreshIssues`: this fires on every lane change, and
  // the uncached read is up to three paginated GraphQL requests plus ~750
  // collection writes plus two publishes. `createLaneFromIssue` emits a lane
  // change AND refreshes directly, so one lane creation was paying for two full
  // reads. What actually changed here is which issues carry a lane badge, and
  // that is what the badge publish redraws.
  subscriptions.push(sdk.events.on("lane.changed", () => {
    void ensureIssues().then(() => publishLaneBadges()).catch(() => {});
  }));

  // The merged-PR transition. The WHOLE payload goes through, not just `ids`:
  // `pr.changed` now carries `transitions` when the host's producer knew where
  // each PR moved from, which is the same previous state core's own merge
  // handling reads. See `flows.mergedLanesFromPrIds` for the fallback when it
  // does not.
  subscriptions.push(sdk.events.on("pr.changed", (payload) => {
    void (async () => {
      try {
        const laneIds = await flows.mergedLanesFromPrIds(payload ?? { ids: [] });
        if (laneIds.length === 0) return;
        const result = await flows.closeIssueOnMerge({ laneIds });
        if (result.moved > 0) await refreshIssues();
      } catch (error) {
        log("warn", `Could not act on a merged pull request: ${error?.message ?? error}`);
      }
    })();
  }));

  // STARTED, not awaited. The bootstrap sends `ready` only once `activate`
  // resolves, and the host gives it 20 s: the first read is up to three
  // paginated GraphQL requests over a network this machine does not control,
  // and `publishSchema` alone retries five times three seconds apart while no
  // project is attached. Awaiting either one here spent the whole deadline and
  // restarted the plugin for a reason no log line named as slowness.
  firstReadPromise = firstRead();
  void firstReadPromise;
};

/**
 * The first publish and the first Linear read, as one chain nothing awaits.
 *
 * The `finally` is the contract: every exit from this chain republishes the two
 * panels that carry a loading card. `refreshCatalogAndIssues` rejects whenever
 * a collection write throws — a full store, a budget refusal — and it rejects
 * BEFORE its own `publish("issues")`, so the seeded "Loading Linear issues…"
 * card used to stand until the reader pressed Refresh. A loading card is never
 * left standing without a republish behind it.
 */
async function firstRead() {
  // In parallel with the read, because the launch form is the only panel that
  // reads the model list and nothing on the way to the issue list waits on it.
  // `loadModels` swallows its own failure, so this cannot reject.
  const models = loadModels();
  try {
    await publish("main");
    await refreshCatalogAndIssues();
  } catch (error) {
    log("warn", `The first Linear read failed: ${error?.message ?? error}`);
  } finally {
    await publish("issues");
    await publish("main");
    await models;
  }
}

/**
 * The connection, then the near-static catalog, then the issues.
 *
 * In that order and not in parallel: the catalog read tells the connection
 * whether the credential actually works, and the issue read is the expensive
 * one that must not be spent on a credential Linear is going to refuse.
 */
async function refreshCatalogAndIssues() {
  const connection = await data.refreshConnection();
  await publish("settings");
  if (!connection?.connected) {
    await publish("issues");
    await publish("main");
    return { state: "no-token" };
  }
  await data.refreshCatalog(null).catch(() => {});
  await data.buildAutolinks(connection.organizationUrlKey ?? null).catch(() => {});
  // Through `flows.githubRepo`, which is the same read: this half had its own
  // copy that parsed a narrower set of result fields, so the two disagreed
  // about a host that answers `{originRemote}` and the autolink card said "no
  // repo" for a project that plainly had one.
  const repo = await flows.githubRepo().catch(() => null);
  githubRepoSlug = repo ? `${repo.owner}/${repo.name}` : null;
  const result = await refreshIssues();
  await publishLaneBadges().catch(() => {});
  return result;
}

/**
 * Put the screens back after a sign-in ends, however it ended.
 *
 * Two things had to be true here and only one was.
 *
 * **The connected state and the list have to land TOGETHER.** This used to
 * publish only `settings`, and to publish it AFTER an unguarded
 * `refreshCatalogAndIssues`. That call rejects whenever a Linear read or a
 * collection write throws, and it rejects before its own publishes — so a
 * reader who had just signed in successfully was left looking at the "Connect
 * Linear" card, with the connection working and nothing on screen saying so.
 * The issues appeared only when they left the tab and came back, because a
 * fresh visit re-reads a panel this handler never wrote. The refresh is now
 * inside a `try` and the republish is its `finally`: both panels are written on
 * every path out of a sign-in, successful or not.
 *
 * **The reader has to end up where they started.** The origin was recorded when
 * the flow began (`connect.js:AUTH_ORIGINS`) rather than guessed now, and it
 * decides which panel is written LAST — the one the reader is looking at is the
 * freshest write, and on the `issue` origin the detail panel is republished too,
 * which nothing else here would have redrawn.
 *
 * What this cannot do is MOVE them. A plugin's only navigation verb is
 * `{navigate}` on an action result, and by the time a sign-in completes the
 * action that started it has long since returned; the SDK has no push-navigation
 * outside that result, so a reader whose client walked them to the settings
 * panel is put back by the host or not at all. See the delivery note.
 */
async function settleSignIn(result) {
  const origin = normalizeAuthOrigin(result?.origin);
  try {
    if (result?.ok) await refreshCatalogAndIssues();
  } finally {
    // `main` too: it is the panel a client that does not own this plugin draws,
    // and a sign-in changes what it says. The origin goes last, on its own.
    for (const panelId of ["settings", "issues", "main"]) {
      if (panelId !== origin) await publish(panelId);
    }
    await publish(origin);
  }
}

exports.deactivate = async () => {
  disposed = true;
  while (subscriptions.length) {
    try {
      subscriptions.pop()?.();
    } catch { /* an unsubscribe that throws is not worth a crash on the way out */ }
  }
  await connect?.cancel().catch(() => {});
  currentIssueId = null;
  currentLaunch = null;
  sdk = null;
  api = null;
  data = null;
  flows = null;
  connect = null;
  automation = null;
  webhook = null;
};


/* ── Actions ─────────────────────────────────────────────────────────────── */

/**
 * The handlers the MANIFEST dispatches, from the file that holds them.
 *
 * Built at LOAD, with `deps` reading this module's live bindings through
 * getters: they are null until `activate` runs, and a table that captured them
 * by value would capture the null. See `actions.js`.
 */
const ownActions = createOwnActions({
  get sdk() { return sdk; },
  get data() { return data; },
  get flows() { return flows; },
  get connect() { return connect; },
  get automation() { return automation; },
  publish,
  refreshIssues,
  ensureIssues,
  webhooksReachable,
  issueIdFromRowKey,
});

/**
 * The handlers the plugin's own HTML PAGE invokes over the webview bridge.
 *
 * The third table, built at LOAD for the same reason as `ownActions` and with
 * the same live-getter `deps`: a page is a webview the reader can open the
 * instant the tab is drawn, which is well before `activate`'s first Linear read
 * has settled. A page that got "no such action" there would draw its empty
 * state and stay there.
 *
 * `api` is in this frame and not in `ownActions`'s, because the page reads four
 * things no collection holds — the viewer's profile, the workspace's projects
 * and members, and a page of search results that has nothing to do with the
 * reader's stored filter. See `pageActions.js`.
 */
const pageActions = createPageActions({
  get sdk() { return sdk; },
  get api() { return api; },
  get data() { return data; },
  get flows() { return flows; },
  get connect() { return connect; },
  get automation() { return automation; },
  publish,
  refreshIssues,
  refreshCatalogAndIssues,
  ensureIssues,
  webhooksReachable,
  chosenReasoningEffort,
  issueIdFromRowKey,
});

/**
 * The action table the host dispatches into.
 *
 * Seeded at LOAD with this half's own handlers and the page's, so every id the
 * manifest declares — the nine tools, the four steps, the search provider, the
 * CLI word — and every id the page can invoke resolves before `activate` has
 * run. The panel half's handlers need a bound host and are merged in at
 * activate.
 *
 * The three tables are DISJOINT: no id is defined by two of them, and
 * `test/index.test.js` asserts it. That is the invariant, and it replaced a
 * merge order — `ownActions` re-applied last, so a collision silently resolved
 * this way — that hid three dead handlers behind live-looking code. `ownActions`
 * is still applied last, but now only as a belt on a table with no collisions
 * in it rather than as the thing that decides which copy runs.
 *
 * `saveWebhookSecret` is the one id the page shares with another half, and it
 * shares it by INVOKING the existing one rather than by defining a second copy:
 * `actions.js` owns it, the page's `saveWebhookSecret()` calls that id, and a
 * `pageSaveWebhookSecret` beside it would be two ways to write one secret.
 */
exports.actions = { ...ownActions, ...pageActions };

// Exported for the host-level install test and for `test/`, which drive the
// lifecycle without a running daemon.
exports.__internals = {
  ISSUE_CACHE_MS,
  chosenReasoningEffort,
  expiry,
  ownActions,
  pageActions,
  webhooksReachable,
  publish,
  refreshCatalogAndIssues,
  refreshIssues,
  settleSignIn,
  /** The first read `activate` started, for a test that must not race it. */
  firstRead: () => firstReadPromise,
};
