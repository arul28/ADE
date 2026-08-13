/**
 * Socket taxonomy — where a plugin is allowed to appear on a core surface.
 *
 * Pure types and pure helpers, shared by the daemon, the desktop renderer, the
 * `ade code` TUI and (transcribed) iOS. No React, no Electron, no Node.
 *
 * The taxonomy is deliberately CLOSED and small. Sixteen kinds across eight
 * surfaces is the whole vocabulary, and a plugin author learns the shape once
 * while iOS implements it exhaustively at compile time. Adding a seventeenth
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
  "chat-card",
  "slash-command",
  // Ambient placement: the seams that are not attached to a row.
  "command-palette-action",
  "settings-section",
  "work-rail-pane",
  "drawer-tab",
  "activity-entry",
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
 * instead of widening the record it builds for all sixteen.
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
  "chat-card": { desktop: true, web: true, ios: true, tui: false },
  "slash-command": { desktop: true, web: true, ios: false, tui: false },
  "command-palette-action": { desktop: true, web: true, ios: false, tui: false },
  "settings-section": { desktop: true, web: true, ios: false, tui: false },
  "work-rail-pane": { desktop: true, web: true, ios: false, tui: false },
  "drawer-tab": { desktop: true, web: true, ios: false, tui: false },
  "activity-entry": { desktop: true, web: true, ios: true, tui: false },
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
 */
const PLUGIN_LONG_RUNNING_SOCKETS: ReadonlySet<PluginSocketKind> = new Set([
  "composer-action",
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

export type PluginToolbarActionPayload = {
  label: string;
  icon?: string;
  actionId: string;
  disabled?: boolean;
};

export type PluginRowBadgePayload = {
  text: string;
  tone: PluginBadgeTone;
  icon?: string;
  tooltip?: string;
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
export type PluginComposerActionPayload = {
  label: string;
  icon?: string;
  actionId: string;
  disabled?: boolean;
};

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
export type PluginCommandPaletteActionPayload = {
  label: string;
  icon?: string;
  actionId: string;
  disabled?: boolean;
};

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
 * Mapped rather than intersected sixteen times over, so a new socket kind gets
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
  "chat-card": PluginChatCardPayload;
  "slash-command": PluginSlashCommandPayload;
  "command-palette-action": PluginCommandPaletteActionPayload;
  "settings-section": PluginSettingsSectionPayload;
  "work-rail-pane": PluginPanelHostPayload;
  "drawer-tab": PluginPanelHostPayload;
  "activity-entry": PluginActivityEntryPayload;
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
      // Same payload, three contexts — see PluginComposerActionPayload. Sharing
      // the arm is what keeps them from drifting into different ceilings.
      case "toolbar-action":
      case "composer-action":
      case "command-palette-action": {
        const label = bounded(raw.label, 40);
        const actionId = bounded(raw.actionId, 64);
        if (!label || !actionId) return null;
        return {
          label,
          actionId,
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
          ...(raw.disabled === true ? { disabled: true } : {}),
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
      case "dialog-section": {
        const dialog = oneOf(raw.dialog, PLUGIN_DIALOG_KINDS);
        const panelId = bounded(raw.panelId, 64);
        if (!dialog || !panelId) return null;
        return {
          dialog,
          panelId,
          ...(bounded(raw.title, 60) ? { title: bounded(raw.title, 60)! } : {}),
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
