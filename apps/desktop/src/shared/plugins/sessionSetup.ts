/**
 * Plugin session setup: the generic seam behind `ADE_LINEAR_*`.
 *
 * The built-in Linear integration injects `ADE_LINEAR_ISSUE_IDS` and
 * `ADE_LINEAR_CONTEXT_FILE` into any agent session launched from an issue, plus
 * a per-session context file the agent reads without Linear credentials. That
 * reach is what makes the built-in feel native. This module is the same reach,
 * generalized, so a Jira plugin gets it too: a plugin that launches an agent
 * session may hand the host a small set of environment variables and ONE
 * context file, and the host validates, writes and injects them.
 *
 * ## Why one fixed `ADE_PLUGIN_` prefix and not a per-plugin namespace
 *
 * A per-plugin namespace (`ADE_PLUGIN_<PLUGINID>_…`) sounds stronger and is
 * not, because the seam a plugin reaches this through — `actions.invoke` in
 * `pluginSdkServer` — is a deliberate pass-through that carries no plugin
 * identity into the action layer. A namespace derived from an id the CALLER
 * supplies is a suggestion, not a namespace: plugin A would be free to claim
 * `ADE_PLUGIN_JIRA_*`. Attribution therefore comes from the one place that
 * knows the truth — the SDK server stamps {@link PLUGIN_SESSION_SOURCE_ENV},
 * overwriting whatever the plugin sent — while the KEY SPACE stays a single
 * static prefix that is trivially auditable.
 *
 * The prefix is also what makes shadowing impossible rather than merely
 * unlikely: no variable the host sets on a launched agent (`PATH`, `HOME`,
 * `ADE_LANE_ID`, `ADE_CHAT_SESSION_ID`, `ANTHROPIC_*`, `OPENAI_*`, …) begins
 * with `ADE_PLUGIN_`, so a plugin cannot reach any of them by construction.
 * A plugin that wants its own name in the variable puts it in the SUFFIX
 * (`ADE_PLUGIN_JIRA_ISSUE_KEYS`) — documentation, not enforcement.
 *
 * On top of the prefix the validator refuses two more classes:
 *
 * - {@link RESERVED_PLUGIN_SESSION_ENV_KEYS}, the `ADE_PLUGIN_*` names the host
 *   itself owns. Static rather than derived, so a plugin cannot win a race by
 *   claiming `ADE_PLUGIN_ID` on a machine where the host happens not to set it.
 * - any key already present in the host env the caller passes in, so a host
 *   variable added later is covered without editing the list above.
 *
 * Keys are compared upper-cased because Windows environment blocks are
 * case-insensitive: `ade_plugin_id` and `ADE_PLUGIN_ID` are the same variable
 * there, and a validator that only matched the exact spelling would leave a
 * shadowing hole on one platform.
 */

/** Environment keys a plugin may set on a session it launches. */
export const PLUGIN_SESSION_ENV_KEY_PATTERN = /^ADE_PLUGIN_[A-Z0-9_]{1,64}$/u;

/** Host-named variable carrying the path of the plugin's context file. */
export const PLUGIN_SESSION_CONTEXT_FILE_ENV = "ADE_PLUGIN_CONTEXT_FILE";

/** Host-stamped id of the plugin whose setup produced this session's env. */
export const PLUGIN_SESSION_SOURCE_ENV = "ADE_PLUGIN_SOURCE_ID";

/**
 * `ADE_PLUGIN_*` names the host owns. A plugin setting one of these would be
 * shadowing the host inside the only prefix it is allowed to write.
 */
export const RESERVED_PLUGIN_SESSION_ENV_KEYS: readonly string[] = [
  PLUGIN_SESSION_CONTEXT_FILE_ENV,
  PLUGIN_SESSION_SOURCE_ENV,
  "ADE_PLUGIN_CHILD_BOOTSTRAP_PATH",
  "ADE_PLUGIN_ID",
  "ADE_PLUGIN_INSTALL_PINGS",
  "ADE_PLUGIN_REGISTRY_URL",
  "ADE_PLUGIN_RELAY_API_BASE_URL",
  "ADE_PLUGIN_ROOT",
];

/** Most variables one plugin may inject into one session. */
export const MAX_PLUGIN_SESSION_ENV_KEYS = 16;

/** Largest single environment value, in UTF-8 bytes. */
export const MAX_PLUGIN_SESSION_ENV_VALUE_BYTES = 4 * 1024;

/** Largest context file, in UTF-8 bytes. */
export const MAX_PLUGIN_SESSION_CONTEXT_FILE_BYTES = 256 * 1024;

/** Accepted context-file names: one path segment, no separators, no dot-files. */
export const PLUGIN_SESSION_CONTEXT_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** One context file a plugin materializes for the agent it launched. */
export type PluginSessionContextFile = {
  /** Single file name, no directory part. Written inside the session's own dir. */
  name: string;
  content: string;
};

/**
 * What a plugin asks for. `env` keys must match
 * {@link PLUGIN_SESSION_ENV_KEY_PATTERN}; the host writes `contextFile` and
 * hands its path to the child through {@link PLUGIN_SESSION_CONTEXT_FILE_ENV}.
 */
export type PluginSessionSetup = {
  env?: Record<string, string>;
  contextFile?: PluginSessionContextFile;
};

