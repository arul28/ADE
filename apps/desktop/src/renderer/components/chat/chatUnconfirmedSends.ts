/**
 * Sends whose arrival is not confirmed, kept outside the chat pane: a project
 * switch tears the pane down, and the draft it restores comes back with the
 * same words. The retry must then carry the same `clientSendId`, or a message
 * that already reached the other machine is written a second time there.
 *
 * Keyed by chat and by the whole payload (built by the pane), bounded to a
 * handful, oldest first. An entry goes when its send is confirmed — by the
 * answer or by the transcript — never on a guess, so a link that drops twice
 * still repeats one id.
 */
const MAX_UNCONFIRMED_SENDS = 8;

const unconfirmed = new Map<string, string>();

/** The id a send of this payload to this chat went out with last time, or null. */
export function unconfirmedSendId(identityKey: string): string | null {
  return unconfirmed.get(identityKey) ?? null;
}

/** Remembers the id for a retry of the same payload to the same chat. */
export function rememberUnconfirmedSend(identityKey: string, clientSendId: string): void {
  unconfirmed.delete(identityKey);
  unconfirmed.set(identityKey, clientSendId);
  while (unconfirmed.size > MAX_UNCONFIRMED_SENDS) {
    const oldest = unconfirmed.keys().next().value;
    if (oldest === undefined) break;
    unconfirmed.delete(oldest);
  }
}

/** The send is confirmed (or the person gave up): a later identical one is new. */
export function forgetUnconfirmedSend(identityKey: string | null | undefined): void {
  if (identityKey) unconfirmed.delete(identityKey);
}
