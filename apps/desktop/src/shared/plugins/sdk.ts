/**
 * Plugin SDK v0 — the contract between ADE and plugin code.
 *
 * Pure types and pure helpers. Imported by the daemon (which implements the
 * host half), by the child bootstrap (which implements the `ade` global), by
 * `apps/ade-cli` (the `ade plugin` command) and by the desktop renderer.
 *
 * The stability promise, in three parts:
 *
 * 1. **`SDK_VERSION` is the compatibility handshake, and it is additive.** The
 *    host announces it in the child's `hello` frame. A plugin written against
 *    v0 keeps working when the host moves to v1: methods are added, never
 *    removed or re-shaped. Anything that would break a shipped plugin needs a
 *    new method name, not a new signature on the old one.
 * 2. **Every budget is enforced by the WRITER, inside its transaction.** The
 *    constants below are not advice to the plugin — they are the numbers the
 *    host checks before a row lands, and a plugin that exceeds one gets a typed
 *    {@link PluginSdkErrorCode} refusal it can act on, never a silent truncation.
 *    `dbMaintenanceApi.ts`'s doctor pass re-exports these rather than
 *    redeclaring them, so the writer and the doctor can never disagree about
 *    a ceiling.
 * 3. **Transport is NDJSON over the child's stdio, one JSON object per line.**
 *    stdin is open for the RPC channel and nothing else; the child never reads
 *    user input, and the host gates every write on `writable`. Errors cross the
 *    boundary as {@link PluginStructuralError}, never as a stringified stack.
 *
 * Plugin code runs ONLY on the machine that owns the plugin. There is no
 * remote-execution path in v0: a device that lacks the plugin renders nothing
 * for it, and the data-owning machine computes every contribution.
 */

import type { PluginManifest, PluginManifestSetting } from "./manifest";
import type { PluginRegistryEntry } from "./registryIndex";
import type { PluginEntityKind, PluginSocketKind, PluginSurfaceId } from "./sockets";

/** SDK surface version announced to the child in `hello`. */
export const PLUGIN_SDK_VERSION = 0;

// ---------------------------------------------------------------------------
// Budgets (writer-enforced — see the module header)
// ---------------------------------------------------------------------------

/** Total `plugin_collections` bytes one plugin may hold on one machine. */
export const PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN = 2 * 1024 * 1024;

/** Total `plugin_collections` rows one plugin may hold. */
export const PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN = 4_000;

/** Largest single collection value. */
export const PLUGIN_COLLECTION_VALUE_MAX_BYTES = 64 * 1024;

/** Total `plugin_contributions` rows one plugin may publish. */
export const PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN = 2_000;

/** Largest single contribution payload. Contributions are glances, not pages. */
export const PLUGIN_CONTRIBUTION_PAYLOAD_MAX_BYTES = 4 * 1024;

/** Panels one plugin may register. */
export const PLUGIN_PANELS_MAX_PER_PLUGIN = 32;

/** Largest panel schema. Matches the vocabulary contract's own schema ceiling. */
export const PLUGIN_PANEL_SCHEMA_MAX_BYTES = 64 * 1024;

/** Collection and key names: identifiers, never paths. */
export const PLUGIN_COLLECTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
export const PLUGIN_COLLECTION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

/** Secret names, matching the project-secret store's own rule. */
export const PLUGIN_SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

/** Lines the host keeps per plugin for `ade plugin logs`. */
export const PLUGIN_LOG_RING_CAPACITY = 500;

/** Bytes retained per log line before truncation. */
export const PLUGIN_LOG_LINE_MAX_BYTES = 2_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The one string a budget refusal ever carries.
 *
 * Declared here rather than beside the budget-pruning constants in
 * `dbMaintenanceApi.ts` (which re-exports it) because both the SDK path and the
 * wire path have to agree, and only this module is importable from all of
 * them — daemon, child runtime, renderer and `apps/ade-cli`. A second spelling
 * would mean a caller branches correctly on one route and falls through to
 * "internal error" on the other.
 */
