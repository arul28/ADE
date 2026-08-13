/**
 * Typed, read-only context objects handed to a plugin at a socket.
 *
 * Pure types plus pure narrowing helpers — no React, no Electron, no Node.
 *
 * Every socket render and every plugin action invoked from a row receives one
 * of these instead of the host's own model object. That indirection is the
 * point:
 *
 * 1. **It is a projection, not a handle.** A plugin gets the handful of fields
 *    its UI needs and no way to reach the lane's worktree, the PR's token, or
 *    the session's transcript. Widening a context is a deliberate platform
 *    change, reviewed once here, rather than an accident of passing an internal
 *    type across the boundary.
 * 2. **It is stable across four clients.** Desktop, TUI, iOS and web all build
 *    the same object from their own local models, so a plugin author reads one
 *    definition and a contribution behaves identically everywhere.
 *
 * Fields are optional-tolerant by construction, because contexts cross a version
 * boundary: a newer client may send fields this build has never heard of, and an
 * older one may omit fields this build would like.
 */

import type { PluginDialogKind, PluginEntityKind, PluginSurfaceId } from "./sockets";

export type PluginPrContext = {
  kind: "pr";
  number: number;
  title: string;
  branch: string | null;
  state: "open" | "closed" | "merged" | "draft" | "unknown";
  ciStatus: "passing" | "failing" | "pending" | "none" | "unknown";
};

export type PluginLaneContext = {
  kind: "lane";
  id: string;
  name: string;
  branch: string | null;
  machineKey: string | null;
  dirty: boolean;
};

export type PluginSessionContext = {
  kind: "session";
  id: string;
  title: string;
  provider: string | null;
  status: string | null;
};

export type PluginFileContext = {
  kind: "file";
  path: string;
  size: number | null;
  extension: string | null;
  workspaceId: string | null;
};

/**
 * One automation rule, for the `automation` entity kind.
 *
 * Minimal on purpose: a plugin badging or acting on an automation needs to know
 * which rule and whether it is live, and nothing about its schedule, its ingress
 * configuration or its run history — all of which are ADE's model to change.
 */
export type PluginAutomationContext = {
  kind: "automation";
  id: string;
  name: string;
  enabled: boolean;
};

/**
 * The live chat composer, for the `composer-action` socket.
 *
 * The one context that carries the user's own unsent words. That is deliberate
 * and it is the whole point of the socket: a button that rewrites, translates,
 * or expands a prompt cannot do its job from a session id, and a plugin that
 * had to ask the user to paste their draft somewhere else would not be a
 * composer button at all. Installing a plugin grants it — the same grant that
 * already lets its child process read any file the user can.
 *
 * `draft` is read at INVOKE time, never at render time: the button is pressed
 * against the text on screen at that moment, not the text that was there when
 * the row last rendered.
 */
export type PluginComposerContext = {
  kind: "composer";
  /**
   * The chat this composer sends to. Null on a composer that has not started
   * one yet (the hero composer, a fresh Work pane) — which is also why a
   * composer-action carries no dynamic per-entity contribution there.
   */
  sessionId: string | null;
  /** The open project binding's stable key. Null on a projectless composer. */
  projectKey: string | null;
  /** Absolute checkout root the composer sends into, when there is one. */
  projectRoot: string | null;
  /** The lane selected in this window, when the composer sits inside one. */
  laneId: string | null;
  /** The full unsent draft, verbatim. */
  draft: string;
  /**
   * Caret offset into `draft`. Null when the composer holds no live caret —
   * an action that inserts then appends, which is what a plugin should want
   * when the user has not put their cursor anywhere in particular.
   */
  cursor: number | null;
};

/**
 * One of ADE's own dialogs, for the `dialog-section` socket.
 *
 * The subject is the dialog, not the thing it will produce — create-lane has no
 * lane yet and create-PR has no PR yet, so a lane or PR context would have had
 * to be half-null on the case it exists for. What a section actually needs is
 * which dialog it is in and what the dialog is working from, which is this.
 *
 * `laneId` is the lane the dialog is ABOUT (manage-lane) or the lane the PR
 * comes from (create-pr), and null on create-lane, where nothing exists yet.
 */
export type PluginDialogContext = {
  kind: "dialog";
  dialog: PluginDialogKind;
  laneId: string | null;
  laneName: string | null;
  branch: string | null;
  /** The open project binding's stable key. Null on a projectless window. */
  projectKey: string | null;
};

