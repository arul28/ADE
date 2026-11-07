/**
 * Which projects keep a ready Agent 37 machine, and how: the person's choice,
 * shared by the desktop keeper (agent37ReadyMachines.ts) and the brain's
 * `agent37` actions. No Electron and no keeper here, so the brain imports only
 * this.
 */

import {
  AGENT37_READY_DEFAULT_SHAPE,
  agent37Shape,
  isAgent37MachineKind,
  type Agent37ReadyProjectSettings,
} from "../../../shared/agent37";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { getErrorMessage } from "../shared/utils";
import type { Agent37Logger } from "./agent37Client";
import type { Agent37Vault } from "./agent37Credential";

/** The account vault item that holds every project's choice. */
export const AGENT37_READY_VAULT_KEY = "agent37-ready";
/** This computer's copy, in the credential file the app, brain and CLI share. */
const AGENT37_READY_MACHINE_CREDENTIAL_KEY = "agent37.ready.v1";

export type Agent37ReadySettingsStore = {
  /**
   * `authoritative` is true only when the account answered with the choice.
   * A choice read from this computer alone (signed out, an unreachable vault,
   * a damaged item) shows what to keep ready but never decides what other
   * computers' machines to delete.
   */
  read(): Promise<{ projects: Agent37ReadyProjectSettings[]; authoritative: boolean }>;
  write(projects: Agent37ReadyProjectSettings[]): Promise<void>;
};

/**
 * What a machine with no SSH keys can clone: the identity over HTTPS. A
 * private repository needs a Git sign-in on the machine; the setup log says so.
 */
export function agent37ReadyCloneUrl(identity: string): string {
  return `https://${identity}.git`;
}

/** A folder name for the clone: the repository's last path part, made safe. */
export function agent37ReadyFolderName(identity: string): string {
  const last = identity.split("/").filter(Boolean).pop() ?? "project";
  return last.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "project";
}

/** The person's choice, checked: anything the renderer or vault hands in passes through here. */
export function normalizeAgent37ReadySettings(raw: Partial<Agent37ReadyProjectSettings> | null | undefined): Agent37ReadyProjectSettings | null {
  if (!raw) return null;
  const identity = normalizeGitRemoteIdentity(raw.identity);
  if (!identity) return null;
  return {
    identity,
    projectName: (typeof raw.projectName === "string" ? raw.projectName : "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60)
      || agent37ReadyFolderName(identity),
    kind: isAgent37MachineKind(raw.kind) ? raw.kind : "vm",
    shape: agent37Shape(raw.shape)?.id ?? AGENT37_READY_DEFAULT_SHAPE,
    setup: typeof raw.setup === "string" ? raw.setup.replace(/\r\n/g, "\n").slice(0, 8_000) : "",
    failure: raw.failure && typeof raw.failure.error === "string" && typeof raw.failure.at === "number"
      ? {
          error: raw.failure.error.slice(0, 600),
          at: raw.failure.at,
          attempts: typeof raw.failure.attempts === "number" && raw.failure.attempts >= 1 ? Math.floor(raw.failure.attempts) : 1,
          retryAt: typeof raw.failure.retryAt === "number" ? raw.failure.retryAt : null,
        }
      : null,
  };
}

/** The stored item; null (logged) for a damaged one, so a caller never takes it for "no projects". */
function parseAgent37ReadySettings(raw: string, logger?: Agent37Logger): Agent37ReadyProjectSettings[] | null {
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; projects?: unknown };
    if (parsed?.v !== 1 || !Array.isArray(parsed.projects)) {
      logger?.warn?.("agent37.ready_settings_unreadable", { reason: "unknown_shape" });
      return null;
    }
    const out: Agent37ReadyProjectSettings[] = [];
    for (const entry of parsed.projects) {
      const settings = normalizeAgent37ReadySettings(entry as Partial<Agent37ReadyProjectSettings>);
      if (settings && !out.some((existing) => existing.identity === settings.identity)) out.push(settings);
    }
    return out;
  } catch (error) {
    logger?.warn?.("agent37.ready_settings_unreadable", { reason: error instanceof SyntaxError ? "invalid_json" : "unreadable" });
    return null;
  }
}

/**
 * The account vault's item when it has one (every computer reads the same),
 * else this computer's copy: the fallback the Agent 37 key itself has. Every
 * write lands in both, so a vault that stops answering, or one that never got
 * the write, still reads the latest choice made here.
 */
export function createAgent37ReadySettingsStore(deps: {
  vault: () => Agent37Vault | null;
  machineStore: () => { getSync(key: string): string | null; setSync(key: string, value: string): void } | null;
  logger?: Agent37Logger;
}): Agent37ReadySettingsStore {
  const local = () => {
    try {
      return deps.machineStore();
    } catch (error) {
      deps.logger?.warn?.("agent37.ready_settings_local_unavailable", { error: getErrorMessage(error) });
      return null;
    }
  };
  return {
    async read() {
      const vault = deps.vault();
      const got = vault
        ? await vault.get().catch((error: unknown) => {
          deps.logger?.warn?.("agent37.ready_settings_vault_read_failed", { error: getErrorMessage(error) });
          return { ok: false as const };
        })
        : { ok: false as const };
      const fromAccount = got.ok && got.value != null ? parseAgent37ReadySettings(got.value, deps.logger) : null;
      if (got.ok && got.value != null && fromAccount) {
        // Kept here too, so a vault that stops answering falls back to the account's last answer.
        const store = local();
        if (store && store.getSync(AGENT37_READY_MACHINE_CREDENTIAL_KEY) !== got.value) {
          try {
            store.setSync(AGENT37_READY_MACHINE_CREDENTIAL_KEY, got.value);
          } catch (error) {
            deps.logger?.warn?.("agent37.ready_settings_mirror_failed", { error: getErrorMessage(error) });
          }
        }
        return { projects: fromAccount, authoritative: true };
      }
      const raw = local()?.getSync(AGENT37_READY_MACHINE_CREDENTIAL_KEY) ?? null;
      return { projects: (raw ? parseAgent37ReadySettings(raw, deps.logger) : null) ?? [], authoritative: false };
    },
    async write(projects) {
      const raw = JSON.stringify({ v: 1, projects });
      let savedHere = false;
      try {
        const store = local();
        store?.setSync(AGENT37_READY_MACHINE_CREDENTIAL_KEY, raw);
        savedHere = store != null;
      } catch (error) {
        // The account copy below still counts.
        deps.logger?.warn?.("agent37.ready_settings_local_write_failed", { error: getErrorMessage(error) });
      }
      const vault = deps.vault();
      const saved = vault ? await vault.set(raw).catch(() => false) : false;
      if (!saved && !savedHere) throw new Error("ADE couldn't save that to your account or this computer. Try again.");
      if (!saved) deps.logger?.warn?.("agent37.ready_settings_saved_locally", {});
    },
  };
}
