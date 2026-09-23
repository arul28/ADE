/**
 * How the Pi worker applies the model and thinking level picked in ADE:
 * exactly, and without touching the user's own Pi defaults.
 *
 * Free of Pi imports, like the protocol: the worker hands in the objects it
 * loaded from the user's installation, so these rules are testable without Pi.
 */

import fs from "node:fs";
import path from "node:path";
import { PI_THINKING_LEVELS, normalizePiSdkModelRef, type PiSdkModelRef } from "./piSdkProtocol";

/**
 * Pi's own thinking level when settings.json names none (`DEFAULT_THINKING_LEVEL`
 * in the Pi package's core/defaults.js, which the package does not export).
 */
export const PI_FALLBACK_THINKING_LEVEL = "medium";

type Callable = (...args: unknown[]) => unknown;
type SettingsScope = "global" | "project";

/** The storage contract `SettingsManager.fromStorage` takes. */
export type PiSettingsStorageLike = {
  withLock: (scope: SettingsScope, fn: (current: string | undefined) => string | undefined) => void;
};

/**
 * The `SettingsManager` setters a Pi session calls on its own: `setModel`
 * persists the pick as the user's default model, and `setThinkingLevel` as the
 * default thinking level. Only a Pi build that cannot take a storage backend
 * needs them disarmed one by one.
 */
const PI_SESSION_DEFAULT_SETTERS = [
  "setDefaultModelAndProvider",
  "setDefaultModel",
  "setDefaultProvider",
  "setDefaultThinkingLevel",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && (typeof value === "object" || typeof value === "function") && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Pi's settings storage with every write dropped.
 *
 * Pi treats a session's model and thinking choices as the user's new GLOBAL
 * defaults: `AgentSession.setModel` calls `setDefaultModelAndProvider` and
 * `setThinkingLevel` calls `setDefaultThinkingLevel`, both of which rewrite
 * `<agentDir>/settings.json`. Through an ADE chat that would change what every
 * later Pi CLI launch starts on. The choices still land in the session file,
 * which is the session's own record. Reads take no lock, because Pi's lock is a
 * directory it creates beside the file, and this storage never writes.
 *
 * Project scope reads nothing: ADE opens the checkout untrusted, so Pi never
 * asks for it, and an empty answer keeps the checkout's `.pi/` out regardless.
 */
export function createPiReadOnlySettingsStorage(agentDir: string): PiSettingsStorageLike {
  const globalPath = path.join(agentDir, "settings.json");
  return {
    withLock(scope, fn) {
      let current: string | undefined;
      if (scope === "global") {
        try {
          current = fs.readFileSync(globalPath, "utf8");
        } catch {
          current = undefined;
        }
      }
      // What `fn` returns is the file Pi wants written. It is dropped.
      fn(current);
    },
  };
}

/**
 * The worker's one settings manager: the user's settings read from disk, no
 * writes, and the project untrusted (so Pi never auto-loads the checkout's
 * extensions). Null when the Pi build exposes no way to build one.
 */
export function createPiSettingsManager(
  SettingsManager: unknown,
  cwd: string,
  agentDir: string,
): Record<string, unknown> | null {
  const ctor = typeof SettingsManager === "function" ? SettingsManager as unknown as Record<string, unknown> : null;
  if (!ctor) return null;
  if (typeof ctor.fromStorage === "function") {
    return record((ctor.fromStorage as Callable).call(
      ctor,
      createPiReadOnlySettingsStorage(agentDir),
      { projectTrusted: false },
    ));
  }
  if (typeof ctor.create !== "function") return null;
  const manager = record((ctor.create as Callable).call(ctor, cwd, agentDir, { projectTrusted: false }));
  if (!manager) return null;
  // No storage injection on this build: disarm the setters a session reaches.
  for (const name of PI_SESSION_DEFAULT_SETTERS) {
    if (typeof manager[name] === "function") manager[name] = () => undefined;
  }
  return manager;
}

/** True for a level Pi's SDK accepts. */
export function isPiThinkingLevel(value: unknown): value is string {
  return typeof value === "string" && (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * The thinking level Pi starts a session on: the user's configured default, or
 * Pi's own. Read before the session exists — a session's own level changes
 * move the manager's in-memory default, even though nothing is written.
 */
export function piDefaultThinkingLevel(settingsManager: Record<string, unknown> | null): string {
  const read = settingsManager?.getDefaultThinkingLevel;
  const configured = typeof read === "function" ? (read as Callable).call(settingsManager) : undefined;
  const level = typeof configured === "string" ? configured.trim() : "";
  return isPiThinkingLevel(level) ? level : PI_FALLBACK_THINKING_LEVEL;
}

/**
 * The exact provider/model picked in ADE, from Pi's catalog, or an error that
 * says why it cannot run.
 *
 * Pi's CLI resolver (`resolveCliModel`) is built for typed input: it matches a
 * partial id, picks another provider's model with the same id, and invents a
 * custom model id when nothing matches. Each of those runs, and bills, a
 * different model than the one picked. ADE's picks come from Pi's own catalog,
 * so an exact provider + id lookup is the whole contract.
 */
export async function resolvePiExactModel(runtime: unknown, ref: PiSdkModelRef): Promise<unknown> {
  const { provider, id } = normalizePiSdkModelRef(ref);
  const target = record(runtime);
  const getModel = target?.getModel;
  if (typeof getModel !== "function") {
    throw new Error(`Pi model "${provider}/${id}" cannot be selected: this Pi build has no exact model lookup (ModelRuntime.getModel). Update Pi.`);
  }
  const model = record(await Promise.resolve((getModel as Callable).call(runtime, provider, id)));
  // Checked again here so a Pi build whose lookup is looser still cannot
  // hand back a neighbour.
  if (model && model.provider === provider && model.id === id) return model;

  const getModels = target?.getModels;
  let providerModels: unknown[] = [];
  try {
    const listed = typeof getModels === "function" ? (getModels as Callable).call(runtime, provider) : [];
    providerModels = Array.isArray(listed) ? listed : [];
  } catch {
    providerModels = [];
  }
  const reason = providerModels.length
    ? `Pi's "${provider}" provider has no model "${id}"`
    : `Pi has no provider "${provider}" with models`;
  throw new Error(
    `Pi model "${provider}/${id}" is unavailable: ${reason}. ADE runs only the exact model you picked, so pick another model or add this one to your Pi profile.`,
  );
}
