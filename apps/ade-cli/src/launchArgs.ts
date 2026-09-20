/**
 * Every rule a session launch's identity args have to satisfy, in one module:
 * the spawn-lineage readers, the launch-profile narrowing, the merged-arg rule
 * block, and the collector that runs them.
 *
 * cli.ts is the only production importer today — all five launch surfaces (`ade new chat`,
 * `ade new chat --mode cli`, `ade shell start-cli`, `ade chat create`, and `lanes
 * create-from-linear --start-chat`) are built there. The file exists not
 * because a second importer is coming, but so that the one rule block is
 * findable as a unit instead of buried in a 28k-line file: a rule that is easy
 * to find is a rule that is hard to fork.
 *
 * The argv primitives and the CLI error type still live in cli.ts, so this
 * module imports them back. That import cycle is safe and deliberate, under
 * one rule, stated once and held on both sides:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 *
 * ESM evaluates a module's imports before its own body, so whichever of the
 * two is entered first has its body run second, and the other file's `const`
 * and `class` exports are still uninitialized while the first body runs
 * (`function` declarations are hoisted and would survive; the rule covers
 * them too so nobody has to remember which kind each name is). Production
 * enters through cli.ts, so this module's body runs first; launchArgs.test.ts
 * enters here, so cli.ts's body runs first. Every value use of
 * `CliUsageError`, `readFlag`, `readValue`, `findFlagName`,
 * `collectGenericObjectArgs` and `asCliUsageError` therefore happens inside a
 * function body, which runs long after both modules are evaluated. Type
 * annotations such as the `: CliUsageError` return type below are erased at
 * compile time and carry no binding, so they are fine at module scope.
 *
 * The flag spellings themselves live one level down, in `launchFlagNames.ts`,
 * which imports nothing at all. Both sides of the cycle can therefore spread
 * them at module scope — a leaf is fully evaluated before either importer's
 * top level runs.
 */
import {
  CliUsageError,
  asCliUsageError,
  collectGenericObjectArgs,
  findFlagName,
  readFlag,
  readValue,
  type JsonObject,
} from "./cli";
import { DEFAULT_PARENT_FLAGS, SPAWN_TYPE_FLAGS } from "./launchFlagNames";
import type { AgentChatPermissionMode } from "../../desktop/src/shared/types";
import {
  isAgentChatDroidPermissionMode,
} from "../../desktop/src/shared/types/chat";
import {
  isLaunchProfile,
  isTrackedCliPermissionMode,
  LAUNCH_PROFILES,
  validateLaunchProfilePermissionMode,
  type LaunchProfile,
} from "../../desktop/src/shared/cliLaunch";

/**
 * Parent chat-session lineage for spawned chat and agent-provider CLI
 * sessions. Defaults to the spawning agent's own session — ADE injects
 * ADE_CHAT_SESSION_ID into every tracked agent shell (chat runtimes and
 * tracked CLI/PTY sessions). `--parent <sessionId>` overrides the default;
 * `--no-parent` opts out entirely. CLI callers keep chatSessionId separate
 * because that field represents attached-terminal ownership, not lineage.
 *
 * `overrideFlags` is required: `readAgentSpawnLineage` is the only caller and
 * it already resolves the surface's own vocabulary, so a default here would
 * only be a second, never-exercised answer to the same question.
 */
function readParentSessionId(
  args: string[],
  overrideFlags: readonly string[],
): {
  parentSessionId: string | undefined;
  /**
   * The ambient `$ADE_CHAT_SESSION_ID` this launch inherits, reported even when
   * an explicit `--parent` outranks it — but NOT when `--no-parent` was passed,
   * because that is the caller explicitly opting out of lineage and nothing was
   * taken away from them.
   */
  ambientParentSessionId: string | undefined;
} {
  const override = readValue(args, overrideFlags);
  const noParent = readFlag(args, ["--no-parent"]);
  if (override && noParent) {
    throw new CliUsageError("--parent cannot be combined with --no-parent.");
  }
  if (noParent) return { parentSessionId: undefined, ambientParentSessionId: undefined };
  const env = process.env.ADE_CHAT_SESSION_ID?.trim();
  const ambientParentSessionId = env?.length ? env : undefined;
  const explicit = override?.trim();
  return {
    parentSessionId: explicit || ambientParentSessionId,
    ambientParentSessionId,
  };
}

