import type {
  AgentActionTraceEntry,
  AgentDomSnapshot,
  AgentElementSnapshot,
  AgentFrame,
  ComputerUseActionEffect,
} from "./agentObservation";
import { RECORDING_MAX_MS, type DemoArtifactMetadata } from "../demoVideo/demoContract";

export type BuiltInBrowserProvider = "cdp";

/**
 * Windows: an ADE desktop app started as administrator makes its bridge pipe
 * admit administrators only, so the background service (the plain user) is
 * refused. One sentence for the brain's reason, the desktop's log and the
 * app-wide banner.
 */
export const ELEVATED_DESKTOP_TITLE = "ADE is running as administrator";
export const ELEVATED_DESKTOP_MESSAGE =
  "The ADE background service cannot reach it, so agents cannot use the browser, record App Control, or make demo videos. Quit ADE and open it normally.";

export type BuiltInBrowserFrame = AgentFrame;

export type BuiltInBrowserBoundsArgs = BuiltInBrowserFrame & {
  visible: boolean;
  /**
   * How much the pane had to shrink the emulated device to fit, in (0, 1].
   *
   * The fit factor is a fact about the pane's CURRENT size, so it changes on
   * every drag rather than only when a preset is picked — which is why it
   * rides with bounds instead of with the emulation state. Main forwards it as
   * CDP's `scale` on `Emulation.setDeviceMetricsOverride`, so the page still
   * lays out at the device's own width and is drawn smaller, instead of being
   * cropped by a narrower native view.
   */
  scale?: number;
} & BuiltInBrowserProjectScopeArgs;

export type BuiltInBrowserProjectScopeArgs = {
  projectRoot?: string | null;
  /** Keep personal-chat tabs separate without changing the global storage profile. */
  tabCollection?: "personal";
};

export type BuiltInBrowserClaimArgs = BuiltInBrowserProjectScopeArgs & {
  tabId?: string | null;
  laneId?: string | null;
  chatSessionId?: string | null;
  /**
   * Lane this tab belongs to for grouping. Sticky: set once when the tab is
   * opened, never cleared by a later human navigation, and never a lease.
   * Human opens pass this without `laneId` so the tab is grouped but not
   * agent-owned. Agent opens omit it and the service stamps the claim lane.
   */
  groupLaneId?: string | null;
  force?: boolean;
  leaseTtlMs?: number | null;
};

/**
 * Open the tab in its own throwaway sign-in instead of the shared profile: an
 * in-memory cookie jar and storage that nobody else's tabs see, wiped when the
 * last tab using it closes and never restored after a restart. Use it to sign
 * in as a test account without signing the user out. `profile` names the jar
 * so several tabs of one chat can share it ("owner", "viewer"); it implies
 * `isolated`. Without a name the chat gets one jar called "default".
 */
export type BuiltInBrowserIsolationArgs = {
  isolated?: boolean;
  profile?: string | null;
};

export type BuiltInBrowserNavigateArgs = BuiltInBrowserClaimArgs & BuiltInBrowserIsolationArgs & {
  url: string;
  tabId?: string | null;
  newTab?: boolean;
  activate?: boolean;
  reuseOwnedTab?: boolean;
  openPanel?: boolean;
};

export type BuiltInBrowserTabLoadError = {
  /** Chromium's net error code, e.g. -102 for a refused connection. */
  code: number;
  description: string;
  url: string | null;
  /**
   * Set only when the failure was an untrusted certificate the person may
   * choose to trust: a local or private address, and an error a self-signed
   * dev certificate produces. A public host never gets one. Absent on a main
   * process that predates certificate trust.
   */
  certificate?: BuiltInBrowserCertificateProblem | null;
};

/** The certificate a local HTTPS page presented, as the trust prompt names it. */
export type BuiltInBrowserCertificateProblem = {
  /** Lowercase hostname without brackets: `localhost`, `192.168.1.20`, `::1`. */
  host: string;
  port: number;
  /** Chromium's fingerprint, `sha256/<base64>` of the certificate. */
  fingerprint: string;
  /** The same SHA-256 as colon-separated hex, the form `openssl x509 -fingerprint -sha256` prints. */
  fingerprintHex: string;
  /** Chromium's error name, e.g. `net::ERR_CERT_AUTHORITY_INVALID`. */
  error: string;
  subjectName: string | null;
  issuerName: string | null;
  /** When the certificate expires, ISO, or null when it did not say. */
  validUntil: string | null;
};

/** One certificate the person chose to trust in the ADE browser. */
export type BuiltInBrowserTrustedCertificate = BuiltInBrowserCertificateProblem & {
  /** Stable id for revoking this one approval. */
  id: string;
  /** `shared` is the signed-in profile; `isolated` is an agent's throwaway sign-in. */
  profile: "shared" | "isolated";
  /** Saved across restarts (shared profile) or kept in memory only (isolated). */
  remembered: boolean;
  trustedAt: string;
};

export type BuiltInBrowserTrustCertificateArgs = BuiltInBrowserProjectScopeArgs & {
  tabId: string;
  /** The fingerprint the person was shown; a different certificate is refused. */
  fingerprint: string;
};

export type BuiltInBrowserRevokeCertificatesArgs = {
  /** One approval; omitted clears every approval. */
  id?: string | null;
};

export type BuiltInBrowserTrustedCertificatesResult = {
  certificates: BuiltInBrowserTrustedCertificate[];
};

export type BuiltInBrowserTab = {
  id: string;
  url: string | null;
  title: string | null;
  /**
   * The tab was opened with no URL and has not navigated yet, so it is sitting
   * on `about:blank` as a launchpad. Surfaces render their own empty state
   * (recent origins, detected dev servers) instead of a blank page, and the
   * title reads "New tab" rather than the empty document title.
   */
  isLaunchpad: boolean;
  /**
   * Why the current page failed to load (connection refused, DNS, timeout), or
   * null. Chromium shows such a page as plain white, so the Work tab's floating
   * preview hides while it is set. Cleared when the tab starts loading again.
   * Absent on a main process that predates it, which reads as null.
   */
  loadError?: BuiltInBrowserTabLoadError | null;
  /**
   * The isolated profile this tab signs in with, or null for the shared
   * profile. Fixed for the tab's life. Absent on a main process that predates
   * isolated tabs, which reads as null.
   */
  isolatedProfile?: string | null;
  /**
   * Best favicon Chromium reported for the current document: the first http(s)
   * URL, or a `data:` icon under 32 KB. Cleared the moment the tab navigates to
   * a different origin so a stale icon never labels the new page. Main never
   * fetches it — the renderer points an `<img>` at whatever is here.
   */
  faviconUrl: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * Lane group for the tab strip. Distinct from the agent lease: a tab a
   * person opened in a chat is grouped with that lane and still has no owner.
   * Absent on a main process that predates grouping.
   */
  groupLaneId?: string | null;
  ownerLaneId: string | null;
  ownerChatSessionId: string | null;
  /** When the current owner first took the tab. Survives lease renewals. */
  ownerClaimedAt: string | null;
  /** Last time the owner touched the tab (read or action). */
  ownerLastActiveAt: string | null;
  ownerLeaseExpiresAt: string | null;
  /**
   * Who created the tab. `human` is the person (or a restored tab);
   * `chat` is an agent call, which also names the chat and lane.
   */
  openedBy: "human" | "chat";
  openedByChatSessionId: string | null;
  openedByLaneId: string | null;
  /** When the tab was created. */
  createdAt: string;
  zoomFactor: number;
  devToolsOpen: boolean;
  emulation: BuiltInBrowserEmulationState | null;
  /**
   * The fixed page size a recording tab is laid out at
   * (`BUILT_IN_BROWSER_RECORDING_VIEWPORT`), or null when the tab follows its box.
   * The wire name predates recording-only use and stays for compatibility.
   * The pane letterboxes it exactly like a device preset. Absent on a main
   * process that predates it, which reads as null.
   */
  agentViewport?: { width: number; height: number } | null;
  networkLogging: boolean;
  recording: BuiltInBrowserRecordingStatus | null;
  /**
   * Non-null while a human holds this tab because an agent asked them to sign
   * in (or clear a CAPTCHA / HTTP auth / client-cert prompt) for it. Surfaces
   * feature-detect this field: when it is set the tab is human-owned, every
   * agent action on it fails with `handoff_active`, and the header owner text
   * reads "you own this tab".
   */
  handoff: BuiltInBrowserTabHandoff | null;
  /**
   * Present only on an identity-scoped read (`ade browser status` from an
   * agent): the tab has no owner, so it is visible but not yet drivable. The
   * agent has to `claim` it first. Tabs owned by a *different* chat stay hidden
   * entirely — this field never means "someone else's tab".
   */
  claimable?: true;
};

/** Why a login handoff ended — carried on the `handoff-end` trace entry. */
export type BuiltInBrowserHandoffEndedBy = "human" | "auto-offer" | "tab-closed" | "timeout";

