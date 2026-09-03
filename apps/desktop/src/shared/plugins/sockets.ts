/**
 * Socket taxonomy — where a plugin is allowed to appear on a core surface.
 *
 * Pure types and pure helpers, shared by the daemon, the desktop renderer, the
 * `ade code` TUI and (transcribed) iOS. No React, no Electron, no Node.
 *
 * The taxonomy is deliberately CLOSED and small. Eighteen kinds across eight
 * surfaces is the whole vocabulary, and a plugin author learns the shape once
 * while iOS implements it exhaustively at compile time. Adding a nineteenth
 * kind is a platform change with a parity cost on four clients — not something
 * a plugin can invent at runtime.
 *
 * A kind does not have to reach every client on the day it lands. A client that
 * has not grown an arm for one drops it where it decodes (iOS maps an unknown
 * `socket` string to `.unsupported` and returns nil), so the contribution is
 * simply absent there rather than half-drawn — which is what lets a kind ship on
 * desktop and web first. `composer-action` is that case today; the skill's
 * per-surface table is where the honest current answer lives.
 *
 * Two invariants the host enforces and clients rely on:
 *
 * 1. **Placement is host-controlled and always AFTER core content.** A
 *    contribution never reorders, replaces, or interleaves with the product's
 *    own rows. `order` sorts plugins against each other, nothing more.
 * 2. **Payload shape is per kind, and a mismatched payload renders nothing.**
 *    {@link parsePluginContributionPayload} is the single gate; surfaces call
 *    it and skip anything that fails rather than rendering a half-built row.
 *    "Single" is load-bearing and now includes the HOST: a kind whose payload
 *    is read in main rather than by a renderer — `slash-command`, whose menu is
 *    built by `getSlashCommands` — routes through this same function, because a
 *    caller that skips it silently exempts its kind from every ceiling here.
 *
 * Static contributions come from the manifest. DYNAMIC per-entity values (this
 * PR's badge, this lane's menu item) come from `plugin_contributions` rows
 * written by the machine that owns the data.
 */

import { bounded, finite, isRecord, oneOf } from "./parse";
import { normalizeVocabTone, type VocabTone } from "./vocabulary";

export const PLUGIN_SOCKET_KINDS = [
  // Rows, lists and detail panes — the six list-shaped surfaces.
  "toolbar-action",
  "row-badge",
  "row-menu-item",
  "detail-section",
  "empty-state",
  "filter-chip",
  "file-viewer",
  // Chat and the agent.
  "composer-action",
  "chat-header-action",
  "chat-card",
  "slash-command",
  // Ambient placement: the seams that are not attached to a row.
  "command-palette-action",
  "settings-section",
  "work-rail-pane",
  "drawer-tab",
  "activity-entry",
  // The canvas. Its own group because it is the one placement that is not a
  // row, a control or a panel: it is a shape on a diagram, with a position and
  // an edge, and nothing else in the taxonomy has either.
  "graph-node",
  // Dialogs.
  "dialog-section",
] as const;

export type PluginSocketKind = (typeof PLUGIN_SOCKET_KINDS)[number];

/**
 * The surfaces a socket may name.
 *
 * The first six are ADE's list-shaped tabs, each with an entity kind behind it
 * (`SURFACE_ENTITY_KIND`), which is what makes a per-entity contribution row
 * meaningful there. `app` and `settings` are the two that carry no entity at
 * all: the command palette and the activity pane belong to the window rather
 * than to a tab, and a settings section belongs to a settings page named in its
 * payload. They are surfaces rather than a separate concept because everything
 * downstream — the manifest field, the contribution read, the per-slot cap, the
 * ordering rule — is the same, and a second concept would have doubled all of
 * it to express "no subject", which `cto` already expresses.
 */
export const PLUGIN_SURFACE_IDS = [
  "work",
  "lanes",
  "files",
  "prs",
  "automations",
  "cto",
  "app",
  "settings",
] as const;

export type PluginSurfaceId = (typeof PLUGIN_SURFACE_IDS)[number];

/** The entity a dynamic contribution is attached to. */
export const PLUGIN_ENTITY_KINDS = ["lane", "pr", "session", "file", "automation", "surface"] as const;

export type PluginEntityKind = (typeof PLUGIN_ENTITY_KINDS)[number];

/** Narrow an untrusted string to a socket kind. Lives here, beside the list. */
export function isPluginSocketKind(value: unknown): value is PluginSocketKind {
  return oneOf(value, PLUGIN_SOCKET_KINDS) !== null;
}

/** Narrow an untrusted string to a core surface. Lives here, beside the list. */
export function isPluginSurfaceId(value: unknown): value is PluginSurfaceId {
  return oneOf(value, PLUGIN_SURFACE_IDS) !== null;
}

/** Narrow an untrusted string to an entity kind. Lives here, beside the list. */
export function isPluginEntityKind(value: unknown): value is PluginEntityKind {
  return oneOf(value, PLUGIN_ENTITY_KINDS) !== null;
}

/**
 * What each socket kind needs before it can render anything.
 *
 * Three layers used to encode this separately and disagree about it: the
 * manifest parser required `panelId`/`actionId` but not `label`, the
 * manifest→payload mapping assumed whatever the manifest happened to carry, and
 * the payload validator dropped the result. A manifest declaring a badge with no
 * label therefore parsed clean, installed clean, and contributed nothing — with
 * nothing anywhere telling the author why.
 *
 * `manifest` names fields on a `sockets[]` entry; `payload` names fields on the
 * per-kind payload. They differ (a badge's manifest `label` becomes the
 * payload's `text`), which is exactly why one table has to state both.
 */
export type PluginSocketRequirementField = "label" | "actionId" | "panelId" | "extensions";

/**
 * Manifest fields a single kind cannot render WITHOUT, held apart from the four
 * above.
 *
 * `command` and `dialog` carry no meaning for any other kind, and the manifest
 * parser reads the four core fields off every entry unconditionally. Listing
 * these separately is what lets the parser learn them one kind at a time
 * instead of widening the record it builds for all seventeen.
 *
 * Membership means REQUIRED, which is the whole reason the list is short. A
 * per-kind field that is merely optional — `settings-section`'s `section`, a
 * slash command's `description` and `argumentHint` — is just an optional field
 * on the manifest entry and belongs nowhere near this union: putting one here
 * would make the parser drop a contribution that renders perfectly well
 * without it.
 */
export type PluginSocketExtraField = "command" | "dialog";

export type PluginSocketRequirement = {
  manifest: readonly PluginSocketRequirementField[];
  /** Extra `sockets[]` fields this kind cannot render without. */
  manifestExtra?: readonly PluginSocketExtraField[];
  payload: readonly string[];
};