type CliAgentSpawnKind = "subagent" | "peer";

/**
 * The spawn-lineage messages `collectLaunchArgs` and the flag readers share, as
 * one string each, so a launch rejected by the flag and the same launch
 * rejected by the merged arg bag read identically.
 */
const SPAWN_TYPE_SHELL_MESSAGE =
  "--type applies only to agent providers; plain shell terminals do not record spawn lineage.";
const SPAWN_PARENT_SHELL_MESSAGE =
  "--parent applies only to agent providers; plain shell terminals do not record spawn lineage.";
const SPAWN_TYPE_ENUM_MESSAGE =
  "--type must be subagent or peer; silent spawn type 'none' is no longer supported.";
/**
 * The two parent/spawn-kind pairing messages, hoisted for the same reason: the
 * flag reader and `assertMergedLaunchArgs` enforce the same pairing, so
 * `--parent p` without `--type` and `--arg orchestrationParentSessionId=p`
 * without a spawn kind have to read identically.
 */
const SPAWN_TYPE_REQUIRED_MESSAGE =
  "--type is required for a parented agent spawn. Use --type subagent when you will need, join, or review the result (including parallel work); use --type peer only for fire-and-forget work. Use --no-parent only for an independent top-level session.";
const SPAWN_PARENT_REQUIRED_MESSAGE =
  "--type requires a parent session. Remove --no-parent or omit --type for an independent top-level session.";

/**
 * The Droid autonomy and permission-mode enum messages, for the same reason:
 * `--droid-autonomy bogus` and `--arg droidPermissionMode=bogus` are the same
 * mistake, and so are `--permissions bogus` and `--arg permissionMode=bogus`.
 */
export const DROID_PERMISSION_MODE_ENUM_MESSAGE =
  "droidPermissionMode must be one of read-only, auto-low, auto-medium, auto-high, or agi.";
export const PERMISSION_MODE_ENUM_MESSAGE =
  "permissionMode must be one of default, auto, plan, edit, full-auto, or config-toml.";

/**
 * What a spawn-lineage read produced. The two arms are disjoint on purpose: a
 * launch either records lineage, or it named a plain shell terminal and the
 * ambient parent was thrown away. Making that a discriminated union means a
 * reader cannot quietly forward a `droppedAmbientParentSessionId` that a
 * lineage read never sets — the compiler names which fields exist.
 */
export type CliAgentSpawnLineage =
  | {
      kind: "lineage";
      orchestrationParentSessionId?: string;
      spawnKind?: CliAgentSpawnKind;
    }
  | {
      kind: "dropped";
      /**
       * The ambient parent id this read threw away because the launch named a
       * plain shell terminal, which records no lineage. `collectLaunchArgs`
       * needs the value (not a re-read of the environment) to tell a launch
       * that lost its lineage by accident from one that opted out with
       * `--no-parent`: the opt-out leaves this `undefined`, so
       * `--provider shell --no-parent --arg provider=codex` is an accepted,
       * deliberately parentless agent launch.
       */
      droppedAmbientParentSessionId?: string;
    };

type SpawnLineageReadOptions = {
  parentFlags?: readonly string[];
  missingParentMessage?: string;
  allowSpawnType?: boolean;
};

/**
 * The two ways this reader is called, as two signatures.
 *
 * A surface that can never launch a shell — `ade chat create`, `lanes
 * create-from-linear --start-chat` — passes no `allowSpawnType` (or a literal
 * `true`), so the "dropped" arm is unreachable for it and the caller reads
 * `orchestrationParentSessionId`/`spawnKind` straight off the result. Only a
 * surface that decides at runtime (`allowSpawnType: provider !== "shell"`)
 * gets the full union back and has to discriminate, which is exactly the set
 * of callers `spawnLineageLaunchArgs` exists for.
 */
