import { buildDeeplink } from "../../../desktop/src/shared/deeplinks";
import { buildWebClientUrl } from "../../../desktop/src/shared/webClientUrl";
import { NO_CI_REASON, rollupPrChecks } from "../../../desktop/src/shared/prChecksRollup";
import type { CursorCloudFleetEntry } from "../../../desktop/src/shared/types/config";
import { formatCursorCloudAge } from "../../../desktop/src/renderer/lib/cursorCloudUtils";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapStructured(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.structuredContent)) return value.structuredContent;
  return value;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function pickString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function pickBoolean(record: JsonRecord, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = asBoolean(record[key]);
    if (value != null) return value;
  }
  return null;
}

function pickPositiveInteger(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    let parsed = NaN;
    if (typeof value === "number") parsed = value;
    else if (typeof value === "string") parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function pickNonNegativeInteger(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    let parsed = NaN;
    if (typeof value === "number") parsed = value;
    else if (typeof value === "string" && value.trim()) parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function unwrapPrValue(value: unknown): { root: JsonRecord; pr: JsonRecord } | null {
  const root = unwrapStructured(value);
  if (!isRecord(root)) return null;
  const nested = root.pr;
  return {
    root,
    pr: isRecord(nested) ? nested : root,
  };
}

/**
 * The message from a PR read that failed, or null when the value is real data.
 *
 * The `/pr` dispatch catches a rejected read into `{ error }` rather than
 * blowing the pane away, so every PR formatter has to tell "GitHub refused"
 * apart from "there is nothing to show". Without this the two collapse: an
 * `{ error }` carries no rows, so the formatters below printed "No PR checks."
 * for an outage — the exact conflation `prService.getChecks` stopped making
 * when it started rejecting instead of returning `[]`. A reader cannot act on
 * a lie that reads as a fact, and "no checks ran" invites a merge.
 */
function prReadFailure(value: unknown): string | null {
  const root = unwrapStructured(value);
  if (!isRecord(root)) return null;
  return asString(root.error);
}

function firstRecordArray(value: unknown, keys: string[]): JsonRecord[] {
  const root = unwrapStructured(value);
  if (Array.isArray(root)) return root.filter(isRecord);
  if (!isRecord(root)) return [];
  for (const key of keys) {
    const candidate = root[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function truncate(value: unknown, max = 96): string {
  const text = (asString(value) ?? "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_>#|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function shortIso(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  return match ? `${match[1]}${match[2] ? ` ${match[2]}` : ""}` : text;
}

function statusWord(status: unknown, conclusion?: unknown): "OK" | "FAIL" | "WAIT" | "SKIP" | string {
  const rawConclusion = asString(conclusion)?.toLowerCase() ?? "";
  const rawStatus = asString(status)?.toLowerCase() ?? "";
  const raw = rawConclusion && rawConclusion !== "null" ? rawConclusion : rawStatus;
  if (!raw) return "unknown";
  if (["success", "passed", "passing", "completed", "ready", "ok"].includes(raw)) return "OK";
  if (["failure", "failed", "failing", "error", "timed_out", "cancelled", "action_required", "changes_requested"].includes(raw)) return "FAIL";
  if (["pending", "running", "in_progress", "queued", "requested", "waiting"].includes(raw)) return "WAIT";
  if (["neutral", "skipped", "stale"].includes(raw)) return "SKIP";
  return raw.toUpperCase();
}

/**
 * Human rendering of a `PrChecksStatus` in a header line. Only `not_run` is
 * rewritten: it is the one value a reader would otherwise see as a raw enum,
 * and "not run" is the whole point — nothing verified the commit (ADE-135).
 */
function checksStatusLabel(status: string | null): string | null {
  if (!status) return null;
  return status === "not_run" ? "not run" : status;
}

function checksStatusWord(status: string | null): string | null {
  const label = checksStatusLabel(status);
  return label && status === "not_run" ? `CI: ${label}` : label;
}

function formatCount(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function commentPreview(record: JsonRecord): string {
  const author = pickString(record, ["author", "user", "reviewer", "login"]) ?? "unknown";
  const body = truncate(record.body ?? record.comment ?? record.summary, 84) || "(no body)";
  return `${author}: ${body}`;
}

function threadLocation(thread: JsonRecord): string {
  const path = pickString(thread, ["path", "filePath", "filename"]) ?? "conversation";
  const line = pickString(thread, ["line", "originalLine", "startLine"]);
  return line ? `${path}:${line}` : path;
}

export function formatSystemDetails(args: {
  project: { projectRoot?: string; workspaceRoot?: string };
  pid: number;
  mode?: string;
}): string {
  const rows = [
    ["project", args.project.projectRoot ?? "unknown"],
    ["workspace", args.project.workspaceRoot ?? "unknown"],
    ["mode", args.mode ?? "ready"],
    ["process", String(args.pid)],
    ["node", process.version],
    ["platform", `${process.platform} ${process.arch}`],
  ];
  return rows.map(([key, value]) => `${key.padEnd(10)} ${value}`).join("\n");
}

export function formatPrSummary(value: unknown): string {
  const unwrapped = unwrapPrValue(value);
  if (!unwrapped) return "No PR data.";
  const { root, pr } = unwrapped;
  const number = pickString(pr, ["number", "githubPrNumber", "prNumber"]);
  const prNumber = pickPositiveInteger(pr, ["number", "githubPrNumber", "prNumber"]);
  const state = pickString(pr, ["state", "status"]) ?? "unknown";
  const draft = pickBoolean(pr, ["isDraft", "draft"]) === true ? " · draft" : "";
  const title = pickString(pr, ["title", "name"]) ?? "Untitled PR";
  const id = pickString(pr, ["id", "prId"]);
  // A PR whose lane was deleted (or moved to another branch) keeps its row and its now
  // dangling `laneId`, so the raw id would read as a live mapping. Show it as history.
  const detached = isRecord(pr.detached) ? pr.detached : null;
  const laneValue = pickString(pr, ["laneName", "laneId"]);
  const lane = detached
    ? `was ${pickString(detached, ["laneName"]) ?? laneValue ?? "deleted lane"}`
    : laneValue;
  const head = pickString(pr, ["headBranch", "headRefName", "branchRef", "branch"]);
  const base = pickString(pr, ["baseBranch", "baseRefName", "baseRef", "targetBranch"]);
  const githubUrl = pickString(root, ["githubUrl", "githubPrUrl"])
    ?? pickString(pr, ["githubUrl", "htmlUrl", "url", "webUrl"]);
  const fallbackUrl = pickString(pr, ["htmlUrl", "url", "webUrl"]);
  const repoOwner = pickString(pr, ["repoOwner", "owner"]);
  const repoName = pickString(pr, ["repoName", "repo"]);
  const derivedAdeUrl = repoOwner && repoName && prNumber
    ? buildDeeplink({ kind: "pr", repoOwner, repoName, prNumber })
    : null;
  const derivedWebUrl = repoOwner && repoName && prNumber
    ? buildWebClientUrl({ kind: "pr", repoOwner, repoName, prNumber })
    : null;
  const adeUrl = pickString(root, ["adeUrl", "adePrUrl"])
    ?? pickString(pr, ["adeUrl", "adePrUrl"])
    ?? derivedAdeUrl;
  const mergeable = pickString(pr, ["mergeable", "mergeStateStatus"]);
  // ADE-135: the PR summary is the first thing `/pr` prints, and it used to say
  // nothing at all about CI — so the reader's only checks signal was the row
  // table below it, which is precisely what read green while nothing verified
  // the commit. The service's rollup (and its one-sentence reason) belongs here.
  const checksStatus = checksStatusLabel(pickString(pr, ["checksStatus"]));
  const checksReason = pickString(pr, ["checksReason"]);
  const checks = checksStatus
    ? `${checksStatus}${checksReason ? ` — ${checksReason}` : ""}`
    : null;
  const rows = [
    `#${number ?? id ?? "?"} · ${state}${draft}`,
    title,
    "",
    id ? `id        ${id}` : null,
    lane ? `lane      ${lane}` : null,
    head || base ? `branch    ${head ?? "unknown"}${base ? ` -> ${base}` : ""}` : null,
    mergeable ? `merge     ${mergeable}` : null,
    checks ? `checks    ${checks}` : null,
    githubUrl ? `github   ${githubUrl}` : null,
    fallbackUrl && fallbackUrl !== githubUrl ? `url      ${fallbackUrl}` : null,
    adeUrl ? `ade      ${adeUrl}` : null,
    derivedWebUrl ? `web      ${derivedWebUrl}` : null,
  ];
  return rows.filter((row): row is string => row != null).join("\n");
}

export type PrMergeReadiness = {
  /** Single-word headline: Ready / Blocked / Behind / Conflicts / Draft / Checking… */
  headline: string;
  /** Longer status line shown beside the headline (mirrors GitHub's merge box). */
  detail: string | null;
  /** Human-readable reasons the merge is held up, in priority order. Empty when ready. */
  blockers: string[];
  /** True while GitHub is still computing mergeability (keep polling). */
  computing: boolean;
  /** True when the viewer can bypass branch protection (admin / bypass permission). */
  canBypass: boolean;
  /** True when nothing is blocking the merge. */
  ready: boolean;
};

/**
 * Derives the same merge-readiness picture the desktop merge box shows from a
 * GitHub-backed PR status payload (the `pr.getStatus` action result, or a
 * `PrSummary`/`PrStatus`-shaped record). Tolerates older runtimes that only
 * expose `mergeConflicts`/`behindBaseBy` by falling back to those fields.
 */
export function derivePrMergeReadiness(value: unknown): PrMergeReadiness {
  const root = unwrapStructured(value);
  const status: JsonRecord = isRecord(root)
    ? (isRecord(root.status) ? root.status : root)
    : {};

  const mergeState = pickString(status, ["mergeStateStatus"])?.toLowerCase() ?? null;
  const reviewDecision = pickString(status, ["reviewDecision"])?.toLowerCase() ?? null;
  const approvals = pickNonNegativeInteger(status, ["approvalsCount"]);
  const requiredApprovals = pickNonNegativeInteger(status, ["requiredApprovals"]);
  const behind = pickNonNegativeInteger(status, ["behindBaseBy", "behindBy"]);
  const conflicts = pickBoolean(status, ["mergeConflicts"]) === true;
  const isMergeable = pickBoolean(status, ["isMergeable", "mergeable"]);
  const canBypass = pickBoolean(status, ["canBypass"]) === true;
  const computing =
    pickBoolean(status, ["mergeabilityComputing"]) === true || mergeState === "unknown";

  const blockers: string[] = [];

  if (reviewDecision === "review_required") {
    const count =
      requiredApprovals != null ? `${approvals ?? 0}/${requiredApprovals}` : `${approvals ?? 0}`;
    blockers.push(`review required (${count} approved)`);
  } else if (reviewDecision === "changes_requested") {
    blockers.push("changes requested");
  }

  // Behind base only hard-blocks when the PR isn't otherwise mergeable. For
  // clean/unstable/has_hooks the PR IS mergeable even when behind, so it's
  // informational — mirror the desktop's buildMergeChecklist treatment.
  const behindMergeable = mergeState === "clean" || mergeState === "unstable" || mergeState === "has_hooks";
  if (behind != null && behind > 0 && !behindMergeable) {
    blockers.push(`${behind} commit${behind === 1 ? "" : "s"} behind base`);
  } else if (mergeState === "behind") {
    blockers.push("behind base branch");
  }

  if (conflicts || mergeState === "dirty") {
    blockers.push("merge conflicts");
  }

  if (mergeState === "draft") blockers.push("PR is a draft");
  // `unstable` = mergeable, but non-required checks are failing/pending. It is
  // NOT a blocker — mirror the desktop's isMergeableFromMergeState treatment, so
  // the TUI lands on "Ready" rather than a false "Blocked — required checks".
  if (mergeState === "blocked" && blockers.length === 0) {
    // `blocked` with no more specific reason → branch protection (needs admin).
    blockers.push("blocked by branch protection");
  }

  // De-dupe while keeping priority order (review → behind → conflicts → checks).
  const seen = new Set<string>();
  const uniqueBlockers = blockers.filter((b) => (seen.has(b) ? false : (seen.add(b), true)));

  let headline: string;
  let detail: string | null = null;
  if (computing) {
    headline = "Checking…";
    detail = "GitHub is computing mergeability.";
  } else if (mergeState === "draft" || uniqueBlockers.includes("PR is a draft")) {
    headline = "Draft";
  } else if (conflicts || mergeState === "dirty") {
    headline = "Conflicts";
  } else if (mergeState === "behind") {
    headline = "Behind";
  } else if (uniqueBlockers.length > 0) {
    headline = "Blocked";
  } else if (mergeState === "clean" || mergeState === "has_hooks" || mergeState === "unstable" || isMergeable === true) {
    // Mergeable (incl. `unstable` = non-required checks failing) → Ready even when
    // behind, mirroring the desktop's isMergeableFromMergeState. Checked BEFORE the
    // bare-behind branch so a mergeable-but-behind PR isn't mislabeled "Behind".
    headline = "Ready";
  } else if (behind != null && behind > 0) {
    // Behind base with no other blocker and no explicit merge-state signal.
    headline = "Behind";
  } else if (mergeState) {
    headline = "Blocked";
  } else {
    headline = uniqueBlockers.length ? "Blocked" : "Ready";
  }

  const ready = !computing && uniqueBlockers.length === 0 && headline !== "Conflicts" && headline !== "Behind" && headline !== "Draft";

  return {
    headline,
    detail,
    blockers: uniqueBlockers,
    computing,
    canBypass,
    ready,
  };
}

/**
 * Compact merge-readiness block for the right pane: a status line plus a short
 * bullet list of blockers. Falls back to a single line when GitHub merge state
 * is unavailable (older runtimes / unmapped PRs).
 */
export function formatPrMergeState(value: unknown): string {
  const readiness = derivePrMergeReadiness(value);
  const lines = [`Merge · ${readiness.headline}${readiness.detail ? ` — ${readiness.detail}` : ""}`];
  if (readiness.blockers.length) {
    for (const blocker of readiness.blockers) lines.push(`  ✗ ${blocker}`);
    if (readiness.canBypass) {
      lines.push("", "You can bypass branch protection: /pr land confirm <method> bypass");
    }
  } else if (readiness.ready) {
    lines.push("  ✓ all requirements met");
  }
  return lines.join("\n");
}

export function formatPrChecks(value: unknown): string {
  const failure = prReadFailure(value);
  if (failure) return `PR checks · could not be read — ${failure}`;
  const root = unwrapStructured(value);
  const rollup = isRecord(root) ? pickString(root, ["checksStatus"]) : null;
  const reason = isRecord(root) ? pickString(root, ["checksReason"]) : null;
  const checks = firstRecordArray(value, ["checks", "items", "results"]);
  if (!checks.length) {
    return rollup === "not_run"
      ? `CI: not run — ${reason ?? NO_CI_REASON}`
      : "No PR checks.";
  }
  // ADE-135: counting the rows directly is producer-blind — three third-party
  // successes tallied as "3 passing". `rollupPrChecks` applies the same CI
  // producer rule as every other surface. The payload's own `checksStatus`
  // still wins when present, since it also knows about required contexts,
  // which these rows cannot see.
  const rows = checks.map((check) => ({
    status: pickString(check, ["status"]) ?? "",
    conclusion: pickString(check, ["conclusion"]),
    appSlug: pickString(check, ["appSlug"]),
  }));
  const rowRollup = rollupPrChecks(rows);
  const ok = rowRollup.counts.passing;
  const fail = rowRollup.counts.failing;
  const wait = rowRollup.counts.pending;
  // A supplied canonical `checksStatus` is authoritative: only the host knows
  // about required contexts, the merge box, and the grace window. The row
  // fallback speaks only when the payload carried no verdict at all — letting
  // it override a supplied `passing` would contradict the contract above.
  const notRun = rollup ? rollup === "not_run" : rowRollup.status === "not_run";
  const summary = notRun
    ? `CI: not run${reason ? ` — ${reason}` : ""}`
    : [ok ? `${ok} passing` : null, fail ? `${fail} failing` : null, wait ? `${wait} pending` : null]
      .filter(Boolean)
      .join(" · ") || `${checks.length} check${checks.length === 1 ? "" : "s"}`;
  return [
    `PR checks · ${summary}`,
    "",
    ...checks.slice(0, 16).map((check) => {
      const status = statusWord(check.status, check.conclusion).padEnd(4);
      const name = truncate(pickString(check, ["name", "context", "workflowName"]) ?? "unnamed check", 72);
      const when = shortIso(check.completedAt ?? check.startedAt);
      return `${status} ${name}${when ? ` · ${when}` : ""}`;
    }),
  ].join("\n");
}

/** reviews + threads + comments — the three independent reads behind `/pr review`. */
const PR_REVIEW_SOURCES = 3;

export function formatPrReview(value: unknown): string {
  const root = unwrapStructured(value);
  const reviews = firstRecordArray(root, ["reviews"]);
  const threads = firstRecordArray(root, ["reviewThreads", "threads"]);
  const comments = firstRecordArray(root, ["comments", "issueComments"]);
  // Three independent reads land here, each caught into its own `{ error }`,
  // so a partial outage is normal: name the sources that failed rather than
  // reporting their absence as "0 reviews".
  const failures: Array<[label: string, message: string]> = [];
  for (const [label, part] of [
    ["reviews", isRecord(root) ? root.reviews : null],
    ["threads", isRecord(root) ? (root.reviewThreads ?? root.threads) : null],
    ["comments", isRecord(root) ? (root.comments ?? root.issueComments) : null],
  ] satisfies Array<[string, unknown]>) {
    const message = prReadFailure(part);
    if (message) failures.push([label, message]);
  }
  const rootFailure = prReadFailure(root);
  if (rootFailure) return `PR review · could not be read — ${rootFailure}`;
  if (failures.length === PR_REVIEW_SOURCES) {
    return [
      "PR review · could not be read",
      ...failures.map(([label, message]) => `  ✗ ${label}: ${message}`),
    ].join("\n");
  }
  // A source that failed has no count to report — printing `0 reviews` would
  // state as fact the very thing the read could not establish.
  const failed = new Set(failures.map(([label]) => label));
  const headerCount = (label: string, noun: string, count: number): string =>
    failed.has(label) ? `${noun}s unavailable` : formatCount(noun, count);
  const lines = [
    `PR review · ${headerCount("reviews", "review", reviews.length)}`
    + ` · ${headerCount("threads", "thread", threads.length)}`
    + ` · ${headerCount("comments", "comment", comments.length)}`,
  ];
  if (reviews.length) {
    lines.push("", "Reviews");
    for (const review of reviews.slice(0, 8)) {
      const state = statusWord(review.state, review.conclusion);
      const who = pickString(review, ["reviewer", "author", "user"]) ?? "unknown";
      const body = truncate(review.body, 76);
      lines.push(`- ${state} ${who}${body ? `: ${body}` : ""}`);
    }
  }
  if (threads.length) {
    lines.push("", "Review threads");
    for (const thread of threads.slice(0, 8)) {
      const state = pickBoolean(thread, ["isResolved", "resolved"]) ? "resolved" : "open";
      const commentsInThread = Array.isArray(thread.comments) ? thread.comments.filter(isRecord) : [];
      const firstComment = commentsInThread[0] ?? thread;
      lines.push(`- ${state} ${threadLocation(thread)} · ${commentPreview(firstComment)}`);
    }
  }
  if (comments.length) {
    lines.push("", "Issue comments");
    for (const comment of comments.slice(0, 8)) {
      lines.push(`- ${commentPreview(comment)}`);
    }
  }
  if (failures.length > 0) {
    lines.push("", "Could not be read");
    for (const [label, message] of failures) lines.push(`  ✗ ${label}: ${message}`);
  } else if (!reviews.length && !threads.length && !comments.length) {
    lines.push("", "No PR reviews or comments.");
  }
  return lines.join("\n");
}

export function formatPrComments(value: unknown): string {
  const failure = prReadFailure(value);
  if (failure) return `PR comments · could not be read — ${failure}`;
  const root = unwrapStructured(value);
  const summary = isRecord(root) && isRecord(root.summary) ? root.summary : null;
  const threads = firstRecordArray(root, ["reviewThreads", "threads"]);
  const comments = firstRecordArray(root, ["comments", "issueComments"]);
  const headerParts = [
    summary ? checksStatusWord(pickString(summary, ["checksStatus"])) : null,
    summary ? `${asString(summary.actionableComments) ?? "0"} actionable` : null,
  ].filter(Boolean);
  // The aggregate reports a failed thread read rather than flattening it to an
  // empty list, so a partial answer is normal here: name the source that failed
  // instead of letting "GitHub refused" read as "nothing to action".
  const threadsUnavailable = isRecord(root) ? asString(root.reviewThreadsUnavailable) : null;
  const lines = [`PR comments${headerParts.length ? ` · ${headerParts.join(" · ")}` : ""}`];
  if (threads.length) {
    lines.push("", "Review threads");
    for (const thread of threads.slice(0, 10)) {
      const state = pickBoolean(thread, ["isResolved", "resolved"]) ? "resolved" : "open";
      const commentsInThread = Array.isArray(thread.comments) ? thread.comments.filter(isRecord) : [];
      const firstComment = commentsInThread[0] ?? thread;
      lines.push(`- ${state} ${threadLocation(thread)} · ${commentPreview(firstComment)}`);
    }
  }
  if (comments.length) {
    lines.push("", "Issue comments");
    for (const comment of comments.slice(0, 10)) {
      lines.push(`- ${commentPreview(comment)}`);
    }
  }
  if (threadsUnavailable) {
    lines.push("", "Could not be read", `  ✗ review threads: ${threadsUnavailable}`);
  } else if (!threads.length && !comments.length) {
    lines.push("", "No actionable PR comments.");
  }
  return lines.join("\n");
}

export function formatLinearStatus(value: unknown): string {
  const root = unwrapStructured(value);
  if (!isRecord(root)) return "Linear status is not available.";
  const connected = pickBoolean(root, ["connected"]);
  const tokenStored = pickBoolean(root, ["tokenStored"]);
  const oauthAvailable = pickBoolean(root, ["oauthAvailable"]);
  const rows = [
    ["connected", connected == null ? "unknown" : connected ? "yes" : "no"],
    ["token", tokenStored == null ? "unknown" : tokenStored ? "stored" : "missing"],
    ["auth", pickString(root, ["authMode"]) ?? "unknown"],
    ["oauth", oauthAvailable == null ? "unknown" : oauthAvailable ? "available" : "unavailable"],
    ["viewer", pickString(root, ["viewerName", "viewerId"]) ?? "not signed in"],
    ["org", pickString(root, ["organizationName", "organizationUrlKey", "organizationId"]) ?? "unknown"],
    ["expires", shortIso(root.tokenExpiresAt) ?? "unknown"],
    ["checked", shortIso(root.checkedAt) ?? "unknown"],
  ];
  return rows.map(([key, rowValue]) => `${key.padEnd(10)} ${rowValue}`).join("\n");
}

export function formatLinearIssueComments(value: unknown): string {
  const items = Array.isArray(value) ? value.filter(isRecord) : [];
  if (!items.length) return "No comments on this issue.";
  const lines = [`${items.length} comment${items.length === 1 ? "" : "s"}`];
  for (const item of items.slice(0, 20)) {
    const who = pickString(item, ["userDisplayName", "userName"]) ?? "unknown";
    const when = shortIso(item.createdAt);
    const body = truncate(item.body, 80);
    lines.push("", `${who}${when ? `  ${when}` : ""}`, body || "(empty)");
  }
  if (items.length > 20) lines.push("", `… and ${items.length - 20} more`);
  return lines.join("\n");
}

// /cloud pane. Read-only by design: open/stop/pull/archive/delete need lane
// and ownership context the terminal does not have, so the pane only answers
// "what is running and how old is it" and points management at desktop/iOS.
export const CURSOR_CLOUD_PANE_NOTE = "Read-only here — manage agents on desktop or iOS.";

function cursorCloudFleetStatusGlyph(status: string): string {
  if (status === "running") return "●";
  if (status === "finished" || status === "completed") return "✓";
  if (status === "error" || status === "failed" || status === "cancelled") return "✗";
  return "○";
}

function cursorCloudFleetCreatedAt(entry: CursorCloudFleetEntry): number {
  const raw = entry.agent.createdAt ?? entry.agent.lastModified ?? null;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * One line per fleet entry for the /cloud right-pane list: running agents
 * first, each group newest first. The short agent id is appended only when the
 * composed row fits the default pane width, so narrow terminals clip nothing.
 */
export function formatCursorCloudFleetRows(entries: CursorCloudFleetEntry[]): string[] {
  const ordered = [...entries].sort((left, right) => {
    const leftRunning = (left.runStatus ?? left.agent.status)?.toLowerCase() === "running" ? 0 : 1;
    const rightRunning = (right.runStatus ?? right.agent.status)?.toLowerCase() === "running" ? 0 : 1;
    if (leftRunning !== rightRunning) return leftRunning - rightRunning;
    return cursorCloudFleetCreatedAt(right) - cursorCloudFleetCreatedAt(left);
  });
  // DEFAULT_PANE_WIDTH (38) minus the four cells the list renderer reserves.
  const rowBudget = 34;
  return ordered.map((entry) => {
    const name = entry.agent.name?.trim() || entry.agent.agentId;
    const status = entry.runStatus ?? entry.agent.status ?? "queued";
    const age = formatCursorCloudAge(cursorCloudFleetCreatedAt(entry) || null);
    let row = `${cursorCloudFleetStatusGlyph(status.toLowerCase())} ${name} · ${status.toLowerCase()}${age ? ` · ${age}` : ""}`;
    const agentId = entry.agent.agentId?.trim();
    if (agentId && row.length + 3 + agentId.length <= rowBudget) row += ` · ${agentId}`;
    return row;
  });
}
