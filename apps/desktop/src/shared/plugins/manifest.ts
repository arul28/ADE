/**
 * `plugin.json` — the ADE plugin manifest contract.
 *
 * This module is the all-client shared half of the plugin platform: pure types
 * plus a pure parser, no React, no Electron, no Node built-ins — mirroring
 * `../adeCard.ts`, which is likewise imported by the desktop renderer AND by
 * `apps/ade-cli`.
 *
 * Two rules the whole plugin contract rests on:
 *
 * 1. **Strict on known keys, tolerant of unknown ones.** A manifest written
 *    against a newer ADE must still load on an older one: fields this build has
 *    never heard of are dropped, not rejected. But a key we DO know, carrying
 *    the wrong shape, is an error — silently ignoring a malformed `sockets`
 *    entry would ship a plugin that looks installed and contributes nothing,
 *    which is the worst of both worlds. {@link parsePluginManifest} therefore
 *    returns errors AND a manifest whenever the identity fields survive.
 * 2. **The plugin id is a path component.** It names a directory under
 *    `~/.ade/plugins/`, a secret namespace, and a sync-table primary key, so it
 *    is validated against one narrow character class here and nowhere else.
 *    Anything that would traverse, collide case-insensitively, or need quoting
 *    is refused at parse time rather than defended against at every use site.
 *
 * Version policy: this file IS the manifest shape. `vocabVersion` in the manifest
 * is the panel-schema vocabulary version, which moves independently (see
 * `./vocabulary.ts`).
 */

import {
  PLUGIN_SOCKET_KINDS,
  PLUGIN_SOCKET_REQUIREMENTS,
  PLUGIN_SURFACE_IDS,
  type PluginSocketKind,
  type PluginSocketRequirementField,
  type PluginSurfaceId,
} from "./sockets";
import { isRecord, oneOf, trimmed as trimmedString } from "./parse";

/**
 * Plugin ids are lowercase-kebab and short: they become a directory name, a
 * `plugin:<id>:<NAME>` secret namespace, a CRR primary-key component, and a
 * `ade <id> <cmd>` CLI word. Case-insensitive filesystems make mixed case a
 * collision hazard, so uppercase is refused rather than folded.
 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** `major.minor.patch` with an optional prerelease/build tail. */
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** CSS hex accent, 3- or 6-digit. Themes carry full token sets instead. */
const PLUGIN_ACCENT_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * An accent reaches a CSS custom property, so every layer that accepts one has
 * to judge it the same way. Exported for the directory parser, which reads
 * accents from third-party index entries the manifest parser never sees.
 */
export function isValidPluginAccent(value: unknown): value is string {
  return typeof value === "string" && PLUGIN_ACCENT_PATTERN.test(value);
}

/**
 * Relative POSIX paths only. A manifest may not reach outside its own install
 * directory, and the host resolves these against the plugin root.
 */
const PLUGIN_RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/;

/** Theme token allowlist — see D15. Only design-token namespaces are settable. */
export const PLUGIN_THEME_TOKEN_PREFIXES = [
  "--color-",
  "--shell-",
  "--chat-",
  "--work-",
  "--pane-",
  "--pr-",
  "--gradient-",
] as const;

/**
 * The full shape of a settable token name, not just its namespace.
 *
 * A prefix check alone accepts anything after the prefix, and the name is
 * interpolated into a stylesheet on the left of the colon — so a "name" like
 * `--color-x: red } html * { display: none } .z{a` closes ADE's own rule and
 * writes arbitrary CSS, and `--color-x: url(https://…)` reaches the network.
 * Both halves are required: the namespace prefix AND this shape.
 */
export const PLUGIN_THEME_TOKEN_NAME_PATTERN = /^--[a-z0-9-]{1,60}$/;

/**
 * `webview` is the escape hatch from the vocabulary, and it is deliberately the
 * narrowest one.
 *
 * A tab or a pane renders a panel schema, which every client interprets with its
 * own widgets — that is what lets one plugin work on desktop, iOS, web and the
 * TUI at once. A webview renders the plugin's own HTML inside a sandboxed guest
 * on the desktop and nowhere else, so it buys unlimited UI at the cost of being
 * a single-platform surface. Choose it when the vocabulary genuinely cannot say
 * what the plugin needs to draw, not to avoid learning the vocabulary.
 *
 * Every webview surface still declares a `panelId`. That panel is what iOS, the
 * web client and the TUI show in its place, so "desktop-only" degrades to the
 * plugin's own sentence and an open-on-desktop link rather than to a blank
 * space. It is required, not optional, precisely because the fallback is the
 * thing that keeps the cross-surface promise honest.
 */
