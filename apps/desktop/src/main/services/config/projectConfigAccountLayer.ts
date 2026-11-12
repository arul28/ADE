import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import type { ProjectConfigAccountNotice, ProjectConfigFile } from "../../../shared/types";
import {
  buildCollectionKeys,
  buildStaticKeys,
  isRecord,
  PROJECT_CONFIG_ACCOUNT_COLLECTION_PREFIXES,
  type MovedKey,
  type ProjectConfigRules,
} from "./projectConfigAccountKeys";

/**
 * Settings in `.ade/local.yaml` that follow the ADE account (account project
 * plan, slices Y2 to Y4; the list is in `projectConfigAccountKeys.ts`). Each
 * is one account row under the project's repository (`repo:<origin>`), so
 * every computer that opens the repository uses the same value.
 *
 * - Read: the account row, when there is one, replaces the file's value.
 * - Write: a value a person changed goes to the account; a value they
 *   cleared is deleted there. The file still gets the account's values for
 *   one release, so an older ADE process on this computer sees them too.
 * - Move: once the account has synced, a value only the file has is written
 *   to the account (write-if-absent). A different value already in the
 *   account wins; this computer's value is kept in a notice the person can
 *   apply. A set-like list is joined instead. Then the file gets the
 *   account's values (`mirror`).
 * - A value deleted on another computer is deleted here too, but only when
 *   this computer's copy came from the account (`mirrored`); a value this
 *   computer never shared still moves.
 * - A value with a credential-shaped key, a folder on this computer, or over
 *   the size cap stays in the file, with a notice that says why.
 * - Signed out, no account store, or a project with no remote: none of
 *   this; the file is the setting, as before.
 *
 * Logs carry key names only, never values.
 */

/** The account settings store as this layer uses it. */
export type ProjectConfigAccountBackend = {
  get(scope: string, key: string): unknown;
  /** False when the write was refused (signed out, account switched). */
  set(scope: string, key: string, value: unknown): unknown;
  /** False when the delete was refused. */
  remove(scope: string, key: string): unknown;
  /** The rows of a scope, to find a collection's items. */
  list(scope: string): ReadonlyArray<{ key: string }>;
  /** Keys some computer deleted, so a stale copy does not come back. */
  deletedKeys(scope: string): ReadonlyArray<{ key: string }>;
};

type PendingConflict = { row: string; localValue: unknown };
type LayerState = {
  /** The account these rows belong to; another account starts afresh. */
  account: string | null;
  /**
   * The first move for this account has run. Until then the file is the
   * setting: an account value written over the file earlier (by a read or a
   * save) would lose this computer's value before the move could join it or
   * keep it in a notice.
   */
  moved: boolean;
  conflicts: PendingConflict[];
  /** Rows whose value in this computer's file came from the account. */
  mirrored: string[];
};

type Logger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

type Target = {
  backend: ProjectConfigAccountBackend;
  scope: string;
  account: string;
  /** Deleted rows, read once per operation. */
  deleted: Set<string>;
};