export const PLUGIN_BUDGET_EXCEEDED_CODE = "plugin_budget_exceeded";

export type PluginSdkErrorCode =
  | "plugin_not_found"
  | "plugin_disabled"
  | "plugin_no_entry"
  | "plugin_crashed"
  | "plugin_timeout"
  | "invalid_args"
  | typeof PLUGIN_BUDGET_EXCEEDED_CODE
  | "not_permitted"
  | "unsupported_method"
  | "internal_error";

/**
 * How an error crosses the child boundary. Structural, never a stack string:
 * the host logs `stack` and shows `message`, and callers branch on `code`.
 */
export type PluginStructuralError = {
  code: PluginSdkErrorCode;
  message: string;
  /** Populated for `budget_exceeded`: which ceiling, and where the plugin sits. */
  detail?: { budget?: string; limit?: number; actual?: number } & Record<string, unknown>;
  stack?: string;
};

export class PluginSdkError extends Error {
  readonly code: PluginSdkErrorCode;
  readonly detail: PluginStructuralError["detail"];

  constructor(code: PluginSdkErrorCode, message: string, detail?: PluginStructuralError["detail"]) {
    super(message);
    this.name = "PluginSdkError";
    this.code = code;
    this.detail = detail;
  }
}

export function toPluginStructuralError(error: unknown): PluginStructuralError {
  if (error instanceof PluginSdkError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: error.message || "Unknown plugin error",
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { code: "internal_error", message: String(error) };
}

export function fromPluginStructuralError(payload: PluginStructuralError | undefined): PluginSdkError {
  const error = new PluginSdkError(
    payload?.code ?? "internal_error",
    payload?.message ?? "Unknown plugin error",
    payload?.detail,
  );
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

export function budgetExceeded(budget: string, limit: number, actual: number): PluginSdkError {
  return new PluginSdkError(
    PLUGIN_BUDGET_EXCEEDED_CODE,
    `Plugin ${budget} budget exceeded: ${actual} of ${limit}.`,
    { budget, limit, actual },
  );
}

/**
 * True when `error` is a budget refusal, however it was relayed.
 *
 * Reads `code` off any shape rather than testing `instanceof PluginSdkError`:
 * the same refusal reaches callers as a `PluginSdkError` in-process, as a
 * `codedError` from a sync-side writer, and as a rehydrated
 * {@link PluginStructuralError} after crossing the child boundary. All three
 * carry the one code, and all three have to answer this question the same way.
 */
export function isPluginBudgetExceeded(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === PLUGIN_BUDGET_EXCEEDED_CODE;
}

// ---------------------------------------------------------------------------
// SDK surface (what plugin code sees as the `ade` global)
// ---------------------------------------------------------------------------

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export type PluginCollectionRow = {
  collection: string;
  key: string;
  value: unknown;
  updatedAt: string;
};

export type PluginEventName = "lane.changed" | "pr.changed" | "session.changed" | "install.changed";

export type PluginEventPayload = {
  event: PluginEventName;
  /** Entity ids that changed since the last delivery, capped and deduped. */
  ids: string[];
  projectId: string | null;
  /**
   * `ids` was truncated at the delivery cap. Absent, never `false`, when it
   * was not — additive so a plugin compiled against the two-field payload
   * keeps working.
   *
   * `ids` is not a diff a listener can trust once this is set: more changed
   * than the cap carries, so the honest read is "the install set moved,
   * treat this the same as `install.changed` with no ids at all" — re-read
   * the roster (`plugin.list`) rather than acting only on the ids present.
   */
  overflow?: true;
};

/**
 * The `ade` global inside a plugin child process.
 *
 * Every method is async and every one can reject with a {@link PluginSdkError}.
 * There is no synchronous escape hatch: the host owns the database, the
 * secrets, and the action bridge, and a plugin reaches all three by asking.
 */
export type AdePluginSdk = {
  readonly pluginId: string;
  readonly sdkVersion: number;
  readonly manifest: PluginManifest;

  actions: {
    /**
     * Invoke an ADE action. The plugin authenticates at `agent` role, so
     * CTO-only actions are refused — a plugin is not the operator.
     * Project-scoped domains require `projectId`.
     */
    invoke(domain: string, action: string, args?: Record<string, unknown>): Promise<unknown>;
  };

  collections: {
    get(collection: string, key: string): Promise<unknown>;
    put(collection: string, key: string, value: unknown): Promise<void>;
    delete(collection: string, key: string): Promise<void>;
    list(collection: string, options?: { keyPrefix?: string; limit?: number }): Promise<PluginCollectionRow[]>;
  };

  /** Namespaced to `plugin:<id>:<NAME>` in the machine credential store. */
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };

  contributions: {
    publish(
      entityKind: PluginEntityKind,
      entityId: string,
      socket: PluginSocketKind,
      payload: Record<string, unknown> | null,
    ): Promise<void>;
  };

  events: {
    /** Debounced; returns an unsubscribe function. */
    on(event: PluginEventName, listener: (payload: PluginEventPayload) => void): () => void;
  };

  panels: {
    /** Replace a panel's vocabulary schema. Rejected if the panel is undeclared. */
    update(panelId: string, schema: unknown): Promise<void>;
  };

  config: {
    /** Current values for the manifest's `settings`, defaults applied. */
    get(): Promise<Record<string, string | number | boolean | null>>;
  };

  log(level: PluginLogLevel, message: string, fields?: Record<string, unknown>): void;
};

/**
 * What a plugin's entry module may export. Both hooks are optional: a plugin
 * that only registers CLI commands and panels needs neither.
 */
export type PluginModule = {
  activate?: (sdk: AdePluginSdk) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
  /** Named handlers reachable as `plugin.invoke {pluginId, action}`. */
  actions?: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>;
};

// ---------------------------------------------------------------------------
// Child transport (NDJSON over stdio — one JSON object per line)
// ---------------------------------------------------------------------------

/** Host → child. */
export type PluginHostFrame =
  | {
    type: "hello";
    sdkVersion: number;
    pluginId: string;
    pluginRoot: string;
    manifest: PluginManifest;
    config: Record<string, string | number | boolean | null>;
  }
  | { type: "invoke"; requestId: string; action: string; args: Record<string, unknown> }
  | { type: "event"; payload: PluginEventPayload }
  /** Reply to a `sdk` frame the child sent. */
  | { type: "sdkResult"; requestId: string; result?: unknown; error?: PluginStructuralError }
  | { type: "shutdown" };

/** The SDK calls a child can make back into the host. */
export type PluginSdkMethod =
  | "actions.invoke"
  | "collections.get"
  | "collections.put"
  | "collections.delete"
  | "collections.list"
  | "secrets.get"
  | "secrets.set"
  | "secrets.delete"
  | "contributions.publish"
  | "panels.update"
  | "config.get";

/** Child → host. */
export type PluginChildFrame =
  | { type: "ready"; actions: string[] }
  | { type: "sdk"; requestId: string; method: PluginSdkMethod; params: Record<string, unknown> }
  | { type: "invokeResult"; requestId: string; result?: unknown; error?: PluginStructuralError }
  | { type: "log"; level: PluginLogLevel; message: string; fields?: Record<string, unknown> }
  | { type: "fatal"; error: PluginStructuralError };

/**
 * Encode one NDJSON frame. Exported so host and child share one encoder and a
 * newline can never sneak into the payload and split a frame in two.
 */
export function encodePluginFrame(frame: PluginHostFrame | PluginChildFrame): string {
  return `${JSON.stringify(frame).replace(/\n/g, "\\n")}\n`;
}

export function decodePluginFrame<T extends PluginHostFrame | PluginChildFrame>(line: string): T | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && "type" in parsed ? parsed as T : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Install registry + the `plugin` action domain
// ---------------------------------------------------------------------------

export type PluginInstallSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; ref?: string }
  | { kind: "builtin" };