export function readAgentSpawnLineage(
  args: string[],
  options?: SpawnLineageReadOptions & { allowSpawnType?: true },
): Extract<CliAgentSpawnLineage, { kind: "lineage" }>;
export function readAgentSpawnLineage(
  args: string[],
  options: SpawnLineageReadOptions & { allowSpawnType: boolean },
): CliAgentSpawnLineage;
export function readAgentSpawnLineage(
  args: string[],
  options: SpawnLineageReadOptions = {},
): CliAgentSpawnLineage {
  const parentFlags = options.parentFlags ?? DEFAULT_PARENT_FLAGS;
  const hasExplicitParentSessionId = findFlagName(args, parentFlags) !== null;
  const { parentSessionId: orchestrationParentSessionId, ambientParentSessionId } =
    readParentSessionId(args, parentFlags);
  const spawnTypeArg = readValue(args, SPAWN_TYPE_FLAGS);
  const normalizedSpawnKind = spawnTypeArg?.trim().toLowerCase();
  if (normalizedSpawnKind && normalizedSpawnKind !== "subagent" && normalizedSpawnKind !== "peer") {
    throw new CliUsageError(SPAWN_TYPE_ENUM_MESSAGE);
  }
  const spawnKind = normalizedSpawnKind as CliAgentSpawnKind | undefined;
  if (options.allowSpawnType === false && spawnKind) {
    throw new CliUsageError(SPAWN_TYPE_SHELL_MESSAGE);
  }
  if (options.allowSpawnType === false && hasExplicitParentSessionId) {
    throw new CliUsageError(SPAWN_PARENT_SHELL_MESSAGE);
  }
  if (options.allowSpawnType === false) {
    return { kind: "dropped", droppedAmbientParentSessionId: ambientParentSessionId };
  }
  if (orchestrationParentSessionId && !spawnKind) {
    throw new CliUsageError(SPAWN_TYPE_REQUIRED_MESSAGE);
  }
  if (!orchestrationParentSessionId && spawnKind) {
    throw new CliUsageError(
      options.missingParentMessage ?? SPAWN_PARENT_REQUIRED_MESSAGE,
    );
  }
  return { kind: "lineage", orchestrationParentSessionId, spawnKind };
}

/**
 * The one usage error every launch surface answers an unusable `provider` with:
 * an unknown spelling, or a value that is not even a string.
 */
function launchProfileUsageError(allowShell: boolean): CliUsageError {
  const allowed = LAUNCH_PROFILES.filter((profile) => allowShell || profile !== "shell");
  const list = allowed
    .map((profile, index) => (index === allowed.length - 1 ? `or ${profile}` : profile))
    .join(", ");
  return new CliUsageError(`provider must be one of ${list}.`);
}

/**
 * Narrow a raw `--provider`/`--profile` value to a launch profile, or throw the
 * one usage error every launch command shares. Trims and lower-cases first: the
 * brain compares provider literals, so a mis-cased or unknown spelling that
 * slipped through would become a silently mis-launched session instead of an
 * error. `allowShell: false` is for the chat surfaces, which have no shell
 * provider. Returns null when nothing (or only blank space) was passed —
 * "leave it to the runtime default" is not an error, so a caller that needs a
 * provider checks for null itself rather than getting a second overload. The
 * parameter is `unknown` because the arg bag can hand it any JSON value, and a
 * non-string is the same usage error as an unknown spelling.
 */
export function requireLaunchProfile(
  raw: unknown,
  opts: { allowShell: boolean },
): LaunchProfile | null {
  const { allowShell } = opts;
  if (raw == null) return null;
  if (typeof raw !== "string") throw launchProfileUsageError(allowShell);
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (!isLaunchProfile(value) || (!allowShell && value === "shell")) {
    throw launchProfileUsageError(allowShell);
  }
  return value;
}

/**
 * The options every merged-launch-arg rule needs, shared by the collector and
 * the rule block so the two cannot drift.
 */
export type LaunchArgRuleOptions = {
  /** Whether `shell` is a usable profile on this surface. */
  allowShell: boolean;
  /**
   * The ambient `$ADE_CHAT_SESSION_ID` the spawn-lineage reader threw away
   * because the launch named `shell` on the flag — `undefined` when nothing was
   * dropped, including when the caller opted out with `--no-parent`. Passed as
   * data rather than re-read from the environment here, so the rule below can
   * tell an accidental orphan from a deliberate one.
   */
  droppedAmbientParentSessionId?: string;
};

