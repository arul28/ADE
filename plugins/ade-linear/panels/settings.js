// Connecting Linear, and everything the connection then decides.
//
// This is `LinearSection.tsx` — the desktop settings section — plus
// `LinearConnectionScreen.swift`, which is the same screen the phone reaches
// from inside the pane. Those two are one panel here, for a reason worth
// stating: `settings-section` is a socket the phone does not draw at all
// (`sockets.ts:266`), so a plugin that put its connection flow only there would
// have no way for a phone reader to sign in. Declaring it as a PANEL of the
// plugin's own pane, and mounting that same panel into desktop Settings through
// the socket, is what makes the flow reachable on both.
//
// ## What is different from the built-in, and why
//
// ADE brokers the AUTHORIZATION and the plugin holds the credential. There is
// no `linear` provider key (`manifest.ts:489`), so this plugin cannot read the
// token ADE already has — except once, through the credential handoff, which is
// the release-day verb: on the day this plugin replaces the compiled
// integration, every user who already had Linear connected is offered the
// connection they already have rather than being asked to sign in again. A
// declined handoff is not an error; the ordinary sign-in is still there and the
// copy says so.
//
// ## Why the preferences are a form and not a strip of controls
//
// Every field below writes a key `plugin.json` declares under `settings`. A
// field naming anything else would be a control that moves and changes nothing,
// because `config.set` writes the manifest's keys and drops the rest — so this
// file and the manifest's `settings` block are one contract, checked by
// `panels.settings.test.js`.

"use strict";

const { ACTIONS } = require("./contract");

const { COPY, DEEPLINK_SETTINGS, LIMITS, fallback, label, prose, value } = require("./common");

const LINEAR_API_SETTINGS_URL = "https://linear.app/settings/api";

/**
 * The setting keys `plugin.json` declares. Spelled once, so a renamed key
 * breaks a test rather than a reader's toggle.
 */
const SETTING_MOVE_ON_MERGE = "moveToDoneOnMerge";
const SETTING_MOVE_ON_LAUNCH = "moveToStartedOnLaunch";
const SETTING_DEFAULT_TEAM = "defaultTeamKey";

/**
 * The card a connected reader sees.
 *
 * Every line here is the desktop section's, in its order: the heading, the
 * one-line identity sentence it assembles from four optional parts, and the
 * workspace footnote that explains the thing people get wrong — that the
 * workspace follows Linear's own selection rather than being picked here.
 */
