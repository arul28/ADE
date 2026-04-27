// Curated parameter schemas for ADE actions, used by the automation rule editor
// to render structured forms for `run_ade_action` step parameters. Source of
// truth for the action allowlist lives in
// `src/main/services/adeActions/registry.ts`.

export type AdeActionParamType =
  | "string"
  | "number"
  | "boolean"
  | "string-array"
  | "json"
  | "enum";

export type AdeActionParam = {
  name: string;
  type: AdeActionParamType;
  required?: boolean;
  description?: string;
  placeholder?: string;
  enumValues?: readonly string[];
  defaultValue?: string | number | boolean;
};

export type AdeActionSchema = {
  domain: string;
  action: string;
  /** Short human label (e.g. "Create lane"). */
  label: string;
  /** One-sentence description of what it does and when to use it. */
  description: string;
  params: AdeActionParam[];
};

const LANE_ID_PARAM: AdeActionParam = {
  name: "laneId",
  type: "string",
  required: true,
  description: "Lane to operate on",
  placeholder: "{{trigger.lane.id}}",
};

const PR_ID_PARAM: AdeActionParam = {
  name: "prId",
  type: "string",
  required: true,
  description: "PR to operate on",
  placeholder: "{{trigger.pr.id}}",
};

const COMMIT_SHA_PARAM: AdeActionParam = {
  name: "commitSha",
  type: "string",
  required: true,
  description: "Commit SHA",
  placeholder: "{{trigger.git.sha}}",
};