/**
 * Every rule a *merged* launch arg bag has to satisfy, in one block.
 *
 * `--arg provider=…` / `--input-json` write the same wire fields the
 * `--provider`, `--instance`, `--permission-mode`, `--droid-autonomy` and
 * spawn-lineage flags fill, and they win the merge — so this is the one place
 * every merged-value rule is enforced: the profile itself must be usable, an
 * `--instance` must belong to a profile that has accounts, a Droid autonomy
 * tier only rides on a Droid session, a permission mode must be one the merged
 * profile supports, and spawn lineage only rides on an agent provider (never a
 * plain shell terminal). Without it a chat, CLI session or terminal could be
 * launched under an unknown, mis-cased or non-string profile, or with an
 * `--instance` the profile cannot use: a `--provider cursor --arg instanceId=work`
 * is rejected exactly like `--provider cursor --instance work`, and
 * `--provider droid --droid-autonomy agi --arg provider=claude` is rejected
 * exactly like `--provider claude --droid-autonomy agi`.
 *
 * It takes a plain object, not an arg list, so the rules can be read — and
 * tested — without building a command line around them. Every value it sees has
 * already been shape- and enum-checked by `collectLaunchArgs`, so each rule
 * compares exact values: a key is either absent (unset) or a valid one.
 */
export function assertMergedLaunchArgs(
  merged: JsonObject,
  options: LaunchArgRuleOptions,
): void {
  const { allowShell, droppedAmbientParentSessionId } = options;
  // The profile the session actually launches under. A launch that names none
  // leaves the choice to the runtime's default, so there is nothing for the
  // pairing rules below to contradict.
  const provider = requireLaunchProfile(merged.provider, { allowShell });
  // The `--instance` rule, applied to the *merged* pair: the flags and the arg
  // bag fill the same two wire fields, so only the merged values are worth
  // checking.
  const instanceId = typeof merged.instanceId === "string" ? merged.instanceId : null;
  if (instanceId && provider && provider !== "claude" && provider !== "codex") {
    throw new CliUsageError(
      "--instance names a Claude or Codex account on this machine; other providers have a single identity per machine.",
    );
  }
  // Droid autonomy, on the merged pair for the same reason: `--arg provider=…`
  // wins the merge, so checking the flag's provider would let
  // `--provider droid --droid-autonomy agi --arg provider=claude` ship a Droid
  // tier on a Claude launch. Every flag site folds its own `--droid-autonomy`
  // into `base`, so the merged bag is the whole channel.
  if (merged.droidPermissionMode !== undefined && provider && provider !== "droid") {
    throw new CliUsageError("Droid autonomy is only supported for Droid sessions.");
  }
  // The permission mode the session actually launches under, for the same
  // reason: `--provider codex --permission-mode config-toml --arg provider=shell`
  // would otherwise reach the runtime as a shell terminal running a mode shells
  // have no answer for. The shared validator throws a plain Error, so it is
  // re-dressed as the usage error every other rule here answers with.
  if (provider && merged.permissionMode !== undefined) {
    try {
      validateLaunchProfilePermissionMode(
        provider,
        merged.permissionMode as AgentChatPermissionMode,
      );
    } catch (error) {
      throw asCliUsageError(error);
    }
  }
  // Spawn lineage, same merge: a plain shell terminal records none, and the
  // merged provider is the only one that knows whether this is a shell.
  if (provider === "shell") {
    if (merged.spawnKind !== undefined) throw new CliUsageError(SPAWN_TYPE_SHELL_MESSAGE);
    if (merged.orchestrationParentSessionId !== undefined) {
      throw new CliUsageError(SPAWN_PARENT_SHELL_MESSAGE);
    }
  }
  // The mirror image of the shell rule: the caller named `shell` on the flag,
  // so the lineage reader ran with `allowSpawnType: false` and *dropped* the
  // ambient parent — then `--arg provider=…` turned the launch back into an
  // agent session. Silently orphaning an agent spawn is worse than refusing it,
  // so say which flag would have kept the lineage. A caller who wrote
  // `--no-parent` dropped nothing, so nothing is refused.
  //
  // Answered BEFORE the pairing rules below, because a dropped ambient parent
  // is the more specific diagnosis of the same bag: `--provider shell --arg
  // provider=codex --arg spawnKind=subagent` has a spawn kind and no parent,
  // which the pairing rule would answer with "remove --no-parent" — advice for
  // a flag this caller never wrote. Naming the flag that actually lost the
  // lineage is what the caller can act on.
  if (
    droppedAmbientParentSessionId !== undefined
    && provider !== null
    && provider !== "shell"
    && merged.orchestrationParentSessionId === undefined
  ) {
    throw new CliUsageError(
      `Name the agent provider with --provider ${provider}, not --arg provider=${provider}: launching as shell drops this session's spawn lineage, so the agent session would be orphaned from its parent.`,
    );
  }
  // The parent/spawn-kind pairing the flag reader enforces, repeated here for
  // the merged bag: `--arg orchestrationParentSessionId=…` and
  // `--arg spawnKind=…` write the same two wire fields the `--parent`/`--type`
  // flags do and win the merge, so without this a bag could record a parented
  // spawn with no kind, or a kind with nothing to hang it on. Provider-
  // independent: the shell rule above has already refused both fields for a
  // shell launch, and every other profile records lineage in pairs.
  if (
    merged.orchestrationParentSessionId !== undefined
    && merged.spawnKind === undefined
  ) {
    throw new CliUsageError(SPAWN_TYPE_REQUIRED_MESSAGE);
  }
  if (
    merged.spawnKind !== undefined
    && merged.orchestrationParentSessionId === undefined
  ) {
    throw new CliUsageError(SPAWN_PARENT_REQUIRED_MESSAGE);
  }
}