function connectedCard(connection = {}) {
  const body = [];

  if (connection.organizationLogoUrl) {
    body.push({
      component: "image",
      src: String(connection.organizationLogoUrl),
      alt: label(`${connection.organizationName ?? "Linear"} workspace logo`),
      maxHeight: 48,
    });
  }

  body.push({ component: "text", variant: "title", text: COPY.connectedTitle });

  // The identity sentence, assembled here rather than in the schema: rule 3
  // forbids interpolation, so the plugin writes the finished words.
  const parts = [connection.viewerName ? `Signed in as ${connection.viewerName}` : "Signed in"];
  if (connection.authMode) parts.push(` via ${connection.authMode === "oauth" ? "OAuth" : "API key"}`);
  if (connection.organizationName) parts.push(` · ${connection.organizationName}`);
  if (connection.issueCount) {
    parts.push(` · ${connection.issueCount} issue${connection.issueCount === 1 ? "" : "s"}`);
  }
  body.push({ component: "text", variant: "caption", text: value(parts.join("")) });

  const rows = [];
  if (connection.organizationName) rows.push({ key: COPY.workspace, value: value(connection.organizationName) });
  if (connection.organizationUrlKey) {
    rows.push({ key: COPY.workspaceKey, value: value(connection.organizationUrlKey) });
  }
  if (connection.viewerName) rows.push({ key: COPY.signedInAs, value: value(connection.viewerName) });
  if (connection.authMode) {
    rows.push({ key: COPY.signInMethod, value: connection.authMode === "oauth" ? "OAuth" : "API key" });
  }
  // `expiresIn` is pre-formatted by the plugin ("expires in 6 days") because a
  // schema cannot do date arithmetic. Amber when it has run out, which is the
  // loudest a plugin gets — there is no red tone anywhere a plugin reaches.
  if (connection.expiresIn) {
    rows.push({
      key: COPY.token,
      value: value(connection.expiresIn),
      tone: connection.expired ? "warning" : "neutral",
    });
  }
  if (connection.lastSyncAt) rows.push({ key: "Last read", value: value(connection.lastSyncAt) });
  if (rows.length > 0) body.push({ component: "keyValue", rows });

  if (connection.lastError) {
    body.push({ component: "text", variant: "caption", tone: "warning", text: prose(connection.lastError) });
  }

  const buttons = [];
  if (connection.oauthAvailable !== false) {
    buttons.push({
      component: "button",
      label: COPY.reconnect,
      icon: "plug",
      onPress: { action: ACTIONS.connectOAuth },
    });
  }
  buttons.push({
    component: "button",
    label: COPY.disconnect,
    kind: "quiet",
    icon: "lock",
    // One sentence, and it names the blast radius: the credential is this
    // plugin's and it is stored per machine, so disconnecting here is not the
    // same act as disconnecting in Linear.
    onPress: { action: ACTIONS.disconnect, confirm: COPY.disconnectConfirm },
  });
  body.push({ component: "stack", direction: "horizontal", gap: "sm", wrap: true, children: buttons });

  body.push({ component: "text", variant: "caption", text: COPY.switchWorkspace });

  return body;
}

/**
 * The card a disconnected reader sees: three ways in, in the honest order.
 *
 * The handoff goes first when it is available, because for an existing user it
 * is the one that costs them nothing. It is offered ONCE per install — after an
 * answer the same call returns that answer without asking again — so a panel
 * that kept drawing the button after a decline would be a button that does
 * nothing, and the plugin stops passing `handoffStatus: "offered"`.
 *
 * The API key is a `form` with a `secret` field rather than a `{prompt}`. A
 * prompt is one plain text field on every client, and a credential typed into a
 * plain field is a credential on screen — the built-in uses a password input on
 * the desktop and a `SecureField` on the phone, and `secret` is the vocabulary's
 * name for exactly that.
 */
function disconnectCard(input = {}) {
  const body = [
    {
      component: "emptyState",
      title: COPY.connectTitle,
      description: COPY.connectBody,
      icon: "plug",
      action: { label: COPY.connectAction, onPress: { action: ACTIONS.connectOAuth } },
    },
    { component: "text", variant: "caption", text: COPY.connectOauthBody },
  ];

  if (input.handoffStatus === "offered") {
    body.push({
      component: "text",
      variant: "caption",
      text: prose(
        "ADE already holds a Linear connection for this machine. You can hand it to this plugin instead of signing in again — ADE will ask you first, and name exactly what moves.",
      ),
    });
    body.push({
      component: "button",
      label: "Use the connection ADE already has",
      kind: "primary",
      icon: "key",
      onPress: { action: ACTIONS.adoptHandoff },
    });
  }

  body.push({ component: "divider", label: COPY.apiKeyHeading });
  body.push({ component: "text", variant: "caption", text: COPY.apiKeyBody });
  body.push({
    component: "form",
    fields: [
      {
        kind: "secret",
        id: "apiKey",
        label: COPY.apiKeyLabel,
        placeholder: COPY.apiKeyPlaceholder,
        help: COPY.apiKeyHelp,
      },
    ],
    submit: { label: COPY.connect, onPress: { action: ACTIONS.connectApiKey } },
  });
  body.push({
    component: "button",
    label: COPY.createKey,
    kind: "quiet",
    icon: "link",
    onPress: { action: ACTIONS.openInLinear, args: { url: LINEAR_API_SETTINGS_URL } },
  });

  return body;
}

