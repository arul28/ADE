/**
 * The launch-surface flag spellings, and nothing else.
 *
 * This module imports NOTHING, on purpose. cli.ts and launchArgs.ts import
 * each other, and ESM evaluates imports before the importer's own body, so
 * whichever of the two has its body run first sees the other's bindings still
 * uninitialized — which is why the cli.ts value-carrier table used to
 * re-spell these names as string literals, with a comment explaining that it
 * had to. A leaf module has no cycle to be caught in: it is fully evaluated
 * before either importer's top level runs, so both files can spread these at
 * module scope and there is exactly one place a new spelling has to be added.
 */

/**
 * The spawn-kind flag spelling: `readAgentSpawnLineage` reads it and `lanes
 * create-from-linear` refuses it without `--start-chat`, so a new spelling
 * added to one and not the other would be silently accepted by the command
 * that launches nothing.
 */
export const SPAWN_TYPE_FLAGS = ["--type", "--spawn-type"] as const;

/**
 * The parent-session flag spelling `lanes create-from-linear --start-chat`
 * uses. `--parent` is deliberately absent: on that command it names the parent
 * LANE, not the parent chat session.
 */
export const CHAT_PARENT_FLAGS = [
  "--chat-parent",
  "--parent-session",
  "--parent-session-id",
] as const;

/** The parent-session flags every other launch surface uses. */
export const DEFAULT_PARENT_FLAGS = [
  "--parent",
  "--parent-session",
  "--parent-session-id",
] as const;