export type BuiltInBrowserTabHandoff = {
  /** Human-readable justification the agent supplied, e.g. "sign in to staging". */
  reason: string;
  startedAt: string;
  /** When the service auto-hands the tab back if the human never does. */
  expiresAt: string;
  requestedByChatSessionId: string | null;
  requestedByLaneId: string | null;
  /**
   * Origin the tab was on when the handoff started. The renderer offers
   * "Signed in? Hand back now" as soon as the tab leaves it.
   */
  startedAtOrigin: string | null;
  /** The lease to re-issue on hand-back. */
  previousOwner: {
    laneId: string | null;
    chatSessionId: string | null;
  };
};

export type BuiltInBrowserStartHandoffArgs = BuiltInBrowserTabTargetArgs & {
  /** Required. Shown in the amber bar, the push body, and the trace entry. */
  reason: string;
  /** Auto hand-back deadline. Defaults to 15 minutes; clamped to 1 min–2 h. */
  timeoutMs?: number | null;
};

export type BuiltInBrowserEndHandoffArgs = BuiltInBrowserTabTargetArgs & {
  /** Defaults to `"human"`. Only the service itself passes the other values. */
  endedBy?: BuiltInBrowserHandoffEndedBy | null;
};

export type BuiltInBrowserWaitForHandoffArgs = BuiltInBrowserTabTargetArgs & {
  /** How long to block. Defaults to the tab's remaining handoff window. */
  timeoutMs?: number | null;
};

