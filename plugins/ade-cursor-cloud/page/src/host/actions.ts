/**
 * The host-call map, in one file.
 *
 * Every call the compiled Cursor Cloud made into ADE has exactly one
 * counterpart here, and the mapping is the whole point of the page tier:
 *
 * | compiled call                                   | page call                       |
 * |-------------------------------------------------|---------------------------------|
 * | `window.ade.ai.cursorCloudFleet`                 | `invoke("pageFleet")`           |
 * | `window.ade.ai.cursorCloudListRuns` + `…GetUsage`| `invoke("pageAgent")`           |
 * | a signed artifact download, once per file        | `invoke("pageArtifactUrls")`    |
 * | `window.ade.ai.cursorCloudListRepositories`      | `invoke("pageLaunchContext")`   |
 * | `window.ade.projectSecrets.list` (names)         | `invoke("pageLaunchContext")`   |
 * | `window.ade.ai.cursorCloudGetLaneSecretNames`    | `invoke("pageLaunchContext")`   |
 * | `window.ade.git.getOpenPrForBranch`              | `invoke("pageLaunchContext")`   |
 * | `window.ade.ai.cursorCloudCreateRun`             | `invoke("pageLaunch")`          |
 * | `window.ade.ai.cursorCloudOpenChat` (+ `…ResolveLane`) | `invoke("pageOpenInAde")` |
 * | `window.ade.ai.cursorCloudCancelRun`/`StopRun`   | `invoke("pageStopRun")`         |
 * | a follow-up turn on a live agent                 | `invoke("pageFollowUp")`        |
 * | `window.ade.ai.cursorCloudPullIntoLane`          | `invoke("pagePullIntoLane")`    |
 * | `window.ade.ai.cursorCloudArchiveAgent`          | `invoke("pageArchiveAgent")`    |
 * | `window.ade.ai.cursorCloudUnarchiveAgent`        | `invoke("pageUnarchiveAgent")`  |
 * | `window.ade.ai.cursorCloudDeleteAgent`           | `invoke("pageDeleteAgent")`     |
 * | `CursorCloudQuickViewButton`'s unread counter    | `invoke("pageAckBadge")`        |
 * | `useAppStore(s => s.lanes)`                      | `CloudLaunchContext.lanes`      |
 * | `useAppStore(s => s.project)`                    | `context.project`               |
 *
 * The plugin's own child process answers every one of them (`pageActions.js`),
 * which is what makes the page work identically on desktop, in the hosted web
 * client and on the phone: the child holds the Cursor client, the API key and
 * every project SECRET VALUE, and the page holds none of the three.
 *
 * Two things the compiled surfaces did are deliberately NOT here.
 *
 * - No date maths and no currency maths. `age`, `cost` and the fleet `footer`
 *   arrive pre-formatted, because a phone and a Mac in different time zones
 *   reading the same row must print the same words.
 * - No `cursorCloudErrorMessage`. Electron's `Error invoking remote method …`
 *   wrapper never crosses the bridge; a refusal comes back as
 *   `{ok:false, message}` and a load failure as `CloudFleetPage.error`, both
 *   already worded by the child.
 */

import { requireBridge } from "../bridge";
import type {
  CloudAgentPage,
  CloudArtifactUrls,
  CloudFleetPage,
  CloudLaunchContext,
  CloudLaunchResult,
  PageActionResult,
} from "../types";

