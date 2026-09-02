/**
 * Catch an ACP agent that approved its own work.
 *
 * ADE renders approval cards for ACP providers. An agent that never sends
 * `session/request_permission` makes those cards decorative: the user believes
 * they are gating writes, and nothing is gated. Grok 1.0.13 does exactly that
 * when it inherits the user's Claude `permissions.defaultMode`, and the fix for
 * that leans on an undocumented environment variable that can disappear in any
 * release. Copilot 1.0.82 does it unconditionally.
 *
 * So the host watches, provider-agnostically:
 *
 *   a turn ran in an ask-style permission mode
 *   AND it produced `edit` or `execute` tool calls
 *   AND zero `session/request_permission` arrived
 *   => the session is unsupervised, and ADE says so.
 *
 * The notice fires once per session and is dismissible. It is a `system_notice`
 * because it is a fact about the session, not a failure of the turn — the work
 * really did happen and the transcript is real.
 *
 * ## Read tools are not evidence
 *
 * Read, search, and fetch never prompt on any of these agents. Only `edit` and
 * `execute` are the kinds an ask-style mode is supposed to gate, so only those
 * arm the invariant. Counting reads would fire on every well-behaved session.
 *
 * ## The notice reports the OBSERVATION, never the cause
 *
 * Silence has more than one explanation, and ADE cannot tell them apart from
 * the wire. Grok evaluates per-project remembered approvals
 * (`CachedStateStore` / `remember_tool_approvals`) before it ever consults the
 * prompt policy, so a user who once chose "always allow" for this project —
 * possibly in Grok's own TUI, in a Work terminal, outside ADE entirely — gets
 * edits with zero `session/request_permission` in a session nobody broke.
 *
 * What is true in EVERY case is the observation: no approval request arrived,
 * so ADE's approval cards could not gate the change. So that is what the
 * message says. Writing "Grok approved its own file changes" would be a guess
 * about who decided, and it would be wrong for the remembered-grant user — and
 * a banner that is wrong often enough is a banner people learn to ignore,
 * which costs more than the warning is worth. The `detail` body names both
 * plausible causes so the user can act on it.
 *
 * ## Preflight failures land here too
 *
 * A provider whose pre-session gate could not confirm supervision seeds the
 * guard with `preflightUnverified`. That notice fires on the first turn rather
 * than at open, because the host's event callback is not live until the caller
 * owns the runtime. It shares the once-per-session latch with the observed
 * case: a user gets one honest line, not two.
 */

import type { AgentChatEvent } from "../../../../shared/types";
import type { AcpToolKind } from "./acpProtocolTypes";

/**
 * Whether a permission mode promises the user a prompt.
 *
 * `plan` and `default` do. `auto-edit` deliberately stops prompting for edits,
 * and `auto` / `yolo` stop prompting entirely, so silence there is the posture
 * working rather than a supervision hole.
 */
export type AcpSupervisionMode = "ask" | "auto";

const ASK_STYLE_PERMISSION_MODES: ReadonlySet<string> = new Set(["plan", "default"]);

export function acpSupervisionModeFor(permissionMode: string | null | undefined): AcpSupervisionMode {
  // An unknown or absent mode is treated as ask-style. ADE's own default is
  // `default`, and a mode ADE cannot read is not a licence to assume the user
  // opted out of approvals.
  if (permissionMode == null || !permissionMode.length) return "ask";
  return ASK_STYLE_PERMISSION_MODES.has(permissionMode) ? "ask" : "auto";
}

/** Tool kinds an ask-style mode is supposed to gate. */
const GATED_TOOL_KINDS: ReadonlySet<AcpToolKind> = new Set<AcpToolKind>([
  "edit",
  "delete",
  "move",
  "execute",
]);

export type AcpSupervisionGuard = {
  /** True once ADE has concluded this session is not gated. */
  readonly unsupervised: boolean;
  /** Record a tool call the agent reported. Kind may be absent on the wire. */
  noteToolCall(kind: AcpToolKind | null | undefined): void;
  /** Record that the agent asked ADE for permission. Disarms the invariant. */
  notePermissionRequest(): void;
  /**
   * Close a turn and return the notices to publish. Empty in the ordinary case.
   * At most one notice is ever produced across the life of the guard.
   */
  endTurn(turnId: string | null): AgentChatEvent[];
  /** Notices queued before a turn ran (preflight). Drains to at most one. */
  drainQueued(turnId: string | null): AgentChatEvent[];
};

