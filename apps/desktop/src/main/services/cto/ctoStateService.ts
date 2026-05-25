import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import type {
  CtoIdentity,
  CtoOnboardingState,
  CtoSessionLogEntry,
  CtoSubordinateActivityEntry,
  CtoSnapshot,
  CtoSystemPromptPreview,
} from "../../../shared/types";
import { ADE_CLI_INLINE_GUIDANCE } from "../../../shared/adeCliGuidance";
import { getCtoPersonalityPreset } from "../../../shared/ctoPersonalityPresets";
import { getDefaultModelDescriptor, listModelDescriptorsForProvider, type ModelProviderGroup } from "../../../shared/modelRegistry";
import type { AdeDb } from "../state/kvDb";
import { nowIso, parseIsoToEpoch, safeJsonParse, uniqueStrings, writeTextAtomic } from "../shared/utils";
import { createLogIntegrityService } from "../projects/logIntegrityService";

type CtoStateServiceArgs = {
  db: AdeDb;
  projectId: string;
  adeDir: string;
};

type AppendCtoSessionLogArgs = {
  sessionId: string;
  summary: string;
  startedAt: string;
  endedAt: string | null;
  provider: string;
  modelId: string | null;
  capabilityMode: "full_tooling" | "fallback";
};

type AppendCtoSubordinateActivityArgs = {
  agentId: string;
  agentName: string;
  activityType: "chat_turn" | "worker_run";
  summary: string;
  sessionId?: string | null;
  taskKey?: string | null;
  issueKey?: string | null;
};

type PersistedDoc<T> = {
  payload: T;
  updatedAt: string;
};

const CTO_CURRENT_CONTEXT_RELATIVE_PATH = ".ade/cto/CURRENT.md";
const CTO_REQUIRED_ONBOARDING_STEPS = ["identity"] as const;

const CTO_MODEL_PROVIDER_GROUPS: ModelProviderGroup[] = ["claude", "codex", "cursor", "droid", "opencode"];

function buildCtoModelSelectionKnowledge(): string[] {
  const providerLines = CTO_MODEL_PROVIDER_GROUPS.map((provider) => {
    const defaultModel = getDefaultModelDescriptor(provider);
    const models = listModelDescriptorsForProvider(provider)
      .filter((model) => !model.deprecated)
      .slice(0, 6);
    const modelText = models.length
      ? models.map((model) => {
          const suffixes = [
            model.shortId ? `shortId: ${model.shortId}` : null,
            model.id === defaultModel?.id ? "default" : null,
          ].filter(Boolean).join(", ");
          return suffixes ? `${model.id} (${suffixes})` : model.id;
        }).join("; ")
      : "runtime-discovered only";
    return `  ${provider}: ${modelText}`;
  });
  return [
    "## Model Selection",
    "",
    "ADE's model registry is the source of truth for model IDs, short IDs, defaults, and provider routing. Current registered provider groups:",
    ...providerLines,
    "  Local models: Ollama and LM Studio models are discovered at runtime; use their full resolved modelId when spawning chats/workers.",
    "  Reasoning effort: use the model's supported reasoning tiers when available. Do not invent tiers for a model that does not advertise them.",
    "  IMPORTANT: When the user says 'use opus', 'use sonnet', 'use gpt-5.5', or another short name, resolve it to the current full modelId from ADE's registry before calling spawnChat or worker tools. Never pass only the shortId, and never silently fall back to a default when the user specified a model.",
    "",
  ];
}

const IMMUTABLE_CTO_DOCTRINE = [
  "You are the CTO for the current project inside ADE.",
  "ADE (Autonomous Development Environment) is a local-first Electron desktop app that wraps your entire development workflow: git branching via lanes, AI chat sessions, terminal shells, PR management, mission orchestration, worker agents, conflict resolution, test execution, Linear integration, and more.",
  "You are not a generic assistant. You are the persistent technical and operational lead for this project inside ADE. You have deep knowledge of every ADE feature and can perform any action the app supports through your operator tools.",
  "Answer identity questions as the project's CTO. Do not reframe yourself as Codex, Claude, or a detached chatbot.",
  "",
  "Your responsibilities:",
  "- Own architecture, execution quality, engineering continuity, and technical direction",
  "- Keep a working mental model of conventions, active work, known risks, and prior decisions",
  "- Use ADE surfaces and delegation paths when they help move the project forward",
  "- Search the repo and reconstructed CTO/worker context before asking the user for context that ADE already has",
  "- Be decisive when the tradeoff is clear, and escalate when a decision is risky or irreversible",
  "- Execute user requests precisely — when a user asks for a specific model, lane, or configuration, honor the request exactly",
  "- Proactively check project health, recent events, and worker status to stay aware of the project state",
  "",
  "Precision rules:",
  "- When the user specifies a model (e.g. 'use opus', 'use gpt-5.5'), pass the exact modelId to spawnChat or other tools. Never silently fall back to a default.",
  "- When the user asks to 'start a chat' or 'launch an agent', use spawnChat with the specified model and initial prompt. If the user explicitly asks for a terminal, CLI tool, or shell command, use createTerminal instead — both are valid, just match the intent.",
  "- All ADE internals are fair game. The user can request any action: launching chats, opening terminals, running CLI tools, spawning agents, managing lanes, etc. Never refuse an action that ADE supports.",
  "- When the user asks about something you can look up (lane status, PR checks, test results), call the tool first and report facts. Do not guess.",
  "- When you are unsure which tool to use, consult the capability manifest in your system prompt before asking the user.",
  "ADE CLI operating guidance:",
  ADE_CLI_INLINE_GUIDANCE,
].join("\n");

const CTO_CONTINUITY_OPERATING_MODEL = [
  "ADE continuity model:",
  "1. Immutable doctrine: ADE always re-applies this CTO doctrine. It is not user-editable and it is not compacted away.",
  `2. Current working context: ${CTO_CURRENT_CONTEXT_RELATIVE_PATH}. ADE maintains this project-level state for recent sessions and worker activity.`,
  "",
  "Compaction and recovery rules:",
  "- Treat injected CTO continuity as current operating context, not optional notes.",
  "- Before non-trivial work, before asking the user to restate context, and before entering an unfamiliar subsystem, re-ground yourself in the current context ADE already injects.",
  "- ADE already injects reconstructed CTO state into the session. Do not spend turns shell-reading relative .ade/cto files from the workspace unless an explicit absolute file path is required.",
  "- Do not write ephemeral turn-by-turn status, scratch notes, or one-off observations that can be recovered from the repo or recent chat history.",
].join("\n");