export type PluginSurfaceKind = "tab" | "pane" | "webview";

/**
 * Tabs that ship compiled into the app and can be *gated* by a plugin rather
 * than rendered by one.
 *
 * Some of ADE's own tabs cannot be expressed as vocabulary — the Graph is an
 * interactive canvas, not a list of rows — but they are still optional weight
 * in the rail. A surface with `builtin` set does not draw anything: it says
 * "this plugin owns the existing tab named here", and the client renders its
 * own compiled page in place of a plugin panel. Uninstalling the plugin takes
 * every entry point for that compiled surface out of the product. Routes and
 * deeplinks must fail closed too; a hidden rail item is not an access control.
 *
 * The list is CLOSED and lives here rather than in the renderer because every
 * client validates against it: a name outside it is a manifest typo, and
 * honouring it would produce a rail item that navigates nowhere.
 */
export const PLUGIN_BUILTIN_SURFACE_IDS = [
  "graph",
  "review",
  "history",
  "linear",
  "ios",
  "app-control",
] as const;

export type PluginBuiltinSurfaceId = (typeof PLUGIN_BUILTIN_SURFACE_IDS)[number];

export function isPluginBuiltinSurfaceId(value: unknown): value is PluginBuiltinSurfaceId {
  return PLUGIN_BUILTIN_SURFACE_IDS.some((id) => id === value);
}

/**
 * Which gated built-ins the phone has a page for.
 *
 * A `builtin` surface renders compiled code, not a panel schema, so "does it
 * appear on mobile" is a fact about what the iOS app SHIPS — not something a
 * manifest can decide. Linear is ported; the Graph canvas, Review, History, the
 * simulator pane and Electron Control are not, and declaring `mobile: true` on
 * one of them would put a rail entry in front of a renderer that does not exist.
 * So the table is the ceiling and the manifest may only narrow it.
 *
 * Keyed by the closed id list above, so adding a gateable surface without
 * deciding this question does not compile.
 */
export const PLUGIN_BUILTIN_SURFACE_MOBILE: Readonly<Record<PluginBuiltinSurfaceId, boolean>> = {
  graph: false,
  review: false,
  history: false,
  linear: true,
  ios: false,
  "app-control": false,
};

const SURFACE_KINDS: readonly PluginSurfaceKind[] = ["tab", "pane", "webview"];

export type PluginManifestSurface = {
  kind: PluginSurfaceKind;
  id: string;
  title: string;
  icon?: string;
  /**
   * The vocabulary panel this surface renders — and, for a `webview` surface,
   * the panel every non-desktop client renders in its place. Required on all
   * three kinds: see {@link PluginSurfaceKind}.
   */
  panelId: string;
  order?: number;
  /**
   * Names a compiled-in tab this surface gates instead of rendering. Only ever
   * present on an official manifest — see the trust note in {@link parseSurfaces}.
   */
  builtin?: PluginBuiltinSurfaceId;
  /**
   * `webview` only: the HTML file the sandboxed guest loads, relative to the
   * plugin's install directory. Served over `ade-plugin://<pluginId>/…`, which
   * exposes that directory and nothing above it.
   */
  entryHtml?: string;
  /**
   * Whether this surface appears on the phone.
   *
   * The parser always sets it, and sets the RESOLVED answer rather than the raw
   * manifest value: what the author asked for is only ever narrowed, by the two
   * ceilings in {@link parseSurfaces}. Optional in the type because a
   * hand-written surface literal (the bundled Marketplace index, a fixture) is
   * not obliged to restate a default — absent reads as "whatever this kind does
   * today", which is what {@link pluginPanelShowsOnMobile} applies.
   */
  mobile?: boolean;
};

export type PluginManifestPanel = {
  id: string;
  /** Relative path to the vocabulary JSON this panel renders by default. */
  schemaFile?: string;
  title?: string;
  icon?: string;
};