/**
 * The launch-identity fields `collectLaunchArgs` normalises, in one place so
 * the "null or blank means unset" pre-pass and the per-field checks below
 * cannot drift apart.
 */
const LAUNCH_ARG_KEYS = [
  "provider",
  "instanceId",
  "droidPermissionMode",
  "spawnKind",
  "permissionMode",
  "orchestrationParentSessionId",
] as const;

/**
 * `collectGenericObjectArgs` for a launch builder: merge the generic arg bag
 * over the caller's `base`, then run `normalizeLaunchArgs` over the result.
 *
 * The one thing the merge itself has to answer is a blanked provider.
 * `--arg provider=` (or `provider: null`) means "unset", and unset falls back
 * to the caller's own resolved provider — which the merge has just overwritten,
 * so it is restored here before `normalizeLaunchArgs` sees the bag. Without
 * this, `ade new chat --provider codex --arg provider=` would launch under no
 * provider at all instead of under codex.
 */
export function collectLaunchArgs(
  args: string[],
  base: JsonObject,
  options: LaunchArgRuleOptions,
): JsonObject {
  const merged = collectGenericObjectArgs(args, base);
  // `base.provider !== undefined` is part of the condition, not a redundant
  // check: a caller whose base carries no provider at all must not gain an own
  // `provider: undefined` key here, because `normalizeLaunchArgs` reads
  // statically named fields and an own key spelled `undefined` is not the same
  // shape on the wire as an absent one.
  if (isBlankLaunchArgValue(merged.provider) && base.provider !== undefined) {
    merged.provider = base.provider;
  }
  return normalizeLaunchArgs(merged, options);
}

/** An explicit `null` or a blank string — a launch-identity field's "unset". */
function isBlankLaunchArgValue(value: unknown): boolean {
  return value === null || (typeof value === "string" && !value.trim());
}

/**
 * Normalise an already-merged launch arg bag, then hand it to
 * `assertMergedLaunchArgs`. Mutates and returns `bag`.
 *
 * Normalisation runs first and covers every field a rule reads, so the rules
 * never have to guess what a `null`, a blank string or a number meant. For
 * `provider`, `instanceId`, `droidPermissionMode`, `spawnKind`,
 * `permissionMode` and `orchestrationParentSessionId`, an explicit `null` or a
 * blank string means "unset": the key is dropped so the runtime keeps its own
 * default instead of re-interpreting a CLI-shaped "no". Everything that
 * survives is shape- and enum-checked here, so the arg bag is never a way past
 * an enum the equivalent flag reader enforces.
 *
 * Restoring a blanked provider is NOT this function's job. `--arg provider=`
 * (or `provider: null`) reaches here already resolved: `collectLaunchArgs` put
 * the caller's own provider back before calling, and the pre-pass below simply
 * drops whatever blank is left. A bag that arrives here with no provider
 * therefore leaves here with no provider — there is no fallback to fall back
 * to, because the only value that could serve as one is the bag's own.
 *
 * Exported separately because `lanes create-from-linear --start-chat` has no
 * arg list to collect — on that command `--arg`/`--input-json` fill the
 * lane-create payload, not the chat — but it builds the same bag out of its own
 * flags and must satisfy the same rules. Calling this directly says so, where
 * `collectLaunchArgs([], bag, …)` only said it with an empty array and a
 * paragraph of comment.
 */
