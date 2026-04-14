/**
 * Human-readable naming map for all workflow fields and enum values.
 * Single source of truth -- used by pipeline builder, tooltips, YAML preview.
 */

import type { LinearWorkflowDefinition } from "../../../../shared/types/linearSync";

/* ── Field labels ── */

export type FieldTier = "essential" | "advanced" | "expert" | "hidden";

export type FieldLabel = {
  displayName: string;
  description: string;
  tier: FieldTier;
};

export const FIELD_LABELS: Record<string, FieldLabel> = {
  // Basics
  "name": { displayName: "Workflow Name", description: "A short name to identify this workflow.", tier: "essential" },
  "enabled": { displayName: "Active", description: "Turn this workflow on or off without deleting it.", tier: "essential" },
  "priority": { displayName: "Priority Rank", description: "Higher numbers match first when multiple workflows could fire.", tier: "advanced" },
  "description": { displayName: "Description", description: "A note for your team about what this workflow does.", tier: "essential" },
  "source": { displayName: "Source", description: "Whether this workflow was created in the editor or loaded from YAML.", tier: "hidden" },

  // Triggers
  "triggers.assignees": { displayName: "Assigned To", description: "Fire when the issue is assigned to any of these people.", tier: "essential" },
  "triggers.labels": { displayName: "Issue Labels", description: "Fire when the issue has any of these labels.", tier: "essential" },
  "triggers.projectSlugs": { displayName: "Projects", description: "Fire only for issues in these Linear projects.", tier: "advanced" },
  "triggers.teamKeys": { displayName: "Teams", description: "Fire only for issues belonging to these Linear teams.", tier: "advanced" },
  "triggers.priority": { displayName: "Priority Level", description: "Fire only when issue priority matches.", tier: "advanced" },
  "triggers.stateTransitions": { displayName: "State Changes", description: "Fire when an issue transitions between specific states.", tier: "expert" },
  "triggers.owner": { displayName: "Issue Owner", description: "Fire when the issue owner matches.", tier: "expert" },
  "triggers.creator": { displayName: "Created By", description: "Fire when the issue was created by one of these people.", tier: "expert" },
  "triggers.metadataTags": { displayName: "Metadata Tags", description: "Fire when the issue has these custom metadata tags.", tier: "expert" },

  // Routing
  "routing.watchOnly": { displayName: "Monitor Only", description: "Match and log issues but do not launch any work.", tier: "advanced" },
  "routing.metadataTags": { displayName: "Route Tags", description: "Tags attached to matched routes for dashboard filtering.", tier: "expert" },

  // Target
  "target.type": { displayName: "Action Type", description: "What kind of work ADE launches when this workflow fires.", tier: "essential" },
  "target.runMode": { displayName: "Autonomy Level", description: "How much freedom the agent has to act without asking.", tier: "essential" },
  "target.employeeIdentityKey": { displayName: "Assigned Agent", description: "Which ADE agent receives the work (blank = match Linear assignee).", tier: "essential" },
  "target.executorKind": { displayName: "Executor Role", description: "Whether the CTO, a named agent, or a background worker handles it.", tier: "advanced" },
  "target.laneSelection": { displayName: "Lane strategy", description: "How ADE creates or picks a lane for this work.", tier: "essential" },
  "target.sessionReuse": { displayName: "Session Handling", description: "Continue in an existing chat or start a fresh one.", tier: "essential" },
  "target.freshLaneName": { displayName: "Custom lane name", description: "Override the default lane name (defaults to issue ID + title).", tier: "advanced" },
  "target.workerSelector": { displayName: "Worker Selection", description: "How to pick which background worker handles this work.", tier: "advanced" },
  "target.workerSelector.mode": { displayName: "Selection Method", description: "Pick a worker by name, ID, capability, or auto.", tier: "advanced" },
  "target.workerSelector.value": { displayName: "Worker Identifier", description: "The slug, ID, or capability that identifies the worker.", tier: "advanced" },
  "target.prStrategy": { displayName: "Pull Request Strategy", description: "How ADE creates or tracks pull requests.", tier: "essential" },
  "target.prStrategy.kind": { displayName: "PR Creation Method", description: "The approach for creating or linking a PR.", tier: "essential" },
  "target.prStrategy.draft": { displayName: "Start as Draft PR", description: "Create the PR in draft mode until it's ready for review.", tier: "advanced" },
  "target.prTiming": { displayName: "PR Timing", description: "When in the workflow ADE creates or links the PR.", tier: "essential" },
  "target.sessionTemplate": { displayName: "Session Template", description: "Template to use when creating the agent session.", tier: "expert" },
  "target.missionTemplate": { displayName: "Mission Template", description: "Template to use when creating the mission.", tier: "expert" },
  "target.phaseProfile": { displayName: "Phase Profile", description: "Named phase configuration for multi-phase missions.", tier: "expert" },
  "target.downstreamTarget": { displayName: "Follow-up Action", description: "A second action that runs after the primary work completes.", tier: "expert" },

  // Visual plan
  "completionContract": { displayName: "Done When", description: "What must happen before ADE considers the work finished.", tier: "essential" },
  "supervisorMode": { displayName: "Review Checkpoint", description: "Whether and when a human reviews the work before closeout.", tier: "essential" },
  "supervisorIdentityKey": { displayName: "Reviewer", description: "Which agent or person acts as the supervisor.", tier: "essential" },
  "rejectAction": { displayName: "If Reviewer Rejects", description: "What happens when the reviewer does not approve.", tier: "essential" },
  "notificationEnabled": { displayName: "Send Notification", description: "Whether to send an in-app notification during the workflow.", tier: "essential" },
  "notificationMilestone": { displayName: "Notify When", description: "At which point in the workflow to send the notification.", tier: "advanced" },

  // Closeout
  "closeout.successState": { displayName: "On Success, Move To", description: "The Linear state to set when the workflow succeeds.", tier: "essential" },
  "closeout.failureState": { displayName: "On Failure, Move To", description: "The Linear state to set when the workflow fails.", tier: "essential" },
  "closeout.successComment": { displayName: "Success Comment", description: "A comment posted when the workflow succeeds.", tier: "advanced" },
  "closeout.failureComment": { displayName: "Failure Comment", description: "A comment posted when the workflow fails.", tier: "advanced" },
  "closeout.commentTemplate": { displayName: "Comment Template", description: "Handlebars template for closeout comments (supports {{issue.title}} etc).", tier: "expert" },
  "closeout.applyLabels": { displayName: "Add Labels on Completion", description: "Labels to apply when the workflow finishes.", tier: "advanced" },
  "closeout.reopenOnFailure": { displayName: "Reopen on Failure", description: "Move the issue back to open if the workflow fails.", tier: "advanced" },
  "closeout.resolveOnSuccess": { displayName: "Resolve on Success", description: "Mark the issue as resolved when the workflow succeeds.", tier: "advanced" },
  "closeout.artifactMode": { displayName: "Artifact Delivery", description: "How proof artifacts are attached to the issue.", tier: "expert" },
  "closeout.reviewReadyWhen": { displayName: "Review-Ready Signal", description: "When the workflow signals it's ready for final review.", tier: "advanced" },

  // Human review
  "humanReview.required": { displayName: "Require Review", description: "Whether a human must approve before closeout.", tier: "essential" },
  "humanReview.reviewers": { displayName: "Reviewers", description: "Who can approve this workflow.", tier: "essential" },
  "humanReview.instructions": { displayName: "Review Instructions", description: "Guidance shown to the reviewer when asked to approve.", tier: "advanced" },

  // Retry
  "retry.maxAttempts": { displayName: "Max Retries", description: "How many times ADE retries if the workflow fails.", tier: "advanced" },
  "retry.baseDelaySec": { displayName: "Initial Wait", description: "Seconds to wait before the first retry.", tier: "expert" },
  "retry.backoffSeconds": { displayName: "Retry Backoff", description: "How much longer to wait between each subsequent retry.", tier: "expert" },

  // Concurrency
  "concurrency.maxActiveRuns": { displayName: "Max Parallel Runs", description: "Maximum active runs across all issues.", tier: "advanced" },
  "concurrency.perIssue": { displayName: "Runs Per Issue", description: "Max simultaneous runs for a single issue.", tier: "advanced" },
  "concurrency.dedupeByIssue": { displayName: "Skip Duplicates", description: "Don't start another run if the issue already has one.", tier: "advanced" },

  // Observability
  "observability.emitNotifications": { displayName: "Desktop Notifications", description: "Send ADE notifications at significant milestones.", tier: "advanced" },
  "observability.captureIssueSnapshot": { displayName: "Save Issue Snapshot", description: "Save a copy of issue data when the workflow starts.", tier: "expert" },
  "observability.persistTimeline": { displayName: "Detailed Timeline", description: "Record a step-by-step timeline for debugging.", tier: "expert" },
};

