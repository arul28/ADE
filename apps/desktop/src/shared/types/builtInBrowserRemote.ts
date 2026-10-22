/**
 * The headless-machine → attached-desktop browser handoff.
 *
 * `ade browser open` on a machine running only `ade serve` has no browser to
 * open: the built-in browser is a `WebContentsView` owned by an Electron main
 * process. Rather than failing at the desktop-bridge socket, the daemon emits
 * `built_in_browser_remote_request` on the runtime event stream that pinned
 * desktops already subscribe to, and a desktop holding a remote pin for that
 * lane opens the URL in ITS browser through a port-forward.
 */

export const BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT = "built_in_browser_remote_request" as const;

/** Emitted by the daemon; consumed by every desktop pinned to that machine. */
export type BuiltInBrowserRemoteRequest = {
  requestId: string;
  url: string;
  laneId: string | null;
  chatSessionId: string | null;
  openPanel: boolean;
  requestedAt: string;
  /**
   * The desktop that sent the chat its last message. Only that desktop takes
   * the request; null means any desktop holding a pin on this machine does.
   */
  targetClientId?: string | null;
  /** The tab to navigate, when the agent named one; else the pane's own choice. */
  tabId?: string;
  /** Open in a new tab rather than the one in front. */
  newTab?: boolean;
  /** Reuse a tab this chat already owns. */
  reuseOwnedTab?: boolean;
};

/** Sent back by the desktop that took the request, over the pinned runtime. */
export type BuiltInBrowserRemoteRequestAck = {
  requestId: string;
  /** Absolute machine name of the desktop that opened it. */
  desktopLabel: string;
  accepted: boolean;
  /**
   * The desktop took the request but is waiting on a human.
   *
   * The first agent use of a (machine, port) pair needs a person to approve the
   * port forward, and nobody answers a prompt inside a 5s ack window — so the
   * desktop acks straight away with this set, the requester prints "waiting for
   * approval" and exits 0, and the navigation happens whenever the human gets
   * to it. `accepted` is true because the request WAS taken; only the page has
   * not loaded yet.
   */
  awaitingApproval?: boolean;
  /** Why it was refused (approval denied, no forward), when `accepted` is false. */
  reason?: string | null;
};

/** What `built_in_browser.navigate` returns instead of a status on a headless box. */
export type BuiltInBrowserForwardedToDesktop = {
  status: "forwarded_to_desktop";
  requestId: string;
  url: string;
  acknowledged: boolean;
  /** A desktop took it and is waiting for a human to approve the port. */
  awaitingApproval?: boolean;
  desktopLabel: string | null;
  reason: string | null;
};

export function isBuiltInBrowserForwardedToDesktop(
  value: unknown,
): value is BuiltInBrowserForwardedToDesktop {
  return Boolean(value)
    && typeof value === "object"
    && (value as { status?: unknown }).status === "forwarded_to_desktop";
}

/**
 * A browser command of an agent, run in the browser of the desktop its user
 * sits at.
 *
 * `built_in_browser_remote_request` above only puts a URL on a screen. Once a
 * page is on the user's desktop, every later command (`observe`, `click`,
 * `fill`, `text`, `claim`, …) has to reach that same browser, or the agent
 * reads a browser on its own machine that the user cannot see and that holds
 * none of the user's tabs. The daemon publishes the command on the same
 * runtime event stream; the desktop that sent the chat its last message runs
 * it as that chat and answers with `built_in_browser.replyRemoteCall`.
 */
export const BUILT_IN_BROWSER_REMOTE_CALL_EVENT = "built_in_browser_remote_call" as const;

/**
 * The commands a desktop elsewhere runs on an agent's behalf: every command
 * that acts on one of the chat's tabs.
 *
 * `navigate` and `createTab` are here for the agent's own opens: the page
 * loads in a background tab the chat owns, as it does for a chat on the
 * desktop's own machine. A desktop answers `needs_pane` for an open it cannot
 * do quietly (a loopback URL needs a port forward a person may have to
 * approve), and the daemon then sends it down the request path above, which
 * opens the Browser pane. `showPanel` always takes the request path.
 *
 * The daemon's route table (`BUILT_IN_BROWSER_METHOD_ROUTES`) gives every
 * other bridge method its machine; a method can be sent here only when it is
 * in this list.
 */
export const BUILT_IN_BROWSER_REMOTE_CALL_METHODS = [
  "navigate",
  "createTab",
  "getStatus",
  "requestOriginAccess",
  "claim",
  "startHandoff",
  "waitForHandoff",
  "startSession",
  "listSessions",
  "endSession",
  "switchTab",
  "closeTab",
  "reload",
  "goBack",
  "goForward",
  "stop",
  "observe",
  "getTrace",
  "click",
  "typeText",
  "dispatchKey",
  "scroll",
  "fill",
  "clear",
  "wait",
  "captureScreenshot",
  "setEmulation",
  "setZoom",
  "findInPage",
  "readText",
  "stopFindInPage",
  "setNetworkLogging",
  "getNetworkLog",
  // A download lands on the machine that runs the browser, so those tabs'
  // receipts have to be read there too.
  "listDownloads",
  "waitForDownload",
  // The clipboard belongs to the desktop that hosts the browser, which is the
  // user's computer, not the machine the agent runs on.
  "readClipboard",
  "writeClipboard",
  "paste",
  "hover",
  "drag",
  "selectOption",
  "startInspect",
  "stopInspect",
  "selectPoint",
  "selectCurrent",
  "clearSelection",
  "setDevTools",
] as const;

