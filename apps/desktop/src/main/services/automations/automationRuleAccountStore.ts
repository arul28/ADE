import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import type { AutomationRuleHome } from "../../../shared/types";
import { AUTOMATION_HOME_LEASE_MS } from "../../../shared/automationHome";
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
 * - `automations.runs.<id>`: runs counted so far, for a rule with a run limit,
 *   so the limit holds when the rule moves to another computer.
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
  health?(): { state: string; pendingChanges: number; lastSyncedAt: string | null };
  /** False when no account service is configured, so no other computer can share these rows. */
  hasRelay?(): boolean;
};

export const AUTOMATION_RULE_KEY_PREFIX = "automations.rule.";
export const AUTOMATION_HOME_KEY_PREFIX = "automations.home.";
export const AUTOMATION_RUNS_KEY_PREFIX = "automations.runs.";

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

export function automationRuleRunsKey(ruleId: string): string {
  return `${AUTOMATION_RUNS_KEY_PREFIX}${keySuffix(ruleId)}`;
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
  /** Runs counted so far across every home, when the rule has a run limit. */
  runCount?: number;
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
  /** Run counts the account refused (signed out), by rule, to send after sign-in. */
  pendingRunCounts?: Record<string, { count: number; owner: string | null }>;
  /**
   * Rules waiting in `.ade/local.yaml` (saved signed out, or before the first
   * sync): the account they belong to, when, and whether it was an edit of an
   * account rule or a new rule.
   */
  offlineSaves?: Record<string, { owner: string | null; at: string; kind?: "edit" | "new" }>;
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

  // The id is read on every config read (to mark which rules run here), so
  // it is kept once known: a computer's sync device id does not change while
  // ADE runs. The name is read fresh when a home is written, because the
  // device registry that knows it may start after this store.
  let knownDeviceId: string | null = null;
  const thisDevice = (options: { name?: boolean } = {}): { deviceId: string | null; name: string | null } => {
    if (knownDeviceId && !options.name) return { deviceId: knownDeviceId, name: null };
    try {
      const device = args.thisComputer();
      const deviceId = device.deviceId?.trim() || null;
      const name = device.name?.trim() || null;
      if (deviceId) knownDeviceId = deviceId;
      return { deviceId: knownDeviceId ?? deviceId, name };
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
    const runs = new Map<string, number>();
    let fingerprint = where;
    for (const row of args.backend.list(where)) {
      if (row.key.startsWith(AUTOMATION_RULE_KEY_PREFIX)) {
        rules.set(row.key.slice(AUTOMATION_RULE_KEY_PREFIX.length), row.value);
      } else if (row.key.startsWith(AUTOMATION_HOME_KEY_PREFIX)) {
        homes.set(row.key.slice(AUTOMATION_HOME_KEY_PREFIX.length), row.value);
      } else if (row.key.startsWith(AUTOMATION_RUNS_KEY_PREFIX)) {
        const count = row.value && typeof row.value === "object" ? (row.value as { count?: unknown }).count : null;
        if (typeof count === "number" && Number.isFinite(count) && count > 0) {
          runs.set(row.key.slice(AUTOMATION_RUNS_KEY_PREFIX.length), Math.floor(count));
        }
      } else {
        continue;
      }
      fingerprint += `|${row.key}@${row.updatedAt}`;
    }
    const rows = [...rules.entries()].map(([suffix, value]) => ({
      value,
      home: homes.get(suffix),
      ...(runs.has(suffix) ? { runCount: runs.get(suffix)! } : {}),
    }));
    return { fingerprint, rows };
  };

  /**
   * A repository whose remote changed (renamed, moved to another owner) files
   * its rules under a new key. The first reads under the new key copy every
   * rule it lacks (and that no computer deleted there) from the key this
   * computer last read; the old rows stay for computers still on the old
   * remote. `complete` is false while a copy was refused, so the next read
   * tries again rather than leaving the rest behind.
   */
  const followRemoteChange = (
    where: string,
    current: { rows: AutomationAccountRow[] },
    state: LocalState,
  ): { copied: number; complete: boolean } => {
    const previous = state.copy?.scope;
    if (!previous || previous === where) return { copied: 0, complete: true };
    if (state.copy?.accountUserId && state.copy.accountUserId !== accountUserId()) return { copied: 0, complete: true };
    let old: AutomationAccountRow[];
    try {
      old = listRows(previous).rows;
    } catch (error) {
      args.logger?.warn("automations.account_rules.remote_change_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { copied: 0, complete: false };
    }
    const idOf = (row: AutomationAccountRow): string | null => {
      const id = row.value && typeof row.value === "object" ? (row.value as { id?: unknown }).id : null;
      return typeof id === "string" && id.trim() ? id.trim() : null;
    };
    const present = new Set(current.rows.map(idOf).filter((id): id is string => Boolean(id)));
    const deleted = new Set((args.backend.deletedKeys?.(where) ?? []).map((entry) => entry.key));
    let copied = 0;
    let complete = true;
    for (const row of old) {
      const id = idOf(row);
      if (!id || present.has(id) || deleted.has(automationRuleAccountKey(id))) continue;
      if (row.home !== undefined && args.backend.set(where, automationRuleHomeKey(id), row.home) === false) {
        complete = false;
        continue;
      }
      if (args.backend.set(where, automationRuleAccountKey(id), row.value) === false) {
        complete = false;
        continue;
      }
      if (row.runCount) args.backend.set(where, automationRuleRunsKey(id), { count: row.runCount });
      copied += 1;
    }
    if (copied > 0) {
      args.logger?.info("automations.account_rules.followed_remote_change", { from: previous, to: where, copied, complete });
      args.onWrite?.();
    }
    return { copied, complete };
  };

  // When this computer last heard from the account. Kept here because the
  // store reports no sync time while signed out.
  let lastSyncedAtMs = 0;
  const noteSyncTime = (): { lastSyncedAtMs: number; noRelay: boolean } => {
    const health = args.backend.health?.();
    if (!health) return { lastSyncedAtMs: Number.POSITIVE_INFINITY, noRelay: true };
    const at = health.lastSyncedAt ? Date.parse(health.lastSyncedAt) : Number.NaN;
    if (Number.isFinite(at) && at > lastSyncedAtMs) lastSyncedAtMs = at;
    // With no account service there is no other computer to hand a rule to.
    return { lastSyncedAtMs, noRelay: args.backend.hasRelay?.() === false };
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
      const device = thisDevice({ name: true });
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
      let copyComplete = true;
      try {
        current = listRows(where);
        const followed = followRemoteChange(where, current, state);
        copyComplete = followed.complete;
        if (followed.copied > 0) current = listRows(where);
      } catch (error) {
        args.logger?.warn("automations.account_rules.read_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { fingerprint: "unreadable", rows: [], signedOut: false };
      }
      const copy = state.copy;
      // An unfinished copy after a remote change keeps the old scope, so the
      // next read finishes it.
      if (copyComplete && (!copy || copy.fingerprint !== current.fingerprint || copy.accountUserId !== userId || copy.scope !== where)) {
        writeState({ ...readState(), copy: { scope: where, accountUserId: userId, fingerprint: current.fingerprint, rows: current.rows } });
      }
      return { ...current, signedOut: false };
    },

    /**
     * Whether this computer heard from the account within the lease, so a
     * rule homed here may start. Past it (offline, signed out), another
     * computer may have taken the rule over without this one seeing it.
     */
    leaseFresh(): boolean {
      const { lastSyncedAtMs: at, noRelay } = noteSyncTime();
      return noRelay || now() - at <= AUTOMATION_HOME_LEASE_MS;
    },

    /**
     * Whether this computer has synced with the account at least once since
     * ADE started. Until then its copy may lack another computer's rules, and
     * a rule filed under an id it cannot see could overwrite one.
     */
    hasSynced(): boolean {
      const { lastSyncedAtMs: at, noRelay } = noteSyncTime();
      return noRelay || at > 0;
    },

    /** Rule ids whose row some computer deleted, with when, as account keys. */
    deletedRuleStamps(): Map<string, string> {
      const where = scope();
      if (!where || !args.backend.deletedKeys) return new Map();
      try {
        return new Map(
          args.backend.deletedKeys(where)
            .filter((entry) => entry.key.startsWith(AUTOMATION_RULE_KEY_PREFIX))
            .map((entry) => [entry.key, entry.updatedAt]),
        );
      } catch (error) {
        args.logger?.warn("automations.account_rules.deleted_read_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return new Map();
      }
    },

    /**
     * Record runs counted so far for a rule with a run limit. A count the
     * account refuses (signed out, within the lease) is kept and sent by
     * `flushRunCounts` after sign-in, so a later home cannot run past the limit.
     */
    writeRunCount(ruleId: string, count: number): boolean {
      const where = scope();
      const keep = () => {
        const owner = accountUserId() ?? readState().copy?.accountUserId ?? null;
        updateState((state) => {
          const pending = { ...(state.pendingRunCounts ?? {}) };
          pending[ruleId] = { count: Math.max(count, pending[ruleId]?.count ?? 0), owner };
          return { ...state, pendingRunCounts: pending };
        });
        return false;
      };
      if (!where || !accountUserId()) return keep();
      try {
        const ok = args.backend.set(where, automationRuleRunsKey(ruleId), { count: Math.floor(count), at: new Date(now()).toISOString() }) !== false;
        return ok || keep();
      } catch (error) {
        args.logger?.warn("automations.account_rules.run_count_write_failed", {
          automationId: ruleId,
          error: error instanceof Error ? error.message : String(error),
        });
        return keep();
      }
    },

    /** Run counts kept while signed out that belong to the account now signed in. */
    pendingRunCounts(): Array<{ ruleId: string; count: number }> {
      const user = accountUserId();
      return Object.entries(readState().pendingRunCounts ?? {})
        .filter(([, entry]) => !entry.owner || entry.owner === user)
        .map(([ruleId, entry]) => ({ ruleId, count: entry.count }));
    },
    clearPendingRunCount(ruleId: string): void {
      updateState((state) => {
        const pending = { ...(state.pendingRunCounts ?? {}) };
        delete pending[ruleId];
        return { ...state, pendingRunCounts: pending };
      });
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
          args.backend.remove(where, automationRuleRunsKey(ruleId));
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

    /** Remember whose rule this is (the account last signed in here), and when it was saved. */
    noteOfflineSave(ruleId: string, kind: "edit" | "new"): void {
      const owner = accountUserId() ?? readState().copy?.accountUserId ?? null;
      const at = new Date(now()).toISOString();
      updateState((state) => ({ ...state, offlineSaves: { ...(state.offlineSaves ?? {}), [ruleId]: { owner, at, kind } } }));
    },
    /** Who a rule waiting in the file belongs to, when, and what kind of save; undefined when none. */
    offlineSave(ruleId: string): { owner: string | null; at: string; kind: "edit" | "new" } | undefined {
      const saves = readState().offlineSaves ?? {};
      const entry = Object.prototype.hasOwnProperty.call(saves, ruleId) ? saves[ruleId] : undefined;
      return entry && typeof entry === "object" ? { ...entry, kind: entry.kind ?? "edit" } : undefined;
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
