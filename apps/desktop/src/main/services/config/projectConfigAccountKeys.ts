import path from "node:path";
import { credentialKeyNames } from "../../../shared/credentialKeys";
import type { ProjectConfigFile } from "../../../shared/types";

/**
 * Which settings of `.ade/local.yaml` follow the ADE account, and how each
 * one maps between the file and its account row (account project plan,
 * slices Y2 to Y4). The behavior lives in `projectConfigAccountLayer.ts`.
 */

/** One setting that follows the account: where it sits in the file, and its row. */
export type MovedKeySpec = {
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
  /**
   * Check the value alone with the config's own validation: an invalid value
   * from the account would make every computer's config invalid.
   */
  validate?: true;
};

/** Why a value stays in this computer's file instead of the account. */
export type MovedKeyHold =
  | { reason: "secret"; names: string[] }
  | { reason: "too_large" }
  | { reason: "machine_path" };

export type MovedKey = MovedKeySpec & {
  /** The file's value, or undefined when the file does not set it. */
  read(local: ProjectConfigFile): unknown;
  /** The file with `value` in this key's place (undefined removes it). */
  write(local: ProjectConfigFile, value: unknown): ProjectConfigFile;
  /** The value as the account keeps it (coerced, local parts dropped), or undefined when it cannot or may not go there. */
  coerce(value: unknown): unknown;
  /** Why this computer's value may not go to the account, or null. */
  hold(value: unknown): MovedKeyHold | null;
  /** The account's value with this computer's local parts from `here` put back. */
  combine(accountValue: unknown, here: unknown): unknown;
  /** Only this computer's local parts of `here` (undefined when it has none): what stays when the account row goes. */
  localOnly(here: unknown): unknown;
};

/**
 * A list in the file whose items each follow the account as one row
 * (`<rowPrefix><id>`), so two computers can add items at the same time.
 */
