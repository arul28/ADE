import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import type { AutomationRuleHome } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { pathKey } from "../shared/pathCompare";

/**
 * Automation rules that follow the account, per repository.
 *
 * Each rule is two rows in the brain's account settings store, filed under the
 * repository (`repo:<host>/<owner>/<repo>`, the scope lane templates and the
 * CTO home use):
 *
 * - `automations.rule.<id>`: the rule itself.
 * - `automations.home.<id>`: the one computer (and checkout) that runs it.
 *
 * One row per rule, not one list: the store keeps the strictly newer stamp per
 * key, so a list saved on one computer would drop a rule another computer had
 * just added. The home is a row of its own for the same reason: an edit on one
 * computer and a change of home on another, made together, both stand.
 *
 * This module is storage only. `projectConfigService` decides what a rule is,
 * merges these rows with `.ade/local.yaml`, and owns every write.
 */

/** The slice of the account settings store this module needs. */
export type AutomationRuleAccountBackend = {
  /** False when the write was refused (signed out, account switched). */
  set(scope: string, key: string, value: unknown): unknown;
  remove(scope: string, key: string): unknown;
  list(scope?: string): ReadonlyArray<{ key: string; value: unknown; updatedAt: string }>;
  /** Keys some computer deleted. Without it, a stale copy of a deleted rule could come back. */
  deletedKeys?(scope: string): ReadonlyArray<{ key: string; updatedAt: string }>;
  /** Flush and pull. `ready` when the account answered. */
  sync?(): Promise<string>;
  health?(): { state: string; pendingChanges: number };
};

export const AUTOMATION_RULE_KEY_PREFIX = "automations.rule.";
export const AUTOMATION_HOME_KEY_PREFIX = "automations.home.";

/**
 * The relay's cap on one setting's JSON (`MAX_SETTING_VALUE_BYTES` in
 * `push-relay/src/accountSettings.ts`, `MAX_UPLOAD_VALUE_CHARS` in the
 * account settings store). A larger value would stay on this computer
 * without a word, so such a rule is never filed in the account.
 */
export const AUTOMATION_RULE_MAX_ACCOUNT_CHARS = 16_000;

// The relay takes keys of `[A-Za-z0-9._-]`, up to 200 characters.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