export type BuiltInBrowserHandoffResult = {
  tabId: string;
  handoff: BuiltInBrowserTabHandoff | null;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserHandoffWaitResult = {
  tabId: string;
  /** False when the wait itself timed out while the handoff was still open. */
  ended: boolean;
  endedBy: BuiltInBrowserHandoffEndedBy | null;
  durationMs: number | null;
  handoff: BuiltInBrowserTabHandoff | null;
};

/**
 * Error code every agent-facing browser action returns while a login handoff is
 * open on the target tab. Typed rather than a bare message so an agent can
 * branch on it instead of pattern-matching prose.
 */
export const BUILT_IN_BROWSER_HANDOFF_ACTIVE_CODE = "handoff_active";

/**
 * Error-message prefixes for an agent call that needs the human's OK to use the
 * ADE browser. `pending`: the prompt is open and nobody has answered inside one
 * call's budget; the same call run again joins the same prompt, so the CLI
 * keeps re-running it for up to {@link BUILT_IN_BROWSER_APPROVAL_WAIT_MS}.
 * `blocked`: the human pressed Block.
 *
 * Match these as substrings: an older desktop said `origin_approval_pending:`,
 * which still contains `approval_pending:`, so a newer CLI keeps waiting on it.
 */
export const BUILT_IN_BROWSER_APPROVAL_PENDING_CODE = "approval_pending";
export const BUILT_IN_BROWSER_APPROVAL_BLOCKED_CODE = "approval_blocked";
/** How long one agent command waits in total for a human to answer the prompt. */
export const BUILT_IN_BROWSER_APPROVAL_WAIT_MS = 2 * 60_000;
/**
 * How long ONE desktop call waits for the answer before it says "pending".
 * Well under the daemon's 30 s bridge budget, so the bridge keeps its own
 * liveness timeout and still never reports a timeout for a waiting human.
 */
export const BUILT_IN_BROWSER_APPROVAL_CALL_BUDGET_MS = 15_000;

/**
 * What an `approval_pending: …` message is waiting for, as a phrase that reads
 * after "waiting for the user to" (e.g. "allow this chat to use the ADE
 * browser"), or null for any other error.
 */
export function parseBuiltInBrowserApprovalPending(message: string): { waitingFor: string } | null {
  const index = message.indexOf(`${BUILT_IN_BROWSER_APPROVAL_PENDING_CODE}:`);
  if (index < 0) return null;
  const tail = message.slice(index);
  const current = /waiting for the user to (allow this (?:chat|lane) to use the ADE browser)/.exec(tail);
  if (current) return { waitingFor: current[1]! };
  // An older desktop's per-site prompt.
  const legacy = /approve (\S+) in ADE/.exec(tail);
  return { waitingFor: legacy ? `approve ${legacy[1]} in ADE` : "answer the ADE browser prompt" };
}

/**
 * Who may drive the ADE browser without asking. Machine-wide: the browser's
 * signed-in profile is one per ADE install, so the answer is too.
 *
 * - `all`: every agent in every lane. The default; nothing is ever asked.
 * - `lanes`: agents in a lane the user allowed. Asked once per lane.
 * - `chats`: chats the user allowed. Asked once per chat.
 */
export type BuiltInBrowserAgentAccessMode = "all" | "lanes" | "chats";
export const BUILT_IN_BROWSER_AGENT_ACCESS_MODES: readonly BuiltInBrowserAgentAccessMode[] = ["all", "lanes", "chats"];
export const BUILT_IN_BROWSER_AGENT_ACCESS_DEFAULT_MODE: BuiltInBrowserAgentAccessMode = "all";

export function normalizeBuiltInBrowserAgentAccessMode(value: unknown): BuiltInBrowserAgentAccessMode {
  return value === "lanes" || value === "chats" || value === "all"
    ? value
    : BUILT_IN_BROWSER_AGENT_ACCESS_DEFAULT_MODE;
}

/** A lane the user allowed. Keyed by project + lane; the names are for display. */
export type BuiltInBrowserAgentLaneGrant = {
  projectRoot: string | null;
  laneId: string;
  laneName: string | null;
  grantedAt: string;
};

/** A chat the user allowed. The names are for display. */
export type BuiltInBrowserAgentChatGrant = {
  chatSessionId: string;
  chatTitle: string | null;
  laneName: string | null;
  grantedAt: string;
};

/** One open "may this agent use the ADE browser?" question. */
export type BuiltInBrowserAgentAccessPrompt = {
  id: string;
  chatSessionId: string | null;
  chatTitle: string | null;
  laneId: string | null;
  laneName: string | null;
  projectRoot: string | null;
  /** The answers this caller can be given: a lane-less chat has no lane to allow, a chat-less shell no chat. */
  canAllowLane: boolean;
  canAllowChat: boolean;
  requestedAt: string;
};

export type BuiltInBrowserAgentAccessAnswer = "all" | "lane" | "chat" | "block";

export type BuiltInBrowserAgentAccessSnapshot = {
  /**
   * The master switch: may agents drive the ADE browser at all. On by default.
   * Off means every agent call is refused outright, whatever `mode` says; the
   * person's own use of the Browser pane is unaffected.
   */
  enabled: boolean;
  mode: BuiltInBrowserAgentAccessMode;
  laneGrants: BuiltInBrowserAgentLaneGrant[];
  chatGrants: BuiltInBrowserAgentChatGrant[];
  /** Oldest first. The renderer shows the first. */
  prompts: BuiltInBrowserAgentAccessPrompt[];
};

/** The user turned agents off entirely in Settings. Retrying cannot help. */
export const BUILT_IN_BROWSER_AGENTS_DISABLED_CODE = "built_in_browser_agents_disabled";

export type BuiltInBrowserAgentAccessRevokeArgs =
  | { kind: "lane"; projectRoot: string | null; laneId: string }
  | { kind: "chat"; chatSessionId: string }
  | { kind: "all" };

/* ── Clipboard ────────────────────────────────────────────────────────────── */

export type BuiltInBrowserClipboardReadArgs = BuiltInBrowserTabTargetArgs;

/**
 * An image that was on the clipboard, written to a scratch file.
 *
 * The bytes never travel in the answer: an agent gets a path it can read or
 * attach, plus the facts it needs to decide what to do with it.
 */
export type BuiltInBrowserClipboardImage = {
  /** Named `filePath` so the remote bridge packs it with the result. */
  filePath: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: "image/png";
};

export type BuiltInBrowserClipboardReadResult = {
  /** The clipboard's plain text, capped at 64k characters. */
  text: string;
  /** The HTML flavor, when the source app put one there. Capped the same way. */
  html: string | null;
  /** The image flavor, when the clipboard held one. */
  image: BuiltInBrowserClipboardImage | null;
  /** True when a text flavor was longer than the cap and had to be cut. */
  truncated: boolean;
};

export type BuiltInBrowserClipboardWriteArgs = BuiltInBrowserTabTargetArgs & {
  text?: string | null;
  html?: string | null;
  /** An image file to put on the clipboard. Absolute path to a readable file. */
  imagePath?: string | null;
};

export type BuiltInBrowserClipboardWriteResult = {
  written: boolean;
};

/**
 * Paste what is on the machine's clipboard into the focused element.
 *
 * `type` uses `Input.insertText`, which bypasses the page's own paste handler;
 * this sends the real edit command, so a rich-text editor (or a page that reads
 * `clipboardData`) sees a paste the way a person's ⌘V would.
 */
export type BuiltInBrowserPasteArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs;

/* ── Downloads ────────────────────────────────────────────────────────────── */

/** One file a page downloaded through the ADE browser. */
export type BuiltInBrowserDownload = {
  id: string;
  tabId: string;
  /** Who held the tab when the download started, so a closed tab keeps its scope. */
  ownerChatSessionId?: string | null;
  ownerLaneId?: string | null;
  fileName: string;
  /** Absolute path the file was saved to. */
  savePath: string;
  url: string | null;
  state: "started" | "completed" | "cancelled" | "interrupted";
  startedAt: string;
  endedAt: string | null;
};

export type BuiltInBrowserListDownloadsArgs = BuiltInBrowserTabTargetArgs & {
  /** Newest first. Defaults to 20, capped at 100. */
  limit?: number | null;
};

export type BuiltInBrowserDownloadsResult = {
  downloads: BuiltInBrowserDownload[];
};

export type BuiltInBrowserWaitForDownloadArgs = BuiltInBrowserTabTargetArgs & {
  /** How long to wait for a completion. Defaults to 60s, capped at 120s. */
  timeoutMs?: number | null;
};

export type BuiltInBrowserWaitForDownloadResult = {
  /** The completed download, or null when the wait timed out. */
  download: BuiltInBrowserDownload | null;
  timedOut: boolean;
  /** Newest first, so a caller that timed out can say what did happen. */
  downloads: BuiltInBrowserDownload[];
};

export type BuiltInBrowserSession = {
  id: string;
  tabId: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  ownerLaneId: string | null;
  ownerChatSessionId: string | null;
  lastObservationId: string | null;
  lastTraceEntryId: string | null;
};

/**
 * Default for `BuiltInBrowserSettings.tabLimit`.
 *
 * The live limit is the setting; this is only what an unset machine gets, and
 * what the fallback statuses report before the setting has been read.
 */
export const BUILT_IN_BROWSER_TAB_LIMIT_DEFAULT = 10;
export const BUILT_IN_BROWSER_TAB_LIMIT_MIN = 1;
export const BUILT_IN_BROWSER_TAB_LIMIT_MAX = 50;

/** Machine-wide browser settings: one browser profile, one set of answers. */
export type BuiltInBrowserAutoGrant = {
  camera: boolean;
  microphone: boolean;
  geolocation: boolean;
};

export type BuiltInBrowserSettings = {
  /** Tabs per collection, clamped to the min/max above. */
  tabLimit: number;
  /** Where downloads go; null means the OS Downloads folder. */
  downloadDir: string | null;
  /** Standing permission grants for agent use. All off by default. */
  autoGrant: BuiltInBrowserAutoGrant;
  /** What the address bar searches with when the text is not a URL. */
  searchEngine: BuiltInBrowserSearchEngineId;
  /**
   * The Custom engine's URL, `%s` where the query goes. Kept when another
   * engine is picked so switching back restores it. Null when never set.
   */
  customSearchUrl: string | null;
};

/** What is on disk: every field optional, older files predate some of them. */
export type BuiltInBrowserSettingsPersisted = {
  tabLimit?: number;
  downloadDir?: string | null;
  autoGrant?: Partial<BuiltInBrowserAutoGrant>;
  searchEngine?: string;
  customSearchUrl?: string | null;
};

export type BuiltInBrowserSettingsPatch = {
  tabLimit?: number;
  downloadDir?: string | null;
  autoGrant?: Partial<BuiltInBrowserAutoGrant>;
  searchEngine?: BuiltInBrowserSearchEngineId;
  customSearchUrl?: string | null;
};

/**
 * Address bar search engines. Google stays the default because it is what the
 * address bar always searched with.
 */
export const BUILT_IN_BROWSER_SEARCH_ENGINES = [
  { id: "google", label: "Google", template: "https://www.google.com/search?q=%s" },
  { id: "duckduckgo", label: "DuckDuckGo", template: "https://duckduckgo.com/?q=%s" },
  { id: "bing", label: "Bing", template: "https://www.bing.com/search?q=%s" },
  { id: "brave", label: "Brave Search", template: "https://search.brave.com/search?q=%s" },
  { id: "kagi", label: "Kagi", template: "https://kagi.com/search?q=%s" },
  { id: "ecosia", label: "Ecosia", template: "https://www.ecosia.org/search?q=%s" },
] as const;

export type BuiltInBrowserSearchEngineId = (typeof BUILT_IN_BROWSER_SEARCH_ENGINES)[number]["id"] | "custom";

export const BUILT_IN_BROWSER_DEFAULT_SEARCH_ENGINE = "google" satisfies BuiltInBrowserSearchEngineId;
/** Long enough for any real search URL; a pasted page of text is not one. */
export const BUILT_IN_BROWSER_CUSTOM_SEARCH_URL_MAX = 2_048;

function isBuiltInBrowserSearchEngineId(value: unknown): value is BuiltInBrowserSearchEngineId {
  return value === "custom" || BUILT_IN_BROWSER_SEARCH_ENGINES.some((engine) => engine.id === value);
}

/**
 * Whether a custom search URL can be used: an http(s) URL with `%s` after the
 * host, so the query can only ever land in the path, query or fragment.
 *
 * Checked by substituting two different words and comparing the results: the
 * host, port and credentials must not change (a `%s` there would let the
 * typed text pick the server), and the URL must change (a `%s` that vanished
 * while parsing is no placeholder at all).
 */
export function isValidBrowserSearchTemplate(value: string | null | undefined): boolean {
  const template = (value ?? "").trim();
  if (!template || template.length > BUILT_IN_BROWSER_CUSTOM_SEARCH_URL_MAX || !template.includes("%s")) return false;
  try {
    const first = new URL(template.replaceAll("%s", "adeprobeone"));
    const second = new URL(template.replaceAll("%s", "adeprobetwo"));
    if (first.protocol !== "https:" && first.protocol !== "http:") return false;
    if (first.host !== second.host || !first.hostname) return false;
    if (first.username !== second.username || first.password !== second.password) return false;
    // `%s` inside the credentials changes nothing above when both words are
    // swallowed the same way, so reject any credentials outright.
    if (first.username || first.password) return false;
    return first.href !== second.href;
  } catch {
    return false;
  }
}

/**
 * The template the address bar should use, and whether a Custom engine fell
 * back to the default because its URL cannot be used.
 */
export function resolveBrowserSearchTemplate(
  settings: Pick<BuiltInBrowserSettings, "searchEngine" | "customSearchUrl"> | null | undefined,
): { template: string; customInvalid: boolean } {
  const fallback = BUILT_IN_BROWSER_SEARCH_ENGINES[0].template;
  if (!settings) return { template: fallback, customInvalid: false };
  if (settings.searchEngine === "custom") {
    const custom = (settings.customSearchUrl ?? "").trim();
    return isValidBrowserSearchTemplate(custom)
      ? { template: custom, customInvalid: false }
      : { template: fallback, customInvalid: true };
  }
  const preset = BUILT_IN_BROWSER_SEARCH_ENGINES.find((engine) => engine.id === settings.searchEngine);
  return { template: preset?.template ?? fallback, customInvalid: false };
}

/** A search URL for typed words. The template must already be resolved. */
export function browserSearchUrl(template: string, query: string): string {
  return template.replaceAll("%s", encodeURIComponent(query));
}

export const BUILT_IN_BROWSER_SETTINGS_DEFAULTS: BuiltInBrowserSettings = {
  tabLimit: BUILT_IN_BROWSER_TAB_LIMIT_DEFAULT,
  downloadDir: null,
  autoGrant: { camera: false, microphone: false, geolocation: false },
  searchEngine: BUILT_IN_BROWSER_DEFAULT_SEARCH_ENGINE,
  customSearchUrl: null,
};

export function normalizeBuiltInBrowserSettings(value: unknown): BuiltInBrowserSettings {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawLimit = typeof record.tabLimit === "number" && Number.isFinite(record.tabLimit)
    ? Math.trunc(record.tabLimit)
    : BUILT_IN_BROWSER_SETTINGS_DEFAULTS.tabLimit;
  const rawDir = typeof record.downloadDir === "string" && record.downloadDir.trim()
    ? record.downloadDir.trim()
    : null;
  const grantRecord = record.autoGrant && typeof record.autoGrant === "object"
    ? record.autoGrant as Record<string, unknown>
    : {};
  const rawCustom = typeof record.customSearchUrl === "string" && record.customSearchUrl.trim()
    ? record.customSearchUrl.trim().slice(0, BUILT_IN_BROWSER_CUSTOM_SEARCH_URL_MAX)
    : null;
  return {
    tabLimit: Math.min(BUILT_IN_BROWSER_TAB_LIMIT_MAX, Math.max(BUILT_IN_BROWSER_TAB_LIMIT_MIN, rawLimit)),
    downloadDir: rawDir,
    autoGrant: {
      camera: grantRecord.camera === true,
      microphone: grantRecord.microphone === true,
      geolocation: grantRecord.geolocation === true,
    },
    // An engine a newer build added, read by an older one, is Google again.
    searchEngine: isBuiltInBrowserSearchEngineId(record.searchEngine)
      ? record.searchEngine
      : BUILT_IN_BROWSER_DEFAULT_SEARCH_ENGINE,
    customSearchUrl: rawCustom,
  };
}

/** One merge rule for the controller, the renderer mock and any other writer. */
export function applyBuiltInBrowserSettingsPatch(
  current: BuiltInBrowserSettings,
  patch: BuiltInBrowserSettingsPatch,
): BuiltInBrowserSettings {
  return normalizeBuiltInBrowserSettings({
    tabLimit: patch.tabLimit ?? current.tabLimit,
    downloadDir: patch.downloadDir === undefined ? current.downloadDir : patch.downloadDir,
    autoGrant: { ...current.autoGrant, ...(patch.autoGrant ?? {}) },
    searchEngine: patch.searchEngine ?? current.searchEngine,
    customSearchUrl: patch.customSearchUrl === undefined ? current.customSearchUrl : patch.customSearchUrl,
  });
}

/**
 * Validate a patch from the renderer. Throws on a malformed field rather than
 * dropping it: a silently ignored `autoGrant` looked like a saved switch.
 */
export function parseBuiltInBrowserSettingsPatch(value: unknown): BuiltInBrowserSettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser settings must be an object.");
  }
  const record = value as Record<string, unknown>;
  const patch: BuiltInBrowserSettingsPatch = {};
  if ("tabLimit" in record) {
    if (typeof record.tabLimit !== "number" || !Number.isFinite(record.tabLimit)) {
      throw new Error("Browser settings: tabLimit must be a number.");
    }
    patch.tabLimit = record.tabLimit;
  }
  if ("downloadDir" in record) {
    if (record.downloadDir !== null && typeof record.downloadDir !== "string") {
      throw new Error("Browser settings: downloadDir must be a string or null.");
    }
    patch.downloadDir = record.downloadDir as string | null;
  }
  if ("autoGrant" in record) {
    if (!record.autoGrant || typeof record.autoGrant !== "object" || Array.isArray(record.autoGrant)) {
      throw new Error("Browser settings: autoGrant must be an object.");
    }
    const grantRecord = record.autoGrant as Record<string, unknown>;
    const grant: Partial<BuiltInBrowserAutoGrant> = {};
    for (const key of ["camera", "microphone", "geolocation"] as const) {
      if (!(key in grantRecord)) continue;
      if (typeof grantRecord[key] !== "boolean") {
        throw new Error(`Browser settings: autoGrant.${key} must be a boolean.`);
      }
      grant[key] = grantRecord[key] as boolean;
    }
    patch.autoGrant = grant;
  }
  if ("searchEngine" in record) {
    if (!isBuiltInBrowserSearchEngineId(record.searchEngine)) {
      throw new Error("Browser settings: searchEngine is not a known search engine.");
    }
    patch.searchEngine = record.searchEngine;
  }
  if ("customSearchUrl" in record) {
    if (record.customSearchUrl !== null && typeof record.customSearchUrl !== "string") {
      throw new Error("Browser settings: customSearchUrl must be a string or null.");
    }
    if (typeof record.customSearchUrl === "string" && record.customSearchUrl.length > BUILT_IN_BROWSER_CUSTOM_SEARCH_URL_MAX) {
      throw new Error(`Browser settings: customSearchUrl is longer than ${BUILT_IN_BROWSER_CUSTOM_SEARCH_URL_MAX} characters.`);
    }
    // Saved even when it cannot be used yet: the row says so, and searches
    // use the default until it is fixed. Refusing the save would throw away
    // a URL the person is halfway through typing.
    patch.customSearchUrl = record.customSearchUrl as string | null;
  }
  return patch;
}