export const PLUGIN_SOCKET_REQUIREMENTS: Record<PluginSocketKind, PluginSocketRequirement> = {
  "toolbar-action": { manifest: ["label", "actionId"], payload: ["label", "actionId"] },
  "row-badge": { manifest: ["label"], payload: ["text"] },
  "row-menu-item": { manifest: ["label", "actionId"], payload: ["label", "actionId"] },
  "detail-section": { manifest: ["panelId"], payload: ["panelId"] },
  "empty-state": { manifest: ["label"], payload: ["title"] },
  // `filterKey` falls back to the socket id, so the manifest need not carry it.
  "filter-chip": { manifest: ["label"], payload: ["label", "filterKey"] },
  "file-viewer": { manifest: ["panelId", "extensions"], payload: ["panelId", "extensions"] },
  "composer-action": { manifest: ["label", "actionId"], payload: ["label", "actionId"] },
  "chat-header-action": { manifest: ["label", "actionId"], payload: ["label", "actionId"] },
  // A card is a panel in a card frame: panel plus context, nothing else, which
  // is what makes it renderable by the panel renderer iOS and the TUI already
  // ship rather than by a card component only desktop has.
  "chat-card": { manifest: ["panelId"], payload: ["panelId"] },
  "slash-command": { manifest: ["actionId"], manifestExtra: ["command"], payload: ["command", "actionId"] },
  "command-palette-action": { manifest: ["label", "actionId"], payload: ["label", "actionId"] },
  "settings-section": { manifest: ["panelId"], payload: ["panelId"] },
  "work-rail-pane": { manifest: ["label", "panelId"], payload: ["label", "panelId"] },
  "drawer-tab": { manifest: ["label", "panelId"], payload: ["label", "panelId"] },
  "activity-entry": { manifest: ["label"], payload: ["title"] },
  // A label and nothing more, like a badge, and for the same reason: a node is
  // a per-ENTITY value, so the manifest entry reserves the slot and a published
  // row supplies the node. `actionId` is deliberately not required — a node that
  // only labels something is a legitimate node, and demanding a press would make
  // every purely informational one undeclarable.
  "graph-node": { manifest: ["label"], payload: ["label"] },
  "dialog-section": { manifest: ["panelId"], manifestExtra: ["dialog"], payload: ["dialog", "panelId"] },
};

/**
 * The dialogs that host a `dialog-section`.
 *
 * Closed, and short on purpose: a section only makes sense on a dialog whose
 * fields the platform has agreed to let a plugin write (see
 * {@link PLUGIN_DIALOG_FIELDS}), and every entry here is a promise that those
 * fields exist and mean what the table says.
 */
export const PLUGIN_DIALOG_KINDS = ["create-lane", "manage-lane", "create-pr"] as const;

export type PluginDialogKind = (typeof PLUGIN_DIALOG_KINDS)[number];

/**
 * The fields a `{dialog: {setField}}` response may write, per dialog.
 *
 * An allowlist rather than "whatever the dialog has in state", for two reasons.
 * A dialog's React state is an implementation detail that gets renamed; a
 * plugin writing to it would break on a refactor with nothing to catch it. And
 * these dialogs hold controls that are not text at all — the delete-lane
 * confirmation, the discard-dirty checkbox, the reclaim phrase — which a
 * setField verb must never be able to reach. Everything listed is a value the
 * user could have typed or picked themselves, and nothing listed commits
 * anything: pressing Create stays theirs.
 */
export const PLUGIN_DIALOG_FIELDS = {
  "create-lane": ["name", "baseBranch", "parentLaneId", "templateId", "color", "machineId"],
  "manage-lane": ["name", "baseBranch", "parentLaneId"],
  "create-pr": ["title", "body", "baseBranch"],
} as const satisfies Record<PluginDialogKind, readonly string[]>;

/** The field names one dialog accepts, as a union. */
export type PluginDialogField<K extends PluginDialogKind = PluginDialogKind> =
  (typeof PLUGIN_DIALOG_FIELDS)[K][number];

export function isPluginDialogKind(value: unknown): value is PluginDialogKind {
  return oneOf(value, PLUGIN_DIALOG_KINDS) !== null;
}

/** Whether a dialog accepts a field name. Narrows, so callers keep the union. */
export function isPluginDialogField<K extends PluginDialogKind>(
  dialog: K,
  field: unknown,
): field is PluginDialogField<K> {
  return typeof field === "string"
    && (PLUGIN_DIALOG_FIELDS[dialog] as readonly string[]).includes(field);
}

/**
 * A slash command's word, without the slash.
 *
 * The same grammar as a `cli[]` word and for the same reason: it is typed by a
 * person under time pressure, so it stays lowercase, hyphenated and short
 * enough to read in a menu. Two characters minimum — a one-letter command in a
 * merged list of every runtime's own commands is a collision waiting to happen.
 */
export const PLUGIN_SLASH_COMMAND_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Narrow a declared slash command, tolerating the leading slash a plugin author
 * will inevitably write. Returns the canonical word, or `null`.
 */
