// The five panel schemas of ade-linear, built on this machine.
//
// This module is the whole seam between the plugin's data half and its
// renderers. `index.js:viewFor` assembles one plain object — the VIEW — and
// this dispatches it to a builder; every sentence a reader sees, on the
// desktop, in the web client, on the phone and in the terminal, comes out of
// this call. There is no second renderer anywhere, which is the point of the
// vocabulary.
//
// ## The view
//
// One object per panel, read-only, assembled by `index.js` before any builder
// runs. No builder calls the SDK, awaits anything, or reads a clock: a builder
// is a pure function of its view, so a panel can be rendered in a test with no
// plugin host and the same bytes come out.
//
// A view is per-PANEL and flat. There is no shared model with a `connection`
// branch every builder digs into: the issue list is handed `{state, groups,
// statePreset, …}` and the settings panel is handed `{state, connection,
// settings, …}`, each already in the words its builder reads.
//
// ## Why this module maps nothing
//
// It used to. `buildIssuesPanel` re-derived `connected`, the filters and the
// error from a `model.connection` that `viewFor` never produced — so
// `isConnected` was always false and a connected reader got the "Connect
// Linear" card, with no error anywhere to say why. Two mappings for one seam
// is a bug that cannot be caught by reading either half on its own.
//
// So: `viewFor` decides, this dispatches. Every case below passes its input
// straight through. If a builder needs a field, it is `viewFor`'s job to
// produce it — never this module's job to invent it from something adjacent.

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
const { buildIssuePanel } = require("./panels/issue");
const { buildIssuesPanel } = require("./panels/issues");
const { buildLaunchPanel } = require("./panels/launch");
const { buildSettingsPanel } = require("./panels/settings");

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
 * The one entry point `index.js` publishes through.
 *
 * A dispatcher rather than five imports, because the caller is a loop: every
 * publish site names a panel id it already holds — a `refreshAction`, a
 * `{navigate}` destination, a webhook that changed one issue — and asking it to
 * map that id back to a function would put the same switch in the caller, once
 * per call site, with nothing keeping the copies in step.
 *
 * Each case hands `view` to its builder unchanged. `main` takes none: its
 * schema is a file.
 *
 * An id this module does not know returns `null` rather than throwing. A plugin
 * publishing a panel the manifest never declared is a bug in the plugin, and the
 * host refuses it anyway (`pluginSdkServer.ts:876`) — but it is not a bug worth
 * taking the child process down for, and a caller that gets `null` can log which
 * id it asked for, which an exception from inside a builder cannot.
 */
function build(panelId, view = {}) {
  switch (panelId) {
    case PANEL_ISSUES:
      return buildIssuesPanel(view);
    case PANEL_ISSUE:
      return buildIssuePanel(view);
    case PANEL_SETTINGS:
      return buildSettingsPanel(view);
    case PANEL_MAIN:
      return buildMainPanel();
    case PANEL_LAUNCH:
      return buildLaunchPanel(view);
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
};
