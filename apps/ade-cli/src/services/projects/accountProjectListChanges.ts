/**
 * The account's project list changed on this brain (`accountProjectSync.ts`
 * read a newer list after a heartbeat). Each project runtime of the brain
 * listens and tells its clients: the desktop through its runtime events, ADE
 * Web and the phone through the sync connection. The clients then read the
 * list again, so a copy added on another computer joins an open tab without a
 * window focus and without a poll.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** A project runtime listens while it runs; call the result when it stops. */
export function onAccountProjectListChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The publishing brain calls this after it wrote a changed list. */
export function noteAccountProjectListChanged(): void {
  for (const listener of [...listeners]) {
    // One runtime's failure must not keep the others from telling their clients.
    try {
      listener();
    } catch {
      // The clients read the list again on their next focus.
    }
  }
}