/** One entry in `~/.ade/plugins/state.json` — the machine install registry. */
export type PluginInstallRecord = {
  pluginId: string;
  version: string;
  enabled: boolean;
  source: PluginInstallSource;
  installedAt: string;
  updatedAt: string;
  /**
   * Manifest socket ids the user switched off — see
   * {@link PluginSummary.disabledContributions}. Optional on the wire so a
   * registry written by an older build parses; the reader fills in `[]`.
   */
  disabledContributions?: string[];
};

export type PluginRuntimeStatus =
  | "idle"
  | "starting"
  | "running"
  | "restarting"
  | "crashed"
  | "stopped"
  | "no-entry";

export type PluginSummary = {
  pluginId: string;
  version: string;
  displayName: string;
  description: string;
  icon: string | null;
  accent: string | null;
  enabled: boolean;
  status: PluginRuntimeStatus;
  /** Non-fatal manifest problems, surfaced in the UI rather than swallowed. */
  warnings: string[];
  /** Fatal manifest problems: the plugin is installed but cannot load. */
  errors: string[];
  source: PluginInstallSource;
  installedAt: string;
  hasEntry: boolean;
  /**
   * Manifest surfaces, in manifest shape. The renderer's own `tabs` list is
   * derived from these at the preload boundary rather than duplicated here: a
   * second spelling of the same manifest fact is the drift this contract exists
   * to prevent.
   */
  surfaces: {
    kind: string;
    id: string;
    title: string;
    panelId: string;
    icon?: string;
    /**
     * Set when the surface gates a compiled-in tab instead of rendering a panel
     * (`PLUGIN_BUILTIN_SURFACE_IDS`). Optional on the wire: a host that predates
     * the field simply reports the surface without it, and the client then shows
     * the built-in tab as it always did rather than hiding a page it cannot
     * prove is owned.
     */
    builtin?: string;
  }[];
  /** Present only for theme plugins; the renderer's theme engine consumes it. */
  theme: { displayName: string; tokens: { dark?: Record<string, string>; light?: Record<string, string> } } | null;
  /**
   * Manifest socket ids the user switched OFF, from the machine install
   * registry.
   *
   * A list of what is off rather than what is on, because contributions are on
   * by default: an empty list has to mean "everything this plugin declares is
   * live", and a list of enabled ids would read as "nothing is" on any plugin
   * installed before the field existed.
   *
   * Optional to match the renderer's `InstalledPlugin`, where absent and empty
   * mean the same thing — the host always populates it, so a caller that sees
   * `undefined` is talking to an older host, not to a plugin with everything
   * switched off.
   */
  disabledContributions?: string[];
  cli: string[];
  restartCount: number;
  lastCrashAt: string | null;
};