export function normalizePluginSlashCommand(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const word = value.trim().replace(/^\//, "").toLowerCase();
  return PLUGIN_SLASH_COMMAND_PATTERN.test(word) ? word : null;
}

/**
 * Which clients draw which kind, today.
 *
 * The honest current answer, in one place, because it is asked by three
 * audiences who otherwise each keep their own: a plugin author deciding whether
 * a badge can be the only way to learn something, the skill's per-surface table,
 * and a client deciding whether an absent contribution is a bug.
 *
 * A client that has not grown an arm for a kind drops it where it decodes, so
 * `false` means "absent there", never "half-drawn". Growing an arm is a
 * one-token edit on one line here — which is the point of the shape: the row is
 * the kind, so a parity pass that teaches iOS six kinds touches six tokens and
 * nothing else, and the table cannot drift from the client it describes without
 * someone editing this line.
 */
export const PLUGIN_CLIENT_SURFACES = ["desktop", "web", "ios", "tui"] as const;

export type PluginClientSurface = (typeof PLUGIN_CLIENT_SURFACES)[number];

export type PluginSocketClientSupport = Record<PluginClientSurface, boolean>;

export const PLUGIN_SOCKET_CLIENT_SUPPORT: Record<PluginSocketKind, PluginSocketClientSupport> = {
  // `web` tracks `desktop` because the hosted client builds the SAME renderer
  // components, and both reads a socket needs now cross the wire: declarations
  // ride `plugins.list`'s `sockets` field and dynamic rows come from the
  // project-scoped `plugins.contributions` command. It was false for every kind
  // until those landed — not for want of a renderer, which is the trap in
  // reading this column: the components were always there and the data was not.
  //
  // The residual is per SURFACE rather than per kind, so it cannot live in this
  // table: the web build does not mount `automations` (no `automations.*`
  // action is registered host-side), so a contribution declared on that surface
  // draws nowhere there whatever its kind says here.
  //
  // `ios` is true for the ten kinds `PluginRecords.swift` decodes and the tab
  // screens mount. It reads BOTH sources the desktop does: `plugins.list` grew
  // a `sockets` field carrying the manifest declarations, which the phone
  // resolves through these same payload arms and folds in beside the published
  // rows. So a declared contribution reaches the phone exactly as it reaches
  // desktop, and the "publish it or the phone cannot see it" rule that held
  // until that field landed is gone.
  //
  // `tui` is true for the three kinds `tuiClient/pluginSockets.ts` draws:
  // row badges on the drawer's lane cards and chat rows, and menu items and
  // toolbar actions listed by the `/plugin-actions` overlay — the second two on
  // the `lanes` and `work` surfaces only, since those are the surfaces that
  // client lists rows for.
  "toolbar-action": { desktop: true, web: true, ios: true, tui: true },
  "row-badge": { desktop: true, web: true, ios: true, tui: true },
  "row-menu-item": { desktop: true, web: true, ios: true, tui: true },
  "detail-section": { desktop: true, web: true, ios: true, tui: false },
  "empty-state": { desktop: true, web: true, ios: true, tui: false },
  "filter-chip": { desktop: true, web: true, ios: true, tui: false },
  "file-viewer": { desktop: true, web: true, ios: true, tui: false },
  "composer-action": { desktop: true, web: true, ios: true, tui: false },
  // The parity gap the alpha retrospective recorded, closed on three clients at
  // once. It shipped desktop-and-web-first with `ios` false for one round, which
  // is the pattern this table exists to make safe: absent on a client is honest
  // and readable, half-drawn is neither.
  //
  // The phone draws these as rows in the chat's existing overflow menu, grouped
  // per plugin, rather than as the split button desktop puts in the header — a
  // nav bar holds a title and about two controls. Different chrome, same
  // contribution and the same `PluginSessionContext`, which is what this row
  // actually promises. It does NOT promise pixels.
  "chat-header-action": { desktop: true, web: true, ios: true, tui: false },
  "chat-card": { desktop: true, web: true, ios: true, tui: false },
  "slash-command": { desktop: true, web: true, ios: false, tui: false },
  "command-palette-action": { desktop: true, web: true, ios: false, tui: false },
  "settings-section": { desktop: true, web: true, ios: false, tui: false },
  "work-rail-pane": { desktop: true, web: true, ios: false, tui: false },
  "drawer-tab": { desktop: true, web: true, ios: false, tui: false },
  "activity-entry": { desktop: true, web: true, ios: true, tui: false },
  // The one kind whose absence is a fact about a WHOLE TAB rather than about a
  // missing renderer arm. The Graph canvas is compiled into the desktop
  // renderer, which the hosted web client builds and mounts at the same
  // `/graph` route, so those two agree by construction. The phone ships no
  // Graph at all — `PLUGIN_BUILTIN_SURFACE_MOBILE.graph` is `false` and has
  // always been — and the terminal draws no canvas, so neither can grow an arm
  // for this kind without first growing the tab. iOS decodes the row and drops
  // it (`PluginSocketKind(rawValue:)` falls to `.unsupported`), which is the
  // absent-not-half-drawn behaviour this table promises.
  "graph-node": { desktop: true, web: true, ios: false, tui: false },
  "dialog-section": { desktop: true, web: true, ios: false, tui: false },
};

/** Whether a client draws a kind at all. Unknown kinds are not drawn. */
export function pluginSocketSupportedOn(
  socket: PluginSocketKind | null | undefined,
  client: PluginClientSurface,
): boolean {
  if (!socket) return false;
  return PLUGIN_SOCKET_CLIENT_SUPPORT[socket]?.[client] === true;
}

/** The kinds one client draws, in taxonomy order. For docs and parity checks. */
export function pluginSocketKindsSupportedOn(client: PluginClientSurface): PluginSocketKind[] {
  return PLUGIN_SOCKET_KINDS.filter((socket) => pluginSocketSupportedOn(socket, client));
}

/**
 * Matches `AdeCardTone`: no red. Failure is amber. See `../adeCard.ts`.
 *
 * The SAME type the panel vocabulary uses, and folded by the same function.
 * They were separate, with separate normalizers, and they disagreed: a payload
 * saying `"info"` or `"Warning"` rendered correctly inside a panel and fell
 * through to neutral as a badge, so one plugin's amber warning was a grey label
 * two pixels away from itself.
 */
export type PluginBadgeTone = VocabTone;

/**
 * Visible badges per row before the rest collapse into a "+N" popover. Two is
 * what a dense Lanes/PRs row can carry without pushing core metadata off.
 */
export const PLUGIN_ROW_BADGE_VISIBLE_LIMIT = 2;

/** Hard ceiling on contributions a single plugin may place in one socket slot. */
export const PLUGIN_CONTRIBUTIONS_PER_SLOT_LIMIT = 8;

/**
 * The host round-trip budget one socket invocation gets, per kind.
 *
 * 60s is the platform default and the right answer for a button on a row: it
 * fires with no visible progress anywhere, so a plugin that wedges must fail
 * while the user still remembers pressing it.
 *
 * `composer-action` is the deliberate exception, and the reason is the busy
 * state rather than the socket. A composer button is the one contribution the
 * user watches for its whole duration — it stays visibly active, refuses a
 * second press, and sits under a caret they are waiting on. Its canonical uses
 * are open-ended by nature: record until I stop, transcribe this, draft that.
 * A 60s cap would cut a dictation off mid-sentence and report it as a plugin
 * fault. So the budget follows the feedback: a kind that shows the user it is
 * working gets minutes, and a kind that shows nothing keeps seconds.
 *
 * These bound the HOST round trip, never the plugin's own process — a plugin
 * may still work for as long as it likes in `activate` or an event handler.
 */
export const PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS = 60_000;

export const PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS = 15 * 60_000;

/**
 * Kinds that get the long budget rather than the 60s default.
 *
 * A slash command joins `composer-action` because it is the same act by a
 * different gesture — the user typed `/transcribe` instead of pressing the
 * button next to it — and it draws the same busy state under the same caret.
 * Splitting the budget by gesture would mean `/summarize` timing out where the
 * button beside it succeeds.
 *
 * `chat-header-action` joins them on the rule this comment states rather than on
 * where it sits: the budget follows the FEEDBACK, and the header button draws
 * the same persistent busy state, refuses re-entry the same way, and is promoted
 * out of its overflow menu while it runs. Its canonical uses are the open-ended
 * ones a chat's own header attracts — summarize this conversation, hand it off,
 * file it — and a 60s cap would report those as plugin faults.
 */
const PLUGIN_LONG_RUNNING_SOCKETS: ReadonlySet<PluginSocketKind> = new Set([
  "composer-action",
  "chat-header-action",
  "slash-command",
]);

/**
 * The largest budget any socket may ask for, and the clamp every layer applies.
 *
 * The timeout crosses three trust boundaries (renderer → preload → host), so
 * the number that arrives is untrusted input. Without a ceiling a caller could
 * ask for a budget that outlives the app and turn a wedged plugin child into a
 * promise that never settles.
 */
export const PLUGIN_SOCKET_INVOKE_TIMEOUT_MAX_MS = PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS;

/** The budget a socket kind's invocations get. Unknown kinds get the default. */
export function pluginSocketInvokeTimeoutMs(socket: PluginSocketKind | null | undefined): number {
  return socket && PLUGIN_LONG_RUNNING_SOCKETS.has(socket)
    ? PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS
    : PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS;
}

/**
 * Narrow an untrusted timeout hint, or `null` for "no hint, use the default".
 *
 * Below the default is accepted — a caller asking for LESS patience than the
 * platform gives is not a risk, and refusing it would make the field
 * one-directional for no reason.
 */
export function clampPluginInvokeTimeoutMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.trunc(value), PLUGIN_SOCKET_INVOKE_TIMEOUT_MAX_MS);
}

/**
 * Extra actions hung off ONE action button, opened by a chevron beside it.
 *
 * The alpha retrospective's sharpest miss: a user asked for "a small arrow on
 * the drink button" that exposes a second action, and the platform's nearest
 * concepts — a slash command, a panel button, a row menu item — each answered a
 * different question, so the visible button acquired no arrow and the result
 * read as unfinished. This is that arrow, and nothing more: the button's primary
 * press is unchanged, and a payload with no `menu` renders exactly what it
 * rendered before this field existed.
 *
 * Deliberately NOT a nested socket. An entry is a label and an action id on the
 * SAME contribution, which is what keeps it addressable by the plugin that owns
 * the button and out of the per-slot cap that governs placement.
 */
export type PluginActionButtonMenuItem = {
  label: string;
  actionId: string;
  /**
   * A token from the same 64-name list the primary button's `icon` takes.
   *
   * Absent means the puzzle piece, which is what EVERY menu row drew before
   * this field existed: the alpha test's "Sober up" entry could not carry a
   * glyph at all, so a two-entry dropdown showed the same generic mark twice
   * and neither row said what it did. Resolved through `pluginIcon` on desktop
   * and `PluginSymbol` on iOS — the same resolver, the same list, the same
   * degradation — so an unknown token puzzle-pieces here exactly as it does on
   * the button above it.
   */
  icon?: string;
  /**
   * The product's own destructive styling, as `row-menu-item` already spends it.
   *
   * Honoured only alongside the attribution the same menu draws — a red row that
   * is not visibly a plugin's reads as ADE's own.
   */
  danger?: boolean;
};

/**
 * Entries one split button may carry.
 *
 * Six, because the menu is a SECONDARY affordance on a control that already has
 * a primary press: a plugin needing more than six related verbs wants a panel,
 * where it owns the layout, not a dropdown hanging off a toolbar. Over-cap
 * entries are truncated rather than dropping the button, so a plugin that grew
 * a seventh action still renders its first six and its primary press.
 */