export type CreateAcpSupervisionGuardArgs = {
  /** Provider display name. Appears in the notice copy. */
  providerLabel: string;
  /** Abstract ACP permission mode the session opened with. */
  permissionMode: string | null | undefined;
  /**
   * True when a provider-specific gate ran and could NOT confirm that the
   * agent will ask before it writes. Absent means "no gate applies".
   */
  preflightUnverified?: boolean;
  /** Already fired in an earlier run of this chat. Suppresses a repeat. */
  alreadyNotified?: boolean;
};

/** Copy for the case ADE observed: work happened, nothing asked. */
export function acpUnsupervisedNoticeMessage(providerLabel: string, sawExecute: boolean, sawEdit: boolean): string {
  const what = sawEdit && sawExecute
    ? "changed files and ran commands"
    : sawExecute
      ? "ran commands"
      : "changed files";
  return `${providerLabel} ${what} here without asking ADE to approve. ADE's approval cards can't gate this chat.`;
}

/**
 * The two explanations ADE cannot tell apart, so it names both rather than
 * picking one. Rendered as the collapsible body under the one-line message.
 */
export function acpUnsupervisedNoticeDetail(providerLabel: string): string {
  return [
    `ADE received no approval request for this turn, so its approval cards had nothing to gate.`,
    ``,
    `Two things cause that, and ADE cannot tell them apart from here:`,
    `• ${providerLabel} is approving the work itself.`,
    `• You already granted an "always allow" for this project. ${providerLabel} remembers those outside ADE, including grants made in its own terminal UI.`,
    ``,
    `Run \`${providerLabel.toLowerCase()} inspect\` in this folder to see which permissions it loaded.`,
  ].join("\n");
}

/** Copy for the case ADE could not verify in advance. Never claims it happened. */
export function acpUnverifiedNoticeMessage(providerLabel: string): string {
  return `ADE could not confirm that ${providerLabel} will ask before it edits files here. It may approve its own changes.`;
}

function notice(message: string, detail: string | null, turnId: string | null): AgentChatEvent {
  return {
    type: "system_notice",
    noticeKind: "warning",
    severity: "warning",
    message,
    ...(detail ? { detail } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

export function createAcpSupervisionGuard(args: CreateAcpSupervisionGuardArgs): AcpSupervisionGuard {
  const mode = acpSupervisionModeFor(args.permissionMode);
  let notified = args.alreadyNotified === true;
  let unsupervised = false;
  let preflightPending = args.preflightUnverified === true;
  // Tool kinds are per turn: the notice describes the turn that tripped it.
  let sawEdit = false;
  let sawExecute = false;
  // Permission requests are sticky for the session. An agent that asked once
  // has proved it asks, and a user who answered `allow-edits-session` bought
  // the silence in every later turn. Resetting this per turn would blame the
  // agent for a decision the user made.
  let sawPermissionRequest = false;

  const fire = (message: string, detail: string | null, turnId: string | null): AgentChatEvent[] => {
    if (notified) return [];
    notified = true;
    unsupervised = true;
    return [notice(message, detail, turnId)];
  };

  const drainQueued = (turnId: string | null): AgentChatEvent[] => {
    if (!preflightPending) return [];
    preflightPending = false;
    return fire(
      acpUnverifiedNoticeMessage(args.providerLabel),
      acpUnsupervisedNoticeDetail(args.providerLabel),
      turnId,
    );
  };

  return {
    get unsupervised() {
      return unsupervised;
    },
    noteToolCall: (kind) => {
      if (!kind) return;
      if (!GATED_TOOL_KINDS.has(kind)) return;
      if (kind === "execute") sawExecute = true;
      else sawEdit = true;
    },
    notePermissionRequest: () => {
      sawPermissionRequest = true;
    },
    drainQueued,
    endTurn: (turnId) => {
      const turnEdit = sawEdit;
      const turnExecute = sawExecute;
      sawEdit = false;
      sawExecute = false;
      const queued = drainQueued(turnId);
      if (queued.length) return queued;
      if (mode !== "ask") return [];
      if (sawPermissionRequest) return [];
      if (!turnEdit && !turnExecute) return [];
      return fire(
        acpUnsupervisedNoticeMessage(args.providerLabel, turnExecute, turnEdit),
        acpUnsupervisedNoticeDetail(args.providerLabel),
        turnId,
      );
    },
  };
}