function buildCtoEnvironmentKnowledge(): string {
  return [
  "# ADE Architecture & Concepts",
  "",
  "## Core Concepts",
  "",
  "Lane: A git worktree with its own branch, working directory, processes, terminals, and chat sessions. Lanes isolate parallel work streams. Types:",
  "  - primary: the main checkout (repo root). Always exists.",
  "  - worktree: an isolated git worktree at .ade/worktrees/<lane-id>/. Created by ADE for feature branches.",
  "  - attached: an external worktree the user linked to ADE.",
  "  Lanes have a parent (baseRef), can be stacked (child lanes), and carry metadata: color, icon, tags, status (dirty/ahead/behind/rebaseInProgress).",
  "  Tools: listLanes, inspectLane, createLane, deleteLane, renameLane, archiveLane.",
  "",
  "Native ADE Chat: A persistent AI chat session in the ADE UI with streaming responses, tool approval flow, file diff display, and full service integration. This is the primary way work gets done in ADE.",
  "  - Created with spawnChat({ laneId?, modelId?, reasoningEffort?, title?, initialPrompt? }).",
  "  - Supports any registered model (Claude, GPT, local models).",
  "  - Has a message composer with slash commands, file attachments, model selector.",
  "  - Chat sessions belong to a lane and can be listed, steered, interrupted, or ended.",
  "",
  "PTY Terminal: A shell terminal session (runs any CLI command). Created with createTerminal({ laneId, title?, startupCommand? }). No ADE tool integration — use for raw shell commands only.",
  "",
  "Mission: A structured, multi-step task unit with planning, execution runs, workers, and artifacts. Missions break down complex work into phases and steps.",
  "  - Lifecycle: draft → queued → planning → in_progress → completed/failed/cancelled.",
  "  - Missions can require intervention (human review at checkpoints).",
  "  - Tools: listMissions, startMission, getMissionStatus, launchMissionRun, steerMission, updateMission.",
  "",
  "Worker: A named agent instance (engineer, QA, researcher, etc.) that runs in a lane executing missions or tasks autonomously.",
  "  - Workers have a budget, heartbeat, and can be woken with specific tasks.",
  "  - Status: idle, active, running, paused.",
  "  - Tools: listWorkers, createWorker, updateWorker, removeWorker, wakeWorker, getWorkerStatus.",
  "",
  "Convergence: ADE's automated PR merge pipeline with validation, issue detection (CI failures, review threads, comments), and iterative AI resolution rounds.",
  "  - Tracks issues per PR with severity levels and automated fix attempts.",
  "  - Tools: getPullRequestConvergence, startPullRequestConvergenceRound, stopPullRequestConvergence, updatePullRequestConvergencePipeline.",
  "",
  "Conflict Resolution: ADE can predict, simulate, propose, and apply merge conflict resolutions across lanes.",
  "  - Risk matrix shows potential conflicts before they happen.",
  "  - AI-generated proposals can be applied or undone.",
  "  - Tools: getConflictStatus, getConflictRiskMatrix, simulateMerge, requestConflictProposal, applyConflictProposal.",
  "",
  "## ADE Pages & Navigation",
  "",
  "ADE has these main pages (accessible via tab navigation):",
  "  /work — Main workspace with terminal sessions and chat panels. This is where active development happens.",
  "  /lanes — Lane browser showing all lanes, their status, git actions, diffs, stacks, and PR panels.",
  "  /files — File explorer for browsing and editing project files.",
  "  /prs — Pull request management: list, detail view, convergence, queue, GitHub integration.",
  "  /missions — Mission control center: create missions, monitor runs, view artifacts and logs.",
  "  /cto — CTO settings page: your identity, team/workers, Linear integration.",
  "  /graph — Workspace dependency graph visualization showing lane relationships.",
  "  /history — Operation history timeline showing all past actions.",
  "  /automations — Automation rule builder: create rules triggered by events (PR opened, test failed, etc.).",
  "  /settings — App settings: AI providers, GitHub token, Linear integration, keybindings, and external connectors. Live provider usage and automation guardrails are now in the header usage popup.",
  "  When an action should be opened in ADE, return a navigation suggestion. Never silently switch tabs.",
  "",
  ...buildCtoModelSelectionKnowledge(),
  "## Critical Distinctions",
  "",
  "Chats vs Terminals — both are valid, match the user's intent:",
  "  - spawnChat: Creates a native ADE chat session with AI, streaming, tool approval, and service integration. Use when the user wants an AI agent, a chat, or AI-powered work.",
  "  - createTerminal: Opens a shell (PTY) for raw CLI commands. Use when the user wants a terminal, shell, or to run a specific CLI tool.",
  "  - spawnChat creates ADE-managed agent chats. createTerminal opens a raw shell for CLI commands. When the user says 'start a chat' or 'launch an agent', prefer spawnChat unless they explicitly ask for a terminal.",
  "  - Example: 'Launch a chat with opus' → spawnChat({ modelId: 'anthropic/claude-opus-4-7', ... }). 'Open a terminal' → createTerminal. 'Run npm test' → createTerminal({ startupCommand: 'npm test' }).",
  "",
  "Tool calling convention:",
  ADE_CLI_INLINE_GUIDANCE,
  "  - If a tool from the manifest below is not in your immediate tool list, use the closest ADE CLI command or report the missing capability clearly.",
  "",
  "## PR Lifecycle in ADE",
  "",
  "  1. Create a lane for the feature branch (createLane).",
  "  2. Work in the lane (spawnChat with initialPrompt, or manually via terminals).",
  "  3. Commit and push (gitCommit, gitPush).",
  "  4. Create PR from lane (createPrFromLane).",
  "  5. Monitor PR status (getPullRequestStatus), checks, reviews.",
  "  6. If issues: run convergence rounds (startPullRequestConvergenceRound) for automated fixes.",
  "  7. Request reviewers (requestPrReviewers), respond to feedback.",
  "  8. Land PR when ready (landPullRequest).",
  "",
  "## Git Operations in ADE",
  "",
  "  All git operations are lane-scoped. Pass a laneId (defaults to the CTO's current lane if omitted).",
  "  Stage & commit: gitCommit({ laneId, message, stageAll: true }).",
  "  Push/pull/fetch: gitPush, gitPull, gitFetch.",
  "  Branch management: gitListBranches, gitCheckoutBranch({ branch, create: true }).",
  "  Stash: gitStashPush, gitStashPop, gitStashList.",
  "  Conflict handling: gitGetConflictState, gitRebaseContinue, gitRebaseAbort, gitMergeAbort.",
  "  History: gitListRecentCommits({ laneId, limit }).",
  "  Status: gitStatus({ laneId }) returns branch info, ahead/behind counts, dirty state.",
  "",
  "## Linear Integration",
  "",
  "  ADE integrates with Linear for issue tracking and workflow automation.",
  "  - List and inspect Linear issues: listLinearIssues, getLinearIssue.",
  "  - Update issues: updateLinearIssueAssignee, addLinearIssueLabel, updateLinearIssueState, commentOnLinearIssue.",
  "  - Route issues to work: routeLinearIssueToCto (handle yourself), routeLinearIssueToMission (auto-plan), routeLinearIssueToWorker (delegate).",
  "  - Workflow management: listLinearWorkflows, getLinearRunStatus, resolveLinearRunAction, cancelLinearRun, rerouteLinearRun.",
  "",
  "## Automation System",
  "",
  "  ADE automations are event-driven rules that trigger actions when conditions are met.",
  "  - List rules: listAutomations. Trigger manually: triggerAutomation. View history: listAutomationRuns.",
  "  - Rules can be configured in /automations or /settings.",
  "",
  "## CTO Continuity",
  "",
  "  ADE keeps CTO continuity through the current working context, recent sessions, and worker activity.",
  "",
  "## Tests",
  "",
  "  ADE discovers test suites from the project config and can run them per-lane.",
  "  - listTestSuites: see available test commands.",
  "  - runTests({ laneId, suiteId }): execute tests and get results.",
  "  - listTestRuns, getTestLog: review test history and output.",
  "",
  "## Task Routing (intent → tool mapping)",
  "",
  "  'Start a chat' or 'launch an agent' → spawnChat({ modelId, initialPrompt, title }).",
  "  'Start a chat with opus/sonnet/gpt-5.5/haiku' → spawnChat({ modelId: '<full-model-id>', ... }). Always map the name to the full ID.",
  "  'Check PR status' → getPullRequestStatus or getPullRequestConvergence.",
  "  'Start work on [feature]' → create/find a lane, then spawnChat or startMission.",
  "  'Open a terminal' → createTerminal.",
  "  'Run the tests' → listTestSuites to find available suites, then runTests.",
  "  'Commit and push' → gitCommit then gitPush.",
  "  'Check for conflicts' → getConflictStatus or getConflictRiskMatrix.",
  "  'Resolve merge conflicts' → getConflictStatus, requestConflictProposal, applyConflictProposal.",
  "  'Steer an active agent' → steerChat({ sessionId, instruction }).",
  "  'How is the project doing?' → getProjectHealthSummary.",
  "  'What happened recently?' → getRecentEvents.",
  "  'List all lanes' or 'show me the branches' → listLanes.",
  "  'Create a new branch for [feature]' → createLane({ name, description }).",
  "  'Read a file' → readWorkspaceFile({ filePath }).",
  "  'Search the code for [pattern]' → searchWorkspaceText({ query }) or searchCodebase({ pattern }).",
  "  'What model is this using?' → report the current session's model from your identity state.",
  "  'Review browser screenshots' → listComputerUseArtifacts, getArtifactPreview, reviewArtifact.",
  "  'How much are we spending?' → getProjectBudgetStatus or getWorkerCostBreakdown.",
  "  'Review this PR's code' → getPullRequestDiff, then approvePullRequest or requestPrChanges.",
  "  'Show me the Linear issues' → listLinearIssues.",
  "  'What processes are running?' → listManagedProcesses.",
  "  'Start the dev server' → startManagedProcess({ processId }) or createTerminal with the startup command.",
  "  'Rename this lane' → renameLane({ laneId, name }).",
  "  'Archive a lane' → archiveLane({ laneId }).",
  "  'Show me recent commits' → gitListRecentCommits.",
  "  'Create a PR for this lane' → createPrFromLane({ laneId, title, body }).",
  ].join("\n");
}

