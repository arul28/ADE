import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import type { ProjectConfigAccountNotice, ProjectConfigFile } from "../../../shared/types";

/**
 * Settings in `.ade/local.yaml` that follow the ADE account (account project
 * plan, slices Y2 and Y3). Each is one account row under the project's repository
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
};

/** One setting that follows the account: where it sits in the file, and its row. */
type MovedKeySpec = {
  /** The account row's key, under the repository scope. */
  row: string;
  /** What Settings calls it, for the notice. */
  label: string;
  /** Where the value sits in `ProjectConfigFile`. */
  path: readonly string[];
  /** A set-like list: the move joins both sides instead of picking one. */
  union?: true;
  /**
   * Parts of the value that belong to this computer (paths inside the
   * value, such as writable folders). They never go to the account and stay
   * in this computer's file.
   */
  localParts?: ReadonlyArray<readonly string[]>;
};

type MovedKey = MovedKeySpec & {
  /** The file's value, or undefined when the file does not set it. */
  read(local: ProjectConfigFile): unknown;
  /** The file with `value` in this key's place. */
  write(local: ProjectConfigFile, value: unknown): ProjectConfigFile;
  /** The value as the account keeps it (coerced, local parts dropped), or undefined when it cannot go there. */
  coerce(value: unknown): unknown;
  /** The account's value with this computer's local parts from `here` put back. */
  combine(accountValue: unknown, here: unknown): unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * The relay's cap on one setting's JSON (`MAX_SETTING_VALUE_BYTES`). A larger
 * value stays in this computer's file.
 */
const MAX_ACCOUNT_VALUE_CHARS = 16_000;

function getIn(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setIn<T>(value: T, path: readonly string[], next: unknown): T {
  if (path.length === 0) return next as T;
  const [head, ...rest] = path;
  const record: Record<string, unknown> = isRecord(value) ? value : {};
  const child = setIn(record[head!], rest, next);
  const out: Record<string, unknown> = { ...record };
  if (child === undefined) delete out[head!];
  else out[head!] = child;
  return out as T;
}

const PR_AND_TRACKER_KEYS: readonly MovedKeySpec[] = [
  { row: "prs.pollIntervalSeconds", label: "How often ADE checks pull requests", path: ["github", "prPollingIntervalSeconds"] },
  { row: "prs.transcriptGists", label: "PR chat transcripts", path: ["github", "prTranscriptGists", "enabled"] },
  { row: "prs.autoMapByBranch", label: "Link pull requests to lanes by branch", path: ["github", "autoMapByBranch"] },
  { row: "jira.projectKeys", label: "Jira projects", path: ["issueTrackers", "jira", "projectKeys"], union: true },
  { row: "linear.batchLaunchPrompt", label: "Default prompt for Linear batch launches", path: ["ui", "linearBatchLaunchDefaultPrompt"] },
];

/**
 * AI preferences (slice Y3). Not here, by design: `apiKeys` (the key store),
 * `localProviders` (servers on this computer), `customProviders` (one row
 * per provider, its own slice), and the chat's `scheduledWorkPaused` and
 * `continueAfterRestart`, which act on this computer's chats.
 */
const AI_KEYS: readonly MovedKeySpec[] = [
  { row: "ai.mode", label: "AI mode", path: ["ai", "mode"] },
  { row: "ai.defaultProvider", label: "Default AI provider", path: ["ai", "defaultProvider"] },
  { row: "ai.taskRouting", label: "Models for ADE's own tasks", path: ["ai", "taskRouting"] },
  { row: "ai.features", label: "AI features", path: ["ai", "features"] },
  { row: "ai.budgets", label: "AI budgets", path: ["ai", "budgets"] },
  {
    row: "ai.permissions",
    label: "Agent permissions",
    path: ["ai", "permissions"],
    // Folders on this computer.
    localParts: [["cli", "writablePaths"], ["providers", "writablePaths"]],
  },
  { row: "ai.conflictResolution", label: "Conflict resolution", path: ["ai", "conflictResolution"] },
  { row: "ai.compaction", label: "Context compaction", path: ["ai", "compaction"] },
  { row: "ai.customModelSlugs", label: "Extra models", path: ["ai", "customModelSlugs"], union: true },
  { row: "ai.disabledProviders", label: "Turned-off providers", path: ["ai", "disabledProviders"] },
  { row: "ai.workerSafety", label: "Worker safety", path: ["ai", "workerSafety"] },
  { row: "ai.featureModelOverrides", label: "Model per AI feature", path: ["ai", "featureModelOverrides"] },
  { row: "ai.featureReasoningOverrides", label: "Reasoning per AI feature", path: ["ai", "featureReasoningOverrides"] },
  { row: "ai.sessionIntelligence", label: "Chat titles and summaries", path: ["ai", "sessionIntelligence"] },
  ...([
    ["defaultProvider", "Default chat provider"],
    ["defaultApprovalPolicy", "Default approval policy"],
    ["sendOnEnter", "Send on Enter"],
    ["autoTitleReasoningEffort", "Reasoning for chat titles"],
    ["codexSandbox", "Codex sandbox"],
    ["claudePermissionMode", "Claude permission mode"],
    ["sessionBudgetUsd", "Chat budget"],
    ["opencodePermissionMode", "OpenCode permission mode"],
    ["autoAllowAskUser", "Answer agent questions automatically"],
    ["piExtensionsEnabled", "Pi extensions"],
    ["claudePluginUiEnabled", "Claude plugin UI"],
    ["promptSuggestionsEnabled", "Prompt suggestions"],
    ["codexPromptSuggestionsEnabled", "Codex prompt suggestions"],
    ["smartDecisionsEnabled", "Smart decisions"],
    ["jevZenCreditEnabled", "Jev Zen credit"],
    ["smartChatStatusEnabled", "Smart chat status"],
    ["smartSettleNudgeEnabled", "Settle nudges"],
    ["smartPaletteEnabled", "Smart palette"],
    ["smartLaneEmojiEnabled", "Lane emoji"],
    ["smartPlainTerminalsEnabled", "Plain terminals"],
    ["modelHintMode", "Model hint"],
  ] as const).map(([field, label]): MovedKeySpec => ({ row: `ai.chat.${field}`, label, path: ["ai", "chat", field] })),
];

const MOVED_KEY_SPECS: readonly MovedKeySpec[] = [...PR_AND_TRACKER_KEYS, ...AI_KEYS];

/** The account rows the layer keeps, for Settings and docs. */
export const PROJECT_CONFIG_ACCOUNT_ROWS = MOVED_KEY_SPECS.map((key) => key.row);
/** The rows of the AI preferences, for the notice on the AI settings page. */
export const PROJECT_CONFIG_ACCOUNT_AI_ROWS = AI_KEYS.map((key) => key.row);

/**
 * Build the keys over the service's own coercion, so a value from the
 * account has exactly the shape a value from the file has (a newer ADE's
 * unknown field is dropped, a bad value is ignored).
 */
function buildMovedKeys(coerceFile: (raw: unknown) => ProjectConfigFile): MovedKey[] {
  return MOVED_KEY_SPECS.map((spec) => {
    const dropLocal = (value: unknown): unknown => {
      let next = value;
      for (const part of spec.localParts ?? []) next = setIn(next, part, undefined);
      return next;
    };
    return {
      ...spec,
      read: (local) => getIn(local, spec.path),
      write: (local, value) => setIn(local, spec.path, value),
      coerce: (value) => {
        if (value === undefined) return undefined;
        let coerced: unknown;
        try {
          coerced = getIn(coerceFile(setIn({}, spec.path, dropLocal(value))), spec.path);
        } catch {
          return undefined;
        }
        if (coerced === undefined || (Array.isArray(coerced) && coerced.length === 0)) return undefined;
        if (isRecord(coerced) && Object.keys(coerced).length === 0) return undefined;
        return JSON.stringify(coerced).length <= MAX_ACCOUNT_VALUE_CHARS ? coerced : undefined;
      },
      combine: (accountValue, here) => {
        let next = accountValue;
        for (const part of spec.localParts ?? []) {
          const mine = getIn(here, part);
          if (mine !== undefined) next = setIn(next, part, mine);
        }
        return next;
      },
    };
  });
}

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
  /** The service's own coercion of a whole file; values from the account pass through it. */
  coerceFile: (raw: unknown) => ProjectConfigFile;
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

  const movedKeys = buildMovedKeys(args.coerceFile);

  /** A store write; false when it was refused or threw. */
  const attempt = (write: () => unknown): boolean => {
    try {
      return write() !== false;
    } catch {
      return false;
    }
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
      for (const key of movedKeys) {
        const value = accountValue(target, key);
        if (value !== undefined) next = key.write(next, key.combine(value, key.read(local)));
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
      let toFile = candidate;
      const written: string[] = [];
      for (const key of movedKeys) {
        const raw = key.read(candidate);
        const wanted = key.coerce(raw);
        const current = accountValue(target, key);
        const before = key.coerce(key.read(file));
        // The person cleared it: the file (a mirror of the account) had it,
        // the save does not.
        if (raw === undefined && current !== undefined && before !== undefined) {
          if (attempt(() => target.backend.remove(target.scope, key.row))) written.push(key.row);
          else {
            args.logger.warn("projectConfig.account_setting_write_refused", { key: key.row });
            toFile = key.write(toFile, key.combine(current, raw));
          }
          continue;
        }
        if (wanted !== undefined && !isDeepStrictEqual(wanted, before) && !isDeepStrictEqual(wanted, current)) {
          if (attempt(() => target.backend.set(target.scope, key.row, wanted))) written.push(key.row);
          else args.logger.warn("projectConfig.account_setting_write_refused", { key: key.row });
          continue;
        }
        if (current !== undefined) toFile = key.write(toFile, key.combine(current, raw));
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
      for (const key of movedKeys) {
        try {
          const local = key.coerce(key.read(file));
          if (local === undefined) continue;
          const current = accountValue(target, key);
          if (current === undefined) {
            if (attempt(() => target.backend.set(target.scope, key.row, local))) result.moved.push(key.row);
            continue;
          }
          if (isDeepStrictEqual(current, local)) continue;
          if (key.union && Array.isArray(current) && Array.isArray(local)) {
            const joined = key.coerce([...new Set([...current, ...local])]);
            if (Array.isArray(joined) && joined.length !== current.length
              && attempt(() => target.backend.set(target.scope, key.row, joined))) {
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
      return JSON.stringify(movedKeys.map((key) => accountValue(target, key) ?? null));
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
      for (const key of movedKeys) {
        const value = accountValue(target, key);
        if (value === undefined) continue;
        const here = key.read(file);
        const combined = key.combine(value, here);
        if (isDeepStrictEqual(combined, here)) continue;
        next = key.write(next, combined);
        changed = true;
      }
      return changed ? next : null;
    },

    /** The notices for Settings: a key whose value on this computer differs from the account's. */
    notices(): ProjectConfigAccountNotice[] {
      const target = active();
      if (!target) return [];
      return readState().conflicts.flatMap((entry) => {
        const key = movedKeys.find((candidate) => candidate.row === entry.row);
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
        const key = movedKeys.find((candidate) => candidate.row === row);
        const value = key?.coerce(entry.localValue);
        if (!target || !key || value === undefined) return false;
        if (!attempt(() => target.backend.set(target.scope, key.row, value))) return false;
      }
      writeState({ conflicts: pending.conflicts.filter((candidate) => candidate.row !== row) });
      args.logger.info("projectConfig.account_move_notice_resolved", { key: row, choice });
      return true;
    },
  };
}

export type ProjectConfigAccountLayer = ReturnType<typeof createProjectConfigAccountLayer>;