export type BuiltInBrowserStatus = {
  attached: boolean;
  partition: string;
  storageProfileKey: "global";
  collectionKey: string;
  collectionProjectRoot: string | null;
  persistentProfile: true;
  visible: boolean;
  bounds: BuiltInBrowserFrame;
  activeTabId: string | null;
  tabs: BuiltInBrowserTab[];
  /**
   * Live tabs in this collection, including ones another chat owns.
   *
   * `tabs` is scoped to the caller; this is the collection's real occupancy, so
   * an agent can tell it is one tab from the limit without asking for tabs it
   * may not see.
   */
  tabCount: number;
  /** The per-collection tab limit. */
  tabLimit: number;
  url: string | null;
  title: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isInspecting: boolean;
  hasSelection: boolean;
  ownerLaneId: string | null;
  ownerChatSessionId: string | null;
  ownerClaimedAt: string | null;
  ownerLastActiveAt: string | null;
  ownerLeaseExpiresAt: string | null;
  /**
   * Chats driving this collection's browser right now.
   *
   * Present on a `getStatus` read so a surface that mounts mid-flight has an
   * answer immediately; after that the `agent-presence` event keeps it current.
   * Optional because most status objects are built by callers that know nothing
   * about presence (the web client's stub, test fixtures), and for them
   * "nobody is browsing" is the right reading of an absent field.
   */
  agentPresence?: BuiltInBrowserAgentPresence[];
  /**
   * The tab an `open`/`navigate` or `new-tab` call drove. Set only on those
   * calls' answers: an agent's open does not take the human's focus, so the
   * active tab is usually not the one it just opened.
   */
  targetTabId?: string | null;
  /** True when that call created the tab rather than navigating an existing one. */
  targetTabCreated?: boolean;
};

export type BuiltInBrowserPermissionDecision = {
  permission: string;
  origin: string;
  embeddingOrigin: string | null;
  decision: "allow" | "block";
  updatedAt: string;
};

export type BuiltInBrowserPermissionsResult = {
  permissions: BuiltInBrowserPermissionDecision[];
};

export type BuiltInBrowserClearPermissionsArgs = {
  origin?: string | null;
  permission?: string | null;
};

export type BuiltInBrowserClearPermissionsResult = BuiltInBrowserPermissionsResult & {
  removed: number;
};

export type BuiltInBrowserProfileDiagnostics = {
  partition: string;
  storageProfileKey: "global";
  persistentProfile: true;
  cookieCount: number;
  persistentCookieCount: number;
  sessionCookieCount: number;
  cookieDomains: string[];
  cacheSizeBytes: number | null;
  persistedPermissionDecisionCount: number;
  tabRestorationEnabled: boolean;
  lastStorageFlushAt: string | null;
};

export type BuiltInBrowserElementTargetArgs = {
  selector?: string | null;
  text?: string | null;
  testId?: string | null;
  elementIndex?: number | null;
  handle?: string | null;
};

export type BuiltInBrowserTabArgs = BuiltInBrowserClaimArgs & {
  tabId: string;
  openPanel?: boolean;
};

export type BuiltInBrowserTabTargetArgs = BuiltInBrowserProjectScopeArgs & {
  tabId?: string | null;
  sessionId?: string | null;
  laneId?: string | null;
  chatSessionId?: string | null;
  force?: boolean;
  leaseTtlMs?: number | null;
  /**
   * Set by the runtime for an outside AI app (ADE's remote MCP runner), which
   * carries no chat or lane. The agent-access gate uses it so the master switch
   * still applies; a person's pane or terminal never sets it.
   */
  agentCaller?: boolean;
};

export type BuiltInBrowserStartSessionArgs = BuiltInBrowserClaimArgs;

export type BuiltInBrowserRequestOriginAccessArgs = BuiltInBrowserTabTargetArgs;

