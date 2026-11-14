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

/** Key of This computer's machine pin. */
export const THIS_MACHINE_SCOPE_KEY = "machine-scope:this";

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
 * What a machine scope answers: a computer's own settings (Providers, the
 * Machines page's Restarts, Update track, Shell and load, Behaviour's Terminal
 * shell, Passwords). `all` means every action of the domain except those in
 * `except`.
 */
const MACHINE_SCOPE_ACTIONS: Readonly<Record<string, { all: true; except?: readonly string[] } | readonly string[]>> = {
  // A project copy saves its AI config (disabled providers, local model
  // servers, custom slugs, compaction); the machine scope has no project.
  ai: { all: true, except: ["updateConfig"] },
  provider_logins: { all: true },
  provider_instances: { all: true },
  proxy: { all: true },
  // A provider's sign-in terminal, in the machine scope's own workspace.
  pty: { all: true },
  lane: ["list"],
  usage: ["getAdeUsageStats"],
  chat: ["listCodexPlugins"],
  machine_stats: ["get"],
  // Settings › Passwords: the summaries and person-only writes its page
  // sends to the machine it shows (`callPasswords` in preload). Never a
  // value read (`revealValue`, passkeys, a browser fill).
  passwords: ["status", "setEnabled", "setCloudEnabled", "reset", "list", "activity", "code", "saveLogin", "saveSecret", "remove", "importCsv", "sync"],
};

export function machineScopeActionAllowed(domain: string, action: string): boolean {
  const rule = MACHINE_SCOPE_ACTIONS[domain];
  if (!rule) return false;
  if (Array.isArray(rule)) return rule.includes(action);
  const all = rule as { all: true; except?: readonly string[] };
  return !(all.except ?? []).includes(action);
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