/* ── Enum labels ── */

export type EnumLabel = {
  displayName: string;
  description?: string;
};

export const TARGET_TYPE_LABELS: Record<string, EnumLabel> = {
  employee_session: { displayName: "Agent Chat Session", description: "Hand the issue to an agent in a chat session." },
  worker_run: { displayName: "Background Worker", description: "Delegate to an isolated worker for autonomous work." },
  mission: { displayName: "Multi-Step Mission", description: "Broader mission with planning, execution, and verification." },
  pr_resolution: { displayName: "PR Workflow", description: "Focus on creating and resolving a pull request." },
  review_gate: { displayName: "Approval Gate", description: "Pause for human approval before continuing." },
};

export const RUN_MODE_LABELS: Record<string, EnumLabel> = {
  autopilot: { displayName: "Fully Automatic", description: "Agent works independently, stops only at checkpoints." },
  assisted: { displayName: "Semi-Automatic", description: "Agent checks in at key decision points." },
  manual: { displayName: "Manual Control", description: "You direct each step." },
};

export const LANE_SELECTION_LABELS: Record<string, EnumLabel> = {
  primary: { displayName: "Use primary lane", description: "Work directly in the primary lane." },
  fresh_issue_lane: { displayName: "New dedicated lane", description: "Create a fresh lane for this issue." },
  operator_prompt: { displayName: "Ask me each time", description: "Pause and let me choose the lane." },
};

