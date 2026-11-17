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