type CollectionSpec = {
  rowPrefix: string;
  path: readonly string[];
  label: (id: string, item: unknown) => string;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
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
  { row: "prs.pollIntervalSeconds", label: "How often ADE checks pull requests", path: ["github", "prPollingIntervalSeconds"], validate: true },
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

/**
 * Repository recipes (slice Y4). A suite or the lane setup with a
 * credential-shaped value (`API_TOKEN` in `env`) stays on this computer,
 * and so does one over the size cap; Settings says which and why.
 */
const RECIPE_KEYS: readonly MovedKeySpec[] = [
  { row: "lanes.envInit", label: "Lane setup", path: ["laneEnvInit"], validate: true },
];

const COLLECTIONS: readonly CollectionSpec[] = [
  {
    rowPrefix: "tests.suite.",
    path: ["testSuites"],
    label: (id, item) => {
      const name = isRecord(item) && typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
      return `Test suite "${name}"`;
    },
  },
];

const MOVED_KEY_SPECS: readonly MovedKeySpec[] = [...PR_AND_TRACKER_KEYS, ...AI_KEYS, ...RECIPE_KEYS];

/** Keys whose value is a path; an absolute one names a folder on this computer. */
const PATH_KEYS = new Set(["cwd", "source", "dest", "composePath"]);

function holdsMachinePath(value: unknown, key?: string): boolean {
  if (typeof value === "string") {
    return Boolean(key && PATH_KEYS.has(key)) && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
  }
  if (Array.isArray(value)) return value.some((entry) => holdsMachinePath(entry, key));
  if (isRecord(value)) return Object.entries(value).some(([childKey, child]) => holdsMachinePath(child, childKey));
  return false;
}

function itemId(item: unknown): string | null {
  return isRecord(item) && typeof item.id === "string" && item.id.trim() ? item.id.trim() : null;
}

/**
 * The config service's own rules, so a value from the account has exactly the
 * shape a value from the file has (a newer ADE's unknown field is dropped, a
 * bad value is ignored), and the layer never keeps a second copy of them.
 */
export type ProjectConfigRules = {
  /** Coerce a whole file, as reading `.ade/local.yaml` does. */
  coerceFile: (raw: unknown) => ProjectConfigFile;
  /** True when a file holding only this part passes validation. */
  validAlone: (partial: ProjectConfigFile) => boolean;
};

function keyFromSpec(spec: MovedKeySpec, rules: ProjectConfigRules, access?: {
  read(local: ProjectConfigFile): unknown;
  write(local: ProjectConfigFile, value: unknown): ProjectConfigFile;
  shape(value: unknown): unknown;
  unshape(file: ProjectConfigFile): unknown;
}): MovedKey {
  const dropLocal = (value: unknown): unknown => {
    let next = value;
    for (const part of spec.localParts ?? []) next = setIn(next, part, undefined);
    return next;
  };
  const read = access?.read ?? ((local: ProjectConfigFile) => getIn(local, spec.path));
  const write = access?.write ?? ((local: ProjectConfigFile, value: unknown) => setIn(local, spec.path, value));
  const shape = access?.shape ?? ((value: unknown) => setIn({}, spec.path, value));
  const unshape = access?.unshape ?? ((file: ProjectConfigFile) => getIn(file, spec.path));
  const coerceFull = (value: unknown): unknown => {
    if (value === undefined) return undefined;
    let coerced: unknown;
    try {
      const file = rules.coerceFile(shape(dropLocal(value)));
      coerced = unshape(file);
      if (coerced !== undefined && spec.validate && !rules.validAlone(shape(coerced) as ProjectConfigFile)) return undefined;
    } catch {
      return undefined;
    }
    if (coerced === undefined || (Array.isArray(coerced) && coerced.length === 0)) return undefined;
    if (isRecord(coerced) && Object.keys(coerced).length === 0) return undefined;
    return coerced;
  };
  const holdOf = (coerced: unknown): MovedKeyHold | null => {
    if (coerced === undefined) return null;
    const names = credentialKeyNames(coerced);
    if (names.length > 0) return { reason: "secret", names };
    if (holdsMachinePath(coerced)) return { reason: "machine_path" };
    if (JSON.stringify(coerced).length > MAX_ACCOUNT_VALUE_CHARS) return { reason: "too_large" };
    return null;
  };
  return {
    ...spec,
    read,
    write,
    coerce: (value) => {
      const coerced = coerceFull(value);
      return holdOf(coerced) ? undefined : coerced;
    },
    hold: (value) => holdOf(coerceFull(value)),
    combine: (accountValue, here) => {
      let next = accountValue;
      for (const part of spec.localParts ?? []) {
        const mine = getIn(here, part);
        if (mine !== undefined) next = setIn(next, part, mine);
      }
      return next;
    },
    localOnly: (here) => {
      let next: unknown = undefined;
      for (const part of spec.localParts ?? []) {
        const mine = getIn(here, part);
        if (mine !== undefined) next = setIn(next ?? {}, part, mine);
      }
      return next;
    },
  };
}

export function buildStaticKeys(rules: ProjectConfigRules): MovedKey[] {
  return MOVED_KEY_SPECS.map((spec) => keyFromSpec(spec, rules));
}

/**
 * One key per item of each collection, for the ids in `files` (the file, a
 * save) and `rows` (the account's row keys, deleted ones included).
 */
export function buildCollectionKeys(
  rules: ProjectConfigRules,
  files: readonly ProjectConfigFile[],
  rows: readonly string[],
): MovedKey[] {
  const keys: MovedKey[] = [];
  for (const collection of COLLECTIONS) {
    const items = (file: ProjectConfigFile): unknown[] => {
      const list = getIn(file, collection.path);
      return Array.isArray(list) ? list : [];
    };
    const ids = new Set<string>();
    const names = new Map<string, unknown>();
    for (const file of files) {
      for (const item of items(file)) {
        const id = itemId(item);
        if (!id) continue;
        ids.add(id);
        if (!names.has(id)) names.set(id, item);
      }
    }
    for (const row of rows) if (row.startsWith(collection.rowPrefix) && row.length > collection.rowPrefix.length) ids.add(row.slice(collection.rowPrefix.length));
    for (const id of ids) {
      const find = (file: ProjectConfigFile) => items(file).find((item) => itemId(item) === id);
      keys.push(keyFromSpec(
        { row: `${collection.rowPrefix}${id}`, label: collection.label(id, names.get(id)), path: collection.path, validate: true },
        rules,
        {
          read: find,
          write: (local, value) => {
            const list = items(local);
            const at = list.findIndex((item) => itemId(item) === id);
            const next = [...list];
            if (value === undefined) {
              if (at < 0) return local;
              next.splice(at, 1);
            } else if (at < 0) next.push(value);
            else next[at] = value;
            return setIn(local, collection.path, next.length > 0 ? next : undefined);
          },
          // An item from the account must keep its own id.
          shape: (value) => setIn({}, collection.path, [value]),
          unshape: (file) => {
            const list = getIn(file, collection.path);
            const item = Array.isArray(list) ? list[0] : undefined;
            return itemId(item) === id ? item : undefined;
          },
        },
      ));
    }
  }
  return keys;
}

/** Row prefixes of the collections, to list their rows in the account. */
export const PROJECT_CONFIG_ACCOUNT_COLLECTION_PREFIXES = COLLECTIONS.map((c) => c.rowPrefix);