export type PluginManifestSocket = {
  socket: PluginSocketKind;
  surface: PluginSurfaceId;
  /** Stable per-plugin id for this contribution; identity for dedupe/ordering. */
  id: string;
  order?: number;
  label?: string;
  icon?: string;
  /** `detail-section` / `file-viewer` render this panel. */
  panelId?: string;
  /** `toolbar-action` / `row-menu-item` invoke this plugin action. */
  actionId?: string;
  /** `file-viewer` only: lowercase extensions including the dot. */
  extensions?: string[];
  /** `filter-chip` only. */
  filterKey?: string;
};

export type PluginSettingKind = "text" | "secret" | "select" | "toggle" | "number";

export type PluginManifestSetting = {
  key: string;
  kind: PluginSettingKind;
  label: string;
  description?: string;
  /** `select` only: static options, or an action that returns them. */
  options?: { value: string; label: string }[];
  optionsAction?: string;
  default?: string | number | boolean;
};

export type PluginManifestCollection = {
  /** Whether rows in this collection ride the sync layer to other devices. */
  sync: boolean;
};

export type PluginManifestTheme = {
  tokens: {
    dark?: Record<string, string>;
    light?: Record<string, string>;
  };
};

export type PluginManifest = {
  name: string;
  version: string;
  displayName: string;
  description: string;
  icon?: string;
  accent?: string;
  minAdeVersion?: string;
  vocabVersion: number;
  /** Absent for UI-only plugins (themes, static panels) — they run no code. */
  entry?: string;
  surfaces: PluginManifestSurface[];
  panels: PluginManifestPanel[];
  sockets: PluginManifestSocket[];
  collections: Record<string, PluginManifestCollection>;
  settings: PluginManifestSetting[];
  /** Subcommand words reachable as `ade <name> <cmd>`. */
  cli: string[];
  /** Relative paths to agent-skill directories this plugin contributes. */
  skills: string[];
  theme?: PluginManifestTheme;
  official: boolean;
};

export type PluginManifestParseResult = {
  /** Present whenever identity (`name` + `version`) parsed; may still have errors. */
  manifest: PluginManifest | null;
  /** Fatal problems: the field was known and malformed. */
  errors: string[];
  /** Non-fatal: a known field held an entry we dropped, or a key we ignored. */
  warnings: string[];
};

export function isValidPluginId(value: unknown): value is string {
  return typeof value === "string" && PLUGIN_ID_PATTERN.test(value);
}

export function isValidPluginVersion(value: unknown): value is string {
  return typeof value === "string" && PLUGIN_VERSION_PATTERN.test(value);
}

/**
 * Guard for every manifest-declared path before it is joined to the plugin
 * root. Rejects absolute paths, `..` segments, backslashes, and control bytes.
 */
export function isSafePluginRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && PLUGIN_RELATIVE_PATH_PATTERN.test(value);
}