function call<T>(action: string, args?: Record<string, unknown>): Promise<T> {
  return requireBridge().invoke(action, args ?? {}) as Promise<T>;
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

/**
 * The whole fleet, assembled and grouped.
 *
 * One call, not the compiled three: the modal fetched the agent list, then a
 * usage read per expanded row, then a run list per active agent. The child does
 * that fan-out once and answers a page — which is the difference between a
 * phone on a slow link drawing a list in one round trip and drawing it in ten.
 */
export const getFleetPage = (): Promise<CloudFleetPage> => call("pageFleet");

/**
 * One agent in full: the entry, its usage, its runs and its artifacts.
 *
 * Called through `host/agentPageCache.ts` rather than directly, so a reader
 * walking back up a list does not pay for a read they already paid for.
 */
export const getAgentPage = (agentId: string): Promise<CloudAgentPage> =>
  call("pageAgent", { agentId });

/**
 * Every signed artifact download for one agent, in one call.
 *
 * Deliberately NOT part of `pageAgent`. Cursor mints a link per file and the
 * pane may list fifty, so minting them inside the detail read put fifty
 * sequential requests in front of the first paint — for links most readers
 * never press. The page asks for them when it opens the artifacts section.
 */
export const getArtifactUrls = (agentId: string): Promise<CloudArtifactUrls> =>
  call("pageArtifactUrls", { agentId });

/**
 * Everything the launch form may offer for one lane.
 *
 * `useCursorCloudDraftState` ran four probes in the renderer — the connected
 * repo list, the project secret NAMES, the lane's remembered secret names and
 * the branch's open PR — and turned them into one `unavailable` sentence. All
 * four moved into the child, and this is that same sentence plus the fields it
 * did not veto.
 */
export const getLaunchContext = (args: {
  laneId?: string | null;
  draft?: string | null;
}): Promise<CloudLaunchContext> => call("pageLaunchContext", args as Record<string, unknown>);

/* ── Mutations ──────────────────────────────────────────────────────────── */

export type PageLaunchArgs = {
  prompt: string;
  laneId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  /**
   * The speed tier, as a THREE-state field.
   *
   * `null` is "Cursor's default", and it is the default here for a reason the
   * form cannot express any other way: `modelSelection.js` reads `false` as an
   * explicit request for the standard tier, and refuses the launch when the
   * chosen model's catalog row names no service tier at all. A form that always
   * sent `false` therefore failed closed on every model without a speed
   * parameter — which is most of them.
   */
  fastMode: boolean | null;
  openPr: boolean;
  /**
   * Secret NAMES. Never a value.
   *
   * The compiled composer sent names too and let the main process resolve them
   * out of the encrypted project store. That rule is stricter here, not looser:
   * a page is a guest with a network allowlist, and a value that reached it
   * would be a value one `fetch` away from leaving the machine.
   */
  secretNames: string[];
  rememberSecretNames: boolean;
};

export const launchAgent = (args: PageLaunchArgs): Promise<CloudLaunchResult> =>
  call("pageLaunch", args as unknown as Record<string, unknown>);

/**
 * Adopt a cloud agent as an ADE chat.
 *
 * The compiled `openInAde` resolved a lane first when the agent had none, then
 * opened the chat, then announced the new session to the Work tab. All three
 * are one child action now, because only the child can do the middle one.
 */
export const openInAde = (
  agentId: string,
  extras?: { createLane?: boolean; laneName?: string },
): Promise<PageActionResult> =>
  call("pageOpenInAde", {
    agentId,
    ...(extras?.createLane === true ? { createLane: true } : {}),
    ...(extras?.laneName ? { laneName: extras.laneName } : {}),
  });

export const stopRun = (agentId: string): Promise<PageActionResult> =>
  call("pageStopRun", { agentId });

/** Send another turn to a live agent. Refused by the child once it is not. */
export const followUp = (agentId: string, prompt: string): Promise<PageActionResult> =>
  call("pageFollowUp", { agentId, prompt });

export const pullIntoLane = (agentId: string): Promise<PageActionResult> =>
  call("pagePullIntoLane", { agentId });

export const archiveAgent = (agentId: string): Promise<PageActionResult> =>
  call("pageArchiveAgent", { agentId });

export const unarchiveAgent = (agentId: string): Promise<PageActionResult> =>
  call("pageUnarchiveAgent", { agentId });

export const deleteAgent = (agentId: string): Promise<PageActionResult> =>
  call("pageDeleteAgent", { agentId });

export const copyWebhookUrl = (): Promise<PageActionResult> =>
  call("pageCopyWebhookUrl");

/**
 * The unread-finished badge, as a REFCOUNT rather than a reset.
 *
 * `CursorCloudQuickViewButton` owned an integer and zeroed it when its modal
 * opened, because there was exactly one modal. There is no longer exactly one:
 * the rail tab, the Work-rail pane and the phone are three placements of this
 * same page and two of them can be mounted at once. So the page reports
 * "a viewer arrived" and "a viewer left" instead, and the child holds the
 * count — which is the only place that can know whether the last one left.
 */
export const ackBadge = (viewed: boolean): Promise<unknown> =>
  call("pageAckBadge", { viewed });