/** A validated setup, safe to persist and inject. */
export type NormalizedPluginSessionSetup = {
  env: Record<string, string>;
  contextFile: PluginSessionContextFile | null;
  /** Host-stamped owner, when the call arrived through the plugin SDK. */
  pluginId: string | null;
};

export type ParsePluginSessionSetupOptions = {
  /**
   * Keys the host already sets on the launched process — normally
   * `Object.keys(process.env)`. Any collision is refused, so a host variable
   * added after this file was written is still un-shadowable.
   */
  hostEnvKeys?: Iterable<string>;
  /** Host-known plugin id. Overwrites anything the caller sent. */
  pluginId?: string | null;
};

// TextEncoder, not Buffer: this module is shared, so it also loads in the
// renderer, where Buffer does not exist.
const utf8Encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return utf8Encoder.encode(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reservedKeySet(hostEnvKeys: Iterable<string> | undefined): Set<string> {
  const reserved = new Set(RESERVED_PLUGIN_SESSION_ENV_KEYS.map((key) => key.toUpperCase()));
  for (const key of hostEnvKeys ?? []) {
    if (typeof key === "string" && key.trim()) reserved.add(key.trim().toUpperCase());
  }
  return reserved;
}

/**
 * Validate and normalize a plugin's requested session setup.
 *
 * Returns `null` when the caller asked for nothing. Throws with a message that
 * names the offending key or cap when the request is not allowed — refusing
 * beats launching a session whose env quietly lost half of what a plugin
 * depends on, which is the same reasoning the MCP-server refusal above
 * `createSession` already follows.
 */
export function parsePluginSessionSetup(
  input: unknown,
  options: ParsePluginSessionSetupOptions = {},
): NormalizedPluginSessionSetup | null {
  if (input === undefined || input === null) return null;
  if (!isRecord(input)) {
    throw new Error("sessionSetup must be an object with optional 'env' and 'contextFile'.");
  }

  const pluginId = typeof options.pluginId === "string" && options.pluginId.trim()
    ? options.pluginId.trim()
    : null;

  const env: Record<string, string> = {};
  if (input.env !== undefined && input.env !== null) {
    if (!isRecord(input.env)) throw new Error("sessionSetup.env must be an object of string values.");
    const reserved = reservedKeySet(options.hostEnvKeys);
    const entries = Object.entries(input.env);
    if (entries.length > MAX_PLUGIN_SESSION_ENV_KEYS) {
      throw new Error(
        `sessionSetup.env accepts at most ${MAX_PLUGIN_SESSION_ENV_KEYS} variables (got ${entries.length}).`,
      );
    }
    for (const [key, value] of entries) {
      if (!PLUGIN_SESSION_ENV_KEY_PATTERN.test(key)) {
        throw new Error(
          `sessionSetup.env key '${key}' is not allowed. Plugin variables must match `
          + "ADE_PLUGIN_[A-Z0-9_] (up to 64 characters after the prefix), which is what keeps a "
          + "plugin from shadowing PATH, HOME, or any ADE_* variable the host sets.",
        );
      }
      if (reserved.has(key.toUpperCase())) {
        throw new Error(
          `sessionSetup.env key '${key}' is set by ADE and cannot be overridden by a plugin.`,
        );
      }
      if (typeof value !== "string") {
        throw new Error(`sessionSetup.env['${key}'] must be a string.`);
      }
      if (value.includes("\0")) {
        throw new Error(`sessionSetup.env['${key}'] must not contain a NUL byte.`);
      }
      const size = utf8Bytes(value);
      if (size > MAX_PLUGIN_SESSION_ENV_VALUE_BYTES) {
        throw new Error(
          `sessionSetup.env['${key}'] is ${size} bytes; the limit is `
          + `${MAX_PLUGIN_SESSION_ENV_VALUE_BYTES}. Put larger context in contextFile.`,
        );
      }
      env[key] = value;
    }
  }

  let contextFile: PluginSessionContextFile | null = null;
  if (input.contextFile !== undefined && input.contextFile !== null) {
    if (!isRecord(input.contextFile)) {
      throw new Error("sessionSetup.contextFile must be an object with 'name' and 'content'.");
    }
    const name = typeof input.contextFile.name === "string" ? input.contextFile.name.trim() : "";
    const content = input.contextFile.content;
    if (!PLUGIN_SESSION_CONTEXT_FILE_NAME_PATTERN.test(name)) {
      throw new Error(
        `sessionSetup.contextFile.name '${name}' is not allowed. Use one plain file name `
        + "(letters, digits, dot, dash, underscore; no directory separators).",
      );
    }
    if (typeof content !== "string") {
      throw new Error("sessionSetup.contextFile.content must be a string.");
    }
    const size = utf8Bytes(content);
    if (size > MAX_PLUGIN_SESSION_CONTEXT_FILE_BYTES) {
      throw new Error(
        `sessionSetup.contextFile is ${size} bytes; the limit is `
        + `${MAX_PLUGIN_SESSION_CONTEXT_FILE_BYTES}.`,
      );
    }
    contextFile = { name, content };
  }

  if (!Object.keys(env).length && !contextFile) return null;
  return { env, contextFile, pluginId };
}