export const PLUGIN_ACTION_MENU_ITEM_LIMIT = 6;

/**
 * The three action-BUTTON kinds share this shape.
 *
 * `toolbar-action`, `composer-action` and `chat-header-action` are one
 * contribution — a labelled button that invokes an action — wearing three
 * chromes, and `command-palette-action` is the fourth spelling of the same
 * fields. They share a parse arm for exactly that reason, and sharing the type
 * is what keeps the arm honest: a field added for one is a field all four
 * parse, at one ceiling, rather than three ceilings that drift.
 */
export type PluginActionButtonPayload = {
  label: string;
  icon?: string;
  actionId: string;
  disabled?: boolean;
  /**
   * Additional actions behind a chevron. Absent means a plain button.
   *
   * Read by the three button kinds. `command-palette-action` parses it — one
   * arm, one ceiling — and the palette ignores it, because a palette row is
   * already a flat searchable list and a submenu inside one would hide entries
   * from the search that is the palette's whole point.
   */
  menu?: PluginActionButtonMenuItem[];
  /**
   * A hex tint for THIS button, already proven legible in both themes.
   *
   * The alpha test's ask: a plugin that wanted its own button tinted had to
   * ship a whole `theme`, which recolours the entire application — a per-plugin
   * accent could not reach a socket, and panel `tone` is a four-value enum that
   * buttons never had. This is the narrow version of that: one control, one
   * colour, and no reach beyond the control.
   *
   * Only ever written by {@link sanitizePluginActionColor}, which is why the
   * field is safe for a renderer to drop straight into a style: anything that
   * is not a plain hex, or that cannot be read against BOTH the light and the
   * dark background, never becomes a value here at all. A renderer that reads
   * this field must never re-derive it from raw payload text.
   */
  color?: string;
  /**
   * `composer-action` only in meaning: this button claims the composer's Send.
   *
   * Parsed on all four action-button kinds (one arm) so the field cannot
   * drift. Only the composer row honours it: a click arms the button instead
   * of invoking, and Enter/Send invokes this action with `args.send === true`.
   */
  ownsSend?: boolean;
  /**
   * A `webview` surface of the same plugin this contribution draws INSTEAD of
   * `panelId`, on a client that can host a plugin page.
   *
   * The one field the page tier adds to the declarative sockets, and it is
   * deliberately a second name beside `panelId` rather than a replacement for it.
   * `panelId` stays REQUIRED and stays the contract: the terminal, an older host
   * and any client without a page host draw it, so a plugin that names a page
   * still works everywhere it worked before. A host that can draw the page draws
   * the page; a host that cannot draws the panel, and neither has to ask the
   * plugin which it should do.
   *
   * Unresolvable ids cost nothing: the renderer looks the surface up in the
   * plugin's OWN declared surfaces, so the worst a wrong value does is fall back
   * to the panel that was always going to be the fallback.
   */
  webviewSurfaceId?: string;
};

/**
 * The two backgrounds every action button has to be legible against.
 *
 * `--color-bg` for `dark` and `light` in `renderer/index.css`, as WCAG relative
 * luminance. A payload carries ONE colour and the user picks the theme, so the
 * host cannot re-tint per theme the way a `theme` plugin does — which is
 * exactly why a button colour is judged against both and a theme token is not.
 *
 * Restated as numbers rather than read from CSS because this runs in the
 * daemon, the TUI and iOS as well as in a browser, where there is no computed
 * style to ask. They move only when the product's own palette does.
 */
const PLUGIN_BUTTON_BACKDROP_LUMINANCE = { dark: 0.0035, light: 0.898 } as const;

/**
 * The floor a button tint has to clear against both backdrops.
 *
 * 3:1 is WCAG 2.1's non-text contrast minimum (SC 1.4.11) — the bar for a UI
 * component's own boundary and glyph, not for body copy. A tint is spent on a
 * label, an icon and a hairline border, so this is the applicable threshold
 * rather than the 4.5:1 one for prose.
 */
const PLUGIN_BUTTON_MIN_CONTRAST = 3;

/** One sRGB channel, linearized. */
function linearizeChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an `#rrggbb` triple. */
function relativeLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * linearizeChannel(red)
    + 0.7152 * linearizeChannel(green)
    + 0.0722 * linearizeChannel(blue);
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Mirrors `PLUGIN_ACCENT_PATTERN` in `manifest.ts`.
 *
 * Restated rather than imported because `manifest.ts` imports THIS file, and a
 * cycle for one regex would trade a real initialization hazard for a saved
 * line. The two are pinned together by a test.
 */
const PLUGIN_HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Narrow an untrusted button tint, or `null` for "use the platform's own".
 *
 * Two gates, and the second is the one that matters. The first is the same hex
 * shape a manifest `accent` takes, so nothing but a colour ever reaches a
 * stylesheet — the lesson `sanitizePluginThemeTokens` already learned, where a
 * value carrying `}` could close the rule and inject arbitrary CSS. The second
 * is legibility: the colour has to clear {@link PLUGIN_BUTTON_MIN_CONTRAST}
 * against BOTH entries in {@link PLUGIN_BUTTON_BACKDROP_LUMINANCE}, which
 * leaves a mid-tone band. Near-white, near-black and the fully saturated
 * primaries at the ends of that band are refused.
 *
 * Refused, deliberately, rather than nudged into range. A host that silently
 * darkened a plugin's brand colour would paint something the author never
 * chose and never told them, and the author's next move — picking a different
 * hex — would change nothing they could see. Falling back to the platform's own
 * tone is the visible answer: the button is plainly not wearing the colour, so
 * the rule in the skill is the next thing the author reads.
 *
 * ADE's own accent (`#7C6FF0`) passes, which is the intended calibration: a
 * plugin's brand colour is expected to work, and a colour that cannot be read
 * on half the installs is expected not to.
 */
export function sanitizePluginActionColor(raw: unknown): string | null {
  const value = bounded(raw, 7);
  if (!value || !PLUGIN_HEX_COLOR_PATTERN.test(value)) return null;
  const digits = value.slice(1);
  const expanded = digits.length === 3
    ? digits.split("").map((digit) => `${digit}${digit}`).join("")
    : digits;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  const luminance = relativeLuminance(red, green, blue);
  for (const backdrop of Object.values(PLUGIN_BUTTON_BACKDROP_LUMINANCE)) {
    if (contrastRatio(luminance, backdrop) < PLUGIN_BUTTON_MIN_CONTRAST) return null;
  }
  return `#${expanded.toLowerCase()}`;
}

/**
 * Narrow a split button's menu. Always an array — `[]` means "no menu".
 *
 * Tolerant per ENTRY and strict per FIELD, which is the same bargain the rest of
 * this file makes: an entry missing a label or an action is dropped, because a
 * blank menu row is a plugin bug that rendering would hide, while the entries
 * around it are still perfectly good. A non-array `menu`, or one whose every
 * entry is malformed, degrades to no menu — a plain button — rather than
 * dropping the whole contribution. The button's primary press is the thing the
 * user asked for; the chevron is the bonus.
 *
 * Exported because two other layers re-derive a menu from a shape this parser
 * never sees: the manifest parser, which reads `sockets[].menu` off authored
 * JSON, and the renderer's manifest→payload mapping. All three go through here
 * so the cap and the label ceiling cannot differ by layer.
 */
