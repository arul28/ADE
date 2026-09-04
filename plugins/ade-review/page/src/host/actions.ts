/**
 * The host-call map, in one file.
 *
 * Every call the compiled Review made into ADE has exactly one counterpart here,
 * and the mapping is the whole point of the page tier:
 *
 * | compiled call                                   | page call                         | child verb              |
 * |-------------------------------------------------|-----------------------------------|-------------------------|
 * | `window.ade.review.listRuns`                    | `invoke("pageRuns")`              | `review.listRuns`       |
 * | `window.ade.review.getRunDetail`                | `invoke("pageRunDetail")`         | `review.getRunDetail`   |
 * | `window.ade.review.listLaunchContext`           | `invoke("pageLaunchContext")`     | `review.listLaunchContext` + `sdk.lanes.list` |
 * | `window.ade.review.listSuppressions`            | `invoke("pageSuppressions")`      | `review.listSuppressions` |
 * | `window.ade.review.qualityReport`               | `invoke("pageQualityReport")`     | `review.qualityReport`  |
 * | `window.ade.ai.getStatus` (the picker's model list) | `invoke("pageChatModels")`     | `sdk.chat.capabilities` |
 * | `window.ade.review.startRun`                    | `invoke("pageStartRun")`          | `review.startRun`       |
 * | `window.ade.review.rerun`                       | `invoke("pageRerun")`             | `review.rerun`          |
 * | `window.ade.review.cancelRun`                   | `invoke("pageCancelRun")`         | `review.cancelRun`      |
 * | `window.ade.review.recordFeedback`              | `invoke("pageRecordFeedback")`    | `review.recordFeedback` |
 * | `window.ade.review.deleteSuppression`           | `invoke("pageDeleteSuppression")` | `review.deleteSuppression` |
 * | `window.ade.review.onEvent`                     | `host.subscribe({kinds:["review"]})` + the poll | — |
 * | `window.ade.app.openPathInEditor`               | `ui.openPathInEditor` (guarded)   | — |
 * | `window.ade.app.writeClipboardText`             | `clipboard.write` (guarded)       | — |
 * | `navigate("/files", { openFilePath })`          | `openDeeplink("ade://files?…")`   | — |
 * | `selectLane` + `focusSession` + `navigate("/work")` | `openDeeplink("ade://lane/<id>?session=<id>")` | — |
 * | `ModelPicker` / `ReasoningEffortPicker`         | `ui.pickModel` / `ui.pickReasoningEffort` | — |
 * | `useAppStore(s => s.lanes)`                     | `pageLaunchContext().lanes`       | `sdk.lanes.list`        |
 * | `useAppStore(s => s.project)`                   | `context.project`                 | — |
 * | `localStorage` sidebar width / selected run     | `collections("ui-state")`         | — |
 *
 * The plugin's own child process answers every `page*` id (`../../pageActions.js`),
 * which is what makes the page work identically on desktop, in the hosted web
 * client and wherever else a guest is drawn: the child holds the `review.*`
 * action domain and the page holds none of it.
 *
 * ## Why a page handler does not throw
 *
 * A press on a panel that fails renders as a banner because the host turns
 * `{message, ok: false}` into one. A page's `invoke` has no such chrome: a
 * rejected promise reaches the page as an exception beside a form the reader has
 * already filled in, and the page has to invent the banner itself. So every
 * MUTATION here answers `{ok: false, message}` for anything the review engine
 * refused, and the child throws only when the plugin itself is wrong.
 *
 * The reads split, and the split is not taste. A read DEGRADES only where the
 * degraded answer has an honest place to live:
 *
 * - `pageLaunchContext` degrades to an empty context carrying `message`, which
 *   the launch form prints beside the lane field. "No lanes, and here is why"
 *   is a true sentence.
 * - `pageQualityReport` degrades to `null`, which the learnings panel already
 *   draws as an em-dash in every metric. "Not measured" is a true reading.
 *
 * The other three REJECT, because an empty answer would be a lie the page
 * cannot detect: an empty `pageRuns` is indistinguishable from "no review runs
 * yet in this workspace", an empty `pageRunDetail.findings` from "this review
 * found nothing", and an empty `pageSuppressions` from "nothing is suppressed" —
 * and each of those three is a sentence the product actually prints.
 */

