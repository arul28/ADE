import type { Logger } from "../logging/logger";

/**
 * Steps of one send on the host, in the order they normally happen. Each one
 * is recorded once per send, in ms after the host took the send.
 */
export type ChatSendTimingMark =
  | "dispatchAck"
  | "userMessageCommitted"
  | "turnStart"
  | "effortApplied"
  | "warmupWaited"
  | "queryReady"
  | "permissionModeSet"
  | "promptBuilt"
  | "promptWritten"
  | "firstSdkMessage"
  | "firstSdkTextDelta"
  | "firstTextCommitted";

/** How the turn got its provider process: a prewarmed query, the live one from an earlier turn, or a new one. */
export type ChatSendTimingQuery = "warm" | "live" | "starting" | "new";

type Entry = {
  startedAt: number;
  receivedAtMs: number;
  clientSubmittedAtMs: number | null;
  provider: string;
  marks: Partial<Record<ChatSendTimingMark, number>>;
  query?: ChatSendTimingQuery;
  firstSdkMessageType?: string;
};

const MAX_OPEN_SENDS = 64;

/**
 * Times one send from the moment the host takes it to its first committed
 * words, and logs one line per turn (`agent_chat.send_timing`). The line
 * carries ids and numbers only, never message text. A send that ends without
 * text logs at the turn's end; a new send to the same chat replaces an open one.
 */
export function createChatSendTiming(logger: Logger) {
  const open = new Map<string, Entry>();
  const elapsed = (entry: Entry): number => Math.round((performance.now() - entry.startedAt) * 10) / 10;

  const finish = (sessionId: string, outcome: "text" | "done"): void => {
    const entry = open.get(sessionId);
    if (!entry) return;
    open.delete(sessionId);
    logger.info("agent_chat.send_timing", {
      sessionId,
      provider: entry.provider,
      outcome,
      receivedAtMs: entry.receivedAtMs,
      clientSubmittedAtMs: entry.clientSubmittedAtMs,
      // Wall clocks of one computer; a client on another machine can be off.
      enterToReceiveMs: entry.clientSubmittedAtMs != null ? entry.receivedAtMs - entry.clientSubmittedAtMs : null,
      query: entry.query ?? null,
      firstSdkMessageType: entry.firstSdkMessageType ?? null,
      ...entry.marks,
    });
  };

  return {
    begin(sessionId: string, provider: string, clientSubmittedAtMs: unknown): void {
      if (!open.has(sessionId) && open.size >= MAX_OPEN_SENDS) {
        const oldest = open.keys().next().value;
        if (oldest !== undefined) open.delete(oldest);
      }
      open.set(sessionId, {
        startedAt: performance.now(),
        receivedAtMs: Date.now(),
        clientSubmittedAtMs: typeof clientSubmittedAtMs === "number" && Number.isFinite(clientSubmittedAtMs)
          ? Math.round(clientSubmittedAtMs)
          : null,
        provider,
        marks: {},
      });
    },
    /** True while a send of this chat is being timed; a cheap check for hot paths. */
    isOpen(sessionId: string): boolean {
      return open.has(sessionId);
    },
    mark(sessionId: string, name: ChatSendTimingMark): void {
      const entry = open.get(sessionId);
      if (!entry || entry.marks[name] !== undefined) return;
      entry.marks[name] = elapsed(entry);
      if (name === "firstTextCommitted") finish(sessionId, "text");
    },
    noteQuery(sessionId: string, query: ChatSendTimingQuery): void {
      const entry = open.get(sessionId);
      if (entry && !entry.query) entry.query = query;
    },
    noteFirstSdkMessage(sessionId: string, type: string): void {
      const entry = open.get(sessionId);
      if (!entry || entry.marks.firstSdkMessage !== undefined) return;
      entry.marks.firstSdkMessage = elapsed(entry);
      entry.firstSdkMessageType = type;
    },
    /** The turn ended before any text was committed. */
    finishTurn(sessionId: string): void {
      finish(sessionId, "done");
    },
  };
}

export type ChatSendTiming = ReturnType<typeof createChatSendTiming>;