export function isAllowedPluginThemeToken(key: string): boolean {
  return typeof key === "string"
    && PLUGIN_THEME_TOKEN_NAME_PATTERN.test(key)
    && PLUGIN_THEME_TOKEN_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const PLUGIN_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseIdentifier(value: unknown): string | null {
  const text = trimmedString(value);
  if (!text || text.length > 64) return null;
  return PLUGIN_IDENTIFIER_PATTERN.test(text) ? text : null;
}

/**
 * The same rule {@link parseIdentifier} applies, for layers that need to judge
 * a panel or socket id they did not parse. Exported so there is ONE spelling:
 * a second regex at the IPC boundary disagreed with this one by a length cap,
 * so an id this parser accepted that layer refused.
 */
export function isValidPluginManifestIdentifier(value: unknown): value is string {
  return parseIdentifier(value) !== null;
}

/**
 * `official` gates `builtin`, and it is worth being precise about what that
 * gate is and is not.
 *
 * It is NOT proof of provenance: `official` is a field the manifest sets about
 * itself, and this parser is pure — it has no directory, no signature and no
 * filesystem. Provenance is established elsewhere, by the directory entry the
 * installer checks (`registryIndex.ts`: an official entry carries a per-version
 * sha256 that must match the fetched tree).
 *
 * What the gate buys is a floor: a manifest that does not even claim official
 * tier cannot claim a compiled-in tab, so a copied or mistyped manifest fails
 * loudly here instead of quietly taking over a rail item. And the ceiling on
 * getting it wrong is deliberately low — `builtin` decides whether one of the
 * user's OWN pages appears in their OWN rail, and names a route from a closed
 * list. It runs no code, reads no data and reaches nothing the app was not
 * already shipping.
 */
function parseSurfaces(raw: unknown, ctx: ParseContext, official: boolean): PluginManifestSurface[] {
  return parseArray(raw, "surfaces", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const kind = SURFACE_KINDS.find((candidate) => candidate === entry.kind) ?? null;
    if (!kind) return ctx.drop(`${label}.kind must be "tab", "pane" or "webview"`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    const title = trimmedString(entry.title);
    if (!title) return ctx.drop(`${label}.title is required`);
    const panelId = parseIdentifier(entry.panelId);
    if (!panelId) return ctx.drop(`${label}.panelId is missing or not an identifier`);
    let entryHtml: string | null = null;
    const declaredEntryHtml = entry.entryHtml;
    if (kind === "webview") {
      // Dropped, not warned: a webview surface with no page is not a degraded
      // surface, it is a surface that would load nothing.
      if (!isSafePluginRelativePath(declaredEntryHtml)) {
        return ctx.drop(`${label}.entryHtml must be a relative path inside the plugin`);
      }
      if (!/\.html?$/i.test(declaredEntryHtml)) {
        return ctx.drop(`${label}.entryHtml must name an .html file`);
      }
      entryHtml = declaredEntryHtml;
    } else if (declaredEntryHtml !== undefined) {
      ctx.warnings.push(`${label}.entryHtml applies only to a "webview" surface — ignored`);
    }
    let builtin: PluginBuiltinSurfaceId | null = null;
    if (entry.builtin !== undefined) {
      const requested = trimmedString(entry.builtin);
      if (!isPluginBuiltinSurfaceId(requested)) {
        ctx.warnings.push(`${label}.builtin "${String(entry.builtin)}" is not a gateable built-in tab — ignored`);
      } else if (!official) {
        ctx.warnings.push(`${label}.builtin is honoured only for official plugins — ignored`);
      } else if (kind === "webview") {
        // A gate draws nothing; a webview draws everything. Honouring both would
        // ask the client which of the two pages it is looking at.
        ctx.warnings.push(`${label}.builtin cannot be combined with a "webview" surface — ignored`);
      } else {
        builtin = requested;
      }
    }
    // `mobile` is a narrowing switch, not a grant. The ceiling comes from what
    // the surface IS — a webview draws a desktop-only page, a gated built-in
    // draws whatever compiled page the phone ships for it — and the manifest may
    // only turn a mobile-capable surface off. A malformed value is treated as
    // absent rather than fatal: it costs the author a default, not a plugin.
    let declaredMobile: boolean | null = null;
    if (entry.mobile !== undefined) {
      if (typeof entry.mobile === "boolean") {
        declaredMobile = entry.mobile;
      } else {
        ctx.warnings.push(`${label}.mobile must be true or false — ignored`);
      }
    }
    const mobileCeiling = kind === "webview"
      ? false
      : builtin
        ? PLUGIN_BUILTIN_SURFACE_MOBILE[builtin]
        : true;
    if (declaredMobile === true && !mobileCeiling) {
      ctx.warnings.push(
        kind === "webview"
          ? `${label}.mobile cannot be true on a "webview" surface — the phone renders its panelId panel instead`
          : `${label}.mobile cannot be true for the built-in "${String(builtin)}" surface, which the phone has no page for — ignored`,
      );
    }
    return {
      kind,
      id,
      title,
      panelId,
      ...(trimmedString(entry.icon) ? { icon: trimmedString(entry.icon)! } : {}),
      ...(typeof entry.order === "number" && Number.isFinite(entry.order) ? { order: entry.order } : {}),
      ...(builtin ? { builtin } : {}),
      ...(entryHtml ? { entryHtml } : {}),
      mobile: mobileCeiling && (declaredMobile ?? true),
    };
  });
}

/**
 * Whether the phone should LIST the panel a surface names.
 *
 * Not the same question as `surface.mobile`, and the webview is why. A webview
 * page is desktop-only by construction, but the panel it names is exactly what
 * every non-desktop client renders in its place — filtering that panel out would
 * delete the fallback the surface exists to provide. A gated built-in has no
 * such consolation: the phone either ships the compiled page or has nothing at
 * all to show, so there the surface's answer is the panel's answer.
 *
 * Exported because two layers ask it — the panel seeder and the SDK's
 * `panels.update` — and a second spelling of this rule is a second answer.
 */
export function pluginPanelShowsOnMobile(surface: PluginManifestSurface): boolean {
  if (surface.kind === "webview") return true;
  return surface.mobile !== false;
}

function parsePanels(raw: unknown, ctx: ParseContext): PluginManifestPanel[] {
  return parseArray(raw, "panels", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    const schemaFile = entry.schemaFile === undefined ? null : entry.schemaFile;
    if (schemaFile !== null && !isSafePluginRelativePath(schemaFile)) {
      return ctx.drop(`${label}.schemaFile must be a relative path inside the plugin`);
    }
    return {
      id,
      ...(schemaFile !== null ? { schemaFile: schemaFile as string } : {}),
      ...(trimmedString(entry.title) ? { title: trimmedString(entry.title)! } : {}),
      ...(trimmedString(entry.icon) ? { icon: trimmedString(entry.icon)! } : {}),
    };
  });
}