import { requireBridge } from "../bridge";
import type {
  PageChatModel,
  PageReviewLaunchContext,
  ReviewFeedbackKind,
  ReviewDismissReason,
  ReviewQualityReport,
  ReviewRun,
  ReviewRunConfig,
  ReviewRunDetail,
  ReviewRunStatus,
  ReviewSuppression,
  ReviewSuppressionScope,
  ReviewTarget,
} from "../types";

/** What every mutating page action answers. Never a throw for a refusal. */
export type PageActionResult = {
  ok: boolean;
  message?: string | null;
  [key: string]: unknown;
};

function call<T>(action: string, args?: Record<string, unknown>): Promise<T> {
  return requireBridge().invoke(action, args ?? {}) as Promise<T>;
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export type PageRunsArgs = {
  laneId?: string | null;
  status?: ReviewRunStatus | "all";
  limit?: number;
};

/** Every run in this project, newest first. Rejects — see the header. */
export const getRuns = (args: PageRunsArgs = {}): Promise<ReviewRun[]> =>
  call("pageRuns", args as Record<string, unknown>);

/** One run with its findings, artifacts, reviewer runs and publications. */
export const getRunDetail = (runId: string): Promise<ReviewRunDetail | null> =>
  call("pageRunDetail", { runId });

/**
 * The lanes, their recent commits and the recommended model.
 *
 * The one read that degrades. `lanes` carries each lane's worktree `path`,
 * which the compiled page took from the app store and a guest cannot reach —
 * the child joins `sdk.lanes.list()` onto the review engine's own answer.
 */
export const getLaunchContext = (): Promise<PageReviewLaunchContext> => call("pageLaunchContext");

/**
 * The models a launch may use, each with its own fast-tier fact.
 *
 * DEGRADES to `[]`. The child reads `sdk.chat.capabilities()`, which is where
 * ADE's own launch form gets the same two facts; an empty answer means the page
 * narrows nothing (the picker offers ADE's whole catalogue) and draws no
 * fast-mode toggle, which is what a host too old to answer gives anyway. The
 * `catch` is here rather than only in the child because a bridge that is gone
 * rejects before the child is ever reached, and a launch form that failed to
 * mount over a model list would be worse than one with an unnarrowed picker.
 */
export const getChatModels = async (): Promise<PageChatModel[]> => {
  try {
    const models = await call<PageChatModel[]>("pageChatModels");
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
};

export const getSuppressions = (limit = 100): Promise<ReviewSuppression[]> =>
  call("pageSuppressions", { limit });

/** The learning loop's numbers, or `null` when the engine has none. */
export const getQualityReport = (): Promise<ReviewQualityReport | null> => call("pageQualityReport");

/* ── Mutations ──────────────────────────────────────────────────────────── */

export type PageStartRunResult = PageActionResult & { runId?: string | null };

/**
 * Start a review.
 *
 * The argument is the compiled `{target, config}` pair verbatim, because it is
 * what `review.startRun` takes and inventing a flatter one here would put a
 * translation nobody asked for between the form and the engine.
 */
export const startRun = (args: {
  target: ReviewTarget;
  config: ReviewRunConfig;
}): Promise<PageStartRunResult> => call("pageStartRun", args as unknown as Record<string, unknown>);

export const rerun = (runId: string): Promise<PageStartRunResult> => call("pageRerun", { runId });

export const cancelRun = (runId: string): Promise<PageActionResult> => call("pageCancelRun", { runId });

export type PageRecordFeedbackArgs = {
  findingId: string;
  kind: ReviewFeedbackKind;
  reason?: ReviewDismissReason | null;
  note?: string | null;
  snoozeDurationMs?: number | null;
  suppression?: { scope: ReviewSuppressionScope; pathPattern?: string | null } | null;
};

export const recordFeedback = (args: PageRecordFeedbackArgs): Promise<PageActionResult> =>
  call("pageRecordFeedback", args as unknown as Record<string, unknown>);

export const deleteSuppression = (suppressionId: string): Promise<PageActionResult> =>
  call("pageDeleteSuppression", { suppressionId });
