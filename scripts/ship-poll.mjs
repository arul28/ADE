#!/usr/bin/env node
/**
 * One poll of a PR for the ship loop: CI, review bots, open review threads,
 * review-body findings, new comments and base movement, read together.
 *
 * The ship loop missed review work when an agent wrote its own poll and read
 * only part of this: a time-filtered comment query drops a review that landed
 * while CI ran, and CodeRabbit puts some findings in the review body, outside
 * any thread. This script reads every surface on every run, so a poll cannot
 * be partial. `next` says what the loop does now.
 *
 *   node scripts/ship-poll.mjs [--pr <n>] [--state <path>] [--text]
 *
 * The state file (`.ade/shipLane/<branch>.json`) supplies `addressedCommentIds`
 * and `addressedReviewFindings`; handled work does not come back.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Status checks that are review bots, not CI. */
const REVIEW_BOT_CHECK = /coderabbit|greptile|devin|bugbot|codex|copilot/i;
/** A bot comment that says the bot did not review, or will not review the next push. */
const BOT_NOTICE = /couldn['’]?t run|usage limit|rate[- ]limit|0 remain|not posted on this PR|review(?:s)? (?:paused|skipped)/i;
const PENDING_CHECK_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);

/**
 * Findings a bot wrote in its review body because they sit outside the diff.
 * CodeRabbit lists them under "Outside diff range comments", one `<details>`
 * block each, with a stable `cr-comment:v1:<id>` marker.
 */