export const SESSION_REUSE_LABELS: Record<string, EnumLabel> = {
  reuse_existing: { displayName: "Continue existing session", description: "Add to the agent's current chat." },
  fresh_session: { displayName: "Start fresh session", description: "Create a new chat session for this issue." },
};

export const PR_TIMING_LABELS: Record<string, EnumLabel> = {
  none: { displayName: "Do not manage PR timing", description: "ADE won't create or link a PR automatically." },
  after_start: { displayName: "As soon as work begins", description: "Create or link the PR right after work starts." },
  after_target_complete: { displayName: "After work finishes", description: "Create or link the PR after delegated work completes." },
};

export const PR_STRATEGY_KIND_LABELS: Record<string, EnumLabel> = {
  "per-lane": { displayName: "One PR per lane", description: "Create a PR from each lane branch." },
  integration: { displayName: "Integration PR", description: "Combine changes into a single integration PR." },
  queue: { displayName: "Merge queue", description: "Use a merge queue for orderly landing." },
  manual: { displayName: "I'll create the PR", description: "ADE tracks a PR you create yourself." },
};

export const COMPLETION_CONTRACT_LABELS: Record<string, EnumLabel> = {
  complete_on_launch: { displayName: "Immediately after starting", description: "Done as soon as work is launched." },
  wait_for_explicit_completion: { displayName: "Agent marks done", description: "Wait for the agent to explicitly report completion." },
  wait_for_runtime_success: { displayName: "Runtime finishes successfully", description: "Wait for the mission or worker to finish with success." },
  wait_for_pr_created: { displayName: "A pull request exists", description: "Wait until a linked PR has been created." },
  wait_for_review_ready: { displayName: "PR passes review checks", description: "Wait until the PR is approved and checks pass." },
};