export const ADE_ACTION_SCHEMAS: readonly AdeActionSchema[] = [
  // ---------------------------------------------------------------------------
  // lane
  // ---------------------------------------------------------------------------
  {
    domain: "lane",
    action: "list",
    label: "List lanes",
    description: "Return every lane known to the project, optionally including archived lanes and live status.",
    params: [
      { name: "includeArchived", type: "boolean", description: "Include archived lanes in the result." },
      { name: "includeStatus", type: "boolean", description: "Compute git status (dirty/ahead/behind) for each lane." },
    ],
  },
  {
    domain: "lane",
    action: "create",
    label: "Create lane",
    description: "Create a new worktree-backed lane from an optional base branch and parent lane.",
    params: [
      { name: "name", type: "string", required: true, description: "Display name for the new lane." },
      { name: "description", type: "string", description: "Optional human description." },
      { name: "parentLaneId", type: "string", description: "Parent lane to stack on." },
      { name: "baseBranch", type: "string", description: "Base branch to fork from when there is no parent lane." },
    ],
  },
  {
    domain: "lane",
    action: "createFromUnstaged",
    label: "Create lane from unstaged changes",
    description: "Move the source lane's uncommitted changes onto a brand new sibling lane.",
    params: [
      { name: "sourceLaneId", type: "string", required: true, description: "Lane whose unstaged changes will move." },
      { name: "name", type: "string", required: true, description: "Display name for the new lane." },
    ],
  },
  {
    domain: "lane",
    action: "importBranch",
    label: "Import branch as lane",
    description: "Wrap an existing local or remote branch in a new lane and worktree.",
    params: [
      { name: "branchRef", type: "string", required: true, description: "Branch to import (e.g. origin/feature)." },
      { name: "name", type: "string", description: "Optional lane name (defaults to the branch name)." },
      { name: "description", type: "string" },
      { name: "baseBranch", type: "string", description: "Base branch to track for sync status." },
    ],
  },
  {
    domain: "lane",
    action: "attach",
    label: "Attach external worktree",
    description: "Register an existing checkout outside ADE as a managed lane.",
    params: [
      { name: "name", type: "string", required: true },
      { name: "attachedPath", type: "string", required: true, description: "Absolute path to the existing worktree." },
      { name: "description", type: "string" },
    ],
  },
  {
    domain: "lane",
    action: "adoptAttached",
    label: "Adopt attached lane",
    description: "Promote an attached worktree into a fully-managed ADE lane.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "lane",
    action: "delete",
    label: "Delete lane",
    description: "Remove a lane, its worktree, and optionally the underlying local/remote branch.",
    params: [
      LANE_ID_PARAM,
      { name: "deleteBranch", type: "boolean", description: "Delete the local branch as well." },
      { name: "deleteRemoteBranch", type: "boolean", description: "Delete the upstream remote branch as well." },
      { name: "remoteName", type: "string", description: "Remote to push the deletion to (default: origin)." },
      { name: "force", type: "boolean", description: "Skip safety checks for unmerged work." },
    ],
  },
  {
    domain: "lane",
    action: "rename",
    label: "Rename lane",
    description: "Change the display name of a lane.",
    params: [LANE_ID_PARAM, { name: "name", type: "string", required: true }],
  },
  {
    domain: "lane",
    action: "reparent",
    label: "Reparent lane",
    description: "Move a lane onto a new parent lane and rebase it onto the new parent's branch.",
    params: [
      LANE_ID_PARAM,
      { name: "newParentLaneId", type: "string", required: true, description: "Lane to set as the new parent." },
    ],
  },
  {
    domain: "lane",
    action: "updateAppearance",
    label: "Update lane appearance",
    description: "Change the color, icon, or tags shown for a lane in the UI.",
    params: [
      LANE_ID_PARAM,
      { name: "color", type: "string", description: "Hex color or null to clear." },
      {
        name: "icon",
        type: "enum",
        enumValues: ["star", "flag", "bolt", "shield", "tag"],
        description: "Optional icon glyph.",
      },
      { name: "tags", type: "string-array", description: "Comma-separated tag list." },
    ],
  },
  {
    domain: "lane",
    action: "getChildren",
    label: "Get child lanes",
    description: "Return lanes that have the given lane as their parent.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "lane",
    action: "getStackChain",
    label: "Get stack chain",
    description: "Return the ancestor chain of the lane from root down to the lane itself.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "lane",
    action: "listUnregisteredWorktrees",
    label: "List unregistered worktrees",
    description: "Find worktrees on disk that ADE does not yet track as lanes.",
    params: [],
  },
  {
    domain: "lane",
    action: "refreshSnapshots",
    label: "Refresh lane snapshots",
    description: "Recompute git status snapshots for every lane.",
    params: [
      { name: "includeArchived", type: "boolean" },
      { name: "includeStatus", type: "boolean" },
    ],
  },

  // ---------------------------------------------------------------------------
  // git
  // ---------------------------------------------------------------------------
  {
    domain: "git",
    action: "stageFile",
    label: "Stage file",
    description: "Stage a single file in the lane's worktree.",
    params: [LANE_ID_PARAM, { name: "path", type: "string", required: true, description: "Repo-relative path." }],
  },
  {
    domain: "git",
    action: "stageAll",
    label: "Stage all files",
    description: "Stage every change in the lane's worktree (optionally limited to the given paths).",
    params: [
      LANE_ID_PARAM,
      { name: "paths", type: "string-array", description: "Optional comma-separated file list." },
    ],
  },
  {
    domain: "git",
    action: "stagePaths",
    label: "Stage paths",
    description: "Stage the listed files. Advanced action — pass arguments as JSON.",
    params: [
      LANE_ID_PARAM,
      { name: "paths", type: "string-array", required: true, description: "Files to stage." },
    ],
  },
  {
    domain: "git",
    action: "unstageFile",
    label: "Unstage file",
    description: "Remove a single file from the index, leaving the working copy unchanged.",
    params: [LANE_ID_PARAM, { name: "path", type: "string", required: true }],
  },
  {
    domain: "git",
    action: "unstageAll",
    label: "Unstage all files",
    description: "Remove every staged change (optionally limited to the given paths).",
    params: [LANE_ID_PARAM, { name: "paths", type: "string-array" }],
  },
  {
    domain: "git",
    action: "unstagePaths",
    label: "Unstage paths",
    description: "Unstage the listed files. Advanced action — pass arguments as JSON.",
    params: [LANE_ID_PARAM, { name: "paths", type: "string-array", required: true }],
  },
  {
    domain: "git",
    action: "discardFile",
    label: "Discard file changes",
    description: "Throw away unstaged edits to a file in the lane's worktree.",
    params: [LANE_ID_PARAM, { name: "path", type: "string", required: true }],
  },
  {
    domain: "git",
    action: "restoreStagedFile",
    label: "Restore staged file",
    description: "Restore a staged file from HEAD (drops staged changes for that file).",
    params: [LANE_ID_PARAM, { name: "path", type: "string", required: true }],
  },
  {
    domain: "git",
    action: "commit",
    label: "Commit staged changes",
    description: "Create a commit on the lane with the given message, optionally amending the previous commit.",
    params: [
      LANE_ID_PARAM,
      { name: "message", type: "string", required: true, description: "Commit message." },
      { name: "amend", type: "boolean", description: "Amend the most recent commit instead of creating a new one." },
    ],
  },
  {
    domain: "git",
    action: "generateCommitMessage",
    label: "Generate commit message",
    description: "Use AI to draft a commit message from the lane's currently staged changes.",
    params: [LANE_ID_PARAM, { name: "amend", type: "boolean" }],
  },
  {
    domain: "git",
    action: "getCommitMessage",
    label: "Get commit message",
    description: "Read the full commit message for a specific commit.",
    params: [LANE_ID_PARAM, COMMIT_SHA_PARAM],
  },
  {
    domain: "git",
    action: "listRecentCommits",
    label: "List recent commits",
    description: "Return the most recent commits on the lane's branch.",
    params: [LANE_ID_PARAM, { name: "limit", type: "number", description: "Max commits to return." }],
  },
  {
    domain: "git",
    action: "listCommitFiles",
    label: "List commit files",
    description: "Return the list of files touched by a specific commit.",
    params: [LANE_ID_PARAM, COMMIT_SHA_PARAM],
  },
  {
    domain: "git",
    action: "getFileHistory",
    label: "Get file history",
    description: "Return the commits that touched a given file path.",
    params: [
      LANE_ID_PARAM,
      { name: "path", type: "string", required: true, description: "Repo-relative path." },
      { name: "limit", type: "number" },
    ],
  },
  {
    domain: "git",
    action: "revertCommit",
    label: "Revert commit",
    description: "Create a commit that undoes the changes from the given commit.",
    params: [LANE_ID_PARAM, COMMIT_SHA_PARAM],
  },
  {
    domain: "git",
    action: "cherryPickCommit",
    label: "Cherry-pick commit",
    description: "Apply a single commit from another branch onto this lane.",
    params: [LANE_ID_PARAM, COMMIT_SHA_PARAM],
  },
  {
    domain: "git",
    action: "fetch",
    label: "Fetch from remote",
    description: "Run `git fetch` for the lane's worktree.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "pull",
    label: "Pull from remote",
    description: "Pull the lane's branch from its upstream tracking branch.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "push",
    label: "Push lane to remote",
    description: "Push the lane's branch to its upstream remote, optionally with --force-with-lease.",
    params: [
      LANE_ID_PARAM,
      { name: "forceWithLease", type: "boolean", description: "Use --force-with-lease for safe force pushes." },
    ],
  },
  {
    domain: "git",
    action: "getSyncStatus",
    label: "Get upstream sync status",
    description: "Return ahead/behind/diverged status against the upstream tracking branch.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "getConflictState",
    label: "Get conflict state",
    description: "Inspect whether the lane is mid-merge or mid-rebase and which files conflict.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "rebaseContinue",
    label: "Continue rebase",
    description: "Continue an in-progress rebase after resolving conflicts.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "rebaseAbort",
    label: "Abort rebase",
    description: "Abort an in-progress rebase and return the lane to its pre-rebase state.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "abortRebase",
    label: "Abort rebase (alias)",
    description: "Advanced action — pass arguments as JSON.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "continueRebase",
    label: "Continue rebase (alias)",
    description: "Advanced action — pass arguments as JSON.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "mergeContinue",
    label: "Continue merge",
    description: "Continue an in-progress merge after resolving conflicts.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "mergeAbort",
    label: "Abort merge",
    description: "Abort an in-progress merge.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "stash",
    label: "Stash changes",
    description: "Advanced action — pass arguments as JSON.",
    params: [LANE_ID_PARAM, { name: "message", type: "string" }, { name: "includeUntracked", type: "boolean" }],
  },
  {
    domain: "git",
    action: "stashPush",
    label: "Stash push",
    description: "Stash the lane's working changes.",
    params: [
      LANE_ID_PARAM,
      { name: "message", type: "string", description: "Optional stash message." },
      { name: "includeUntracked", type: "boolean", description: "Also stash untracked files." },
    ],
  },
  {
    domain: "git",
    action: "stashApply",
    label: "Stash apply",
    description: "Apply a stash entry without removing it from the stash list.",
    params: [LANE_ID_PARAM, { name: "stashRef", type: "string", required: true, description: "Stash ref e.g. stash@{0}." }],
  },
  {
    domain: "git",
    action: "stashPop",
    label: "Stash pop",
    description: "Apply a stash entry and remove it from the stash list.",
    params: [LANE_ID_PARAM, { name: "stashRef", type: "string", required: true }],
  },
  {
    domain: "git",
    action: "stashDrop",
    label: "Stash drop",
    description: "Discard a single stash entry without applying it.",
    params: [LANE_ID_PARAM, { name: "stashRef", type: "string", required: true }],
  },
  {
    domain: "git",
    action: "stashClear",
    label: "Stash clear",
    description: "Discard every stash entry on the lane.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "listStashes",
    label: "List stashes",
    description: "Return the stash entries on the lane.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "listBranches",
    label: "List branches",
    description: "Return the local and remote branches visible from the lane.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "git",
    action: "checkoutBranch",
    label: "Checkout branch",
    description: "Switch the lane's worktree to the given branch.",
    params: [LANE_ID_PARAM, { name: "branchName", type: "string", required: true }],
  },

  // ---------------------------------------------------------------------------
  // diff
  // ---------------------------------------------------------------------------
  {
    domain: "diff",
    action: "getChanges",
    label: "Get diff changes",
    description: "Return the staged + unstaged file change summary for the lane.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "diff",
    action: "getFileDiff",
    label: "Get file diff",
    description: "Return the original/modified text for a single file at the chosen diff mode.",
    params: [
      LANE_ID_PARAM,
      { name: "path", type: "string", required: true, description: "Repo-relative path." },
      { name: "mode", type: "enum", required: true, enumValues: ["unstaged", "staged", "commit"] },
      { name: "compareRef", type: "string", description: "Optional ref when mode=commit." },
      { name: "compareTo", type: "enum", enumValues: ["worktree", "parent"], description: "Compare base when mode=commit." },
    ],
  },

  // ---------------------------------------------------------------------------
  // conflicts
  // ---------------------------------------------------------------------------
  {
    domain: "conflicts",
    action: "getLaneStatus",
    label: "Get lane conflict status",
    description: "Return the conflict status (predicted/active/clean) for a single lane.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "conflicts",
    action: "listOverlaps",
    label: "List conflict overlaps",
    description: "Return the lanes that overlap with this lane and the conflicting files.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "conflicts",
    action: "rebaseLane",
    label: "Rebase lane",
    description: "Rebase the lane onto its base, optionally with AI-assisted conflict resolution.",
    params: [
      LANE_ID_PARAM,
      { name: "aiAssisted", type: "boolean", description: "Run an AI resolver if conflicts are predicted." },
      { name: "provider", type: "enum", enumValues: ["codex", "claude"] },
      { name: "modelId", type: "string" },
      { name: "reasoningEffort", type: "string" },
      { name: "permissionMode", type: "enum", enumValues: ["read_only", "guarded_edit", "full_edit"] },
      { name: "autoApplyThreshold", type: "number", description: "Confidence threshold (0-1) for auto-applying AI patches." },
    ],
  },
  {
    domain: "conflicts",
    action: "runPrediction",
    label: "Run conflict prediction",
    description: "Recompute pairwise conflict predictions across the project's lanes.",
    params: [
      { name: "laneId", type: "string", description: "Optional single lane to anchor the run.", placeholder: "{{trigger.lane.id}}" },
      { name: "laneIds", type: "string-array", description: "Optional comma-separated lane IDs to compare." },
    ],
  },

  // ---------------------------------------------------------------------------
  // pr
  // ---------------------------------------------------------------------------
  {
    domain: "pr",
    action: "createFromLane",
    label: "Create PR from lane",
    description: "Open a GitHub PR from the lane's branch with the given title and body.",
    params: [
      LANE_ID_PARAM,
      { name: "title", type: "string", required: true },
      { name: "body", type: "string", required: true, description: "PR description (Markdown)." },
      { name: "draft", type: "boolean", required: true, defaultValue: false },
      { name: "baseBranch", type: "string" },
      { name: "labels", type: "string-array" },
      { name: "reviewers", type: "string-array" },
      { name: "allowDirtyWorktree", type: "boolean" },
      { name: "strategy", type: "enum", enumValues: ["pr_target", "lane_base"] },
    ],
  },
  {
    domain: "pr",
    action: "linkToLane",
    label: "Link existing PR to lane",
    description: "Associate an existing GitHub PR (URL or number) with an ADE lane.",
    params: [LANE_ID_PARAM, { name: "prUrlOrNumber", type: "string", required: true }],
  },
  {
    domain: "pr",
    action: "listAll",
    label: "List PRs",
    description: "Return every tracked PR, optionally filtered to a single lane.",
    params: [{ name: "laneId", type: "string", placeholder: "{{trigger.lane.id}}" }],
  },
  {
    domain: "pr",
    action: "refresh",
    label: "Refresh PR data",
    description: "Force a refresh of one or more PRs from the GitHub API.",
    params: [
      { name: "prId", type: "string", placeholder: "{{trigger.pr.id}}" },
      { name: "prIds", type: "string-array" },
    ],
  },
  {
    domain: "pr",
    action: "getDetail",
    label: "Get PR detail",
    description: "Return the full PR detail (body, labels, reviewers, assignees).",
    params: [PR_ID_PARAM],
  },
  {
    domain: "pr",
    action: "getChecks",
    label: "Get PR checks",
    description: "Return the latest CI check runs for the PR.",
    params: [PR_ID_PARAM],
  },
  {
    domain: "pr",
    action: "getComments",
    label: "Get PR comments",
    description: "Return issue + review comments on the PR.",
    params: [PR_ID_PARAM],
  },
  {
    domain: "pr",
    action: "getReviews",
    label: "Get PR reviews",
    description: "Return the submitted reviews on the PR.",
    params: [PR_ID_PARAM],
  },
  {
    domain: "pr",
    action: "getReviewThreads",
    label: "Get PR review threads",
    description: "Return the threaded review comments on the PR.",
    params: [PR_ID_PARAM],
  },
  {
    domain: "pr",
    action: "getPrHealth",
    label: "Get PR health",
    description: "Return the unified PR health snapshot (state, checks, conflicts, rebase need).",
    params: [PR_ID_PARAM],
  },
  {
    domain: "pr",
    action: "getMobileSnapshot",
    label: "Get mobile PR snapshot",
    description: "Return the aggregated PR snapshot used by the iOS PRs surface.",
    params: [],
  },
  {
    domain: "pr",
    action: "getGithubSnapshot",
    label: "Get GitHub PR snapshot",
    description: "Return the cached list of GitHub PRs visible to the viewer.",
    params: [{ name: "force", type: "boolean", description: "Force refresh from GitHub." }],
  },
  {
    domain: "pr",
    action: "addComment",
    label: "Add PR comment",
    description: "Post a new top-level issue comment on the PR.",
    params: [
      PR_ID_PARAM,
      { name: "body", type: "string", required: true, description: "Comment body (Markdown)." },
      { name: "inReplyToCommentId", type: "string", description: "Optional parent comment ID." },
    ],
  },
  {
    domain: "pr",
    action: "postReviewComment",
    label: "Post review comment",
    description: "Reply to a review thread on the PR.",
    params: [
      PR_ID_PARAM,
      { name: "threadId", type: "string", required: true },
      { name: "body", type: "string", required: true },
    ],
  },
  {
    domain: "pr",
    action: "setReviewThreadResolved",
    label: "Resolve review thread",
    description: "Mark a PR review thread as resolved or unresolved.",
    params: [
      PR_ID_PARAM,
      { name: "threadId", type: "string", required: true },
      { name: "resolved", type: "boolean", required: true },
    ],
  },
  {
    domain: "pr",
    action: "reactToComment",
    label: "React to PR comment",
    description: "Add an emoji reaction to a PR comment.",
    params: [
      PR_ID_PARAM,
      { name: "commentId", type: "string", required: true },
      {
        name: "content",
        type: "enum",
        required: true,
        enumValues: ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"],
      },
    ],
  },
  {
    domain: "pr",
    action: "submitReview",
    label: "Submit PR review",
    description: "Submit an APPROVE / REQUEST_CHANGES / COMMENT review on the PR.",
    params: [
      PR_ID_PARAM,
      { name: "event", type: "enum", required: true, enumValues: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] },
      { name: "body", type: "string", description: "Review summary body." },
      { name: "comments", type: "json", description: "Optional inline comments array (path/body/position)." },
    ],
  },
  {
    domain: "pr",
    action: "updateTitle",
    label: "Update PR title",
    description: "Rename the PR.",
    params: [PR_ID_PARAM, { name: "title", type: "string", required: true }],
  },
  {
    domain: "pr",
    action: "updateDescription",
    label: "Update PR description",
    description: "Replace the PR body.",
    params: [PR_ID_PARAM, { name: "body", type: "string", required: true }],
  },
  {
    domain: "pr",
    action: "draftDescription",
    label: "Draft PR description with AI",
    description: "Use an AI model to draft a title + body for a PR from the lane's commits.",
    params: [
      LANE_ID_PARAM,
      { name: "model", type: "string" },
      { name: "reasoningEffort", type: "string" },
      { name: "baseBranch", type: "string" },
    ],
  },
  {
    domain: "pr",
    action: "setLabels",
    label: "Set PR labels",
    description: "Replace the PR's labels with the given list.",
    params: [PR_ID_PARAM, { name: "labels", type: "string-array", required: true }],
  },
  {
    domain: "pr",
    action: "requestReviewers",
    label: "Request PR reviewers",
    description: "Add reviewers to the PR.",
    params: [PR_ID_PARAM, { name: "reviewers", type: "string-array", required: true }],
  },
  {
    domain: "pr",
    action: "aiReviewSummary",
    label: "AI PR review summary",
    description: "Generate an AI-written PR review summary with risks and recommendations.",
    params: [PR_ID_PARAM, { name: "model", type: "string" }],
  },
  {
    domain: "pr",
    action: "getActionRuns",
    label: "Get GitHub Actions runs",
    description: "Return the GitHub Actions workflow runs for the PR.",
    params: [PR_ID_PARAM],
  },
  {
    domain: "pr",
    action: "getQueueState",
    label: "Get queue state",
    description: "Return the merge queue state for a PR group.",
    params: [{ name: "groupId", type: "string", required: true }],
  },
  {
    domain: "pr",
    action: "listGroupPrs",
    label: "List group PRs",
    description: "Return every PR in a queue or integration group.",
    params: [{ name: "groupId", type: "string", required: true }],
  },
  {
    domain: "pr",
    action: "listWithConflicts",
    label: "List PRs with conflicts",
    description: "Return PRs that currently have an active conflict analysis.",
    params: [],
  },
  {
    domain: "pr",
    action: "createQueuePrs",
    label: "Create queue PRs",
    description: "Create a stacked queue of PRs from a lane chain.",
    params: [
      { name: "laneIds", type: "string-array", required: true },
      { name: "targetBranch", type: "string", required: true },
      { name: "titles", type: "json", description: "Optional map from laneId to PR title." },
      { name: "draft", type: "boolean" },
      { name: "autoRebase", type: "boolean" },
      { name: "ciGating", type: "boolean" },
      { name: "queueName", type: "string" },
      { name: "allowDirtyWorktree", type: "boolean" },
    ],
  },
  {
    domain: "pr",
    action: "createIntegrationPr",
    label: "Create integration PR",
    description: "Merge multiple lanes into a new integration lane and open a PR for it.",
    params: [
      { name: "sourceLaneIds", type: "string-array", required: true },
      { name: "integrationLaneName", type: "string", required: true },
      { name: "baseBranch", type: "string", required: true },
      { name: "title", type: "string", required: true },
      { name: "body", type: "string" },
      { name: "draft", type: "boolean" },
      { name: "allowDirtyWorktree", type: "boolean" },
      { name: "existingIntegrationLaneId", type: "string" },
    ],
  },
  {
    domain: "pr",
    action: "createIntegrationLane",
    label: "Create integration lane",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },
  {
    domain: "pr",
    action: "simulateIntegration",
    label: "Simulate integration",
    description: "Predict the outcome of merging multiple lanes into a base branch.",
    params: [
      { name: "sourceLaneIds", type: "string-array", required: true },
      { name: "baseBranch", type: "string", required: true },
      { name: "persist", type: "boolean", description: "Save the simulation as a proposal." },
      { name: "mergeIntoLaneId", type: "string", description: "Existing integration lane to start from." },
    ],
  },
  {
    domain: "pr",
    action: "listIntegrationProposals",
    label: "List integration proposals",
    description: "Return saved integration proposals for the project.",
    params: [],
  },
  {
    domain: "pr",
    action: "listIntegrationWorkflows",
    label: "List integration workflows",
    description: "Return integration workflows, filtered by display state.",
    params: [{ name: "view", type: "enum", enumValues: ["active", "history", "all"] }],
  },
  {
    domain: "pr",
    action: "updateIntegrationProposal",
    label: "Update integration proposal",
    description: "Update title/body/draft/preferred lane on a saved integration proposal.",
    params: [
      { name: "proposalId", type: "string", required: true },
      { name: "title", type: "string" },
      { name: "body", type: "string" },
      { name: "draft", type: "boolean" },
      { name: "integrationLaneName", type: "string" },
      { name: "preferredIntegrationLaneId", type: "string" },
      { name: "mergeIntoHeadSha", type: "string" },
      { name: "clearIntegrationBinding", type: "boolean" },
    ],
  },
  {
    domain: "pr",
    action: "dismissIntegrationCleanup",
    label: "Dismiss integration cleanup",
    description: "Dismiss the integration cleanup nudge for a proposal.",
    params: [{ name: "proposalId", type: "string", required: true }],
  },
  {
    domain: "pr",
    action: "cleanupIntegrationWorkflow",
    label: "Cleanup integration workflow",
    description: "Archive integration + source lanes after the workflow has merged.",
    params: [
      { name: "proposalId", type: "string", required: true },
      { name: "archiveIntegrationLane", type: "boolean" },
      { name: "archiveSourceLaneIds", type: "string-array" },
    ],
  },
  {
    domain: "pr",
    action: "getIntegrationResolutionState",
    label: "Get integration resolution state",
    description: "Return the per-step resolution state for an integration proposal.",
    params: [{ name: "proposalId", type: "string", required: true }],
  },
  {
    domain: "pr",
    action: "startIntegrationResolution",
    label: "Start integration resolution",
    description: "Kick off conflict resolution for one source lane in an integration proposal.",
    params: [
      { name: "proposalId", type: "string", required: true },
      { name: "laneId", type: "string", required: true, description: "Conflicting source lane.", placeholder: "{{trigger.lane.id}}" },
    ],
  },
  {
    domain: "pr",
    action: "recheckIntegrationStep",
    label: "Recheck integration step",
    description: "Re-run an integration step after the resolver finishes editing files.",
    params: [
      { name: "proposalId", type: "string", required: true },
      { name: "laneId", type: "string", required: true, placeholder: "{{trigger.lane.id}}" },
    ],
  },
  {
    domain: "pr",
    action: "landStack",
    label: "Land stack",
    description: "Merge a stack of PRs from root to leaf with the given merge method.",
    params: [
      { name: "rootLaneId", type: "string", required: true, placeholder: "{{trigger.lane.id}}" },
      { name: "method", type: "enum", required: true, enumValues: ["merge", "squash", "rebase"] },
    ],
  },
  {
    domain: "pr",
    action: "landStackEnhanced",
    label: "Land stack (enhanced)",
    description: "Land a stack with sequential or all-at-once mode.",
    params: [
      { name: "rootLaneId", type: "string", required: true, placeholder: "{{trigger.lane.id}}" },
      { name: "method", type: "enum", required: true, enumValues: ["merge", "squash", "rebase"] },
      { name: "mode", type: "enum", required: true, enumValues: ["sequential", "all-at-once"] },
    ],
  },
  {
    domain: "pr",
    action: "landQueueNext",
    label: "Land next queue PR",
    description: "Land the next eligible PR in a queue group.",
    params: [
      { name: "groupId", type: "string", required: true },
      { name: "method", type: "enum", required: true, enumValues: ["merge", "squash", "rebase"] },
      { name: "archiveLane", type: "boolean" },
      { name: "autoResolve", type: "boolean" },
      { name: "confidenceThreshold", type: "number" },
    ],
  },
  {
    domain: "pr",
    action: "reorderQueuePrs",
    label: "Reorder queue PRs",
    description: "Reorder PRs within a queue group.",
    params: [
      { name: "groupId", type: "string", required: true },
      { name: "prIds", type: "string-array", required: true },
    ],
  },

  // ---------------------------------------------------------------------------
  // tests
  // ---------------------------------------------------------------------------
  {
    domain: "tests",
    action: "listSuites",
    label: "List test suites",
    description: "Return the configured test suite definitions.",
    params: [],
  },
  {
    domain: "tests",
    action: "run",
    label: "Run test suite",
    description: "Run a configured test suite on a lane.",
    params: [
      LANE_ID_PARAM,
      { name: "suiteId", type: "string", required: true, description: "Test suite ID from project config." },
    ],
  },
  {
    domain: "tests",
    action: "stop",
    label: "Stop test run",
    description: "Cancel an in-progress test run.",
    params: [{ name: "runId", type: "string", required: true }],
  },
  {
    domain: "tests",
    action: "listRuns",
    label: "List test runs",
    description: "Return recent test runs, optionally filtered by lane and suite.",
    params: [
      { name: "laneId", type: "string", placeholder: "{{trigger.lane.id}}" },
      { name: "suiteId", type: "string" },
      { name: "limit", type: "number" },
    ],
  },
  {
    domain: "tests",
    action: "getLogTail",
    label: "Get test log tail",
    description: "Return the tail of a test run's log output.",
    params: [
      { name: "runId", type: "string", required: true },
      { name: "maxBytes", type: "number" },
    ],
  },

  // ---------------------------------------------------------------------------
  // chat
  // ---------------------------------------------------------------------------
  {
    domain: "chat",
    action: "createSession",
    label: "Create chat session",
    description: "Start a new agent chat session on a lane with the given provider/model.",
    params: [
      LANE_ID_PARAM,
      { name: "provider", type: "string", required: true, description: "codex | claude | cursor | opencode | …" },
      { name: "model", type: "string", required: true, description: "Runtime model token (CLI shortId or API model id)." },
      { name: "modelId", type: "string", description: "Registry model id (optional)." },
      { name: "sessionProfile", type: "enum", enumValues: ["light", "workflow"] },
      { name: "reasoningEffort", type: "string" },
      { name: "permissionMode", type: "enum", enumValues: ["default", "plan", "edit", "full-auto", "config-toml"] },
      { name: "interactionMode", type: "enum", enumValues: ["default", "plan"] },
      { name: "claudePermissionMode", type: "enum", enumValues: ["default", "plan", "acceptEdits", "bypassPermissions"] },
      { name: "codexApprovalPolicy", type: "enum", enumValues: ["untrusted", "on-request", "on-failure", "never"] },
      { name: "codexSandbox", type: "enum", enumValues: ["read-only", "workspace-write", "danger-full-access"] },
      { name: "codexConfigSource", type: "enum", enumValues: ["flags", "config-toml"] },
      { name: "opencodePermissionMode", type: "enum", enumValues: ["plan", "edit", "full-auto"] },
      { name: "cursorModeId", type: "string" },
      { name: "cursorConfigValues", type: "json" },
      { name: "identityKey", type: "string", description: "cto or agent:<id>." },
      { name: "surface", type: "enum", enumValues: ["work", "automation"] },
      { name: "automationId", type: "string" },
      { name: "automationRunId", type: "string" },
      { name: "requestedCwd", type: "string", description: "Subdirectory or absolute path under the lane worktree." },
    ],
  },
  {
    domain: "chat",
    action: "sendMessage",
    label: "Send chat message",
    description: "Send a user message to an existing chat session.",
    params: [
      { name: "sessionId", type: "string", required: true },
      { name: "text", type: "string", required: true, description: "Prompt sent to the agent." },
      { name: "displayText", type: "string", description: "Override the rendered message text." },
      { name: "attachments", type: "json", description: "Array of {path,type} attachment refs." },
      { name: "reasoningEffort", type: "string" },
      { name: "executionMode", type: "enum", enumValues: ["focused", "parallel", "subagents", "teams"] },
      { name: "interactionMode", type: "enum", enumValues: ["default", "plan"] },
    ],
  },
  {
    domain: "chat",
    action: "interrupt",
    label: "Interrupt chat",
    description: "Interrupt the running turn on a chat session.",
    params: [{ name: "sessionId", type: "string", required: true }],
  },
  {
    domain: "chat",
    action: "resumeSession",
    label: "Resume chat session",
    description: "Resume a previously ended or idled chat session.",
    params: [{ name: "sessionId", type: "string", required: true }],
  },
  {
    domain: "chat",
    action: "deleteSession",
    label: "Delete chat session",
    description: "Permanently delete a chat session and its transcript.",
    params: [{ name: "sessionId", type: "string", required: true }],
  },
  {
    domain: "chat",
    action: "listSessions",
    label: "List chat sessions",
    description: "List chat sessions, optionally filtered to a lane or including automation runs.",
    params: [
      { name: "laneId", type: "string", placeholder: "{{trigger.lane.id}}" },
      { name: "includeAutomation", type: "boolean" },
    ],
  },
  {
    domain: "chat",
    action: "getSessionSummary",
    label: "Get chat session summary",
    description: "Return the summary record for a chat session.",
    params: [{ name: "sessionId", type: "string", required: true }],
  },
  {
    domain: "chat",
    action: "getAvailableModels",
    label: "Get available chat models",
    description: "Return the available models for a chat provider.",
    params: [
      { name: "provider", type: "string", required: true },
      { name: "activateRuntime", type: "boolean" },
    ],
  },
  {
    domain: "chat",
    action: "getSlashCommands",
    label: "Get slash commands",
    description: "Return the slash commands available in a chat session.",
    params: [{ name: "sessionId", type: "string", required: true }],
  },

  // ---------------------------------------------------------------------------
  // memory
  // ---------------------------------------------------------------------------
  {
    domain: "memory",
    action: "writeMemory",
    label: "Write memory",
    description: "Insert or upsert a memory entry into the unified memory store.",
    params: [
      { name: "projectId", type: "string", required: true },
      { name: "scope", type: "enum", required: true, enumValues: ["project", "agent", "mission"] },
      { name: "scopeOwnerId", type: "string", description: "Agent ID for agent scope, mission/run ID for mission scope." },
      { name: "category", type: "enum", required: true, enumValues: ["fact", "preference", "pattern", "decision", "gotcha", "convention", "episode", "procedure", "digest", "handoff"] },
      { name: "content", type: "string", required: true, description: "Memory body text." },
      { name: "importance", type: "enum", enumValues: ["low", "medium", "high"] },
      { name: "confidence", type: "number", description: "Confidence in [0,1]." },
      { name: "status", type: "enum", enumValues: ["candidate", "promoted", "archived"] },
      { name: "tier", type: "number", description: "Memory tier (1=pinned, 2=hot, 3=cold)." },
      { name: "pinned", type: "boolean" },
      { name: "sourceSessionId", type: "string" },
      { name: "sourceRunId", type: "string" },
      { name: "sourceType", type: "string" },
      { name: "sourceId", type: "string" },
      { name: "agentId", type: "string" },
      { name: "fileScopePattern", type: "string" },
      { name: "writeGateMode", type: "enum", enumValues: ["default", "strict"] },
    ],
  },
  {
    domain: "memory",
    action: "pinMemory",
    label: "Pin memory",
    description: "Promote a memory entry to Tier 1 (pinned, never decays).",
    params: [{ name: "id", type: "string", required: true, description: "Memory entry ID." }],
  },
  {
    domain: "memory",
    action: "searchMemories",
    label: "Search memories",
    description: "Run a hybrid (semantic + lexical) search against the unified memory store.",
    params: [
      { name: "projectId", type: "string", required: true },
      { name: "query", type: "string", required: true },
      { name: "scope", type: "enum", enumValues: ["project", "agent", "mission"] },
      { name: "scopeOwnerId", type: "string" },
      { name: "limit", type: "number" },
      { name: "mode", type: "enum", enumValues: ["lexical", "hybrid"] },
      { name: "status", type: "enum", enumValues: ["candidate", "promoted", "archived"] },
      { name: "tiers", type: "json", description: "Array of tier numbers, e.g. [1,2]." },
    ],
  },
  {
    domain: "memory",
    action: "addSharedFact",
    label: "Add shared mission fact",
    description: "Record a shared mission fact that all workers on the run can read.",
    params: [
      { name: "runId", type: "string", required: true },
      { name: "stepId", type: "string" },
      { name: "factType", type: "string", required: true, description: "Fact category (e.g. decision, gotcha)." },
      { name: "content", type: "string", required: true },
    ],
  },

  // ---------------------------------------------------------------------------
  // mission
  // ---------------------------------------------------------------------------
  {
    domain: "mission",
    action: "list",
    label: "List missions",
    description: "Return missions for the project, optionally filtered by status or lane.",
    params: [
      { name: "status", type: "string", description: "MissionStatus or 'active'." },
      { name: "laneId", type: "string", placeholder: "{{trigger.lane.id}}" },
      { name: "limit", type: "number" },
      { name: "includeArchived", type: "boolean" },
    ],
  },
  {
    domain: "mission",
    action: "get",
    label: "Get mission detail",
    description: "Return the full detail (steps + events + artifacts + interventions) for a mission.",
    params: [{ name: "missionId", type: "string", required: true }],
  },
  {
    domain: "mission",
    action: "create",
    label: "Create mission",
    description: "Create a new mission with a prompt and optional launch settings.",
    params: [
      { name: "prompt", type: "string", required: true },
      { name: "title", type: "string" },
      { name: "laneId", type: "string", placeholder: "{{trigger.lane.id}}" },
      { name: "priority", type: "enum", enumValues: ["urgent", "high", "normal", "low"] },
      { name: "executionMode", type: "enum", enumValues: ["local", "relay"] },
      { name: "targetMachineId", type: "string" },
      { name: "plannerEngine", type: "enum", enumValues: ["auto", "claude_cli", "codex_cli"] },
      { name: "planningTimeoutMs", type: "number" },
      { name: "autostart", type: "boolean" },
      { name: "launchMode", type: "enum", enumValues: ["autopilot", "manual"] },
      { name: "autopilotExecutor", type: "string" },
      { name: "executionPolicy", type: "json" },
      { name: "recoveryLoop", type: "json" },
      { name: "modelConfig", type: "json" },
      { name: "teamRuntime", type: "json" },
      { name: "agentRuntime", type: "json" },
      { name: "employeeAgentId", type: "string" },
      { name: "phaseProfileId", type: "string" },
      { name: "phaseOverride", type: "json" },
      { name: "permissionConfig", type: "json" },
    ],
  },
  {
    domain: "mission",
    action: "update",
    label: "Update mission",
    description: "Patch the editable fields on a mission.",
    params: [
      { name: "missionId", type: "string", required: true },
      { name: "title", type: "string" },
      { name: "prompt", type: "string" },
      { name: "laneId", type: "string", placeholder: "{{trigger.lane.id}}" },
      { name: "status", type: "string" },
      { name: "priority", type: "enum", enumValues: ["urgent", "high", "normal", "low"] },
      { name: "executionMode", type: "enum", enumValues: ["local", "relay"] },
      { name: "targetMachineId", type: "string" },
      { name: "outcomeSummary", type: "string" },
      { name: "lastError", type: "string" },
    ],
  },
  {
    domain: "mission",
    action: "delete",
    label: "Delete mission",
    description: "Permanently delete a mission and its events.",
    params: [{ name: "missionId", type: "string", required: true }],
  },
  {
    domain: "mission",
    action: "archive",
    label: "Archive mission",
    description: "Archive a completed mission so it disappears from the active list.",
    params: [{ name: "missionId", type: "string", required: true }],
  },
  {
    domain: "mission",
    action: "addIntervention",
    label: "Add mission intervention",
    description: "Open an intervention against a mission (approval needed, manual input, etc.).",
    params: [
      { name: "missionId", type: "string", required: true },
      {
        name: "interventionType",
        type: "enum",
        required: true,
        enumValues: [
          "approval_required",
          "manual_input",
          "conflict",
          "policy_block",
          "failed_step",
          "orchestrator_escalation",
          "budget_limit_reached",
          "provider_unreachable",
          "unrecoverable_error",
          "phase_approval",
        ],
      },
      { name: "title", type: "string", required: true },
      { name: "body", type: "string", required: true },
      { name: "requestedAction", type: "string" },
      { name: "laneId", type: "string", placeholder: "{{trigger.lane.id}}" },
      { name: "metadata", type: "json" },
      { name: "pauseMission", type: "boolean" },
    ],
  },
  {
    domain: "mission",
    action: "resolveIntervention",
    label: "Resolve mission intervention",
    description: "Close out an open intervention with a status and optional resolution kind.",
    params: [
      { name: "missionId", type: "string", required: true },
      { name: "interventionId", type: "string", required: true },
      { name: "status", type: "enum", required: true, enumValues: ["resolved", "dismissed"] },
      { name: "note", type: "string" },
      {
        name: "resolutionKind",
        type: "enum",
        enumValues: ["answer_provided", "accept_defaults", "skip_question", "cancel_run"],
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // automations
  // ---------------------------------------------------------------------------
  {
    domain: "automations",
    action: "list",
    label: "List automations",
    description: "Return every automation rule with its last-run status.",
    params: [],
  },
  {
    domain: "automations",
    action: "get",
    label: "Get automation rule",
    description: "Return the saved rule definition for a single automation by ID.",
    params: [{ name: "id", type: "string", required: true }],
  },
  {
    domain: "automations",
    action: "saveRule",
    label: "Save automation rule",
    description: "Validate and save a draft automation rule.",
    params: [
      { name: "draft", type: "json", required: true, description: "AutomationRuleDraft payload." },
      { name: "confirmations", type: "string-array", description: "Confirmation keys the user agreed to." },
    ],
  },
  {
    domain: "automations",
    action: "deleteRule",
    label: "Delete automation rule",
    description: "Delete an automation rule by ID.",
    params: [{ name: "id", type: "string", required: true }],
  },
  {
    domain: "automations",
    action: "toggleRule",
    label: "Toggle automation rule",
    description: "Enable or disable an automation rule.",
    params: [
      { name: "id", type: "string", required: true },
      { name: "enabled", type: "boolean", required: true },
    ],
  },
  {
    domain: "automations",
    action: "triggerManually",
    label: "Trigger automation manually",
    description: "Run an automation rule on demand.",
    params: [
      { name: "id", type: "string", required: true },
      { name: "laneId", type: "string", placeholder: "{{trigger.lane.id}}" },
      {
        name: "reviewProfileOverride",
        type: "string",
        description: "Optional review profile override for this run.",
      },
      { name: "verboseTrace", type: "boolean" },
      { name: "dryRun", type: "boolean" },
    ],
  },
  {
    domain: "automations",
    action: "listRuns",
    label: "List automation runs",
    description: "Return recent automation runs.",
    params: [
      { name: "automationId", type: "string" },
      { name: "status", type: "string", description: "AutomationRunStatus or 'all'." },
      { name: "limit", type: "number" },
    ],
  },
  {
    domain: "automations",
    action: "getRunDetail",
    label: "Get automation run detail",
    description: "Return the full detail (rule + actions + chat session) for a run.",
    params: [{ name: "runId", type: "string", required: true }],
  },

  // ---------------------------------------------------------------------------
  // issue
  // ---------------------------------------------------------------------------
  {
    domain: "issue",
    action: "addComment",
    label: "Add issue comment",
    description: "Post a comment on a GitHub issue.",
    params: [
      { name: "owner", type: "string", description: "Repo owner (auto-detected if omitted)." },
      { name: "name", type: "string", description: "Repo name (auto-detected if omitted)." },
      { name: "number", type: "number", required: true, description: "Issue number." },
      { name: "body", type: "string", required: true },
    ],
  },
  {
    domain: "issue",
    action: "setLabels",
    label: "Set issue labels",
    description: "Replace the labels on a GitHub issue.",
    params: [
      { name: "owner", type: "string" },
      { name: "name", type: "string" },
      { name: "number", type: "number", required: true },
      { name: "labels", type: "string-array", required: true },
    ],
  },
  {
    domain: "issue",
    action: "close",
    label: "Close issue",
    description: "Close a GitHub issue with an optional reason.",
    params: [
      { name: "owner", type: "string" },
      { name: "name", type: "string" },
      { name: "number", type: "number", required: true },
      { name: "reason", type: "enum", enumValues: ["completed", "not_planned"] },
    ],
  },
  {
    domain: "issue",
    action: "reopen",
    label: "Reopen issue",
    description: "Reopen a closed GitHub issue.",
    params: [
      { name: "owner", type: "string" },
      { name: "name", type: "string" },
      { name: "number", type: "number", required: true },
    ],
  },
  {
    domain: "issue",
    action: "assign",
    label: "Assign issue",
    description: "Set the assignees on a GitHub issue.",
    params: [
      { name: "owner", type: "string" },
      { name: "name", type: "string" },
      { name: "number", type: "number", required: true },
      { name: "assignees", type: "string-array", required: true },
    ],
  },
  {
    domain: "issue",
    action: "setTitle",
    label: "Set issue title",
    description: "Rename a GitHub issue.",
    params: [
      { name: "owner", type: "string" },
      { name: "name", type: "string" },
      { name: "number", type: "number", required: true },
      { name: "title", type: "string", required: true },
    ],
  },

  // ---------------------------------------------------------------------------
  // file
  // ---------------------------------------------------------------------------
  {
    domain: "file",
    action: "listWorkspaces",
    label: "List file workspaces",
    description: "Return the file workspaces (one per lane + primary repo).",
    params: [{ name: "includeArchived", type: "boolean" }],
  },
  {
    domain: "file",
    action: "listTree",
    label: "List file tree",
    description: "Return the file tree for a workspace, optionally rooted at a subdirectory.",
    params: [
      { name: "workspaceId", type: "string", required: true },
      { name: "parentPath", type: "string" },
      { name: "depth", type: "number" },
      { name: "includeIgnored", type: "boolean" },
    ],
  },
  {
    domain: "file",
    action: "readFile",
    label: "Read file",
    description: "Return the contents of a file in a workspace.",
    params: [
      { name: "workspaceId", type: "string", required: true },
      { name: "path", type: "string", required: true, description: "Workspace-relative path." },
    ],
  },
  {
    domain: "file",
    action: "writeWorkspaceText",
    label: "Write file (text)",
    description: "Atomically write text content to a file in a workspace.",
    params: [
      { name: "workspaceId", type: "string", required: true },
      { name: "path", type: "string", required: true },
      { name: "text", type: "string", required: true },
    ],
  },
  {
    domain: "file",
    action: "createFile",
    label: "Create file",
    description: "Create a new file with optional initial content.",
    params: [
      { name: "workspaceId", type: "string", required: true },
      { name: "path", type: "string", required: true },
      { name: "content", type: "string" },
    ],
  },
  {
    domain: "file",
    action: "createDirectory",
    label: "Create directory",
    description: "Create a directory inside a workspace.",
    params: [
      { name: "workspaceId", type: "string", required: true },
      { name: "path", type: "string", required: true },
    ],
  },
  {
    domain: "file",
    action: "rename",
    label: "Rename path",
    description: "Rename or move a file or directory inside a workspace.",
    params: [
      { name: "workspaceId", type: "string", required: true },
      { name: "oldPath", type: "string", required: true },
      { name: "newPath", type: "string", required: true },
    ],
  },
  {
    domain: "file",
    action: "deletePath",
    label: "Delete path",
    description: "Delete a file or directory in a workspace.",
    params: [
      { name: "workspaceId", type: "string", required: true },
      { name: "path", type: "string", required: true },
    ],
  },
  {
    domain: "file",
    action: "quickOpen",
    label: "Quick open",
    description: "Fuzzy-search filenames in a workspace.",
    params: [
      { name: "workspaceId", type: "string", required: true },
      { name: "query", type: "string", required: true },
      { name: "limit", type: "number" },
      { name: "includeIgnored", type: "boolean" },
    ],
  },
  {
    domain: "file",
    action: "searchText",
    label: "Search file contents",
    description: "Full-text search across the workspace files.",
    params: [
      { name: "workspaceId", type: "string", required: true },
      { name: "query", type: "string", required: true },
      { name: "limit", type: "number" },
      { name: "includeIgnored", type: "boolean" },
    ],
  },

  // ---------------------------------------------------------------------------
  // process
  // ---------------------------------------------------------------------------
  {
    domain: "process",
    action: "listDefinitions",
    label: "List process definitions",
    description: "Return the configured background process definitions.",
    params: [],
  },
  {
    domain: "process",
    action: "listRuntime",
    label: "List process runtime",
    description: "Return the live runtime state of background processes for a lane.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "process",
    action: "startAll",
    label: "Start all processes",
    description: "Start every configured background process for the lane.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "process",
    action: "stopAll",
    label: "Stop all processes",
    description: "Stop every configured background process for the lane.",
    params: [LANE_ID_PARAM],
  },
  {
    domain: "process",
    action: "getLogTail",
    label: "Get process log tail",
    description: "Return the tail of a process's log buffer.",
    params: [
      LANE_ID_PARAM,
      { name: "processId", type: "string", required: true, description: "Process definition ID." },
      { name: "runId", type: "string", description: "Specific run ID (defaults to most recent)." },
      { name: "maxBytes", type: "number" },
    ],
  },

  // ---------------------------------------------------------------------------
  // linear_dispatcher
  // ---------------------------------------------------------------------------
  {
    domain: "linear_dispatcher",
    action: "dispatchIssue",
    label: "Dispatch Linear issue",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },
  {
    domain: "linear_dispatcher",
    action: "getDashboard",
    label: "Get Linear dispatcher dashboard",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },
  {
    domain: "linear_dispatcher",
    action: "listEmployees",
    label: "List Linear employees",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },
  {
    domain: "linear_dispatcher",
    action: "listQueue",
    label: "List Linear dispatch queue",
    description: "Return the queued Linear sync items waiting for dispatch.",
    params: [],
  },

  // ---------------------------------------------------------------------------
  // feedback
  // ---------------------------------------------------------------------------
  {
    domain: "feedback",
    action: "list",
    label: "List feedback submissions",
    description: "Return recent in-app feedback submissions.",
    params: [],
  },
  {
    domain: "feedback",
    action: "prepareDraft",
    label: "Prepare feedback draft",
    description: "Generate a structured GitHub-issue draft (title + body + labels) from user feedback input.",
    params: [
      { name: "draftInput", type: "json", required: true, description: "FeedbackDraftInput payload (category-specific)." },
      { name: "modelId", type: "string", description: "Model used to generate the draft." },
      { name: "reasoningEffort", type: "string" },
    ],
  },
  {
    domain: "feedback",
    action: "submitPreparedDraft",
    label: "Submit feedback draft",
    description: "Open a GitHub issue from a prepared feedback draft.",
    params: [
      { name: "draft", type: "json", required: true, description: "FeedbackPreparedDraft payload." },
      { name: "title", type: "string", required: true },
      { name: "body", type: "string", required: true },
      { name: "labels", type: "string-array", required: true },
    ],
  },

  // ---------------------------------------------------------------------------
  // keybindings
  // ---------------------------------------------------------------------------
  { domain: "keybindings", action: "get", label: "Get keybindings", description: "Return the saved keybinding map.", params: [] },
  {
    domain: "keybindings",
    action: "set",
    label: "Set keybindings",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },

  // ---------------------------------------------------------------------------
  // onboarding
  // ---------------------------------------------------------------------------
  { domain: "onboarding", action: "complete", label: "Complete onboarding", description: "Mark onboarding as complete.", params: [] },
  { domain: "onboarding", action: "detectDefaults", label: "Detect onboarding defaults", description: "Auto-detect sensible onboarding defaults.", params: [] },
  { domain: "onboarding", action: "getStatus", label: "Get onboarding status", description: "Return the current onboarding state.", params: [] },
  {
    domain: "onboarding",
    action: "setDismissed",
    label: "Set onboarding dismissed",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },

  // ---------------------------------------------------------------------------
  // automation_planner
  // ---------------------------------------------------------------------------
  {
    domain: "automation_planner",
    action: "parseNaturalLanguage",
    label: "Parse natural-language automation",
    description: "Run the AI planner to convert a natural-language intent into an automation rule draft.",
    params: [],
  },
  {
    domain: "automation_planner",
    action: "saveDraft",
    label: "Save automation draft",
    description: "Validate and persist an automation draft built by the planner.",
    params: [],
  },
  {
    domain: "automation_planner",
    action: "simulate",
    label: "Simulate automation",
    description: "Simulate the actions an automation draft would run without executing them.",
    params: [],
  },
  {
    domain: "automation_planner",
    action: "validateDraft",
    label: "Validate automation draft",
    description: "Validate an automation draft and surface required confirmations.",
    params: [],
  },

  // ---------------------------------------------------------------------------
  // orchestrator
  // ---------------------------------------------------------------------------
  { domain: "orchestrator", action: "cancelRunGracefully", label: "Cancel orchestrator run gracefully", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator", action: "finalizeRun", label: "Finalize orchestrator run", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator", action: "getMissionMetrics", label: "Get mission metrics", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator", action: "getTeamMembers", label: "Get team members", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator", action: "getThreadMessages", label: "Get thread messages", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator", action: "getWorkerStates", label: "Get worker states", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator", action: "listChatThreads", label: "List orchestrator chat threads", description: "Advanced action — pass arguments as JSON.", params: [] },
  {
    domain: "orchestrator",
    action: "startMissionRun",
    label: "Start mission run",
    description: "Launch a mission run via the AI orchestrator.",
    params: [],
  },
  {
    domain: "orchestrator",
    action: "steerMission",
    label: "Steer mission",
    description: "Send a steering directive to a running mission.",
    params: [
      { name: "missionId", type: "string", required: true },
      { name: "directive", type: "string", required: true, description: "Free-text steering message." },
      { name: "priority", type: "enum", required: true, enumValues: ["suggestion", "instruction", "override"] },
      { name: "targetStepKey", type: "string" },
      { name: "interventionId", type: "string" },
      {
        name: "resolutionKind",
        type: "enum",
        enumValues: ["answer_provided", "accept_defaults", "skip_question", "cancel_run"],
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // orchestrator_core
  // ---------------------------------------------------------------------------
  { domain: "orchestrator_core", action: "addReflection", label: "Add reflection", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "addSteps", label: "Add steps", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "appendRuntimeEvent", label: "Append runtime event", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "appendTimelineEvent", label: "Append timeline event", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "completeAttempt", label: "Complete attempt", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "createHandoff", label: "Create handoff", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "emitRuntimeUpdate", label: "Emit runtime update", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "getRunGraph", label: "Get run graph", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "listAttempts", label: "List attempts", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "listRetrospectivePatternStats", label: "List retrospective pattern stats", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "listRetrospectiveTrends", label: "List retrospective trends", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "listRetrospectives", label: "List retrospectives", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "listRuns", label: "List runs", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "listTimeline", label: "List timeline", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "pauseRun", label: "Pause run", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "resumeRun", label: "Resume run", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "skipStep", label: "Skip step", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "startReadyAutopilotAttempts", label: "Start ready autopilot attempts", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "supersedeStep", label: "Supersede step", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "updateStepDependencies", label: "Update step dependencies", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "orchestrator_core", action: "updateStepMetadata", label: "Update step metadata", description: "Advanced action — pass arguments as JSON.", params: [] },

  // ---------------------------------------------------------------------------
  // cto_state
  // ---------------------------------------------------------------------------
  { domain: "cto_state", action: "getIdentity", label: "Get CTO identity", description: "Return the CTO agent's identity record.", params: [] },
  {
    domain: "cto_state",
    action: "getSnapshot",
    label: "Get CTO snapshot",
    description: "Return the CTO agent's current snapshot (identity + recent activity).",
    params: [{ name: "recentLimit", type: "number", description: "Number of recent items to include." }],
  },
  {
    domain: "cto_state",
    action: "updateCoreMemory",
    label: "Update CTO core memory",
    description: "Patch the CTO's persisted core memory document.",
    params: [{ name: "patch", type: "json", required: true, description: "Partial CtoCoreMemory patch." }],
  },

  // ---------------------------------------------------------------------------
  // worker_agent
  // ---------------------------------------------------------------------------
  {
    domain: "worker_agent",
    action: "updateCoreMemory",
    label: "Update worker agent core memory",
    description: "Patch a worker agent's persisted core memory document.",
    params: [{ name: "patch", type: "json", required: true }],
  },

  // ---------------------------------------------------------------------------
  // session
  // ---------------------------------------------------------------------------
  {
    domain: "session",
    action: "get",
    label: "Get terminal session",
    description: "Return the detail record for a terminal session.",
    params: [{ name: "sessionId", type: "string", required: true }],
  },
  {
    domain: "session",
    action: "readTranscriptTail",
    label: "Read transcript tail",
    description: "Read the last N bytes of a session transcript file.",
    params: [
      { name: "transcriptPath", type: "string", required: true, description: "Absolute path to transcript file." },
      { name: "maxBytes", type: "number", required: true },
      { name: "options", type: "json", description: "{raw?: boolean, alignToLineBoundary?: boolean}" },
    ],
  },

  // ---------------------------------------------------------------------------
  // operation
  // ---------------------------------------------------------------------------
  {
    domain: "operation",
    action: "list",
    label: "List operations",
    description: "Return recorded git/lane operations, optionally filtered by lane or kind.",
    params: [
      { name: "laneId", type: "string", placeholder: "{{trigger.lane.id}}" },
      { name: "kind", type: "string" },
      { name: "limit", type: "number" },
    ],
  },
  {
    domain: "operation",
    action: "start",
    label: "Start operation",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },
  {
    domain: "operation",
    action: "finish",
    label: "Finish operation",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },

  // ---------------------------------------------------------------------------
  // project_config
  // ---------------------------------------------------------------------------
  { domain: "project_config", action: "get", label: "Get project config", description: "Return the merged project configuration.", params: [] },
  {
    domain: "project_config",
    action: "save",
    label: "Save project config",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },

  // ---------------------------------------------------------------------------
  // issue_inventory
  // ---------------------------------------------------------------------------
  { domain: "issue_inventory", action: "deletePipelineSettings", label: "Delete pipeline settings", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "getConvergenceRuntime", label: "Get convergence runtime", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "getConvergenceStatus", label: "Get convergence status", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "getInventory", label: "Get issue inventory", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "getNewItems", label: "Get new inventory items", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "getPipelineSettings", label: "Get pipeline settings", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "markDismissed", label: "Mark inventory dismissed", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "markEscalated", label: "Mark inventory escalated", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "markFixed", label: "Mark inventory fixed", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "markSentToAgent", label: "Mark inventory sent to agent", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "reconcileConvergenceSessionExit", label: "Reconcile convergence session exit", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "resetConvergenceRuntime", label: "Reset convergence runtime", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "resetInventory", label: "Reset inventory", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "saveConvergenceRuntime", label: "Save convergence runtime", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "savePipelineSettings", label: "Save pipeline settings", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "issue_inventory", action: "syncFromPrData", label: "Sync inventory from PR data", description: "Advanced action — pass arguments as JSON.", params: [] },

  // ---------------------------------------------------------------------------
  // flow_policy
  // ---------------------------------------------------------------------------
  { domain: "flow_policy", action: "diffPolicyPaths", label: "Diff policy paths", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "flow_policy", action: "getPolicy", label: "Get flow policy", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "flow_policy", action: "listRevisions", label: "List policy revisions", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "flow_policy", action: "normalizePolicy", label: "Normalize policy", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "flow_policy", action: "rollbackRevision", label: "Rollback policy revision", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "flow_policy", action: "savePolicy", label: "Save flow policy", description: "Advanced action — pass arguments as JSON.", params: [] },

  // ---------------------------------------------------------------------------
  // linear_credentials
  // ---------------------------------------------------------------------------
  { domain: "linear_credentials", action: "clearOAuthClientCredentials", label: "Clear Linear OAuth client", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "linear_credentials", action: "clearToken", label: "Clear Linear token", description: "Clear the stored Linear token.", params: [] },
  { domain: "linear_credentials", action: "getStatus", label: "Get Linear credential status", description: "Return whether a Linear token is stored.", params: [] },
  { domain: "linear_credentials", action: "setOAuthClientCredentials", label: "Set Linear OAuth client", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "linear_credentials", action: "setOAuthToken", label: "Set Linear OAuth token", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "linear_credentials", action: "setToken", label: "Set Linear token", description: "Advanced action — pass arguments as JSON.", params: [] },

  // ---------------------------------------------------------------------------
  // linear_issue_tracker
  // ---------------------------------------------------------------------------
  { domain: "linear_issue_tracker", action: "getStatus", label: "Get Linear issue tracker status", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "linear_issue_tracker", action: "listIssues", label: "List Linear issues", description: "Advanced action — pass arguments as JSON.", params: [] },

  // ---------------------------------------------------------------------------
  // linear_sync
  // ---------------------------------------------------------------------------
  { domain: "linear_sync", action: "getDashboard", label: "Get Linear sync dashboard", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "linear_sync", action: "getRunDetail", label: "Get Linear sync run detail", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "linear_sync", action: "listQueue", label: "List Linear sync queue", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "linear_sync", action: "resolveQueueItem", label: "Resolve Linear sync queue item", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "linear_sync", action: "runSyncNow", label: "Run Linear sync now", description: "Trigger an immediate Linear sync run.", params: [] },

  // ---------------------------------------------------------------------------
  // linear_ingress
  // ---------------------------------------------------------------------------
  { domain: "linear_ingress", action: "ensureRelayWebhook", label: "Ensure Linear relay webhook", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "linear_ingress", action: "getStatus", label: "Get Linear ingress status", description: "Return the configured Linear ingress status.", params: [] },
  { domain: "linear_ingress", action: "listRecentEvents", label: "List recent Linear events", description: "Advanced action — pass arguments as JSON.", params: [] },

  // ---------------------------------------------------------------------------
  // linear_routing
  // ---------------------------------------------------------------------------
  { domain: "linear_routing", action: "simulateRoute", label: "Simulate Linear routing", description: "Advanced action — pass arguments as JSON.", params: [] },

  // ---------------------------------------------------------------------------
  // github
  // ---------------------------------------------------------------------------
  { domain: "github", action: "clearToken", label: "Clear GitHub token", description: "Clear the stored GitHub token.", params: [] },
  { domain: "github", action: "getRepoOrThrow", label: "Get GitHub repo (or throw)", description: "Return the detected GitHub repo or throw if missing.", params: [] },
  { domain: "github", action: "getStatus", label: "Get GitHub status", description: "Return the GitHub auth status (token, scopes, repo).", params: [] },
  { domain: "github", action: "setToken", label: "Set GitHub token", description: "Advanced action — pass arguments as JSON.", params: [] },

  // ---------------------------------------------------------------------------
  // usage
  // ---------------------------------------------------------------------------
  { domain: "usage", action: "forceRefresh", label: "Force usage refresh", description: "Force a refresh of the usage tracking snapshot.", params: [] },
  { domain: "usage", action: "getUsageSnapshot", label: "Get usage snapshot", description: "Return the latest usage snapshot.", params: [] },
  { domain: "usage", action: "poll", label: "Poll usage", description: "Trigger a one-shot poll of the usage tracker.", params: [] },
  { domain: "usage", action: "start", label: "Start usage polling", description: "Start the usage tracking polling loop.", params: [] },
  { domain: "usage", action: "stop", label: "Stop usage polling", description: "Stop the usage tracking polling loop.", params: [] },

  // ---------------------------------------------------------------------------
  // budget
  // ---------------------------------------------------------------------------
  { domain: "budget", action: "checkBudget", label: "Check budget", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "budget", action: "getConfig", label: "Get budget config", description: "Return the configured budget caps.", params: [] },
  { domain: "budget", action: "getCumulativeUsage", label: "Get cumulative budget usage", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "budget", action: "recordUsage", label: "Record budget usage", description: "Advanced action — pass arguments as JSON.", params: [] },
  { domain: "budget", action: "updateConfig", label: "Update budget config", description: "Advanced action — pass arguments as JSON.", params: [] },

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------
  { domain: "update", action: "checkForUpdates", label: "Check for updates", description: "Trigger an auto-update check.", params: [] },
  { domain: "update", action: "dismissInstalledNotice", label: "Dismiss installed notice", description: "Dismiss the post-install update notice.", params: [] },
  { domain: "update", action: "getSnapshot", label: "Get auto-update snapshot", description: "Return the current auto-update state.", params: [] },
  { domain: "update", action: "quitAndInstall", label: "Quit and install update", description: "Quit ADE and install the pending update.", params: [] },

  // ---------------------------------------------------------------------------
  // pty
  // ---------------------------------------------------------------------------
  {
    domain: "pty",
    action: "create",
    label: "Create PTY",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },
  {
    domain: "pty",
    action: "dispose",
    label: "Dispose PTY",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },
  {
    domain: "pty",
    action: "resize",
    label: "Resize PTY",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },
  {
    domain: "pty",
    action: "write",
    label: "Write to PTY",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },

  // ---------------------------------------------------------------------------
  // layout
  // ---------------------------------------------------------------------------
  {
    domain: "layout",
    action: "get",
    label: "Get dock layout",
    description: "Return the persisted dock layout for a layout ID.",
    params: [{ name: "layoutId", type: "string", required: true }],
  },
  {
    domain: "layout",
    action: "set",
    label: "Set dock layout",
    description: "Persist the dock layout for a layout ID.",
    params: [
      { name: "layoutId", type: "string", required: true },
      { name: "layout", type: "json", required: true, description: "Object of pane key → percent, or null to clear." },
    ],
  },

  // ---------------------------------------------------------------------------
  // tiling_tree
  // ---------------------------------------------------------------------------
  {
    domain: "tiling_tree",
    action: "get",
    label: "Get tiling tree",
    description: "Return the persisted tiling tree for a layout ID.",
    params: [{ name: "layoutId", type: "string", required: true }],
  },
  {
    domain: "tiling_tree",
    action: "set",
    label: "Set tiling tree",
    description: "Persist the tiling tree for a layout ID.",
    params: [
      { name: "layoutId", type: "string", required: true },
      { name: "tree", type: "json", required: true, description: "Tree object or null to clear." },
    ],
  },

  // ---------------------------------------------------------------------------
  // graph_state
  // ---------------------------------------------------------------------------
  {
    domain: "graph_state",
    action: "get",
    label: "Get graph state",
    description: "Return the persisted lanes-graph state for the current project.",
    params: [],
  },
  {
    domain: "graph_state",
    action: "set",
    label: "Set graph state",
    description: "Persist the lanes-graph state for the current project.",
    params: [{ name: "state", type: "json", required: true, description: "State object or null to clear." }],
  },

  // ---------------------------------------------------------------------------
  // computer_use_artifacts
  // ---------------------------------------------------------------------------
  {
    domain: "computer_use_artifacts",
    action: "ingest",
    label: "Ingest computer-use artifact",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },
  {
    domain: "computer_use_artifacts",
    action: "listArtifacts",
    label: "List computer-use artifacts",
    description: "Advanced action — pass arguments as JSON.",
    params: [],
  },
];

export function findAdeActionSchema(domain: string, action: string): AdeActionSchema | undefined {
  return ADE_ACTION_SCHEMAS.find((s) => s.domain === domain && s.action === action);
}