function parseSockets(raw: unknown, ctx: ParseContext): PluginManifestSocket[] {
  return parseArray(raw, "sockets", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const socket = oneOf(entry.socket, PLUGIN_SOCKET_KINDS);
    if (!socket) return ctx.drop(`${label}.socket is not a known socket kind`);
    const surface = oneOf(entry.surface, PLUGIN_SURFACE_IDS);
    if (!surface) return ctx.drop(`${label}.surface is not a core surface`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    const panelId = entry.panelId === undefined ? null : parseIdentifier(entry.panelId);
    if (entry.panelId !== undefined && !panelId) return ctx.drop(`${label}.panelId is not an identifier`);
    const actionId = entry.actionId === undefined ? null : parseIdentifier(entry.actionId);
    if (entry.actionId !== undefined && !actionId) return ctx.drop(`${label}.actionId is not an identifier`);
    const extensions = entry.extensions === undefined
      ? null
      : Array.isArray(entry.extensions)
        ? entry.extensions
          .map((value) => trimmedString(value)?.toLowerCase() ?? null)
          .filter((value): value is string => Boolean(value) && value!.startsWith("."))
        : null;
    if (entry.extensions !== undefined && extensions === null) {
      return ctx.drop(`${label}.extensions must be an array of ".ext" strings`);
    }
    const declaredLabel = trimmedString(entry.label);
    // A socket that renders nothing and invokes nothing is a manifest typo, not
    // a contribution. Refusing it here is what keeps empty rows off the surface.
    // The requirement table is shared with the payload validator and the
    // renderer's manifest→payload mapping, so "parses clean but contributes
    // nothing" — the old failure for a badge with no label — cannot recur.
    const present: Record<PluginSocketRequirementField, boolean> = {
      label: declaredLabel !== null,
      actionId: actionId !== null,
      panelId: panelId !== null,
      extensions: Boolean(extensions && extensions.length > 0),
    };
    for (const field of PLUGIN_SOCKET_REQUIREMENTS[socket].manifest) {
      if (!present[field]) return ctx.drop(`${label} requires ${field} for socket "${socket}"`);
    }
    return {
      socket,
      surface,
      id,
      ...(typeof entry.order === "number" && Number.isFinite(entry.order) ? { order: entry.order } : {}),
      ...(declaredLabel ? { label: declaredLabel } : {}),
      ...(trimmedString(entry.icon) ? { icon: trimmedString(entry.icon)! } : {}),
      ...(panelId ? { panelId } : {}),
      ...(actionId ? { actionId } : {}),
      ...(extensions && extensions.length ? { extensions } : {}),
      ...(trimmedString(entry.filterKey) ? { filterKey: trimmedString(entry.filterKey)! } : {}),
    };
  });
}

function parseSettings(raw: unknown, ctx: ParseContext): PluginManifestSetting[] {
  const kinds: PluginSettingKind[] = ["text", "secret", "select", "toggle", "number"];
  return parseArray(raw, "settings", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const key = parseIdentifier(entry.key);
    if (!key) return ctx.drop(`${label}.key is missing or not an identifier`);
    const kind = kinds.find((candidate) => candidate === entry.kind);
    if (!kind) return ctx.drop(`${label}.kind is not a known setting kind`);
    const settingLabel = trimmedString(entry.label);
    if (!settingLabel) return ctx.drop(`${label}.label is required`);
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((option) => {
        if (!isRecord(option)) return [];
        const value = trimmedString(option.value);
        const optionLabel = trimmedString(option.label) ?? value;
        return value && optionLabel ? [{ value, label: optionLabel }] : [];
      })
      : null;
    const optionsAction = entry.optionsAction === undefined ? null : parseIdentifier(entry.optionsAction);
    const defaultValue = typeof entry.default === "string"
      || typeof entry.default === "number"
      || typeof entry.default === "boolean"
      ? entry.default
      : null;
    return {
      key,
      kind,
      label: settingLabel,
      ...(trimmedString(entry.description) ? { description: trimmedString(entry.description)! } : {}),
      ...(options && options.length ? { options } : {}),
      ...(optionsAction ? { optionsAction } : {}),
      ...(defaultValue !== null ? { default: defaultValue } : {}),
    };
  });
}