/**
 * One plugin's install state on one machine in the account.
 *
 * Flattened per (machine, plugin) because that is the grain the Marketplace's
 * coverage matrix draws. `isThisMachine` is stamped by the HOST: the renderer
 * holds no machine key, and a wrong guess shows someone another machine's
 * install state as their own.
 */
export type PluginPresenceMachineRow = {
  machineKey: string;
  machineName: string;
  pluginId: string;
  version: string | null;
  enabled: boolean;
  /** False for a machine in the directory that is not reachable right now. */
  online: boolean;
  isThisMachine: boolean;
};

/**
 * One materialized socket contribution, joined to the surface it renders on.
 *
 * `surface` is not stored — `plugin_contributions` keys on the socket KIND, and
 * which surface that socket belongs to lives in the plugin's manifest. The host
 * performs that join so every client does not have to hold every manifest.
 */
export type PluginContributionRecord = {
  entityKind: PluginEntityKind;
  entityId: string;
  pluginId: string;
  socket: PluginSocketKind;
  surface: PluginSurfaceId;
  /** The manifest socket id this row fills, for ordering and per-socket toggles. */
  socketId: string;
  payload: unknown;
  updatedAt: string | null;
};

/** The plugin directory, as the Marketplace reads it. */
export type PluginMarketplaceIndex = {
  entries: PluginRegistryEntry[];
  /** When the bytes were last confirmed current. A 304 counts. */
  fetchedAt: string | null;
  origin: "network" | "cache";
};

