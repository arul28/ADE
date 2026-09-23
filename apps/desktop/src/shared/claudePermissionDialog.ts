import { ownQuestionValue } from "./pendingInputAnswers";
import type { AgentChatApprovalDecision, PendingInputOption, PendingInputQuestion } from "./types/chat";

/** The approval values that answer the decision question. */
const CLAUDE_APPROVAL_ALLOW_VALUE = "allow";
const CLAUDE_APPROVAL_DENY_VALUE = "deny";
/** The approval value that persists a session-wide allow. */
const CLAUDE_APPROVAL_ALLOW_SESSION_VALUE = "allow_session";

/**
 * Whether an approval's option list offers the session-wide choice.
 *
 * The one place that decides whether the session-wide option is offered, so the
 * builder that omits the option and the cards that render the controls cannot
 * disagree about which value means "persist this for the session".
 */
export function claudeApprovalOptionsOfferSession(
  options: readonly PendingInputOption[] | null | undefined,
): boolean {
  return (options ?? []).some((option) => option.value === CLAUDE_APPROVAL_ALLOW_SESSION_VALUE);
}

/**
 * The SDK ask flags that ride on canUseTool's options, read once.
 *
 * `defaultToNo` is an elevated-risk ask (`default_to_no`): do not pre-select
 * Allow. `suppressAlwaysAllowRule` says accepting this ask would write a
 * session-wide allow rule broader than the ask's own action, so the SDK forbids
 * the persistent choice. Either one removes the session-wide option; both can
 * be set at once.
 */
export type ClaudeToolApprovalFlags = {
  defaultToNo: boolean;
  suppressAlwaysAllowRule: boolean;
};

/**
 * The one reader of both SDK ask flags, so no call site parses them twice and
 * the two approvals that consume them cannot disagree.
 *
 * The snake_case spellings are read too, defensively: they are the spellings
 * the SDK uses on ask results, and a runtime shape that puts either on the
 * options object must not slip past the gate. The field reads are static so a
 * typo cannot silently disable the security-relevant suppression.
 */
export function claudeToolApprovalFlags(sdkOptions: unknown): ClaudeToolApprovalFlags {
  if (!sdkOptions || typeof sdkOptions !== "object" || Array.isArray(sdkOptions)) {
    return { defaultToNo: false, suppressAlwaysAllowRule: false };
  }
  const record = sdkOptions as Record<string, unknown>;
  return {
    defaultToNo: record.defaultToNo === true || record.default_to_no === true,
    suppressAlwaysAllowRule:
      record.suppressAlwaysAllowRule === true || record.suppress_always_allow_rule === true,
  };
}

export function buildClaudeToolApprovalOptions(args: ClaudeToolApprovalFlags): PendingInputOption[] {
  if (args.defaultToNo || args.suppressAlwaysAllowRule) {
    return [
      { label: "Allow", value: CLAUDE_APPROVAL_ALLOW_VALUE },
      { label: "Deny", value: CLAUDE_APPROVAL_DENY_VALUE },
    ];
  }
  return [
    { label: "Allow", value: CLAUDE_APPROVAL_ALLOW_VALUE, recommended: true },
    { label: "Allow for Session", value: CLAUDE_APPROVAL_ALLOW_SESSION_VALUE },
    { label: "Deny", value: CLAUDE_APPROVAL_DENY_VALUE },
  ];
}

/**
 * The decision one of the approval's own option values stands for, or null for
 * a value this module does not mint.
 *
 * The single interpreter of the option vocabulary, so the builder, the
 * session-choice check, and the answer mapping cannot drift apart.
 */
function claudeApprovalDecisionForOptionValue(value: string): AgentChatApprovalDecision | null {
  if (value === CLAUDE_APPROVAL_DENY_VALUE) return "decline";
  if (value === CLAUDE_APPROVAL_ALLOW_SESSION_VALUE) return "accept_for_session";
  if (value === CLAUDE_APPROVAL_ALLOW_VALUE) return "accept";
  return null;
}

/**
 * The decision an option-chip answer implies for a Claude approval.
 *
 * Question-card clients render the approval's options as chips and answer with
 * `accept` plus the chosen option value in `answers` (iOS does; the desktop
 * renderer sends the decision itself). The host reads `decision`, so without
 * this a chip labeled "Deny" would allow the tool. Membership is exact against
 * the request's own option values — an answer that names no option, or names a
 * future one, keeps the client's decision.
 *
 * Only tool approvals reach this: `runtime.approvals` also holds
 * `AskUserQuestion` (kind `question`, model-authored option values) and the
 * plan approval (kind `plan_approval`, vocabulary `approve`/`reject`), so the
 * caller guards on the request kind.
 */
export function claudeApprovalDecisionFromOptionAnswers(
  questions: readonly PendingInputQuestion[] | null | undefined,
  answers: Readonly<Record<string, string | string[]>> | null | undefined,
): AgentChatApprovalDecision | null {
  if (!questions?.length || !answers) return null;
  for (const question of questions) {
    const raw = ownQuestionValue(answers, question.id);
    const selected = Array.isArray(raw) ? raw[0] : raw;
    if (typeof selected !== "string") continue;
    const option = (question.options ?? []).find((candidate) => candidate.value === selected);
    if (!option) continue;
    const decision = claudeApprovalDecisionForOptionValue(option.value);
    if (decision) return decision;
  }
  return null;
}