export function createProjectConfigAccountLayer(args: {
  /** The account settings store, or null while signed out or without one. */
  backend: () => ProjectConfigAccountBackend | null;
  /** The signed-in account, or null. */
  accountUserId: () => string | null;
  /** The project's origin URL, or null when it has no remote. */
  readOriginUrl: () => string | null;
  /** Per-project, per-computer state: the notices waiting for the person. */
  statePath: string;
  /** The service's own coercion and validation; values from the account pass through them. */
  rules: ProjectConfigRules;
  logger: Logger;
}) {
  // Every snapshot read coerces and checks each value; the answers repeat,
  // so they are kept briefly (a folder that appears is seen within seconds).
  const rules = memoizedRules(args.rules);
  const staticKeys = buildStaticKeys(rules);

  // A store read that throws falls back to the file. It runs on every
  // snapshot read, so it warns once per kind for this process.
  const warned = new Set<string>();
  const readFailed = (read: "origin" | "deleted" | "list" | "get", error: unknown): void => {
    if (warned.has(read)) return;
    warned.add(read);
    args.logger.warn("projectConfig.account_store_read_failed", { read, error: error instanceof Error ? error.name : "unknown" });
  };

  const active = (): Target | null => {
    const backend = args.backend();
    const account = backend ? args.accountUserId() : null;
    if (!backend || !account) return null;
    let origin: string | null = null;
    try {
      origin = args.readOriginUrl();
    } catch (error) {
      readFailed("origin", error);
      return null;
    }
    const scope = origin ? accountRepoScopeKey(origin) : null;
    if (!scope) return null;
    let deleted = new Set<string>();
    try {
      deleted = new Set(backend.deletedKeys(scope).map((entry) => entry.key));
    } catch (error) {
      // Without the list, nothing counts as deleted: values move as before.
      readFailed("deleted", error);
    }
    return { backend, scope, account, deleted };
  };

  /** Every key this operation touches: the static ones, and one per collection item. */
  const keysFor = (target: Target, files: readonly ProjectConfigFile[]): MovedKey[] => {
    let rows: string[] = [...target.deleted];
    try {
      rows = rows.concat(target.backend.list(target.scope).map((entry) => entry.key));
    } catch (error) {
      // A collection then shows the file's items only.
      readFailed("list", error);
    }
    rows = rows.filter((row) => PROJECT_CONFIG_ACCOUNT_COLLECTION_PREFIXES.some((prefix) => row.startsWith(prefix)));
    return [...staticKeys, ...buildCollectionKeys(rules, files, rows)];
  };

  /** A store write; false when it was refused or threw. */
  const attempt = (write: () => unknown): boolean => {
    try {
      return write() !== false;
    } catch {
      return false;
    }
  };

  const accountValue = (target: Target, key: MovedKey): unknown => {
    try {
      return key.coerce(target.backend.get(target.scope, key.row));
    } catch (error) {
      readFailed("get", error);
      return undefined;
    }
  };

  // ── This computer's state ────────────────────────────────────────────

  // Read once, then kept in memory: only this brain writes the file, and
  // every snapshot read asks for it.
  let state: LayerState | null = null;

  const readState = (account: string): LayerState => {
    if (!state) {
      state = { account: null, moved: false, conflicts: [], mirrored: [] };
      try {
        const parsed = JSON.parse(fs.readFileSync(args.statePath, "utf8")) as unknown;
        if (isRecord(parsed)) {
          state = {
            account: typeof parsed.account === "string" ? parsed.account : null,
            moved: parsed.moved === true,
            conflicts: Array.isArray(parsed.conflicts)
              ? parsed.conflicts.filter((entry): entry is PendingConflict => isRecord(entry) && typeof entry.row === "string")
              : [],
            mirrored: Array.isArray(parsed.mirrored) ? parsed.mirrored.filter((row): row is string => typeof row === "string") : [],
          };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          args.logger.warn("projectConfig.account_move_state_read_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
        }
      }
    }
    // Another account's notices and mirrors say nothing about this one.
    const current = state.account === account ? state : { account, moved: false, conflicts: [], mirrored: [] };
    return { account, moved: current.moved, conflicts: [...current.conflicts], mirrored: [...current.mirrored] };
  };

  const writeState = (next: LayerState): void => {
    if (state && isDeepStrictEqual(state, next)) return;
    state = { account: next.account, moved: next.moved, conflicts: [...next.conflicts], mirrored: [...next.mirrored] };
    try {
      fs.mkdirSync(path.dirname(args.statePath), { recursive: true });
      const tmp = `${args.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(tmp, args.statePath);
    } catch (error) {
      args.logger.warn("projectConfig.account_move_state_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
    }
  };

  /** Deleted in the account after this computer's copy came from there: gone here too. */
  const deletedHere = (target: Target, mirrored: readonly string[], key: MovedKey, current: unknown): boolean =>
    current === undefined && target.deleted.has(key.row) && mirrored.includes(key.row);

  return {
    /** The file's config with the account's value in place of each moved key. */
    overlay(local: ProjectConfigFile): ProjectConfigFile {
      const target = active();
      if (!target) return local;
      const { mirrored, moved } = readState(target.account);
      if (!moved) return local;
      let next = local;
      for (const key of keysFor(target, [local])) {
        const here = key.read(local);
        // A value that may not leave this computer is the one in use here.
        if (here !== undefined && key.hold(here)) continue;
        const value = accountValue(target, key);
        if (value !== undefined) next = key.write(next, key.combine(value, here));
        else if (deletedHere(target, mirrored, key, value)) next = key.write(next, key.localOnly(here));
      }
      return next;
    },

    /**
     * Route a save. `candidate` is what the person saves; `file` is what the
     * file holds now. A moved key goes to the account only when the person
     * changed it: it differs from the file AND from the account's current
     * value. A save from a snapshot read before another computer's change
     * is refused earlier, by the base hash (`fingerprint` is part of it).
     * Returns the config to write to the file, which carries the account's
     * value for every moved key (the one-release mirror).
     */
    routeSave(candidate: ProjectConfigFile, file: ProjectConfigFile): ProjectConfigFile {
      const target = active();
      if (!target) return candidate;
      const saved = readState(target.account);
      // Before the first move the file is the setting; the move takes it.
      if (!saved.moved) return candidate;
      let toFile = candidate;
      const written: string[] = [];
      for (const key of keysFor(target, [candidate, file])) {
        const raw = key.read(candidate);
        // It stays in this file (a secret, a folder here, too large).
        if (raw !== undefined && key.hold(raw)) continue;
        const wanted = key.coerce(raw);
        const current = accountValue(target, key);
        const before = key.coerce(key.read(file));
        // The person cleared it: the file (a mirror of the account) had it,
        // the save does not, or keeps only this computer's own parts.
        const cleared = raw === undefined
          || (wanted === undefined && key.localParts !== undefined && isDeepStrictEqual(raw, key.localOnly(raw)));
        if (cleared && current !== undefined && before !== undefined) {
          if (attempt(() => target.backend.remove(target.scope, key.row))) written.push(key.row);
          else {
            args.logger.warn("projectConfig.account_setting_write_refused", { key: key.row });
            toFile = key.write(toFile, key.combine(current, raw));
          }
          continue;
        }
        if (wanted !== undefined && !isDeepStrictEqual(wanted, before) && !isDeepStrictEqual(wanted, current)) {
          if (attempt(() => target.backend.set(target.scope, key.row, wanted))) {
            written.push(key.row);
            if (!saved.mirrored.includes(key.row)) saved.mirrored.push(key.row);
          } else {
            args.logger.warn("projectConfig.account_setting_write_refused", { key: key.row });
          }
          continue;
        }
        if (current !== undefined) {
          toFile = key.write(toFile, key.combine(current, raw));
          if (!saved.mirrored.includes(key.row)) saved.mirrored.push(key.row);
        }
      }
      if (written.length > 0) {
        args.logger.info("projectConfig.account_settings_saved", { keys: written });
        // A save of the key settles its notice.
        saved.conflicts = saved.conflicts.filter((entry) => !written.includes(entry.row));
      }
      writeState(saved);
      return toFile;
    },

    /**
     * Write-if-absent: each moved key the file sets and the account does not
     * goes to the account. Call only after the account store has synced, so
     * another computer's row is known. Never throws.
     */
    move(file: ProjectConfigFile): { moved: string[]; joined: string[]; conflicts: string[] } {
      const result = { moved: [] as string[], joined: [] as string[], conflicts: [] as string[] };
      const target = active();
      if (!target) return result;
      const pending = readState(target.account);
      for (const key of keysFor(target, [file])) {
        try {
          const local = key.coerce(key.read(file));
          if (local === undefined) continue;
          const current = accountValue(target, key);
          if (current === undefined) {
            // Deleted elsewhere after it came from the account: `mirror` removes it.
            if (deletedHere(target, pending.mirrored, key, current)) continue;
            if (attempt(() => target.backend.set(target.scope, key.row, local))) result.moved.push(key.row);
            continue;
          }
          if (isDeepStrictEqual(current, local)) continue;
          // The file's value came from the account: an older copy, not this
          // computer's own choice. `mirror` brings it up to date; joining or
          // keeping it would bring back what another computer changed.
          if (pending.mirrored.includes(key.row)) continue;
          if (key.union && Array.isArray(current) && Array.isArray(local)) {
            const joined = key.coerce([...new Set([...current, ...local])]);
            if (Array.isArray(joined) && joined.length === current.length) continue;
            if (Array.isArray(joined) && attempt(() => target.backend.set(target.scope, key.row, joined))) {
              result.joined.push(key.row);
              continue;
            }
            // Not joined (too large, or refused): this computer's list goes
            // to a notice below, before `mirror` replaces it.
          }
          if (!pending.conflicts.some((entry) => entry.row === key.row)) {
            pending.conflicts.push({ row: key.row, localValue: local });
            result.conflicts.push(key.row);
          }
        } catch (error) {
          args.logger.warn("projectConfig.account_move_failed", { key: key.row, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      pending.moved = true;
      writeState(pending);
      for (const row of result.conflicts) args.logger.info("projectConfig.account_move_conflict", { key: row });
      if (result.moved.length > 0 || result.joined.length > 0) {
        args.logger.info("projectConfig.account_settings_moved", { moved: result.moved, joined: result.joined });
      }
      return result;
    },

    /** The account's values of the moved keys, as text; null when there is no account layer in use. */
    fingerprint(): string | null {
      const target = active();
      if (!target || !readState(target.account).moved) return null;
      return JSON.stringify(keysFor(target, []).map((key) => [key.row, accountValue(target, key) ?? null]));
    },

    /**
     * The file with the account's value for each moved key (and without the
     * values deleted elsewhere), or null when the file already matches. The
     * one-release mirror; it also records which rows the file now mirrors.
     */
    mirror(file: ProjectConfigFile): ProjectConfigFile | null {
      const target = active();
      if (!target) return null;
      const saved = readState(target.account);
      let next = file;
      let changed = false;
      for (const key of keysFor(target, [file])) {
        const here = key.read(file);
        if (here !== undefined && key.hold(here)) continue;
        const value = accountValue(target, key);
        if (value === undefined) {
          const kept = key.localOnly(here);
          if (deletedHere(target, saved.mirrored, key, value) && here !== undefined && !isDeepStrictEqual(kept, here)) {
            // This computer's own parts (its writable folders) stay.
            next = key.write(next, kept);
            changed = true;
          }
          saved.mirrored = saved.mirrored.filter((row) => row !== key.row);
          continue;
        }
        if (!saved.mirrored.includes(key.row)) saved.mirrored.push(key.row);
        const combined = key.combine(value, here);
        if (isDeepStrictEqual(combined, here)) continue;
        next = key.write(next, combined);
        changed = true;
      }
      writeState(saved);
      return changed ? next : null;
    },

    /**
     * The notices for Settings: a key whose value on this computer differed
     * from the account's when it moved, and a value that stays in `file`.
     */
    notices(file: ProjectConfigFile): ProjectConfigAccountNotice[] {
      const target = active();
      if (!target) return [];
      const keys = keysFor(target, [file]);
      const out: ProjectConfigAccountNotice[] = [];
      for (const entry of readState(target.account).conflicts) {
        const key = keys.find((candidate) => candidate.row === entry.row);
        // Settled meanwhile: the account now holds this computer's value.
        if (!key || isDeepStrictEqual(accountValue(target, key), entry.localValue)) continue;
        out.push({ kind: "account_setting", key: key.row, label: key.label });
      }
      for (const key of keys) {
        const here = key.read(file);
        const hold = here === undefined ? null : key.hold(here);
        if (!hold) continue;
        out.push(hold.reason === "secret"
          ? { kind: "kept_here", key: key.row, label: key.label, reason: "secret", names: hold.names }
          : { kind: "kept_here", key: key.row, label: key.label, reason: hold.reason });
      }
      return out;
    },

    /**
     * The person's answer to a notice: `use_local` puts this computer's value
     * in the account; `keep` keeps the account's. Either way the notice goes.
     */
    resolve(row: string, choice: "use_local" | "keep"): boolean {
      const target = active();
      if (!target) return false;
      const pending = readState(target.account);
      const entry = pending.conflicts.find((candidate) => candidate.row === row);
      if (!entry) return false;
      if (choice === "use_local") {
        const key = keysFor(target, []).find((candidate) => candidate.row === row)
          ?? buildCollectionKeys(rules, [], [row])[0];
        const value = key?.coerce(entry.localValue);
        if (!key || value === undefined) return false;
        if (!attempt(() => target.backend.set(target.scope, key.row, value))) return false;
      }
      pending.conflicts = pending.conflicts.filter((candidate) => candidate.row !== row);
      writeState(pending);
      args.logger.info("projectConfig.account_move_notice_resolved", { key: row, choice });
      return true;
    },
  };
}

const RULE_MEMO_MS = 5_000;
const RULE_MEMO_MAX = 500;

function memoizedRules(rules: ProjectConfigRules): ProjectConfigRules {
  const memo = <T>(fn: (input: ProjectConfigFile | unknown) => T, copy: (value: T) => T) => {
    const cache = new Map<string, { at: number; value: T }>();
    return (input: unknown): T => {
      const key = JSON.stringify(input) ?? "undefined";
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.at < RULE_MEMO_MS) return copy(hit.value);
      const value = fn(input);
      if (cache.size >= RULE_MEMO_MAX) cache.clear();
      cache.set(key, { at: now, value });
      return copy(value);
    };
  };
  return {
    // A copy each time: the caller may build a snapshot from it.
    coerceFile: memo((raw) => rules.coerceFile(raw), (value) => structuredClone(value)),
    validAlone: memo((partial) => rules.validAlone(partial as ProjectConfigFile), (value) => value),
  };
}

export type ProjectConfigAccountLayer = ReturnType<typeof createProjectConfigAccountLayer>;
