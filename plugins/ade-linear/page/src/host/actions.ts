/**
 * The host-call map, in one file.
 *
 * Every call the compiled Linear made into ADE has exactly one counterpart here,
 * and the mapping is the whole point of the page tier:
 *
 * | compiled call                          | page call                        |
 * |----------------------------------------|----------------------------------|
 * | `window.ade.cto.getLinearQuickView`    | `invoke("pageQuickView")`        |
 * | `…getLinearIssuePickerData`            | `invoke("pageCatalog")`          |
 * | `…searchLinearIssues`                  | `invoke("pageSearchIssues")`     |
 * | `…getLinearIssueComments`              | `invoke("pageIssueComments")`    |
 * | `…getLinearConnectionStatus`           | `invoke("pageConnection")`       |
 * | `…getLinearProjects`                   | `invoke("pageProjects")`         |
 * | `…setLinearToken` / `clearLinearToken` | `invoke("pageSaveApiKey"/"pageDisconnect")` |
 * | `…startLinearOAuth` / `getLinearOAuthSession` | `invoke("pageConnectOAuth")` |
 * | `window.ade.github.*` autolinks        | `invoke("pageAutolinks"/"pageCreateAutolink")` |
 * | `automations.linearIngressSetup`       | `invoke("registerWebhook")`      |
 * | `automations.getLinearIngressStatus`   | `invoke("webhookStatus")`        |
 * | `window.ade.lanes.create` / `.delete`  | `invoke("pageCreateLane"/"pageDeleteLane")` |
 * | `…getLinearIssue` by id                | `invoke("pageIssueById")`        |
 * | `modelSupportsFastMode` / `ReasoningEffortPicker` tiers | `invoke("pageModels")` |
 * | `CLAUDE_PERMISSION_OPTIONS` and its four siblings | `invoke("pageCapabilities")` |
 * | `window.ade.agentChat.launch`          | `invoke("pageLaunchAgent")`      |
 * | `window.ade.agentChat.launchCli`       | `invoke("pageLaunchCli")`        |
 * | `window.ade.lanes.attach/detachLinearIssue…` | `invoke("pageLinkIssue"/"pageUnlinkIssue")` |
 * | `useAppStore(s => s.lanes)`            | `invoke("pageLanes")` + `host` events |
 * | `useAppStore(s => s.project)`          | `context.project`                |
 *
 * The plugin's own child process answers every one of them (`pageActions.js`),
 * which is what makes the page work identically on desktop, in the hosted web
 * client and on the phone: the child holds the Linear client and the credentials,
 * and the page holds none of either.
 */

import { requireBridge } from "../bridge";
import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearIssueComment,
  CtoLinearProject,
  CtoLinearQuickView,
  CtoSearchLinearIssuesArgs,
  CtoSearchLinearIssuesResult,
  GitHubAutolink,
  LinearConnectionStatus,
  NormalizedLinearIssue,
  PageCapabilities,
  PageChatModel,
  PageLane,
} from "../types";

/** What every mutating page action answers. Never a throw for a Linear refusal. */
export type PageActionResult = {
  ok: boolean;
  message?: string | null;
  [key: string]: unknown;
};