/**
 * The preferences a connected reader can change, with no Apply button.
 *
 * `applyOnChange` is the settings shape: a toggle commits the moment it moves,
 * a select the moment it changes, and a text field on blur — so the plugin is
 * never invoked once per keystroke and the reader never hunts for a Save.
 * Written as a `form` rather than as a strip of `segmented` controls because
 * the form is what carries the field labels, the help text and a real boolean —
 * and because a `segmented` would spend a panel state key on a value that is
 * stored rather than viewed.
 *
 * Every id below is a key in `plugin.json`'s `settings`. The built-in Linear
 * integration has NO preferences on either surface, so this whole block is an
 * addition rather than a port, and the parity report says so.
 */
function preferencesForm(input = {}) {
  const settings = input.settings ?? {};
  const teams = Array.isArray(input.teams) ? input.teams : [];

  const fields = [
    {
      kind: "toggle",
      id: SETTING_MOVE_ON_LAUNCH,
      label: "Move the issue to In Progress when an agent starts on it",
      help: "Uses the team's first started workflow state.",
      value: settings[SETTING_MOVE_ON_LAUNCH] === true,
    },
    {
      kind: "toggle",
      id: SETTING_MOVE_ON_MERGE,
      label: "Move the issue to Done when its pull request merges",
      help: 'Only issues linked to the lane with "close on merge" are moved.',
      value: settings[SETTING_MOVE_ON_MERGE] === true,
    },
  ];

  // A select when the plugin knows the teams, a text field when it does not.
  // The manifest declares the key as text either way; a select is the same
  // string with the guesswork removed.
  if (teams.length > 0) {
    fields.push({
      kind: "select",
      id: SETTING_DEFAULT_TEAM,
      label: "Default team key",
      help: "Used when a command does not name a team, e.g. ENG.",
      options: teams.slice(0, LIMITS.maxSelectOptions).map((team) => ({
        value: String(team.key),
        label: label(team.name ? `${team.key} · ${team.name}` : team.key),
      })),
      value: String(settings[SETTING_DEFAULT_TEAM] ?? teams[0].key),
    });
  } else {
    fields.push({
      kind: "text",
      id: SETTING_DEFAULT_TEAM,
      label: "Default team key",
      help: "Used when a command does not name a team, e.g. ENG.",
      placeholder: "ENG",
      value: value(String(settings[SETTING_DEFAULT_TEAM] ?? "")),
    });
  }

  return {
    component: "form",
    applyOnChange: { action: ACTIONS.applySettings },
    fields: fields.slice(0, LIMITS.maxFormFields),
  };
}

/**
 * The GitHub autolink manager.
 *
 * A LITERAL list rather than a bound one. The candidates are one row for ADE's
 * own PR refs plus one per team key — a handful, computed from rows the plugin
 * already holds — and `plugin.json` declares no `autolinks` collection, so a
 * binding here would read a collection the plugin is not allowed to write
 * (`pluginSdkServer.ts:801`) and draw an empty list with no error anywhere.
 *
 * Each row carries its prefix as `mono`, its state as a `badge` — Configured or
 * not — and one trailing button, which is the built-in's row exactly.
 */
function autolinksBlock(input = {}) {
  if (!input.showAutolinks) return [];

  const candidates = Array.isArray(input.autolinks) ? input.autolinks : [];
  const block = [
    { component: "divider", label: COPY.autolinksHeading },
    { component: "text", variant: "caption", text: prose(COPY.autolinksBody) },
    {
      component: "keyValue",
      rows: [{ key: COPY.autolinksRepo, value: value(input.githubRepo || COPY.autolinksNoRepo) }],
    },
  ];

  if (candidates.length === 0) {
    block.push({ component: "text", variant: "caption", text: prose(COPY.autolinksEmpty) });
    return block;
  }

  block.push({
    component: "list",
    items: candidates.slice(0, LIMITS.maxListItems).map((entry) => ({
      key: String(entry.prefix),
      title: label(entry.title),
      subtitle: value(entry.description),
      mono: value(entry.prefix),
      icon: "link",
      ...(entry.configured
        ? { badge: { text: COPY.autolinksConfigured, tone: "success" } }
        : {
            actions: [
              {
                action: ACTIONS.createAutolink,
                args: { prefix: String(entry.prefix) },
                label: COPY.autolinksCreate,
                kind: "primary",
              },
            ],
          }),
    })),
  });

  return block;
}

