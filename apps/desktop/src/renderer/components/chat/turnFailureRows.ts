import type { AgentChatEvent } from "../../../shared/types";
import { isUsageLimitChatError } from "../../../shared/chatAutoResume";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";

type ErrorEvent = Extract<AgentChatEvent, { type: "error" }>;
type GroupedRow = ChatTranscriptGroupedEnvelope;

export type ProviderFailureRecovery = { kind: "capacity" | "rate_limit" };

export function classifyProviderFailure(event: ErrorEvent): ProviderFailureRecovery | null {
  const identity = `${
    typeof event.errorInfo === "string" ? event.errorInfo : event.errorInfo?.category ?? ""
  } ${event.message}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (identity.includes("serveroverloaded") || identity.includes("modelisatcapacity")) return { kind: "capacity" };
  // Delegated rather than spelled out again: the host computes
  // `usageLimitResume` off `isUsageLimitChatError`, so a turn the host treats
  // as limited is the turn the transcript treats as limited.
  if (isUsageLimitChatError(event)) return { kind: "rate_limit" };
  return null;
}

/**
 * What recovery an error's own row offers (a sign-in card, the capacity or
 * usage-limit help), or null for a plain failure.
 */
function recoveryKind(event: ErrorEvent): "auth" | ProviderFailureRecovery["kind"] | null {
  const info = typeof event.errorInfo === "object" ? event.errorInfo : null;
  if (info?.agentCli || info?.category === "auth" || info?.category === "agent_cli_auth") return "auth";
  return classifyProviderFailure(event)?.kind ?? null;
}

function failureSignature(event: ErrorEvent): string {
  const category = typeof event.errorInfo === "string" ? event.errorInfo : event.errorInfo?.category ?? "";
  return `${category}\u0000${event.message.trim()}`;
}

function rowTurnId(event: GroupedRow["event"]): string | null {
  const turnId = "turnId" in event && typeof event.turnId === "string" ? event.turnId.trim() : "";
  return turnId || null;
}

/** A notice the transcript draws as an error (the generic notice row's own rule). */
function isErrorNotice(event: GroupedRow["event"]): event is Extract<AgentChatEvent, { type: "system_notice" }> {
  if (event.type !== "system_notice") return false;
  if (event.severity) return event.severity === "error";
  return event.noticeKind === "error" || event.noticeKind === "thread_error";
}

// Rows a retry leaves between two failures without changing what happened.
function isRetryNoise(event: GroupedRow["event"]): boolean {
  return event.type === "status" || event.type === "context_usage";
}

type RowPatch = Pick<GroupedRow, "repeatCount" | "endedAtUsageLimit" | "failureShown" | "failureNotes">;

/**
 * One patched copy per source row and patch, so an unchanged transcript keeps
 * the same row objects across passes (rows are memoized on identity).
 */
const patchedRows = new WeakMap<GroupedRow, { signature: string; row: GroupedRow }>();

function patchRow(row: GroupedRow, patch: RowPatch): GroupedRow {
  const signature = JSON.stringify([patch.repeatCount, patch.endedAtUsageLimit, patch.failureShown, patch.failureNotes]);
  const cached = patchedRows.get(row);
  if (cached?.signature === signature) return cached.row;
  const next: GroupedRow = { ...row };
  if (patch.repeatCount !== undefined) next.repeatCount = patch.repeatCount;
  if (patch.endedAtUsageLimit !== undefined) next.endedAtUsageLimit = patch.endedAtUsageLimit;
  if (patch.failureShown !== undefined) next.failureShown = patch.failureShown;
  if (patch.failureNotes !== undefined) next.failureNotes = patch.failureNotes;
  patchedRows.set(row, { signature, row: next });
  return next;
}

/**
 * How failed turns read in the transcript: one state per turn, in time order.
 *
 * - One failure line per turn. A second `error` of the same turn (a provider
 *   that reports the failure and then the turn's end, the launch hand-off and
 *   the brain both ending it) draws no row of its own: its words go under the
 *   first line's Details. One whose recovery differs (a sign-in, capacity or
 *   usage limit the first line doesn't offer) keeps its row, so its card shows. An error-tone notice of that turn that says the same
 *   thing (the storage guard's notice next to its refusal) is dropped too.
 * - The turn-end line of a failed turn whose failure is already drawn says no
 *   second "FAILED": it reads like any other turn end (`failureShown`).
 * - A turn that ended at a usage limit draws no row of its own: its turn-end
 *   line says "Usage limit" (`endedAtUsageLimit`), and the pill above the
 *   composer owns what happens next.
 * - A retry that resends the prompt and fails the same way again folds into
 *   the failure before it: the earlier prompt, error and turn-end line drop
 *   out, and the newest failure carries `repeatCount`. So does the same
 *   failure again with no new prompt between (an older host that refused a
 *   send without recording it). Retrying into an exhausted limit otherwise
 *   stacks one identical prompt and failure per press.
 */
export function foldTurnFailureRows(rows: GroupedRow[]): GroupedRow[] {
  if (!rows.some((row) => row.event.type === "error")) return rows;

  // Each turn's error messages, so a notice of that turn that repeats one can
  // drop out whichever came first.
  const errorMessagesByTurn = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.event.type !== "error") continue;
    const turnId = rowTurnId(row.event);
    if (!turnId) continue;
    const messages = errorMessagesByTurn.get(turnId) ?? new Set<string>();
    messages.add(row.event.message.trim());
    errorMessagesByTurn.set(turnId, messages);
  }

  const dropped = new Set<GroupedRow>();
  const patches = new Map<GroupedRow, RowPatch>();
  const patchOf = (row: GroupedRow): RowPatch => {
    const existing = patches.get(row);
    if (existing) return existing;
    const created: RowPatch = {};
    patches.set(row, created);
    return created;
  };
  // The first failure line drawn for each turn.
  const lineByTurn = new Map<string, GroupedRow>();
  let lastPrompt: { text: string; row: GroupedRow } | null = null;
  let open: {
    signature: string;
    turnId: string | null;
    prompt: { text: string; row: GroupedRow } | null;
    usageLimit: boolean;
    count: number;
    error: GroupedRow;
    done: GroupedRow | null;
    replay: GroupedRow | null;
  } | null = null;

  for (const row of rows) {
    const event = row.event;
    if (event.type === "error") {
      const turnId = rowTurnId(event);
      const line = turnId ? lineByTurn.get(turnId) : undefined;
      const laterRecovery = line ? recoveryKind(event) : null;
      if (line && (laterRecovery == null || laterRecovery === recoveryKind(line.event as ErrorEvent))) {
        // The same turn again: one line, the rest of its words under Details.
        dropped.add(row);
        const message = event.message.trim();
        const lineEvent = line.event as ErrorEvent;
        if (message && message !== lineEvent.message.trim()) {
          const patch = patchOf(line);
          if (!patch.failureNotes?.includes(message)) patch.failureNotes = [...(patch.failureNotes ?? []), message];
        }
        continue;
      }
      const signature = failureSignature(event);
      const usageLimit = classifyProviderFailure(event)?.kind === "rate_limit";
      let count = 1;
      // The newest attempt's prompt stays, so the prompt and the turn-end
      // line left on screen belong to the same turn. `open` is still set only
      // when nothing but bookkeeping (or a resend of its prompt) came since.
      if (open && open.signature === signature) {
        if (open.replay && open.prompt) dropped.add(open.prompt.row);
        dropped.add(open.error);
        if (open.done) dropped.add(open.done);
        count = open.count + 1;
      }
      if (usageLimit) dropped.add(row);
      else if (count > 1) patchOf(row).repeatCount = count;
      if (turnId && !usageLimit) lineByTurn.set(turnId, row);
      open = { signature, turnId, prompt: lastPrompt, usageLimit, count, error: row, done: null, replay: null };
      continue;
    }
    if (isErrorNotice(event)) {
      // Said once already by its turn's failure line.
      const turnId = rowTurnId(event);
      const sameTurnErrors = turnId ? errorMessagesByTurn.get(turnId) : undefined;
      const repeats = sameTurnErrors?.has(event.message.trim())
        || (Boolean(sameTurnErrors) && typeof event.detail === "object" && event.detail?.kind === "disk_pressure");
      if (repeats) {
        dropped.add(row);
        continue;
      }
    }
    if (event.type === "user_message") {
      const text = event.text.trim();
      if (open && !open.replay && open.prompt?.text === text) {
        open.replay = row;
        lastPrompt = { text, row };
        continue;
      }
      lastPrompt = { text, row };
      open = null;
      continue;
    }
    if (event.type === "done" && open && !open.done && (!open.turnId || !event.turnId || open.turnId === event.turnId)) {
      open.done = row;
      if (open.usageLimit) {
        patchOf(row).endedAtUsageLimit = true;
      } else if (event.status !== "completed") {
        // Its failure line already says what went wrong.
        patchOf(row).failureShown = true;
      }
      if (open.count > 1) patchOf(row).repeatCount = open.count;
      continue;
    }
    // Another turn's end: the failure before it can no longer fold with a later one.
    if (event.type === "done" && open?.turnId && rowTurnId(event) && rowTurnId(event) !== open.turnId) {
      open = null;
      continue;
    }
    // Anything but bookkeeping ends the run a repeat can fold into.
    if (open && !isRetryNoise(event) && event.type !== "done" && !isErrorNotice(event)) open = null;
  }

  const folded: GroupedRow[] = [];
  for (const row of rows) {
    if (dropped.has(row)) continue;
    const patch = patches.get(row);
    folded.push(patch ? patchRow(row, patch) : row);
  }
  return folded;
}
