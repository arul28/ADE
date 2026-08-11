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
 * Version policy: {@link PLUGIN_MANIFEST_VERSION} is the shape of THIS file.
 * `vocabVersion` in the manifest is the panel-schema vocabulary version, which
 * moves independently (see `./vocabulary.ts`).
 */

import { PLUGIN_SOCKET_KINDS, PLUGIN_SURFACE_IDS, type PluginSocketKind, type PluginSurfaceId } from "./sockets";

/** Shape version of the manifest contract implemented by this file. */
export const PLUGIN_MANIFEST_VERSION = 1;

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
 * Relative POSIX paths only. A manifest may not reach outside its own install
 * directory, and the host resolves these against the plugin root.
 */
const PLUGIN_RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/;

/** Theme token allowlist — see D15. Only design-token namespaces are settable. */
const PLUGIN_THEME_TOKEN_PREFIXES = [
  "--color-",
  "--shell-",
  "--chat-",
  "--work-",
  "--pane-",
  "--pr-",
  "--gradient-",
] as const;

export type PluginSurfaceKind = "tab" | "pane";

export type PluginManifestSurface = {
  kind: PluginSurfaceKind;
  id: string;
  title: string;
  icon?: string;
  panelId: string;
  order?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

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
  return PLUGIN_THEME_TOKEN_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function parseIdentifier(value: unknown): string | null {
  const text = trimmedString(value);
  if (!text || text.length > 64) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) ? text : null;
}

function parseSurfaces(raw: unknown, ctx: ParseContext): PluginManifestSurface[] {
  return parseArray(raw, "surfaces", ctx, (entry, label) => {
    if (!isRecord(entry)) return ctx.drop(`${label} is not an object`);
    const kind = entry.kind === "pane" ? "pane" : entry.kind === "tab" ? "tab" : null;
    if (!kind) return ctx.drop(`${label}.kind must be "tab" or "pane"`);
    const id = parseIdentifier(entry.id);
    if (!id) return ctx.drop(`${label}.id is missing or not an identifier`);
    const title = trimmedString(entry.title);
    if (!title) return ctx.drop(`${label}.title is required`);
    const panelId = parseIdentifier(entry.panelId);
    if (!panelId) return ctx.drop(`${label}.panelId is missing or not an identifier`);
    return {
      kind,
      id,
      title,
      panelId,
      ...(trimmedString(entry.icon) ? { icon: trimmedString(entry.icon)! } : {}),
      ...(typeof entry.order === "number" && Number.isFinite(entry.order) ? { order: entry.order } : {}),
    };
  });
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
    const socket = PLUGIN_SOCKET_KINDS.find((kind) => kind === entry.socket);
    if (!socket) return ctx.drop(`${label}.socket is not a known socket kind`);
    const surface = PLUGIN_SURFACE_IDS.find((id) => id === entry.surface);
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
    // A socket that renders nothing and invokes nothing is a manifest typo, not
    // a contribution. Refusing it here is what keeps empty rows off the surface.
    if ((socket === "detail-section" || socket === "file-viewer") && !panelId) {
      return ctx.drop(`${label} requires panelId for socket "${socket}"`);
    }
    if ((socket === "toolbar-action" || socket === "row-menu-item") && !actionId) {
      return ctx.drop(`${label} requires actionId for socket "${socket}"`);
    }
    if (socket === "file-viewer" && (!extensions || extensions.length === 0)) {
      return ctx.drop(`${label} requires at least one extension for socket "file-viewer"`);
    }
    return {
      socket,
      surface,
      id,
      ...(typeof entry.order === "number" && Number.isFinite(entry.order) ? { order: entry.order } : {}),
      ...(trimmedString(entry.label) ? { label: trimmedString(entry.label)! } : {}),
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

  const surfaces = parseSurfaces(raw.surfaces, ctx);
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
      official: raw.official === true,
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
