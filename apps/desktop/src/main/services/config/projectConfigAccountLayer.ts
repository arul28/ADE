import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import type { ProjectConfigAccountNotice, ProjectConfigFile } from "../../../shared/types";

/**
 * Settings in `.ade/local.yaml` that follow the ADE account (account project
 * plan, slice Y2). Each is one account row under the project's repository
 * (`repo:<origin>`), so every computer that opens the repository uses the same
 * value.
 *
 * - Read: the account row, when there is one, replaces the file's value.
 * - Write: a value a person changed goes to the account. The file still gets
 *   the account's value for one release, so an older ADE process on this
 *   computer (a stale `ade` on PATH) sees it too.
 * - Move: once the account has synced, a value only the file has is written
 *   to the account (write-if-absent). A different value already in the
 *   account wins; this computer's value is kept in a notice the person can
 *   apply. A set-like list is joined instead. Then the file gets the
 *   account's values (`mirror`), so from here on a file value is always a
 *   value the account once had.
 * - Signed out, no account store, or a project with no GitHub remote: none of
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
};

type MovedKey = {
  /** The account row's key, under the repository scope. */
  row: string;
  /** What Settings calls it, for the notice. */
  label: string;
  /** The file's value, or undefined when the file does not set it. */
  read(local: ProjectConfigFile): unknown;
  /** The file with `value` in this key's place. */
  write(local: ProjectConfigFile, value: unknown): ProjectConfigFile;
  /** A stored row's value, or undefined when it is not a valid value for this key. */
  coerce(value: unknown): unknown;
  /** A set-like list: the move joins both sides instead of picking one. */
  union?: true;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const MAX_PROMPT_CHARS = 8_000;
/** The form `coerceJiraProjectKeys` keeps. */
const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,9}$/;

const MOVED_KEYS: readonly MovedKey[] = [
  {
    row: "prs.pollIntervalSeconds",
    label: "How often ADE checks pull requests",
    read: (local) => local.github?.prPollingIntervalSeconds,
    write: (local, value) => ({ ...local, github: { ...(local.github ?? {}), prPollingIntervalSeconds: value as number } }),
    coerce: (value) => (typeof value === "number" && Number.isFinite(value) && value >= 5 && value <= 300 ? value : undefined),
  },
  {
    row: "prs.transcriptGists",
    label: "PR chat transcripts",
    read: (local) => local.github?.prTranscriptGists?.enabled,
    write: (local, value) => ({ ...local, github: { ...(local.github ?? {}), prTranscriptGists: { enabled: value as boolean } } }),
    coerce: (value) => (typeof value === "boolean" ? value : undefined),
  },
  {
    row: "prs.autoMapByBranch",
    label: "Link pull requests to lanes by branch",
    read: (local) => local.github?.autoMapByBranch,
    write: (local, value) => ({ ...local, github: { ...(local.github ?? {}), autoMapByBranch: value as boolean } }),
    coerce: (value) => (typeof value === "boolean" ? value : undefined),
  },
  {
    row: "jira.projectKeys",
    label: "Jira projects",
    read: (local) => {
      const keys = local.issueTrackers?.jira?.projectKeys;
      return Array.isArray(keys) && keys.length > 0 ? keys : undefined;
    },
    write: (local, value) => ({
      ...local,
      issueTrackers: { ...(local.issueTrackers ?? {}), jira: { ...(local.issueTrackers?.jira ?? {}), projectKeys: value as string[] } },
    }),
    coerce: (value) => (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && JIRA_KEY.test(entry))
      ? value
      : undefined),
    union: true,
  },
  {
    row: "linear.batchLaunchPrompt",
    label: "Default prompt for Linear batch launches",
    read: (local) => {
      const prompt = local.ui?.linearBatchLaunchDefaultPrompt;
      return typeof prompt === "string" && prompt.trim() ? prompt : undefined;
    },
    write: (local, value) => ({ ...local, ui: { ...(local.ui ?? {}), linearBatchLaunchDefaultPrompt: value as string } }),
    coerce: (value) => (typeof value === "string" && value.trim() && value.length <= MAX_PROMPT_CHARS ? value : undefined),
  },
];