export const SUPERVISOR_MODE_LABELS: Record<string, EnumLabel> = {
  none: { displayName: "No review step", description: "Work goes straight to closeout." },
  after_work: { displayName: "After work completes", description: "Reviewer checks the work after the agent finishes." },
  before_pr: { displayName: "Before PR is created", description: "Reviewer must approve before the PR is opened." },
  after_pr: { displayName: "After PR is ready", description: "Reviewer checks the PR after it's created." },
};

export const REJECT_ACTION_LABELS: Record<string, EnumLabel> = {
  loop_back: { displayName: "Request changes and retry", description: "Send the work back for revisions." },
  reopen_issue: { displayName: "Reject and reopen issue", description: "Stop the workflow and put the issue back in queue." },
  cancel: { displayName: "Reject and cancel", description: "Stop the workflow entirely." },
};

export const WORKER_SELECTOR_MODE_LABELS: Record<string, EnumLabel> = {
  none: { displayName: "Auto-select", description: "Let ADE pick the best available worker." },
  slug: { displayName: "By name", description: "Pick a specific worker by its short name." },
  id: { displayName: "By ID", description: "Pick a specific worker by its unique ID." },
  capability: { displayName: "By capability", description: "Pick any worker with a specific skill." },
};

export const EXECUTOR_KIND_LABELS: Record<string, EnumLabel> = {
  cto: { displayName: "CTO Agent" },
  employee: { displayName: "Named Agent" },
  worker: { displayName: "Background Worker" },
};

export const ARTIFACT_MODE_LABELS: Record<string, EnumLabel> = {
  links: { displayName: "Link to files", description: "Post links to artifacts in the comment." },
  attachments: { displayName: "Upload files", description: "Upload artifacts directly to the Linear issue." },
};

export const REVIEW_READY_WHEN_LABELS: Record<string, EnumLabel> = {
  work_complete: { displayName: "When work finishes", description: "Signal review-ready as soon as work completes." },
  pr_created: { displayName: "When a PR exists", description: "Signal review-ready when a PR has been created." },
  pr_ready: { displayName: "When PR is approved", description: "Signal review-ready when the PR passes checks." },
};

export const NOTIFY_ON_LABELS: Record<string, EnumLabel> = {
  delegated: { displayName: "Work is delegated" },
  pr_linked: { displayName: "PR is linked" },
  review_ready: { displayName: "Ready for review" },
  completed: { displayName: "Workflow completed" },
  failed: { displayName: "Workflow failed" },
};

export const STEP_TYPE_LABELS: Record<string, EnumLabel> = {
  set_linear_state: { displayName: "Update Issue State", description: "Move the Linear issue to a different state." },
  comment_linear: { displayName: "Post Comment", description: "Add a comment to the Linear issue." },
  set_linear_assignee: { displayName: "Change Assignee", description: "Reassign the Linear issue." },
  apply_linear_label: { displayName: "Add Label", description: "Apply a label to the Linear issue." },
  launch_target: { displayName: "Start Work", description: "Launch the configured action." },
  wait_for_target_status: { displayName: "Wait for Completion", description: "Wait until the delegated work reaches a status." },
  wait_for_pr: { displayName: "Wait for PR", description: "Wait for the linked pull request." },
  request_human_review: { displayName: "Supervisor Review", description: "Pause for a reviewer to approve or reject." },
  emit_app_notification: { displayName: "Send Notification", description: "Send an in-app notification." },
  complete_issue: { displayName: "Complete Workflow", description: "Mark the workflow as finished." },
  attach_artifacts: { displayName: "Attach Files", description: "Link or attach proof artifacts to the issue." },
  reopen_issue: { displayName: "Reopen Issue", description: "Move the issue back to an open state." },
};