export function parsePluginActionButtonMenu(raw: unknown): PluginActionButtonMenuItem[] {
  if (!Array.isArray(raw)) return [];
  const items: PluginActionButtonMenuItem[] = [];
  for (const entry of raw) {
    if (items.length >= PLUGIN_ACTION_MENU_ITEM_LIMIT) break;
    if (!isRecord(entry)) continue;
    // The same 40 the button's own label takes: a menu row sits directly under
    // the button and a longer one would make the popover wider than the control
    // it hangs from.
    const label = bounded(entry.label, 40);
    const actionId = bounded(entry.actionId, 64);
    if (!label || !actionId) continue;
    // The same 40 the button's own `icon` takes. Kept as raw text rather than
    // checked against the token list, exactly as every other `icon` in this
    // file is: the list lives in a renderer (Phosphor here, SF Symbols on the
    // phone) and the resolver on each client degrades an unknown token to the
    // puzzle piece. A shared parser that rejected tokens would have to know
    // both lists and would drop a glyph the OTHER client can draw.
    const icon = bounded(entry.icon, 40);
    items.push({
      label,
      actionId,
      ...(icon ? { icon } : {}),
      ...(entry.danger === true ? { danger: true } : {}),
    });
  }
  return items;
}

export type PluginToolbarActionPayload = PluginActionButtonPayload;

export type PluginRowBadgePayload = {
  text: string;
  tone: PluginBadgeTone;
  icon?: string;
  tooltip?: string;
  /** See the note on {@link PluginActionButtonPayload.webviewSurfaceId}. */
  webviewSurfaceId?: string;
};

export type PluginRowMenuItemPayload = {
  label: string;
  icon?: string;
  danger?: boolean;
  actionId: string;
};

export type PluginDetailSectionPayload = {
  panelId: string;
  title?: string;
};

export type PluginEmptyStatePayload = {
  title: string;
  body?: string;
  actionId?: string;
  actionLabel?: string;
};

export type PluginFilterChipPayload = {
  label: string;
  filterKey: string;
  count?: number;
};

export type PluginFileViewerPayload = {
  panelId: string;
  extensions: string[];
};

/**
 * A button in the chat composer's accessory row.
 *
 * Structurally a toolbar action, and deliberately not folded into one: a
 * toolbar action's context is the surface or the row it sits on, while this
 * one's is the live composer — its session and its unsent draft. Two kinds
 * sharing a payload shape is cheap; one kind carrying two different contexts
 * would mean every action handler had to guess which it received.
 */
export type PluginComposerActionPayload = PluginActionButtonPayload;

/**
 * A button in an open chat's header, beside the chat's own controls.
 *
 * The retrospective's direct ask, and the third chrome over
 * {@link PluginActionButtonPayload}. What separates it from the
 * `toolbar-action` two pixels away is the CONTEXT, which is the same reason
 * `composer-action` is its own kind: a toolbar action on Work receives the tab
 * (`{kind: "surface", surface: "work"}`), while this one receives the chat it
 * sits above as a {@link PluginSessionContext}. A plugin that wants to act on
 * *this conversation* could not do it from the toolbar kind without the host
 * guessing which chat was meant.
 *
 * It is deliberately not scoped to a new chat, either. The alpha test's plugin
 * appeared in a fresh pane and not in the conversation the user was already
 * having, which read as the contribution being absent; this kind mounts on the
 * header every chat surface shares, so an EXISTING chat carries it.
 */
export type PluginChatHeaderActionPayload = PluginActionButtonPayload;

/**
 * A plugin's panel rendered as a card in the chat transcript.
 *
 * Payload is a panel id and nothing else the desktop happens to have. That is
 * the whole design: the transcript is the one place where a desktop-shaped
 * contribution would be most tempting and least portable, and a card that is
 * "panel + session context" is drawn by the vocabulary renderer iOS and the TUI
 * already ship. A card kind with its own fields would have needed a fourth
 * renderer on every client before a plugin could use it anywhere.
 */
export type PluginChatCardPayload = {
  panelId: string;
  title?: string;
  icon?: string;
  /** See the note on {@link PluginActionButtonPayload.webviewSurfaceId}. */
  webviewSurfaceId?: string;
};

/**
 * A command the user types into the composer.
 *
 * `command` is the word without the slash — the client draws the slash, the
 * same way it draws the `@` for a mention, so a plugin that declares `"/fix"`
 * and one that declares `"fix"` produce the same menu entry.
 */
export type PluginSlashCommandPayload = {
  command: string;
  actionId: string;
  description?: string;
  /**
   * What the command takes, for the menu row: `<issue-id>`, `[branch]`.
   *
   * A hint, never a contract — nothing parses it and nothing enforces it. The
   * handler receives the composer draft and reads its own arguments out of it,
   * the same as every other runtime's commands do.
   */
  argumentHint?: string;
  icon?: string;
};

/**
 * An entry in the ⌘K palette.
 *
 * Structurally a toolbar action, and folded into its parse arm for the same
 * reason `composer-action` is: same fields, different context. The palette
 * hands a surface-only context because it is opened from anywhere and belongs
 * to no row.
 */
export type PluginCommandPaletteActionPayload = PluginActionButtonPayload;

/**
 * A section on a core settings page.
 *
 * `section` names the page and is deliberately an opaque string rather than a
 * union: settings page ids are ADE's own furniture and they move, so a plugin
 * naming one this build has never heard of lands in the plugins section instead
 * of failing to parse. Omitting it means the same thing.
 */
export type PluginSettingsSectionPayload = {
  panelId: string;
  title?: string;
  section?: string;
  /** See the note on {@link PluginActionButtonPayload.webviewSurfaceId}. */
  webviewSurfaceId?: string;
};

/**
 * A pane in the Work tools rail, or a tab in the chat actions drawer.
 *
 * One payload shape for the two because they are the same contribution wearing
 * different chrome — a labelled, icon-bearing entry that reveals a panel — and
 * a plugin moving one to the other should be a one-word manifest edit.
 */
export type PluginPanelHostPayload = {
  label: string;
  panelId: string;
  icon?: string;
  /**
   * See the note on {@link PluginActionButtonPayload.webviewSurfaceId}.
   *
   * The rail and the drawer were the LAST two placements resolving a page by
   * matching `panelId` against the plugin's `webview` surfaces instead of
   * reading a declared id. That match is first-declaration-wins, so a plugin
   * with three surfaces sharing one `panelId` — ade-linear has exactly that —
   * got whichever appeared first in its manifest, and reordering the file
   * silently swapped the pane. Naming the surface makes the choice the author's.
   */
  webviewSurfaceId?: string;
};

/** A row in the activity pane. Mostly published dynamically, as events happen. */
export type PluginActivityEntryPayload = {
  title: string;
  body?: string;
  tone: PluginBadgeTone;
  actionId?: string;
  actionLabel?: string;
};

/**
 * What a plugin's edge ASSERTS, in three words the canvas already has a visual
 * for.
 *
 * Closed and short, because an edge on this canvas is read as a claim about
 * work: ADE's own edges mean "this branch descends from that one", "these two
 * touch the same files", "this proposal feeds that lane". A plugin's edge has
 * to be readable in the same glance without being mistaken for one of those, so
 * it gets a word rather than a free-text label, and every one of them is drawn
 * dashed in the plugin's own accent.
 *
 * No destructive word here, and no red on the edge itself: `blocks` is amber.
 * A plugin cannot paint a lane as failed. Badge tone is a different closed
 * set — panels and badges do have `destructive`.
 */
export const PLUGIN_GRAPH_EDGE_KINDS = ["link", "tracks", "blocks"] as const;

export type PluginGraphEdgeKind = (typeof PLUGIN_GRAPH_EDGE_KINDS)[number];

/**
 * The entities a plugin edge may point AT.
 *
 * A strict subset of {@link PLUGIN_ENTITY_KINDS}, and the subset is the whole
 * point: these are the two the canvas can resolve to a node it is already
 * drawing. A session, a file or an automation has no shape on this diagram, so
 * an edge naming one would resolve to nothing and the honest place to say so is
 * the type rather than a silent drop three layers down.
 */
