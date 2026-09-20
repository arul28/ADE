/**
 * Which approvals a spoken "yes" may never release.
 *
 * Its own module because it is a gate, not a type: two tables of names and
 * patterns and the predicates that read them. The call service and the runtime
 * both consult it, and nothing in it needs the prompt, the tool list or the
 * call state.
 */

/**
 * Tool names whose blast radius is other people's work. These always require a
 * tap, never a spoken yes, because a misheard word must not be able to destroy
 * history or publish something.
 */
export const CTO_VOICE_DESTRUCTIVE_TOOLS = [
  "gitPush",
  "gitForcePush",
  "gitUndoLastHeadChange",
  "gitCheckoutBranch",
  "gitStashPop",
  "deleteLane",
  "archiveLane",
  "mergePr",
  "publishRelease",
  "gitResetHard",
  "discardChanges",
] as const;

export function isDestructiveVoiceTool(toolName: string): boolean {
  return (CTO_VOICE_DESTRUCTIVE_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Shell commands whose blast radius is other people's work.
 *
 * The list above names ADE's OWN operations, and a real approval never mentions
 * one: a Claude bash approval arrives as `kind: "command"` with a sentence like
 * "Run command: git push --force origin main". These patterns are the half of
 * the gate that can read that.
 *
 * Deliberately conservative and deliberately over-broad: a false positive costs
 * the user one tap, a false negative costs them history. Anchored on a word
 * boundary so `git pushd` and a path containing "rm -rf" in prose do not match
 * by accident, and applied to the command text only.
 */
const CTO_VOICE_DESTRUCTIVE_COMMAND_PATTERNS: readonly RegExp[] = [
  // ANY push, not just a forced one. `gitPush` is on the tool list above, so a
  // spoken "yes" can never publish through ADE's own operation — and a plain
  // `git push origin main` publishes exactly the same commits to exactly the
  // same branch. The force variants stay below because they are what the
  // pattern is named for, and a narrowing edit to this line must not silently
  // take them with it.
  /\bgit\s+push\b/i,
  /\bgit\s+push\b[^\n]*\s(?:--force|-f)\b/i,
  /\bgit\s+push\b[^\n]*--force-with-lease\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+clean\b[^\n]*-[a-z]*[fd]/i,
  /\bgit\s+checkout\s+--\s/i,
  /\bgit\s+restore\b/i,
  /\bgit\s+stash\s+(?:drop|clear|pop)\b/i,
  /\brm\s+-[a-z]*[rf]/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bgh\s+release\s+(?:create|delete)\b/i,
  /\bgh\s+repo\s+delete\b/i,
  /\bnpm\s+publish\b/i,
];

/**
 * ADE action `domain.action` pairs an agent can reach through
 * `mcp__ade__run_ade_action`, whose effect is the same as the commands above.
 * The tool name alone says nothing here — the payload is where the verb is.
 */
const CTO_VOICE_DESTRUCTIVE_ACTION_VERBS =
  "delete|deleteTemplate|archive|archiveAndReclaim|merge|mergePr|forcePush|gitForcePush"
  + "|resetHard|discardChanges|clearLocalData|undoLastHeadChange|stashPop|checkoutBranch|publishRelease";

/** `lane.delete`, as written in prose or in an `ade actions run` invocation. */
const CTO_VOICE_DESTRUCTIVE_ACTION_PATTERN = new RegExp(
  `\\b(?:lane|pr|git|session|ade_project|project_secret|automations)\\.(?:${CTO_VOICE_DESTRUCTIVE_ACTION_VERBS})\\b`,
  "i",
);

/**
 * The same call as a tool payload: `{"domain":"lane","action":"delete"}`.
 *
 * Read off the `action` field alone, because the verb is what decides and the
 * domain is only there to keep the prose form honest. A payload is the shape an
 * agent's `mcp__ade__run_ade_action` carries, and it never reads as prose.
 */
const CTO_VOICE_DESTRUCTIVE_ACTION_PAYLOAD = new RegExp(
  `"action"\\s*:\\s*"(?:${CTO_VOICE_DESTRUCTIVE_ACTION_VERBS})"`,
  "i",
);

/**
 * Does this command text do something a spoken "yes" must not be able to do?
 *
 * Exported for the gate's own tests; callers should prefer
 * `describeVoiceApproval`, which decides from a whole approval event.
 */
export function isDestructiveVoiceCommand(text: string | null | undefined): boolean {
  const command = typeof text === "string" ? text : "";
  if (!command.trim().length) return false;
  if (CTO_VOICE_DESTRUCTIVE_ACTION_PATTERN.test(command)) return true;
  if (CTO_VOICE_DESTRUCTIVE_ACTION_PAYLOAD.test(command)) return true;
  return CTO_VOICE_DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * The approval shape every provider ends up emitting, as far as this gate cares.
 *
 * `detail` is always an OBJECT, never a string: `{ tool }` for Claude,
 * `{ command, cwd, reason }` for Codex, `{ droidSdk, request, hook }` for Droid,
 * `{ cursorSdk, request, hook, policy }` for Cursor, `{ acp, provider }` for the
 * ACP dialects.
 */
export type CtoVoiceApprovalEvent = {
  kind: string;
  description: string;
  detail?: unknown;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The tool an approval is about, and whether a voice may answer it.
 *
 * Two independent sources, because no provider carries both: the NAME comes out
 * of the structured detail (`detail.tool`, `detail.hook.toolName`,
 * `detail.request.tool`), and the VERDICT comes from the command text when the
 * approval is a command — which is the only place a force-push is visible at
 * all. Falls back to `kind` for the name, which is what the card shows when a
 * provider tells us nothing better.
 */
export function describeVoiceApproval(event: CtoVoiceApprovalEvent): {
  toolName: string;
  destructive: boolean;
} {
  const detail = readRecord(event.detail);
  const hook = readRecord(detail?.hook);
  const request = readRecord(detail?.request);
  const providerMeta = readRecord(request?.providerMetadata);
  const toolName = readString(detail?.tool)
    ?? readString(hook?.toolName)
    ?? readString(request?.tool)
    ?? readString(providerMeta?.tool)
    ?? event.kind;

  // Every place a provider puts the command, because each puts it somewhere
  // else. Claude has it only in the description ("Run command: …"); Codex has
  // it on `detail.command` and in provider metadata, and its description is
  // the model's `reason` whenever there is one — so reading the description
  // alone misses every Codex approval that explained itself.
  const commandText = [
    event.description,
    readString(detail?.command),
    readString(providerMeta?.command),
    readString(readRecord(detail?.input)?.command),
    readString(readRecord(hook?.toolInput)?.command),
    readString(readRecord(providerMeta?.input)?.command),
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");

  return {
    toolName,
    // Four ways in, any of which is enough: an ADE operation named outright, a
    // command whose shape is destructive, a tool we already refuse by name, or
    // an approval we cannot read at all.
    //
    // That last one is ACP (Qwen, Kimi, Copilot). Its card carries
    // `detail: { acp: true, provider }` and a description that is the tool's
    // TITLE — never the command — and its provider metadata holds only ids and
    // option kinds. There is nothing to judge by, and an ACP host only asks at
    // all when it needs permission to change something. An unreadable mutation
    // is exactly what this gate exists for, so it needs a tap: the cost is one
    // extra tap on those three providers, and the alternative is a misheard
    // "yes" approving something nobody could see.
    destructive: detail?.acp === true
      || isDestructiveVoiceTool(toolName)
      || isDestructiveVoiceCommand(commandText),
  };
}