export type BuiltInBrowserOriginAccessResult = {
  origin: string | null;
  required: boolean;
  granted: boolean;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserEndSessionArgs = BuiltInBrowserClaimArgs & {
  sessionId: string;
};

export type BuiltInBrowserListSessionsArgs = BuiltInBrowserTabTargetArgs & {
  tabId?: string | null;
  includeEnded?: boolean;
};

export type BuiltInBrowserSessionResult = {
  session: BuiltInBrowserSession;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserSessionsResult = {
  sessions: BuiltInBrowserSession[];
};

export type BuiltInBrowserCreateTabArgs = BuiltInBrowserClaimArgs & BuiltInBrowserIsolationArgs & {
  url?: string | null;
  activate?: boolean;
  openPanel?: boolean;
};

export type BuiltInBrowserOpenPanelArgs = BuiltInBrowserClaimArgs & {
  url?: string | null;
  tabId?: string | null;
};

export type BuiltInBrowserSelectPointArgs = BuiltInBrowserTabTargetArgs & {
  x: number;
  y: number;
  includeScreenshot?: boolean;
};

export type BuiltInBrowserObservationArgs = BuiltInBrowserTabTargetArgs & {
  keepCount?: number | null;
  includeDataUrl?: boolean;
  includeDom?: boolean;
  includeElementMap?: boolean;
  includeDiagnostics?: boolean;
  maxElements?: number | null;
  /**
   * Fail the observation when no screenshot can be captured. Off by default:
   * an observation of a tab whose pixels are unavailable (host window
   * minimised, no host window) still returns its DOM, with `filePath: null`
   * and `screenshotUnavailable` naming why. Proof sets it, because proof
   * without pixels is not proof.
   */
  requireScreenshot?: boolean;
};

export type BuiltInBrowserObservationCleanup = {
  keepCount: number;
  keptCount: number;
  deletedCount: number;
};

export type BuiltInBrowserObservation = {
  id: string;
  tabId: string;
  sessionId: string | null;
  url: string | null;
  title: string | null;
  capturedAt: string;
  /** Null, with `filePath`/`mimeType`, when the screenshot was unavailable. */
  width: number | null;
  height: number | null;
  mimeType: string | null;
  filePath: string | null;
  relativePath: string | null;
  /** Why there is no image, when there is none: "Browser screenshot is unavailable for tab …". */
  screenshotUnavailable?: string;
  /**
   * For the agent, when the page is narrow because the person's pane is: why a
   * site may be in its mobile layout, and the command for a desktop one.
   */
  narrowPageHint?: string;
  dataUrl?: string;
  dom?: BuiltInBrowserDomSnapshot | null;
  elementMap?: BuiltInBrowserObservationElementMap | null;
  diagnostics?: BuiltInBrowserDiagnostics | null;
  ownerLaneId: string | null;
  ownerChatSessionId: string | null;
  cleanup: BuiltInBrowserObservationCleanup;
};

export type BuiltInBrowserAgentActionArgs = BuiltInBrowserObservationArgs & {
  observe?: boolean;
  waitAfterMs?: number | null;
  laneId?: string | null;
  chatSessionId?: string | null;
  force?: boolean;
  leaseTtlMs?: number | null;
};

export type BuiltInBrowserClickArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  x?: number | null;
  y?: number | null;
  button?: "left" | "middle" | "right";
  clickCount?: number | null;
};

export type BuiltInBrowserTypeTextArgs = BuiltInBrowserAgentActionArgs & {
  text: string;
};

export type BuiltInBrowserDispatchKeyArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  key: string;
};

export type BuiltInBrowserScrollArgs = BuiltInBrowserAgentActionArgs & {
  x?: number | null;
  y?: number | null;
  deltaX?: number | null;
  deltaY?: number | null;
};

export type BuiltInBrowserFillArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  /**
   * Value to insert. Kept optional because older callers used `text` for the
   * fill payload when the element target was selected by selector/test id/handle.
   */
  value?: string | null;
};

export type BuiltInBrowserClearArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs;

export type BuiltInBrowserWaitArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  url?: string | null;
  loadState?: "domcontentloaded" | "load" | "network-idle";
  timeoutMs?: number | null;
  networkIdleMs?: number | null;
};

export type BuiltInBrowserTraceArgs = BuiltInBrowserTabTargetArgs & {
  limit?: number | null;
};

export type BuiltInBrowserAgentActionResult = {
  ok: true;
  observation: BuiltInBrowserObservation | null;
  status: BuiltInBrowserStatus;
  trace: BuiltInBrowserActionTraceEntry | null;
  session: BuiltInBrowserSession | null;
  /**
   * The element the target resolved to, or null when the action went to a
   * point or to whatever had focus. Read before the input was sent.
   */
  resolved: BuiltInBrowserElementSnapshot | null;
  /** Whether anything visibly changed between the state before the input and the post-action observation. */
  effect: ComputerUseActionEffect;
};

export type BuiltInBrowserElementSnapshot = AgentElementSnapshot;

export type BuiltInBrowserObservationElementMap = {
  filePath: string;
  relativePath: string | null;
  width: number;
  height: number;
  mimeType: string;
  elementCount: number;
  dataUrl?: string;
};

export type BuiltInBrowserDomSnapshot = AgentDomSnapshot;

export type BuiltInBrowserConsoleDiagnostic = {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  sourceId: string | null;
  line: number | null;
  column: number | null;
  timestamp: string;
};

export type BuiltInBrowserNetworkDiagnostic = {
  url: string;
  method: string | null;
  resourceType: string | null;
  statusCode: number | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string;
  durationMs: number | null;
};

export type BuiltInBrowserDiagnostics = {
  capturedAt: string;
  pendingRequestCount: number;
  console: BuiltInBrowserConsoleDiagnostic[];
  network: BuiltInBrowserNetworkDiagnostic[];
  /** Present only while full network logging is enabled for the tab. */
  networkLog?: BuiltInBrowserObservationNetworkLog | null;
};

export type BuiltInBrowserObservationNetworkLog = {
  enabled: true;
  recordedCount: number;
  droppedCount: number;
  recent: BuiltInBrowserNetworkLogEntry[];
};

export type BuiltInBrowserActionTraceEntry = AgentActionTraceEntry & { tabId: string };

export type BuiltInBrowserTraceResult = {
  tabId: string;
  sessionId: string | null;
  entries: BuiltInBrowserActionTraceEntry[];
};

export type BuiltInBrowserScreenshot = {
  capturedAt: string;
  width: number;
  height: number;
  dataUrl: string;
};

/**
 * What the trusted renderer gets back from a screenshot request.
 *
 * "There is no tab" is an ordinary state of the browser pane, not a failure:
 * a card polling a browser whose last tab was just closed would otherwise turn
 * a normal race into a thrown IPC error on every tick. Agents still get the
 * throw — for them a screenshot of nothing IS a failed request.
 *
 * `"unavailable"` is the same idea one step later: the tab exists, but its view
 * has no compositor surface to photograph — it is parked, hidden, or being torn
 * down. The panel asks for exactly this frame on the way out of every popover
 * and every tool switch, so it is a race it loses routinely and recovers from
 * by keeping its last frame.
 */
export type BuiltInBrowserScreenshotResult =
  | ({ ok: true } & BuiltInBrowserScreenshot)
  | { ok: false; reason: "no_tab" | "unavailable" };

export type BuiltInBrowserContextItem = {
  kind: "built_in_browser_element" | "built_in_browser_capture";
  id: string;
  provider: BuiltInBrowserProvider;
  componentId: string;
  url: string | null;
  title: string | null;
  sourceFile: string | null;
  sourceLine: number | null;
  frame: BuiltInBrowserFrame;
  pixelFrame: BuiltInBrowserFrame;
  metadata: Record<string, unknown>;
  screenshotDataUrl: string | null;
  selectedAt: string;
};

export type BuiltInBrowserSelectResult = {
  item: BuiltInBrowserContextItem | null;
};