export const PLUGIN_GRAPH_EDGE_TARGET_KINDS = ["lane", "pr"] as const;

export type PluginGraphEdgeTargetKind = (typeof PLUGIN_GRAPH_EDGE_TARGET_KINDS)[number];

/**
 * One edge from a plugin's node to something ADE already draws.
 *
 * Note what this shape CANNOT express: an edge between two of ADE's own nodes.
 * One endpoint is always the plugin's own node — the payload names the other —
 * and that asymmetry is a safety property rather than a simplification. An edge
 * between two lane nodes reads as a git relationship, and a plugin that could
 * draw one would be asserting a topology it does not own, in a place where the
 * user has no way to tell it apart from ADE's own.
 */
export type PluginGraphNodeEdge = {
  to: { kind: PluginGraphEdgeTargetKind; id: string };
  kind: PluginGraphEdgeKind;
  /** One word on the edge. Absent draws the edge with no caption. */
  label?: string;
};

/**
 * A shape a plugin adds to the Graph canvas.
 *
 * The last structural surface that had no plugin reach, and the one kind that is
 * not a row, a control or a panel. What makes it expressible at all is that the
 * canvas already knows where every lane sits: the ANCHOR is the published row's
 * entity, so a node published against a lane hangs beside that lane's card and
 * needs no coordinates from the plugin. A plugin never positions anything —
 * placement stays the host's here exactly as it is on a row.
 *
 * `edges` is the surplus over the anchor. The anchor already draws one edge; a
 * plugin needs this only when its node relates to more than the lane it is
 * filed against — one issue tracked by three lanes, say.
 */
export type PluginGraphNodePayload = {
  label: string;
  /** One line under the label: an id, a state, a count. */
  detail?: string;
  tone: PluginBadgeTone;
  icon?: string;
  /**
   * Pressed, this invokes the plugin. Optional: a node that only labels
   * something is a legitimate node.
   *
   * There is no separate deeplink field, and there does not need to be — the
   * ordinary socket-action dispatch already answers `{navigate}` and `{openUrl}`
   * response verbs, so a plugin that wants a press to go somewhere returns one
   * from its handler and gets it for free.
   */
  actionId?: string;
  edges?: PluginGraphNodeEdge[];
};

/**
 * Edges one node may carry beyond its anchor.
 *
 * Four, because the node is a glance. A plugin whose node relates to more than
 * four lanes is describing a list, and a list belongs in a panel where it can be
 * scrolled and read — not as a fan of lines across a canvas whose whole value is
 * that the shape of the work is legible at a distance.
 */
export const PLUGIN_GRAPH_NODE_EDGE_LIMIT = 4;

/**
 * Nodes one plugin may draw on the canvas, and nodes every plugin may draw
 * between them.
 *
 * Two caps rather than one, because they refuse two different failures. The
 * per-plugin cap stops ONE plugin from burying the topology under its own
 * annotations; the total stops three well-behaved plugins from doing it
 * collectively, which no per-plugin number can prevent.
 *
 * Both are enforced AFTER the canvas has built every core node, so the thing
 * that gets dropped is always a plugin's. A lane never loses its node to a
 * plugin's, whatever these are set to.
 *
 * The storage layer already caps harder in one direction and it is worth
 * knowing: `plugin_contributions` is keyed on
 * `(entity_kind, entity_id, plugin_id, socket)`, so a plugin gets at most one
 * node per lane and exactly one free-floating node however many times it
 * publishes.
 */
export const PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT = 24;

export const PLUGIN_GRAPH_NODES_TOTAL_LIMIT = 48;

/**
 * Narrow a node's extra edges. Always an array — `[]` means "anchor only".
 *
 * Tolerant per entry and strict per field, the bargain
 * {@link parsePluginActionButtonMenu} already makes: an edge missing a target or
 * naming an unknown kind is dropped while the ones beside it still draw, and a
 * malformed `edges` degrades the contribution to a plain anchored node rather
 * than deleting it. The node is what the plugin asked for; the extra lines are
 * the bonus.
 */
export function parsePluginGraphNodeEdges(raw: unknown): PluginGraphNodeEdge[] {
  if (!Array.isArray(raw)) return [];
  const edges: PluginGraphNodeEdge[] = [];
  for (const entry of raw) {
    if (edges.length >= PLUGIN_GRAPH_NODE_EDGE_LIMIT) break;
    if (!isRecord(entry)) continue;
    const kind = oneOf(entry.kind, PLUGIN_GRAPH_EDGE_KINDS);
    if (!kind) continue;
    if (!isRecord(entry.to)) continue;
    const targetKind = oneOf(entry.to.kind, PLUGIN_GRAPH_EDGE_TARGET_KINDS);
    // The same 512 the data store allows an entity id, since that is exactly
    // what this is: a foreign key into one of ADE's own tables.
    const targetId = bounded(entry.to.id, 512);
    if (!targetKind || !targetId) continue;
    // Short enough to sit on a line without becoming a second label.
    const label = bounded(entry.label, 24);
    edges.push({
      to: { kind: targetKind, id: targetId },
      kind,
      ...(label ? { label } : {}),
    });
  }
  return edges;
}

/**
 * A section inside one of ADE's own dialogs.
 *
 * `dialog` is part of the payload rather than implied by the surface because
 * two of the three dialogs live on the same surface (`lanes`), and a section
 * that appeared on both create-lane and manage-lane because it could not tell
 * them apart would be wrong on one of them every time.
 */
export type PluginDialogSectionPayload = {
  dialog: PluginDialogKind;
  panelId: string;
  title?: string;
  /**
   * See the note on {@link PluginActionButtonPayload.webviewSurfaceId}.
   *
   * On a dialog section the upgrade is the whole point of the socket rather
   * than a nicety: the surface it replaces in ADE's own dialogs is a PICKER —
   * the Create-lane issue chooser and the Create-PR issue reference — and a
   * picker is a search box over a live list, which a vocabulary panel cannot
   * be. A section that names one is drawn as a `dialog-picker` guest, sized to
   * the height the page reports, and answers the dialog through
   * `dialog.submit`. One that does not keeps drawing its panel.
   */
  webviewSurfaceId?: string;
};

/**
 * The one field every socket kind may carry, whatever its own shape.
 *
 * `filterKey` is not placement, it is a TAG on the entity a contribution was
 * published against, and that is why it cannot live in the per-kind arms:
 * tagging is how a contributed filter chip actually filters. A plugin declares
 * a chip with a `filterKey` and marks the entities belonging to it by putting
 * the same key on whatever it publishes for them — usually a `row-badge`,
 * because the badge is the thing it already had a reason to publish.
 *
 * Before this existed, `parsePluginContributionPayload` was a per-kind
 * whitelist and `publishContribution` persists the whitelisted literal, so the
 * key was silently dropped from every kind except `filter-chip` itself. Every
 * client then read `filterKey` off stored payloads of any kind, so the maps
 * were empty in production and `entityMatchesPluginFilters` — which returns
 * false for an entity with no keys — hid every row the moment a user selected
 * a chip. The chips were not merely dead, they emptied the list, on desktop,
 * web and iOS alike.
 */