/**
 * What the host learned by reading an install source without installing it.
 *
 * `manifest` is null for a source this machine cannot read without fetching it
 * (a git URL): the modal then shows what the directory claims instead. Reading
 * a source must never be the thing that puts code on the machine.
 */
export type PluginSourceInspection = {
  source: string;
  manifest: PluginManifest | null;
};

/**
 * A materialized `plugin_panels` row.
 *
 * `schema` is opaque here on purpose: this module never parses vocabulary, and
 * a client too old to understand `vocabVersion` renders the panel's declared
 * fallback rather than guessing at the body.
 */
export type PluginPanelRecord = {
  pluginId: string;
  panelId: string;
  title: string | null;
  schema: unknown;
  vocabVersion: number;
  updatedAt: string | null;
};

export type PluginDetail = PluginSummary & {
  manifest: PluginManifest | null;
  settings: PluginManifestSetting[];
  config: Record<string, string | number | boolean | null>;
  root: string;
  logs: PluginLogEntry[];
};

export type PluginLogEntry = {
  at: string;
  level: PluginLogLevel;
  message: string;
  fields?: Record<string, unknown>;
};

export type PluginUsageSummaryEntry = {
  pluginId: string;
  collectionRows: number;
  collectionBytes: number;
  contributionRows: number;
  panelRows: number;
  /** Sync bytes attributed to this plugin's frames, when metering is on. */
  syncBytesOut: number;
  syncBytesIn: number;
};

export type PluginUsageSummary = {
  entries: PluginUsageSummaryEntry[];
  budgets: {
    collectionBytesPerPlugin: number;
    collectionRowsPerPlugin: number;
    contributionsPerPlugin: number;
    panelsPerPlugin: number;
  };
};

/**
 * The `plugin` action domain.
 *
 * ONE fixed domain, with `{pluginId, action, args}` inside — the action
 * envelope's domain enum is closed at both the RPC schema and iOS's
 * compile-time allowlist, so per-plugin domains are impossible by construction.
 * See D1 in the plugin platform design.
 */
