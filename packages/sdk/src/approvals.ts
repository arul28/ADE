import { isSupportedProvider } from "./permissions.js";
import {
  PENDING_INPUT_KINDS,
  type AdeProvider,
  type PendingInputKind,
  type PendingInputRequest,
} from "./types.js";

/**
 * The approval half of the pending-input surface.
 *
 * A provider that wants a decision emits `approval_request` and then BLOCKS.
 * There is no timeout in the runtime, so the turn stays parked until something
 * answers it. `thread.approve()` is the answer; `thread.interrupt()` is the
 * abort. A host that renders neither has a chat that looks frozen.
 */

/** What a host can say about a pending approval. */
export type ApprovalDecision = "accept" | "accept_always" | "reject";

/** Engine spelling of the same three answers. */
export type EngineApprovalDecision = "accept" | "accept_for_session" | "decline" | "cancel";

/**
 * The SDK's three decisions in the engine's vocabulary.
 *
 * `accept_always` is the one that makes approvals bearable over a long session:
 * it settles this request AND every later request the provider considers the
 * same, for the life of the session.
 */
const ENGINE_DECISIONS: Record<ApprovalDecision, EngineApprovalDecision> = {
  accept: "accept",
  accept_always: "accept_for_session",
  reject: "decline",
};

export function engineApprovalDecision(decision: ApprovalDecision): EngineApprovalDecision | null {
  return ENGINE_DECISIONS[decision] ?? null;
}

export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  "accept",
  "accept_always",
  "reject",
];

/** One request a host has to answer before its turn can continue. */
export type ApprovalRequest = {
  /** The id to pass to `approve()`. */
  itemId: string;
  /** Groups retries of one logical action, when the provider reports one. */
  logicalItemId?: string;
  /** The shape of the thing being confirmed. */
  kind: "command" | "file_change" | "tool_call";
  /**
   * The finer-grained kind.
   *
   * `"approval"` and `"permissions"` are answerable with `approve()`. The other
   * kinds — `"question"`, `"structured_question"`, `"plan_approval"`,
   * `"model_selection"` — want prose or a choice that this surface cannot
   * carry, so render them read-only rather than offering Allow and Reject for
   * something that wants a sentence.
   */
  requestKind?: PendingInputKind;
  /** Human-readable and provider-supplied. Safe to render. */
  description: string;
  turnId?: string;
  /** Provider payload: the command string, the patch, the tool input. */
  detail?: unknown;
  /** Which provider raised it. */
  provider: AdeProvider;
};

/**
 * True for the two kinds `approve()` can actually settle.
 *
 * The canonical partition of `PendingInputKind`. `@ade-dev/chat-ui` states the
 * complement of this set in `transcript/ApprovalCard.tsx` because it takes this
 * package only as an OPTIONAL peer and cannot import the function; that copy
 * points back here.
 */
export function isApprovalShaped(kind: PendingInputKind | undefined): boolean {
  return kind === "approval" || kind === "permissions";
}

const PENDING_INPUT_KIND_SET: ReadonlySet<string> = new Set<string>(PENDING_INPUT_KINDS);

/**
 * A `requestKind` off the wire, or `undefined` when it is not one this SDK
 * knows.
 *
 * `AgentChatEvent` is open, so the field is any string. Casting it into the
 * closed union put a value nothing can branch on into a field that drives a
 * card's answerable/read-only decision; `undefined` is the honest answer.
 */