function call<T>(action: string, args?: Record<string, unknown>): Promise<T> {
  return requireBridge().invoke(action, args ?? {}) as Promise<T>;
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export const getQuickView = (): Promise<CtoLinearQuickView> => call("pageQuickView");

export const getCatalog = (): Promise<CtoGetLinearIssuePickerDataResult> => call("pageCatalog");

export const searchIssues = (
  args: CtoSearchLinearIssuesArgs,
): Promise<CtoSearchLinearIssuesResult> => call("pageSearchIssues", args as Record<string, unknown>);

export const getIssueComments = (issueId: string): Promise<CtoLinearIssueComment[]> =>
  call("pageIssueComments", { issueId });

/**
 * One issue, by its id ALONE.
 *
 * Every other read here finds an issue by its KEY, because `pageSearchIssues`
 * is Linear's own search and Linear's search does not match a raw uuid. A lane
 * row badge is handed an id and sometimes no key anywhere, and this is the only
 * read that can answer it. `null` means no such issue in this workspace.
 */
export const getIssueById = (issueId: string): Promise<NormalizedLinearIssue | null> =>
  call("pageIssueById", { issueId });

export const getConnection = (): Promise<LinearConnectionStatus> => call("pageConnection");

export const getProjects = (): Promise<CtoLinearProject[]> => call("pageProjects");

export type PageAutolinkState = {
  autolinks: GitHubAutolink[];
  repo: { owner: string; name: string } | null;
  teams: { teamKey: string; teamName: string; keyPrefix: string; urlTemplate: string | null }[];
};

export const getAutolinks = (): Promise<PageAutolinkState> => call("pageAutolinks");

export const getLanes = (): Promise<PageLane[]> => call("pageLanes");

export const getChatModels = (): Promise<PageChatModel[]> => call("pageModels");

/**
 * What the launch form may OFFER, per provider.
 *
 * The permission vocabulary is not one list. Claude asks in one set of words,
 * Codex in another, Cursor names modes, Droid an autonomy ladder — and each of
 * those maps onto the single `permissionMode` string a launch carries. The
 * child holds the table, because it is the half that knows what
 * `chat.launchHeadless` accepts.
 */
export const getCapabilities = (): Promise<PageCapabilities> => call("pageCapabilities");

/* ── Issue mutations ────────────────────────────────────────────────────── */

export const setIssueState = (issueId: string, stateId: string): Promise<PageActionResult> =>
  call("pageSetIssueState", { issueId, stateId });

export const setIssuePriority = (issueId: string, priority: number): Promise<PageActionResult> =>
  call("pageSetIssuePriority", { issueId, priority });

export const assignIssue = (issueId: string, assigneeId: string | null): Promise<PageActionResult> =>
  call("pageAssignIssue", { issueId, assigneeId });

export const addComment = (issueId: string, body: string): Promise<PageActionResult> =>
  call("pageAddComment", { issueId, body });

export const addLabel = (issueId: string, labelName: string): Promise<PageActionResult> =>
  call("pageAddLabel", { issueId, labelName });

/* ── The connection ─────────────────────────────────────────────────────── */

/**
 * Begin the plugin's own OAuth.
 *
 * The result carries `{authSession}`, which the HOST reads and acts on before
 * the promise resolves — the bridge applies the same control-flow answers a
 * socket press honours. The page only has to redraw once it resolves.
 */
export const connectOAuth = (origin?: string): Promise<PageActionResult> =>
  call("pageConnectOAuth", origin ? { origin } : {});

export const saveApiKey = (token: string): Promise<PageActionResult> =>
  call("pageSaveApiKey", { token });

export const disconnect = (): Promise<PageActionResult> => call("pageDisconnect");

export const createAutolink = (teamKey: string): Promise<PageActionResult> =>
  call("pageCreateAutolink", { teamKey });

/* ── The webhook ────────────────────────────────────────────────────────── */

export type PageWebhookStatus = {
  ok: boolean;
  registered: boolean;
  canRegister: boolean;
  /** A sentence the tile prints: "Registered", "Connect Linear first", … */
  status: string;
  url: string | null;
  secretStored: boolean;
  connected: boolean;
  webhooksPossible: boolean;
  /** Pre-formatted — "2026-09-01 12:00 UTC" — or null when nothing has arrived. */
  lastEvent: string | null;
  pendingDeliveries: number;
  error: string | null;
  webhookId?: string | null;
  registeredAt?: string | null;
  message?: string | null;
};

/**
 * Registered, receiving, or broken.
 *
 * The `automation-trigger-tile`'s `statusAction`, called from here as well so
 * the settings section's one-line pointer can say whether the reader still has
 * something to do in Automations.
 */
export const getWebhookStatus = (): Promise<PageWebhookStatus> => call("webhookStatus");

/**
 * Create the webhook and store its signing secret, in one press.
 *
 * The tile's `registerAction`. There is no secret to paste: `webhookSetup.js`
 * generates one, creates the hook through the Linear API on the authorization
 * the reader already granted, and stores it in the same act.
 */
export const registerWebhook = (): Promise<PageWebhookStatus> => call("registerWebhook");

export const unregisterWebhook = (): Promise<PageWebhookStatus> => call("unregisterWebhook");

/* ── The chat's own issue ───────────────────────────────────────────────── */

/**
 * Open one issue on the open web.
 *
 * Answers `{openUrl}`, which the HOST acts on — the bridge honours the same
 * control-flow answers a socket press does, so the page does not (and may not)
 * navigate a window itself.
 */
export const openIssueInLinear = (issueId: string): Promise<PageActionResult> =>
  call("openInLinear", { issueId });

/**
 * Ask the host to open this plugin's picker surface, as a picker.
 *
 * The chat menu's Issue context card is drawn in a popover the host sized to a
 * card. A list has nowhere to go in it, and the modal this used to open drew
 * its own backdrop across the reader's window and asked for a pane wider than
 * the popover by a factor of five. So the card asks for the PICKER placement
 * instead, which is the surface the composer's own menu row opens and the one
 * that knows how to finish an attach.
 *
 * `laneId` is the pointer the picker reads: with one it links the issue to that
 * lane, without one it attaches a chip to the composer.
 */
export const openIssuePickerSurface = (laneId?: string | null): Promise<PageActionResult> =>
  call("openIssuePickerSurface", laneId ? { laneId } : {});

/**
 * The lane one chat belongs to, issue or no issue.
 *
 * `pageLanes` answers a lane's Linear links alone, so it can only place a chat
 * that already HAS an issue — which is the opposite of the chat the Attach row
 * exists for. The chat's own summary carries the binding.
 */
export const getSessionLane = (sessionId: string): Promise<{ laneId: string | null }> =>
  call("pageSessionLane", { sessionId });

/**
 * Post this chat's last assistant turn onto its issue.
 *
 * Reads the transcript through `chat.readTranscript` in the child rather than
 * inventing a summary here: a plugin that made up a progress note would be
 * posting words the agent never said onto a ticket other people read.
 */
export const commentProgress = (sessionId: string): Promise<PageActionResult> =>
  call("commentProgress", { sessionId });

/* ── Lanes, chats and launches ──────────────────────────────────────────── */

export type PageCreateLaneResult = PageActionResult & {
  laneId?: string;
  laneName?: string;
  branch?: string;
};

export const createLaneForIssue = (args: {
  issueId: string;
  baseRef?: string | null;
  name?: string | null;
  /** Override the branch the lane is cut on. Defaults to Linear's own name. */
  branchName?: string | null;
}): Promise<PageCreateLaneResult> => call("pageCreateLane", args as Record<string, unknown>);

export const deleteLane = (
  laneId: string,
  options?: { deleteBranch?: boolean; force?: boolean },
): Promise<PageActionResult> => call("pageDeleteLane", { laneId, ...(options ?? {}) });

export type PageLaunchArgs = {
  issueId: string;
  laneId?: string | null;
  baseRef?: string | null;
  provider?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  reasoningEffort?: string | null;
  /**
   * The provider's FAST service tier. Sent only when the form asked — a model
   * with no fast tier draws no toggle, and `false` for a reader who never saw
   * one would be a choice they did not make.
   */
  fastMode?: boolean;
  prompt?: string | null;
  cli?: boolean;
};

export type PageLaunchResult = PageActionResult & {
  laneId?: string;
  laneName?: string;
  sessionId?: string;
};

export const launchAgentOnIssue = (args: PageLaunchArgs): Promise<PageLaunchResult> =>
  call("pageLaunchAgent", args as Record<string, unknown>);

export const launchCliOnIssue = (args: PageLaunchArgs): Promise<PageLaunchResult> =>
  call("pageLaunchCli", args as Record<string, unknown>);

export const openChatOnIssue = (args: {
  issueId: string;
  laneId?: string | null;
  prompt?: string | null;
}): Promise<PageLaunchResult> => call("pageOpenChat", args as Record<string, unknown>);

export const linkIssueToLane = (issueId: string, laneId: string): Promise<PageActionResult> =>
  call("pageLinkIssue", { issueId, laneId });

export const unlinkIssueFromLane = (issueId: string, laneId: string): Promise<PageActionResult> =>
  call("pageUnlinkIssue", { issueId, laneId });
