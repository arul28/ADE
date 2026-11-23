import { StringDecoder } from "node:string_decoder";
import { PairedRuntimeSupersededError } from "./pairedRuntimeErrors";
import { syntheticCallerId } from "../../../shared/syntheticCallerId";
import { carryExpected, markExpectedFromWire } from "../../../shared/expectedError";
import { armDeadline, type DeadlineTimer } from "../../../shared/deadlineTimer";
import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";
import { readBrainConnectionLossData, type BrainConnectionLossData } from "../../../shared/brainConnectionLoss";
import { wireBrainFrames, type RuntimeActionReplyError } from "../../../shared/runtimeActionReplyError";
import { RPC_LIVENESS_PROBE_TIMEOUT_MS } from "../../../shared/rpcLiveness";
import {
  readRunningRequestIds,
  REQUEST_STATUS_METHOD,
  requestDeliveryAllowanceMs,
  MAX_REQUEST_STATUS_IDS,
  RUNNING_REQUEST_NOT_RUNNING_REASON,
  type RequestStatusParams,
  RUNNING_REQUEST_MAX_EXTENSION_MS,
  RUNNING_REQUEST_RECHECK_MS,
} from "../../../shared/runningRequests";
import type { JsonRpcId, JsonRpcRequest, JsonRpcTransport } from "../../../../../ade-cli/src/jsonrpc";

export type RuntimeRpcTransportCloseInfo = {
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string | null;
  /**
   * Who closed a socket transport, and why: the WebSocket close code and
   * reason, or that this computer closed it. Without it every paired close read
   * "connection closed", and a flapping connection could not be diagnosed.
   */
  detail?: string | null;
  /** The host replaced this connection with a newer one from the same device. */
  superseded?: boolean;
  /** The WebSocket close code, kept on the error so a caller can classify it (the relay's 4505). */
  closeCode?: number | null;
};

export type RuntimeRpcTransport = JsonRpcTransport & {
  onClose?: (callback: (info?: RuntimeRpcTransportCloseInfo) => void) => void;
  onError?: (callback: (error: Error) => void) => void;
};

type PendingRequest = {
  method: string;
  /** `method`, plus the action it carries. What a timeout must name. */
  label: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  deadline: DeadlineTimer;
  /** When the call was sent. */
  sentAt: number;
  /** The call's own budget, before any wait while it still runs. */
  budgetMs: number;
  /** Set for a call that asks the other end before giving up (`shared/runningRequests.ts`). */
  giveUpAt: number | null;
  /** Its whole budget when the other end cannot answer that check. */
  withoutCheckMs: number;
  /** The other end has said at least once that it still runs this call. */
  seenRunning: boolean;
};

const MAX_RPC_BUFFER_CHARS = 16 * 1024 * 1024;
// Head of an oversized line retained to identify which request it answers.
// The JSON-RPC envelope id appears within the first few dozen chars of a
// response; 4 KiB is generous while keeping discarded-line memory bounded.
const OVERSIZED_LINE_PREFIX_CHARS = 4096;
const MAX_RPC_TIMEOUT_MS = 2_147_483_647;

type RuntimeRpcCallOptions = {
  timeoutMs?: number;
  /**
   * When `timeoutMs` runs out, ask the other end whether it is still working
   * on this call and keep waiting while it is (`shared/runningRequests.ts`).
   * For work the caller wants the answer to, however long it takes; not for a
   * read whose caller has a fallback to show when it is slow.
   */
  waitWhileRunning?: boolean;
  /**
   * With `waitWhileRunning`: the call's whole budget when the other end is an
   * ADE from before the check, so it is not cut shorter than it used to be.
   * Defaults to `timeoutMs`.
   */
  timeoutWithoutCheckMs?: number;
};

