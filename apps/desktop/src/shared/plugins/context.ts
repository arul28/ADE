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
 * Fields are optional-tolerant on read ({@link parsePluginSurfaceContext}
 * accepts a partial object and fills what it can) because contexts cross a
 * version boundary: a newer client may send fields this build has never heard
 * of, and an older one may omit fields this build would like.
 */

import { PLUGIN_SURFACE_IDS, type PluginEntityKind, type PluginSurfaceId } from "./sockets";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function prState(value: unknown): PluginPrContext["state"] {
  return value === "open" || value === "closed" || value === "merged" || value === "draft" ? value : "unknown";
}

function ciStatus(value: unknown): PluginPrContext["ciStatus"] {
  return value === "passing" || value === "failing" || value === "pending" || value === "none" ? value : "unknown";
}

/** Lowercase extension including the dot, derived from a path. */
export function pluginFileExtension(filePath: string): string | null {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot).toLowerCase();
}

/**
 * Narrow an untrusted context object arriving from a client or a plugin call.
 * Returns `null` only when `kind` itself is unrecognized — a context missing
 * optional fields still parses, because refusing it would blank a socket over
 * version skew.
 */
export function parsePluginSurfaceContext(raw: unknown): PluginSurfaceContext | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "pr": {
      const number = num(raw.number);
      if (number === null) return null;
      return {
        kind: "pr",
        number: Math.trunc(number),
        title: str(raw.title) ?? "",
        branch: str(raw.branch),
        state: prState(raw.state),
        ciStatus: ciStatus(raw.ciStatus),
      };
    }
    case "lane": {
      const id = str(raw.id);
      if (!id) return null;
      return {
        kind: "lane",
        id,
        name: str(raw.name) ?? id,
        branch: str(raw.branch),
        machineKey: str(raw.machineKey),
        dirty: raw.dirty === true,
      };
    }
    case "session": {
      const id = str(raw.id);
      if (!id) return null;
      return {
        kind: "session",
        id,
        title: str(raw.title) ?? "",
        provider: str(raw.provider),
        status: str(raw.status),
      };
    }
    case "file": {
      const filePath = str(raw.path);
      if (!filePath) return null;
      return {
        kind: "file",
        path: filePath,
        size: num(raw.size),
        extension: str(raw.extension)?.toLowerCase() ?? pluginFileExtension(filePath),
        workspaceId: str(raw.workspaceId),
      };
    }
    case "automation": {
      const automationId = str(raw.id);
      if (!automationId) return null;
      return {
        kind: "automation",
        id: automationId,
        name: str(raw.name) ?? automationId,
        enabled: raw.enabled !== false,
      };
    }
    case "surface": {
      const surface = PLUGIN_SURFACE_IDS.find((id) => id === raw.surface);
      return surface ? { kind: "surface", surface } : null;
    }
    default:
      return null;
  }
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
