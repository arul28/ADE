import {
  isLinkableIssueRef,
  issueRefToStoredLinearIssue,
  type IssueRef,
} from "../../../../shared/issueRef";
import type { LaneLinearIssue } from "../../../../shared/types/lanes";
import type {
  PluginWebviewComposerAttach,
  PluginWebviewDialogSubmit,
} from "../../../../shared/plugins/webviewBridge";

/**
 * The five facts a picker page reports, as the issue ADE's dialogs already
 * hold.
 *
 * A `dialog-picker` answers with {@link PluginWebviewComposerAttach} — the same
 * record `composer.attach` carries — and the Create-lane and Create-PR dialogs
 * both hold a `LaneLinearIssue`. Something has to bridge the two, and the
 * question is what to do about the twenty fields the page did not send.
 *
 * The answer is: nothing invented. The record becomes an {@link IssueRef},
 * which is the provider-neutral shape ADE already stores issue links in, and
 * `issueRefToStoredLinearIssue` projects it down to the legacy Linear shape
 * WITH the ref embedded under its reserved key. Every consumer that matters
 * then reads the ref rather than the projection: `readLinearIssueRef` returns
 * what the page actually said, and `buildLinearPrReference` writes `Fixes` only
 * for a provider whose merge can close an issue — so a third-party tracker's
 * page gets `Refs`, which is correct, rather than a magic word GitHub will
 * honour against an issue that does not exist.
 *
 * What the projection fills in for the missing fields is the ref's own
 * defaults (`unstarted`, priority 0, the provider's uppercase name as the team
 * key), which is exactly what every other cross-tracker writer in the app
 * produces. Nothing here guesses a Linear team id.
 */

/**
 * The answer a dialog should apply, or null when the page sent nonsense.
 *
 * `{ issue: null }` — the reader cleared the selection — is a real answer and
 * comes back as `{ issue: null }`, not as a refusal: a dialog must be able to
 * hear "unselected" or a choice made inside the page could never be undone.
 */
export function readPluginDialogIssueAnswer(
  answer: PluginWebviewDialogSubmit,
  pluginId: string,
): { issue: LaneLinearIssue | null } | null {
  const raw = answer.issue;
  if (raw === null || raw === undefined) return { issue: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const issue = laneIssueFromPluginAttachment(raw as PluginWebviewComposerAttach, pluginId);
  return issue ? { issue } : null;
}

/**
 * One picker answer as a stored issue row, or null when it cannot be linked.
 *
 * `isLinkableIssueRef` is the gate rather than a hand-rolled field check: it is
 * the same predicate every other issue writer in the app uses for "enough to
 * link, display and reference in a PR", so a page cannot fill a dialog with an
 * issue the lane linker would then refuse.
 */
export function laneIssueFromPluginAttachment(
  attachment: PluginWebviewComposerAttach,
  pluginId: string,
): LaneLinearIssue | null {
  const provider = typeof attachment.provider === "string" ? attachment.provider.trim().toLowerCase() : "";
  const issueId = typeof attachment.issueId === "string" ? attachment.issueId.trim() : "";
  const key = typeof attachment.identifier === "string" ? attachment.identifier.trim() : "";
  const title = typeof attachment.title === "string" ? attachment.title.trim() : "";
  const url = typeof attachment.url === "string" && attachment.url.trim() ? attachment.url.trim() : null;
  const ref: IssueRef = {
    // The plugin that owns this link, so a later reconcile can tell whose it
    // is. Never `core`: core did not pick this issue, a page did.
    pluginId,
    provider,
    issueId,
    key,
    title,
    url,
  };
  return isLinkableIssueRef(ref) ? issueRefToStoredLinearIssue(ref) : null;
}