export type BuiltInBrowserEventPayload =
  | { type: "status"; status: BuiltInBrowserStatus }
  | {
      type: "open-request";
      status: BuiltInBrowserStatus;
      url: string | null;
      tabId: string | null;
      requestedAt: string;
    }
  | { type: "selection"; item: BuiltInBrowserContextItem }
  | { type: "selection-cleared"; item: null; clearedAt: string }
  | {
      type: "found-in-page";
      tabId: string;
      requestId: number;
      activeMatchOrdinal: number | null;
      matches: number | null;
      finalUpdate: boolean;
      foundAt: string;
    }
  | {
      type: "recording";
      tabId: string;
      recording: BuiltInBrowserRecordingStatus | null;
      frameCount: number;
      /**
       * Set only when something other than the agent ended the recording: a
       * login handoff suspended capture, or the recording hit its wall-clock
       * cap. Either way the agent that armed it learns the recording stopped
       * without having called `stopRecording`.
       */
      endedBy?: BuiltInBrowserRecordingEndedBy;
      /**
       * The recording tab's title at the moment it stopped.
       *
       * Carried because a `recording` event is filtered by project but not by
       * tab: a background tab hitting the cap raises a toast on top of whatever
       * page the human is actually looking at, and "Recording stopped" with no
       * subject reads as being about that page. `null` for an untitled tab.
       */
      tabTitle?: string | null;
      updatedAt: string;
    }
  /**
   * A human-run login import finished. Carries only counts and domain names —
   * never a cookie name or value — so the renderer can toast the result without
   * the event stream becoming a credential channel.
   */
  | {
      type: "login-import-completed";
      importedCount: number;
      domains: string[];
      completedAt: string;
    }
  /**
   * One frame of a tab's live preview stream, emitted only while something has
   * called `startPreviewStream` for that tab. JPEG data URL, already downscaled
   * in main so the renderer never resizes on the paint path.
   */
  | {
      type: "preview-frame";
      tabId: string;
      dataUrl: string;
      width: number;
      height: number;
      capturedAt: string;
    }
  /**
   * An agent action finished. Carries the trace entry that was just appended so
   * surfaces can caption "what just happened" without polling `getTrace`.
   */
  | { type: "trace"; tabId: string; entry: BuiltInBrowserActionTraceEntry }
  /**
   * A login handoff opened: the agent asked the human to take this tab. The
   * pane reveals an amber bar and the tab is human-owned until `handoff-ended`.
   */
  | {
      type: "handoff-started";
      tabId: string;
      handoff: BuiltInBrowserTabHandoff;
      startedAt: string;
    }
  | {
      type: "handoff-ended";
      tabId: string;
      /** The handoff that just closed, for surfaces that missed the start. */
      handoff: BuiltInBrowserTabHandoff;
      endedBy: BuiltInBrowserHandoffEndedBy;
      durationMs: number;
      endedAt: string;
    }
  /**
   * The tab's error tally changed — a console error, or a request that failed
   * or came back 4xx/5xx. Counts are since the tab's last main-frame
   * navigation, so a reload clears the badge without a second event.
   */
  | {
      type: "diagnostics";
      tabId: string;
      consoleErrorCount: number;
      failedRequestCount: number;
      updatedAt: string;
    }
  /**
   * A dev server was sniffed out of a terminal session's output. Carries
   * `open-request`-style metadata (url + tab + status) so the corner card can
   * caption "opened localhost:5173 in the background" without polling.
   */
  | {
      type: "dev-server-detected";
      server: DevServerRecord;
      /** The background tab it was opened in, or `null` when nothing opened. */
      tabId: string | null;
      autoOpened: boolean;
      status: BuiltInBrowserStatus;
      detectedAt: string;
    }
  /**
   * Which chats are driving the browser right now, in full each time.
   *
   * A whole-set event rather than a per-chat delta: presence is read as "is
   * THIS chat browsing", by surfaces that mount and unmount constantly (a
   * session card scrolls, a chat header switches sessions), and a surface that
   * arrived between two deltas would have no way to know what it had missed.
   * The set is small by construction — one entry per chat currently touching
   * the browser — so sending it whole is cheaper than making every reader keep
   * a reconciled copy.
   *
   * Fires when a chat starts or stops browsing, never on a heartbeat.
   */
  | { type: "agent-presence"; presence: BuiltInBrowserAgentPresence[]; updatedAt: string }
  | { type: "error"; message: string; occurredAt: string };

/**
 * One chat that is using the browser, as every surface renders it.
 *
 * Never set by the agent — see `builtInBrowserPresence.ts` in main, which
 * derives it from the browser commands themselves. The collection this presence
 * belongs to is deliberately absent: a chat session id is unique across
 * projects, so a surface keys on it directly rather than filtering, and the
 * projected shape carries nothing a window that is not showing that chat could
 * do anything with.
 */
export type BuiltInBrowserAgentPresence = {
  chatSessionId: string;
  /** The chat's lane, when it has one; personal chats have none. */
  laneId: string | null;
  /** The tab the last command addressed, when it named one. */
  tabId: string | null;
  /** When this stretch of browsing started, not when the chat did. */
  since: string;
  lastActivityAt: string;
};

/**
 * How long after an agent's last browser command presence survives.
 *
 * Shared rather than owned by main: the runtime daemon's Work-tools mirror
 * derives its own "an agent touched the browser just now" window from this
 * number, and a daemon that value-imported an Electron-main module to read it
 * would drag that module's `electron` import graph into a plain Node process.
 */
export const BUILT_IN_BROWSER_PRESENCE_EXPIRY_MS = 20_000;

/**
 * The hard cap on a single presence hold.
 *
 * A hold suspends expiry for a capture that runs for minutes without a command,
 * and is released by the `recording` event that ends it. This is the backstop
 * for a release that never arrives — a renderer torn down mid-capture, a window
 * closed under a recording — so a missed event costs at most this long instead
 * of pinning a globe beside the chat for the life of the process.
 */
export const BUILT_IN_BROWSER_PRESENCE_HOLD_MAX_MS = 10 * 60_000;

/* ── Dev servers ──────────────────────────────────────────────────────────── */

/**
 * A local dev server ADE noticed in terminal output. Detection is passive: the
 * PTY output pipeline matches the ready lines frameworks already print
 * (`http://localhost:5173`, `Local:   …`, `listening on …`), so nothing probes
 * or fetches anything the user did not already start.
 */
export type DevServerRecord = {
  port: number;
  url: string;
  source: {
    sessionId: string | null;
    laneId: string | null;
    /**
     * The project the detecting terminal belongs to, stamped at detection time.
     *
     * Carried on the record because nothing downstream can recover it: a lane
     * that has never opened a browser tab gives the Browser service no way to
     * tell which project's collection the chip belongs in, and stamping it with
     * whichever window is frontmost puts one project's `localhost` URL in
     * another project's launchpad (every surface filters `dev-server-detected`
     * on `status.collectionProjectRoot`). `null` only for detections that came
     * from no project at all.
     */
    projectRoot: string | null;
  };
  detectedAt: string;
  /**
   * The report this one replaced when a different chat named the same port
   * before. Windows has no other way to tell a chat's own server from one it
   * only printed the address of.
   */
  previousReport?: { sessionId: string | null; detectedAt: string } | null;
};

/** One dev server per (lane, port): two lanes may serve the same port. */
export function devServerKey(laneId: string | null | undefined, port: number): string {
  return `${laneId ?? ""}:${port}`;
}

export type DevServersArgs = {
  laneId?: string | null;
};

export type DevServersResult = {
  servers: DevServerRecord[];
};

/**
 * `work_tools.stopDevServer`: stop a dev server one chat's agent started. The
 * runtime that runs the chat decides again, at stop time, that the process on
 * the port is that chat's (see `devServerStop.ts`).
 */
export type DevServerStopArgs = {
  /** The chat whose agent started the server. An agent caller is pinned to its own chat. */
  chatSessionId: string;
  port: number;
  laneId?: string | null;
};

export type DevServerStopResult =
  | {
      ok: true;
      port: number;
      /** Pids that were signalled. Empty when nothing was listening any more. */
      stopped: number[];
      /** Something ignored SIGTERM (or `taskkill /T`) and was killed outright. */
      forced: boolean;
      /** Nothing was listening on the port by the time ADE looked. */
      alreadyStopped?: boolean;
    }
  | {
      ok: false;
      port: number;
      /**
       * `not_owned`: the port is held by something this chat did not start.
       * `protected`: it is ADE, a chat's agent CLI or a terminal, or stopping it
       * would stop one of them. `failed`: ADE could not look or the kill did
       * not take. `invalid`: bad arguments.
       */
      reason: "invalid" | "not_owned" | "protected" | "failed";
      error: string;
    };

/**
 * Published by the runtime that runs a lane's processes when one of its dev
 * servers starts or stops. Every desktop on that project hears it, local or
 * connected from another machine, so the Browser lights up wherever the user is.
 */
export const DEV_SERVER_EVENT = "dev_server_event" as const;

export type DevServerEvent = {
  kind: "detected" | "removed";
  server: DevServerRecord;
};

/* ── Device emulation ─────────────────────────────────────────────────────── */

export type BuiltInBrowserEmulationPresetId =
  | "desktop"
  | "iphone-17"
  | "iphone-17-pro"
  | "iphone-17-pro-max"
  | "ipad"
  | "pixel"
  | "responsive";

export type BuiltInBrowserEmulationMetrics = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent?: string | null;
};

/** CDP `Emulation.UserAgentMetadata`, sent alongside a mobile UA override. */
export type BuiltInBrowserUserAgentMetadata = {
  brands: Array<{ brand: string; version: string }>;
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
};

export type BuiltInBrowserEmulationPreset = {
  id: BuiltInBrowserEmulationPresetId;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  hasTouch: boolean;
  userAgent: string | null;
};

/**
 * Emulation currently applied to one tab. `null` means "no override".
 *
 * This is also the renderer's letterboxing contract: whenever `emulation` is
 * non-null, `width` / `height` are the *effective* CSS pixel size the page was
 * laid out at, `deviceScaleFactor` the DPR it renders with, `mobile` whether it
 * is in mobile viewport mode, and `label` the human name for the chrome
 * ("iPhone 17 Pro", "820×1180"). The pane sizes the native view to exactly
 * `width × height` CSS px, centers it in the pane, and letterboxes the rest —
 * never stretched, never scaled to fit, so a screenshot an agent takes matches
 * what the human sees.
 */
export type BuiltInBrowserEmulationState = {
  presetId: BuiltInBrowserEmulationPresetId | null;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  hasTouch: boolean;
  userAgent: string | null;
};

export type BuiltInBrowserSetEmulationArgs = BuiltInBrowserTabTargetArgs & {
  /** Preset id/label, or `off`/`none`/`null` to clear the override. */
  preset?: string | null;
  width?: number | null;
  height?: number | null;
  deviceScaleFactor?: number | null;
  mobile?: boolean | null;
  userAgent?: string | null;
};

