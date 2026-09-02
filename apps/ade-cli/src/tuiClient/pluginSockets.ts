// ---------------------------------------------------------------------------
// Plugin socket contributions for the TUI.
//
// The panel half of the plugin platform already has a terminal interpreter
// (pluginPane.ts). This is the socket half: the badges a plugin puts on a row
// and the actions it puts in a row's menu, drawn where `ade code` has an honest
// equivalent for them.
//
// Reuse over transcription. The rules that decide WHICH contribution appears
// WHERE — a dynamic row replacing the manifest socket it fills, the host's
// ordering, the per-plugin cap, dropping a disabled plugin's rows — live in the
// desktop's `contributionModel`, which is pure and has no React in it. Reading
// it from here is what keeps the terminal and the app agreeing about what a
// plugin contributes, exactly as both agree about panels by sharing
// `vocabulary.ts`. What is genuinely this module's is the part a terminal has
// to answer for itself: how much of a 32-column drawer row a badge may take,
// and what a "menu" is on a surface that has no pointer.
//
// TUI SUPPORT, stated once (design decision: honest degradation over invented
// chrome). Of the eight socket kinds:
//
//   row-badge      — drawn on the drawer's lane cards and chat rows, and only
//                    from a PUBLISHED per-entity row. The manifest declaration
//                    reserves the slot and draws nothing.
//   row-menu-item  — listed by `/plugin-actions` for the focused lane or chat.
//   toolbar-action — listed by `/plugin-actions` under the surface itself. The
//                    TUI header is a breadcrumb strip with nothing selectable in
//                    it, so a toolbar button has no home there; the actions pane
//                    is where a surface-scoped action becomes reachable instead
//                    of vanishing.
//   everything else — NOT rendered. `detail-section`, `empty-state`,
//                    `filter-chip`, `file-viewer` and `composer-action` have no
//                    drawer or pane in this client that is honestly the same
//                    thing, and a contribution nobody can act on is worse than
//                    an absent one. They render nothing, never a placeholder.
//
// Surfaces: `lanes` (entity `lane`) and `work` (entity `session`) — the two the
// drawer actually lists. `files`, `prs`, `automations` and `cto` have no list
// surface here.
// ---------------------------------------------------------------------------

import {
  buildContributionSet,
  contributionKey,
  selectContributions,
  selectPluginTabBadge,
  EMPTY_CONTRIBUTION_SET,
  type PluginSocketIdentity,
  type SurfaceContributionSet,
} from "../../../desktop/src/renderer/components/plugins/sockets/contributionModel";
import type {
  PluginContributionRow,
  PluginSocketSource,
} from "../../../desktop/src/renderer/components/plugins/sockets/contributionBridge";
import {
  PLUGIN_SOCKET_KINDS,
  pluginSocketSupportedOn,
  splitPluginRowBadges,
  type PluginContribution,
  type PluginEntityKind,
  type PluginSocketKind,
  type PluginSurfaceId,
} from "../../../desktop/src/shared/plugins/sockets";
import type {
  PluginLaneContext,
  PluginSessionContext,
  PluginSurfaceContext,
} from "../../../desktop/src/shared/plugins/context";
import type { VocabTone } from "../../../desktop/src/shared/plugins/vocabulary";
import type { PluginContributionRecord, PluginSummary } from "../../../desktop/src/shared/plugins/sdk";

export { EMPTY_CONTRIBUTION_SET };
export type { PluginSocketSource, SurfaceContributionSet };

/**
 * The socket kinds this client draws — DERIVED from the shared support table,
 * never listed by hand, so this file and `PLUGIN_SOCKET_CLIENT_SUPPORT` cannot
 * silently disagree about what the TUI renders.
 */
export const PLUGIN_TUI_SOCKET_KINDS: readonly PluginSocketKind[] =
  PLUGIN_SOCKET_KINDS.filter((socket) => pluginSocketSupportedOn(socket, "tui"));