export type PluginDomainService = {
  /** Call a plugin's own named handler. Treated as MUTATING by the renderer. */
  invoke(args: { pluginId: string; action: string; args?: Record<string, unknown>; argv?: string[] }): Promise<unknown>;
  list(args?: { includeDisabled?: boolean }): Promise<PluginSummary[]>;
  get(args: { pluginId: string }): Promise<PluginDetail | null>;
  /**
   * Read a materialized panel schema. Every surface that renders a plugin panel
   * goes through here — a manifest only names a `schemaFile`, and the row is
   * what the plugin actually published.
   */
  getPanel(args: { pluginId: string; panelId: string }): Promise<PluginPanelRecord | null>;
  getCollection(
    args: { pluginId: string; collection: string; keyPrefix?: string; limit?: number },
  ): Promise<PluginCollectionRow[]>;
  /**
   * The plugin directory. Null when there is neither a network answer nor a
   * cache — distinct from an empty index, which means the directory is
   * reachable and lists nothing.
   */
  marketplaceIndex(args?: { refresh?: boolean }): Promise<PluginMarketplaceIndex | null>;
  /**
   * Install state across the account's machines, from the synced presence
   * table. Empty on a machine with no sync host, which reads as
   * "this machine only" rather than as an error.
   */
  presence(): Promise<PluginPresenceMachineRow[]>;
  /**
   * Dynamic per-entity contributions for one surface.
   *
   * The half of the socket taxonomy that a manifest cannot express: static
   * sockets say a plugin CAN badge a lane, these rows say what it says about
   * lane 7 right now. Rows from disabled plugins and switched-off sockets are
   * filtered here, so no caller has to re-derive that.
   */
  listContributions(args: {
    surface: PluginSurfaceId;
    entityKind?: PluginEntityKind;
    entityIds?: string[];
  }): Promise<PluginContributionRecord[]>;
  /** An installed plugin's parsed manifest, or null when it has none readable. */
  getManifest(args: { pluginId: string }): Promise<PluginManifest | null>;
  /** An installed plugin's README, or null when it ships none. */
  getReadme(args: { pluginId: string }): Promise<string | null>;
  /** Recent log lines from the plugin's child process ring buffer. */
  openLogs(args: { pluginId: string }): Promise<PluginLogEntry[]>;
  /** Read an install source WITHOUT installing it. See {@link PluginSourceInspection}. */
  inspectSource(args: { source: string }): Promise<PluginSourceInspection | null>;
  /**
   * Turn one of a plugin's declared socket contributions off or on. Persisted
   * in the machine install registry, so it survives a restart and a reinstall.
   */
  setContributionEnabled(args: {
    pluginId: string;
    socketId: string;
    enabled: boolean;
  }): Promise<PluginSummary>;
  install(args: { source: string; ref?: string; enable?: boolean }): Promise<PluginSummary>;
  uninstall(args: { pluginId: string }): Promise<{ removed: boolean }>;
  enable(args: { pluginId: string }): Promise<PluginSummary>;
  disable(args: { pluginId: string }): Promise<PluginSummary>;
  usageSummary(args?: { pluginId?: string }): Promise<PluginUsageSummary>;
  /**
   * Write settings values for one plugin and return the plugin as it now reads.
   *
   * `values` is a PATCH: keys absent from it keep their stored value, and a key
   * set to `null` returns to the manifest's declared default. Every key is
   * checked against `manifest.settings` and an unknown one is refused rather
   * than stored — a typo that silently persists would read back as a setting
   * the plugin never sees, which is indistinguishable from a broken plugin.
   *
   * Deliberately NOT operator-gated: configuring an installed plugin is not
   * installing code. Denial (when it happens) is policy, so it surfaces as
   * `policyDenied`, never as a missing method.
   */
  setConfig(args: {
    pluginId: string;
    values: Record<string, string | number | boolean | null>;
  }): Promise<PluginDetail>;
  /** Re-read the manifest and restart the child. The `ade plugin dev` loop. */
  reload(args: { pluginId: string }): Promise<PluginSummary>;
};

/** Actions exposed through `ade actions` / the renderer bridge, in list order. */
export const PLUGIN_DOMAIN_ACTIONS = [
  "disable",
  "enable",
  "get",
  "getCollection",
  "getManifest",
  "getPanel",
  "getReadme",
  "inspectSource",
  "install",
  "invoke",
  "list",
  "listContributions",
  "marketplaceIndex",
  "openLogs",
  "presence",
  "reload",
  "setConfig",
  "setContributionEnabled",
  "uninstall",
  "usageSummary",
] as const;

export type PluginDomainAction = (typeof PLUGIN_DOMAIN_ACTIONS)[number];

/**
 * Read-only actions, for the renderer's mutating/read-only classification.
 * `invoke` is deliberately absent: a plugin handler may write anything, so the
 * safe default is MUTATING.
 */
export const PLUGIN_READ_ONLY_DOMAIN_ACTIONS: readonly PluginDomainAction[] = [
  "list",
  "get",
  "getPanel",
  "getCollection",
  "getReadme",
  "getManifest",
  "listContributions",
  "openLogs",
  // Reading a source is deliberately a READ: it parses a manifest the machine
  // can already see and never fetches or installs anything.
  "inspectSource",
  "marketplaceIndex",
  "presence",
  "usageSummary",
];

// ---------------------------------------------------------------------------
// Shared validation helpers (host and child agree by importing, not by copying)
// ---------------------------------------------------------------------------

export function assertPluginCollectionName(collection: unknown): string {
  if (typeof collection !== "string" || !PLUGIN_COLLECTION_NAME_PATTERN.test(collection)) {
    throw new PluginSdkError("invalid_args", `Invalid collection name: ${String(collection)}`);
  }
  return collection;
}