/**
 * The activity pane, for the `activity-entry` socket.
 *
 * `entryId` is the plugin's own contribution id — the row the user pressed —
 * because an activity list is the one surface where a plugin routinely places
 * several entries that share an action, and "which one" is the only thing the
 * handler cannot work out for itself.
 */
export type PluginActivityContext = {
  kind: "activity";
  entryId: string;
  projectKey: string | null;
  /** The lane in view, when the pane is scoped to one. */
  laneId: string | null;
};

/** A surface with no per-entity subject (toolbar actions, empty states, chips). */
export type PluginSurfaceOnlyContext = {
  kind: "surface";
  surface: PluginSurfaceId;
};

export type PluginSurfaceContext =
  | PluginPrContext
  | PluginLaneContext
  | PluginSessionContext
  | PluginFileContext
  | PluginAutomationContext
  | PluginComposerContext
  | PluginDialogContext
  | PluginActivityContext
  | PluginSurfaceOnlyContext;

/** Lowercase extension including the dot, derived from a path. */
export function pluginFileExtension(filePath: string): string | null {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot).toLowerCase();
}

/**
 * The `(entityKind, entityId)` pair a context maps to in `plugin_contributions`.
 * `null` for surface-only contexts, which carry no per-entity row.
 */
export function pluginContributionKeyForContext(
  context: PluginSurfaceContext,
): { entityKind: PluginEntityKind; entityId: string } | null {
  switch (context.kind) {
    case "pr":
      return { entityKind: "pr", entityId: String(context.number) };
    case "lane":
      return { entityKind: "lane", entityId: context.id };
    case "session":
      return { entityKind: "session", entityId: context.id };
    case "file":
      return { entityKind: "file", entityId: context.path };
    case "automation":
      return { entityKind: "automation", entityId: context.id };
    // A composer belongs to its chat, so a plugin publishes per-session rows to
    // change what its composer button says for one conversation. Before the
    // chat exists there is nothing to key on, and the composer then shows the
    // plugin's manifest declaration only.
    case "composer":
      return context.sessionId ? { entityKind: "session", entityId: context.sessionId } : null;
    // A dialog belongs to the lane it is about, so a plugin publishes per-lane
    // rows to change what its section says for one lane. Create-lane has no
    // subject yet and shows the manifest declaration only, the same way a
    // composer does before its chat exists.
    case "dialog":
      return context.laneId ? { entityKind: "lane", entityId: context.laneId } : null;
    // An activity entry is published against whatever it is about — a session,
    // a lane, a PR — and the pane reads all of them, so the context itself
    // keys nothing. `entryId` names which row was pressed, not which entity.
    case "activity":
    case "surface":
      return null;
  }
}

/**
 * The `(entityKind, entityId)` a SURFACE-scoped dynamic row is published under.
 *
 * Separate from {@link pluginContributionKeyForContext}, which answers null for
 * a surface-only context, and deliberately so — the two answer different
 * questions and one function cannot answer both without breaking a caller.
 * "Which entity is this contribution about" is null for a toolbar: a toolbar
 * button is about the tab, not about a row on it, and the filter-matching path
 * relies on that null to mean "this subject is not filterable, keep it".
 * "Where does a plugin address the tab itself" has a real answer, and this is
 * it: entity kind `surface`, entity id the surface's own name.
 *
 * It matters because this is the only address a DYNAMIC `toolbar-action`,
 * `empty-state`, `filter-chip` or `file-viewer` has — those kinds sit on the
 * tab rather than on a row, so a plugin recomputing one per entity has nowhere
 * else to put it. Desktop reads its dynamic rows per surface and today asks for
 * the entity kind that surface carries (`lane` for Lanes, `pr` for PRs), so a
 * surface-scoped row published for Lanes is fetched by no one, while iOS reads
 * it. The same plugin's live filter chip appears on the phone and not on the
 * desktop.
 *
 * This is one of the two halves of closing that gap and the only half that
 * lives in shared code. The other is the per-surface read asking for `surface`
 * rows alongside its own entity kind, which belongs to the client.
 */
export function pluginSurfaceContributionKey(
  surface: PluginSurfaceId,
): { entityKind: PluginEntityKind; entityId: string } {
  return { entityKind: "surface", entityId: surface };
}