/** The keys Y2 moves, for tests and docs. */
export const PROJECT_CONFIG_ACCOUNT_ROWS = MOVED_KEYS.map((key) => key.row);

type PendingConflict = { row: string; localValue: unknown };
type LayerState = { conflicts: PendingConflict[] };

type Logger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
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
  logger: Logger;
}) {
  const scope = (): string | null => {
    if (!args.accountUserId()) return null;
    let origin: string | null = null;
    try {
      origin = args.readOriginUrl();
    } catch {
      return null;
    }
    return origin ? accountRepoScopeKey(origin) : null;
  };

  const active = (): { backend: ProjectConfigAccountBackend; scope: string } | null => {
    const backend = args.backend();
    const repoScope = backend ? scope() : null;
    return backend && repoScope ? { backend, scope: repoScope } : null;
  };

  const accountValue = (target: { backend: ProjectConfigAccountBackend; scope: string }, key: MovedKey): unknown => {
    try {
      return key.coerce(target.backend.get(target.scope, key.row));
    } catch {
      return undefined;
    }
  };

  // ── Notices (this computer's state) ──────────────────────────────────

  // Read once, then kept in memory: only this brain writes the file, and
  // every snapshot read asks for the notices.
  let state: LayerState | null = null;

  const readState = (): LayerState => {
    if (state) return { conflicts: [...state.conflicts] };
    state = { conflicts: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(args.statePath, "utf8")) as unknown;
      if (isRecord(parsed) && Array.isArray(parsed.conflicts)) {
        state = { conflicts: parsed.conflicts.filter((entry): entry is PendingConflict => isRecord(entry) && typeof entry.row === "string") };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        args.logger.warn("projectConfig.account_move_state_read_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
      }
    }
    return { conflicts: [...state.conflicts] };
  };

  const writeState = (next: LayerState): void => {
    state = { conflicts: [...next.conflicts] };
    try {
      if (next.conflicts.length === 0) {
        fs.rmSync(args.statePath, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(args.statePath), { recursive: true });
      const tmp = `${args.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(tmp, args.statePath);
    } catch (error) {
      args.logger.warn("projectConfig.account_move_state_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
    }
  };

  return {
    /** The file's config with the account's value in place of each moved key. */
    overlay(local: ProjectConfigFile): ProjectConfigFile {
      const target = active();
      if (!target) return local;
      let next = local;
      for (const key of MOVED_KEYS) {
        const value = accountValue(target, key);
        if (value !== undefined) next = key.write(next, value);
      }
      return next;
    },

    /**
     * Route a save. `candidate` is what the person saves; `file` is what the
     * file holds now. A moved key goes to the account only when the person
     * changed it: it differs from the file AND from the account's current
     * value. A save from a snapshot read before another computer's change
     * is refused earlier, by the base hash (`fingerprint` is part of it). Returns the config to write to the file, which carries the
     * account's value for every moved key (the one-release mirror).
     */
    routeSave(candidate: ProjectConfigFile, file: ProjectConfigFile): ProjectConfigFile {
      const target = active();
      if (!target) return candidate;
      let toFile = candidate;
      const written: string[] = [];
      for (const key of MOVED_KEYS) {
        const wanted = key.read(candidate);
        const current = accountValue(target, key);
        // The person cleared it: the file (a mirror of the account) had it,
        // the save does not.
        if (wanted === undefined && current !== undefined && key.read(file) !== undefined) {
          let removed = false;
          try {
            removed = target.backend.remove(target.scope, key.row) !== false;
          } catch {
            removed = false;
          }
          if (removed) written.push(key.row);
          else {
            args.logger.warn("projectConfig.account_setting_write_refused", { key: key.row });
            toFile = key.write(toFile, current);
          }
          continue;
        }
        const changed = wanted !== undefined
          && !isDeepStrictEqual(wanted, key.read(file))
          && !isDeepStrictEqual(wanted, current);
        if (changed && key.coerce(wanted) !== undefined) {
          let saved = false;
          try {
            saved = target.backend.set(target.scope, key.row, wanted) !== false;
          } catch {
            saved = false;
          }
          if (saved) written.push(key.row);
          else args.logger.warn("projectConfig.account_setting_write_refused", { key: key.row });
          continue;
        }
        if (current !== undefined) toFile = key.write(toFile, current);
      }
      if (written.length > 0) {
        args.logger.info("projectConfig.account_settings_saved", { keys: written });
        // A save of the key settles its notice.
        const pending = readState();
        const left = pending.conflicts.filter((entry) => !written.includes(entry.row));
        if (left.length !== pending.conflicts.length) writeState({ conflicts: left });
      }
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
      const pending = readState();
      for (const key of MOVED_KEYS) {
        try {
          const local = key.read(file);
          if (local === undefined || key.coerce(local) === undefined) continue;
          const current = accountValue(target, key);
          if (current === undefined) {
            if (target.backend.set(target.scope, key.row, local) !== false) result.moved.push(key.row);
            continue;
          }
          if (isDeepStrictEqual(current, local)) continue;
          if (key.union) {
            const joined = [...new Set([...(current as string[]), ...(local as string[])])];
            if (joined.length !== (current as string[]).length && target.backend.set(target.scope, key.row, joined) !== false) {
              result.joined.push(key.row);
            }
            continue;
          }
          if (!pending.conflicts.some((entry) => entry.row === key.row)) {
            pending.conflicts.push({ row: key.row, localValue: local });
            result.conflicts.push(key.row);
          }
        } catch (error) {
          args.logger.warn("projectConfig.account_move_failed", { key: key.row, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      if (result.conflicts.length > 0) {
        writeState(pending);
        for (const row of result.conflicts) args.logger.info("projectConfig.account_move_conflict", { key: row });
      }
      if (result.moved.length > 0 || result.joined.length > 0) {
        args.logger.info("projectConfig.account_settings_moved", { moved: result.moved, joined: result.joined });
      }
      return result;
    },

    /** The account's values of the moved keys, as text; null when there is no account layer in use. */
    fingerprint(): string | null {
      const target = active();
      if (!target) return null;
      return JSON.stringify(MOVED_KEYS.map((key) => accountValue(target, key) ?? null));
    },

    /**
     * The file with the account's value for each moved key, or null when the
     * file already matches (or there is no account). The one-release mirror.
     */
    mirror(file: ProjectConfigFile): ProjectConfigFile | null {
      const target = active();
      if (!target) return null;
      let next = file;
      let changed = false;
      for (const key of MOVED_KEYS) {
        const value = accountValue(target, key);
        if (value === undefined || isDeepStrictEqual(value, key.read(file))) continue;
        next = key.write(next, value);
        changed = true;
      }
      return changed ? next : null;
    },

    /** The notices for Settings: a key whose value on this computer differs from the account's. */
    notices(): ProjectConfigAccountNotice[] {
      const target = active();
      if (!target) return [];
      return readState().conflicts.flatMap((entry) => {
        const key = MOVED_KEYS.find((candidate) => candidate.row === entry.row);
        if (!key) return [];
        // Settled meanwhile: the account now holds this computer's value.
        if (isDeepStrictEqual(accountValue(target, key), entry.localValue)) return [];
        return [{ kind: "account_setting" as const, key: key.row, label: key.label }];
      });
    },

    /**
     * The person's answer to a notice: `use_local` puts this computer's value
     * in the account; `keep` keeps the account's. Either way the notice goes.
     */
    resolve(row: string, choice: "use_local" | "keep"): boolean {
      const pending = readState();
      const entry = pending.conflicts.find((candidate) => candidate.row === row);
      if (!entry) return false;
      if (choice === "use_local") {
        const target = active();
        const key = MOVED_KEYS.find((candidate) => candidate.row === row);
        if (!target || !key || key.coerce(entry.localValue) === undefined) return false;
        if (target.backend.set(target.scope, key.row, entry.localValue) === false) return false;
      }
      writeState({ conflicts: pending.conflicts.filter((candidate) => candidate.row !== row) });
      args.logger.info("projectConfig.account_move_notice_resolved", { key: row, choice });
      return true;
    },
  };
}

export type ProjectConfigAccountLayer = ReturnType<typeof createProjectConfigAccountLayer>;