function reportBrainConnectionLoss(method: string, data: BrainConnectionLossData): void {
  forwardSignalToSentry("remote.brain_connection_lost", {
    method,
    brainState: data.brainState,
    socketError: data.socketError,
    heartbeatAgeSec: data.heartbeatAgeSec,
    brainLogTail: data.brainLogTail
      .map((entry) => [entry.level, entry.event, entry.code].filter(Boolean).join(" "))
      .join("\n"),
  }, `remote.brain_connection_lost:${data.brainState}`);
}

function formatRpcErrorData(data: unknown): string {
  if (data && typeof data === "object") return JSON.stringify(data);
  if (typeof data === "string" && data.trim()) return data.trim();
  return "";
}

/**
 * What a pending call is called, for humans.
 *
 * Every runtime action in the product travels as the same JSON-RPC method,
 * `ade/actions/call`, so a bare method name in a timeout says only "something
 * on the runtime hung" — which is exactly what the Apple pane's input bug
 * looked like in the desktop log: dozens of identical lines naming no action.
 * The domain and action are already in the envelope; naming them costs nothing
 * and turns that log line into a diagnosis.
 */
export function describeRuntimeRpcCall(
  method: string,
  params?: Record<string, unknown>,
): string {
  const envelope = params?.arguments;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return method;
  const record = envelope as Record<string, unknown>;
  const domain = typeof record.domain === "string" ? record.domain.trim() : "";
  const action = typeof record.action === "string" ? record.action.trim() : "";
  if (!domain && !action) return method;
  return `${method} ${domain || "?"}.${action || "?"}`;
}

function normalizeRuntimeRpcTimeoutMs(value: number): number {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_RPC_TIMEOUT_MS) {
    throw new Error(
      `Runtime RPC timeout must be a finite positive number no greater than ${MAX_RPC_TIMEOUT_MS}.`,
    );
  }
  return Math.ceil(timeoutMs);
}

type OversizedLineState = {
  prefix: string;
  discardedChars: number;
};

export class RuntimeRpcClient {
  private nextId = 1;
  private buffer = "";
  private oversizedLine: OversizedLineState | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly disconnectCallbacks = new Set<(error: Error) => void>();
  private closedError: Error | null = null;
  private lastInboundAtMs: number | null = null;
  /** Calls past their budget waiting for the next status check. */
  private readonly overdue = new Set<number>();
  private statusCheckRunning = false;
  private statusCheckAgain = false;
  /** The other end answered the status check with an error: an older brain without it. */
  private requestStatusUnsupported = false;
  /** Characters sent and received on this connection, for the link summary log. */
  private bytesIn = 0;
  private bytesOut = 0;

