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
 *    (Wave C unifies these with `dbMaintenanceApi.ts`; they live here so the
 *    SDK's own writer never depends on the maintenance module's load order.)
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
  surfaces: { kind: string; id: string; title: string; panelId: string; icon?: string }[];
  /** Present only for theme plugins; the renderer's theme engine consumes it. */
  theme: { displayName: string; tokens: { dark?: Record<string, string>; light?: Record<string, string> } } | null;
  cli: string[];
  restartCount: number;
  lastCrashAt: string | null;
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
  "getPanel",
  "install",
  "invoke",
  "list",
  "reload",
  "setConfig",
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

export type PluginSurfaceScope = { surface: PluginSurfaceId; entityKind: PluginEntityKind };
