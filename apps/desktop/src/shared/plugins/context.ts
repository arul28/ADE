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
    case "surface":
      return null;
  }
}