/**
 * The core surfaces this client lists rows for, with the entity each carries.
 *
 * The pairing is the load-bearing part: `plugin.listContributions` filters by
 * entity kind, and asking the `work` surface for `lane` rows returns nothing —
 * which looks exactly like a machine with no contributions rather than a wrong
 * argument. So the two travel together, from one place.
 */
export const PLUGIN_TUI_SURFACES = [
  { surface: "lanes", entityKind: "lane" },
  { surface: "work", entityKind: "session" },
  { surface: "app", entityKind: "surface" },
] as const satisfies readonly { surface: PluginSurfaceId; entityKind: PluginEntityKind }[];

export function pluginSocketSupportedInTui(socket: PluginSocketKind): boolean {
  return PLUGIN_TUI_SOCKET_KINDS.includes(socket);
}

/** Both surfaces' contributions, as one value the drawer and the panes read. */
export type PluginTuiContributions = {
  lanes: SurfaceContributionSet;
  work: SurfaceContributionSet;
  app: SurfaceContributionSet;
};

export const EMPTY_PLUGIN_TUI_CONTRIBUTIONS: PluginTuiContributions = {
  lanes: EMPTY_CONTRIBUTION_SET,
  work: EMPTY_CONTRIBUTION_SET,
  app: EMPTY_CONTRIBUTION_SET,
};

/* ── Sources ────────────────────────────────────────────────────────────── */

/**
 * Turn what `plugin.list` and `plugin.getManifest` answered into the shape the
 * shared model consumes.
 *
 * Disabled plugins are kept rather than filtered, because the model needs to
 * see the difference: `enabled:false` drops that plugin's contributions AND its
 * published rows, while an absent plugin would make a row from a plugin the
 * user merely switched off indistinguishable from one they uninstalled.
 */
export function pluginSocketSources(
  plugins: readonly PluginSummary[],
  manifestsByPluginId: ReadonlyMap<string, unknown>,
): PluginSocketSource[] {
  return plugins.map((plugin) => ({
    pluginId: plugin.pluginId,
    displayName: plugin.displayName?.trim() || plugin.pluginId,
    enabled: plugin.enabled,
    accent: plugin.accent ?? null,
    icon: plugin.icon ?? null,
    disabledContributions: plugin.disabledContributions ?? [],
    manifest: manifestsByPluginId.get(plugin.pluginId) ?? null,
  }));
}

/**
 * `plugin.listContributions` records as the model's row shape.
 *
 * The host already dropped rows from disabled plugins and switched-off sockets,
 * and the model checks both again. That duplication is deliberate: this client
 * also talks to hosts that predate either filter, and the model is the layer
 * that must hold whether or not the host helped.
 */
export function pluginContributionRows(
  records: readonly PluginContributionRecord[],
): PluginContributionRow[] {
  return records.map((record) => ({
    entityKind: record.entityKind,
    entityId: record.entityId,
    pluginId: record.pluginId,
    socket: record.socket,
    ...(record.socketId ? { socketId: record.socketId } : {}),
    ...(record.surface ? { surface: record.surface } : {}),
    payload: record.payload,
    updatedAt: record.updatedAt ?? null,
  }));
}

export function buildPluginTuiContributions(
  sources: readonly PluginSocketSource[],
  rowsBySurface: {
    lanes: readonly PluginContributionRow[];
    work: readonly PluginContributionRow[];
    app?: readonly PluginContributionRow[];
  },
): PluginTuiContributions {
  return {
    lanes: buildContributionSet(sources, rowsBySurface.lanes, "lanes"),
    work: buildContributionSet(sources, rowsBySurface.work, "work"),
    app: buildContributionSet(sources, rowsBySurface.app ?? [], "app"),
  };
}

/**
 * The unread mark a plugin published for its rail tab, as text for a picker row.
 *
 * Null when the plugin has no tab surface or has not published a badge.
 */
