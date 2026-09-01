// The four panel schemas of ade-linear, built on this machine.
//
// This module is the whole seam between the plugin's data half and its four
// renderers. `index.js` assembles one plain object — the MODEL — and calls a
// builder here; every sentence a reader sees, on the desktop, in the web
// client, on the phone and in the terminal, comes out of this call. There is no
// second renderer anywhere, which is the point of the vocabulary.
//
// ## The model
//
// One object, read-only, assembled by `index.js` before any builder runs. No
// builder calls the SDK, awaits anything, or reads a clock: a builder is a pure
// function of the model, so a panel can be rendered in a test with no plugin
// host and the same bytes come out.
//
// ```js
// {
//   connection: {
//     connected, authMode: "oauth"|"apiKey", viewerId, viewerName,
//     organizationName, organizationUrlKey, organizationLogoUrl,
//     expiresIn, expired, handoffStatus: "offered"|"taken"|"declined"|null,
//     webhookUrl, lastError, lastSyncAt, issueCount, oauthAvailable,
//   },
//   filters: {
//     statePreset: "all"|"active"|"backlog", sort, view: "grouped"|"flat",
//     text, projectId, assigneeId, priority, updated,
//     hasProjects, hasPeople, hasTeams,
//   },
//   groups: [{ stateId, stateName, stateType, count, defaultOpen }],
//   teams:  [{ key, name }],
//   settings: { moveToDoneOnMerge, moveToStartedOnLaunch, defaultTeamKey },
//   issue, subIssues, comments, commentsState, hasEarlierComments,
//   ingress, autolinks, githubRepo, showAutolinks,
//   lanes, models, loading, error, updatedAt, updatedAgo,
// }
// ```
//
// Every field is optional. A builder handed `{}` returns a valid panel that
// says it is loading — which is what a panel published before the first fetch
// returns actually IS, and is better than a builder that throws inside the
// plugin host and leaves the reader on a stale screen.
//
// ## Why the state of a panel is computed here and not in a builder
//
// Each builder takes a `state` word and draws one of its bodies. Deciding that
// word from the model — is this loading, disconnected, broken, empty, or a list
// — is one rule that must read the same for all four panels, so it lives here
// once rather than being re-derived in each builder from a different set of
// fields.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  PANEL_ISSUE,
  PANEL_ISSUES,
  PANEL_LAUNCH,
  PANEL_MAIN,
  PANEL_SETTINGS,
} = require("./panels/contract");
const { buildIssuePanel: buildIssueBody } = require("./panels/issue");
const { buildIssuesPanel: buildIssuesBody } = require("./panels/issues");
const { buildLaunchPanel: buildLaunchBody } = require("./panels/launch");
const { buildSettingsPanel: buildSettingsBody } = require("./panels/settings");

/**
 * The gating panel, read from disk exactly as the manifest declares it.
 *
 * `panels/main.json` is what a client draws when this plugin is not the one
 * holding the connection — a phone attached to a project whose computer has the
 * plugin, a remote runtime. It is deliberately never rebuilt: the manifest
 * already ships it as this panel's `schemaFile`, so building a second copy in
 * code would be two sources for one screen and a chance for them to disagree.
 */
const MAIN_PANEL_PATH = path.join(__dirname, "panels", "main.json");

/** Read once. The file ships inside the package and cannot change under us. */
let mainPanelCache = null;

/* ── Reading the model ──────────────────────────────────────────────────── */

function connectionOf(model) {
  const connection = model && typeof model === "object" ? model.connection : null;
  return connection && typeof connection === "object" ? connection : {};
}

/**
 * The filters, read under either spelling the data half uses.
 *
 * `data.js` calls the state preset `stateTab`, after the built-in's tab strip;
 * the builders call it `statePreset`, after what it selects. Neither name is
 * wrong and both halves are being written at once, so this reads both rather
 * than making the primary filter of the whole panel depend on which of us
 * renamed first — a mismatch there would silently pin the list to "All issues"
 * with no error anywhere.
 *
 * The same for `hasTeams`, which `index.js` computes beside the filters rather
 * than inside them.
 */
function filtersOf(model) {
  const source = model && typeof model === "object" ? model : {};
  const filters = source.filters && typeof source.filters === "object" ? source.filters : {};
  return {
    ...filters,
    statePreset: filters.statePreset ?? filters.stateTab ?? "all",
    hasTeams: filters.hasTeams ?? source.hasTeams ?? false,
  };
}