export function readPendingInputKind(value: unknown): PendingInputKind | undefined {
  return typeof value === "string" && PENDING_INPUT_KIND_SET.has(value)
    ? (value as PendingInputKind)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readKind(value: unknown): ApprovalRequest["kind"] | undefined {
  return value === "command" || value === "file_change" || value === "tool_call"
    ? value
    : undefined;
}

/**
 * The `kind` for a pending request the engine described only by `PendingInputKind`.
 *
 * `PendingInputRequest` carries no command/file/tool discriminant of its own,
 * so this reads the provider payload for one and falls back to `"tool_call"`.
 * When the SDK also saw the `approval_request` event for the same item, that
 * event's own `kind` wins — it is the engine's answer rather than this guess.
 */
function inferKind(request: PendingInputRequest): ApprovalRequest["kind"] {
  const metadata = request.providerMetadata ?? {};
  const explicit = readKind(metadata.kind);
  if (explicit) return explicit;
  if (metadata.command !== undefined) return "command";
  if (
    metadata.changes !== undefined ||
    metadata.path !== undefined ||
    metadata.filePath !== undefined
  ) {
    return "file_change";
  }
  return "tool_call";
}

/**
 * What the SDK remembers from an `approval_request` event, so a request read
 * back from the runtime keeps the engine's own discriminants instead of the
 * inference above.
 */
export type ObservedApproval = {
  itemId: string;
  logicalItemId?: string;
  kind: ApprovalRequest["kind"];
  description: string;
  turnId?: string;
  detail?: unknown;
  requestKind?: PendingInputKind;
};

/** Reads an `approval_request` event payload, or null when it is not one. */
export function observedApprovalFromEvent(event: {
  type: string;
  [key: string]: unknown;
}): ObservedApproval | null {
  if (event.type !== "approval_request") return null;
  const itemId = readString(event.itemId);
  if (!itemId) return null;
  const requestKind = readPendingInputKind(event.requestKind);
  return {
    itemId,
    ...(readString(event.logicalItemId) ? { logicalItemId: readString(event.logicalItemId)! } : {}),
    kind: readKind(event.kind) ?? "tool_call",
    description: typeof event.description === "string" ? event.description : "",
    ...(readString(event.turnId) ? { turnId: readString(event.turnId)! } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
    ...(requestKind ? { requestKind } : {}),
  };
}

/**
 * Maps a runtime pending request onto the SDK shape.
 *
 * `threadProvider` fills in for a request whose `source` is not one of the six
 * chat providers — `"acp"` covers four dialects at once and `"ade"` is a
 * request ADE staged itself, and neither is a value `AdeProvider` can carry.
 * The thread's own provider is the honest answer there, because it is the
 * provider that is actually blocked.
 */
export function approvalFromPendingInput(
  request: PendingInputRequest,
  threadProvider: AdeProvider,
  observed?: ObservedApproval,
): ApprovalRequest {
  const itemId = request.itemId ?? request.requestId;
  const description =
    readString(request.description) ??
    readString(request.title) ??
    readString(request.questions?.[0]?.question) ??
    observed?.description ??
    "";
  const turnId = readString(request.turnId ?? undefined) ?? observed?.turnId;
  const logicalItemId = observed?.logicalItemId;
  const detail = request.providerMetadata ?? observed?.detail;
  return {
    itemId,
    ...(logicalItemId ? { logicalItemId } : {}),
    kind: observed?.kind ?? inferKind(request),
    // Validated, not trusted: `kind` is a bare string on the wire, and it now
    // drives whether `approve()` will answer the request at all. An unknown
    // value becomes `undefined` — the honest answer, and the one that leaves
    // the request answerable rather than refusing it on a guess.
    ...(readPendingInputKind(request.kind) ? { requestKind: readPendingInputKind(request.kind)! } : {}),
    description,
    ...(turnId ? { turnId } : {}),
    ...(detail !== undefined ? { detail } : {}),
    // `isSupportedProvider` is a type guard, so `request.source` is already
    // narrowed to `AdeProvider` in this branch.
    provider: isSupportedProvider(request.source) ? request.source : threadProvider,
  };
}

/** Maps an observed event to the same shape, for the no-RPC fallback path. */
export function approvalFromObserved(
  observed: ObservedApproval,
  threadProvider: AdeProvider,
): ApprovalRequest {
  return {
    itemId: observed.itemId,
    ...(observed.logicalItemId ? { logicalItemId: observed.logicalItemId } : {}),
    kind: observed.kind,
    ...(observed.requestKind ? { requestKind: observed.requestKind } : {}),
    description: observed.description,
    ...(observed.turnId ? { turnId: observed.turnId } : {}),
    ...(observed.detail !== undefined ? { detail: observed.detail } : {}),
    provider: threadProvider,
  };
}
