/**
 * Chat first on a chat open.
 *
 * A page that opens on a chat (the Work tab, or a link to a chat or session)
 * sends about 70 reads at start. Before this gate, the chat's own reads (its
 * session row, then its history) waited behind usage totals, the model
 * catalog, provider status and the other heavy reads: a host runs a client's
 * reads a few at a time, and an older brain runs them one at a time. The
 * transcript then came last.
 *
 * On such a page, the reads in DEFERRED_READS wait until one of these:
 *  - the chat's history has arrived and the page has painted and gone idle;
 *  - the Work page has its session list and no chat started to load its
 *    history within NO_CHAT_MS (the page shows a terminal, or no session);
 *  - the hard cap.
 * Every other read, and every write, goes at once. A deferred read goes once
 * the gate opens; nothing is sent twice and nothing is dropped.
 *
 * A "no read in flight" quiet rule does not work here: on a slow link the
 * page downloads the chat pane's code while no read is in flight, and the
 * gate opened before the chat asked for its history (measured at 150 ms RTT,
 * 5 Mbit/s).
 */

/** Reads that a chat does not need to paint. Matched by action, or by namespace with a trailing dot. */
const DEFERRED_READS: readonly string[] = [
  "usage.",
  "chat.modelCatalog",
  "chat.getSlashCommands",
  "chat.getParallelLaunchState",
  "modelPicker.",
  "ai.getStatus",
  "ai.listCursorCloudRepositories",
  "ai.cursorCloudFleet",
  "ai.getCursorCloudLaneSecretNames",
  "android.",
  "macDesktop.",
  "apple.",
  "computerUse.",
  "appControl.",
  "github.",
  "prs.",
  "jira.",
  "cto.",
  "archive.",
  "cloud.",
  "git.getOriginRemote",
  "git.getOpenPrForBranch",
];

/**
 * After the Work page has its session list, this long without a chat history
 * read means no chat is on screen. It covers the download of the chat pane's
 * code on a slow link (about 280 KB compressed).
 */
const NO_CHAT_MS = 4_000;
/** The gate never holds a read longer than this after the first read. */
const HARD_CAP_MS = 12_000;
/** The read that tells the Work page what to show. */
const SESSION_LIST_READ = "work.listSessions";
/** The idle callback's own deadline, so a busy page still opens the gate. */
const IDLE_TIMEOUT_MS = 800;

export function isDeferredBootRead(action: string): boolean {
  return DEFERRED_READS.some((entry) => (entry.endsWith(".") ? action.startsWith(entry) : action === entry));
}

/** True when the page opened on a chat: the Work tab, or a link to a chat or session. */
function opensOnChat(): boolean {
  if (typeof window === "undefined" || !window.location) return false;
  const { pathname, search } = window.location;
  if (pathname === "/work" || pathname.startsWith("/work/")) return true;
  if (pathname === "/open") {
    const type = new URLSearchParams(search).get("type");
    return type === "session" || type === "chat";
  }
  return false;
}

type Gate = {
  open: boolean;
  waiters: Array<() => void>;
  historyStarted: boolean;
  noChatTimer: ReturnType<typeof setTimeout> | null;
  opening: boolean;
};

let gate: Gate | null = null;

function getGate(): Gate {
  if (gate) return gate;
  const active = opensOnChat();
  gate = {
    open: !active,
    waiters: [],
    historyStarted: false,
    noChatTimer: null,
    opening: false,
  };
  if (active) setTimeout(openNow, HARD_CAP_MS);
  return gate;
}

function openNow(): void {
  const current = getGate();
  if (current.open) return;
  current.open = true;
  if (current.noChatTimer) clearTimeout(current.noChatTimer);
  current.noChatTimer = null;
  for (const resolve of current.waiters.splice(0)) resolve();
}

function afterPaintThenIdle(run: () => void): void {
  const idle = () => {
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    } else {
      setTimeout(run, 0);
    }
  };
  // Two frames: React commits the history, and the browser paints it.
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(idle));
  } else {
    idle();
  }
}

function openWhenSettled(): void {
  const current = getGate();
  if (current.open || current.opening) return;
  current.opening = true;
  afterPaintThenIdle(openNow);
}

/**
 * Resolves when `action` may go. Resolves at once for a read the gate does not
 * hold, and for every read once the gate is open.
 */
export function waitForBootPriority(action: string): Promise<void> | null {
  const current = getGate();
  if (current.open || !isDeferredBootRead(action)) return null;
  // The person left the chat (for example, to Home) before it painted: the
  // page they look at now needs these reads, so nothing waits any more.
  if (!opensOnChat()) {
    openNow();
    return null;
  }
  return new Promise<void>((resolve) => current.waiters.push(resolve));
}

/**
 * Resolves when the heavy reads may go: at once on a page that did not open on
 * a chat. For other startup work that must not compete with the chat, such as
 * the download of the other pages' code.
 */
export function whenBootPriorityOpen(): Promise<void> {
  const current = getGate();
  if (current.open) return Promise.resolve();
  return new Promise<void>((resolve) => current.waiters.push(resolve));
}

/**
 * Brackets a read the gate does not hold. When the Work page's session list
 * arrives and no chat has asked for its history, the no-chat timer starts.
 * Returns the end call.
 */
export function noteBootCriticalRead(action: string): () => void {
  const current = getGate();
  if (current.open || action !== SESSION_LIST_READ) return () => {};
  return () => {
    if (current.open || current.historyStarted || current.noChatTimer) return;
    current.noChatTimer = setTimeout(() => {
      current.noChatTimer = null;
      if (!current.historyStarted) openWhenSettled();
    }, NO_CHAT_MS);
  };
}

/** A chat asked for its history: the gate now waits for that read. */
export function noteChatHistoryStarted(): void {
  const current = getGate();
  current.historyStarted = true;
  if (current.noChatTimer) {
    clearTimeout(current.noChatTimer);
    current.noChatTimer = null;
  }
}

/** A chat's history read settled (with an answer or not): open after it paints. */
export function noteChatHistorySettled(): void {
  openWhenSettled();
}