function isConnected(model) {
  return connectionOf(model).connected === true;
}

function errorOf(model) {
  const error = model && typeof model === "object" ? model.error : null;
  return typeof error === "string" && error.trim() ? error.trim() : null;
}

/**
 * Whether any filter is away from its unset value.
 *
 * Read from the model rather than from panel state, because panel state belongs
 * to the client and this plugin never sees it. It decides one thing: whether the
 * list offers `Reset filters`, which is the desktop's own button and which is
 * pointless when there is nothing to reset.
 */
function filtersActive(filters) {
  return Boolean(
    (filters.statePreset && filters.statePreset !== "all") ||
      filters.projectId ||
      filters.assigneeId ||
      (filters.priority !== undefined && filters.priority !== null && filters.priority !== "") ||
      filters.updated ||
      (filters.sort && filters.sort !== "updated_desc") ||
      filters.text,
  );
}

/* ── The four panels ────────────────────────────────────────────────────── */

/**
 * The issue list.
 *
 * Note what is NOT in the input: the rows. Every issue a reader sees arrives
 * through a collection BINDING, so this schema is the same handful of bytes
 * whether the workspace holds nine issues or nine hundred, and re-publishing it
 * after a filter change moves no issue data at all.
 */
function buildIssuesPanel(model = {}) {
  const filters = filtersOf(model);
  const connection = connectionOf(model);
  const groups = Array.isArray(model.groups) ? model.groups : [];
  const error = errorOf(model);

  const state = !isConnected(model)
    ? "disconnected"
    : error
      ? "error"
      : model.loading && groups.length === 0
        ? "loading"
        : "list";

  return buildIssuesBody({
    state,
    error,
    groups,
    query: filters.text ?? null,
    statePreset: filters.statePreset,
    sort: filters.sort ?? "updated_desc",
    view: filters.view === "flat" ? "flat" : "grouped",
    filtersActive: filtersActive(filters),
    assignedToMe: Boolean(connection.viewerId && filters.assigneeId === connection.viewerId),
    viewerId: connection.viewerId ?? null,
    hasProjects: filters.hasProjects === true,
    hasPeople: filters.hasPeople === true,
    hasTeams: filters.hasTeams === true,
    workspace: connection.organizationName ?? null,
    age: model.updatedAgo ?? null,
    title: "Linear",
  });
}

/**
 * One issue in full.
 *
 * `context` is the `{navigate: {context}}` the row's press carried, and it
 * reaches the panel as `$context` too. It is read here only as a cross-check: a
 * model carrying a different issue than the one the reader navigated to means
 * the fetch has not landed yet, and the honest answer is the loading body rather
 * than the previous issue's words under this issue's title.
 */
function buildIssuePanel(model = {}, context = null) {
  const issue = model && typeof model === "object" ? model.issue : null;
  const wanted = context && typeof context === "object" ? context.issueId : null;
  const error = errorOf(model);

  if (!isConnected(model)) {
    return buildIssuesBody({ state: "disconnected", title: "Issue" });
  }

  const stale = Boolean(wanted && issue && String(issue.id) !== String(wanted) && String(issue.identifier) !== String(wanted));

  if (model.loading && (!issue || stale)) {
    return buildIssueBody({ state: "loading" });
  }

  return buildIssueBody({
    state: "detail",
    issue: stale ? null : (issue ?? null),
    error,
    subIssues: Array.isArray(model.subIssues) ? model.subIssues : [],
    comments: Array.isArray(model.comments) ? model.comments : [],
    commentsState: model.commentsState ?? "loaded",
    hasEarlierComments: model.hasEarlierComments === true,
  });
}

/**
 * The connection, the preferences and the two things a connection turns on.
 *
 * One panel for the desktop settings section AND the phone's connection screen,
 * because the phone draws no `settings-section` socket at all — see the module
 * comment in `panels/settings.js`.
 */