function parseCollections(raw: unknown, ctx: ParseContext): Record<string, PluginManifestCollection> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    ctx.errors.push("collections must be an object keyed by collection name");
    return {};
  }
  const collections: Record<string, PluginManifestCollection> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = parseIdentifier(key);
    if (!name) {
      ctx.warnings.push(`collections["${key}"] dropped: name is not an identifier`);
      continue;
    }
    collections[name] = { sync: isRecord(value) && value.sync === true };
  }
  return collections;
}

function parseTheme(raw: unknown, ctx: ParseContext): PluginManifestTheme | null {
  if (raw === undefined) return null;
  if (!isRecord(raw) || !isRecord(raw.tokens)) {
    ctx.errors.push("theme must be an object with a tokens map");
    return null;
  }
  const readMode = (mode: "dark" | "light"): Record<string, string> | null => {
    const source = raw.tokens as Record<string, unknown>;
    const modeTokens = source[mode];
    if (modeTokens === undefined) return null;
    if (!isRecord(modeTokens)) {
      ctx.errors.push(`theme.tokens.${mode} must be an object`);
      return null;
    }
    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(modeTokens)) {
      if (!isAllowedPluginThemeToken(key)) {
        ctx.warnings.push(`theme.tokens.${mode}["${key}"] dropped: token is outside the plugin theme allowlist`);
        continue;
      }
      const text = trimmedString(value);
      if (!text) {
        ctx.warnings.push(`theme.tokens.${mode}["${key}"] dropped: value is not a non-empty string`);
        continue;
      }
      tokens[key] = text;
    }
    return tokens;
  };
  const dark = readMode("dark");
  const light = readMode("light");
  if (!dark && !light) return null;
  return {
    tokens: {
      ...(dark ? { dark } : {}),
      ...(light ? { light } : {}),
    },
  };
}

function parseStringList(
  raw: unknown,
  field: string,
  ctx: ParseContext,
  accept: (value: string) => boolean,
): string[] {
  return parseArray(raw, field, ctx, (entry, label) => {
    const text = trimmedString(entry);
    if (!text || !accept(text)) return ctx.drop(`${label} is not a valid ${field} entry`);
    return text;
  });
}

type ParseContext = {
  errors: string[];
  warnings: string[];
  /** Record a dropped array entry and yield `null` so the caller filters it. */
  drop: (message: string) => null;
};

function parseArray<T>(
  raw: unknown,
  field: string,
  ctx: ParseContext,
  parseEntry: (entry: unknown, label: string) => T | null,
): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    ctx.errors.push(`${field} must be an array`);
    return [];
  }
  const parsed: T[] = [];
  raw.forEach((entry, index) => {
    const value = parseEntry(entry, `${field}[${index}]`);
    if (value !== null) parsed.push(value);
  });
  return parsed;
}

/**
 * Parse a manifest object (already JSON-decoded).
 *
 * Returns a manifest whenever identity survives, so a plugin with one bad
 * socket still installs and the operator sees exactly which entry was refused.
 * Callers decide policy: the installer refuses on `errors.length`, the host
 * loads on warnings alone.
 */
