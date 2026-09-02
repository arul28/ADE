/**
 * Bridge `session/request_permission` to an ADE pending-input surface.
 *
 * The agent blocks on this request. Three rules follow from that.
 *
 * 1. Every request must get an answer. A dropped request hangs the turn with no
 *    visible cause.
 * 2. A cancelled turn must answer every request that is still open, with
 *    `outcome: "cancelled"`. Otherwise the agent waits for a card the user can
 *    no longer see.
 * 3. A closing connection must reject the waiters, not leave them pending.
 *
 * ## Option kinds
 *
 * ACP defines four option kinds. Grok has shipped options with no `kind` at
 * all, and with ids such as `enable-always-approve`. The bridge therefore
 * derives a kind from the option id and name when the wire omits it, so the
 * host always knows which option means "allow" and which means "reject".
 */

import type { PendingInputOption, PendingInputRequest } from "../../../../shared/types";
import type {
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpRequestPermissionResponse,
  AcpToolCallUpdate,
} from "./acpProtocolTypes";
import { normalizeAcpPermissionRequest } from "./acpProtocolTypes";

export type AcpNormalizedPermissionOption = {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
  /** True when the kind came from the wire rather than from id matching. */
  kindFromWire: boolean;
};

const WIRE_KINDS: ReadonlySet<string> = new Set<AcpPermissionOptionKind>([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);

/**
 * Ordered id and name patterns, most specific first.
 *
 * "always" must be tested before the bare allow and reject words, or
 * `enable-always-approve` matches "approve" and loses its "always" meaning.
 */
const KIND_PATTERNS: ReadonlyArray<{ kind: AcpPermissionOptionKind; pattern: RegExp }> = [
  { kind: "reject_always", pattern: /(reject|deny|disallow|never|no)[-_ ]?.*always|always[-_ ]?.*(reject|deny|disallow)|never/i },
  { kind: "allow_always", pattern: /always|persist|remember|session|enable[-_ ]?always/i },
  { kind: "reject_once", pattern: /reject|deny|disallow|decline|cancel|no/i },
  { kind: "allow_once", pattern: /allow|approve|accept|yes|proceed|continue|ok/i },
];

/** Derive a permission option kind when the agent did not send one. */
export function normalizePermissionOption(option: AcpPermissionOption): AcpNormalizedPermissionOption {
  if (option.kind && WIRE_KINDS.has(option.kind)) {
    return { optionId: option.optionId, name: option.name, kind: option.kind, kindFromWire: true };
  }
  const haystack = `${option.optionId} ${option.name}`;
  for (const entry of KIND_PATTERNS) {
    if (entry.pattern.test(haystack)) {
      return { optionId: option.optionId, name: option.name, kind: entry.kind, kindFromWire: false };
    }
  }
  // An option ADE cannot classify is treated as a one-time allow, because the
  // agent only offers options it is willing to act on and the user still reads
  // the label. Never silently treat it as an "always".
  return { optionId: option.optionId, name: option.name, kind: "allow_once", kindFromWire: false };
}

export type AcpPendingPermission = {
  /** Stable id ADE uses for the card and for the resolution receipt. */
  requestId: string;
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpNormalizedPermissionOption[];
  turnId: string | null;
  /** Answer with one of the offered option ids. Safe to call twice. */
  select(optionId: string): void;
  /** Answer `cancelled`. Safe to call twice. */
  cancel(): void;
};

export type AcpPermissionBridgeCallbacks = {
  /** Raise a card. The bridge is waiting for `select` or `cancel`. */
  onPermissionRequested: (pending: AcpPendingPermission) => void;
  /** The request settled. Drop the card. */
  onPermissionSettled: (requestId: string, outcome: "selected" | "cancelled" | "closed") => void;
};

export type AcpPermissionBridge = {
  /** Wire this into `connection.onRequest("session/request_permission", ...)`. */
  handleRequest(params: unknown): Promise<AcpRequestPermissionResponse>;
  /** Answer every open request with `cancelled`. Call this when a turn stops. */
  cancelAll(reason: string): void;
  /** Reject every open request. Call this when the connection goes away. */
  rejectAll(reason: string): void;
  /** Open request ids, oldest first. Diagnostics and tests. */
  openRequestIds(): string[];
  /** Current turn id stamped onto new requests. */
  setTurnId(turnId: string | null): void;
};

type OpenRequest = {
  settle: (response: AcpRequestPermissionResponse) => void;
  fail: (error: Error) => void;
  settled: boolean;
};

export type CreateAcpPermissionBridgeArgs = {
  callbacks: AcpPermissionBridgeCallbacks;
  /** Mints the ADE-facing request id. Overridable so tests stay deterministic. */
  generateRequestId?: () => string;
};

export function createAcpPermissionBridge(args: CreateAcpPermissionBridgeArgs): AcpPermissionBridge {
  const open = new Map<string, OpenRequest>();
  let counter = 0;
  let turnId: string | null = null;
  const nextId = args.generateRequestId ?? (() => `acp-perm-${++counter}`);

  const settleWith = (requestId: string, response: AcpRequestPermissionResponse, outcome: "selected" | "cancelled") => {
    const entry = open.get(requestId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    open.delete(requestId);
    entry.settle(response);
    args.callbacks.onPermissionSettled(requestId, outcome);
  };

  return {
    handleRequest: (params: unknown) =>
      new Promise<AcpRequestPermissionResponse>((resolve, reject) => {
        const request = normalizeAcpPermissionRequest(params);
        if (!request) {
          // A malformed request still gets an answer, so the agent moves on.
          resolve({ outcome: { outcome: "cancelled" } });
          return;
        }
        const requestId = nextId();
        open.set(requestId, { settle: resolve, fail: reject, settled: false });
        const pending: AcpPendingPermission = {
          requestId,
          sessionId: request.sessionId,
          toolCall: request.toolCall,
          options: request.options.map(normalizePermissionOption),
          turnId,
          select: (optionId: string) => {
            settleWith(requestId, { outcome: { outcome: "selected", optionId } }, "selected");
          },
          cancel: () => {
            settleWith(requestId, { outcome: { outcome: "cancelled" } }, "cancelled");
          },
        };
        try {
          args.callbacks.onPermissionRequested(pending);
        } catch (error) {
          // The host could not raise a card. Fail closed: answer `cancelled`
          // so the agent stops instead of waiting on a card that never came.
          settleWith(requestId, { outcome: { outcome: "cancelled" } }, "cancelled");
          void error;
        }
      }),
    cancelAll: (reason: string) => {
      for (const requestId of [...open.keys()]) {
        settleWith(requestId, { outcome: { outcome: "cancelled" }, _meta: { reason } }, "cancelled");
      }
    },
    rejectAll: (reason: string) => {
      for (const [requestId, entry] of [...open.entries()]) {
        if (entry.settled) continue;
        entry.settled = true;
        open.delete(requestId);
        entry.fail(new Error(`ACP permission request abandoned: ${reason}`));
        args.callbacks.onPermissionSettled(requestId, "closed");
      }
    },
    openRequestIds: () => [...open.keys()],
    setTurnId: (value: string | null) => {
      turnId = value;
    },
  };
}

/**
 * Shape a pending permission as an ADE `PendingInputRequest`.
 *
 * `source` stays a parameter because W1 adds the `"acp"` member to
 * `PendingInputSource`. Until that lands the caller passes an existing member,
 * and no cast is needed anywhere in this module.
 */
export function pendingPermissionToInputRequest(args: {
  pending: AcpPendingPermission;
  source: PendingInputRequest["source"];
  providerLabel: string;
}): PendingInputRequest {
  const { pending, providerLabel } = args;
  const title = pending.toolCall.title ?? pending.toolCall.name ?? "Tool call";
  const options: PendingInputOption[] = pending.options.map((option) => ({
    label: option.name,
    value: option.optionId,
    ...(option.kind === "allow_once" ? { recommended: true } : {}),
    description:
      option.kind === "allow_always"
        ? "Allow this and every later request of this kind."
        : option.kind === "reject_always"
          ? "Reject this and every later request of this kind."
          : option.kind === "reject_once"
            ? "Reject this request only."
            : "Allow this request only.",
  }));
  return {
    requestId: pending.requestId,
    itemId: pending.toolCall.toolCallId,
    source: args.source,
    kind: "approval",
    title: `${providerLabel} needs permission`,
    description: title,
    questions: [
      {
        id: "decision",
        question: title,
        options,
      },
    ],
    allowsFreeform: false,
    blocking: true,
    canProceedWithoutAnswer: false,
    options,
    turnId: pending.turnId,
    providerMetadata: {
      toolCallId: pending.toolCall.toolCallId,
      toolKind: pending.toolCall.kind ?? null,
      optionKinds: pending.options.map((option) => ({
        optionId: option.optionId,
        kind: option.kind,
        kindFromWire: option.kindFromWire,
      })),
    },
  };
}
