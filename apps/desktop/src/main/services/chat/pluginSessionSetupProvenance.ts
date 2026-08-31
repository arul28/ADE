/**
 * Which plugin owns a session's injected environment, established by the host.
 *
 * `chat.createSession` and `chat.launchCli` both accept `sessionSetup`, and both
 * are reachable by three untrusted callers: an agent through `run_ade_action`,
 * an automation step, and a plugin child through `sdk.actions.invoke`. All three
 * hand the host plain JSON. If the owning plugin id travelled in that JSON, any
 * of them could write `"ade-linear"` onto an environment it injected itself, and
 * `ADE_PLUGIN_SOURCE_ID` inside a launched agent is exactly the kind of label a
 * reader trusts.
 *
 * So it does not travel in the arguments. It rides on a module-private symbol
 * stamped by the one bridge that knows which plugin is calling — the daemon's
 * `invokeAdeAction`, whose `pluginId` comes from the supervisor that owns the
 * child socket, not from the call. A symbol survives an in-process call and
 * cannot survive `JSON.parse`, which is the boundary the untrusted callers sit
 * on. Same mechanism, and same reasoning, as `adeCardProvenance.ts`.
 *
 * A call with no stamp is not refused — an agent may legitimately launch a
 * session with `ADE_PLUGIN_*` variables of its own. It simply gets no
 * `ADE_PLUGIN_SOURCE_ID`, because the host has nobody to name.
 */

const TRUSTED_PLUGIN_OWNER = Symbol("ade.sessionSetup.trustedPluginOwner");

/** Attach the host-verified owning plugin id to an action's arguments. */
export function withTrustedPluginSessionOwner<T extends Record<string, unknown>>(
  args: T,
  pluginId: string,
): T {
  const normalized = pluginId.trim();
  if (!normalized) return args;
  // A copy: the caller's object is the plugin's own decoded payload, and
  // mutating it would leave the stamp where a retry could observe it.
  const copy = { ...args } as T;
  Object.defineProperty(copy, TRUSTED_PLUGIN_OWNER, {
    value: normalized,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return copy;
}

/** The owning plugin a trusted bridge stamped, or null for every other caller. */
export function readTrustedPluginSessionOwner(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<symbol, unknown>)[TRUSTED_PLUGIN_OWNER];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
