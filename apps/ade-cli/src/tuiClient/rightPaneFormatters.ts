import { buildDeeplink } from "../../../desktop/src/shared/deeplinks";
import { buildWebClientUrl } from "../../../desktop/src/shared/webClientUrl";

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
  const rows = [
    `#${number ?? id ?? "?"} · ${state}${draft}`,
    title,
    "",
    id ? `id        ${id}` : null,
    lane ? `lane      ${lane}` : null,
    head || base ? `branch    ${head ?? "unknown"}${base ? ` -> ${base}` : ""}` : null,
    mergeable ? `merge     ${mergeable}` : null,
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
  const checks = firstRecordArray(value, ["checks", "items", "results"]);
  if (!checks.length) return "No PR checks.";
  let ok = 0;
  let fail = 0;
  let wait = 0;
  for (const check of checks) {
    const status = statusWord(check.status, check.conclusion);
    if (status === "OK") ok += 1;
    else if (status === "FAIL") fail += 1;
    else if (status === "WAIT") wait += 1;
  }
  const summary = [ok ? `${ok} passing` : null, fail ? `${fail} failing` : null, wait ? `${wait} pending` : null]
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

export function formatPrReview(value: unknown): string {
  const root = unwrapStructured(value);
  const reviews = firstRecordArray(root, ["reviews"]);
  const threads = firstRecordArray(root, ["reviewThreads", "threads"]);
  const comments = firstRecordArray(root, ["comments", "issueComments"]);
  const lines = [
    `PR review · ${formatCount("review", reviews.length)} · ${formatCount("thread", threads.length)} · ${formatCount("comment", comments.length)}`,
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
  if (!reviews.length && !threads.length && !comments.length) lines.push("", "No PR reviews or comments.");
  return lines.join("\n");
}

export function formatPrComments(value: unknown): string {
  const root = unwrapStructured(value);
  const summary = isRecord(root) && isRecord(root.summary) ? root.summary : null;
  const threads = firstRecordArray(root, ["reviewThreads", "threads"]);
  const comments = firstRecordArray(root, ["comments", "issueComments"]);
  const headerParts = [
    summary ? pickString(summary, ["checksStatus"]) : null,
    summary ? `${asString(summary.actionableComments) ?? "0"} actionable` : null,
  ].filter(Boolean);
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
  if (!threads.length && !comments.length) lines.push("", "No actionable PR comments.");
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