export function assertPluginCollectionKey(key: unknown): string {
  if (typeof key !== "string" || !PLUGIN_COLLECTION_KEY_PATTERN.test(key)) {
    throw new PluginSdkError("invalid_args", `Invalid collection key: ${String(key)}`);
  }
  return key;
}

export function assertPluginSecretName(name: unknown): string {
  if (typeof name !== "string" || !PLUGIN_SECRET_NAME_PATTERN.test(name)) {
    throw new PluginSdkError("invalid_args", `Invalid secret name: ${String(name)}`);
  }
  return name;
}

/** `plugin:<pluginId>:<NAME>` — the machine credential store namespace. */
export function pluginSecretStoreKey(pluginId: string, name: string): string {
  return `plugin:${pluginId}:${name}`;
}

/** UTF-8 byte length. `TextEncoder` keeps this module usable in the renderer. */
export function pluginUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Serialize a value for a collection or contribution and enforce its ceiling in
 * the same step, so no caller can measure one encoding and store another.
 */
export function encodePluginJsonWithinBudget(value: unknown, budget: string, limitBytes: number): string {
  let json: string;
  try {
    json = JSON.stringify(value ?? null) ?? "null";
  } catch (error) {
    throw new PluginSdkError(
      "invalid_args",
      `Value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bytes = pluginUtf8ByteLength(json);
  if (bytes > limitBytes) throw budgetExceeded(budget, limitBytes, bytes);
  return json;
}

// ---------------------------------------------------------------------------
// Client wire types (renderer ⇄ preload ⇄ host)
// ---------------------------------------------------------------------------

/**
 * What the UI sees, as distinct from what the host holds.
 *
 * These are deliberately NOT the host types above. The client's runtime status
 * is a five-value union where the host's is seven; a collection row on the wire
 * carries `{key, value}` where the host's carries its collection and timestamp;
 * an inspected source reaches the UI with an unparsed manifest because parsing
 * it is the renderer's job. Folding either pair into one type would force one
 * side to carry fields it cannot fill.
 *
 * They live here rather than in `renderer/lib/pluginRuntimeBridge` because the
 * PRELOAD has to name them, and preload importing the renderer is a layering
 * inversion that `contextBridge.exposeInMainWorld`'s `any` signature was hiding:
 * nothing was checking that what preload publishes matches what the UI calls.
 * The bridge re-exports every one of these under its own historical name, so the
 * UI's imports are unchanged.
 *
 * `PluginClient` prefixes the ones whose host counterpart shares a name. The
 * prefix is not decoration — it is what makes importing both into one file, as
 * preload does, possible at all.
 */

/** Child-process health as the UI renders it. `none` = the plugin runs no code. */
export type PluginClientRuntimeStatus = "running" | "starting" | "stopped" | "crashed" | "none";

/** Token sets a theme plugin may set, per built-in base theme. */
export type PluginClientThemeTokens = Partial<Record<"dark" | "light", Record<string, string>>>;

/** One `{"kind":"tab"}` surface, flattened for the rail. */
export type PluginClientTabDescriptor = {
  id: string;
  title: string;
  panelId: string;
  /** Phosphor icon name; resolved through `pluginIcons.ts`, never rendered raw. */
  icon?: string | null;
  /**
   * Names a compiled-in tab this surface gates rather than renders — see
   * `PLUGIN_BUILTIN_SURFACE_IDS` in `./manifest`. Absent on every ordinary
   * plugin tab, and absent from a host too old to report it, so its absence
   * means "not a gate" and never "hidden".
   */
  builtin?: string | null;
};

export type PluginClientInstalled = {
  pluginId: string;
  displayName: string;
  version: string;
  enabled: boolean;
  icon: string | null;
  /** Hex accent from the manifest. Applied as a CSS variable, never inlined as a class. */
  accent: string | null;
  status: PluginClientRuntimeStatus;
  tabs: PluginClientTabDescriptor[];
  /** Present only for theme plugins. */
  theme: { displayName: string; tokens: PluginClientThemeTokens } | null;
  /**
   * Manifest socket ids the user has switched off. Absent means none are —
   * which is why it is a list of what is OFF: contributions are on by default,
   * and an absent field must not read as "everything is disabled".
   */
  disabledContributions?: readonly string[];
  /** Drives the nav dot. Off unless the plugin asks for attention. */
  attention?: boolean;
};

/** One collection row as the UI reads it. The host's own row carries more. */
export type PluginClientCollectionRow = {
  key: string;
  value: unknown;
};

/** What changed, so a subscriber can decide whether it needs to refetch. */
export type PluginClientChangeEvent = {
  /**
   * Mirrors `main/services/plugins/pluginEvents.ts`'s `PluginChangeKind`.
   *
   * The daemon may send a kind this build has never heard of — the union is
   * open in practice and grows without a renderer release. Consumers must treat
   * an unrecognized kind as "refetch everything for this plugin" rather than
   * dropping it.
   */
  kind: "installs" | "panels" | "collections" | "contributions" | "status";
  pluginId?: string;
  panelId?: string;
  collection?: string;
};

/** The directory as the Marketplace receives it; entries stay unparsed. */
export type PluginClientMarketplaceIndex = {
  entries: unknown[];
  /** When the index was fetched. Null when it came from a cold cache. */
  fetchedAt: string | null;
  /** Whether these bytes came off the network or out of the etag cache. */
  origin: "network" | "cache";
};

/** A plugin's install state on one machine, as the coverage rail draws it. */
export type PluginClientPresenceRow = {
  machineKey: string;
  machineName: string;
  pluginId: string;
  version: string | null;
  enabled: boolean;
  /** False for a machine that is in the directory but not reachable now. */
  online: boolean;
  /**
   * Set by the host on rows for the machine this client runs on. The client
   * cannot work this out from the rows alone, and guessing wrong shows someone
   * another machine's install state as their own.
   */
  isThisMachine: boolean;
};

/** Storage and wire usage for one plugin, against its writer-enforced budget. */
export type PluginClientUsageRow = {
  pluginId: string;
  collectionBytes: number;
  collectionBudgetBytes: number;
  rows: number;
  rowBudget: number;
  /** Cumulative sync bytes attributed to this plugin. Null when unmetered. */
  syncBytesTotal: number | null;
};

export type PluginClientInstallRequest = {
  /** Git URL or directory path. The one field an install always has. */
  source: string;
  /** Known ahead of time for a directory entry; absent for install-from-URL. */
  pluginId?: string;
  /**
   * The directory version the user chose. Carried all the way to the host,
   * which is the only layer that knows how a version maps to a git ref.
   */
  version?: string;
  /** Install on another machine instead of this one. */
  machineKey?: string;
};

export type PluginClientInstallResult = {
  pluginId: string;
  version: string;
  displayName: string;
};

/** What the host learned by reading a source before installing it. */
export type PluginClientSourceInspection = {
  source: string;
  /** Raw manifest object — parsed by `./manifest`, never by the transport. */
  manifest: unknown;
};

// ---------------------------------------------------------------------------
// Service availability
// ---------------------------------------------------------------------------

/**
 * The one code every layer answers with when plugins are not available here.
 *
 * A headless brain, a build without the plugin host, and a desktop main process
 * whose `pluginHostService` was never assigned are all the same answer to the
 * caller: this computer cannot do plugins. Saying so in one typed code is what
 * lets a client degrade honestly — showing a machine-level Marketplace as
 * read-only — instead of surfacing a project-runtime error for a request that
 * has nothing to do with a project, or reporting a success that never happened.
 */
export const PLUGIN_SERVICE_UNAVAILABLE_CODE = "plugins_unavailable";

/** True when `error` is that refusal, however it was relayed. */
export function isPluginsUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === PLUGIN_SERVICE_UNAVAILABLE_CODE) return true;
  // Electron IPC strips custom Error properties, so the code arrives inside the
  // message (see `shared/codedError.ts` — `"<code>: <message>"`).
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes(PLUGIN_SERVICE_UNAVAILABLE_CODE);
}