export function pluginTabBadgeText(
  set: SurfaceContributionSet,
  plugin: Pick<PluginSummary, "pluginId" | "surfaces">,
): string | null {
  const tab = plugin.surfaces.find((surface) => surface.kind === "tab");
  if (!tab) return null;
  return selectPluginTabBadge(set, plugin.pluginId, tab.id)?.payload.text ?? null;
}

/* ── Contexts ───────────────────────────────────────────────────────────── */

/**
 * Contexts are built here rather than imported from the desktop's
 * `surfaceContexts` for one reason: the TUI's lane and session models are the
 * daemon's wire types, not the renderer's, and the two builders take different
 * inputs even though they must produce identical output. The output shape is
 * `shared/plugins/context.ts`, which is the thing that actually has to match.
 */
export function tuiLaneContext(lane: {
  id: string;
  name: string;
  branchRef?: string | null;
  status?: { dirty?: boolean } | null;
}): PluginLaneContext {
  const branch = (lane.branchRef ?? "").replace(/^refs\/heads\//, "");
  return {
    kind: "lane",
    id: lane.id,
    name: lane.name,
    branch: branch.length > 0 ? branch : null,
    // The TUI talks to one machine at a time and the daemon does not hand a
    // lane row a machine key, so this is honestly unknown rather than guessed.
    machineKey: null,
    dirty: lane.status?.dirty === true,
  };
}

export function tuiSessionContext(session: {
  sessionId: string;
  title?: string | null;
  provider?: string | null;
  status?: string | null;
}): PluginSessionContext {
  return {
    kind: "session",
    id: session.sessionId,
    title: session.title ?? "",
    provider: session.provider ?? null,
    status: session.status ?? null,
  };
}

/* ── Row badges ─────────────────────────────────────────────────────────── */

/**
 * Longest a single badge may render in a drawer row.
 *
 * The payload allows 32 characters, which is the whole drawer. Anything past
 * this truncates the same way a lane name or a chat title does — the drawer's
 * own convention, and the alternative (dropping the badge whole) would make a
 * plugin's status vanish for being verbose.
 */
export const PLUGIN_BADGE_TEXT_MAX_WIDTH = 14;

/** Smallest badge worth drawing: `[` + one character + `…` + `]`. */
const PLUGIN_BADGE_MIN_WIDTH = 4;

export type PluginRowBadgeCell = {
  /** Stable identity, for React keys and for tests that assert order. */
  key: string;
  pluginId: string;
  text: string;
  tone: VocabTone;
  tooltip: string | null;
};

export type PluginRowBadgeStrip = {
  cells: PluginRowBadgeCell[];
  /** Badges the visible cap left out. Zero when everything fits. */
  overflowCount: number;
};

export const EMPTY_PLUGIN_ROW_BADGE_STRIP: PluginRowBadgeStrip = { cells: [], overflowCount: 0 };

function truncateBadgeText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - 1)}…`;
}

/**
 * The badges one row carries, ordered and capped by the shared rule.
 *
 * `splitPluginRowBadges` is the same split the desktop and iOS use, so the two
 * badges a lane shows in the terminal are the same two it shows in the app.
 */
export function pluginRowBadgeStrip(
  set: SurfaceContributionSet,
  context: PluginSurfaceContext,
): PluginRowBadgeStrip {
  const contributions = selectContributions(set, "row-badge", context);
  if (contributions.length === 0) return EMPTY_PLUGIN_ROW_BADGE_STRIP;
  const { visible, overflowCount } = splitPluginRowBadges(contributions);
  return {
    cells: visible.map((contribution) => ({
      key: contributionKey(contribution),
      pluginId: contribution.pluginId,
      text: truncateBadgeText(contribution.payload.text, PLUGIN_BADGE_TEXT_MAX_WIDTH),
      tone: contribution.payload.tone,
      tooltip: contribution.payload.tooltip ?? null,
    })),
    overflowCount,
  };
}

/** Columns a cell occupies drawn as `[text]`. */
function badgeCellWidth(cell: PluginRowBadgeCell): number {
  return cell.text.length + 2;
}

/** Columns the whole strip occupies, cells space-separated, `+N` last. */
export function pluginBadgeStripWidth(strip: PluginRowBadgeStrip): number {
  if (strip.cells.length === 0) return 0;
  const cells = strip.cells.reduce((total, cell) => total + badgeCellWidth(cell), 0);
  const gaps = strip.cells.length - 1;
  const overflow = strip.overflowCount > 0 ? 1 + `+${strip.overflowCount}`.length : 0;
  return cells + gaps + overflow;
}

/**
 * The strip that fits `budget` columns, or nothing.
 *
 * Badges drop from the right into the overflow count until the rest fit, and a
 * budget too small for even one badge yields an empty strip — NOT a bare "+3".
 * A count with nothing to count is a placeholder, and a placeholder is the one
 * thing degradation here is not allowed to be: it takes the row's width to say
 * a plugin had something to say, without saying it.
 */
export function fitPluginBadgeStrip(strip: PluginRowBadgeStrip, budget: number): PluginRowBadgeStrip {
  if (strip.cells.length === 0) return EMPTY_PLUGIN_ROW_BADGE_STRIP;
  if (budget < PLUGIN_BADGE_MIN_WIDTH) return EMPTY_PLUGIN_ROW_BADGE_STRIP;
  let cells = strip.cells;
  let overflowCount = strip.overflowCount;
  while (cells.length > 0 && pluginBadgeStripWidth({ cells, overflowCount }) > budget) {
    cells = cells.slice(0, -1);
    overflowCount += 1;
  }
  if (cells.length === 0) return EMPTY_PLUGIN_ROW_BADGE_STRIP;
  return { cells, overflowCount };
}

/** The strip as plain text. The renderer colors it; this is what it says. */
export function pluginBadgeStripText(strip: PluginRowBadgeStrip): string {
  if (strip.cells.length === 0) return "";
  const badges = strip.cells.map((cell) => `[${cell.text}]`).join(" ");
  return strip.overflowCount > 0 ? `${badges} +${strip.overflowCount}` : badges;
}

/* ── Row actions ────────────────────────────────────────────────────────── */

export type PluginRowActionEntry = {
  /** Contribution identity — the id the actions pane hands back on Enter. */
  key: string;
  pluginId: string;
  pluginName: string;
  actionId: string;
  label: string;
  danger: boolean;
  socket: "row-menu-item" | "toolbar-action";
};

function identityName(set: SurfaceContributionSet, pluginId: string): string {
  const identity: PluginSocketIdentity | undefined = set.identities.get(pluginId);
  return identity?.displayName?.trim() || pluginId;
}

function toEntry(
  set: SurfaceContributionSet,
  contribution: PluginContribution<"row-menu-item"> | PluginContribution<"toolbar-action">,
  socket: PluginRowActionEntry["socket"],
): PluginRowActionEntry {
  const payload = contribution.payload as { label: string; actionId: string; danger?: boolean };
  return {
    key: contributionKey(contribution),
    pluginId: contribution.pluginId,
    pluginName: identityName(set, contribution.pluginId),
    actionId: payload.actionId,
    label: payload.label,
    danger: payload.danger === true,
    socket,
  };
}

/**
 * Contributed menu items for one lane or chat.
 *
 * The `surface` re-check mirrors `buildPluginMenuEntries`: a set is built for
 * one surface, and a caller that passes the wrong one would otherwise get the
 * other tab's entries wearing this one's name.
 */
export function pluginRowActionEntries(
  set: SurfaceContributionSet,
  surface: PluginSurfaceId,
  context: PluginSurfaceContext,
): PluginRowActionEntry[] {
  return selectContributions(set, "row-menu-item", context)
    .filter((contribution) => contribution.surface === surface)
    .map((contribution) => toEntry(set, contribution, "row-menu-item"));
}

/**
 * Contributed toolbar actions for a surface.
 *
 * Surface-scoped, so no entity context: `selectContributions` reads statics
 * only for a surface-only subject, which is exactly what a toolbar button is.
 */
export function pluginSurfaceActionEntries(
  set: SurfaceContributionSet,
  surface: PluginSurfaceId,
): PluginRowActionEntry[] {
  return selectContributions(set, "toolbar-action", { kind: "surface", surface })
    .filter((contribution) => contribution.surface === surface)
    .map((contribution) => toEntry(set, contribution, "toolbar-action"));
}

/* ── The actions pane ───────────────────────────────────────────────────── */

/**
 * What `/plugin-actions` puts in the right pane.
 *
 * A list pane, so the rows are strings and the ids run parallel to them —
 * the same contract `/chats`, `/secrets` and the plugin picker already use.
 * Heading rows carry an empty id, which the pane's activation path ignores.
 *
 * Attribution is not decoration here either: a contributed row may ask for the
 * product's destructive styling, and a row that is not visibly a plugin's reads
 * as ADE's own. So every row names its plugin, and the danger marker only ever
 * ships alongside that name.
 */
export type PluginActionsPane = {
  rows: string[];
  ids: string[];
  entriesByKey: Map<string, PluginRowActionEntry>;
  emptyText: string;
};

const PLUGIN_ACTION_ROW_GLYPH = "▸";

/** `▸ Label · destructive · Plugin`, with the plugin's own label giving first. */
export function formatPluginActionRow(entry: PluginRowActionEntry, width: number): string {
  const marker = entry.danger ? " · destructive" : "";
  const label = `${PLUGIN_ACTION_ROW_GLYPH} ${entry.label}${marker}`;
  const suffix = ` · ${entry.pluginName}`;
  if (width <= 0 || label.length + suffix.length <= width) return `${label}${suffix}`;
  // Attribution is the LAST thing to give up, not the first. A contributed row
  // that has lost its plugin's name reads as ADE's own row, and a row wearing
  // the product's `destructive` word without a name attached reads as ADE about
  // to delete something — which is the exact confusion this suffix exists to
  // prevent, so the plugin's own label is what shortens. Only a width too small
  // for even a stub of one falls back to letting the pane clip.
  const room = width - `${PLUGIN_ACTION_ROW_GLYPH} `.length - marker.length - suffix.length;
  if (room < 3) return `${label}${suffix}`;
  return `${PLUGIN_ACTION_ROW_GLYPH} ${entry.label.slice(0, room - 1)}…${marker}${suffix}`;
}

export function buildPluginActionsPane(options: {
  set: SurfaceContributionSet;
  surface: PluginSurfaceId;
  context: PluginSurfaceContext | null;
  /** What the focused row is called, for the section heading. */
  entityLabel: string | null;
  /** What the surface is called, for the toolbar section heading. */
  surfaceLabel: string;
  width: number;
}): PluginActionsPane {
  const { set, surface, context, entityLabel, surfaceLabel, width } = options;
  const rowEntries = context ? pluginRowActionEntries(set, surface, context) : [];
  const surfaceEntries = pluginSurfaceActionEntries(set, surface);

  const rows: string[] = [];
  const ids: string[] = [];
  const entriesByKey = new Map<string, PluginRowActionEntry>();
  const push = (row: string, entry: PluginRowActionEntry | null): void => {
    rows.push(row);
    ids.push(entry?.key ?? "");
    if (entry) entriesByKey.set(entry.key, entry);
  };

  if (rowEntries.length > 0) {
    if (entityLabel) push(entityLabel, null);
    for (const entry of rowEntries) push(formatPluginActionRow(entry, width), entry);
  }
  if (surfaceEntries.length > 0) {
    if (rows.length > 0) push("", null);
    push(surfaceLabel, null);
    for (const entry of surfaceEntries) push(formatPluginActionRow(entry, width), entry);
  }

  return {
    rows,
    ids,
    entriesByKey,
    emptyText: "No plugin adds an action here.",
  };
}
