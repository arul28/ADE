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

export type BuiltInBrowserRemoteRequestEvent = {
  type: typeof BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT;
  request: BuiltInBrowserRemoteRequest;
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
 * The commands a desktop elsewhere runs on an agent's behalf.
 *
 * `navigate` and `createTab` are here for the agent's own opens: the page
 * loads in a background tab the chat owns, as it does for a chat on the
 * desktop's own machine. A desktop answers `needs_pane` for an open it cannot
 * do quietly (a loopback URL needs a port forward a person may have to
 * approve), and the daemon then sends it down the request path above, which
 * opens the Browser pane. `showPanel` always takes the request path.
 *
 * Not here, because their input or output is a file on one machine:
 * `uploadFile`, `exportHar`, `startRecording` / `stopRecording`.
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
  "hover",
  "drag",
  "selectOption",
] as const;

export type BuiltInBrowserRemoteCallMethod = (typeof BUILT_IN_BROWSER_REMOTE_CALL_METHODS)[number];

const REMOTE_CALL_METHOD_SET = new Set<string>(BUILT_IN_BROWSER_REMOTE_CALL_METHODS);

export function isBuiltInBrowserRemoteCallMethod(value: unknown): value is BuiltInBrowserRemoteCallMethod {
  return typeof value === "string" && REMOTE_CALL_METHOD_SET.has(value);
}

/** Commands that read or write a file on the agent's machine, so they stay there. */
export const BUILT_IN_BROWSER_LOCAL_FILE_METHODS: ReadonlySet<string> = new Set([
  "uploadFile",
  "exportHar",
  "startRecording",
  "stopRecording",
]);

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

export type BuiltInBrowserRemoteCallEvent = {
  type: typeof BUILT_IN_BROWSER_REMOTE_CALL_EVENT;
  request: BuiltInBrowserRemoteCall;
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

/** One screenshot is ~150 KB; a reply is refused past this so it cannot stall the channel. */
export const BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Sent by the desktop over the pinned runtime, twice: `taken` the moment it
 * accepts the command (so a desktop that is gone is noticed in seconds, not
 * after the command's own timeout), then `done` with the outcome.
 */
export type BuiltInBrowserRemoteCallReply =
  | { requestId: string; phase: "taken"; desktopLabel: string }
  | {
    requestId: string;
    phase: "done";
    desktopLabel: string;
    ok: true;
    result: unknown;
    files?: BuiltInBrowserRemoteCallFile[];
  }
  | {
    requestId: string;
    phase: "done";
    desktopLabel: string;
    ok: false;
    error: string;
    /** The desktop can only do this open with its Browser pane on screen. */
    code?: "needs_pane";
  };

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