// Keep in sync with ctoOperatorTools.ts tool registrations
const CTO_CAPABILITY_MANIFEST = [
  "# ADE Operator Tools (complete reference)",
  "",
  "## Lanes (workspace isolation)",
  "  listLanes — List all lanes with status, branch info, ahead/behind counts.",
  "  inspectLane — Get detailed info for a single lane (worktree path, status, stack chain).",
  "  createLane — Create a new lane (git worktree + branch). Params: name, description, baseRef, parentLaneId.",
  "  deleteLane — Remove a lane and its worktree. Params: laneId.",
  "  renameLane — Change a lane's display name. Params: laneId, name.",
  "  archiveLane — Archive a lane (hides from default view, preserves data). Params: laneId.",
  "",
  "## Chats (AI work sessions)",
  "  listChats — List all chat sessions, optionally filtered by lane.",
  "  spawnChat — Create a new ADE chat session. THIS IS THE PRIMARY WAY TO LAUNCH AI AGENTS. Params: laneId, modelId (use full ID like 'anthropic/claude-sonnet-4-6'), reasoningEffort, title, initialPrompt, openInUi. The modelId is critical — always pass it when the user specifies a model.",
  "  sendChatMessage — Send a follow-up message to an existing chat; ended sessions continue from this message. Params: sessionId, text.",
  "  interruptChat — Stop a running turn in a chat. Params: sessionId.",
  "  getChatStatus — Get the current status of a chat (running, idle, ended). Params: sessionId.",
  "  getChatTranscript — Read the conversation history of a chat. Params: sessionId, limit.",
  "",
  "## Chat Steering (supervise active agents)",
  "  steerChat — Inject a steering instruction into an active chat session. Params: sessionId, instruction.",
  "  cancelSteer — Cancel a pending steer instruction. Params: sessionId.",
  "  handoffChat — Hand off a chat to a different agent identity. Params: sessionId, targetIdentityKey, reason.",
  "  listSubagents — List sub-agents spawned by a chat. Params: sessionId.",
  "  approveToolUse — Approve or deny a pending tool use in a supervised chat. Params: sessionId, toolUseId, decision (accept/accept_for_session/decline/cancel).",
  "",
  "## Missions (structured multi-step tasks)",
  "  listMissions — List all missions with status and summary.",
  "  startMission — Create and start a new mission. Params: title, description, laneId.",
  "  getMissionStatus — Get detailed mission status, progress, and outcomes. Params: missionId.",
  "  updateMission — Update mission title, description, or configuration. Params: missionId.",
  "  launchMissionRun — Launch or re-launch a mission execution run. Params: missionId.",
  "  resolveMissionIntervention — Resolve a human intervention checkpoint. Params: missionId, resolution.",
  "  getMissionRunView — Get the detailed run view with phase/step progress. Params: missionId.",
  "  getMissionLogs — Read mission execution logs. Params: missionId.",
  "  listMissionWorkerDigests — Get summaries of worker activity in a mission. Params: missionId.",
  "  steerMission — Inject a steering directive into a running mission. Params: missionId, instruction.",
  "",
  "## Workers (autonomous agent instances)",
  "  listWorkers — List all worker agents with status and budget info.",
  "  createWorker — Create a new worker agent. Params: name, description, role, laneId.",
  "  updateWorker — Update worker config (name, description, role, model prefs). Params: agentId.",
  "  removeWorker — Delete a worker agent. Params: agentId.",
  "  updateWorkerStatus — Change worker status (active, paused, idle). Params: agentId, status.",
  "  wakeWorker — Wake a worker with a specific task or issue. Params: agentId, taskKey, issueKey, message.",
  "  getWorkerStatus — Get detailed worker status with recent activity. Params: agentId.",
  "",
  "## Git (version control)",
  "  gitStatus — Branch info, ahead/behind, dirty state for a lane.",
  "  gitCommit — Create a commit. Params: laneId, message, stageAll (default true).",
  "  gitPush — Push commits to remote. Params: laneId, force.",
  "  gitPull — Pull from remote. Params: laneId, mode? (ff-only, rebase, merge).",
  "  gitUndoLastHeadChange / gitRedoLastHeadChange — Reset between ADE-recorded pre/post HEADs. Params: laneId.",
  "  gitFetch — Fetch remote refs. Params: laneId.",
  "  gitListRecentCommits — Show recent commits. Params: laneId, limit (default 20).",
  "  gitListBranches — List all branches. Params: laneId.",
  "  gitCheckoutBranch — Switch or create branch. Params: laneId, branch, create.",
  "  gitStashPush — Stash working changes. Params: laneId, message.",
  "  gitStashPop — Pop latest stash. Params: laneId.",
  "  gitStashList — List stashes. Params: laneId.",
  "  gitGetConflictState — Check for merge/rebase conflicts. Params: laneId.",
  "  gitRebaseContinue — Continue rebase after conflict resolution. Params: laneId.",
  "  gitRebaseAbort — Abort in-progress rebase. Params: laneId.",
  "  gitMergeAbort — Abort in-progress merge. Params: laneId.",
  "",
  "## Pull Requests",
  "  listPullRequests — List all tracked PRs with status.",
  "  getPullRequestStatus — Detailed PR status: checks, reviews, merge readiness. Params: prId.",
  "  commentOnPullRequest — Add a comment to a PR. Params: prId, body.",
  "  updatePullRequestTitle — Change PR title. Params: prId, title.",
  "  updatePullRequestBody — Change PR description. Params: prId, body.",
  "  createPrFromLane — Create a GitHub PR from a lane. Params: laneId, title, body, draft.",
  "  landPullRequest — Merge/land a PR. Params: prId, mergeMethod.",
  "  closePullRequest — Close a PR without merging. Params: prId.",
  "  requestPrReviewers — Request reviewers for a PR. Params: prId, reviewers.",
  "  getPullRequestDiff — Get the full diff for code review. Params: prId.",
  "  approvePullRequest — Approve a PR review. Params: prId, body.",
  "  requestPrChanges — Request changes on a PR. Params: prId, body.",
  "",
  "## Convergence (automated PR resolution)",
  "  getPullRequestConvergence — Get convergence status, issues, and round history. Params: prId.",
  "  updatePullRequestConvergencePipeline — Update pipeline settings for a PR. Params: prId.",
  "  updatePullRequestConvergenceRuntime — Update runtime state (enable/disable auto-converge). Params: prId.",
  "  startPullRequestConvergenceRound — Start an AI resolution round for PR issues. Params: prId.",
  "  stopPullRequestConvergence — Stop an active convergence run. Params: prId.",
  "",
  "## Conflict Resolution",
  "  getConflictStatus — Check merge conflict status for a lane. Params: laneId.",
  "  getConflictRiskMatrix — Risk matrix across all lanes (predicts conflicts before they happen).",
  "  simulateMerge — Dry-run merge between two lanes. Params: sourceLaneId, targetLaneId.",
  "  runConflictPrediction — Batch conflict prediction across all lanes.",
  "  listConflictProposals — List AI-generated resolution proposals. Params: laneId.",
  "  requestConflictProposal — Request AI resolution for a conflict. Params: laneId, filePath.",
  "  applyConflictProposal — Apply a resolution proposal. Params: laneId, proposalId.",
  "  undoConflictProposal — Revert an applied proposal. Params: laneId, proposalId.",
  "",
  "## Files",
  "  listFileWorkspaces — List file workspaces (one per lane).",
  "  readWorkspaceFile — Read a file's contents. Params: filePath, laneId.",
  "  searchWorkspaceText — Search for text patterns in workspace files. Params: query, laneId.",
  "  searchCodebase — Search the ADE codebase itself for patterns (for self-debugging). Params: pattern, fileGlob.",
  "",
  "## Processes (managed dev servers, builds, etc.)",
  "  listManagedProcesses — List defined processes and their runtime status.",
  "  startManagedProcess — Start a defined process. Params: processId, laneId.",
  "  stopManagedProcess — Stop a running process. Params: processId, laneId.",
  "  getManagedProcessLog — Read process log output. Params: processId, laneId.",
  "",
  "## Tests",
  "  listTestSuites — List available test suite definitions.",
  "  runTests — Run a test suite in a lane. Params: laneId, suiteId.",
  "  stopTestRun — Stop a running test. Params: runId.",
  "  listTestRuns — List recent test runs with pass/fail status.",
  "  getTestLog — Read test run output. Params: runId.",
  "",
  "## Terminals",
  "  createTerminal — Open a shell terminal in a lane. Params: laneId, title, startupCommand.",
  "",
  "## Linear Integration",
  "  listLinearWorkflows — List active Linear workflow runs.",
  "  getLinearRunStatus — Get status of a specific Linear workflow run. Params: runId.",
  "  resolveLinearRunAction — Approve/reject a Linear workflow action. Params: runId, action.",
  "  cancelLinearRun — Cancel a Linear workflow run. Params: runId.",
  "  rerouteLinearRun — Reroute a Linear run to a different handler. Params: runId, target.",
  "  commentOnLinearIssue — Add a comment to a Linear issue. Params: issueId, body.",
  "  updateLinearIssueState — Move a Linear issue to a new state. Params: issueId, stateId.",
  "  routeLinearIssueToCto — Route a Linear issue to yourself (the CTO) for handling.",
  "  routeLinearIssueToMission — Auto-create a mission from a Linear issue. Params: issueId.",
  "  routeLinearIssueToWorker — Delegate a Linear issue to a worker agent. Params: issueId, agentId.",
  "  listLinearIssues — Search/list Linear issues. Params: projectSlug, query, limit.",
  "  getLinearIssue — Get full detail of a Linear issue. Params: issueId.",
  "  updateLinearIssueAssignee — Assign/unassign a Linear issue. Params: issueId, assigneeId.",
  "  addLinearIssueLabel — Add a label to a Linear issue. Params: issueId, labelName.",
  "",
  "## Automations",
  "  listAutomations — List all automation rules.",
  "  triggerAutomation — Manually trigger an automation rule. Params: id, dryRun.",
  "  listAutomationRuns — List recent automation run history.",
  "",
  "## Events & Health",
  "  getRecentEvents — Unified feed of recent project events (sessions, worker activity, tests, PRs, missions, chats). Params: since, limit.",
  "  getProjectHealthSummary — Aggregate dashboard: mission counts, worker utilization, test pass rates, PR status, budget burn.",
  "",
  "## Computer Use",
  "  listComputerUseArtifacts — List browser screenshots and artifacts from computer use sessions.",
  "  getArtifactPreview — Preview a specific artifact. Params: artifactId.",
  "  reviewArtifact — Review and approve/reject a computer use artifact. Params: artifactId, decision.",
  "",
  "## Budget & Cost",
  "  getProjectBudgetStatus — Get project-wide budget and spending snapshot.",
  "  getWorkerCostBreakdown — Get cost breakdown per worker agent. Params: agentId, monthKey.",
  "",
  "# Operating Rules",
  "",
  "- Internal ADE actions run through service-backed tools even when no renderer click occurs.",
  "- UI navigation is suggestion-only. When an action should open in ADE, return an explicit navigation suggestion instead of silently switching tabs.",
  "- Treat ADE as your operating environment. Do not describe yourself as blocked on renderer button clicks when an internal tool can do the work.",
  "- When multiple tools exist for similar purposes, prefer the higher-level one (e.g., createPrFromLane over manual git commands).",
  "- Always default laneId to the CTO's current lane if the user doesn't specify one.",
  "- For model-specific requests, always resolve the user's model name to the full modelId before calling spawnChat.",
].join("\n");

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const normalized = typeof item === "string" ? item.trim() : "";
    if (!normalized.length) continue;
    out.push(normalized);
  }
  return out;
}

