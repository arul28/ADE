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
 * | `window.ade.lanes.create` / `.delete`  | `invoke("pageCreateLane"/"pageDeleteLane")` |
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

export const getConnection = (): Promise<LinearConnectionStatus> => call("pageConnection");

export const getProjects = (): Promise<CtoLinearProject[]> => call("pageProjects");

export type PageAutolinkState = {
  autolinks: GitHubAutolink[];
  repo: { owner: string; name: string } | null;
  teams: { teamKey: string; teamName: string; keyPrefix: string; urlTemplate: string | null }[];
  webhookUrl: string | null;
  webhookSecretStored: boolean;
  webhooksPossible: boolean;
};

export const getAutolinks = (): Promise<PageAutolinkState> => call("pageAutolinks");

export const getLanes = (): Promise<PageLane[]> => call("pageLanes");

export const getChatModels = (): Promise<PageChatModel[]> => call("pageModels");

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

export const saveWebhookSecret = (secret: string): Promise<PageActionResult> =>
  call("saveWebhookSecret", { secret });

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