function keySuffix(ruleId: string): string {
  const id = ruleId.trim();
  if (SAFE_ID.test(id)) return id;
  return `h.${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

/** The account key a rule is stored under. Ids the relay cannot carry are hashed. */
export function automationRuleAccountKey(ruleId: string): string {
  return `${AUTOMATION_RULE_KEY_PREFIX}${keySuffix(ruleId)}`;
}

export function automationRuleHomeKey(ruleId: string): string {
  return `${AUTOMATION_HOME_KEY_PREFIX}${keySuffix(ruleId)}`;
}

/** A rule armed from one chat (auto-handoff and the like): it stays with that chat's computer. */
export function isChatScopedAutomationRule(rule: { scope?: { sessionId?: string | null } | null }): boolean {
  return typeof rule.scope?.sessionId === "string" && rule.scope.sessionId.trim().length > 0;
}

/** True when a rule's JSON fits in one account setting. */
export function fitsInAccount(value: unknown): boolean {
  return (JSON.stringify(value) ?? "").length <= AUTOMATION_RULE_MAX_ACCOUNT_CHARS;
}

/** One checkout's id: a hash of its path as the platform compares paths. */
export function checkoutKeyFor(projectRoot: string): string {
  return createHash("sha256").update(pathKey(projectRoot)).digest("hex").slice(0, 16);
}

/** JSON with keys in a fixed order, to compare two values for sameness. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  }) ?? "";
}

export type AutomationAccountRow = {
  /** The stored rule, as the computer that wrote it wrote it. */
  value: unknown;
  /** The stored home, or undefined when there is none. */
  home: unknown;
};

/**
 * A write this computer made that another computer could still overwrite
 * before seeing it: a rule moved out of `.ade/local.yaml` or newly created.
 * Kept, with the rule, until a sync shows which write the account kept.
 */
export type AutomationPendingConfirmation = {
  ruleId: string;
  rule: Record<string, unknown> & { id: string };
  home: AutomationRuleHome;
  accountUserId: string | null;
  at: string;
};

type LocalState = {
  /** This computer's read-only copy of the account's rows, for while signed out. */
  copy?: { scope: string; accountUserId: string | null; fingerprint: string; rows: AutomationAccountRow[] } | null;
  /** Writes waiting for a sync to confirm them. */
  pending?: AutomationPendingConfirmation[];
  /** Rules saved in `.ade/local.yaml` while signed out, by the account they belong to. */
  offlineSaves?: Record<string, string | null>;
};

export type AutomationRuleAccountStore = ReturnType<typeof createAutomationRuleAccountStore>;

export function createAutomationRuleAccountStore(args: {
  backend: AutomationRuleAccountBackend;
  /** The canonical origin URL; read on every call, so cache it in the caller. */
  readOriginUrl: () => string | null;
  /** This computer's sync device id and name. The id may be unknown early on. */
  thisComputer: () => { deviceId: string | null; name: string | null };
  /** This project's checkout path, so two checkouts on one computer are told apart. */
  projectRoot: string;
  /** The signed-in account, or null. A signed-out store hides every row. */
  accountUserId: () => string | null;
  /**
   * Per-computer state: the signed-out copy, the confirmations waiting for a
   * sync, and who saved rules while signed out. Null keeps it in memory only.
   */
  statePath: string | null;
  /** Called after a write, so the host can sync and confirm it soon. */
  onWrite?: () => void;
  logger?: Pick<Logger, "warn" | "info"> | null;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const checkout = checkoutKeyFor(args.projectRoot);
  // Read once, then kept in memory: only this brain writes the file, and it
  // is consulted on every config read.
  let memoryState: LocalState | null = null;

  const readState = (): LocalState => {
    if (memoryState) return memoryState;
    memoryState = {};
    if (!args.statePath) return memoryState;
    try {
      const parsed = JSON.parse(fs.readFileSync(args.statePath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) memoryState = parsed as LocalState;
    } catch (error) {
      // Missing is an empty state. Unreadable is too (the account is the
      // authority), but it is worth a line: the signed-out copy and any
      // unconfirmed writes in it are gone.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        args.logger?.warn("automations.account_rules.state_read_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return memoryState;
  };

  const writeState = (next: LocalState): void => {
    memoryState = next;
    if (!args.statePath) return;
    try {
      fs.mkdirSync(path.dirname(args.statePath), { recursive: true });
      const tmp = `${args.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(tmp, args.statePath);
    } catch (error) {
      args.logger?.warn("automations.account_rules.state_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const updateState = (change: (state: LocalState) => LocalState): void => writeState(change(readState()));

  const scope = (): string | null => {
    try {
      return accountRepoScopeKey(args.readOriginUrl());
    } catch (error) {
      args.logger?.warn("automations.account_rules.origin_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  // Read on every config read (to mark which rules run here), so it is kept
  // once known: a computer's sync device id does not change while ADE runs.
  let knownDevice: { deviceId: string; name: string | null } | null = null;
  const thisDevice = (): { deviceId: string | null; name: string | null } => {
    if (knownDevice) return knownDevice;
    try {
      const device = args.thisComputer();
      const deviceId = device.deviceId?.trim() || null;
      const name = device.name?.trim() || null;
      if (deviceId) knownDevice = { deviceId, name };
      return { deviceId, name };
    } catch (error) {
      args.logger?.warn("automations.account_rules.device_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { deviceId: null, name: null };
    }
  };

  const accountUserId = (): string | null => {
    try {
      return args.accountUserId();
    } catch {
      return null;
    }
  };

  const listRows = (where: string): { fingerprint: string; rows: AutomationAccountRow[] } => {
    const rules = new Map<string, unknown>();
    const homes = new Map<string, unknown>();
    let fingerprint = where;
    for (const row of args.backend.list(where)) {
      if (row.key.startsWith(AUTOMATION_RULE_KEY_PREFIX)) {
        rules.set(row.key.slice(AUTOMATION_RULE_KEY_PREFIX.length), row.value);
      } else if (row.key.startsWith(AUTOMATION_HOME_KEY_PREFIX)) {
        homes.set(row.key.slice(AUTOMATION_HOME_KEY_PREFIX.length), row.value);
      } else {
        continue;
      }
      fingerprint += `|${row.key}@${row.updatedAt}`;
    }
    const rows = [...rules.entries()].map(([suffix, value]) => ({ value, home: homes.get(suffix) }));
    return { fingerprint, rows };
  };

  /**
   * A repository whose remote changed (renamed, moved to another owner) files
   * its rules under a new key. The first read under the new key, when it holds
   * no rules yet, copies them from the key this computer last read; the old
   * rows stay for computers still on the old remote.
   */
  const followRemoteChange = (where: string, current: { rows: AutomationAccountRow[] }, state: LocalState): boolean => {
    const previous = state.copy?.scope;
    if (!previous || previous === where || current.rows.length > 0) return false;
    if (state.copy?.accountUserId && state.copy.accountUserId !== accountUserId()) return false;
    let old: AutomationAccountRow[];
    try {
      old = listRows(previous).rows;
    } catch {
      return false;
    }
    if (old.length === 0) return false;
    let copied = 0;
    for (const row of old) {
      const id = row.value && typeof row.value === "object" ? (row.value as { id?: unknown }).id : null;
      if (typeof id !== "string" || !id.trim()) continue;
      if (args.backend.set(where, automationRuleAccountKey(id), row.value) === false) return false;
      if (row.home !== undefined) args.backend.set(where, automationRuleHomeKey(id), row.home);
      copied += 1;
    }
    args.logger?.info("automations.account_rules.followed_remote_change", { from: previous, to: where, copied });
    args.onWrite?.();
    return copied > 0;
  };

  return {
    /** The repository scope rules are filed under, or null when the project has no usable remote. */
    scope,
    /** This checkout's id; see `AutomationRuleHome.checkout`. */
    checkout,

    /** This computer's sync device id, or null while it is not known. */
    thisDeviceId(): string | null {
      return thisDevice().deviceId;
    },

    accountUserId,
    signedIn(): boolean {
      return Boolean(accountUserId());
    },

    /** This computer and checkout as a rule's home, or null while the device id is not known. */
    thisComputerHome(): AutomationRuleHome | null {
      const device = thisDevice();
      if (!device.deviceId) return null;
      return {
        deviceId: device.deviceId,
        name: device.name ?? "This computer",
        chosenAt: new Date(now()).toISOString(),
        checkout,
      };
    },

    /**
     * Every stored rule in this repository's scope with its home, plus a
     * fingerprint of the rows so a caller can cache what it derives. Signed
     * out, the last signed-in copy (read-only). Null when there is no remote.
     */
    read(): { fingerprint: string; rows: AutomationAccountRow[]; signedOut: boolean } | null {
      const where = scope();
      if (!where) return null;
      const state = readState();
      const userId = accountUserId();
      if (!userId) {
        // Shown and run as they were; edits wait in `.ade/local.yaml`.
        const copy = state.copy;
        if (copy && copy.scope === where) return { fingerprint: `signed-out|${copy.fingerprint}`, rows: copy.rows, signedOut: true };
        return { fingerprint: "signed-out", rows: [], signedOut: true };
      }
      let current: { fingerprint: string; rows: AutomationAccountRow[] };
      try {
        current = listRows(where);
        if (followRemoteChange(where, current, state)) current = listRows(where);
      } catch (error) {
        args.logger?.warn("automations.account_rules.read_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { fingerprint: "unreadable", rows: [], signedOut: false };
      }
      const copy = state.copy;
      if (!copy || copy.fingerprint !== current.fingerprint || copy.accountUserId !== userId || copy.scope !== where) {
        writeState({ ...readState(), copy: { scope: where, accountUserId: userId, fingerprint: current.fingerprint, rows: current.rows } });
      }
      return { ...current, signedOut: false };
    },

    /** Rule ids whose row some computer deleted, as account keys. */
    deletedRuleKeys(): Set<string> {
      const where = scope();
      if (!where || !args.backend.deletedKeys) return new Set();
      try {
        return new Set(
          args.backend.deletedKeys(where)
            .map((entry) => entry.key)
            .filter((key) => key.startsWith(AUTOMATION_RULE_KEY_PREFIX)),
        );
      } catch (error) {
        args.logger?.warn("automations.account_rules.deleted_read_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return new Set();
      }
    },

    /** Store one rule's content. False when the account refused it or there is no remote. */
    writeRule(rule: Record<string, unknown> & { id: string }): boolean {
      const where = scope();
      if (!where || !accountUserId()) return false;
      try {
        const ok = args.backend.set(where, automationRuleAccountKey(rule.id), rule) !== false;
        if (ok) args.onWrite?.();
        return ok;
      } catch (error) {
        args.logger?.warn("automations.account_rules.write_failed", {
          automationId: rule.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },

    /** Store which computer runs a rule. */
    writeHome(ruleId: string, home: AutomationRuleHome): boolean {
      const where = scope();
      if (!where || !accountUserId()) return false;
      try {
        const ok = args.backend.set(where, automationRuleHomeKey(ruleId), home) !== false;
        if (ok) args.onWrite?.();
        return ok;
      } catch (error) {
        args.logger?.warn("automations.account_rules.home_write_failed", {
          automationId: ruleId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },

    /** Delete one rule and its home on every computer. False when the account refused it. */
    remove(ruleId: string): boolean {
      const where = scope();
      if (!where || !accountUserId()) return false;
      try {
        const ok = args.backend.remove(where, automationRuleAccountKey(ruleId)) !== false;
        if (ok) {
          args.backend.remove(where, automationRuleHomeKey(ruleId));
          args.onWrite?.();
        }
        return ok;
      } catch (error) {
        args.logger?.warn("automations.account_rules.remove_failed", {
          automationId: ruleId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },

    // ── Confirmations ──────────────────────────────────────────────────────

    addPending(entry: Omit<AutomationPendingConfirmation, "accountUserId" | "at">): void {
      updateState((state) => ({
        ...state,
        pending: [
          ...(state.pending ?? []).filter((item) => item.ruleId !== entry.ruleId),
          { ...entry, accountUserId: accountUserId(), at: new Date(now()).toISOString() },
        ],
      }));
    },
    pending(): AutomationPendingConfirmation[] {
      return [...(readState().pending ?? [])];
    },
    dropPending(ruleIds: readonly string[]): void {
      if (ruleIds.length === 0) return;
      const drop = new Set(ruleIds);
      updateState((state) => ({ ...state, pending: (state.pending ?? []).filter((item) => !drop.has(item.ruleId)) }));
    },
    /**
     * True once every local write has reached the account and the account
     * answered. `sync: false` reads the store's health only, for a caller that
     * runs right after the store's own sync (no second request).
     */
    async syncedEverything(options: { sync: boolean } = { sync: true }): Promise<boolean> {
      try {
        if (options.sync) {
          if (!args.backend.sync) return false;
          if ((await args.backend.sync()) !== "ready") return false;
        }
        const health = args.backend.health?.();
        return Boolean(health) && health!.state === "ok" && health!.pendingChanges === 0;
      } catch (error) {
        args.logger?.warn("automations.account_rules.sync_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },

    // ── Saved while signed out ─────────────────────────────────────────────

    /** Remember whose rule this is: the account that was last signed in here. */
    noteOfflineSave(ruleId: string): void {
      const owner = readState().copy?.accountUserId ?? null;
      updateState((state) => ({ ...state, offlineSaves: { ...(state.offlineSaves ?? {}), [ruleId]: owner } }));
    },
    /** The account a rule saved while signed out belongs to; undefined when it was not saved that way. */
    offlineOwner(ruleId: string): string | null | undefined {
      const saves = readState().offlineSaves ?? {};
      return Object.prototype.hasOwnProperty.call(saves, ruleId) ? saves[ruleId] ?? null : undefined;
    },
    clearOfflineSave(ruleIds: readonly string[]): void {
      if (ruleIds.length === 0) return;
      updateState((state) => {
        const saves = { ...(state.offlineSaves ?? {}) };
        for (const id of ruleIds) delete saves[id];
        return { ...state, offlineSaves: saves };
      });
    },
  };
}