  constructor(
    private readonly transport: RuntimeRpcTransport,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {
    // A reply larger than one read arrives in pieces, and a piece can end
    // inside a multi-byte character. The decoder keeps the incomplete bytes for
    // the next piece. Decoding each piece alone turned that character into
    // U+FFFD, at a different place on every read of the same data.
    const decoder = new StringDecoder("utf8");
    this.transport.onData((chunk) => {
      this.bytesIn += chunk.length;
      this.onData(decoder.write(chunk));
    });
    this.transport.onError?.((error) => {
      // `cause` keeps the transport's typed error, so a caller can tell an
      // over-budget channel close from a lost machine.
      this.failConnection(carryExpected(error, new Error(`Remote ADE service connection failed: ${error.message}`, { cause: error })));
    });
    this.transport.onClose?.((info) => {
      const details = [
        info?.exitCode != null ? `exit code ${info.exitCode}` : null,
        info?.signal ? `signal ${info.signal}` : null,
        info?.stderr?.trim() ? `stderr: ${summarizeRemoteRuntimeStderr(info.stderr)}` : null,
        info?.detail?.trim() ? info.detail.trim() : null,
      ].filter((value): value is string => value != null);
      const message = details.length > 0
        ? `Remote ADE service connection closed (${details.join(", ")}).`
        : "Remote ADE service connection closed.";
      const error = info?.superseded
        ? new Error(message, { cause: new PairedRuntimeSupersededError() })
        : new Error(message);
      this.failConnection(info?.closeCode != null ? Object.assign(error, { closeCode: info.closeCode }) : error);
    });
  }

  async initialize(
    clientName: string,
    version: string,
    options: {
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    return await this.call("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: clientName, version },
      identity: {
        callerId: syntheticCallerId(clientName),
        role: "cto",
      },
    }, {
      ...(options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  call(
    method: string,
    params?: Record<string, unknown>,
    options: RuntimeRpcCallOptions = {},
  ): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: id as JsonRpcId,
      method,
      ...(params ? { params } : {}),
    };
    let timeoutMs: number;
    let withoutCheckMs: number;
    let line: string;
    try {
      line = `${JSON.stringify(payload)}\n`;
      timeoutMs = normalizeRuntimeRpcTimeoutMs(options.timeoutMs ?? this.timeoutMs);
      // The first check cannot be answered before the request has arrived.
      if (options.waitWhileRunning) {
        timeoutMs = Math.min(MAX_RPC_TIMEOUT_MS, timeoutMs + requestDeliveryAllowanceMs(line.length));
      }
      withoutCheckMs = Math.max(timeoutMs, normalizeRuntimeRpcTimeoutMs(options.timeoutWithoutCheckMs ?? timeoutMs));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const label = describeRuntimeRpcCall(method, params);
    return new Promise((resolve, reject) => {
      const sentAt = Date.now();
      // A timer that fires late (the Mac slept) gets one short grace, so a
      // reply that is already waiting on the socket is read before it fails.
      const deadline = armDeadline(timeoutMs, () => this.handleDeadline(id));
      this.pending.set(id, {
        method,
        label,
        resolve,
        reject,
        deadline,
        sentAt,
        budgetMs: timeoutMs,
        giveUpAt: options.waitWhileRunning ? sentAt + timeoutMs + RUNNING_REQUEST_MAX_EXTENSION_MS : null,
        withoutCheckMs,
        seenRunning: false,
      });
      try {
        this.bytesOut += Buffer.byteLength(line);
        this.transport.write(line);
      } catch (error) {
        this.takePending(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onDisconnect(callback: (error: Error) => void): () => void {
    if (this.closedError) {
      const error = this.closedError;
      queueMicrotask(() => callback(error));
      return () => {};
    }
    this.disconnectCallbacks.add(callback);
    return () => {
      this.disconnectCallbacks.delete(callback);
    };
  }

  onNotification(method: string, callback: (params: unknown) => void): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set<(params: unknown) => void>();
    handlers.add(callback);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(callback);
      if (handlers.size === 0) {
        this.notificationHandlers.delete(method);
      }
    };
  }

  close(): void {
    this.failConnection(new Error("Remote ADE service connection closed."));
    try {
      this.transport.close();
    } catch {
      // Best-effort close. Pending callers have already been rejected.
    }
  }

  isClosed(): boolean {
    return this.closedError != null;
  }

  /**
   * When the other end last sent anything (a reply, a notification), or null
   * before it ever has. Bytes arriving prove the connection carries traffic,
   * however long one particular reply is taking.
   */
  lastInboundAt(): number | null {
    return this.lastInboundAtMs;
  }

  /** Bytes in and out on this connection since it opened (out: characters of each request). */
  traffic(): { bytesIn: number; bytesOut: number } {
    return { bytesIn: this.bytesIn, bytesOut: this.bytesOut };
  }

  /**
   * A call's timer ran out. One that waits while it runs is asked about
   * (`checkOverdueRequests`) until its last allowed moment; any other fails.
   */
  private handleDeadline(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const now = Date.now();
    if (pending.giveUpAt != null && now < pending.giveUpAt) {
      if (this.requestStatusUnsupported) {
        if (this.waitWithoutCheck(id, pending, now)) return;
      } else {
        this.overdue.add(id);
        void this.checkOverdueRequests();
        return;
      }
    }
    this.takePending(id);
    pending.reject(
      pending.giveUpAt != null && now >= pending.giveUpAt
        ? runtimeRpcTimeoutError(pending, now - pending.sentAt, "it was still running there")
        : runtimeRpcTimeoutError(pending, pending.budgetMs),
    );
  }

  /**
   * Asks the other end which overdue calls it is still working on, one
   * `ade/requests/status` for every call overdue at the time, and decides
   * each: still running waits on; missing fails, since its answer is not
   * coming. No answer to the check, or an end without it, fails them as a
   * timeout did before the check existed, so a dead link is not held open
   * any longer than it was (the pool's liveness check and redial take over).
   */
  private async checkOverdueRequests(): Promise<void> {
    if (this.statusCheckRunning) {
      this.statusCheckAgain = true;
      return;
    }
    this.statusCheckRunning = true;
    try {
      do {
        this.statusCheckAgain = false;
        const waiting = [...this.overdue].filter((id) => this.pending.has(id));
        this.overdue.clear();
        if (waiting.length === 0) break;
        // The other end answers for at most this many ids; the rest go next.
        const ids = waiting.slice(0, MAX_REQUEST_STATUS_IDS);
        for (const id of waiting.slice(MAX_REQUEST_STATUS_IDS)) this.overdue.add(id);
        if (this.overdue.size > 0) this.statusCheckAgain = true;
        // null: no answer, or an answer from an end that does not know the check.
        let running: Set<string | number> | null = null;
        let unsupported = false;
        try {
          const params: RequestStatusParams = { ids };
          const reply = await this.call(REQUEST_STATUS_METHOD, params, { timeoutMs: RPC_LIVENESS_PROBE_TIMEOUT_MS });
          running = readRunningRequestIds(reply);
          unsupported = !running;
        } catch (error) {
          if (this.closedError) return;
          // Only an error reply means the other end does not know the check;
          // a timeout, a failed write or a relay that lost its brain is no answer.
          unsupported = error instanceof Error
            && error.message.startsWith(`Remote ADE service method ${REQUEST_STATUS_METHOD} failed`)
            && !("remoteDiagnostics" in error);
        }
        if (unsupported && !this.requestStatusUnsupported) {
          this.requestStatusUnsupported = true;
          console.warn("Remote ADE service does not answer request status checks; calls keep their plain budgets", {
            method: REQUEST_STATUS_METHOD,
          });
        }
        const now = Date.now();
        for (const id of ids) {
          const pending = this.pending.get(id);
          if (!pending) continue;
          if (unsupported && this.waitWithoutCheck(id, pending, now)) continue;
          const failure = overdueFailure(pending, running?.has(id) ?? null, now);
          if (failure) {
            this.takePending(id);
            pending.reject(failure);
            continue;
          }
          pending.seenRunning = true;
          pending.deadline.cancel();
          const giveUpAt = pending.giveUpAt ?? now;
          pending.deadline = armDeadline(
            Math.max(1, Math.min(RUNNING_REQUEST_RECHECK_MS, giveUpAt - now)),
            () => this.handleDeadline(id),
          );
        }
      } while (this.statusCheckAgain);
    } finally {
      this.statusCheckRunning = false;
    }
  }

  /**
   * The other end cannot answer the check (an ADE from before it): give the
   * call the rest of `withoutCheckMs`, then a plain timeout. False when none is left.
   */
  private waitWithoutCheck(id: number, pending: PendingRequest, now: number): boolean {
    const remainingMs = pending.sentAt + pending.withoutCheckMs - now;
    if (remainingMs <= 0) return false;
    pending.giveUpAt = null;
    pending.budgetMs = pending.withoutCheckMs;
    pending.deadline.cancel();
    pending.deadline = armDeadline(remainingMs, () => this.handleDeadline(id));
    return true;
  }

  private onData(chunk: string): void {
    if (this.closedError) return;
    this.lastInboundAtMs = Date.now();
    if (this.oversizedLine) {
      // An oversized line is being discarded as it streams. Drop chunks until
      // its terminating newline, then resume normal parsing on the remainder.
      const newline = chunk.indexOf("\n");
      if (newline < 0) {
        this.oversizedLine.discardedChars += chunk.length;
        return;
      }
      const oversized = this.oversizedLine;
      this.oversizedLine = null;
      oversized.discardedChars += newline;
      this.rejectOversizedLine(oversized);
      chunk = chunk.slice(newline + 1);
    }
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
      if (this.closedError) return;
    }
    // The leftover is one partial line. If it has outgrown the buffer cap,
    // reject only the request it answers and discard the rest of the line as
    // it streams — a single oversized response must not take down the shared
    // connection (every project pane multiplexes over it). Note the cap
    // bounds PARTIAL-LINE ACCUMULATION, not message size: a complete line
    // delivered within one chunk is parsed regardless of length. Real
    // transports chunk at ~64 KB, so any >16 MiB line lands here in practice.
    if (this.buffer.length > MAX_RPC_BUFFER_CHARS) {
      this.oversizedLine = {
        prefix: this.buffer.slice(0, OVERSIZED_LINE_PREFIX_CHARS),
        discardedChars: this.buffer.length,
      };
      this.buffer = "";
    }
  }

  private takePending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    pending.deadline.cancel();
    return pending;
  }

  /**
   * Fail the single request answered by a discarded oversized line. The
   * envelope id is recovered from the retained line head; a `"method"` key
   * appearing before `"id"` marks the line as a notification (its params may
   * embed unrelated `"id"` fields), in which case nothing is rejected.
   *
   * Heuristic assumption: the daemon serializes response envelopes with the
   * top-level `id` before `result` (jsonrpc.ts writeMessage key order), so
   * the first `"id"` in a response line is the envelope id, never one nested
   * inside the result. If a misfire ever happens anyway, the failure mode is
   * benign: no pending entry matches, the line is warn-logged and dropped,
   * and the real caller times out instead of receiving a wrong rejection.
   */
  private rejectOversizedLine(oversized: OversizedLineState): void {
    const idMatch = /"id"\s*:\s*(\d+)/.exec(oversized.prefix);
    const methodMatch = /"method"\s*:/.exec(oversized.prefix);
    const responseId = idMatch && (!methodMatch || idMatch.index < methodMatch.index)
      ? Number(idMatch[1])
      : null;
    const approxMiB = (oversized.discardedChars / (1024 * 1024)).toFixed(1);
    const pending = responseId != null ? this.takePending(responseId) : undefined;
    if (!pending || responseId == null) {
      console.warn("Remote ADE service sent an oversized message; discarded", {
        approxMiB,
        hasResponseId: responseId != null,
      });
      return;
    }
    pending.reject(new Error(
      `Remote ADE service response for method ${pending.method} exceeded 16 MiB (~${approxMiB} MiB) and was discarded.`,
    ));
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.failConnection(new Error(`Failed to parse remote ADE service response: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const response = parsed as Record<string, unknown>;
    const id = typeof response.id === "number" ? response.id : null;
    if (id == null) {
      const method = typeof response.method === "string" ? response.method : "";
      if (!method) return;
      for (const handler of this.notificationHandlers.get(method) ?? []) {
        try {
          handler(response.params);
        } catch (error) {
          console.error("Remote ADE notification handler failed", { method, error });
        }
      }
      return;
    }
    const pending = this.takePending(id);
    if (!pending) return;
    const error = response.error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const rpcError = error as { code?: unknown; message?: unknown; data?: unknown; expected?: unknown };
      const message = String(rpcError.message ?? "Remote ADE service request failed.");
      const code = typeof rpcError.code === "number" ? ` (code ${rpcError.code})` : "";
      const brainLoss = readBrainConnectionLossData(rpcError.data);
      if (brainLoss) {
        // The other machine's relay lost its brain. What it saw goes to Sentry
        // from here (that machine may have no route to Sentry); the message
        // stays a sentence a person can read.
        reportBrainConnectionLoss(pending.label, brainLoss);
        pending.reject(markExpectedFromWire(Object.assign(new Error(
          `Remote ADE service method ${pending.method} failed${code}: ${message}`,
        ), { remoteDiagnostics: brainLoss }), rpcError.expected));
        return;
      }
      const data = formatRpcErrorData(rpcError.data);
      const rebuilt: RuntimeActionReplyError = new Error(
        `Remote ADE service method ${pending.method} failed${code}: ${message}${data ? ` Details: ${data}` : ""}`,
      );
      // An internal error's own frames (`data.frames`), so the report says
      // where the brain failed, as it does for a failed action's reply.
      const brainFrames = wireBrainFrames(
        rpcError.data && typeof rpcError.data === "object" ? (rpcError.data as { frames?: unknown }).frames : null,
      );
      if (brainFrames.length) rebuilt.brainFrames = brainFrames;
      pending.reject(markExpectedFromWire(rebuilt, rpcError.expected));
      return;
    }
    pending.resolve(response.result);
  }

  private failConnection(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.rejectAll(error);
    for (const callback of this.disconnectCallbacks) {
      try {
        callback(error);
      } catch {
        // Disconnect observers are best-effort; the connection is already failed.
      }
    }
    this.disconnectCallbacks.clear();
  }

  private rejectAll(error: Error): void {
    this.overdue.clear();
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.deadline.cancel();
      pending.reject(error);
    }
  }
}

/**
 * What a status check decided for one overdue call: null while the other end
 * still runs it. `running` is null when the check got no usable answer.
 */
function overdueFailure(pending: PendingRequest, running: boolean | null, now: number): Error | null {
  if (running === true) return null;
  if (running === false) {
    return runtimeRpcTimeoutError(pending, now - pending.sentAt, RUNNING_REQUEST_NOT_RUNNING_REASON);
  }
  return pending.seenRunning
    ? runtimeRpcTimeoutError(pending, now - pending.sentAt, "it stopped answering")
    : runtimeRpcTimeoutError(pending, pending.budgetMs);
}

/**
 * A call that got no answer in time. The wording stays the one every reader
 * matches (`isRuntimeTransportTimeoutError`, Sentry's expected failures); a
 * call that waited while it ran adds why it stopped waiting.
 */
function runtimeRpcTimeoutError(pending: PendingRequest, waitedMs: number, reason?: string): Error {
  const waited = reason ? `${Math.round(waitedMs)}ms; ${reason}` : `${waitedMs}ms`;
  return new Error(`Remote ADE service timed out waiting for method ${pending.label} (${waited}).`);
}

/**
 * The remote CLI's stderr, reduced to what a person can act on.
 *
 * On a failed connect the remote `ade` prints its error line, then a stack
 * trace into a bundled `.sea` file, and Node adds an ExperimentalWarning and
 * a "--trace-warnings" hint. All of it landed in the Machines dialog verbatim
 * (2026-09-22), three times over. Keep the error lines; drop stack frames and
 * runtime warnings. The CLI's own "ade: Error: " prefix goes too — the dialog
 * already says the remote ADE failed.
 */
export function summarizeRemoteRuntimeStderr(stderr: string): string {
  const kept = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0
      && !/^at\s/.test(line)
      && !/\b(?:Experimental|Deprecation)Warning\b/.test(line)
      && !/--trace-(?:warnings|deprecation)\b/.test(line)
    )
    .map((line) => line.replace(/^ade:\s+(?:Error:\s+)?/, ""));
  return kept.length > 0 ? kept.join(" ") : stderr.trim();
}
