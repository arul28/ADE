/**
 * Sends whose arrival is not confirmed, kept outside the chat pane: a project
 * switch tears the pane down, and the draft it restores comes back with the
 * same words. The retry must then carry the same `clientSendId`, or a message
 * that already reached the other machine is written a second time there.
 *
 * An entry also keeps what it takes to tell "still in doubt" from "arrived
 * while the pane was closed": the chat, the words and the moment the send was
 * made, which is exactly what the pane's arrival check reads. An entry goes
 * when its send is confirmed — by the answer or by the transcript — never on a
 * guess, so a link that drops twice still repeats one id.
 */
const MAX_UNCONFIRMED_SENDS = 8;

export type UnconfirmedSend = {
  clientSendId: string;
  sessionId: string;
  /** The words the send carried, as the transcript records them. */
  texts: string[];
  /** When the send was made, ISO 8601. */
  submittedAt: string;
  /** Copies of those words already in the chat when it went out. */
  alreadyThere: number;
  /**
   * The composer text the send took, exactly as typed: what a put-back writes
   * into the composer or the saved draft. Once the send shows in its chat,
   * this text must not stay in either.
   */
  draftText?: string;
};

const unconfirmed = new Map<string, UnconfirmedSend>();

/** The send of this payload to this chat that is still unconfirmed, or null. */
export function unconfirmedSend(identityKey: string): UnconfirmedSend | null {
  return unconfirmed.get(identityKey) ?? null;
}

/** Remembers a send's id for a retry of the same payload to the same chat. */
export function rememberUnconfirmedSend(identityKey: string, send: UnconfirmedSend): void {
  unconfirmed.delete(identityKey);
  unconfirmed.set(identityKey, send);
  while (unconfirmed.size > MAX_UNCONFIRMED_SENDS) {
    const oldest = unconfirmed.keys().next().value;
    if (oldest === undefined) break;
    unconfirmed.delete(oldest);
  }
}

/**
 * The send is confirmed (or the person gave up): a later identical one is new.
 * It forgets only the entry it names — an earlier send's late check must not
 * drop the id a later, identical send is still relying on.
 */
export function forgetUnconfirmedSend(identityKey: string, clientSendId: string): void {
  if (unconfirmed.get(identityKey)?.clientSendId === clientSendId) unconfirmed.delete(identityKey);
}

/** The unconfirmed sends to one chat, with the key each is kept under. */
export function unconfirmedSendsFor(sessionId: string): Array<[identityKey: string, send: UnconfirmedSend]> {
  return [...unconfirmed].filter(([, send]) => send.sessionId === sessionId);
}

/**
 * Sends seen in their chat after their call was lost, by client send id. A
 * put-back or a draft restore that ran before the message showed can still
 * bring the words back for a moment after that; for this long, a pane that
 * shows the chat clears exactly those words from its composer and drafts.
 */
const DELIVERED_KEEP_MS = 60_000;
const MAX_DELIVERED_SENDS = 16;

export type DeliveredSend = { sessionId: string; clientSendId: string; draftText: string; seenAt: number };

const delivered = new Map<string, DeliveredSend>();

function pruneDelivered(now: number): void {
  for (const [id, send] of delivered) {
    if (now - send.seenAt > DELIVERED_KEEP_MS || delivered.size > MAX_DELIVERED_SENDS) delivered.delete(id);
  }
}

/** The send showed in its chat: it is delivered, and never goes back in a composer. */
export function markSendDelivered(send: UnconfirmedSend, now = Date.now()): void {
  if (!delivered.has(send.clientSendId)) {
    delivered.set(send.clientSendId, {
      sessionId: send.sessionId,
      clientSendId: send.clientSendId,
      draftText: send.draftText ?? "",
      seenAt: now,
    });
  }
  pruneDelivered(now);
}

/** Whether a pane has seen this send in its chat (within the keep window). */
export function isSendDelivered(clientSendId: string | null | undefined, now = Date.now()): boolean {
  if (!clientSendId) return false;
  pruneDelivered(now);
  return delivered.has(clientSendId);
}

/** The delivered sends to one chat still within the keep window. */
export function deliveredSendsFor(sessionId: string, now = Date.now()): DeliveredSend[] {
  pruneDelivered(now);
  return [...delivered.values()].filter((send) => send.sessionId === sessionId);
}