export type PluginContributionEntityTag = {
  /**
   * Groups this contribution's entity under a declared `filter-chip`.
   *
   * Ignored unless some chip declares the same key. Bounded to 64 characters
   * by {@link parsePluginContributionPayload}, like the chip's own copy.
   */
  filterKey?: string;
  /**
   * WHICH declaration this row fills, when its kind is declared more than once.
   *
   * A plugin declaring two `row-badge` sockets on Lanes has two slots of one
   * kind, and a published row has to say which it belongs to. Three resolvers
   * already read this field and refuse to guess without it — the desktop host
   * (`pluginHostService.listContributions`, addressed path then sole-by-kind,
   * warning `plugin.contribution_id_ambiguous`) and iOS
   * (`PluginRecords.resolve(pluginId:socket:payloadId:)`, `declaredByTriple`).
   *
   * It was stripped by the same per-kind whitelist that dropped `filterKey`, so
   * every one of those addressed paths was dead code and any plugin declaring
   * one kind twice on a surface had ALL its published rows of that kind dropped
   * as ambiguous. Rows published before this carry no id and keep taking the
   * sole-by-kind path, so nothing that renders today stops rendering.
   */
  id?: string;
  /**
   * Where this row sorts among its plugin's own contributions.
   *
   * The THIRD field the per-kind whitelist silently dropped, found because a
   * renderer probe read `raw.order` off a payload the writer had already
   * stripped it from. `comparePluginContributions` treats an absent `order` as
   * `Number.MAX_SAFE_INTEGER`, so every published row sorted last and fell back
   * to plugin id — while STATIC contributions, which come from the manifest and
   * never pass through this parser, ordered correctly. Two sources of one list
   * disagreeing about whether ordering works at all.
   */
  order?: number;
};

/**
 * Per-kind payload shapes, each additionally carrying
 * {@link PluginContributionEntityTag}.
 *
 * Mapped rather than intersected seventeen times over, so a new socket kind gets
 * the tag by existing rather than by someone remembering.
 */
export type PluginContributionPayloadByKind = {
  [K in keyof PluginContributionPayloadByKindBase]:
  PluginContributionPayloadByKindBase[K] & PluginContributionEntityTag;
};

type PluginContributionPayloadByKindBase = {
  "toolbar-action": PluginToolbarActionPayload;
  "row-badge": PluginRowBadgePayload;
  "row-menu-item": PluginRowMenuItemPayload;
  "detail-section": PluginDetailSectionPayload;
  "empty-state": PluginEmptyStatePayload;
  "filter-chip": PluginFilterChipPayload;
  "file-viewer": PluginFileViewerPayload;
  "composer-action": PluginComposerActionPayload;
  "chat-header-action": PluginChatHeaderActionPayload;
  "chat-card": PluginChatCardPayload;
  "slash-command": PluginSlashCommandPayload;
  "command-palette-action": PluginCommandPaletteActionPayload;
  "settings-section": PluginSettingsSectionPayload;
  "work-rail-pane": PluginPanelHostPayload;
  "drawer-tab": PluginPanelHostPayload;
  "activity-entry": PluginActivityEntryPayload;
  "graph-node": PluginGraphNodePayload;
  "dialog-section": PluginDialogSectionPayload;
};

export type PluginContribution<K extends PluginSocketKind = PluginSocketKind> = {
  pluginId: string;
  socket: K;
  surface: PluginSurfaceId;
  /** Stable per-plugin id: identity for dedupe and ordering, not content. */
  id: string;
  order?: number;
  payload: PluginContributionPayloadByKind[K];
};

/** A dynamic contribution row as stored in `plugin_contributions`. */
export type PluginEntityContribution = PluginContribution & {
  entityKind: PluginEntityKind;
  entityId: string;
  updatedAt: string;
};

/**
 * Validate a payload against its socket kind.
 *
 * Returns `null` for anything malformed. Surfaces skip nulls — a contribution
 * with a missing label or action is a bug in the plugin, and rendering a blank
 * button would hide it.
 */
/**
 * Read the cross-kind tag off a stored payload, whatever kind it belongs to.
 *
 * Every client reads these two fields structurally, because a payload arriving
 * over IPC or sync is `unknown` by the time it gets there — plugin-authored
 * JSON that has to be validated, never asserted. Without a shared reader each
 * surface re-implements the probe (`typeof payload.filterKey === "string"`),
 * and a probe is not something a compiler checks: the desktop filter map, the
 * CLI join and the iOS decoder each grew their own copy, and all three were
 * silently reading a field the writer had already stripped.
 *
 * The writer's ceilings are re-applied here rather than trusted, since a row
 * may have been published by an older or newer host than the one reading it.
 */
export function readPluginContributionEntityTag(payload: unknown): PluginContributionEntityTag {
  if (!isRecord(payload)) return {};
  const filterKey = bounded(payload.filterKey, 64);
  const id = bounded(payload.id, 64);
  const order = finite(payload.order);
  return {
    ...(filterKey ? { filterKey } : {}),
    ...(id ? { id } : {}),
    ...(order !== null ? { order } : {}),
  };
}