export type BuiltInBrowserEmulationResult = {
  tabId: string;
  emulation: BuiltInBrowserEmulationState | null;
  presets: BuiltInBrowserEmulationPreset[];
  status: BuiltInBrowserStatus;
};

/* ── Zoom ─────────────────────────────────────────────────────────────────── */

export type BuiltInBrowserSetZoomArgs = BuiltInBrowserTabTargetArgs & {
  factor?: number | null;
  /** Convenience for `factor: 1`. */
  reset?: boolean;
};

export type BuiltInBrowserZoomResult = {
  tabId: string;
  zoomFactor: number;
  status: BuiltInBrowserStatus;
};

/* ── Find in page ─────────────────────────────────────────────────────────── */

export type BuiltInBrowserFindInPageArgs = BuiltInBrowserTabTargetArgs & {
  text: string;
  forward?: boolean;
  matchCase?: boolean;
  /** Advance to the next match of an already-running find instead of restarting. */
  findNext?: boolean;
  timeoutMs?: number | null;
};

export type BuiltInBrowserFindInPageResult = {
  tabId: string;
  text: string;
  requestId: number;
  activeMatchOrdinal: number | null;
  matches: number | null;
  finalUpdate: boolean;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserStopFindInPageArgs = BuiltInBrowserTabTargetArgs & {
  action?: "clearSelection" | "keepSelection" | "activateSelection";
};

export type BuiltInBrowserStopFindInPageResult = {
  /** Empty when there was no tab to stop a find on. */
  tabId: string;
  /**
   * False means "there was nothing to stop", not "it failed".
   *
   * The find bar's teardown races tab closure by construction — closing the
   * last tab unmounts the panel, whose cleanup then asks an empty pane to end a
   * find — so an empty pane answers rather than throwing, the same way
   * `captureScreenshot` answers `{ ok: false, reason: "no_tab" }`.
   */
  stopped: boolean;
  status: BuiltInBrowserStatus;
};

/* ── DevTools ─────────────────────────────────────────────────────────────── */

export type BuiltInBrowserDevToolsMode = "right" | "bottom" | "detach";

export type BuiltInBrowserSetDevToolsArgs = BuiltInBrowserTabTargetArgs & {
  open: boolean;
  mode?: BuiltInBrowserDevToolsMode | null;
};

export type BuiltInBrowserDevToolsResult = {
  tabId: string;
  devToolsOpen: boolean;
  mode: BuiltInBrowserDevToolsMode | null;
  status: BuiltInBrowserStatus;
};

/* ── Full network log ─────────────────────────────────────────────────────── */

export type BuiltInBrowserNetworkHeader = {
  name: string;
  value: string;
  /** True when the value was replaced with a redaction marker. */
  redacted: boolean;
};

export type BuiltInBrowserNetworkTimings = {
  /** Wall-clock start of the request, ISO 8601. */
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** Time to first response byte, when the response phase was observed. */
  waitMs: number | null;
  receiveMs: number | null;
};

export type BuiltInBrowserNetworkLogEntry = {
  id: string;
  method: string | null;
  url: string;
  status: number | null;
  statusText: string | null;
  mimeType: string | null;
  resourceType: string | null;
  protocol: string | null;
  fromCache: boolean;
  requestHeaders: BuiltInBrowserNetworkHeader[];
  responseHeaders: BuiltInBrowserNetworkHeader[];
  requestBodySize: number | null;
  responseBodySize: number | null;
  responseHeaderSize: number | null;
  timings: BuiltInBrowserNetworkTimings;
  error: string | null;
};

export type BuiltInBrowserSetNetworkLoggingArgs = BuiltInBrowserTabTargetArgs & {
  enabled: boolean;
  /** Drop anything already recorded when turning logging on. */
  clear?: boolean;
};

export type BuiltInBrowserNetworkLoggingResult = {
  tabId: string;
  enabled: boolean;
  entryCount: number;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserNetworkLogArgs = BuiltInBrowserTabTargetArgs & {
  limit?: number | null;
  /** Case-insensitive substring matched against method, URL, status and mime. */
  filter?: string | null;
  failedOnly?: boolean;
};

export type BuiltInBrowserNetworkLogResult = {
  tabId: string;
  enabled: boolean;
  recordedCount: number;
  droppedCount: number;
  matchedCount: number;
  entries: BuiltInBrowserNetworkLogEntry[];
};

/**
 * Read a tab's text the way a person reads it: the rendered text of the page's
 * main content (or one element), in pages of `maxChars`. `observe` maps what an
 * agent can click; this is what it can read.
 */
export type BuiltInBrowserReadTextArgs = BuiltInBrowserTabTargetArgs & {
  /** CSS selector to read instead of the page's main content. */
  selector?: string | null;
  /** Characters to skip, to read on from an earlier result's `nextOffset`. */
  offset?: number | null;
  maxChars?: number | null;
};

export type BuiltInBrowserReadTextResult = {
  tabId: string;
  url: string | null;
  title: string | null;
  /** Where the text came from: the selector, the page's main/article region, or the whole body. */
  source: "selector" | "main" | "body";
  text: string;
  offset: number;
  totalChars: number;
  /** Where the next page starts, or null when this one reached the end. */
  nextOffset: number | null;
};

export type BuiltInBrowserExportHarArgs = BuiltInBrowserTabTargetArgs & {
  filter?: string | null;
  failedOnly?: boolean;
};

export type BuiltInBrowserExportHarResult = {
  tabId: string;
  filePath: string;
  relativePath: string | null;
  entryCount: number;
  exportedAt: string;
};

/* ── Extra page actions ───────────────────────────────────────────────────── */

export type BuiltInBrowserHoverArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  x?: number | null;
  y?: number | null;
};

export type BuiltInBrowserDragArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  /** Source coordinates when no source element target is given. */
  x?: number | null;
  y?: number | null;
  toSelector?: string | null;
  toText?: string | null;
  toTestId?: string | null;
  toElementIndex?: number | null;
  toHandle?: string | null;
  toX?: number | null;
  toY?: number | null;
  /** Intermediate mouseMoved events between press and release (1–50). */
  steps?: number | null;
};

export type BuiltInBrowserSelectOptionArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  value?: string | null;
  label?: string | null;
  index?: number | null;
};

export type BuiltInBrowserUploadFileArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  paths: string[];
  /**
   * Click this element and satisfy the file chooser it opens, instead of
   * setting files on an `<input type=file>` that is already in the DOM.
   *
   * Some pages never keep an input around: the button creates one, clicks it,
   * and the browser shows its native sheet. `DOM.setFileInputFiles` has no node
   * to target in that case, so the chooser itself is intercepted and handed the
   * files. The element named by the usual target args stays the file input;
   * this names the thing that opens it.
   */
  triggerSelector?: string | null;
};

/**
 * Drop files on an element, the way a person drags them from Finder.
 *
 * For pages with a dropzone and no file input at all: `upload --selector` has
 * no input to set, and `upload --trigger` has no chooser to intercept.
 */
export type BuiltInBrowserDropFilesArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  paths: string[];
};

/* ── Screen recording ─────────────────────────────────────────────────────── */

export type BuiltInBrowserRecordingFormat = "webm" | "mp4";

/**
 * The frame rates a recording may run at, and the wall-clock cap on one.
 *
 * These live here rather than next to the recorder because both processes need
 * them and neither can import the other's: main enforces them
 * (`builtInBrowserCapabilities.ts` re-exports them for its call sites) and the
 * renderer renders them — the fps menu in the overflow panel and the
 * "5-minute limit reached" toast. They used to be a main-side pair with a
 * hand-synced renderer copy and a "change both" comment; one home is the
 * point.
 */
export const BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS = [30, 60] as const;

export type BuiltInBrowserRecordingFps = (typeof BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS)[number];

/**
 * Wall-clock cap on a single recording, enforced by the session's own timer.
 *
 * A recording is a `getDisplayMedia` capture of a live tab writing to the
 * project's scratch dir; an agent that forgets to call `stopRecording` (or dies
 * mid-run) would otherwise capture until the app quits. Five minutes is long
 * enough for any "show me this flow" and short enough that the forgotten case
 * costs a bounded file.
 *
 * What the caller sees when it fires: the recording is finalized exactly as a
 * `stopRecording` would have finalized it — same file, same manifest — and the
 * agent is told through two channels rather than a return value it never
 * asked for. A `recording` event carries `endedBy: "max_duration"` (so the
 * pane can say why the REC pill vanished), and a `stopRecording`-shaped entry
 * with the same `endedBy` lands in the tab's action trace, which is where the
 * skill tells an agent to look. A later `stopRecording` then throws
 * `Browser tab <id> is not recording.` A login hand-off is the other automatic
 * ending (`endedBy: "handoff"`), and unlike this one it ABORTS rather than
 * finalizes — see `suspendAgentCaptureForHandoff`. Neither resumes; an agent
 * that wants more has to start a new recording.
 */
