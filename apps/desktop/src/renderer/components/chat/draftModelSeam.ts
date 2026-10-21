/**
 * Sets the model of the chat draft on screen from outside its composer: the
 * onboarding tour's first chat starts on a cheap model the user did not pick.
 *
 * A draft pane registers its composer's own model handler while it is mounted
 * (`AgentChatPane`), so the composer's usual checks apply. A pick made while
 * the draft is still mounting (right after navigating to it) waits for one to
 * register, for a bounded time. No polling, no window events.
 */

export type DraftModelPick = {
  modelId: string;
  /**
   * False when ADE chose the model: sending the draft must not make it the
   * machine's remembered default. A model the person picks clears this.
   */
  rememberLaunchDefaults: boolean;
};

/** Applies a pick; false when this draft could not take one yet. */
export type DraftModelSetter = (pick: DraftModelPick) => boolean;

const setters = new Set<DraftModelSetter>();
const waiters = new Set<() => void>();

export function registerDraftModelSetter(setter: DraftModelSetter): () => void {
  setters.add(setter);
  for (const wake of [...waiters]) wake();
  return () => {
    setters.delete(setter);
  };
}

function apply(pick: DraftModelPick): boolean {
  let taken = false;
  for (const setter of setters) {
    if (setter(pick)) taken = true;
  }
  return taken;
}

/**
 * Sets the open draft's model, waiting up to `timeoutMs` for a draft to
 * mount. Resolves false when none took it in time.
 */
export function setOpenDraftModel(pick: DraftModelPick, timeoutMs = 4_000): Promise<boolean> {
  if (apply(pick)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (taken: boolean) => {
      waiters.delete(wake);
      window.clearTimeout(timer);
      resolve(taken);
    };
    const wake = () => {
      if (apply(pick)) finish(true);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    waiters.add(wake);
  });
}