export function parsePluginManifest(raw: unknown): PluginManifestParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ctx: ParseContext = {
    errors,
    warnings,
    drop: (message) => {
      warnings.push(`${message} — entry dropped`);
      return null;
    },
  };

  if (!isRecord(raw)) {
    return { manifest: null, errors: ["manifest must be a JSON object"], warnings };
  }

  const name = trimmedString(raw.name);
  if (!name) {
    errors.push("name is required");
  } else if (!isValidPluginId(name)) {
    errors.push(`name "${name}" must be lowercase kebab-case, start with a letter, and be 64 characters or fewer`);
  }
  const version = trimmedString(raw.version);
  if (!version) {
    errors.push("version is required");
  } else if (!isValidPluginVersion(version)) {
    errors.push(`version "${version}" must be major.minor.patch`);
  }

  const entry = raw.entry === undefined ? null : raw.entry;
  if (entry !== null && !isSafePluginRelativePath(entry)) {
    errors.push("entry must be a relative path inside the plugin directory");
  }

  const accent = raw.accent === undefined ? null : trimmedString(raw.accent);
  if (raw.accent !== undefined && (!accent || !PLUGIN_ACCENT_PATTERN.test(accent))) {
    errors.push("accent must be a hex color such as #7C6FF0");
  }

  const vocabVersionRaw = raw.vocabVersion;
  const vocabVersion = typeof vocabVersionRaw === "number" && Number.isInteger(vocabVersionRaw) && vocabVersionRaw > 0
    ? vocabVersionRaw
    : null;
  if (vocabVersionRaw !== undefined && vocabVersion === null) {
    errors.push("vocabVersion must be a positive integer");
  }

  const minAdeVersion = raw.minAdeVersion === undefined ? null : trimmedString(raw.minAdeVersion);
  if (raw.minAdeVersion !== undefined && (!minAdeVersion || !isValidPluginVersion(minAdeVersion))) {
    errors.push("minAdeVersion must be major.minor.patch");
  }

  const official = raw.official === true;
  const surfaces = parseSurfaces(raw.surfaces, ctx, official);
  const panels = parsePanels(raw.panels, ctx);
  const sockets = parseSockets(raw.sockets, ctx);
  const settings = parseSettings(raw.settings, ctx);
  const collections = parseCollections(raw.collections, ctx);
  const theme = parseTheme(raw.theme, ctx);
  const cli = parseStringList(raw.cli, "cli", ctx, (value) => /^[a-z][a-z0-9-]{0,31}$/.test(value));
  const skills = parseStringList(raw.skills, "skills", ctx, isSafePluginRelativePath);

  // Identity must be VALID here, not merely present: `manifest.name` is joined
  // into a filesystem path and a secret namespace, so a caller that ignores
  // `errors` must never be handed one that failed validation.
  if (!isValidPluginId(name) || !isValidPluginVersion(version)) {
    return { manifest: null, errors, warnings };
  }

  const displayName = trimmedString(raw.displayName) ?? name;
  const description = trimmedString(raw.description) ?? "";

  return {
    manifest: {
      name,
      version,
      displayName,
      description,
      ...(trimmedString(raw.icon) ? { icon: trimmedString(raw.icon)! } : {}),
      ...(accent ? { accent } : {}),
      ...(minAdeVersion ? { minAdeVersion } : {}),
      vocabVersion: vocabVersion ?? 1,
      ...(typeof entry === "string" ? { entry } : {}),
      surfaces,
      panels,
      sockets,
      collections,
      settings,
      cli,
      skills,
      ...(theme ? { theme } : {}),
      official,
    },
    errors,
    warnings,
  };
}

/** Parse manifest JSON text. A syntax error is fatal and reported as an error. */
export function parsePluginManifestJson(text: string): PluginManifestParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    return {
      manifest: null,
      errors: [`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
  return parsePluginManifest(decoded);
}

/** True when the plugin ships code the host must run in a child process. */
export function pluginHasRuntimeEntry(manifest: PluginManifest): boolean {
  return typeof manifest.entry === "string" && manifest.entry.length > 0;
}

/**
 * Compare two `major.minor.patch` strings. Prerelease tails are ignored — the
 * only consumer is the `minAdeVersion` gate, which is a floor, not an ordering.
 */
export function comparePluginVersions(left: string, right: string): number {
  const parts = (value: string): number[] => value.split(/[-+]/, 1)[0]!.split(".").map((part) => Number(part) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** `false` when the host is older than the manifest's declared floor. */
export function isPluginSupportedByAdeVersion(
  manifest: PluginManifest,
  adeVersion: string | null | undefined,
): boolean {
  if (!manifest.minAdeVersion) return true;
  const host = trimmedString(adeVersion);
  // An unknown host version must not lock the user out of their own plugins.
  if (!host || !isValidPluginVersion(host)) return true;
  return comparePluginVersions(host, manifest.minAdeVersion) >= 0;
}