export const ISSUE_STATE_LABELS: Record<string, EnumLabel> = {
  todo: { displayName: "To Do" },
  in_progress: { displayName: "In Progress" },
  in_review: { displayName: "In Review" },
  done: { displayName: "Done" },
  canceled: { displayName: "Canceled" },
  blocked: { displayName: "Blocked" },
};

/* ── Stage card colors ── */

export const STAGE_COLORS: Record<string, string> = {
  employee_session: "#A78BFA", // violet
  worker_run: "#34D399",      // emerald
  mission: "#A78BFA",         // violet
  pr_resolution: "#FB7185",   // rose
  review_gate: "#FBBF24",     // amber
};

/* ── Template descriptions for the preset cards ── */

export const PRESET_TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  employee_session: "Hand an issue to an agent in a live chat session.",
  mission: "Broad multi-step mission with planning and verification.",
  worker_run: "Run isolated background work with a dedicated worker.",
  pr_resolution: "Create, track, and land a pull request automatically.",
  review_gate: "Pause the pipeline for human approval before continuing.",
};

/* ── Helper to look up any enum label ── */

export function enumLabel(enumMap: Record<string, EnumLabel>, value: string | undefined | null): string {
  if (!value) return "";
  return enumMap[value]?.displayName ?? value;
}

export function enumDescription(enumMap: Record<string, EnumLabel>, value: string | undefined | null): string {
  if (!value) return "";
  return enumMap[value]?.description ?? "";
}

export function fieldLabel(path: string): string {
  return FIELD_LABELS[path]?.displayName ?? path;
}

export function fieldDescription(path: string): string {
  return FIELD_LABELS[path]?.description ?? "";
}

/* ── Auto-summary generator ── */

/**
 * Generate a one-sentence human-readable summary of what a workflow does.
 *
 * Example output:
 *   "When CTO is assigned an issue labeled employee-session, launch an agent chat
 *    session in a fresh branch, wait for completion, then move to In Review."
 */
export function generateWorkflowSummary(workflow: LinearWorkflowDefinition): string {
  const parts: string[] = [];

  // Trigger clause
  const triggerParts: string[] = [];
  if (workflow.triggers.assignees?.length) {
    triggerParts.push(workflow.triggers.assignees.join(" or ") + " is assigned");
  }
  if (workflow.triggers.labels?.length) {
    triggerParts.push("an issue labeled " + workflow.triggers.labels.join(", "));
  } else {
    triggerParts.push("an issue");
  }
  parts.push("When " + triggerParts.join(" "));

  // Action clause -- target type
  const targetLabel = TARGET_TYPE_LABELS[workflow.target.type]?.displayName?.toLowerCase() ?? workflow.target.type;
  parts.push("launch " + (/^[aeiou]/i.test(targetLabel) ? "an" : "a") + " " + targetLabel);

  // Lane clause
  const laneSelection = workflow.target.laneSelection;
  if (laneSelection) {
    const laneLabel = LANE_SELECTION_LABELS[laneSelection]?.displayName?.toLowerCase();
    if (laneLabel && laneSelection !== "primary") {
      parts.push("in a " + laneLabel.replace(/^new /, ""));
    }
  }

  // Completion clause
  const completionStep = workflow.steps.find((s) => s.type === "wait_for_target_status");
  if (completionStep) {
    parts.push("wait for completion");
  }

  // Success state clause
  const successState = workflow.closeout?.successState;
  if (successState) {
    const stateLabel = ISSUE_STATE_LABELS[successState]?.displayName ?? successState;
    parts.push("then move to " + stateLabel);
  }

  // Join with commas, ending with period
  let sentence = parts[0];
  for (let i = 1; i < parts.length; i++) {
    if (i === parts.length - 1) {
      sentence += ", " + parts[i];
    } else {
      sentence += ", " + parts[i];
    }
  }
  return sentence + ".";
}