export type BuiltInBrowserRemoteCallMethod = (typeof BUILT_IN_BROWSER_REMOTE_CALL_METHODS)[number];

const REMOTE_CALL_METHOD_SET = new Set<string>(BUILT_IN_BROWSER_REMOTE_CALL_METHODS);

export function isBuiltInBrowserRemoteCallMethod(value: unknown): value is BuiltInBrowserRemoteCallMethod {
  return typeof value === "string" && REMOTE_CALL_METHOD_SET.has(value);
}

/** Emitted by the daemon; taken only by the desktop it names. */
export type BuiltInBrowserRemoteCall = {
  requestId: string;
  method: BuiltInBrowserRemoteCallMethod;
  /**
   * The command's own arguments. The chat and lane are the daemon's answer to
   * "who is calling"; which project's tabs they mean is the desktop's to say,
   * because the agent's project path is a path on another machine.
   */
  input: Record<string, unknown>;
  chatSessionId: string | null;
  laneId: string | null;
  requestedAt: string;
  /** The desktop that sent the chat its last message. */
  targetClientId: string;
};

/**
 * A file a result points at (an observation's screenshot). The path in the
 * result is a path on the desktop, which the agent cannot read, so the bytes
 * travel with the reply and the daemon writes them where the agent can.
 */
export type BuiltInBrowserRemoteCallFile = {
  /** Where the path sits in the result, e.g. `["observation", "filePath"]`. */
  pointer: string[];
  fileName: string;
  base64: string;
};

/** How long a desktop that took a command has to answer, when the command sets no time of its own. */
const REMOTE_CALL_DONE_TIMEOUT_MS = 60_000;
/** A `wait` or a sign-in handoff runs as long as the agent asked, plus the trip. */
const REMOTE_CALL_DONE_MARGIN_MS = 15_000;
const REMOTE_CALL_DONE_MAX_TIMEOUT_MS = 30 * 60_000;

/**
 * The time a taken command has to finish. The daemon waits this long for the
 * `done` reply, and the desktop's own IPC call gets the same budget, so a long
 * `wait` or a person's sign-in is not cut off on either side.
 */
export function builtInBrowserRemoteCallDoneTimeoutMs(method: string, input: unknown): number {
  const asked = input && typeof input === "object" ? (input as { timeoutMs?: unknown }).timeoutMs : undefined;
  if (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0) {
    return method === "waitForHandoff" ? REMOTE_CALL_DONE_MAX_TIMEOUT_MS : REMOTE_CALL_DONE_TIMEOUT_MS;
  }
  return Math.min(REMOTE_CALL_DONE_MAX_TIMEOUT_MS, Math.max(REMOTE_CALL_DONE_TIMEOUT_MS, asked + REMOTE_CALL_DONE_MARGIN_MS));
}

/** Files one reply may carry (an observation has a screenshot and an element map). */
export const BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILES = 4;

/** One screenshot is ~150 KB; a reply is refused past this so it cannot stall the channel. */
export const BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Sent by the desktop over the pinned runtime, twice: `taken` the moment it
 * accepts the command (so a desktop that is gone is noticed in seconds, not
 * after the command's own timeout), then `done` with the outcome.
 *
 * `clientId` is the replying desktop's own id; the daemon takes a reply only
 * from the desktop it sent the command to. `desktopLabel` is the machine name
 * the desktop's main process reads; the daemon never shows a desktop's word
 * for itself ("This computer") to an agent on another machine.
 */
export type BuiltInBrowserRemoteCallReplyBody =
  | { phase: "taken" }
  | { phase: "done"; desktopLabel?: string; ok: true; result: unknown; files?: BuiltInBrowserRemoteCallFile[] }
  | {
    phase: "done";
    desktopLabel?: string;
    ok: false;
    error: string;
    /** The desktop can only do this open with its Browser pane on screen. */
    code?: "needs_pane";
  };

export type BuiltInBrowserRemoteCallReply = {
  requestId: string;
  clientId: string | null;
} & BuiltInBrowserRemoteCallReplyBody;

/** What this desktop's main process returns for one command it ran for an agent elsewhere. */
export type BuiltInBrowserRemoteAgentCallOutcome =
  | { ok: true; result: unknown; files: BuiltInBrowserRemoteCallFile[]; machineName: string }
  | { ok: false; error: string; machineName: string };

/**
 * Where a command ran, added to object results so the agent can say it in
 * plain words. `userComputer` is the desktop the user sits at; `userElsewhere`
 * is a command that ran on the agent's own machine although the user is not
 * at it, which is why the user cannot see what it did.
 */
export type BuiltInBrowserHostNote = {
  machine: string;
  userComputer: boolean;
  userElsewhere?: boolean;
};
