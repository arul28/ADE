import type { UpdateInterruptedChat } from "../../../shared/types";

/**
 * The ways to ask for the "What's new" modal, without its code.
 *
 * The modal (`AnnouncementsHost`, with the bundled release notes and its
 * pages) loads after the window's first paint, or at once when something asks
 * for it. A request made before it is listening waits here and is handed over
 * when it starts listening, so an after-update showing asked for at launch is
 * never lost.
 */

export const WHATS_NEW_OPEN_EVENT = "ade:open-whats-new";
export const WHATS_NEW_AFTER_UPDATE_EVENT = "ade:open-whats-new-after-update";

export type AfterUpdateDetail = {
  version: string;
  fromVersion: string | null;
  resumedChats: readonly UpdateInterruptedChat[];
  changelogUrl: string | null;
  githubReleaseUrl: string | null;
  /** Called once the modal closes, so the update record can be put away. */
  onClose: () => void;
};

type WhatsNewRequest = { kind: "all" } | { kind: "after-update"; detail: AfterUpdateDetail };

let hostListening = false;
const queued: WhatsNewRequest[] = [];
const requestListeners = new Set<() => void>();

function dispatch(request: WhatsNewRequest): void {
  if (request.kind === "all") {
    window.dispatchEvent(new Event(WHATS_NEW_OPEN_EVENT));
    return;
  }
  window.dispatchEvent(new CustomEvent<AfterUpdateDetail>(WHATS_NEW_AFTER_UPDATE_EVENT, { detail: request.detail }));
}

function deliver(request: WhatsNewRequest): void {
  if (hostListening) {
    dispatch(request);
    return;
  }
  queued.push(request);
  for (const listener of [...requestListeners]) listener();
}

/** Opens every "What's new" page (Help menu, command palette). */
export function openWhatsNew(): void {
  deliver({ kind: "all" });
}

/** The first launch after this computer installed an update (AutoUpdateControl). */
export function openWhatsNewAfterUpdate(detail: AfterUpdateDetail): void {
  deliver({ kind: "after-update", detail });
}

/** Whether a request is waiting for the modal to load. */
export function whatsNewRequested(): boolean {
  return queued.length > 0;
}

/** Called when a request arrives before the modal is listening. */
export function subscribeWhatsNewRequests(listener: () => void): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

/**
 * The modal calls this once its event listeners are attached: the requests
 * that waited are dispatched to it now, in order. Returns the detach.
 */
export function attachWhatsNewHost(): () => void {
  hostListening = true;
  for (const request of queued.splice(0)) dispatch(request);
  return () => {
    hostListening = false;
  };
}
