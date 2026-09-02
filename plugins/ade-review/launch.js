// Reading the Review launch form into the `review.startRun` args the host
// already answers. The compiled dialog (`ReviewPage.tsx`,
// `PrRequestAiReviewDialog.tsx`) is the source of the fields and the defaults.

"use strict";

const { readString, TARGET_MODE_LABELS } = require("./format");

const TARGET_MODES = ["lane_diff", "commit_range", "working_tree", "pr"];
const COMPARE_KINDS = ["default_branch", "lane"];
const PUBLISH_BEHAVIORS = ["local_only", "auto_publish"];
const DEFAULT_MODEL_ID = "openai/gpt-5.6-sol";
const DEFAULT_REASONING = "low";
const REASONING_EFFORT_DEFAULT = "default";

const REASONING_EFFORTS = [
  { value: REASONING_EFFORT_DEFAULT, label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

function readBool(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function chosenReasoningEffort(value) {
  const text = readString(value);
  return text && text !== REASONING_EFFORT_DEFAULT ? text : null;
}

function readTargetMode(value) {
  const text = readString(value);
  return TARGET_MODES.includes(text) ? text : "lane_diff";
}

function readCompareKind(value) {
  const text = readString(value);
  return COMPARE_KINDS.includes(text) ? text : "default_branch";
}

function readPublishBehavior(value) {
  const text = readString(value);
  return PUBLISH_BEHAVIORS.includes(text) ? text : "local_only";
}

/**
 * Fields a reader typed, plus the live context a PR toolbar press already has.
 *
 * A form field that is empty is unset, not a SHA named "". The PR path can
 * name a `prId` without opening the form — that is how compiled "ADE review"
 * launched from the rail.
 */
function readLaunchForm(args = {}) {
  const context = args.context && typeof args.context === "object" ? args.context : null;
  const fromPr = context?.kind === "pr";
  const targetMode = fromPr && !readString(args.targetMode) ? "pr" : readTargetMode(args.targetMode);
  const laneId = readString(args.laneId)
    ?? (fromPr ? readString(context.laneId) : null)
    ?? (context?.kind === "lane" ? readString(context.id) : null)
    ?? (context?.kind === "composer" ? readString(context.laneId) : null);
  const prId = readString(args.prId) ?? (fromPr ? readString(context.id) : null);
  const fast = readBool(args.fastMode);
  return {
    laneId,
    targetMode,
    compareKind: readCompareKind(args.compareKind),
    compareLaneId: readString(args.compareLaneId),
    baseCommit: readString(args.baseCommit),
    headCommit: readString(args.headCommit),
    prId,
    modelId: readString(args.modelId) ?? DEFAULT_MODEL_ID,
    reasoningEffort: chosenReasoningEffort(args.reasoningEffort) ?? DEFAULT_REASONING,
    fastMode: fast === true,
    publishBehavior: fromPr && !readString(args.publishBehavior)
      ? "auto_publish"
      : readPublishBehavior(args.publishBehavior),
  };
}

function validationMessage(form) {
  if (form.targetMode === "pr" && !form.laneId) {
    return "ADE review diffs a local checkout. Open this pull request as a lane first.";
  }
  if (!form.laneId) return "Choose a lane before launching a review.";
  if (form.targetMode === "lane_diff" && form.compareKind === "lane" && !form.compareLaneId) {
    return "Choose another lane to compare against.";
  }
  if (form.targetMode === "commit_range" && (!form.baseCommit || !form.headCommit)) {
    return "Pick the earlier commit, then the later commit.";
  }
  if (form.targetMode === "pr" && !form.prId) {
    return "This pull request is not linked in ADE yet.";
  }
  return null;
}

function buildTargetConfig(form) {
  const config = {
    compareAgainst: form.targetMode === "lane_diff" && form.compareKind === "lane" && form.compareLaneId
      ? { kind: "lane", laneId: form.compareLaneId }
      : { kind: "default_branch" },
    selectionMode: form.targetMode === "commit_range"
      ? "selected_commits"
      : form.targetMode === "working_tree"
        ? "dirty_only"
        : "full_diff",
    dirtyOnly: form.targetMode === "working_tree",
    modelId: form.modelId,
    reasoningEffort: form.reasoningEffort,
    fastMode: form.fastMode,
    publishBehavior: form.publishBehavior,
  };

  if (form.targetMode === "commit_range") {
    return {
      target: {
        mode: "commit_range",
        laneId: form.laneId,
        baseCommit: form.baseCommit,
        headCommit: form.headCommit,
      },
      config,
    };
  }
  if (form.targetMode === "working_tree") {
    return { target: { mode: "working_tree", laneId: form.laneId }, config };
  }
  if (form.targetMode === "pr") {
    return { target: { mode: "pr", laneId: form.laneId, prId: form.prId }, config };
  }
  return { target: { mode: "lane_diff", laneId: form.laneId }, config };
}

function readRunId(result) {
  if (typeof result === "string") return readString(result);
  if (result && typeof result === "object") {
    return readString(result.runId) ?? readString(result.id);
  }
  return null;
}

function commitOptions(commits) {
  const list = Array.isArray(commits) ? commits : [];
  return list.slice(0, 40).map((commit) => {
    const sha = readString(commit?.sha);
    if (!sha) return null;
    const short = readString(commit.shortSha) ?? sha.slice(0, 7);
    const subject = readString(commit.subject) ?? sha;
    return { value: sha, label: `${short} ${subject}`.slice(0, 80) };
  }).filter(Boolean);
}

function laneOptions(lanes) {
  const list = Array.isArray(lanes) ? lanes : [];
  return list.slice(0, 40).map((lane) => ({
    value: readString(lane?.id) ?? "",
    label: readString(lane?.name) ?? readString(lane?.id) ?? "Lane",
  })).filter((option) => option.value);
}

module.exports = {
  DEFAULT_MODEL_ID,
  DEFAULT_REASONING,
  REASONING_EFFORTS,
  TARGET_MODES,
  TARGET_MODE_LABELS,
  buildTargetConfig,
  commitOptions,
  laneOptions,
  readLaunchForm,
  readRunId,
  validationMessage,
};