export function normalizeLaunchArgs(
  merged: JsonObject,
  options: LaunchArgRuleOptions,
): JsonObject {
  const { allowShell } = options;

  // One pre-pass, before any rule reads the bag: an explicit `null` or a blank
  // string means "unset" for every launch-identity field, so the key is
  // dropped and the runtime keeps its own default. Doing it up front — rather
  // than as a side effect inside a per-field predicate — means each check
  // below is a plain `!== undefined` read of a statically named field.
  for (const key of LAUNCH_ARG_KEYS) {
    if (isBlankLaunchArgValue(merged[key])) delete merged[key];
  }

  // Canonicalise the spelling the bag supplied: the brain compares provider
  // literals, so `--arg provider=Claude` has to reach the wire as `claude`.
  // A provider the pre-pass dropped stays dropped — see the note above on why
  // there is no fallback to re-install here.
  if (merged.provider !== undefined) {
    merged.provider = requireLaunchProfile(merged.provider, { allowShell });
  }
  // A non-string account id is a typo the runtime would otherwise store
  // verbatim, and a padded one would have it hunting for an account named
  // "  work".
  if (merged.instanceId !== undefined) {
    if (typeof merged.instanceId !== "string") {
      throw new CliUsageError(
        "instanceId must be the id of a provider account on this machine.",
      );
    }
    merged.instanceId = merged.instanceId.trim();
  }
  if (merged.droidPermissionMode !== undefined) {
    if (
      typeof merged.droidPermissionMode !== "string"
      || !isAgentChatDroidPermissionMode(merged.droidPermissionMode)
    ) {
      throw new CliUsageError(DROID_PERMISSION_MODE_ENUM_MESSAGE);
    }
  }
  if (merged.spawnKind !== undefined) {
    if (merged.spawnKind !== "subagent" && merged.spawnKind !== "peer") {
      throw new CliUsageError(SPAWN_TYPE_ENUM_MESSAGE);
    }
  }
  if (merged.permissionMode !== undefined) {
    if (
      typeof merged.permissionMode !== "string"
      || !isTrackedCliPermissionMode(merged.permissionMode)
    ) {
      throw new CliUsageError(PERMISSION_MODE_ENUM_MESSAGE);
    }
  }
  if (merged.orchestrationParentSessionId !== undefined) {
    if (typeof merged.orchestrationParentSessionId !== "string") {
      throw new CliUsageError(
        "orchestrationParentSessionId must be the id of the parent chat session.",
      );
    }
    merged.orchestrationParentSessionId = merged.orchestrationParentSessionId.trim();
  }

  assertMergedLaunchArgs(merged, options);
  return merged;
}

/**
 * The spawn lineage a launch records, as the two things every launch surface
 * needs from it: the arg-bag fields to fold into `base`, and the rule options
 * to hand `collectLaunchArgs`.
 *
 * One accessor so the discriminated union is read in one place. Every call
 * site used to re-derive the same three lines — two `lineage.kind === "lineage"
 * ? … : undefined` reads and one `kind === "dropped"` spread — and a surface
 * that got the last one wrong would silently stop reporting a dropped ambient
 * parent, which is the orphaned-spawn bug the rule exists to catch.
 *
 * `null` means the surface read no lineage at all (nothing was launched), and
 * produces an empty base with the caller's own rule options.
 */
export function spawnLineageLaunchArgs(
  lineage: CliAgentSpawnLineage | null,
  launchOpts: { allowShell: boolean },
): { base: JsonObject; launchOptions: LaunchArgRuleOptions } {
  const base: JsonObject = {};
  if (lineage?.kind === "lineage") {
    if (lineage.orchestrationParentSessionId) {
      base.orchestrationParentSessionId = lineage.orchestrationParentSessionId;
    }
    if (lineage.spawnKind) base.spawnKind = lineage.spawnKind;
  }
  return {
    base,
    launchOptions: {
      ...launchOpts,
      ...(lineage?.kind === "dropped"
        ? { droppedAmbientParentSessionId: lineage.droppedAmbientParentSessionId }
        : {}),
    },
  };
}