export function parseOutsideDiffFindings(reviewBody, reviewId) {
  const body = String(reviewBody ?? "").replace(/^> ?/gm, "");
  const start = body.search(/Outside diff range comments/i);
  if (start === -1) return [];
  const section = body.slice(start);
  const end = section.search(/\n---\n/);
  const scoped = end === -1 ? section : section.slice(0, end);
  // A finding's own summary names its file (`<code>file:line</code>`); nested
  // blocks inside it (the agent prompt, an analysis chain) do not.
  const entries = [...scoped.matchAll(/<summary>(.*?)<\/summary>/g)]
    .filter((match) => /<code>[^<]+:\d+(?:-\d+)?<\/code>/.test(match[1]));
  const findings = [];
  for (const [index, match] of entries.entries()) {
    const summary = match[1];
    const restEnd = entries[index + 1]?.index ?? scoped.length;
    const rest = scoped.slice(match.index + match[0].length, restEnd);
    const location = rest.match(/`([^`\s]+):(\d+)(?:-\d+)?`/) ?? summary.match(/<code>([^<]+):(\d+)<\/code>/);
    const title = rest.match(/\*\*([^*]+)\*\*/)?.[1]
      ?? summary.split("·").map((part) => part.trim()).filter(Boolean)[1]
      ?? summary.replace(/<[^>]+>/g, "").trim();
    const marker = rest.match(/cr-comment:v1:([0-9a-f]+)/)?.[1];
    findings.push({
      key: marker ? `cr:${marker}` : `review:${reviewId}:${findings.length}`,
      reviewId,
      title: title.trim(),
      path: location?.[1] ?? null,
      line: location ? Number(location[2]) : null,
    });
  }
  return findings;
}

const isBot = (login) => /\[bot\]$/.test(login ?? "");

/**
 * The poll summary. Pure: every input is data the caller fetched.
 *
 * @param {object} input
 * @param {{state:string,isDraft:boolean,mergeStateStatus:string,headRefOid:string,baseRefName:string}} input.pr
 * @param {Array<{name:string,state:string,bucket?:string,link?:string}>} input.checks
 * @param {Array} input.issueComments  GitHub issue comments on the PR.
 * @param {Array} input.reviews        GitHub PR reviews.
 * @param {Array} input.threads        GraphQL reviewThreads nodes.
 * @param {number} input.behindBy      Commits the base has that the PR head lacks.
 * @param {boolean} input.localAhead   Local HEAD has commits the remote head lacks.
 * @param {object} input.state         Ship state file contents (may be empty).
 */
export function summarizePoll({ pr, checks, issueComments, reviews, threads, behindBy, localAhead, state }) {
  const addressedComments = new Set((state?.addressedCommentIds ?? []).map(Number));
  const addressedFindings = new Set(state?.addressedReviewFindings ?? []);
  const lastPushAt = state?.lastPushAt ?? null;

  const ciChecks = checks.filter((check) => !REVIEW_BOT_CHECK.test(check.name));
  const botChecks = checks.filter((check) => REVIEW_BOT_CHECK.test(check.name));
  const pending = (check) => PENDING_CHECK_STATES.has(String(check.state).toUpperCase()) || check.bucket === "pending";
  const failed = (check) => check.bucket === "fail" || /^(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED)$/i.test(check.state);
  const ciRunning = ciChecks.filter(pending).map((check) => check.name);
  const ciFailed = ciChecks.filter(failed).map((check) => ({ name: check.name, link: check.link ?? null }));
  const pendingReviewBots = botChecks.filter(pending).map((check) => check.name);

  const openThreads = threads
    .filter((thread) => !thread.isResolved)
    .map((thread) => {
      const first = thread.comments?.nodes?.[0] ?? {};
      return {
        threadId: thread.id,
        commentId: first.databaseId ?? null,
        author: first.author?.login ?? null,
        path: first.path ?? null,
        outdated: Boolean(thread.isOutdated),
        // Handled in code but not yet answered: reply with the fix or the
        // reason it was rejected, then resolve. Not merge-ready until then.
        addressed: addressedComments.has(Number(first.databaseId)),
      };
    });

  const reviewFindings = reviews
    .filter((review) => isBot(review.user?.login))
    .flatMap((review) => parseOutsideDiffFindings(review.body, review.id).map((finding) => ({
      ...finding,
      author: review.user.login,
      submittedAt: review.submitted_at,
    })))
    .filter((finding, index, all) => all.findIndex((other) => other.key === finding.key) === index)
    .filter((finding) => !addressedFindings.has(finding.key));

  const sincePush = (timestamp) => !lastPushAt || (timestamp && timestamp > lastPushAt);
  const newComments = [
    ...issueComments
      .filter((comment) => !isBot(comment.user?.login) && !addressedComments.has(Number(comment.id)))
      .filter((comment) => sincePush(comment.created_at))
      .map((comment) => ({ id: comment.id, author: comment.user?.login, type: "issue", body: comment.body })),
    ...reviews
      .filter((review) => !isBot(review.user?.login) && (review.state === "CHANGES_REQUESTED" || String(review.body ?? "").trim()))
      .filter((review) => !addressedComments.has(Number(review.id)) && sincePush(review.submitted_at))
      .map((review) => ({ id: review.id, author: review.user?.login, type: "review", state: review.state, body: review.body })),
  ];

  // A bot whose newest word is a notice: one that could not run reviewed
  // nothing. A notice the same bot has since followed with a review is history.
  const newestByBot = new Map();
  for (const item of [...issueComments, ...reviews]) {
    const login = item.user?.login;
    const at = item.created_at ?? item.submitted_at;
    if (!isBot(login) || !String(item.body ?? "").trim()) continue;
    const previous = newestByBot.get(login);
    if (!previous || at > previous.at) newestByBot.set(login, { at, item });
  }
  const noticeByBot = new Map();
  for (const [login, { at, item }] of newestByBot) {
    if (!BOT_NOTICE.test(item.body ?? "")) continue;
    const line = String(item.body).split("\n")
      .map((part) => part.replace(/<[^>]+>/g, "").replace(/\(?\[([^\]]*)\]\([^)]*\)\)?/g, "").replace(/\*\*/g, "").trim())
      .find((part) => BOT_NOTICE.test(part)) ?? "";
    noticeByBot.set(login, { bot: login, at, notice: line.slice(0, 200) });
  }

  const merged = pr.state === "MERGED";
  const conflicting = pr.mergeStateStatus === "DIRTY";
  const behindBase = behindBy > 0 || pr.mergeStateStatus === "BEHIND" || conflicting;
  const unaddressedThreads = openThreads.filter((thread) => !thread.addressed);
  const fixWork = ciFailed.length > 0 || unaddressedThreads.length > 0 || reviewFindings.length > 0
    || newComments.length > 0 || localAhead;
  const waiting = ciRunning.length > 0 || pendingReviewBots.length > 0;

  let next;
  if (merged) next = "merged";
  else if (pr.state !== "OPEN") next = "closed";
  else if (behindBase) next = "rebase";
  else if (waiting) next = "wait";
  else if (fixWork) next = "fix";
  else if (openThreads.length > 0) next = "resolve-threads";
  else if (pr.isDraft) next = "mark-ready";
  else next = "merge";

  return {
    next,
    headSha: pr.headRefOid,
    baseBranch: pr.baseRefName,
    merged,
    behindBase,
    conflicting,
    ciRunning,
    ciFailed,
    reviewBotsRunning: pendingReviewBots.length > 0,
    pendingReviewBots,
    openThreads,
    reviewFindings,
    newComments,
    botNotices: [...noticeByBot.values()],
    localAhead,
  };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

const THREADS_QUERY = `query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated comments(first:1){nodes{databaseId author{login} path}}}}}}}`;

function fetchThreads(owner, repo, number) {
  const nodes = [];
  let after = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `o=${owner}`, "-F", `r=${repo}`, "-F", `n=${number}`];
    if (after) args.push("-f", `after=${after}`);
    const page = JSON.parse(run("gh", args)).data.repository.pullRequest.reviewThreads;
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    after = page.pageInfo.endCursor;
  }
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const options = { pr: null, statePath: null, text: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pr") options.pr = argv[++index];
    else if (arg === "--state") options.statePath = argv[++index];
    else if (arg === "--text") options.text = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function formatText(summary) {
  const lines = [`next: ${summary.next}  head ${summary.headSha.slice(0, 9)} → ${summary.baseBranch}${summary.behindBase ? " (behind base)" : ""}`];
  lines.push(`ci: ${summary.ciRunning.length} running, ${summary.ciFailed.length} failed${summary.ciFailed.map((check) => `\n  FAIL ${check.name} ${check.link ?? ""}`).join("")}`);
  lines.push(`review bots running: ${summary.pendingReviewBots.join(", ") || "none"}`);
  lines.push(`open threads: ${summary.openThreads.length}${summary.openThreads.map((thread) => `\n  ${thread.addressed ? "answer+resolve" : "FIX"} ${thread.commentId} ${thread.author} ${thread.path ?? ""}${thread.outdated ? " (outdated)" : ""}`).join("")}`);
  lines.push(`review-body findings: ${summary.reviewFindings.length}${summary.reviewFindings.map((finding) => `\n  ${finding.key} ${finding.author} ${finding.path ?? ""}:${finding.line ?? ""} ${finding.title}`).join("")}`);
  lines.push(`new comments: ${summary.newComments.length}${summary.newComments.map((comment) => `\n  ${comment.id} ${comment.author} (${comment.type})`).join("")}`);
  lines.push(`bot notices: ${summary.botNotices.length}${summary.botNotices.map((notice) => `\n  ${notice.bot}: ${notice.notice}`).join("")}`);
  if (summary.localAhead) lines.push("local HEAD is ahead of the remote head (held commits)");
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = run("git", ["rev-parse", "--show-toplevel"]);
  const branch = run("git", ["branch", "--show-current"]);
  const pr = JSON.parse(run("gh", [
    "pr", "view", ...(options.pr ? [options.pr] : []),
    "--json", "number,state,isDraft,mergeStateStatus,headRefOid,headRefName,baseRefName,url",
  ]));
  const [owner, repo] = new URL(pr.url).pathname.split("/").filter(Boolean);
  const statePath = options.statePath
    ?? path.join(root, ".ade", "shipLane", `${pr.headRefName.replaceAll("/", "__")}.json`);
  // `gh pr checks` exits non-zero while a check is pending or has failed; its
  // JSON is still the answer.
  let checksJson;
  try {
    checksJson = run("gh", ["pr", "checks", String(pr.number), "--json", "name,state,bucket,link"]);
  } catch (error) {
    checksJson = String(error.stdout ?? "").trim();
    if (!checksJson) throw error;
  }
  const checks = JSON.parse(checksJson || "[]");
  const slurp = (endpoint) => JSON.parse(run("gh", ["api", "--paginate", "--slurp", endpoint])).flat();
  const issueComments = slurp(`repos/${owner}/${repo}/issues/${pr.number}/comments`);
  const reviews = slurp(`repos/${owner}/${repo}/pulls/${pr.number}/reviews`);
  const threads = fetchThreads(owner, repo, pr.number);
  const behindBy = Number(run("gh", [
    "api", `repos/${owner}/${repo}/compare/${pr.baseRefName}...${pr.headRefOid}`, "-q", ".behind_by",
  ])) || 0;
  let localAhead = false;
  if (branch === pr.headRefName) {
    try {
      localAhead = Number(run("git", ["rev-list", "--count", `${pr.headRefOid}..HEAD`], { cwd: root })) > 0;
    } catch {
      // The remote head is not in this clone yet; fetch it to compare.
      run("git", ["fetch", "origin", pr.headRefName], { cwd: root });
      localAhead = Number(run("git", ["rev-list", "--count", `${pr.headRefOid}..HEAD`], { cwd: root })) > 0;
    }
  }
  const summary = summarizePoll({
    pr, checks, issueComments, reviews, threads, behindBy, localAhead, state: readState(statePath),
  });
  process.stdout.write(options.text ? `${formatText(summary)}\n` : `${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ship-poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