function safeYamlParse<T>(raw: string): T | null {
  try {
    return YAML.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeOnboardingState(value: unknown): CtoOnboardingState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const completedSteps = uniqueStrings(asStringArray(source.completedSteps));
  const dismissedAt =
    typeof source.dismissedAt === "string" && source.dismissedAt.trim().length
      ? source.dismissedAt.trim()
      : undefined;
  const completedAt =
    typeof source.completedAt === "string" && source.completedAt.trim().length
      ? source.completedAt.trim()
      : undefined;
  return {
    completedSteps,
    ...(dismissedAt ? { dismissedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

function normalizePersonalityPreset(value: unknown): CtoIdentity["personality"] | undefined {
  return value === "strategic"
    || value === "professional"
    || value === "hands_on"
    || value === "casual"
    || value === "minimal"
    || value === "custom"
    ? value
    : undefined;
}

function hasCompletedRequiredOnboardingSteps(state: CtoOnboardingState | null | undefined): boolean {
  const completedSteps = state?.completedSteps ?? [];
  return CTO_REQUIRED_ONBOARDING_STEPS.every((stepId) => completedSteps.includes(stepId));
}

function resolvePersonalityOverlay(identity: CtoIdentity): string {
  const presetId = identity.personality ?? "strategic";
  if (presetId === "custom") {
    const custom = identity.customPersonality?.trim() || identity.persona?.trim();
    if (custom?.length) return custom;
    return getCtoPersonalityPreset("custom").systemOverlay;
  }
  return getCtoPersonalityPreset(presetId).systemOverlay;
}

function normalizeIdentity(input: unknown): CtoIdentity | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const name = typeof source.name === "string" && source.name.trim().length ? source.name.trim() : "CTO";
  const persona = typeof source.persona === "string" && source.persona.trim().length
    ? source.persona.trim()
    : "Persistent technical lead for this project.";
  const version = Math.max(1, Math.floor(Number(source.version ?? 1)));
  const updatedAt = typeof source.updatedAt === "string" && source.updatedAt.trim().length
    ? source.updatedAt
    : nowIso();
  const modelPreferencesRaw =
    source.modelPreferences && typeof source.modelPreferences === "object"
      ? (source.modelPreferences as Record<string, unknown>)
      : {};
  const communicationStyleRaw =
    source.communicationStyle && typeof source.communicationStyle === "object"
      ? (source.communicationStyle as Record<string, unknown>)
      : {};
  const onboardingState = normalizeOnboardingState(source.onboardingState);
  const personality = normalizePersonalityPreset(source.personality);
  const customPersonality =
    typeof source.customPersonality === "string" && source.customPersonality.trim().length
      ? source.customPersonality.trim()
      : undefined;
  const communicationStyle: CtoIdentity["communicationStyle"] =
    typeof communicationStyleRaw.verbosity === "string"
    && typeof communicationStyleRaw.proactivity === "string"
    && typeof communicationStyleRaw.escalationThreshold === "string"
      ? {
          verbosity:
            communicationStyleRaw.verbosity === "detailed"
            || communicationStyleRaw.verbosity === "adaptive"
              ? communicationStyleRaw.verbosity
              : "concise",
          proactivity:
            communicationStyleRaw.proactivity === "balanced"
            || communicationStyleRaw.proactivity === "proactive"
              ? communicationStyleRaw.proactivity
              : "reactive",
          escalationThreshold:
            communicationStyleRaw.escalationThreshold === "low"
            || communicationStyleRaw.escalationThreshold === "high"
              ? communicationStyleRaw.escalationThreshold
              : "medium",
        }
      : undefined;
  const constraints = uniqueStrings(asStringArray(source.constraints));
  const systemPromptExtension =
    typeof source.systemPromptExtension === "string" && source.systemPromptExtension.trim().length
      ? source.systemPromptExtension.trim()
      : undefined;

  return {
    name,
    version,
    persona,
    ...(personality ? { personality } : {}),
    ...(customPersonality ? { customPersonality } : {}),
    ...(communicationStyle ? { communicationStyle } : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(systemPromptExtension ? { systemPromptExtension } : {}),
    modelPreferences: {
      provider: typeof modelPreferencesRaw.provider === "string" && modelPreferencesRaw.provider.trim().length
        ? modelPreferencesRaw.provider.trim()
        : "claude",
      model: typeof modelPreferencesRaw.model === "string" && modelPreferencesRaw.model.trim().length
        ? modelPreferencesRaw.model.trim()
        : "sonnet",
      ...(typeof modelPreferencesRaw.modelId === "string" && modelPreferencesRaw.modelId.trim().length
        ? { modelId: modelPreferencesRaw.modelId.trim() }
        : {}),
      ...(typeof modelPreferencesRaw.reasoningEffort === "string" || modelPreferencesRaw.reasoningEffort == null
        ? { reasoningEffort: (modelPreferencesRaw.reasoningEffort as string | null | undefined) ?? null }
        : {}),
    },
    ...(onboardingState ? { onboardingState } : {}),
    updatedAt,
  };
}

function squishText(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxLength = 220): string {
  const normalized = squishText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function normalizeSessionLogEntry(input: unknown): CtoSessionLogEntry | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const sessionId = typeof source.sessionId === "string" ? source.sessionId.trim() : "";
  const createdAt = typeof source.createdAt === "string" ? source.createdAt.trim() : "";
  const summary = typeof source.summary === "string" ? source.summary.trim() : "";
  const startedAt = typeof source.startedAt === "string" ? source.startedAt.trim() : "";
  const provider = typeof source.provider === "string" ? source.provider.trim() : "";
  if (!sessionId || !createdAt || !summary || !startedAt || !provider) return null;

  const capabilityMode = source.capabilityMode === "full_tooling" || source.capabilityMode === "full_mcp"
    ? "full_tooling"
    : "fallback";
  return {
    id: typeof source.id === "string" && source.id.trim().length ? source.id.trim() : randomUUID(),
    prevHash: typeof source.prevHash === "string" && source.prevHash.trim().length ? source.prevHash.trim() : null,
    sessionId,
    summary,
    startedAt,
    endedAt: typeof source.endedAt === "string" && source.endedAt.trim().length ? source.endedAt.trim() : null,
    provider,
    modelId: typeof source.modelId === "string" && source.modelId.trim().length ? source.modelId.trim() : null,
    capabilityMode,
    createdAt,
  };
}

function normalizeSubordinateActivityEntry(input: unknown): CtoSubordinateActivityEntry | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const agentId = typeof source.agentId === "string" ? source.agentId.trim() : "";
  const agentName = typeof source.agentName === "string" ? source.agentName.trim() : "";
  const summary = typeof source.summary === "string" ? source.summary.trim() : "";
  const createdAt = typeof source.createdAt === "string" ? source.createdAt.trim() : "";
  if (!agentId || !agentName || !summary || !createdAt) return null;
  const activityType = source.activityType === "worker_run" ? "worker_run" : "chat_turn";
  return {
    id: typeof source.id === "string" && source.id.trim().length ? source.id.trim() : randomUUID(),
    agentId,
    agentName,
    activityType,
    summary,
    sessionId: typeof source.sessionId === "string" && source.sessionId.trim().length ? source.sessionId.trim() : null,
    taskKey: typeof source.taskKey === "string" && source.taskKey.trim().length ? source.taskKey.trim() : null,
    issueKey: typeof source.issueKey === "string" && source.issueKey.trim().length ? source.issueKey.trim() : null,
    createdAt,
  };
}

function makeDefaultIdentity(): CtoIdentity {
  const timestamp = nowIso();
  return {
    name: "CTO",
    version: 1,
    persona: "Persistent project CTO for this ADE workspace.",
    personality: "strategic",
    modelPreferences: {
      provider: "claude",
      model: "sonnet",
      reasoningEffort: "high",
    },
    updatedAt: timestamp,
  };
}

export function createCtoStateService(args: CtoStateServiceArgs) {
  const logIntegrityService = createLogIntegrityService();
  const ctoDir = path.join(args.adeDir, "cto");
  const identityPath = path.join(ctoDir, "identity.yaml");
  // Only identity.yaml belongs to the shared Git-tracked ADE scaffold in W3.
  // The remaining files here are generated local/runtime state.
  const currentContextPath = path.join(ctoDir, "CURRENT.md");
  const sessionsPath = path.join(ctoDir, "sessions.jsonl");
  const subordinateActivityPath = path.join(ctoDir, "subordinate-activity.jsonl");

  fs.mkdirSync(ctoDir, { recursive: true });

  const readIdentityFromFile = (): PersistedDoc<CtoIdentity> | null => {
    if (!fs.existsSync(identityPath)) return null;
    const parsed = safeYamlParse<unknown>(fs.readFileSync(identityPath, "utf8"));
    const payload = normalizeIdentity(parsed);
    if (!payload) return null;
    return { payload, updatedAt: payload.updatedAt };
  };

  const readIdentityFromDb = (): PersistedDoc<CtoIdentity> | null => {
    const row = args.db.get<{ payload_json: string; updated_at: string }>(
      `select payload_json, updated_at from cto_identity_state where project_id = ? limit 1`,
      [args.projectId]
    );
    if (!row?.payload_json) return null;
    const payload = normalizeIdentity(safeJsonParse(row.payload_json, null));
    if (!payload) return null;
    const updatedAt = row.updated_at?.trim() || payload.updatedAt;
    return { payload: { ...payload, updatedAt }, updatedAt };
  };

  const writeIdentityToFile = (payload: CtoIdentity): void => {
    writeTextAtomic(identityPath, YAML.stringify(payload, { indent: 2 }));
  };

  const writeIdentityToDb = (payload: CtoIdentity): void => {
    args.db.run(
      `
        insert into cto_identity_state(project_id, version, payload_json, updated_at)
        values(?, ?, ?, ?)
        on conflict(project_id) do update set
          version = excluded.version,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `,
      [args.projectId, payload.version, JSON.stringify(payload), payload.updatedAt]
    );
  };

  const chooseCanonical = <T extends { updatedAt: string }>(
    fromFile: PersistedDoc<T> | null,
    fromDb: PersistedDoc<T> | null,
    defaultFactory: () => T,
  ): T => {
    if (!fromFile && !fromDb) return defaultFactory();
    if (fromFile && !fromDb) return fromFile.payload;
    if (!fromFile && fromDb) return fromDb.payload;

    const fileUpdated = parseIsoToEpoch(fromFile!.updatedAt);
    const dbUpdated = parseIsoToEpoch(fromDb!.updatedAt);

    if (Number.isFinite(fileUpdated) && Number.isFinite(dbUpdated)) {
      if (fileUpdated > dbUpdated) return fromFile!.payload;
      if (dbUpdated > fileUpdated) return fromDb!.payload;
    } else if (Number.isFinite(fileUpdated)) {
      return fromFile!.payload;
    } else if (Number.isFinite(dbUpdated)) {
      return fromDb!.payload;
    }

    // Tied timestamps or both invalid: prefer file source.
    return fromFile!.payload;
  };

  const listSessionLogsFromDb = (): CtoSessionLogEntry[] => {
    const rows = args.db.all<Record<string, unknown>>(
      `
        select id, session_id, summary, started_at, ended_at, provider, model_id, capability_mode, created_at
        from cto_session_logs
        where project_id = ?
        order by datetime(created_at) desc
      `,
      [args.projectId]
    );
    return rows
      .map((row) =>
        normalizeSessionLogEntry({
          id: row.id,
          sessionId: row.session_id,
          summary: row.summary,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          provider: row.provider,
          modelId: row.model_id,
          capabilityMode: row.capability_mode,
          createdAt: row.created_at,
        })
      )
      .filter((entry): entry is CtoSessionLogEntry => entry != null);
  };

  const listSessionLogsFromFile = (): CtoSessionLogEntry[] => {
    if (!fs.existsSync(sessionsPath)) return [];
    const raw = fs.readFileSync(sessionsPath, "utf8");
    const entries: CtoSessionLogEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.length) continue;
      const parsed = safeJsonParse<unknown>(trimmed, null);
      const normalized = normalizeSessionLogEntry(parsed);
      if (normalized) entries.push(normalized);
    }
    return entries;
  };

  const appendSessionLogToFile = (entry: CtoSessionLogEntry): CtoSessionLogEntry => {
    fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
    return logIntegrityService.appendEntry(sessionsPath, entry) as CtoSessionLogEntry;
  };

  const listSubordinateActivityFromFile = (): CtoSubordinateActivityEntry[] => {
    if (!fs.existsSync(subordinateActivityPath)) return [];
    const raw = fs.readFileSync(subordinateActivityPath, "utf8");
    const entries: CtoSubordinateActivityEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.length) continue;
      const parsed = safeJsonParse<unknown>(trimmed, null);
      const normalized = normalizeSubordinateActivityEntry(parsed);
      if (normalized) entries.push(normalized);
    }
    return entries;
  };

  const appendSubordinateActivityToFile = (entry: CtoSubordinateActivityEntry): void => {
    fs.mkdirSync(path.dirname(subordinateActivityPath), { recursive: true });
    fs.appendFileSync(subordinateActivityPath, `${JSON.stringify(entry)}\n`, "utf8");
  };

  const insertSessionLogToDb = (entry: CtoSessionLogEntry): void => {
    args.db.run(
      `
        insert or ignore into cto_session_logs(
          id, project_id, session_id, summary, started_at, ended_at, provider, model_id, capability_mode, created_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        entry.id,
        args.projectId,
        entry.sessionId,
        entry.summary,
        entry.startedAt,
        entry.endedAt,
        entry.provider,
        entry.modelId,
        entry.capabilityMode,
        entry.createdAt,
      ]
    );
  };

  const reconcileSessionLogs = (): void => {
    const dbEntries = listSessionLogsFromDb();
    const fileEntries = listSessionLogsFromFile();
    const dbKeySet = new Set(dbEntries.map((entry) => `${entry.sessionId}::${entry.createdAt}`));
    const fileKeySet = new Set(fileEntries.map((entry) => `${entry.sessionId}::${entry.createdAt}`));

    for (const entry of fileEntries) {
      const key = `${entry.sessionId}::${entry.createdAt}`;
      if (dbKeySet.has(key)) continue;
      insertSessionLogToDb(entry);
      dbKeySet.add(key);
    }

    for (const entry of dbEntries) {
      const key = `${entry.sessionId}::${entry.createdAt}`;
      if (fileKeySet.has(key)) continue;
      appendSessionLogToFile(entry);
      fileKeySet.add(key);
    }
  };

  const reconcileAll = (): CtoIdentity => {
    const identity = chooseCanonical(readIdentityFromFile(), readIdentityFromDb(), makeDefaultIdentity);
    writeIdentityToFile(identity);
    writeIdentityToDb(identity);
    reconcileSessionLogs();
    return identity;
  };

  const getIdentity = (): CtoIdentity => reconcileAll();

  const getSessionLogs = (limit = 20): CtoSessionLogEntry[] => {
    reconcileAll();
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return args.db
      .all<Record<string, unknown>>(
        `
          select id, session_id, summary, started_at, ended_at, provider, model_id, capability_mode, created_at
          from cto_session_logs
          where project_id = ?
          order by datetime(created_at) desc
          limit ?
        `,
        [args.projectId, safeLimit]
      )
      .map((row) =>
        normalizeSessionLogEntry({
          id: row.id,
          sessionId: row.session_id,
          summary: row.summary,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          provider: row.provider,
          modelId: row.model_id,
          capabilityMode: row.capability_mode,
          createdAt: row.created_at,
        })
      )
      .filter((entry): entry is CtoSessionLogEntry => entry != null);
  };

  const getSnapshot = (recentLimit = 20): CtoSnapshot => {
    const identity = reconcileAll();
    return {
      identity,
      recentSessions: getSessionLogs(recentLimit),
      recentSubordinateActivity: getSubordinateActivityLogs(recentLimit),
    };
  };

  const buildCurrentContextLines = (snapshot: CtoSnapshot): string[] => {
    const lines: string[] = ["## Recent CTO sessions"];
    if (snapshot.recentSessions.length > 0) {
      for (const entry of snapshot.recentSessions) {
        lines.push(`- [${entry.createdAt}] ${clipText(entry.summary, 220)}`);
      }
    } else {
      lines.push("- No recent CTO sessions recorded.");
    }

    if (snapshot.recentSubordinateActivity.length > 0) {
      lines.push("", "## Recent worker activity");
      for (const entry of snapshot.recentSubordinateActivity) {
        const detailParts = [
          entry.taskKey ? `task ${entry.taskKey}` : "",
          entry.issueKey ? `issue ${entry.issueKey}` : "",
        ].filter((part) => part.length > 0);
        lines.push(
          `- [${entry.createdAt}] ${entry.agentName}${detailParts.length ? ` (${detailParts.join(", ")})` : ""}: ${clipText(entry.summary, 220)}`
        );
      }
    }

    return lines;
  };

  const renderGeneratedContextDoc = (
    title: string,
    intro: string,
    bodyLines: ReadonlyArray<string>,
  ): string => {
    return [
      `# ${title}`,
      "",
      intro,
      "",
      ...bodyLines,
    ].join("\n").trim();
  };

  const syncDerivedContextDoc = (snapshot = getSnapshot(8)): void => {
    const currentContextBody = renderGeneratedContextDoc(
      "CTO Current Context",
      "Internal ADE-generated working context for session resumes.",
      buildCurrentContextLines(snapshot),
    );
    writeTextAtomic(currentContextPath, `${currentContextBody}\n`);
  };

  const appendSessionLog = (entry: AppendCtoSessionLogArgs): CtoSessionLogEntry => {
    reconcileAll();
    const next: CtoSessionLogEntry = {
      id: randomUUID(),
      sessionId: entry.sessionId,
      summary: entry.summary.trim() || "Session completed.",
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      provider: entry.provider,
      modelId: entry.modelId,
      capabilityMode: entry.capabilityMode,
      createdAt: nowIso(),
    };
    insertSessionLogToDb(next);
    const written = appendSessionLogToFile(next);
    syncDerivedContextDoc();
    return written;
  };

  const getSubordinateActivityLogs = (limit = 20): CtoSubordinateActivityEntry[] => {
    reconcileAll();
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return listSubordinateActivityFromFile()
      .sort((a, b) => parseIsoToEpoch(b.createdAt) - parseIsoToEpoch(a.createdAt))
      .slice(0, safeLimit);
  };

  const appendSubordinateActivity = (entry: AppendCtoSubordinateActivityArgs): CtoSubordinateActivityEntry => {
    reconcileAll();
    const next: CtoSubordinateActivityEntry = {
      id: randomUUID(),
      agentId: entry.agentId.trim(),
      agentName: entry.agentName.trim() || entry.agentId.trim(),
      activityType: entry.activityType,
      summary: entry.summary.trim() || "Worker activity recorded.",
      sessionId: typeof entry.sessionId === "string" && entry.sessionId.trim().length ? entry.sessionId.trim() : null,
      taskKey: typeof entry.taskKey === "string" && entry.taskKey.trim().length ? entry.taskKey.trim() : null,
      issueKey: typeof entry.issueKey === "string" && entry.issueKey.trim().length ? entry.issueKey.trim() : null,
      createdAt: nowIso(),
    };
    appendSubordinateActivityToFile(next);
    syncDerivedContextDoc();
    return next;
  };

  const buildReconstructionContext = (recentLimit = 8): string => {
    const snapshot = getSnapshot(recentLimit);
    const sections: string[] = [];
    sections.push("CTO Context");
    sections.push("The CTO state below is already reconstructed by ADE for this session. Do not burn turns trying to rediscover it by shelling into relative .ade/cto paths.");
    sections.push("- Runtime identity and operating doctrine keep you in the CTO role.");
    sections.push(`- Current working context at ${CTO_CURRENT_CONTEXT_RELATIVE_PATH} carries recent sessions and worker activity through session resumes.`);
    sections.push("");
    sections.push("ADE Operational Knowledge");
    sections.push(buildCtoEnvironmentKnowledge());
    sections.push("");
    sections.push("CTO Identity");
    sections.push(`- Name: ${snapshot.identity.name}`);
    sections.push(`- Persona: ${snapshot.identity.persona}`);
    sections.push(`- Preferred model: ${snapshot.identity.modelPreferences.provider}/${snapshot.identity.modelPreferences.model}`);
    sections.push("");
    sections.push("Current working context");
    sections.push(...buildCurrentContextLines(snapshot));

    return sections.join("\n").trim();
  };

  /* ── Onboarding state ── */

  const getOnboardingState = (): CtoOnboardingState => {
    const identity = getIdentity();
    return identity.onboardingState ?? { completedSteps: [] };
  };

  const persistOnboardingState = (next: CtoOnboardingState): CtoOnboardingState => {
    const identity = getIdentity();
    const updated: CtoIdentity = {
      ...identity,
      onboardingState: next,
      version: identity.version + 1,
      updatedAt: nowIso(),
    };
    writeIdentityToFile(updated);
    writeIdentityToDb(updated);
    syncDerivedContextDoc();
    return next;
  };

  const maybeMarkOnboardingComplete = (state: CtoOnboardingState): CtoOnboardingState => {
    if (hasCompletedRequiredOnboardingSteps(state) && !state.completedAt) {
      return { ...state, completedAt: nowIso() };
    }
    return state;
  };

  const completeOnboardingStep = (stepId: string): CtoOnboardingState => {
    const current = getOnboardingState();
    if (current.completedSteps.includes(stepId)) {
      const patched = maybeMarkOnboardingComplete(current);
      if (patched !== current) return persistOnboardingState(patched);
      return current;
    }
    const next = maybeMarkOnboardingComplete({
      ...current,
      completedSteps: [...current.completedSteps, stepId],
    });
    return persistOnboardingState(next);
  };

  const dismissOnboarding = (): CtoOnboardingState => {
    return persistOnboardingState({ ...getOnboardingState(), dismissedAt: nowIso() });
  };

  const resetOnboarding = (): CtoOnboardingState => {
    return persistOnboardingState({ completedSteps: [] });
  };

  /* ── Identity update (full patch) ── */

  const updateIdentity = (patch: Partial<Omit<CtoIdentity, "version" | "updatedAt">>): CtoSnapshot => {
    const current = getIdentity();
    const timestamp = nowIso();
    const candidate: CtoIdentity = {
      ...current,
      ...patch,
      modelPreferences: { ...current.modelPreferences, ...(patch.modelPreferences ?? {}) },
      version: current.version + 1,
      updatedAt: timestamp,
    };
    const next = normalizeIdentity(candidate) ?? candidate;
    writeIdentityToFile(next);
    writeIdentityToDb(next);
    const snapshot = getSnapshot();
    syncDerivedContextDoc(snapshot);
    return snapshot;
  };

  /* ── System prompt preview ── */

  const previewSystemPrompt = (identityOverride?: Partial<CtoIdentity>): CtoSystemPromptPreview => {
    const identity = identityOverride
      ? { ...getIdentity(), ...identityOverride }
      : getIdentity();
    const previewSections: CtoSystemPromptPreview["sections"] = [
      {
        id: "doctrine",
        title: "Immutable ADE doctrine",
        content: IMMUTABLE_CTO_DOCTRINE,
      },
      {
        id: "personality",
        title: "Selected personality overlay",
        content: resolvePersonalityOverlay(identity),
      },
      {
        id: "continuity",
        title: "Continuity model",
        content: CTO_CONTINUITY_OPERATING_MODEL,
      },
      {
        id: "knowledge",
        title: "ADE environment knowledge",
        content: buildCtoEnvironmentKnowledge(),
      },
      {
        id: "capabilities",
        title: "ADE operator tools",
        content: CTO_CAPABILITY_MANIFEST,
      },
    ];

    const prompt = [
      `You are ${identity.name}.`,
      ...previewSections.map((section) => `## ${section.title}\n${section.content}`),
      identity.systemPromptExtension?.trim() ? `## Extension\n${identity.systemPromptExtension.trim()}` : "",
    ].filter((section) => section.trim().length > 0).join("\n\n").trim();
    return {
      prompt,
      tokenEstimate: Math.ceil(prompt.length / 4),
      sections: previewSections,
    };
  };

  // Ensure the state is initialized as soon as the service is created.
  reconcileAll();
  syncDerivedContextDoc();

  return {
    getIdentity,
    getSessionLogs,
    getSubordinateActivityLogs,
    getSnapshot,
    updateIdentity,
    appendSessionLog,
    appendSubordinateActivity,
    buildReconstructionContext,
    getOnboardingState,
    completeOnboardingStep,
    dismissOnboarding,
    resetOnboarding,
    previewSystemPrompt,
    syncDerivedContextDoc,
  };
}

export type CtoStateService = ReturnType<typeof createCtoStateService>;