export function parsePluginContributionPayload<K extends PluginSocketKind>(
  socket: K,
  raw: unknown,
): PluginContributionPayloadByKind[K] | null {
  if (!isRecord(raw)) return null;
  const result = ((): PluginContributionPayloadByKind[PluginSocketKind] | null => {
    switch (socket) {
      // Same payload, four contexts — see PluginActionButtonPayload. Sharing
      // the arm is what keeps them from drifting into different ceilings.
      case "toolbar-action":
      case "composer-action":
      case "chat-header-action":
      case "command-palette-action": {
        const label = bounded(raw.label, 40);
        const actionId = bounded(raw.actionId, 64);
        if (!label || !actionId) return null;
        const menu = parsePluginActionButtonMenu(raw.menu);
        // An illegible or malformed tint drops to `null` here and the field is
        // simply absent, so a renderer never has to decide whether to trust it.
        const color = sanitizePluginActionColor(raw.color);
        // Bounded at the manifest identifier ceiling every other surface id
        // uses. Never resolved here: this module runs in the daemon and on the
        // phone, where there is no registry to look a surface up in, so the
        // parser only proves the SHAPE and the drawing client proves the id.
        const webviewSurfaceId = bounded(raw.webviewSurfaceId, 64);
        return {
          label,
          actionId,
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
          ...(raw.disabled === true ? { disabled: true } : {}),
          ...(menu.length > 0 ? { menu } : {}),
          ...(color ? { color } : {}),
          ...(raw.ownsSend === true ? { ownsSend: true } : {}),
          ...(webviewSurfaceId ? { webviewSurfaceId } : {}),
        };
      }
      case "row-badge": {
        const badgeText = bounded(raw.text, 32);
        if (!badgeText) return null;
        return {
          text: badgeText,
          tone: normalizeVocabTone(raw.tone),
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
          ...(bounded(raw.tooltip, 200) ? { tooltip: bounded(raw.tooltip, 200)! } : {}),
          ...(bounded(raw.webviewSurfaceId, 64)
            ? { webviewSurfaceId: bounded(raw.webviewSurfaceId, 64)! }
            : {}),
        };
      }
      case "row-menu-item": {
        const label = bounded(raw.label, 60);
        const actionId = bounded(raw.actionId, 64);
        if (!label || !actionId) return null;
        return {
          label,
          actionId,
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
          ...(raw.danger === true ? { danger: true } : {}),
        };
      }
      case "detail-section": {
        const panelId = bounded(raw.panelId, 64);
        if (!panelId) return null;
        return {
          panelId,
          ...(bounded(raw.title, 60) ? { title: bounded(raw.title, 60)! } : {}),
        };
      }
      case "empty-state": {
        const title = bounded(raw.title, 80);
        if (!title) return null;
        return {
          title,
          ...(bounded(raw.body, 240) ? { body: bounded(raw.body, 240)! } : {}),
          ...(bounded(raw.actionId, 64) ? { actionId: bounded(raw.actionId, 64)! } : {}),
          ...(bounded(raw.actionLabel, 40) ? { actionLabel: bounded(raw.actionLabel, 40)! } : {}),
        };
      }
      case "filter-chip": {
        const label = bounded(raw.label, 40);
        const filterKey = bounded(raw.filterKey, 64);
        if (!label || !filterKey) return null;
        return {
          label,
          filterKey,
          ...((finite(raw.count) ?? -1) >= 0 ? { count: Math.trunc(finite(raw.count)!) } : {}),
        };
      }
      case "file-viewer": {
        const panelId = bounded(raw.panelId, 64);
        const extensions = Array.isArray(raw.extensions)
          ? raw.extensions
            .map((value) => bounded(value, 16)?.toLowerCase() ?? null)
            .filter((value): value is string => Boolean(value) && value!.startsWith("."))
          : [];
        if (!panelId || extensions.length === 0) return null;
        return { panelId, extensions };
      }
      case "chat-card": {
        const panelId = bounded(raw.panelId, 64);
        if (!panelId) return null;
        return {
          panelId,
          ...(bounded(raw.title, 60) ? { title: bounded(raw.title, 60)! } : {}),
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
          ...(bounded(raw.webviewSurfaceId, 64)
            ? { webviewSurfaceId: bounded(raw.webviewSurfaceId, 64)! }
            : {}),
        };
      }
      case "slash-command": {
        const command = normalizePluginSlashCommand(raw.command);
        const actionId = bounded(raw.actionId, 64);
        if (!command || !actionId) return null;
        return {
          command,
          actionId,
          // Long enough for the one line a command menu shows, short enough
          // that it cannot become a second description field.
          ...(bounded(raw.description, 120) ? { description: bounded(raw.description, 120)! } : {}),
          ...(bounded(raw.argumentHint, 40) ? { argumentHint: bounded(raw.argumentHint, 40)! } : {}),
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
        };
      }
      case "settings-section": {
        const panelId = bounded(raw.panelId, 64);
        if (!panelId) return null;
        return {
          panelId,
          ...(bounded(raw.title, 60) ? { title: bounded(raw.title, 60)! } : {}),
          ...(bounded(raw.section, 64) ? { section: bounded(raw.section, 64)! } : {}),
          ...(bounded(raw.webviewSurfaceId, 64)
            ? { webviewSurfaceId: bounded(raw.webviewSurfaceId, 64)! }
            : {}),
        };
      }
      case "work-rail-pane":
      case "drawer-tab": {
        // Shorter than a menu label: this one sits in a rail or a tab strip
        // beside ADE's own single-word entries, and a long one would push them.
        const label = bounded(raw.label, 24);
        const panelId = bounded(raw.panelId, 64);
        if (!label || !panelId) return null;
        return {
          label,
          panelId,
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
          ...(bounded(raw.webviewSurfaceId, 64)
            ? { webviewSurfaceId: bounded(raw.webviewSurfaceId, 64)! }
            : {}),
        };
      }
      case "activity-entry": {
        const title = bounded(raw.title, 80);
        if (!title) return null;
        return {
          title,
          tone: normalizeVocabTone(raw.tone),
          ...(bounded(raw.body, 240) ? { body: bounded(raw.body, 240)! } : {}),
          ...(bounded(raw.actionId, 64) ? { actionId: bounded(raw.actionId, 64)! } : {}),
          ...(bounded(raw.actionLabel, 40) ? { actionLabel: bounded(raw.actionLabel, 40)! } : {}),
        };
      }
      case "graph-node": {
        // The same 40 a button's label takes. A node card is about as wide as a
        // toolbar button and sits over a diagram, so a longer one would push
        // the lane cards it is meant to annotate.
        const label = bounded(raw.label, 40);
        if (!label) return null;
        return {
          label,
          tone: normalizeVocabTone(raw.tone),
          // Longer than the label because it carries the identifier a reader
          // matches against something outside ADE — an issue key, a run id.
          ...(bounded(raw.detail, 80) ? { detail: bounded(raw.detail, 80)! } : {}),
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
          ...(bounded(raw.actionId, 64) ? { actionId: bounded(raw.actionId, 64)! } : {}),
          ...((): { edges?: PluginGraphNodeEdge[] } => {
            const edges = parsePluginGraphNodeEdges(raw.edges);
            return edges.length > 0 ? { edges } : {};
          })(),
        };
      }
      case "dialog-section": {
        const dialog = oneOf(raw.dialog, PLUGIN_DIALOG_KINDS);
        const panelId = bounded(raw.panelId, 64);
        if (!dialog || !panelId) return null;
        return {
          dialog,
          panelId,
          ...(bounded(raw.title, 60) ? { title: bounded(raw.title, 60)! } : {}),
          ...(bounded(raw.webviewSurfaceId, 64)
            ? { webviewSurfaceId: bounded(raw.webviewSurfaceId, 64)! }
            : {}),
        };
      }
      default: {
        // A never-guard, not a silent null. `payloadFromManifestSocket` in the
        // renderer already does this, and the two have to fail the same way:
        // without it, adding a socket kind compiles, installs and renders
        // nothing, which is the exact silent-failure shape this round kept
        // rediscovering.
        const unhandled: never = socket as never;
        void unhandled;
        return null;
      }
    }
  })();
  if (!result) return null;
  // The switch above and PLUGIN_SOCKET_REQUIREMENTS say the same thing, and the
  // whole point of the table is that the other two layers can trust it. This
  // is where the two are held to each other: a payload that satisfied the
  // switch but is missing a field the table advertises means the table has
  // drifted, and rendering it would make the manifest parser's warnings lie.
  const required = PLUGIN_SOCKET_REQUIREMENTS[socket as PluginSocketKind].payload;
  const record = result as Record<string, unknown>;
  for (const field of required) {
    const value = record[field];
    const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
    if (!present) return null;
  }
  // The two CROSS-KIND fields, carried after the per-kind arms have had their
  // say. Deliberately outside the switch: neither describes the contribution's
  // own shape — `filterKey` tags the ENTITY it was published against and `id`
  // names the DECLARATION it fills — so every kind may carry them and no arm
  // should have to remember to. Being per-kind is exactly what silently
  // dropped them from every published row.
  //
  // Also deliberately after the drift check above rather than before it, so
  // that guard keeps judging exactly what the switch produced.
  //
  // `filter-chip` is skipped for `filterKey` only: its arm already validated
  // and returned its own required copy, and re-tagging here would let a chip
  // whose `filterKey` the arm rejected acquire one anyway. It still takes `id`
  // like every other kind, because a plugin can declare two chips too.
  if (socket !== "filter-chip") {
    const tag = bounded(raw.filterKey, 64);
    if (tag) record.filterKey = tag;
  }
  const declarationId = bounded(raw.id, 64);
  if (declarationId) record.id = declarationId;
  const order = finite(raw.order);
  if (order !== null) record.order = order;
  return result as PluginContributionPayloadByKind[K] | null;
}

/**
 * Host-controlled placement: plugin order, then plugin id, then contribution
 * id. Deterministic across machines so two devices show the same row order for
 * the same data, and stable when a plugin omits `order` entirely.
 */
export function comparePluginContributions(left: PluginContribution, right: PluginContribution): number {
  const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
  const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  const byPlugin = left.pluginId.localeCompare(right.pluginId);
  return byPlugin !== 0 ? byPlugin : left.id.localeCompare(right.id);
}

/**
 * Sort, cap, and split row badges into the visible set plus an overflow count.
 * Every row-badge surface uses this so desktop, TUI and iOS agree on which two
 * badges are the visible ones.
 */
export function splitPluginRowBadges(
  contributions: readonly PluginContribution<"row-badge">[],
  visibleLimit = PLUGIN_ROW_BADGE_VISIBLE_LIMIT,
): { visible: PluginContribution<"row-badge">[]; overflowCount: number } {
  const sorted = [...contributions].sort(comparePluginContributions);
  const visible = sorted.slice(0, Math.max(0, visibleLimit));
  return { visible, overflowCount: Math.max(0, sorted.length - visible.length) };
}