/**
 * The webhook ingress strip.
 *
 * This is the one area of the whole Linear integration the platform serves
 * better as a plugin than as compiled code: `webhookIngress` gives the plugin a
 * relay URL, a delivery event and an ack, so the status a reader wants is three
 * pre-formatted facts, the URL to paste into Linear, and a button that copies
 * it. The built-in's equivalent lives in Automations and cannot be reached from
 * the Linear settings section at all.
 */
function ingressBlock(input = {}) {
  const ingress = input.ingress;
  if (!ingress) return [];

  const rows = [{ key: "Webhook", value: value(ingress.status ?? "Not set up"), tone: ingress.tone ?? "neutral" }];
  if (ingress.lastEvent) rows.push({ key: "Last event", value: value(ingress.lastEvent) });

  const block = [
    { component: "divider", label: "Automations" },
    { component: "keyValue", rows },
  ];

  if (ingress.url) {
    block.push({
      component: "text",
      variant: "caption",
      text: "Paste this URL into Linear's webhook settings so an issue that changes wakes ADE.",
    });
    // `code`, because this is the one value on the screen a reader compares
    // character by character before pasting it into another product.
    block.push({ component: "text", variant: "code", text: value(ingress.url) });
    block.push({
      component: "button",
      label: "Copy the webhook URL",
      kind: "quiet",
      icon: "link",
      onPress: { action: ACTIONS.copyWebhookUrl },
    });
  }

  return block;
}

function settingsFallback(text) {
  return fallback(
    text ?? "Linear connects on the computer that holds this plugin. Open ADE there to sign in.",
    DEEPLINK_SETTINGS,
  );
}

/**
 * The settings panel.
 *
 * Drawn as one panel in three states — loading, disconnected, connected — so a
 * reader never sees preferences for a connection that does not exist, which is
 * the shape the desktop section already has.
 */
function buildSettingsPanel(input = {}) {
  const { state = "connected", error = null, connection = null } = input;

  if (state === "loading") {
    return {
      v: 1,
      title: "Linear",
      fallback: settingsFallback(),
      body: [
        {
          component: "emptyState",
          title: "Checking your Linear connection…",
          description: "Reading the credential stored on this machine.",
          icon: "plug",
        },
      ],
    };
  }

  const body = [];

  if (error) {
    body.push({ component: "text", variant: "caption", tone: "warning", text: prose(error) });
  }

  if (state === "disconnected" || !connection || connection.connected === false) {
    body.push(...disconnectCard(input));
    body.push(...autolinksBlock(input));
    return { v: 1, title: "Linear", fallback: settingsFallback(), body };
  }

  body.push(...connectedCard(connection));
  body.push({ component: "divider", label: "Preferences" });
  body.push(preferencesForm(input));
  body.push(...autolinksBlock(input));
  body.push(...ingressBlock(input));

  return { v: 1, title: "Linear", fallback: settingsFallback(), body };
}

module.exports = {
  LINEAR_API_SETTINGS_URL,
  SETTING_DEFAULT_TEAM,
  SETTING_MOVE_ON_LAUNCH,
  SETTING_MOVE_ON_MERGE,
  autolinksBlock,
  buildSettingsPanel,
  connectedCard,
  disconnectCard,
  ingressBlock,
  preferencesForm,
};