export const BUILT_IN_BROWSER_MAX_RECORDING_MS = RECORDING_MAX_MS;

/**
 * Query parameters whose value is a credential rather than a request detail.
 *
 * Redacting only headers left the bigger hole open: an IdP callback, a
 * magic-link, and a presigned URL all carry the secret in the query string, and
 * a HAR export explodes every parameter into the file by name and value.
 *
 * Lives in `shared/` rather than beside the HAR writer because the renderer
 * needs the same list: the launchpad's "Recently used" store refuses to
 * persist a URL carrying any of these, and a second hand-maintained copy there
 * would be a list that silently stops matching this one.
 */
export const BUILT_IN_BROWSER_REDACTED_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "code",
  "access_token",
  "id_token",
  "token",
  "state",
  "session",
  "sig",
  "signature",
  "api_key",
  "refresh_token",
  "client_secret",
]);

export function isRedactedBuiltInBrowserQueryParam(name: string): boolean {
  return BUILT_IN_BROWSER_REDACTED_QUERY_PARAMS.has(name.trim().toLowerCase());
}

export type BuiltInBrowserRecordingStatus = {
  startedAt: string;
  fps: number;
};

/**
 * What ended a recording the agent did not stop itself.
 *
 * `max_duration` finalizes the file (the wall-clock cap fired —
 * `BUILT_IN_BROWSER_MAX_RECORDING_MS`); `handoff` aborts it, because a partial
 * capture taken while a human was typing a password is not proof of anything the
 * agent did. Both are surfaced twice: on the `recording` event as `endedBy`, so
 * a pane can explain why the REC pill vanished, and as a `stopRecording`-shaped
 * action-trace entry carrying the same value, so `ade browser trace` explains it
 * to the agent.
 */
/** `idle` and `disk` are the limits every recording shares (`demoRecordingGuard.ts`). */
export type BuiltInBrowserRecordingEndedBy = "handoff" | "max_duration" | "idle" | "disk";

export type BuiltInBrowserStartRecordingArgs = BuiltInBrowserTabTargetArgs & {
  /** 30 or 60; anything else is rejected. */
  fps?: number | null;
  /** Supplying a caption is what makes `stopRecording` file a proof entry. */
  caption?: string | null;
  /** File the recording as it happened: no cuts, zoom or overlays. */
  plain?: boolean | null;
};

export type BuiltInBrowserStartRecordingResult = {
  tabId: string;
  recording: BuiltInBrowserRecordingStatus;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserStopRecordingArgs = BuiltInBrowserTabTargetArgs & {
  /** Overrides the start's `plain` for this recording. */
  plain?: boolean | null;
};

export type BuiltInBrowserStopRecordingResult = {
  tabId: string;
  path: string;
  relativePath: string | null;
  durationMs: number;
  fps: number;
  frameCount: number;
  format: BuiltInBrowserRecordingFormat;
  mimeType: string;
  caption: string | null;
  /** Reserved for encoders that emit a sidecar manifest; `null` today. */
  manifestPath: string | null;
  /** How the demo was made; the proof stores it at `metadata.demo`. Null for a file passed through as recorded. */
  demo?: DemoArtifactMetadata | null;
  status: BuiltInBrowserStatus;
};

/* ── Live preview stream ──────────────────────────────────────────────────── */

/**
 * A cheap "what does this tab look like right now" feed for surfaces that are
 * not the browser panel — the Work tab's floating corner card, mainly.
 *
 * Deliberately NOT the recording pipeline: that negotiates a `getDisplayMedia`
 * grant and an encoder to produce a file. A preview only ever needs a small
 * JPEG at a low frame rate, and `capturePage()` gives us that with no grant, no
 * encoder, and no artefact on disk. It is also refcounted and never started for
 * a tab nobody is watching, so an idle Work tab pays nothing.
 */
export const BUILT_IN_BROWSER_PREVIEW_DEFAULT_FPS = 12;
export const BUILT_IN_BROWSER_PREVIEW_MAX_FPS = 24;
export const BUILT_IN_BROWSER_PREVIEW_DEFAULT_MAX_WIDTH = 480;
export const BUILT_IN_BROWSER_PREVIEW_MAX_WIDTH_LIMIT = 1_280;
/** JPEG quality for preview frames — small enough to shuttle at 12fps. */
export const BUILT_IN_BROWSER_PREVIEW_JPEG_QUALITY = 80;
/**
 * Geometry for a tab that is being previewed while the panel is showing
 * something else.
 *
 * The view has to stay attached and visible to keep a compositor surface (a
 * detached or hidden `WebContentsView` captures nothing at all), so it is parked
 * this far past the bottom-right corner of the union of every display, where no
 * window on any screen can reach it. The size floors only apply to a tab the
 * panel never showed — a zero-sized view would capture an empty image.
 */
export const BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN = 64;
export const BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_WIDTH = 960;
export const BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_HEIGHT = 600;
/**
 * A page narrower than this, because the person's pane is, gets a
 * `narrowPageHint` on an agent's observation. The page keeps
 * the size of the pane that showed it; the hint tells the agent how to ask
 * for a desktop layout.
 */
export const BUILT_IN_BROWSER_NARROW_PAGE_WIDTH = 640;

/**
 * The page size of a tab that is being recorded.
 *
 * A page lays out at its native view's size, so a recording made in a narrow
 * Work pane was a thin strip. While a tab records, its layout viewport is
 * pinned here (the same CDP device-metrics override a device preset uses) and
 * scaled to fit whatever box shows it; parked off screen, it is exactly this
 * size at scale 1. Agent-owned tabs are not pinned: they lay out at the pane.
 */
export const BUILT_IN_BROWSER_RECORDING_VIEWPORT: { readonly width: number; readonly height: number } = {
  width: 1280,
  height: 800,
};
/**
 * How long a watched view is held overlapping the window before it is parked.
 *
 * Two frames at 60Hz plus slack: long enough for Chromium to allocate the
 * compositor surface the capture needs, short enough that the single pixel of
 * the page showing at the window's corner is never something anybody sees.
 */
export const BUILT_IN_BROWSER_PREVIEW_WARM_MS = 120;

/**
 * The radius the loaded page itself is rounded to, in the panel's inset frame.
 *
 * A `WebContentsView` is composited ABOVE the renderer, so the frame's CSS
 * `overflow-hidden` cannot mask it: the page stayed a hard rectangle inside a
 * rounded container, and the four corners were the one place the panel visibly
 * stopped being a browser and started being an iframe. Electron's
 * `View.setBorderRadius` is the only thing that can round the native layer.
 *
 * 9, not 10: the view sits one hairline inside the frame's 10px radius, which
 * is the same arithmetic `BrowserStage`'s masking element does — both read this
 * constant so they cannot drift apart.
 */
export const BUILT_IN_BROWSER_VIEW_CORNER_RADIUS = 9;

/**
 * How long window/display geometry has to settle before parked views are
 * repositioned. A live resize drag fires continuously; recomputing on every
 * frame would `setBounds` a dozen views per tick for no visible benefit.
 */
export const BUILT_IN_BROWSER_PARKED_PREVIEW_REPARK_DEBOUNCE_MS = 50;

export type BuiltInBrowserStartPreviewStreamArgs = BuiltInBrowserProjectScopeArgs & {
  /** Defaults to the collection's active tab. */
  tabId?: string | null;
  /** Clamped to `BUILT_IN_BROWSER_PREVIEW_MAX_FPS`. */
  fps?: number | null;
  /** Longest edge of the emitted frame, clamped to the limit above. */
  maxWidth?: number | null;
};

export type BuiltInBrowserStopPreviewStreamArgs = BuiltInBrowserProjectScopeArgs & {
  tabId?: string | null;
};

export type BuiltInBrowserPreviewStreamResult = {
  tabId: string;
  /** Effective loop rate, which is the fastest rate any subscriber asked for. */
  fps: number;
  maxWidth: number;
  /** How many subscribers the loop is now serving; 0 means it stopped. */
  subscribers: number;
};

export function normalizeBuiltInBrowserPreviewFps(value: number | null | undefined): number {
  const fps = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : BUILT_IN_BROWSER_PREVIEW_DEFAULT_FPS;
  return Math.max(1, Math.min(BUILT_IN_BROWSER_PREVIEW_MAX_FPS, fps));
}

export function normalizeBuiltInBrowserPreviewMaxWidth(value: number | null | undefined): number {
  const width = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : BUILT_IN_BROWSER_PREVIEW_DEFAULT_MAX_WIDTH;
  return Math.max(80, Math.min(BUILT_IN_BROWSER_PREVIEW_MAX_WIDTH_LIMIT, width));
}