function buildSettingsPanel(model = {}) {
  const connection = connectionOf(model);
  const error = errorOf(model);

  const state = model.loading && connection.connected === undefined
    ? "loading"
    : connection.connected === true
      ? "connected"
      : "disconnected";

  return buildSettingsBody({
    state,
    error,
    connection,
    handoffStatus: connection.handoffStatus ?? null,
    settings: model.settings ?? {},
    teams: Array.isArray(model.teams) ? model.teams : [],
    showAutolinks: model.showAutolinks === true,
    autolinks: Array.isArray(model.autolinks) ? model.autolinks : [],
    githubRepo: model.githubRepo ?? null,
    ingress: model.ingress ?? null,
    // Read at the TOP level first, because that is where it survives being
    // disconnected: the view sends `connection: null` when there is no
    // credential, and the pre-sign-in warning is the one that matters most —
    // it is the difference between choosing a custom Linear app knowingly and
    // discovering weeks later that no webhook ever fired. The copy on
    // `connection` is the fallback for a connected reader.
    clientSource: model.clientSource ?? connection.clientSource ?? null,
    // A sibling of `connection` in the view, not a field of it: it is a fact
    // about this MACHINE's ability to run the flow, not about the connection
    // that does not exist yet.
    oauthBlockedReason: model.oauthBlockedReason ?? null,
  });
}

/**
 * The gating panel, verbatim.
 *
 * Returns a fresh parse each call rather than the cached object, so a caller
 * that mutates what it publishes cannot corrupt the next reader's copy. The
 * file is a few hundred bytes; re-parsing it is not a cost worth a bug.
 */
function buildMainPanel() {
  if (mainPanelCache === null) {
    mainPanelCache = fs.readFileSync(MAIN_PANEL_PATH, "utf8");
  }
  return JSON.parse(mainPanelCache);
}

/**
 * The launch form. Inert until the manifest declares a `launch` panel.
 *
 * Built and exported because the phone's `LinearLaunchScreen` is five parity
 * rows on its own — the session type, the model picker, the permission mode,
 * the reasoning effort and the kickoff prompt — and none of them survives being
 * folded into a bare "Launch lane + agent" button. `index.js` mounts it the day
 * `plugin.json` gains the panel; until then nothing navigates to it and it costs
 * the package one unreferenced module. See `panels/contract.js:PANEL_LAUNCH`.
 */
function buildLaunchPanel(model = {}) {
  return buildLaunchBody({
    // `state` when the data half declares one, `loading` when it does not. The
    // two halves were written at once and the view arrives spelled either way;
    // reading only one of them would have shown a spinner over a ready form, or
    // a form over an issue that had not arrived.
    state: model.state ?? (model.loading ? "loading" : "form"),
    issue: model.issue ?? null,
    models: Array.isArray(model.models) ? model.models : [],
    permissionModes: Array.isArray(model.permissionModes) ? model.permissionModes : [],
    reasoningEfforts: Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [],
    laneOnly: model.laneOnly === true,
    sessionType: model.sessionType ?? "chat",
    laneName: model.laneName ?? "",
    branchName: model.branchName ?? null,
    kickoff: model.kickoff ?? "",
    // The reader's stored choice, under either name. Absent, every select opens
    // on its first option — which is a different model from the one they picked
    // last time, silently.
    model: model.selectedModel ?? model.model ?? null,
    permissionMode: model.permissionMode ?? null,
    reasoningEffort: model.reasoningEffort ?? null,
    fastModeSupported: model.fastModeSupported === true,
    fastMode: model.fastMode === true,
    error: errorOf(model),
    unavailable: model.unavailable ?? null,
  });
}

/**
 * The one entry point `index.js` publishes through.
 *
 * A dispatcher rather than five imports, because the caller is a loop: every
 * publish site names a panel id it already holds — a `refreshAction`, a
 * `{navigate}` destination, a webhook that changed one issue — and asking it to
 * map that id back to a function would put the same switch in the caller, once
 * per call site, with nothing keeping the copies in step.
 *
 * An id this module does not know returns `null` rather than throwing. A plugin
 * publishing a panel the manifest never declared is a bug in the plugin, and the
 * host refuses it anyway (`pluginSdkServer.ts:876`) — but it is not a bug worth
 * taking the child process down for, and a caller that gets `null` can log which
 * id it asked for, which an exception from inside a builder cannot.
 */
function build(panelId, model = {}, context = null) {
  switch (panelId) {
    case PANEL_ISSUES:
      return buildIssuesPanel(model);
    case PANEL_ISSUE:
      return buildIssuePanel(model, context);
    case PANEL_SETTINGS:
      return buildSettingsPanel(model);
    case PANEL_MAIN:
      return buildMainPanel();
    case PANEL_LAUNCH:
      return buildLaunchPanel(model);
    default:
      return null;
  }
}

module.exports = {
  MAIN_PANEL_PATH,
  build,
  buildIssuePanel,
  buildIssuesPanel,
  buildLaunchPanel,
  buildMainPanel,
  buildSettingsPanel,
  filtersActive,
};
