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

import type { PluginEntityKind, PluginSurfaceId } from "./sockets";

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
    case "surface":
      return null;
  }
}
