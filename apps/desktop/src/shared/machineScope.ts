/**
 * The machine route: an address for one computer's own settings that needs no
 * project on it.
 *
 * Provider installs, sign-ins, accounts and stored keys belong to a computer,
 * not to a repository. Before this route, Settings reached another computer
 * only through its copy of the open repository, so a computer without one
 * (and This computer, from a tab bound elsewhere) dropped out of Providers.
 *
 * A machine pin is an `OpenProjectBinding` whose project is the machine
 * itself, so every pin-aware preload call, cancel and event feed reaches it
 * the way it reaches a project copy:
 * - another computer: `projectId` is `MACHINE_SCOPE_PROJECT_ID`, sent over
 *   the saved connection. Its brain answers from its machine-owned runtime
 *   (the one personal chats use), never from a project.
 * - This computer: `rootPath` is `MACHINE_SCOPE_ROOT_PATH`, which main sends
 *   to this computer's brain the same way.
 *
 * A brain answers only the domains and actions listed here. Project settings
 * (the AI config a project copy saves) are not among them: those stay on the
 * copy's own pin.
 */

import { remoteProjectBindingKey } from "./projectIdentity";
import type { OpenProjectBinding } from "./types/core";

/** The project id that names a computer's machine scope on the wire. */
export const MACHINE_SCOPE_PROJECT_ID = "ade-machine-scope";

/** The root path that names This computer's machine scope. Never a real folder. */
export const MACHINE_SCOPE_ROOT_PATH = "ade:machine-scope";

/**
 * Key of This computer's machine pin. It has the shape every local pin's key
 * has (`local:<rootPath>`), because main pushes a local root's runtime events
 * (a sign-in terminal's output) under that key and the preload delivers them
 * to the pin with the same key.
 */
export const THIS_MACHINE_SCOPE_KEY = `local:${MACHINE_SCOPE_ROOT_PATH}`;

export type MachineScopePin = OpenProjectBinding & { machineScope: true };

const pinCache = new Map<string, MachineScopePin>();

/**
 * One computer's machine pin. The same machine and name give the same object,
 * so effects keyed on the pin do not restart on every machine-list tick.
 */
export function machineScopePin(
  machine:
    | { kind: "this"; name: string }
    | { kind: "remote"; targetId: string; name: string; hostname?: string | null },
): MachineScopePin {
  const cacheKey = machine.kind === "this"
    ? `this|${machine.name}`
    : `remote|${machine.targetId}|${machine.name}|${machine.hostname ?? ""}`;
  const cached = pinCache.get(cacheKey);
  if (cached) return cached;
  const pin: MachineScopePin = machine.kind === "this"
    ? {
        kind: "local",
        key: THIS_MACHINE_SCOPE_KEY,
        rootPath: MACHINE_SCOPE_ROOT_PATH,
        displayName: machine.name,
        machineScope: true,
      }
    : {
        kind: "remote",
        key: remoteProjectBindingKey(machine.targetId, MACHINE_SCOPE_PROJECT_ID),
        targetId: machine.targetId,
        runtimeName: machine.name,
        transport: "paired",
        ...(machine.hostname ? { hostname: machine.hostname } : {}),
        projectId: MACHINE_SCOPE_PROJECT_ID,
        rootPath: "",
        displayName: machine.name,
        machineScope: true,
      };
  pinCache.set(cacheKey, pin);
  return pin;
}

/** Whether a pin names a computer's machine scope rather than a project copy. */
export function isMachineScopePin(pin: OpenProjectBinding | null | undefined): boolean {
  if (!pin) return false;
  return pin.kind === "remote"
    ? pin.projectId === MACHINE_SCOPE_PROJECT_ID
    : pin.rootPath === MACHINE_SCOPE_ROOT_PATH;
}

export function isMachineScopeRootPath(rootPath: string | null | undefined): boolean {
  return typeof rootPath === "string" && rootPath.trim() === MACHINE_SCOPE_ROOT_PATH;
}

/**
 * The action that saves a project copy's AI config (disabled providers, local
 * model servers, custom slugs, compaction). The machine scope has no project,
 * so it never answers it, and Settings edits that config only on a copy's pin.
 */
export const PROJECT_AI_CONFIG_ACTION = { domain: "ai", action: "updateConfig" } as const;

/** One domain's rule: every action but `except`, or `only` the ones listed. */
type MachineScopeRule = { all: true; except: readonly string[] } | { only: readonly string[] };

/**
 * What a machine scope answers: a computer's own settings (Providers, the
 * Machines page's Restarts, Update track, Shell and load, Behaviour's Terminal
 * shell). Passwords is not here: the machine-owned runtime is lent only the
 * account settings store (for account-saved sign-ins), not the vault, and
 * This computer's machine pin reaches its brain's `passwords.call`.
 */
const MACHINE_SCOPE_ACTIONS: Readonly<Record<string, MachineScopeRule>> = {
  ai: { all: true, except: [PROJECT_AI_CONFIG_ACTION.action] },
  provider_logins: { all: true, except: [] },
  provider_instances: { all: true, except: [] },
  proxy: { all: true, except: [] },
  // A provider's sign-in terminal, in the machine scope's own workspace.
  pty: { all: true, except: [] },
  lane: { only: ["list"] },
  usage: { only: ["getAdeUsageStats"] },
  chat: { only: ["listCodexPlugins"] },
  machine_stats: { only: ["get"] },
};

export function machineScopeActionAllowed(domain: string, action: string): boolean {
  const rule = Object.hasOwn(MACHINE_SCOPE_ACTIONS, domain) ? MACHINE_SCOPE_ACTIONS[domain] : undefined;
  if (!rule) return false;
  return "only" in rule ? rule.only.includes(action) : !rule.except.includes(action);
}

/** The sentence for a computer whose ADE predates the machine route. */
export function machineScopeUpdateMessage(machineName: string): string {
  return `${machineName} runs an older ADE. Update ADE on ${machineName} to manage it from here.`;
}

/** The same for This computer: its ADE service is older than this app. */
export const THIS_COMPUTER_MACHINE_SCOPE_UPDATE_MESSAGE =
  "This computer's ADE service is older than this app. Restart ADE to update it, then manage it from here.";

/**
 * How a brain that predates the machine route answers a machine-scope call:
 * it looks the scope's id up as a project and does not find it.
 */
export function isMachineScopeUnknownProjectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes(`Unknown projectId: ${MACHINE_SCOPE_PROJECT_ID}`);
}
