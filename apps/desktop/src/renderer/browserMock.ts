/**
 * Browser-safe mock for `window.ade`.
 * Injected only when the Electron preload bridge is absent (i.e. opening the
 * Vite dev server directly in a regular browser).  Every method returns a
 * resolved promise with a sensible default value so the renderer can at least
 * paint the UI without crashing.
 *
 * This mock populates all 4 PRs tabs with realistic data:
 *   Normal  – 5 PRs (open/draft/merged/closed, varied checks/reviews)
 *   Queue   – 4 PRs in 2 queue groups with pipeline state
 *   Integration – 2 integration PRs with multi-source merge contexts
 *   Rebase  – 6 rebase needs across all urgency categories
 *
 * when a snapshot is exported; otherwise a built-in multi-command / groups / runtime demo is used.
 * Work tab: `sessions` come from the snapshot when present; otherwise built-in terminal session rows
 * (same shape as the export script) so the session list is not empty in Vite-only previews.
 * Linear: `getLinearConnectionStatus` and quick-view mocks stay in sync so the top-bar Linear
 * button appears; data is synthetic unless you use the Electron dev shell (real `window.ade` IPC).
 * For real Linear, sync, and lanes in Vite-only preview, run `npm run dev:vite:live` with
 * `ADE_PROJECT_ROOT` pointing at your ADE project (starts the browser runtime bridge).
 *
 * Optional: generate `browser-mock-ade-snapshot.generated.json` with
 *   npm run export:browser-mock-ade
 * to mirror the current project’s `.ade/ade.db` snapshot. Exported lanes, PRs,
 * queue/rebase/history/session/process rows replace the built-in demo data so
 * browser-only UI work follows the same local state as the desktop app.
 * Files tab: snapshot may include `filesTreeByWorkspace` / `filesContentsByWorkspace`
 * from the export script (disk walk at export time); without them, a small
 * synthetic tree is used per lane workspace id.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDefaultModelDescriptor } from "../shared/modelRegistry";
import { deriveSmartLinkPreview } from "../shared/smartLinks";
import { remoteProjectBindingKey } from "../shared/projectIdentity";
import {
  isAdeUsageRangePreset,
  type AdeUsageRangePreset,
  type AgentChatRecoverCodexTurnArgs,
  type AgentChatRecoverCodexTurnResult,
  type AgentChatRecoverTurnArgs,
  type AgentChatRecoverTurnResult,
  type AgentChatPrepareCrossMachineHandoffArgs,
  type AgentChatInterruptResult,
  type AgentChatRestoreCancelledQueueResult,
  type AgentChatResolveUnprocessedMessageArgs,
  type AgentChatResolveUnprocessedMessageResult,
  type RemoteRuntimeActionRequest,
} from "../shared/types";
import {
  ADE_WELCOME_VIDEO_ID,
  ADE_WELCOME_VIDEO_VERSION,
} from "../shared/welcomeVideo";
import { attachBrowserRuntimeBridge } from "./browserRuntimeBridge";

const noop = () => () => {};
const resolved =
  <T>(v: T) =>
  async () =>
    v;
const resolvedArg =
  <T>(v: T) =>
  async (_a: any) =>
    v;
const resolvedArg2 =
  <T>(v: T) =>
  async (_a: any, _b: any) =>
    v;
const DEFAULT_BROWSER_MOCK_CODEX_MODEL =
  getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.6-sol";
const DEFAULT_BROWSER_MOCK_CLAUDE_MODEL =
  getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-5";
const BROWSER_MOCK_PREVIEW_CAPABILITY_UNSUPPORTED = {
  platform: "darwin",
  supported: false,
  docsUrl: "https://developer.apple.com/documentation/xcode",
  xcodeVersion: null,
  mcpbridgeAvailable: false,
  xcodeRunning: false,
  xcodeWindows: [],
  selectedWindow: null,
  setupSteps: ["Browser preview cannot manage Xcode."],
  error: "Browser preview cannot manage Xcode.",
  checkedAt: "1970-01-01T00:00:00.000Z",
} as const;

const BUILTIN_MOCK_PROJECT = {
  id: "browser-mock",
  name: "Browser Preview",
  displayName: "Browser Preview",
  rootPath: "/tmp/mock",
  gitRemoteUrl: "https://github.com/acme/ade",
  gitDefaultBranch: "main",
  createdAt: new Date().toISOString(),
};

const adeDbSnapshotByPath = import.meta.glob<any>(
  "./browser-mock-ade-snapshot.generated.json",
  {
    eager: true,
    import: "default",
  },
);

const ADE_DB_SNAPSHOT =
  adeDbSnapshotByPath["./browser-mock-ade-snapshot.generated.json"] ?? null;
const USE_ADE_DB_SNAPSHOT = Boolean(ADE_DB_SNAPSHOT?.project);
const USE_STATS_DASHBOARD_SNAPSHOT = USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.statsDashboardVersion === 1;

const MOCK_PROJECT =
  USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.project
    ? {
        ...BUILTIN_MOCK_PROJECT,
        id: ADE_DB_SNAPSHOT.project.id,
        name: ADE_DB_SNAPSHOT.project.name,
        displayName: ADE_DB_SNAPSHOT.project.name,
        rootPath: ADE_DB_SNAPSHOT.project.rootPath,
        gitDefaultBranch:
          ADE_DB_SNAPSHOT.project.gitDefaultBranch ??
          BUILTIN_MOCK_PROJECT.gitDefaultBranch,
        createdAt:
          ADE_DB_SNAPSHOT.project.createdAt ?? BUILTIN_MOCK_PROJECT.createdAt,
      }
    : BUILTIN_MOCK_PROJECT;

// ── Timestamps ────────────────────────────────────────────────
const now = new Date().toISOString();

const WELCOME_VIDEO_STORAGE_KEY = "ade.browserMock.welcomeVideoState";

function readBrowserMockWelcomeVideoState() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WELCOME_VIDEO_STORAGE_KEY) ?? "null") as {
      videoId?: unknown;
      version?: unknown;
      completedAt?: unknown;
      dismissedAt?: unknown;
    } | null;
    if (parsed?.videoId === ADE_WELCOME_VIDEO_ID && parsed.version === ADE_WELCOME_VIDEO_VERSION) {
      return {
        videoId: ADE_WELCOME_VIDEO_ID,
        version: ADE_WELCOME_VIDEO_VERSION,
        completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null,
        dismissedAt: typeof parsed.dismissedAt === "string" ? parsed.dismissedAt : null,
      };
    }
  } catch {
    // Ignore malformed preview-only state.
  }
  return {
    videoId: ADE_WELCOME_VIDEO_ID,
    version: ADE_WELCOME_VIDEO_VERSION,
    completedAt: null,
    dismissedAt: null,
  };
}

function writeBrowserMockWelcomeVideoState(state: ReturnType<typeof readBrowserMockWelcomeVideoState>) {
  try {
    window.localStorage.setItem(WELCOME_VIDEO_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browser preview storage can be unavailable.
  }
}

const MOCK_LINEAR_CONNECTION = {
  tokenStored: true,
  connected: true,
  viewerId: "mock-linear-user",
  viewerName: "Mock Linear User",
  organizationId: "mock-linear-org",
  organizationName: "ADE",
  organizationUrlKey: "ade",
  organizationLogoUrl: null,
  projectCount: 1,
  projectPreview: ["Desktop polish"],
  checkedAt: now,
  authMode: "manual" as const,
  oauthAvailable: true,
  tokenExpiresAt: null,
  message: null,
};

const MOCK_LINEAR_PROJECTS = [
  {
    id: "mock-linear-project",
    name: "Desktop polish",
    slug: "desktop-polish",
    teamName: "ADE",
    teamKey: "ADE",
    icon: null,
    color: "#5E6AD2",
  },
];

const MOCK_LINEAR_ISSUES = [
  {
    id: "mock-linear-issue-1",
    identifier: "ADE-101",
    title: "Polish Work tab header layout",
    description: "Align tabs, tools toggle, and lane bands in the Work chrome.",
    url: "https://linear.app/ade/issue/ADE-101/polish-work-tab-header-layout",
    projectId: "mock-linear-project",
    projectSlug: "desktop-polish",
    projectName: "Desktop polish",
    teamId: "mock-linear-team",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "mock-linear-state-started",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: [],
    metadataTags: [],
    assigneeId: "mock-linear-user",
    assigneeName: "Mock Linear User",
    creatorId: "mock-linear-user",
    creatorName: "Mock Linear User",
    blockerIssueIds: [],
    hasOpenBlockers: false,
    dueDate: null,
    estimate: 3,
    archivedAt: null,
    completedAt: null,
    canceledAt: null,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    raw: {},
  },
  {
    id: "mock-linear-issue-2",
    identifier: "ADE-102",
    title: "Chat actions drawer parity",
    description: "Unify Proof, Agents, and Handoff into one tabbed drawer.",
    url: "https://linear.app/ade/issue/ADE-102/chat-actions-drawer-parity",
    projectId: "mock-linear-project",
    projectSlug: "desktop-polish",
    projectName: "Desktop polish",
    teamId: "mock-linear-team",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "mock-linear-state-todo",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 3,
    priorityLabel: "medium",
    labels: [],
    metadataTags: [],
    assigneeId: null,
    assigneeName: null,
    creatorId: "mock-linear-user",
    creatorName: "Mock Linear User",
    blockerIssueIds: [],
    hasOpenBlockers: false,
    dueDate: null,
    estimate: 2,
    archivedAt: null,
    completedAt: null,
    canceledAt: null,
    startedAt: null,
    createdAt: now,
    updatedAt: now,
    raw: {},
  },
];

const MOCK_LINEAR_PICKER = {
  projects: MOCK_LINEAR_PROJECTS,
  users: [
    {
      id: "mock-linear-user",
      name: "Mock Linear User",
      displayName: "Mock Linear User",
      email: "mock@example.com",
      avatarUrl: null,
      active: true,
    },
  ],
  states: [
    { id: "mock-linear-state-started", name: "In Progress", type: "started", teamId: "mock-linear-team" },
    { id: "mock-linear-state-todo", name: "Todo", type: "unstarted", teamId: "mock-linear-team" },
  ],
};

/** Browser mock lane health; matches `LaneHealthCheck` in shared types. */
function mockBrowserLaneHealth(laneId: string) {
  return {
    laneId,
    status: "unknown" as const,
    portResponding: false,
    respondingPort: null as number | null,
    proxyRouteActive: false,
    fallbackMode: false,
    lastCheckedAt: now,
    issues: [] as Array<{
      type:
        | "port-unresponsive"
        | "proxy-route-missing"
        | "port-conflict"
        | "env-init-failed";
      message: string;
      actionLabel?: string;
      actionType?:
        | "reassign-port"
        | "restart-proxy"
        | "reinit-env"
        | "enable-fallback"
        | "refresh-preview";
    }>,
  };
}

const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
const thirtyMinAgo = new Date(Date.now() - 1800000).toISOString();
const tenMinAgo = new Date(Date.now() - 600000).toISOString();
const fiveMinAgo = new Date(Date.now() - 300000).toISOString();
const yesterday = new Date(Date.now() - 86400000).toISOString();
const twoDaysAgo = new Date(Date.now() - 172800000).toISOString();
const threeDaysAgo = new Date(Date.now() - 259200000).toISOString();
const fourHoursFromNow = new Date(Date.now() + 4 * 3600000).toISOString();

// ── Orchestration demo data ──────────────────────────────────
const MOCK_ORCH_RUN_ID = "orch-run-demo-001";
const MOCK_ORCH_BUNDLE = "/tmp/mock/.ade/orchestration/" + MOCK_ORCH_RUN_ID;
const MOCK_ORCH_LEAD_SESSION = "mock-orch-lead";
const MOCK_ORCH_WORKER_1 = "mock-orch-worker-auth";
const MOCK_ORCH_WORKER_2 = "mock-orch-worker-dashboard";
const MOCK_ORCH_VALIDATOR = "mock-orch-validator";

const MOCK_ORCH_MANIFEST: any = {
  version: 1,
  runId: MOCK_ORCH_RUN_ID,
  laneId: "lane-main",
  bundlePath: MOCK_ORCH_BUNDLE,
  etag: "etag-42",
  serverGeneration: 42,
  createdAt: oneHourAgo,
  updatedAt: fiveMinAgo,
  title: "Implement user authentication + dashboard",
  goalSummary: "Add OAuth login flow with Google/GitHub, session management, and a post-login dashboard showing recent activity and quick actions.",
  currentPhase: "developing",
  phases: [
    { id: "planning", title: "Planning", status: "done", startedAt: oneHourAgo, completedAt: thirtyMinAgo },
    { id: "developing", title: "Developing", status: "active", startedAt: thirtyMinAgo },
    { id: "validating", title: "Validating", status: "pending" },
    { id: "wrapup", title: "Wrap-up", status: "pending" },
  ],
  agents: [
    { sessionId: MOCK_ORCH_LEAD_SESSION, role: "lead", goalSummary: "Coordinate auth + dashboard implementation", status: "running", lastHeartbeatAt: fiveMinAgo, spawnedAt: oneHourAgo, spawnFingerprint: { provider: "claude", modelId: "claude-sonnet-5", resolvedAt: oneHourAgo, routingKey: "default" } },
    { sessionId: MOCK_ORCH_WORKER_1, role: "worker", tag: "auth", displayName: "Auth flow worker", goalSummary: "Build OAuth login with Google + GitHub providers", status: "running", currentStepId: "T-auth-oauth", lastHeartbeatAt: fiveMinAgo, spawnedAt: thirtyMinAgo, spawnFingerprint: { provider: "claude", modelId: "claude-sonnet-5", resolvedAt: thirtyMinAgo, routingKey: "byTag" } },
    { sessionId: MOCK_ORCH_WORKER_2, role: "worker", tag: "dashboard", displayName: "Dashboard worker", goalSummary: "Build post-login dashboard with activity feed and quick actions", status: "running", currentStepId: "T-dash-layout", lastHeartbeatAt: tenMinAgo, spawnedAt: thirtyMinAgo, spawnFingerprint: { provider: "codex", modelId: "openai/o3", resolvedAt: thirtyMinAgo, routingKey: "byRoleTag" } },
    { sessionId: MOCK_ORCH_VALIDATOR, role: "validator", tag: "quality", displayName: "Quality validator", goalSummary: "Verify test coverage, type safety, and security review", status: "pending", spawnedAt: thirtyMinAgo, spawnFingerprint: { provider: "claude", modelId: "claude-sonnet-5", resolvedAt: thirtyMinAgo, routingKey: "byRole" } },
  ],
  tasks: [
    { id: "T-auth-oauth", phaseId: "developing", title: "OAuth provider integration", description: "Implement Google and GitHub OAuth flows with passport.js", status: "in_progress", tag: "auth", labels: ["backend", "security"], priority: "high", estimatedComplexity: "medium", filesHint: ["src/auth/oauth.ts", "src/auth/providers/google.ts", "src/auth/providers/github.ts"], assigneeSessionId: MOCK_ORCH_WORKER_1, claimedAt: thirtyMinAgo, validationGate: { required: true, stepIds: ["VS-auth-security"] }, attempts: [{ id: "att-1", sessionId: MOCK_ORCH_WORKER_1, startedAt: thirtyMinAgo, outcome: "succeeded" }] },
    { id: "T-auth-session", phaseId: "developing", title: "Session management", description: "Cookie-based session with Redis store, CSRF protection", status: "pending", tag: "auth", labels: ["backend", "security"], priority: "high", estimatedComplexity: "small", blockedBy: ["T-auth-oauth"], filesHint: ["src/auth/session.ts", "src/middleware/csrf.ts"], validationGate: { required: true, stepIds: ["VS-auth-security"] } },
    { id: "T-dash-layout", phaseId: "developing", title: "Dashboard layout + routing", description: "Post-login dashboard shell with sidebar nav and content area", status: "in_progress", tag: "dashboard", labels: ["frontend", "ui"], priority: "normal", estimatedComplexity: "medium", filesHint: ["src/pages/Dashboard.tsx", "src/components/DashboardShell.tsx"], assigneeSessionId: MOCK_ORCH_WORKER_2, claimedAt: thirtyMinAgo, validationGate: { required: false, stepIds: [] }, attempts: [{ id: "att-2", sessionId: MOCK_ORCH_WORKER_2, startedAt: thirtyMinAgo, outcome: "succeeded" }] },
    { id: "T-dash-activity", phaseId: "developing", title: "Activity feed component", description: "Real-time activity feed with infinite scroll and skeleton loading", status: "pending", tag: "dashboard", labels: ["frontend"], priority: "normal", estimatedComplexity: "small", blockedBy: ["T-dash-layout"], filesHint: ["src/components/ActivityFeed.tsx"], validationGate: { required: false, stepIds: [] } },
    { id: "T-dash-actions", phaseId: "developing", title: "Quick actions grid", description: "Grid of action cards with keyboard navigation", status: "pending", tag: "dashboard", labels: ["frontend"], priority: "low", estimatedComplexity: "trivial", blockedBy: ["T-dash-layout"], filesHint: ["src/components/QuickActions.tsx"], validationGate: { required: false, stepIds: [] } },
    { id: "T-plan-review", phaseId: "planning", title: "Architecture review", description: "Review proposed architecture, confirm tech stack", status: "done", tag: "planning", labels: ["planning"], priority: "critical", estimatedComplexity: "small", assigneeSessionId: MOCK_ORCH_LEAD_SESSION, validationGate: { required: false, stepIds: [] } },
  ],
  validationStrategy: {
    steps: [
      { id: "VS-auth-security", concern: "reverify_changes", scope: "per_worker", required: true, prompt: "Verify OAuth token handling, CSRF protection, and session cookie security flags", evidenceRequired: ["test_log", "diff_summary"] },
      { id: "VS-test-coverage", concern: "test_suite_truthfulness", scope: "mission_exit", required: true, prompt: "Run full test suite, verify >80% branch coverage on new code", evidenceRequired: ["test_log"] },
    ],
    checklist: [],
  },
  modelRouting: {
    default: { provider: "claude", modelId: "claude-sonnet-5" },
    byRole: { validator: { provider: "claude", modelId: "claude-sonnet-5", reasoningEffort: "high" } },
    byTag: { auth: { provider: "claude", modelId: "claude-sonnet-5" } },
    byRoleTag: { "worker:dashboard": { provider: "codex", modelId: "openai/o3" } },
  },
  assets: [
    { id: "asset-1", path: "artifacts/ui/dashboard-wireframe.html", kind: "html_spec", version: 1, approval: "approved" },
    { id: "asset-2", path: "artifacts/auth-flow-diagram.md", kind: "doc", version: 1 },
  ],
  decisions: [
    { id: "D-1", at: oneHourAgo, source: "user", summary: "Use passport.js for OAuth instead of custom implementation" },
    { id: "D-2", at: thirtyMinAgo, source: "lead", summary: "Split auth and dashboard into parallel work streams" },
  ],
  userOverrides: [],
  leadState: { lastSnapshotEtag: "etag-40", lastSnapshotSeenAt: tenMinAgo, planApprovedAt: thirtyMinAgo },
  history: [
    { etag: "etag-1", at: oneHourAgo, summary: "Run created", patchKindSummary: "core" },
    { etag: "etag-20", at: thirtyMinAgo, summary: "Plan approved, entering development", patchKindSummary: "phase" },
    { etag: "etag-30", at: thirtyMinAgo, summary: "Workers spawned for auth and dashboard", patchKindSummary: "agent" },
    { etag: "etag-42", at: fiveMinAgo, summary: "Auth worker claimed T-auth-oauth", patchKindSummary: "task" },
  ],
};

const MOCK_ORCH_PLAN_MD = `# Auth + Dashboard Implementation Plan

## Architecture

OAuth flow uses passport.js with Google and GitHub strategies.
Sessions stored in Redis with \`connect-redis\`.
Dashboard is a React SPA with server-side data fetching.

\`\`\`mermaid
graph LR
  A[Login Page] --> B{OAuth Provider}
  B --> C[Google]
  B --> D[GitHub]
  C --> E[Callback Handler]
  D --> E
  E --> F[Session Created]
  F --> G[Dashboard]
\`\`\`

## Task Breakdown

### Auth Stream (tag: auth)
1. **T-auth-oauth** — OAuth provider integration (Google + GitHub)
2. **T-auth-session** — Session management (Redis, CSRF, expiry)

### Dashboard Stream (tag: dashboard)
3. **T-dash-layout** — Dashboard layout + routing
4. **T-dash-activity** — Activity feed component
5. **T-dash-actions** — Quick actions grid

## Validation Strategy

- **Security review** (per-worker): OAuth token handling, CSRF, cookie flags
- **Test coverage** (exit gate): >80% branch coverage on new code

## Decisions

- passport.js over custom OAuth (user decision)
- Parallel auth + dashboard streams (lead decision, no shared code)
`;

const MOCK_ORCH_SESSIONS: any[] = [
  {
    id: MOCK_ORCH_LEAD_SESSION, laneId: "lane-main", laneName: "main", ptyId: null, tracked: true, pinned: false, manuallyNamed: false,
    goal: "Coordinate auth + dashboard implementation", toolType: "claude-chat", title: "Orchestrator Lead", status: "running",
    startedAt: oneHourAgo, endedAt: null, archivedAt: null, exitCode: null, transcriptPath: null, headShaStart: null, headShaEnd: null,
    lastOutputPreview: "Workers spawned. Auth and dashboard streams running in parallel.", summary: null, runtimeState: "running", resumeCommand: null,
    resumeMetadata: { provider: "claude", targetKind: "session", targetId: MOCK_ORCH_LEAD_SESSION, modelId: "claude-sonnet-5", model: "Sonnet 5", interactionMode: "orchestrator-lead", launch: {} },
    orchestrationRunId: MOCK_ORCH_RUN_ID, orchestrationRole: "lead", orchestrationBundlePath: MOCK_ORCH_BUNDLE,
  },
  {
    id: MOCK_ORCH_WORKER_1, laneId: "lane-main", laneName: "main", ptyId: null, tracked: true, pinned: false, manuallyNamed: false,
    goal: "Build OAuth login with Google + GitHub providers", toolType: "claude-chat", title: "Auth flow worker", status: "running",
    startedAt: thirtyMinAgo, endedAt: null, archivedAt: null, exitCode: null, transcriptPath: null, headShaStart: null, headShaEnd: null,
    lastOutputPreview: "Implementing Google OAuth callback handler…", summary: null, runtimeState: "running", resumeCommand: null,
    resumeMetadata: { provider: "claude", targetKind: "session", targetId: MOCK_ORCH_WORKER_1, modelId: "claude-sonnet-5", model: "Sonnet 5", interactionMode: "orchestrator-worker", launch: {} },
    orchestrationRunId: MOCK_ORCH_RUN_ID, orchestrationRole: "worker", orchestrationTag: "auth", orchestrationStepId: "T-auth-oauth", orchestrationParentSessionId: MOCK_ORCH_LEAD_SESSION, orchestrationBundlePath: MOCK_ORCH_BUNDLE,
  },
  {
    id: MOCK_ORCH_WORKER_2, laneId: "lane-main", laneName: "main", ptyId: null, tracked: true, pinned: false, manuallyNamed: false,
    goal: "Build dashboard layout and routing", toolType: "codex-chat", title: "Dashboard worker", status: "running",
    startedAt: thirtyMinAgo, endedAt: null, archivedAt: null, exitCode: null, transcriptPath: null, headShaStart: null, headShaEnd: null,
    lastOutputPreview: "Setting up dashboard shell with sidebar navigation…", summary: null, runtimeState: "running", resumeCommand: null,
    resumeMetadata: { provider: "codex", targetKind: "session", targetId: MOCK_ORCH_WORKER_2, modelId: "openai/o3", model: "o3", interactionMode: "orchestrator-worker", launch: {} },
    orchestrationRunId: MOCK_ORCH_RUN_ID, orchestrationRole: "worker", orchestrationTag: "dashboard", orchestrationStepId: "T-dash-layout", orchestrationParentSessionId: MOCK_ORCH_LEAD_SESSION, orchestrationBundlePath: MOCK_ORCH_BUNDLE,
  },
  {
    id: MOCK_ORCH_VALIDATOR, laneId: "lane-main", laneName: "main", ptyId: null, tracked: true, pinned: false, manuallyNamed: false,
    goal: "Verify test coverage and security review", toolType: "claude-chat", title: "Quality validator", status: "idle",
    startedAt: thirtyMinAgo, endedAt: null, archivedAt: null, exitCode: null, transcriptPath: null, headShaStart: null, headShaEnd: null,
    lastOutputPreview: "Waiting for development phase to complete…", summary: null, runtimeState: "idle", resumeCommand: null,
    resumeMetadata: { provider: "claude", targetKind: "session", targetId: MOCK_ORCH_VALIDATOR, modelId: "claude-sonnet-5", model: "Sonnet 5", interactionMode: "orchestrator-validator", launch: {} },
    orchestrationRunId: MOCK_ORCH_RUN_ID, orchestrationRole: "validator", orchestrationTag: "quality", orchestrationParentSessionId: MOCK_ORCH_LEAD_SESSION, orchestrationBundlePath: MOCK_ORCH_BUNDLE,
  },
];

// ── Lane defaults (fields required by LaneSummary) ────────────
function makeLane(
  id: string,
  name: string,
  branchRef: string,
  opts?: Partial<any>,
): any {
  return {
    id,
    name,
    description: null,
    laneType: id === "lane-main" ? "primary" : "worktree",
    baseRef: "main",
    branchRef,
    worktreePath: `/tmp/mock/${id}`,
    attachedRootPath: null,
    parentLaneId: id === "lane-main" ? null : "lane-main",
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: 0,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    createdAt: twoDaysAgo,
    archivedAt: null,
    ...opts,
  };
}

// ── Mock Lanes ────────────────────────────────────────────────
const BUILTIN_MOCK_LANES: any[] = [
  // Primary
  makeLane("lane-main", "main", "refs/heads/main"),
  // Normal PR lanes
  makeLane("lane-auth", "feature/auth-flow", "refs/heads/feature/auth-flow"),
  makeLane(
    "lane-dashboard",
    "feature/dashboard-v2",
    "refs/heads/feature/dashboard-v2",
  ),
  makeLane(
    "lane-api",
    "feature/api-refactor",
    "refs/heads/feature/api-refactor",
  ),
  makeLane(
    "lane-perf",
    "fix/perf-regression",
    "refs/heads/fix/perf-regression",
  ),
  makeLane(
    "lane-onboard",
    "feature/onboarding-wizard",
    "refs/heads/feature/onboarding-wizard",
  ),
  // Queue PR lanes
  makeLane("lane-payments", "feature/payments", "refs/heads/feature/payments"),
  makeLane(
    "lane-checkout",
    "feature/checkout-flow",
    "refs/heads/feature/checkout-flow",
  ),
  makeLane(
    "lane-notifications",
    "feature/notifications",
    "refs/heads/feature/notifications",
  ),
  makeLane(
    "lane-billing",
    "feature/billing-v2",
    "refs/heads/feature/billing-v2",
  ),
  // Integration PR lanes
  makeLane("lane-search", "feature/search-v2", "refs/heads/feature/search-v2"),
  makeLane(
    "lane-analytics",
    "feature/analytics",
    "refs/heads/feature/analytics",
  ),
  makeLane("lane-i18n", "feature/i18n", "refs/heads/feature/i18n"),
  makeLane(
    "lane-a11y",
    "feature/accessibility",
    "refs/heads/feature/accessibility",
  ),
];

/** Work tab preview when the snapshot omits `sessions` (matches export script row shape). */
const BUILTIN_MOCK_SESSIONS: any[] = [
  {
    id: "mock-session-claude-1",
    laneId: "lane-main",
    laneName: "main",
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: "Polish Run and Work browser mocks",
    toolType: "claude-chat",
    title: "Claude · Browser preview parity",
    status: "running",
    startedAt: oneHourAgo,
    endedAt: null,
    archivedAt: null,
    exitCode: null,
    transcriptPath: ".ade/transcripts/mock-session-claude-1.chat.jsonl",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: "Planning UI tweaks…",
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    resumeMetadata: {
      provider: "claude",
      targetKind: "session",
      targetId: "mock-session-claude-1",
      launch: {},
    },
  },
  {
    id: "mock-session-codex-1",
    laneId: "lane-auth",
    laneName: "feature/auth-flow",
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: "Tighten agent chat IPC merge path",
    toolType: "codex-chat",
    title: "Codex · IPC merge review",
    status: "completed",
    startedAt: yesterday,
    endedAt: oneHourAgo,
    archivedAt: null,
    exitCode: 0,
    transcriptPath: ".ade/transcripts/mock-session-codex-1.chat.jsonl",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: "Done.",
    summary: "Reviewed session merge logic.",
    runtimeState: "exited",
    resumeCommand: null,
    resumeMetadata: {
      provider: "codex",
      targetKind: "session",
      targetId: "mock-session-codex-1",
      launch: {},
    },
  },
  {
    id: "mock-session-shell-1",
    laneId: "lane-main",
    laneName: "main",
    ptyId: "pty-mock-1",
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: null,
    toolType: "shell",
    title: "npm run typecheck",
    status: "completed",
    startedAt: twoDaysAgo,
    endedAt: yesterday,
    archivedAt: null,
    exitCode: 0,
    transcriptPath: ".ade/transcripts/mock-session-shell-1.log",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: "> tsc --noEmit\n",
    summary: null,
    runtimeState: "exited",
    resumeCommand: null,
    resumeMetadata: null,
  },
];

function buildMockLanesFromAdeSnapshot(laneRows: any[]): any[] {
  const childCounts = new Map<string, number>();
  for (const row of laneRows) {
    const pid = row.parentLaneId;
    if (typeof pid === "string" && pid.length > 0) {
      childCounts.set(pid, (childCounts.get(pid) ?? 0) + 1);
    }
  }
  return laneRows.map((raw) => {
    const id = String(raw.id);
    let branchRef = String(raw.branchRef ?? "refs/heads/main");
    if (!branchRef.startsWith("refs/")) {
      branchRef = `refs/heads/${branchRef.replace(/^refs\/heads\//, "")}`;
    }
    const st = raw.status;
    return {
      id,
      name: String(raw.name ?? "lane"),
      description: raw.description ?? null,
      laneType:
        raw.laneType === "primary" ||
        raw.laneType === "worktree" ||
        raw.laneType === "attached"
          ? raw.laneType
          : "worktree",
      baseRef: String(raw.baseRef ?? "main"),
      branchRef,
      worktreePath: String(raw.worktreePath ?? "/tmp/mock"),
      attachedRootPath: raw.attachedRootPath ?? null,
      parentLaneId: raw.parentLaneId ?? null,
      childCount: childCounts.get(id) ?? 0,
      stackDepth: 0,
      parentStatus: null,
      isEditProtected: Boolean(raw.isEditProtected),
      status: {
        dirty: Boolean(st?.dirty),
        ahead: st?.ahead ?? 0,
        behind: st?.behind ?? 0,
        remoteBehind: st?.remoteBehind ?? -1,
        rebaseInProgress: Boolean(st?.rebaseInProgress),
      },
      color: raw.color ?? null,
      icon: raw.icon ?? null,
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      folder: raw.folder ?? null,
      createdAt: raw.createdAt ?? now,
      archivedAt: raw.archivedAt ?? null,
    };
  });
}

const MOCK_LANES: any[] = USE_ADE_DB_SNAPSHOT
  ? buildMockLanesFromAdeSnapshot(
      Array.isArray(ADE_DB_SNAPSHOT?.lanes) ? ADE_DB_SNAPSHOT.lanes : [],
    )
  : BUILTIN_MOCK_LANES;

const ADE_DB_PR_SNAPSHOTS: any[] =
  USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.prSnapshots)
    ? ADE_DB_SNAPSHOT.prSnapshots
    : [];
const ADE_DB_PR_SNAPSHOT_BY_ID = new Map<string, any>(
  ADE_DB_PR_SNAPSHOTS.map((snapshot) => [String(snapshot.prId), snapshot]),
);
const ADE_DB_OPERATIONS: any[] =
  USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.operations)
    ? ADE_DB_SNAPSHOT.operations
    : [];
const ADE_DB_SESSIONS: any[] =
  USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.sessions)
    ? ADE_DB_SNAPSHOT.sessions
    : [];
/** Prefer exported DB rows when present; otherwise built-ins so Work is usable without a snapshot file.
 *  Always append orchestration demo sessions so the orchestration panel is populated. */
const MOCK_SESSIONS: any[] = [
  ...(ADE_DB_SESSIONS.length > 0 ? ADE_DB_SESSIONS : BUILTIN_MOCK_SESSIONS),
  ...MOCK_ORCH_SESSIONS,
];
const ADE_DB_CHAT_TRANSCRIPTS: Record<
  string,
  { events?: any[]; path?: string | null }
> =
  USE_ADE_DB_SNAPSHOT &&
  ADE_DB_SNAPSHOT?.chatTranscripts &&
  typeof ADE_DB_SNAPSHOT.chatTranscripts === "object"
    ? ADE_DB_SNAPSHOT.chatTranscripts
    : {};
const ADE_DB_AUTOMATIONS =
  USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.automations
    ? ADE_DB_SNAPSHOT.automations
    : null;

function normalizeBrowserMockRelPath(rel: unknown): string {
  let s = String(rel ?? "")
    .trim()
    .replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s === "." || s === "/") return "";
  return s.replace(/\/+$/, "");
}

function languageIdForBrowserMockPath(relPath: string): string {
  const lower = relPath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs")
    return "javascript";
  if (ext === ".json") return "json";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".md") return "markdown";
  if (ext === ".py") return "python";
  if (ext === ".css") return "css";
  if (ext === ".html") return "html";
  if (ext === ".swift") return "swift";
  return "plaintext";
}

/** Depth-1 listTree rows keyed by parent path ("" = workspace root), from `export-browser-mock-ade-snapshot.mjs`. */
const ADE_DB_FILES_TREE_BY_WORKSPACE: Record<
  string,
  Record<string, any[]>
> = USE_ADE_DB_SNAPSHOT &&
ADE_DB_SNAPSHOT?.filesTreeByWorkspace &&
typeof ADE_DB_SNAPSHOT.filesTreeByWorkspace === "object"
  ? ADE_DB_SNAPSHOT.filesTreeByWorkspace
  : {};

const ADE_DB_FILES_CONTENTS_BY_WORKSPACE: Record<
  string,
  Record<string, any>
> = USE_ADE_DB_SNAPSHOT &&
ADE_DB_SNAPSHOT?.filesContentsByWorkspace &&
typeof ADE_DB_SNAPSHOT.filesContentsByWorkspace === "object"
  ? ADE_DB_SNAPSHOT.filesContentsByWorkspace
  : {};

function makeBuiltinSyntheticFilesTreeIndex(): Record<string, any[]> {
  return {
    "": [
      { name: "apps", path: "apps", type: "directory", changeStatus: null },
      { name: "docs", path: "docs", type: "directory", changeStatus: null },
      {
        name: "AGENTS.md",
        path: "AGENTS.md",
        type: "file",
        changeStatus: null,
      },
      {
        name: "package.json",
        path: "package.json",
        type: "file",
        changeStatus: null,
      },
    ],
    apps: [
      {
        name: "desktop",
        path: "apps/desktop",
        type: "directory",
        changeStatus: null,
      },
      {
        name: "ade-cli",
        path: "apps/ade-cli",
        type: "directory",
        changeStatus: null,
      },
    ],
    "apps/desktop": [
      {
        name: "package.json",
        path: "apps/desktop/package.json",
        type: "file",
        changeStatus: null,
      },
      {
        name: "src",
        path: "apps/desktop/src",
        type: "directory",
        changeStatus: null,
      },
    ],
    "apps/desktop/src": [
      {
        name: "renderer",
        path: "apps/desktop/src/renderer",
        type: "directory",
        changeStatus: null,
      },
    ],
    "apps/desktop/src/renderer": [
      {
        name: "browserMock.ts",
        path: "apps/desktop/src/renderer/browserMock.ts",
        type: "file",
        changeStatus: null,
      },
    ],
    docs: [
      {
        name: "README.md",
        path: "docs/README.md",
        type: "file",
        changeStatus: null,
      },
    ],
  };
}

const BUILTIN_FILES_TREE_BY_WORKSPACE: Record<
  string,
  Record<string, any[]>
> = Object.fromEntries(
  MOCK_LANES.map((lane) => [
    String(lane.id),
    makeBuiltinSyntheticFilesTreeIndex(),
  ]),
);

function getBrowserMockFilesWorkspaces(): any[] {
  return [...MOCK_LANES]
    .map((lane) => {
      const laneType =
        lane.laneType === "primary" ||
        lane.laneType === "attached" ||
        lane.laneType === "worktree"
          ? lane.laneType
          : "worktree";
      return {
        id: String(lane.id),
        kind: laneType,
        laneId: String(lane.id),
        name: String(lane.name ?? lane.id),
        branchRef:
          typeof lane.branchRef === "string" ? lane.branchRef : undefined,
        rootPath: String(lane.worktreePath ?? MOCK_PROJECT.rootPath),
        isReadOnlyByDefault: false,
        mobileReadOnly: true,
      };
    })
    .sort((a, b) => {
      if (a.kind === b.kind) return 0;
      if (a.kind === "primary") return -1;
      if (b.kind === "primary") return 1;
      return 0;
    });
}

function getBrowserMockListTreeNodes(
  workspaceId: string,
  parentPath: string,
): any[] {
  const parentKey = normalizeBrowserMockRelPath(parentPath);
  const snapTree = ADE_DB_FILES_TREE_BY_WORKSPACE[workspaceId];
  if (snapTree && Object.prototype.hasOwnProperty.call(snapTree, parentKey)) {
    const rows = snapTree[parentKey];
    return Array.isArray(rows) ? rows : [];
  }
  const builtin = BUILTIN_FILES_TREE_BY_WORKSPACE[workspaceId];
  if (builtin && Object.prototype.hasOwnProperty.call(builtin, parentKey)) {
    const rows = builtin[parentKey];
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

function getBrowserMockReadFilePayload(
  workspaceId: string,
  relPath: string,
): any {
  const normalized = normalizeBrowserMockRelPath(relPath);
  const fromSnapshot =
    ADE_DB_FILES_CONTENTS_BY_WORKSPACE[workspaceId]?.[normalized];
  if (fromSnapshot && typeof fromSnapshot.content === "string") {
    return {
      content: fromSnapshot.content,
      encoding: fromSnapshot.encoding ?? "utf-8",
      size: Number(fromSnapshot.size ?? fromSnapshot.content.length),
      languageId:
        fromSnapshot.languageId ?? languageIdForBrowserMockPath(normalized),
      isBinary: Boolean(fromSnapshot.isBinary),
    };
  }
  const stub = `// Browser mock (Vite preview)\n// Workspace ${workspaceId}\n// ${normalized || "(root)"}\n// Export with: npm run export:browser-mock-ade\n`;
  return {
    content: stub,
    encoding: "utf-8",
    size: new TextEncoder().encode(stub).length,
    languageId: languageIdForBrowserMockPath(normalized),
    isBinary: false,
  };
}

function isMockChatToolType(toolType: unknown): boolean {
  const normalized = String(toolType ?? "")
    .trim()
    .toLowerCase();
  return Boolean(
    normalized &&
    (normalized === "codex-chat" ||
      normalized === "claude-chat" ||
      normalized === "opencode-chat" ||
      normalized === "cursor" ||
      normalized === "droid" ||
      normalized === "droid-chat" ||
      normalized.endsWith("-chat")),
  );
}

function inferMockChatProvider(
  session: any,
): "claude" | "codex" | "cursor" | "droid" | "opencode" {
  const metadataProvider = String(session?.resumeMetadata?.provider ?? "")
    .trim()
    .toLowerCase();
  if (
    metadataProvider === "claude" ||
    metadataProvider === "codex" ||
    metadataProvider === "cursor" ||
    metadataProvider === "droid" ||
    metadataProvider === "opencode"
  ) {
    return metadataProvider;
  }
  const toolType = String(session?.toolType ?? "")
    .trim()
    .toLowerCase();
  if (toolType.startsWith("claude")) return "claude";
  if (toolType.startsWith("codex")) return "codex";
  if (toolType === "cursor" || toolType.startsWith("cursor")) return "cursor";
  if (toolType === "droid-chat" || toolType.startsWith("droid")) return "droid";
  return "opencode";
}

function getMockChatTranscriptEvents(sessionId: string): any[] {
  const events = ADE_DB_CHAT_TRANSCRIPTS[sessionId]?.events;
  return Array.isArray(events)
    ? events.filter((entry) => entry?.sessionId === sessionId && entry?.event)
    : [];
}

function latestMockDoneEvent(events: any[]): any | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "done") return event;
  }
  return null;
}

function fallbackMockModelForProvider(
  provider: "claude" | "codex" | "cursor" | "droid" | "opencode",
): string {
  if (provider === "claude") return "sonnet";
  if (provider === "codex") return DEFAULT_BROWSER_MOCK_CODEX_MODEL;
  if (provider === "cursor") return "auto";
  if (provider === "droid") return "claude-opus-4-6";
  return "opencode/mock";
}

function fallbackMockModelIdForProvider(
  provider: "claude" | "codex" | "cursor" | "droid" | "opencode",
): string {
  if (provider === "claude") return DEFAULT_BROWSER_MOCK_CLAUDE_MODEL;
  if (provider === "codex") return DEFAULT_BROWSER_MOCK_CODEX_MODEL;
  if (provider === "cursor") return "cursor/auto";
  if (provider === "droid") return "droid/claude-opus-4-6";
  return "opencode/mock";
}

function mockAgentChatSummaryFromSession(session: any): any | null {
  if (!session || !isMockChatToolType(session.toolType)) return null;
  const provider = inferMockChatProvider(session);
  const events = getMockChatTranscriptEvents(String(session.id));
  const done = latestMockDoneEvent(events);
  const modelId = String(
    session.resumeMetadata?.modelId ??
      session.resumeMetadata?.launch?.modelId ??
      done?.modelId ??
      fallbackMockModelIdForProvider(provider),
  );
  const model = String(
    session.resumeMetadata?.model ??
      session.resumeMetadata?.launch?.model ??
      done?.model ??
      fallbackMockModelForProvider(provider),
  );
  const endedAt = session.endedAt ?? null;
  const lastActivityAt =
    session.lastActivityAt ?? session.endedAt ?? session.startedAt ?? now;
  const status = session.status === "running" ? "idle" : "ended";
  return {
    sessionId: String(session.id),
    laneId: String(session.laneId ?? ""),
    provider,
    model,
    modelId,
    sessionProfile: session.resumeMetadata?.sessionProfile ?? "workflow",
    title: session.title ?? null,
    goal: session.goal ?? null,
    reasoningEffort: session.resumeMetadata?.reasoningEffort ?? null,
    fastMode: (session.resumeMetadata?.fastMode ?? session.resumeMetadata?.codexFastMode) === true,
    executionMode: session.resumeMetadata?.executionMode ?? null,
    permissionMode: session.resumeMetadata?.permissionMode ?? null,
    interactionMode: session.resumeMetadata?.interactionMode ?? null,
    claudePermissionMode:
      session.resumeMetadata?.claudePermissionMode ?? undefined,
    codexApprovalPolicy:
      session.resumeMetadata?.codexApprovalPolicy ?? undefined,
    codexSandbox: session.resumeMetadata?.codexSandbox ?? undefined,
    codexConfigSource: session.resumeMetadata?.codexConfigSource ?? undefined,
    opencodePermissionMode:
      session.resumeMetadata?.opencodePermissionMode ?? undefined,
    droidPermissionMode:
      session.resumeMetadata?.droidPermissionMode ?? undefined,
    cursorModeSnapshot: session.resumeMetadata?.cursorModeSnapshot ?? undefined,
    cursorModeId: session.resumeMetadata?.cursorModeId ?? null,
    cursorConfigValues: session.resumeMetadata?.cursorConfigValues ?? null,
    identityKey: session.resumeMetadata?.identityKey ?? undefined,
    surface: session.resumeMetadata?.surface ?? "work",
    automationId: session.resumeMetadata?.automationId ?? null,
    automationRunId: session.resumeMetadata?.automationRunId ?? null,
    capabilityMode: session.resumeMetadata?.capabilityMode ?? null,
    completion: session.resumeMetadata?.completion ?? null,
    status,
    idleSinceAt: status === "idle" ? lastActivityAt : null,
    startedAt: session.startedAt ?? now,
    endedAt,
    archivedAt: session.archivedAt ?? null,
    lastActivityAt,
    lastOutputPreview: session.lastOutputPreview ?? null,
    summary: session.summary ?? null,
    threadId: session.resumeMetadata?.threadId ?? undefined,
    requestedCwd: session.resumeMetadata?.requestedCwd ?? null,
    orchestrationRunId: session.orchestrationRunId ?? undefined,
    orchestrationRole: session.orchestrationRole ?? undefined,
    orchestrationParentSessionId: session.orchestrationParentSessionId ?? undefined,
    spawnKind: session.spawnKind ?? undefined,
    orchestrationTag: session.orchestrationTag ?? undefined,
    orchestrationStepId: session.orchestrationStepId ?? undefined,
    orchestrationBundlePath: session.orchestrationBundlePath ?? undefined,
  };
}

function listMockAgentChatSummaries(args: any = {}): any[] {
  let rows = MOCK_SESSIONS.map(mockAgentChatSummaryFromSession).filter(
    (session): session is any => Boolean(session),
  );
  if (typeof args?.laneId === "string" && args.laneId.trim()) {
    rows = rows.filter((session) => session.laneId === args.laneId.trim());
  }
  if (!args?.includeAutomation) {
    rows = rows.filter((session) => (session.surface ?? "work") === "work");
  }
  return rows;
}

/** Returns a fresh snapshot object on every call to avoid shared-state leakage. */
function makeLaneSnapshot(lane: any): any {
  const runtimeBucket =
    lane.id === "lane-auth" || lane.id === "lane-checkout"
      ? "running"
      : lane.id === "lane-dashboard" || lane.id === "lane-api"
        ? "awaiting-input"
        : lane.id === "lane-perf"
          ? "ended"
          : "none";
  return {
    lane: { ...lane },
      runtime: {
        bucket: runtimeBucket,
        runningCount: runtimeBucket === "running" ? 1 : 0,
        awaitingInputCount: runtimeBucket === "awaiting-input" ? 1 : 0,
        pendingInputCount: runtimeBucket === "awaiting-input" ? 1 : 0,
        endedCount: runtimeBucket === "ended" ? 1 : 0,
        sessionCount: runtimeBucket === "none" ? 0 : 1,
      },
    rebaseSuggestion:
      lane.id === "lane-dashboard" || lane.id === "lane-onboard"
        ? {
            laneId: lane.id,
            parentLaneId: "lane-main",
            parentHeadSha: "mock",
            behindCount: 2,
            lastSuggestedAt: now,
            deferredUntil: null,
            dismissedAt: null,
            hasPr: true,
          }
        : null,
    autoRebaseStatus:
      lane.id === "lane-perf"
        ? {
            laneId: lane.id,
            parentLaneId: "lane-main",
            parentHeadSha: "mock",
            state: "autoRebased",
            updatedAt: now,
            conflictCount: 0,
            message: "Mock auto-rebase",
          }
        : null,
    conflictStatus:
      lane.id === "lane-dashboard" || lane.id === "lane-search"
        ? {
            laneId: lane.id,
            status: "conflict-active",
            conflictCount: 2,
            warningCount: 0,
            updatedAt: now,
            summary: "Mock conflict",
          }
        : null,
    stateSnapshot: null,
    adoptableAttached: lane.laneType === "attached" && lane.archivedAt == null,
  };
}

// ── Helper for PrWithConflicts ────────────────────────────────
function makePr(
  id: string,
  laneId: string,
  num: number,
  title: string,
  opts: Partial<any> = {},
): any {
  return {
    id,
    laneId,
    projectId: "browser-mock",
    repoOwner: "acme",
    repoName: "ade",
    githubPrNumber: num,
    githubUrl: `https://github.com/acme/ade/pull/${num}`,
    githubNodeId: id.toUpperCase(),
    title,
    state: "open",
    baseBranch: "main",
    headBranch:
      MOCK_LANES.find((l: any) => l.id === laneId)?.branchRef?.replace(
        "refs/heads/",
        "",
      ) ?? laneId,
    checksStatus: "passing",
    reviewStatus: "none",
    additions: 100,
    deletions: 20,
    lastSyncedAt: now,
    createdAt: yesterday,
    updatedAt: now,
    conflictAnalysis: null,
    ...opts,
  };
}

// ── Normal PRs (5 varied states) ──────────────────────────────
const NORMAL_PRS: any[] = [
  makePr("pr-1", "lane-auth", 142, "Add OAuth2 login flow with PKCE", {
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 847,
    deletions: 123,
    createdAt: yesterday,
    conflictAnalysis: {
      prId: "pr-1",
      laneId: "lane-auth",
      riskLevel: "low",
      overlapCount: 0,
      conflictPredicted: false,
      peerConflicts: [],
      analyzedAt: now,
    },
  }),
  makePr(
    "pr-2",
    "lane-dashboard",
    145,
    "Dashboard v2 — metric cards & chart widgets",
    {
      state: "open",
      checksStatus: "failing",
      reviewStatus: "changes_requested",
      additions: 1562,
      deletions: 340,
      createdAt: twoDaysAgo,
      conflictAnalysis: {
        prId: "pr-2",
        laneId: "lane-dashboard",
        riskLevel: "medium",
        overlapCount: 3,
        conflictPredicted: true,
        peerConflicts: [
          {
            peerId: "pr-3",
            peerName: "Refactor REST endpoints",
            riskLevel: "medium",
            overlapFiles: ["src/lib/metrics.ts"],
          },
        ],
        analyzedAt: now,
      },
    },
  ),
  makePr(
    "pr-3",
    "lane-api",
    148,
    "Refactor REST endpoints to use Zod schemas",
    {
      state: "draft",
      checksStatus: "pending",
      reviewStatus: "requested",
      additions: 2100,
      deletions: 980,
      createdAt: yesterday,
      conflictAnalysis: null,
    },
  ),
  makePr("pr-4", "lane-perf", 151, "Fix N+1 query in session list endpoint", {
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 45,
    deletions: 12,
    createdAt: oneHourAgo,
    conflictAnalysis: {
      prId: "pr-4",
      laneId: "lane-perf",
      riskLevel: "low",
      overlapCount: 0,
      conflictPredicted: false,
      peerConflicts: [],
      analyzedAt: now,
    },
  }),
  makePr(
    "pr-5",
    "lane-onboard",
    153,
    "Onboarding wizard with step-by-step project setup",
    {
      state: "open",
      checksStatus: "passing",
      reviewStatus: "none",
      additions: 620,
      deletions: 80,
      createdAt: now,
      conflictAnalysis: {
        prId: "pr-5",
        laneId: "lane-onboard",
        riskLevel: "high",
        overlapCount: 5,
        conflictPredicted: true,
        peerConflicts: [],
        analyzedAt: now,
      },
    },
  ),
];

// ── Queue PRs (2 groups) ──────────────────────────────────────
//
// Group 1: "Release v3.0 — Commerce" (3 PRs: one landed, one active, one pending)
// Group 2: "Billing Upgrade" (1 PR in queue)
const QUEUE_PRS: any[] = [
  makePr(
    "pr-q1",
    "lane-payments",
    160,
    "Payment gateway integration (Stripe + PayPal)",
    {
      state: "merged",
      checksStatus: "passing",
      reviewStatus: "approved",
      additions: 1200,
      deletions: 150,
      createdAt: threeDaysAgo,
      updatedAt: yesterday,
    },
  ),
  makePr("pr-q2", "lane-checkout", 161, "Checkout flow with cart validation", {
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 890,
    deletions: 210,
    createdAt: twoDaysAgo,
  }),
  makePr(
    "pr-q3",
    "lane-notifications",
    162,
    "Order confirmation & shipping notifications",
    {
      state: "open",
      checksStatus: "pending",
      reviewStatus: "requested",
      additions: 430,
      deletions: 60,
      createdAt: yesterday,
    },
  ),
  makePr("pr-q4", "lane-billing", 170, "Billing v2 — usage-based metering", {
    state: "draft",
    checksStatus: "none",
    reviewStatus: "none",
    additions: 340,
    deletions: 45,
    createdAt: yesterday,
  }),
];

// ── Integration PRs (2 PRs) ──────────────────────────────────
//
// pr-i1: Merges search + analytics into main (multi-source)
// pr-i2: Merges i18n + a11y into main (multi-source)
const INTEGRATION_PRS: any[] = [
  makePr("pr-i1", "lane-search", 180, "Search & Analytics integration branch", {
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    headBranch: "integration/search-analytics",
    additions: 2400,
    deletions: 300,
    createdAt: twoDaysAgo,
    conflictAnalysis: {
      prId: "pr-i1",
      laneId: "lane-search",
      riskLevel: "medium",
      overlapCount: 2,
      conflictPredicted: false,
      peerConflicts: [
        {
          peerId: "pr-i2",
          peerName: "i18n + a11y integration",
          riskLevel: "low",
          overlapFiles: ["src/App.tsx"],
        },
      ],
      analyzedAt: now,
    },
  }),
  makePr(
    "pr-i2",
    "lane-i18n",
    185,
    "Internationalization & accessibility bundle",
    {
      state: "open",
      checksStatus: "failing",
      reviewStatus: "changes_requested",
      headBranch: "integration/i18n-a11y",
      additions: 1800,
      deletions: 420,
      createdAt: yesterday,
      conflictAnalysis: {
        prId: "pr-i2",
        laneId: "lane-i18n",
        riskLevel: "high",
        overlapCount: 7,
        conflictPredicted: true,
        peerConflicts: [
          {
            peerId: "pr-2",
            peerName: "Dashboard v2",
            riskLevel: "medium",
            overlapFiles: [
              "src/components/Dashboard.tsx",
              "src/styles/global.css",
            ],
          },
        ],
        analyzedAt: now,
      },
    },
  ),
];

// ── All PRs combined ──────────────────────────────────────────
const ALL_PRS = USE_ADE_DB_SNAPSHOT
  ? Array.isArray(ADE_DB_SNAPSHOT?.prs)
    ? ADE_DB_SNAPSHOT.prs
    : []
  : [...NORMAL_PRS, ...QUEUE_PRS, ...INTEGRATION_PRS];

// ── Merge Contexts ────────────────────────────────────────────
const BUILTIN_MOCK_MERGE_CONTEXTS: Record<string, any> = {
  // Normal PRs — no group
  "pr-1": {
    prId: "pr-1",
    groupId: null,
    groupType: null,
    sourceLaneIds: ["lane-auth"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [],
  },
  "pr-2": {
    prId: "pr-2",
    groupId: null,
    groupType: null,
    sourceLaneIds: ["lane-dashboard"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [],
  },
  "pr-3": {
    prId: "pr-3",
    groupId: null,
    groupType: null,
    sourceLaneIds: ["lane-api"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [],
  },
  "pr-4": {
    prId: "pr-4",
    groupId: null,
    groupType: null,
    sourceLaneIds: ["lane-perf"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [],
  },
  "pr-5": {
    prId: "pr-5",
    groupId: null,
    groupType: null,
    sourceLaneIds: ["lane-onboard"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [],
  },

  // Queue group 1: "Release v3.0 — Commerce"
  "pr-q1": {
    prId: "pr-q1",
    groupId: "queue-commerce-v3",
    groupType: "queue",
    sourceLaneIds: ["lane-payments"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [
      {
        prId: "pr-q1",
        laneId: "lane-payments",
        laneName: "feature/payments",
        prNumber: 160,
        position: 0,
        role: "source",
      },
      {
        prId: "pr-q2",
        laneId: "lane-checkout",
        laneName: "feature/checkout-flow",
        prNumber: 161,
        position: 1,
        role: "source",
      },
      {
        prId: "pr-q3",
        laneId: "lane-notifications",
        laneName: "feature/notifications",
        prNumber: 162,
        position: 2,
        role: "source",
      },
    ],
  },
  "pr-q2": {
    prId: "pr-q2",
    groupId: "queue-commerce-v3",
    groupType: "queue",
    sourceLaneIds: ["lane-checkout"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [
      {
        prId: "pr-q1",
        laneId: "lane-payments",
        laneName: "feature/payments",
        prNumber: 160,
        position: 0,
        role: "source",
      },
      {
        prId: "pr-q2",
        laneId: "lane-checkout",
        laneName: "feature/checkout-flow",
        prNumber: 161,
        position: 1,
        role: "source",
      },
      {
        prId: "pr-q3",
        laneId: "lane-notifications",
        laneName: "feature/notifications",
        prNumber: 162,
        position: 2,
        role: "source",
      },
    ],
  },
  "pr-q3": {
    prId: "pr-q3",
    groupId: "queue-commerce-v3",
    groupType: "queue",
    sourceLaneIds: ["lane-notifications"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [
      {
        prId: "pr-q1",
        laneId: "lane-payments",
        laneName: "feature/payments",
        prNumber: 160,
        position: 0,
        role: "source",
      },
      {
        prId: "pr-q2",
        laneId: "lane-checkout",
        laneName: "feature/checkout-flow",
        prNumber: 161,
        position: 1,
        role: "source",
      },
      {
        prId: "pr-q3",
        laneId: "lane-notifications",
        laneName: "feature/notifications",
        prNumber: 162,
        position: 2,
        role: "source",
      },
    ],
  },
  // Queue group 2: "Billing Upgrade"
  "pr-q4": {
    prId: "pr-q4",
    groupId: "queue-billing-upgrade",
    groupType: "queue",
    sourceLaneIds: ["lane-billing"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [
      {
        prId: "pr-q4",
        laneId: "lane-billing",
        laneName: "feature/billing-v2",
        prNumber: 170,
        position: 0,
        role: "source",
      },
    ],
  },

  // Integration PRs — multi-source
  "pr-i1": {
    prId: "pr-i1",
    groupId: "integration-search-analytics",
    groupType: "integration",
    sourceLaneIds: ["lane-search", "lane-analytics"],
    targetLaneId: "lane-main",
    integrationLaneId: "lane-search",
    members: [
      {
        prId: "pr-i1",
        laneId: "lane-search",
        laneName: "integration/search-analytics",
        prNumber: 180,
        position: 0,
        role: "integration",
      },
      {
        prId: "pr-i1",
        laneId: "lane-search",
        laneName: "feature/search-v2",
        prNumber: 180,
        position: 0,
        role: "source",
      },
      {
        prId: "pr-i1",
        laneId: "lane-analytics",
        laneName: "feature/analytics",
        prNumber: null,
        position: 1,
        role: "source",
      },
    ],
  },
  "pr-i2": {
    prId: "pr-i2",
    groupId: "integration-i18n-a11y",
    groupType: "integration",
    sourceLaneIds: ["lane-i18n", "lane-a11y"],
    targetLaneId: "lane-main",
    integrationLaneId: "lane-i18n",
    members: [
      {
        prId: "pr-i2",
        laneId: "lane-i18n",
        laneName: "integration/i18n-a11y",
        prNumber: 185,
        position: 0,
        role: "integration",
      },
      {
        prId: "pr-i2",
        laneId: "lane-i18n",
        laneName: "feature/i18n",
        prNumber: 185,
        position: 0,
        role: "source",
      },
      {
        prId: "pr-i2",
        laneId: "lane-a11y",
        laneName: "feature/accessibility",
        prNumber: null,
        position: 1,
        role: "source",
      },
    ],
  },
};

const MOCK_MERGE_CONTEXTS: Record<string, any> = USE_ADE_DB_SNAPSHOT
  ? (ADE_DB_SNAPSHOT?.prMergeContexts ?? {})
  : BUILTIN_MOCK_MERGE_CONTEXTS;

// ── Per-PR detail data (keyed by prId) ────────────────────────
const MOCK_CHECKS_BY_PR: Record<string, any[]> = {
  "pr-1": [
    {
      name: "CI / Build",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / Lint",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / Unit Tests",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / E2E Tests",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "Deploy Preview",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
  ],
  "pr-2": [
    {
      name: "CI / Build",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / Lint",
      status: "completed",
      conclusion: "failure",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / Unit Tests",
      status: "completed",
      conclusion: "failure",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / E2E Tests",
      status: "completed",
      conclusion: "skipped",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
  ],
  "pr-3": [
    {
      name: "CI / Build",
      status: "in_progress",
      conclusion: null,
      detailsUrl: "#",
      startedAt: now,
      completedAt: null,
    },
    {
      name: "CI / Lint",
      status: "queued",
      conclusion: null,
      detailsUrl: "#",
      startedAt: null,
      completedAt: null,
    },
    {
      name: "CI / Unit Tests",
      status: "queued",
      conclusion: null,
      detailsUrl: "#",
      startedAt: null,
      completedAt: null,
    },
  ],
  "pr-4": [
    {
      name: "CI / Build",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: oneHourAgo,
      completedAt: now,
    },
    {
      name: "CI / Unit Tests",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: oneHourAgo,
      completedAt: now,
    },
  ],
  "pr-5": [
    {
      name: "CI / Build",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: now,
      completedAt: now,
    },
    {
      name: "CI / Lint",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: now,
      completedAt: now,
    },
    {
      name: "CI / Unit Tests",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: now,
      completedAt: now,
    },
  ],
};

const MOCK_REVIEWS_BY_PR: Record<string, any[]> = {
  "pr-1": [
    {
      reviewer: "alice",
      state: "approved",
      body: "LGTM! Clean implementation.",
      submittedAt: now,
    },
    {
      reviewer: "carol",
      state: "commented",
      body: "Nice work overall. Left a few minor suggestions.",
      submittedAt: yesterday,
    },
  ],
  "pr-2": [
    {
      reviewer: "bob",
      state: "changes_requested",
      body: "Please add error handling for the token refresh edge case.",
      submittedAt: now,
    },
    {
      reviewer: "dave",
      state: "changes_requested",
      body: "Dashboard layout breaks on mobile viewports.",
      submittedAt: yesterday,
    },
  ],
  "pr-3": [
    { reviewer: "alice", state: "pending", body: null, submittedAt: null },
  ],
  "pr-4": [
    {
      reviewer: "eve",
      state: "approved",
      body: "Quick fix, looks good.",
      submittedAt: now,
    },
  ],
  "pr-5": [],
};

const MOCK_COMMENTS_BY_PR: Record<string, any[]> = {
  "pr-1": [
    {
      id: "c1",
      author: "alice",
      body: "Have you considered using the `useAuth` hook from our shared lib?",
      source: "review",
      url: null,
      path: "src/hooks/useLogin.ts",
      line: 42,
      createdAt: yesterday,
      updatedAt: null,
    },
    {
      id: "c2",
      author: "ci-bot",
      body: "Coverage report: 94.2% (+1.3%)",
      source: "issue",
      url: null,
      path: null,
      line: null,
      createdAt: now,
      updatedAt: null,
    },
  ],
  "pr-2": [
    {
      id: "c3",
      author: "bob",
      body: "The `metricReducer` doesn't handle negative values.",
      source: "review",
      url: null,
      path: "src/lib/metrics.ts",
      line: 87,
      createdAt: twoDaysAgo,
      updatedAt: null,
    },
    {
      id: "c4",
      author: "dave",
      body: "CSS grid is breaking at <768px — need a media query.",
      source: "review",
      url: null,
      path: "src/styles/dashboard.css",
      line: 15,
      createdAt: yesterday,
      updatedAt: null,
    },
    {
      id: "c5",
      author: "ci-bot",
      body: "Coverage report: 78.1% (-3.4%)",
      source: "issue",
      url: null,
      path: null,
      line: null,
      createdAt: now,
      updatedAt: null,
    },
  ],
  "pr-3": [
    {
      id: "c6",
      author: "alice",
      body: "Should we keep backwards-compat for the old `/api/v1` routes?",
      source: "issue",
      url: null,
      path: null,
      line: null,
      createdAt: yesterday,
      updatedAt: null,
    },
  ],
  "pr-4": [
    {
      id: "c7",
      author: "ci-bot",
      body: "Performance benchmark: p95 latency down from 420ms to 12ms",
      source: "issue",
      url: null,
      path: null,
      line: null,
      createdAt: now,
      updatedAt: null,
    },
  ],
  "pr-5": [],
};

const MOCK_STATUS_BY_PR: Record<string, any> = {
  "pr-1": {
    prId: "pr-1",
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    isMergeable: true,
    mergeConflicts: false,
    behindBaseBy: 0,
  },
  "pr-2": {
    prId: "pr-2",
    state: "open",
    checksStatus: "failing",
    reviewStatus: "changes_requested",
    isMergeable: false,
    mergeConflicts: true,
    behindBaseBy: 12,
  },
  "pr-3": {
    prId: "pr-3",
    state: "draft",
    checksStatus: "pending",
    reviewStatus: "requested",
    isMergeable: false,
    mergeConflicts: false,
    behindBaseBy: 7,
  },
  "pr-4": {
    prId: "pr-4",
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    isMergeable: true,
    mergeConflicts: false,
    behindBaseBy: 0,
  },
  "pr-5": {
    prId: "pr-5",
    state: "open",
    checksStatus: "passing",
    reviewStatus: "none",
    isMergeable: true,
    mergeConflicts: false,
    behindBaseBy: 3,
  },
};

// ── Rebase Needs (all urgency categories) ─────────────────────
const BUILTIN_MOCK_REBASE_NEEDS: any[] = [
  // Attention: behind + conflicts predicted
  {
    laneId: "lane-dashboard",
    laneName: "feature/dashboard-v2",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 12,
    conflictPredicted: true,
    conflictingFiles: [
      "src/components/Dashboard.tsx",
      "src/lib/metrics.ts",
      "src/styles/dashboard.css",
    ],
    prId: "pr-2",
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
  },
  {
    laneId: "lane-i18n",
    laneName: "feature/i18n",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 8,
    conflictPredicted: true,
    conflictingFiles: ["src/i18n/translations.json", "src/App.tsx"],
    prId: "pr-i2",
    groupContext: "integration-i18n-a11y",
    dismissedAt: null,
    deferredUntil: null,
  },
  // Clean rebase: behind but no conflicts
  {
    laneId: "lane-api",
    laneName: "feature/api-refactor",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 7,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: "pr-3",
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
  },
  {
    laneId: "lane-onboard",
    laneName: "feature/onboarding-wizard",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 3,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: "pr-5",
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
  },
  // Up to date (behind 0)
  {
    laneId: "lane-auth",
    laneName: "feature/auth-flow",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 0,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: "pr-1",
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
  },
  // Deferred (still behind but snoozed — categorized as upToDate)
  {
    laneId: "lane-search",
    laneName: "feature/search-v2",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 5,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: "pr-i1",
    groupContext: "integration-search-analytics",
    dismissedAt: null,
    deferredUntil: fourHoursFromNow,
  },
  // Dismissed
  {
    laneId: "lane-checkout",
    laneName: "feature/checkout-flow",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 2,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: "pr-q2",
    groupContext: "queue-commerce-v3",
    dismissedAt: yesterday,
    deferredUntil: null,
  },
];

const MOCK_REBASE_NEEDS: any[] = USE_ADE_DB_SNAPSHOT
  ? Array.isArray(ADE_DB_SNAPSHOT?.rebaseNeeds)
    ? ADE_DB_SNAPSHOT.rebaseNeeds
    : []
  : BUILTIN_MOCK_REBASE_NEEDS;

// ── Queue Landing State ───────────────────────────────────────
const BUILTIN_MOCK_QUEUE_STATE: Record<string, any> = {
  "queue-commerce-v3": {
    queueId: "queue-commerce-v3",
    groupId: "queue-commerce-v3",
    groupName: "Release v3.0 - Commerce",
    targetBranch: "main",
    state: "landing",
    entries: [
      {
        prId: "pr-q1",
        laneId: "lane-payments",
        laneName: "feature/payments",
        position: 0,
        prNumber: 160,
        githubUrl: "https://github.com/mock/repo/pull/160",
        state: "landed",
        updatedAt: yesterday,
      },
      {
        prId: "pr-q2",
        laneId: "lane-checkout",
        laneName: "feature/checkout-flow",
        position: 1,
        prNumber: 161,
        githubUrl: "https://github.com/mock/repo/pull/161",
        state: "landing",
        updatedAt: now,
      },
      {
        prId: "pr-q3",
        laneId: "lane-notifications",
        laneName: "feature/notifications",
        position: 2,
        prNumber: 162,
        githubUrl: "https://github.com/mock/repo/pull/162",
        state: "pending",
        updatedAt: null,
      },
    ],
    currentPosition: 1,
    activePrId: "pr-q2",
    activeResolverRunId: null,
    lastError: null,
    waitReason: null,
    config: {
      method: "squash",
      archiveLane: false,
      autoResolve: true,
      ciGating: true,
      resolverProvider: "claude",
      resolverModel: "anthropic/claude-sonnet-5",
      reasoningEffort: "medium",
      permissionMode: "guarded_edit",
      confidenceThreshold: null,
      originSurface: "queue",
      originRunId: null,
      originLabel: "Release v3.0 - Commerce",
    },
    startedAt: yesterday,
    completedAt: null,
    updatedAt: now,
  },
  "queue-billing-upgrade": {
    queueId: "queue-billing-upgrade",
    groupId: "queue-billing-upgrade",
    groupName: "Billing Upgrade",
    targetBranch: "main",
    state: "idle",
    entries: [
      {
        prId: "pr-q4",
        laneId: "lane-billing",
        laneName: "feature/billing-v2",
        position: 0,
        prNumber: 170,
        githubUrl: "https://github.com/mock/repo/pull/170",
        state: "pending",
        updatedAt: null,
      },
    ],
    currentPosition: 0,
    activePrId: null,
    activeResolverRunId: null,
    lastError: null,
    waitReason: null,
    config: {
      method: "squash",
      archiveLane: false,
      autoResolve: false,
      ciGating: true,
      resolverProvider: null,
      resolverModel: "anthropic/claude-sonnet-5",
      reasoningEffort: "medium",
      permissionMode: "guarded_edit",
      confidenceThreshold: null,
      originSurface: "queue",
      originRunId: null,
      originLabel: "Billing Upgrade",
    },
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  },
};

const MOCK_QUEUE_STATE: Record<string, any> = USE_ADE_DB_SNAPSHOT
  ? Object.fromEntries(
      (Array.isArray(ADE_DB_SNAPSHOT?.queueStates)
        ? ADE_DB_SNAPSHOT.queueStates
        : []
      ).flatMap((state: any) => {
        const keys = [state?.groupId, state?.queueId]
          .filter(Boolean)
          .map(String);
        return keys.map((key) => [key, state]);
      }),
    )
  : BUILTIN_MOCK_QUEUE_STATE;

// ── Integration simulation result ─────────────────────────────
const BUILTIN_MOCK_INTEGRATION_SIMULATION: any = {
  proposalId: "sim-mock-1",
  sourceLaneIds: ["lane-search", "lane-analytics"],
  baseBranch: "main",
  overallOutcome: "conflict",
  steps: [
    {
      laneId: "lane-search",
      laneName: "feature/search-v2",
      position: 0,
      outcome: "clean",
      conflictingFiles: [],
      diffStat: { insertions: 1420, deletions: 180, filesChanged: 22 },
    },
    {
      laneId: "lane-analytics",
      laneName: "feature/analytics",
      position: 1,
      outcome: "conflict",
      conflictingFiles: [
        { path: "src/lib/analytics.ts", conflictMarkers: "<<<<<<< HEAD..." },
        { path: "src/App.tsx", conflictMarkers: "<<<<<<< HEAD..." },
      ],
      diffStat: { insertions: 980, deletions: 120, filesChanged: 14 },
    },
  ],
  createdAt: now,
};

const MOCK_INTEGRATION_SIMULATION: any = USE_ADE_DB_SNAPSHOT
  ? {
      proposalId: "empty",
      sourceLaneIds: [] as string[],
      baseBranch: "main",
      overallOutcome: "clean",
      steps: [] as any[],
      createdAt: now,
    }
  : BUILTIN_MOCK_INTEGRATION_SIMULATION;

const BUILTIN_MOCK_INTEGRATION_WORKFLOWS: any[] = [
  {
    proposalId: "workflow-int-active",
    sourceLaneIds: ["lane-search", "lane-analytics"],
    baseBranch: "main",
    pairwiseResults: [],
    laneSummaries: [
      {
        laneId: "lane-search",
        laneName: "feature/search-v2",
        outcome: "clean",
        commitHash: "abc1234",
        commitCount: 4,
        conflictsWith: [],
        diffStat: { insertions: 1420, deletions: 180, filesChanged: 22 },
      },
      {
        laneId: "lane-analytics",
        laneName: "feature/analytics",
        outcome: "clean",
        commitHash: "def5678",
        commitCount: 3,
        conflictsWith: [],
        diffStat: { insertions: 980, deletions: 120, filesChanged: 14 },
      },
    ],
    steps: BUILTIN_MOCK_INTEGRATION_SIMULATION.steps,
    overallOutcome: "clean",
    createdAt: twoDaysAgo,
    title: "Search & Analytics integration branch",
    body: "This integration workflow bundles search and analytics for a shared release train.",
    draft: false,
    integrationLaneName: "integration/search-analytics",
    status: "committed",
    integrationLaneId: "lane-search",
    linkedGroupId: "integration-search-analytics",
    linkedPrId: "pr-i1",
    workflowDisplayState: "active",
    cleanupState: "none",
    closedAt: null,
    mergedAt: null,
    completedAt: null,
    cleanupDeclinedAt: null,
    cleanupCompletedAt: null,
    resolutionState: null,
  },
  {
    proposalId: "workflow-int-history",
    sourceLaneIds: ["lane-i18n", "lane-a11y"],
    baseBranch: "main",
    pairwiseResults: [],
    laneSummaries: [
      {
        laneId: "lane-i18n",
        laneName: "feature/i18n",
        outcome: "conflict",
        commitHash: "ghi9012",
        commitCount: 6,
        conflictsWith: ["lane-a11y"],
        diffStat: { insertions: 1100, deletions: 220, filesChanged: 19 },
      },
      {
        laneId: "lane-a11y",
        laneName: "feature/accessibility",
        outcome: "conflict",
        commitHash: "jkl3456",
        commitCount: 2,
        conflictsWith: ["lane-i18n"],
        diffStat: { insertions: 700, deletions: 90, filesChanged: 9 },
      },
    ],
    steps: [
      {
        laneId: "lane-i18n",
        laneName: "feature/i18n",
        position: 0,
        outcome: "conflict",
        conflictingFiles: [
          {
            path: "src/App.tsx",
            conflictMarkers: "<<<<<<< HEAD...",
            oursExcerpt: null,
            theirsExcerpt: null,
            diffHunk: null,
          },
        ],
        diffStat: { insertions: 1100, deletions: 220, filesChanged: 19 },
      },
      {
        laneId: "lane-a11y",
        laneName: "feature/accessibility",
        position: 1,
        outcome: "conflict",
        conflictingFiles: [
          {
            path: "src/App.tsx",
            conflictMarkers: "<<<<<<< HEAD...",
            oursExcerpt: null,
            theirsExcerpt: null,
            diffHunk: null,
          },
        ],
        diffStat: { insertions: 700, deletions: 90, filesChanged: 9 },
      },
    ],
    overallOutcome: "conflict",
    createdAt: threeDaysAgo,
    title: "Internationalization & accessibility bundle",
    body: "Closed after validation. Cleanup was declined so the workflow lives in history.",
    draft: false,
    integrationLaneName: "integration/i18n-a11y",
    status: "committed",
    integrationLaneId: "lane-i18n",
    linkedGroupId: "integration-i18n-a11y",
    linkedPrId: "pr-i2",
    workflowDisplayState: "history",
    cleanupState: "declined",
    closedAt: yesterday,
    mergedAt: null,
    completedAt: yesterday,
    cleanupDeclinedAt: yesterday,
    cleanupCompletedAt: null,
    resolutionState: null,
  },
];

const MOCK_INTEGRATION_WORKFLOWS: any[] = USE_ADE_DB_SNAPSHOT
  ? Array.isArray(ADE_DB_SNAPSHOT?.integrationWorkflows)
    ? ADE_DB_SNAPSHOT.integrationWorkflows
    : []
  : BUILTIN_MOCK_INTEGRATION_WORKFLOWS;

function isBotGitHubAuthor(author: unknown): boolean {
  if (typeof author !== "string" || !author.trim()) return false;
  const normalized = author.toLowerCase();
  return (
    normalized.endsWith("[bot]") ||
    normalized.endsWith("-bot") ||
    normalized.includes("dependabot")
  );
}

function normalizeGitHubPrListItem(item: any): any {
  return {
    ...item,
    labels: Array.isArray(item?.labels) ? item.labels : [],
    isBot: typeof item?.isBot === "boolean" ? item.isBot : isBotGitHubAuthor(item?.author),
    commentCount:
      typeof item?.commentCount === "number"
        ? item.commentCount
        : Number(item?.commentCount ?? 0),
  };
}

function normalizeGitHubSnapshot(snapshot: any): any {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  return {
    ...snapshot,
    repoPullRequests: Array.isArray(snapshot.repoPullRequests)
      ? snapshot.repoPullRequests.map(normalizeGitHubPrListItem)
      : [],
    externalPullRequests: Array.isArray(snapshot.externalPullRequests)
      ? snapshot.externalPullRequests.map(normalizeGitHubPrListItem)
      : [],
  };
}

function buildCreateLaneFromPrPreflight(args: any): any {
  const repoOwner = String(args?.repoOwner ?? "mock");
  const repoName = String(args?.repoName ?? "repo");
  const githubPrNumber = Number(args?.githubPrNumber ?? 0);
  const headBranch = args?.headBranch ?? null;
  const title = String(args?.title ?? `PR #${githubPrNumber}`);
  const targetLaneName =
    typeof headBranch === "string" && headBranch.trim()
      ? headBranch.replace(/^[^/]+\//, "")
      : `pr-${githubPrNumber}`;
  return {
    repoOwner,
    repoName,
    githubPrNumber,
    githubUrl: String(
      args?.githubUrl ??
        `https://github.com/${repoOwner}/${repoName}/pull/${githubPrNumber}`,
    ),
    title,
    headBranch,
    headSha: null,
    headRepoOwner: repoOwner,
    headRepoName: repoName,
    remoteBranch: headBranch,
    importBranchRef: headBranch,
    targetLaneName,
    baseBranch: args?.baseBranch ?? "main",
    canCreate: true,
    status: "ready",
    blockingConflict: null,
    blockingConflicts: [],
  };
}

const BUILTIN_MOCK_GITHUB_SNAPSHOT: any = {
  repo: { owner: "acme", name: "ade" },
  viewerLogin: "mock-user",
  syncedAt: now,
  repoPullRequests: [
    ...ALL_PRS.map((pr: any) => {
      const ctx = MOCK_MERGE_CONTEXTS[pr.id] ?? null;
      const workflow =
        MOCK_INTEGRATION_WORKFLOWS.find((item) => item.linkedPrId === pr.id) ??
        null;
      return {
        id: pr.id,
        scope: "repo",
        repoOwner: pr.repoOwner,
        repoName: pr.repoName,
        githubPrNumber: pr.githubPrNumber,
        githubUrl: pr.githubUrl,
        title: pr.title,
        state: pr.state === "draft" ? "draft" : pr.state,
        isDraft: pr.state === "draft",
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        author: "mock-user",
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        linkedPrId: pr.id,
        linkedGroupId: workflow?.linkedGroupId ?? ctx?.groupId ?? null,
        linkedLaneId: pr.laneId,
        linkedLaneName:
          MOCK_LANES.find((lane: any) => lane.id === pr.laneId)?.name ??
          pr.laneId,
        adeKind: workflow ? "integration" : (ctx?.groupType ?? "single"),
        workflowDisplayState: workflow?.workflowDisplayState ?? null,
        cleanupState: workflow?.cleanupState ?? null,
      };
    }),
    {
      id: "repo-unmapped-191",
      scope: "repo",
      repoOwner: "acme",
      repoName: "ade",
      githubPrNumber: 191,
      githubUrl: "https://github.com/acme/ade/pull/191",
      title: "Hotfix from GitHub UI with no ADE lane",
      state: "open",
      isDraft: false,
      baseBranch: "main",
      headBranch: "hotfix/github-ui-edit",
      author: "teammate",
      createdAt: oneHourAgo,
      updatedAt: now,
      linkedPrId: null,
      linkedGroupId: null,
      linkedLaneId: null,
      linkedLaneName: null,
      adeKind: null,
      workflowDisplayState: null,
      cleanupState: null,
    },
  ],
  externalPullRequests: [
    {
      id: "external-42",
      scope: "external",
      repoOwner: "acme",
      repoName: "infra",
      githubPrNumber: 42,
      githubUrl: "https://github.com/acme/infra/pull/42",
      title: "Rotate runner credentials for deployment fleet",
      state: "open",
      isDraft: false,
      baseBranch: "main",
      headBranch: "ops/runner-credential-rotation",
      author: "mock-user",
      createdAt: yesterday,
      updatedAt: now,
      linkedPrId: null,
      linkedGroupId: null,
      linkedLaneId: null,
      linkedLaneName: null,
      adeKind: null,
      workflowDisplayState: null,
      cleanupState: null,
    },
  ],
};

const MOCK_GITHUB_SNAPSHOT: any = normalizeGitHubSnapshot(
  USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.githubSnapshot
    ? ADE_DB_SNAPSHOT.githubSnapshot
    : BUILTIN_MOCK_GITHUB_SNAPSHOT,
);

// ═══════════════════════════════════════════════════════════════
// Wire it up
// ═══════════════════════════════════════════════════════════════

/**
 * In Electron, preload already set `window.ade` and must win. In the Vite dev browser
 * we set `__adeBrowserMock` so we can re-run this file on HMR (Vite re-executes the module,
 * but `window.ade` already exists from the first load — a naive `!window.ade` guard would skip
 * the mock and leave a stale, broken stub). Only skip the mock when the real Electron preload
 * is present: a partial `window.ade` from another script would otherwise keep a broken object
 * (missing `sync`, `onboarding`, …).
 */
function shouldInstallBrowserMock(target: Window): boolean {
  const w = target as any;
  return !(
    w.ade &&
    !w.__adeBrowserMock &&
    typeof w.ade.sync?.getStatus === "function"
  );
}

if (typeof window !== "undefined" && shouldInstallBrowserMock(window)) {
  const w = window as any;
  if (w.ade) {
    console.warn(
      "[ADE] Re-applying full window.ade browser mock (e.g. Vite HMR).",
    );
  } else {
    console.warn(
      "[ADE] Running outside Electron — injecting browser mock for window.ade",
    );
  }
  w.__adeBrowserMock = true;
  const BROWSER_MOCK_LOCAL_DEVICE: any = {
    deviceId: "browser-mock-device",
    siteId: "browser-mock-site",
    name: "Browser preview",
    platform: "macOS",
    deviceType: "desktop",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    lastHost: null,
    lastPort: null,
    tailscaleIp: null,
    ipAddresses: ["127.0.0.1"],
    metadata: {},
  };

  const BROWSER_MOCK_SYNC_SNAPSHOT: any = {
    mode: "standalone",
    role: "brain",
    localDevice: BROWSER_MOCK_LOCAL_DEVICE,
    currentBrain: BROWSER_MOCK_LOCAL_DEVICE,
    clusterState: null,
    bootstrapToken: null,
    pairingPin: null,
    pairingPinConfigured: false,
    runtimeName: null,
    pairingConnectInfo: null,
    connectedPeers: [],
    tailnetDiscovery: {
      state: "disabled",
      serviceName: "ade-sync",
      servicePort: 0,
      target: null,
      updatedAt: null,
      error: null,
      stderr: null,
    },
    client: {
      state: "disconnected",
      host: null,
      port: null,
      connectedAt: null,
      lastSeenAt: null,
      latencyMs: null,
      syncLag: null,
      lastRemoteDbVersion: 0,
      brainDeviceId: BROWSER_MOCK_LOCAL_DEVICE.deviceId,
      hostName: "Browser preview",
      error: null,
      message: null,
      savedDraft: null,
    },
    transferReadiness: {
      ready: true,
      blockers: [],
      survivableState: [],
    },
    survivableStateText: "Idle (browser preview)",
    blockingStateText: "",
  };

  const BROWSER_MOCK_PROVIDER_CONNECTION = (
    provider: "claude" | "codex" | "cursor" | "droid",
  ) => ({
    provider,
    authAvailable: false,
    runtimeDetected: false,
    runtimeAvailable: false,
    usageAvailable: false,
    path: null,
    blocker: null,
    lastCheckedAt: now,
    sources: [] as { kind: string }[],
  });

  const BROWSER_MOCK_AI_STATUS: any = {
    mode: "guest",
    availableProviders: {
      claude: {
        binary: {
          present: true,
          source: "path",
          path: "/opt/homebrew/bin/claude",
        },
        auth: {
          ready: false,
          mode: "none",
          detail: null,
        },
      },
      codex: false,
      cursor: false,
      droid: false,
    },
    models: { claude: [], codex: [], cursor: [], droid: [] },
    availableModelIds: [
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5-codex",
    ],
    features: [
      { feature: "pr_descriptions", enabled: true },
      { feature: "terminal_summaries", enabled: false },
      { feature: "commit_messages", enabled: false },
    ],
    providerConnections: {
      claude: BROWSER_MOCK_PROVIDER_CONNECTION("claude"),
      codex: BROWSER_MOCK_PROVIDER_CONNECTION("codex"),
      cursor: BROWSER_MOCK_PROVIDER_CONNECTION("cursor"),
      droid: BROWSER_MOCK_PROVIDER_CONNECTION("droid"),
    },
  };

  const BROWSER_MOCK_HELP_STATE: any = {
    glossaryTermsSeen: [],
  };

  const markBrowserMockGlossaryTermSeen = (termId: unknown) => {
    const id = typeof termId === "string" ? termId.trim() : "";
    if (!id) return BROWSER_MOCK_HELP_STATE;
    if (!BROWSER_MOCK_HELP_STATE.glossaryTermsSeen.includes(id)) {
      BROWSER_MOCK_HELP_STATE.glossaryTermsSeen = [
        ...BROWSER_MOCK_HELP_STATE.glossaryTermsSeen,
        id,
      ];
    }
    return BROWSER_MOCK_HELP_STATE;
  };

  const BROWSER_MOCK_USAGE_SNAPSHOT: any = {
    windows: [],
    pacing: {
      status: "on-track",
      projectedWeeklyPercent: 0,
      weekElapsedPercent: 0,
      expectedPercent: 0,
      deltaPercent: 0,
      etaHours: null,
      willLastToReset: true,
      resetsInHours: 168,
    },
    costs: [],
    adeCosts: [],
    extraUsage: [],
    lastPolledAt: now,
    errors: [],
  };
  const BROWSER_USAGE_SNAPSHOT: any =
    USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.usageSnapshot
      ? ADE_DB_SNAPSHOT.usageSnapshot
      : BROWSER_MOCK_USAGE_SNAPSHOT;

  const browserStatsRangeForPreset = (preset: AdeUsageRangePreset) => {
    const until = new Date();
    const start = new Date(until);
    start.setHours(0, 0, 0, 0);
    if (preset === "7d") start.setDate(start.getDate() - 6);
    if (preset === "30d") start.setDate(start.getDate() - 29);
    if (preset === "year") start.setDate(start.getDate() - 364);
    return {
      preset,
      since: preset === "all" ? null : start.toISOString(),
      until: until.toISOString(),
    };
  };
  const makeBrowserStatsDailySkeleton = (range: { preset: AdeUsageRangePreset; since: string | null; until: string }) => {
    const maxDays = range.preset === "today" ? 1 : range.preset === "7d" ? 7 : range.preset === "30d" ? 30 : 365;
    const untilMs = Date.parse(range.until);
    const start = new Date(range.since ?? untilMs - (maxDays - 1) * 86_400_000);
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: maxDays }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return {
        date: date.toISOString().slice(0, 10),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        commits: 0,
        prs: 0,
        insertions: 0,
        deletions: 0,
        filesChanged: 0,
        sessions: 0,
      };
    });
  };
  const makeBrowserEmptyAdeUsageStats = (preset: AdeUsageRangePreset): any => {
    const range = browserStatsRangeForPreset(preset);
    return {
    generatedAt: now,
    range,
    summary: {
      totalTokens: 0,
      tokenTotalSource: "provider_logs",
      observedProviderTokens: 0,
      observedProviderInputTokens: 0,
      observedProviderOutputTokens: 0,
      observedProviderCachedTokens: 0,
      observedProviderCostRangeUsd: 0,
      observedProviderCost30dUsd: 0,
      observedProviderCostTodayUsd: 0,
      adeRuntimeTokens: 0,
      adeRuntimeInputTokens: 0,
      adeRuntimeOutputTokens: 0,
      adeRuntimeCachedTokens: 0,
      adeRuntimeCostRangeUsd: 0,
      adeRuntimeCost30dUsd: 0,
      adeRuntimeCostTodayUsd: 0,
      adeTotalTokens: 0,
      adeTotalCostRangeUsd: 0,
      trackedAdeTokens: 0,
      trackedAdeInputTokens: 0,
      trackedAdeOutputTokens: 0,
      trackedAdeCalls: 0,
      trackedAdeDurationMs: 0,
      workerTokens: 0,
      workerCostUsd: 0,
      chatSessions: 0,
      terminalSessions: 0,
      activeLanes: 0,
      lanesCreated: 0,
      lanesArchived: 0,
      lanesDeleted: 0,
      commitsCreated: 0,
      pushOperations: 0,
      prLandings: 0,
      prsTracked: 0,
      prsOpen: 0,
      prsMerged: 0,
      prsClosed: 0,
      prAdditions: 0,
      prDeletions: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      artifactsCaptured: 0,
      automationRuns: 0,
      workerRuns: 0,
    },
    providers: [],
    models: [],
    adeProviders: [],
    adeModels: [],
    agentProviders: [],
    agentModels: [],
    features: [],
    lanes: [],
    activities: [],
    daily: makeBrowserStatsDailySkeleton(range),
    github: {
      repo: "Browser preview",
      available: true,
      lastFetchedAt: null,
      error: null,
    },
    sourceNotes: [],
  };
  };
  const BROWSER_ADE_USAGE_STATS_BY_PRESET: Record<string, any> =
    USE_STATS_DASHBOARD_SNAPSHOT &&
    ADE_DB_SNAPSHOT?.adeUsageStatsByPreset &&
    typeof ADE_DB_SNAPSHOT.adeUsageStatsByPreset === "object"
      ? ADE_DB_SNAPSHOT.adeUsageStatsByPreset
      : {};
  const getBrowserAdeUsageStats = async (args?: { preset?: string }) => {
    const preset = isAdeUsageRangePreset(args?.preset) ? args.preset : "7d";
    return BROWSER_ADE_USAGE_STATS_BY_PRESET[preset] ?? makeBrowserEmptyAdeUsageStats(preset);
  };

  const BROWSER_MOCK_BUDGET_CONFIG: any = {
    refreshIntervalMin: 15,
    budgetCaps: [] as any[],
    preset: "conservative",
  };

  /** Full enough for Settings and lane behavior in the dev browser. */
  const BROWSER_MOCK_PROJECT_CONFIG_SNAPSHOT: any = {
    shared: {
      version: 1,
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
    },
    local: {
      version: 1,
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
      git: { autoRebaseOnHeadChange: false },
      laneCleanup: {},
      ai: {
        orchestrator: {
          defaultOrchestratorModel: { modelId: "anthropic/claude-sonnet-5" },
          teammatePlanMode: "auto",
        },
        permissions: {
          cli: { mode: "full-auto", sandboxPermissions: "workspace-write" },
          inProcess: { mode: "full-auto" },
          providers: {
            claude: "full-auto",
            codex: "default",
            opencode: "full-auto",
            codexSandbox: "workspace-write",
          },
        },
      },
    },
    effective: {
      version: 1,
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
      git: { autoRebaseOnHeadChange: false },
      ai: {
        featureModelOverrides: { pr_descriptions: "anthropic/claude-sonnet-5" },
        orchestrator: {
          defaultOrchestratorModel: { modelId: "anthropic/claude-sonnet-5" },
          teammatePlanMode: "auto",
        },
        permissions: {
          cli: { mode: "full-auto", sandboxPermissions: "workspace-write" },
          inProcess: { mode: "full-auto" },
          providers: {
            claude: "full-auto",
            codex: "default",
            opencode: "full-auto",
            codexSandbox: "workspace-write",
          },
        },
      },
    },
    validation: { ok: true, issues: [] },
    trust: {
      sharedHash: "mock",
      localHash: "mock",
      approvedSharedHash: null,
      requiresSharedTrust: false,
    },
    paths: {
      sharedPath: "/tmp/.ade/ade.yaml",
      localPath: "/tmp/.ade/local.yaml",
    },
  };

  const BROWSER_MOCK_DEVTOOLS_CHECK: any = {
    tools: [
      {
        id: "git" as const,
        label: "Git",
        command: "git",
        installed: true,
        detectedPath: "/usr/bin/git",
        detectedVersion: "2.0.0",
        required: true,
      },
    ],
    platform: "darwin",
  };

  const browserMockPersonalChats: any[] = [];
  const browserMockPersonalChatEvents = new Map<string, any[]>();
  let browserMockPersonalChatSequence = 0;

  const appendBrowserMockPersonalChatEvent = (
    sessionId: string,
    event: Record<string, unknown>,
  ) => {
    const envelope = {
      sessionId,
      timestamp: new Date().toISOString(),
      event,
    };
    const events = browserMockPersonalChatEvents.get(sessionId) ?? [];
    events.push(envelope);
    browserMockPersonalChatEvents.set(sessionId, events);
    return envelope;
  };

  (window as any).ade = {
    analytics: {
      capture: async () => ({ accepted: false, reason: "not_configured" }),
      getStatus: async () => ({
        configured: false,
        enabled: true,
        effective: false,
        host: "https://us.i.posthog.com",
        dailyBudget: 200,
        acceptedToday: 0,
        droppedToday: 0,
        day: new Date().toISOString().slice(0, 10),
      }),
      setEnabled: async (enabled: boolean) => ({
        configured: false,
        enabled,
        effective: false,
        host: "https://us.i.posthog.com",
        dailyBudget: 200,
        acceptedToday: 0,
        droppedToday: 0,
        day: new Date().toISOString().slice(0, 10),
      }),
    },
    // Machine-owned ADE account (Clerk identity). The dev browser preview toggles
    // signed-in vs signed-out via localStorage `ade.mock.account` = "out".
    account: (() => {
      const signedOut = () => {
        try {
          return window.localStorage.getItem("ade.mock.account") === "out";
        } catch {
          return false;
        }
      };
      const setSignedOut = (value: boolean) => {
        try {
          if (value) {
            window.localStorage.setItem("ade.mock.account", "out");
          } else {
            window.localStorage.removeItem("ade.mock.account");
          }
        } catch {
          // localStorage may be unavailable in hardened contexts.
        }
      };
      const signedInStatus = {
        signedIn: true,
        userId: "user_2xMockAccount",
        email: "arul@ade.dev",
        name: "Arul Sharma",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        provider: "github" as const,
        imageUrl: null,
        configured: true,
      };
      const signedOutStatus = {
        signedIn: false,
        userId: null,
        email: null,
        name: null,
        expiresAt: null,
        provider: null,
        imageUrl: null,
        configured: true,
      };
      const status = () => (signedOut() ? signedOutStatus : signedInStatus);
      return {
        status: async () => status(),
        startLogin: async () => ({
          sessionId: "mock-session",
          authorizeUrl: "https://accounts.ade.dev/oauth/authorize?mock=1",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
        pollLogin: async () => {
          setSignedOut(false);
          return {
            status: "signed_in" as const,
            message: null,
            authStatus: signedInStatus,
          };
        },
        cancelLogin: async () => status(),
        signOut: async () => {
          setSignedOut(true);
          return signedOutStatus;
        },
        listMachines: async () => {
          if (signedOut()) {
            return { state: "signed_out" as const, machines: [], message: null };
          }
          return {
            state: "ok" as const,
            message: null,
            machines: [
              {
                machineKey: "mk_studio",
                deviceId: "dev_studio",
                name: "Studio",
                platform: "darwin",
                deviceType: "desktop",
                reachableEndpoints: [
                  { kind: "tailnet" as const, host: "100.92.14.3", port: 22 },
                ],
                lastSeenAt: Date.now() - 45_000,
                online: true,
              },
              {
                machineKey: "mk_mini",
                deviceId: "dev_mini",
                name: "Mac mini",
                platform: "darwin",
                deviceType: "desktop",
                reachableEndpoints: [
                  { kind: "relay" as const, url: "wss://relay.ade.dev/mini" },
                ],
                lastSeenAt: Date.now() - 6 * 3_600_000,
                online: false,
              },
            ],
          };
        },
        pairMachine: async (machineKey: string) => ({
          targetId: `paired-${machineKey}`,
          machineKey,
          deviceId: "dev_studio",
          name: "Studio",
        }),
        onPairMachineProgress: () => () => {},
      };
    })(),
    app: {
      ping: resolved("pong" as const),
      getInfo: resolved({
        appVersion: "0.0.0-browser",
        isPackaged: false,
        automationsEnabled: true,
        platform: "browser",
        arch: "web",
        versions: {
          electron: "0.0.0-browser",
          chrome: "0.0.0-browser",
          node: "0.0.0-browser",
          v8: "0.0.0-browser",
        },
        env: {},
        localRuntime: {
          connectionState: "idle",
          pid: null,
          syncPort: null,
          publishHealth: null,
          lastWedge: null,
          runtimeMode: "primary",
          serviceInstall: {
            state: "skipped",
            attempted: false,
            path: null,
            message:
              "Background service installation is not available in the browser mock.",
            exitCode: null,
            updatedAt: null,
          },
          serviceHealth: {
            state: "unsupported",
            installed: null,
            running: null,
            path: null,
            message:
              "Background service status is not available in the browser mock.",
            checkedAt: null,
          },
        },
      }),
      onRuntimeStatusChanged: () => () => {},
      getResourceUsage: resolved({
        sampledAt: now,
        processCount: 1,
        cpuPercent: 0,
        mainCpuPercent: 0,
        rendererCpuPercent: 0,
        memoryMB: 0,
        mainMemoryMB: 0,
        rendererMemoryMB: 0,
        activePtyCount: 0,
        ptyProcessCount: 0,
        ptyCpuPercent: 0,
        ptyMemoryMB: 0,
        freeMemoryMB: 8_000,
        totalMemoryMB: 16_000,
        roleUsage: [
          { role: "ade-runtime", processCount: 1, cpuPercent: 2, memoryMB: 280 },
        ],
      }),
      getRuntimeHealth: resolved({
        slowActions24h: 0,
        slowActionP95Ms: null,
        sampledAt: now,
      }),
      getLatestRelease: resolved({
        version: "1.0.0",
        htmlUrl: "https://github.com/arul28/ADE/releases/latest",
        publishedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        updateAvailable: false,
      }),
      getProject: resolved(MOCK_PROJECT),
      getWindowSession: resolved({
        windowId: 1,
        project: MOCK_PROJECT,
        binding: {
          kind: "local",
          key: `local:${MOCK_PROJECT.rootPath}`,
          rootPath: MOCK_PROJECT.rootPath,
          displayName: MOCK_PROJECT.name,
        },
        openProjectTabs: [MOCK_PROJECT],
      }),
      getWelcomeVideoState: async () => readBrowserMockWelcomeVideoState(),
      markWelcomeVideoSeen: async (reason: "completed" | "dismissed" = "dismissed") => {
        const current = readBrowserMockWelcomeVideoState();
        const next = {
          ...current,
          completedAt: reason === "completed" ? new Date().toISOString() : current.completedAt,
          dismissedAt: reason === "completed" ? current.dismissedAt : new Date().toISOString(),
        };
        writeBrowserMockWelcomeVideoState(next);
        return next;
      },
      getLaunchGateState: resolved({ resolved: true }),
      resolveLaunchGate: resolved({ resolved: true as const }),
      setWindowProjectTabs: resolved({ openProjectTabs: [MOCK_PROJECT] }),
      newWindow: resolved({ windowId: 2 }),
      openProjectInNewWindow: resolvedArg({
        windowId: 2,
        project: MOCK_PROJECT,
      }),
      closeWindow: resolvedArg({ closed: false }),
      onProjectChanged: () => () => {},
      onProjectBindingChanged: () => () => {},
      onNavigate: () => () => {},
      openExternal: resolvedArg(undefined),
      revealPath: resolvedArg(undefined),
      writeClipboardText: async (text: string): Promise<void> => {
        const writeText = window.navigator.clipboard?.writeText;
        if (typeof writeText !== "function") return;
        await writeText.call(window.navigator.clipboard, text);
      },
      hasClipboardImage: resolved(false),
      readClipboardImage: resolved(null),
      saveClipboardImageAttachment: resolved(null),
      getImageDataUrl: resolvedArg({ dataUrl: "" }),
      writeClipboardImage: resolvedArg(undefined),
      openPath: resolvedArg(undefined),
      openPathInEditor: resolvedArg(undefined),
      logDebugEvent: () => {},
    },
    storage: {
      getPressure: resolved({
        state: "normal" as const,
        freeBytes: 100 * 1024 ** 3,
        totalBytes: 500 * 1024 ** 3,
        freeFraction: 0.2,
        perRoot: [],
        sampledAt: now,
      }),
      getSnapshot: resolvedArg({
        generatedAt: now,
        projectRoot: MOCK_PROJECT.rootPath,
        volume: { freeBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
        totalAdeBytes: 0,
        categories: [],
        scanDurationMs: 0,
        truncated: false,
        extras: {
          dbBreakdown: [
            { table: "automation_ingress_events", label: "Webhook history", bytes: 12 * 1024 ** 2, category: "webhooks", action: "prunable" },
            { table: "operations", label: "Sync bookkeeping", bytes: 6 * 1024 ** 2, category: "sync_bookkeeping", action: "compactable" },
            { table: "core", label: "Core data", bytes: 8 * 1024 ** 2, category: "core", action: null },
          ],
          maintenance: {
            lastRun: {
              startedAt: now,
              finishedAt: now,
              trigger: "daily",
              actions: [],
              reclaimedBytes: 0,
              dbSizeBytes: 26 * 1024 ** 2,
            },
            journal: [
              {
                startedAt: now,
                finishedAt: now,
                trigger: "daily",
                actions: [],
                reclaimedBytes: 0,
                dbSizeBytes: 26 * 1024 ** 2,
              },
            ],
          },
          safeReclaimableBytes: 18 * 1024 ** 2,
          policyChips: {
            chats_history: "Compressed after 14 days",
            build_release: "Auto-cleans · 7 days",
            caches: "Rebuilt on demand",
          },
        },
      }),
      cleanupPreview: resolvedArg({ items: [], totalBytes: 0, blocked: [] }),
      compressNow: resolvedArg({ filesCompressed: 0, savedBytes: 0 }),
      cleanup: resolvedArg({ removed: [], failed: [], freedBytes: 0 }),
      runMaintenanceNow: resolved({
        startedAt: now,
        finishedAt: now,
        trigger: "manual" as const,
        actions: [],
        reclaimedBytes: 18 * 1024 ** 2,
        dbSizeBytes: 20 * 1024 ** 2,
      }),
    },
    project: {
      openRepo: resolved(MOCK_PROJECT),
      chooseDirectory: resolvedArg(null),
      browseDirectories: async (args?: { inputPath?: string }) => {
        const inputPath =
          typeof args?.inputPath === "string" &&
          args.inputPath.trim().length > 0
            ? args.inputPath
            : "~/";
        return {
          inputPath,
          resolvedPath: "/tmp/mock",
          directoryPath: "/tmp/mock",
          parentPath: "/tmp",
          exactDirectoryPath: "/tmp/mock",
          openableProjectRoot: "/tmp/mock",
          entries: [],
        };
      },
      getDetail: resolvedArg({
        rootPath: MOCK_PROJECT.rootPath,
        isGitRepo: true,
        branchName: MOCK_PROJECT.gitDefaultBranch,
        dirtyCount: 0,
        dirtyBreakdown: null,
        aheadBehind: null,
        lastCommit: null,
        readmeExcerpt: null,
        languages: [],
        laneCount: null,
        lastOpenedAt: null,
        subdirectoryCount: null,
      }),
      getDroppedPath: (_file: unknown) => "",
      openAdeFolder: resolved(undefined),
      clearLocalData: resolved({
        deletedPaths: [],
        clearedAt: new Date().toISOString(),
      }),
      listRecent: resolved([]),
      findForRepo: resolved(null),
      closeCurrent: resolved(undefined),
      resolveIcon: resolvedArg({
        dataUrl: null,
        sourcePath: null,
        mimeType: null,
      }),
      chooseIcon: resolvedArg(null),
      removeIcon: resolvedArg({
        dataUrl: null,
        sourcePath: null,
        mimeType: null,
      }),
      switchToPath: resolvedArg(MOCK_PROJECT),
      forgetRecent: resolvedArg([]),
      reorderRecent: resolvedArg([]),
      setRecentPinned: resolvedArg([]),
      getSnapshot: resolved({
        rootPath: MOCK_PROJECT.rootPath,
        adeDir: `${MOCK_PROJECT.rootPath}/.ade`,
        lastCheckedAt: new Date().toISOString(),
        entries: [],
        health: [],
        cleanup: { changed: false, actions: [] },
        config: {
          sharedPath: `${MOCK_PROJECT.rootPath}/.ade/ade.yaml`,
          localPath: `${MOCK_PROJECT.rootPath}/.ade/local.yaml`,
          secretPath: `${MOCK_PROJECT.rootPath}/.ade/local.secret.yaml`,
          trust: {
            sharedHash: "",
            localHash: "",
            approvedSharedHash: null,
            requiresSharedTrust: false,
          },
        },
      }),
      initializeOrRepair: resolved({ changed: false, actions: [] }),
      runIntegrityCheck: resolved({ changed: false, actions: [] }),
      onMissing: noop,
      onStateEvent: noop,
    },
    remoteRuntime: {
      listTargets: resolved([{
        id: "mock-remote",
        name: "Studio Mac",
        hostname: "studio.local",
        transport: "paired",
        pairedMachine: { hostIdentity: "mock-studio" },
        sshUser: null,
        port: null,
        sshKeyPath: null,
        lastSeenArch: "darwin-arm64",
        runtimeBinaryVersion: "0.0.0-browser",
        lastConnectedAt: Date.now(),
      }]),
      getConnectionSnapshot: resolved({
        connections: [{
          target: {
            id: "mock-remote",
            name: "Studio Mac",
            hostname: "studio.local",
            transport: "paired",
            pairedMachine: { hostIdentity: "mock-studio" },
            sshUser: null,
            port: null,
            sshKeyPath: null,
            lastSeenArch: "darwin-arm64",
            runtimeBinaryVersion: "0.0.0-browser",
            lastConnectedAt: Date.now(),
          },
          state: "connected",
          arch: "darwin-arm64",
          version: "0.0.0-browser",
          route: { kind: "tailnet", endpoint: "100.64.0.2" },
          capabilities: {
            projects: true,
            machineProjects: {
              getDefaultParentDir: true,
              handoffStoragePreflight: true,
              clone: true,
            },
          },
          projects: [],
          lastError: null,
          lastAttemptedAt: Date.now(),
          connectedAt: Date.now(),
        }],
        connectedCount: 1,
        updatedAt: Date.now(),
      }),
      onConnectionSnapshotChanged: noop,
      listDiscoveredMachines: resolved({ machines: [], diagnostics: [] }),
      saveTarget: resolvedArg({
        id: "mock-remote",
        name: "Mock remote",
        hostname: "mock.local",
        sshUser: "ade",
        port: 22,
        sshKeyPath: null,
        lastSeenArch: null,
        runtimeBinaryVersion: null,
        lastConnectedAt: null,
      }),
      setAutoConnect: resolvedArg({
        id: "mock-remote",
        name: "Mock remote",
        hostname: "mock.local",
        sshUser: "ade",
        port: 22,
        sshKeyPath: null,
        lastSeenArch: null,
        runtimeBinaryVersion: null,
        lastConnectedAt: null,
        autoConnect: true,
      }),
      removeTarget: resolvedArg({ removed: true }),
      connect: resolvedArg({
        target: {
          id: "mock-remote",
          name: "Mock remote",
          hostname: "mock.local",
          sshUser: "ade",
          port: 22,
          sshKeyPath: null,
          lastSeenArch: "darwin-arm64",
          runtimeBinaryVersion: "0.0.0-browser",
          lastConnectedAt: Date.now(),
        },
        arch: "darwin-arm64",
        version: "0.0.0-browser",
        projects: [],
      }),
      listProjects: resolvedArg([{
        projectId: "mock-remote-project",
        rootPath: "/Users/ade/Projects/browser-preview",
        displayName: "Browser Preview",
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        gitOriginUrl: "git@github.com:ade/browser-preview.git",
      }]),
      addProject: async (_id: string, rootPath: string) => ({
        projectId: `mock-${
          rootPath
            .replace(/[^a-z0-9]+/gi, "-")
            .replace(/^-|-$/g, "")
            .toLowerCase() || "project"
        }`,
        rootPath,
        displayName:
          rootPath.split(/[\\/]/).filter(Boolean).at(-1) || "Mock project",
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        gitOriginUrl: null,
      }),
      browseDirectories: resolvedArg2({
        inputPath: "",
        resolvedPath: "/Users/ade",
        directoryPath: "/Users/ade",
        parentPath: "/Users",
        exactDirectoryPath: "/Users/ade",
        openableProjectRoot: null,
        entries: [],
      }),
      getProjectDetail: async (_id: string, rootPath: string) => ({
        rootPath,
        isGitRepo: true,
        branchName: "main",
        dirtyCount: 0,
        dirtyBreakdown: null,
        aheadBehind: { ahead: 0, behind: 0 },
        lastCommit: null,
        readmeExcerpt: null,
        languages: [],
        laneCount: 0,
        lastOpenedAt: null,
        subdirectoryCount: 0,
      }),
      getDefaultParentDir: resolved("/Users/ade/Projects"),
      getHandoffStoragePreflight: resolvedArg2({
        parentDir: "/Users/ade/Projects",
        targetPath: "/Users/ade/Projects/browser-preview",
        freeBytes: 128 * 1024 * 1024 * 1024,
        requiredBytes: 1024 * 1024 * 1024,
        hasEnoughSpace: true,
        targetExists: false,
        blockingErrors: [],
        warnings: [],
      }),
      createProject: async (
        _id: string,
        input: { name: string; parentDir: string },
      ) => {
        const rootPath = `${input.parentDir.replace(/\/+$/g, "")}/${input.name}`;
        return {
          projectId: `mock-${input.name}`,
          rootPath,
          displayName: input.name,
          addedAt: Date.now(),
          lastOpenedAt: Date.now(),
          gitOriginUrl: null,
        };
      },
      cloneProject: async (
        _id: string,
        input: { url: string; parentDir: string; name?: string },
      ) => {
        const name =
          input.name ||
          input.url
            .split(/[/:]/)
            .pop()
            ?.replace(/\.git$/i, "") ||
          "repo";
        const rootPath = `${input.parentDir.replace(/\/+$/g, "")}/${name}`;
        return {
          projectId: `mock-${name}`,
          rootPath,
          displayName: name,
          addedAt: Date.now(),
          lastOpenedAt: Date.now(),
          gitOriginUrl: input.url,
        };
      },
      listMyGitHubRepos: resolvedArg2({ repos: [] }),
      openProject: async (id: string, projectId: string) => ({
        kind: "remote" as const,
        key: remoteProjectBindingKey(id, projectId),
        targetId: id,
        runtimeName: "Mock remote",
        projectId,
        rootPath: "/Users/ade/mock-project",
        displayName: "mock-project",
      }),
      callAction: async (
        _id: string,
        _projectId: string,
        request: RemoteRuntimeActionRequest,
      ) => {
        if (request.domain === "chat" && request.action === "preflightCrossMachineDestination") {
          return {
            domain: request.domain,
            action: request.action,
            result: {
              providerAuthorized: true,
              modelAvailable: true,
              remoteBranchHeadSha: request.args?.sourceHeadSha ?? null,
              existingLaneId: null,
              blockingErrors: [],
              warnings: [],
            },
            statusHints: {},
          };
        }
        if (request.domain === "chat" && request.action === "acceptCrossMachineHandoff") {
          const capsule = request.args?.capsule;
          const handoffId = capsule && typeof capsule === "object" && !Array.isArray(capsule)
            && typeof (capsule as { handoffId?: unknown }).handoffId === "string"
            ? (capsule as { handoffId: string }).handoffId
            : "mock-handoff";
          return {
            domain: request.domain,
            action: request.action,
            result: {
              handoffId,
              laneId: "mock-remote-lane",
              session: {
                id: "mock-remote-chat",
                laneId: "mock-remote-lane",
                provider: "claude",
                model: "claude-sonnet-5",
                status: "active",
                createdAt: new Date().toISOString(),
                lastActivityAt: new Date().toISOString(),
              },
              reusedLane: false,
              reusedSession: false,
            },
            statusHints: {},
          };
        }
        return ({
        domain: request.domain,
        action: request.action,
        result:
          request.domain === "lane" && request.action === "list"
            ? [
                {
                  id: "lane-main",
                  name: "Main",
                  branchName: "main",
                  laneType: "primary",
                },
              ]
            : null,
        statusHints: {},
        });
      },
      streamEvents: resolvedArg({ events: [], nextCursor: 0, hasMore: false }),
      disconnect: resolvedArg({ disconnected: true }),
    },
    keybindings: {
      get: resolved({ definitions: [], overrides: [] }),
      set: resolvedArg({ definitions: [], overrides: [] }),
    },
    sync: {
      getStatus: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      getLocalStatus: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      refreshDiscovery: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      listDevices: resolved([]),
      updateLocalDevice: resolvedArg(BROWSER_MOCK_LOCAL_DEVICE),
      connectToBrain: resolvedArg(BROWSER_MOCK_SYNC_SNAPSHOT),
      disconnectFromBrain: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      forgetDevice: resolvedArg(BROWSER_MOCK_SYNC_SNAPSHOT),
      getTransferReadiness: resolved({
        ready: true,
        blockers: [],
        survivableState: [],
      }),
      transferBrainToLocal: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      getPin: resolved({ pin: null }),
      setPin: resolvedArg(BROWSER_MOCK_SYNC_SNAPSHOT),
      generatePin: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      clearPin: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      getRuntimeName: async () => ({ runtimeName: BROWSER_MOCK_SYNC_SNAPSHOT.runtimeName ?? null }),
      setRuntimeName: async (name: string) => {
        const trimmed = String(name ?? "").trim();
        BROWSER_MOCK_SYNC_SNAPSHOT.runtimeName = trimmed || null;
        return BROWSER_MOCK_SYNC_SNAPSHOT;
      },
      clearRuntimeName: async () => {
        BROWSER_MOCK_SYNC_SNAPSHOT.runtimeName = null;
        return BROWSER_MOCK_SYNC_SNAPSHOT;
      },
      setActiveLanePresence: resolvedArg(undefined),
      onEvent: () => () => {},
    },
    ai: {
      getStatus: resolved(BROWSER_MOCK_AI_STATUS),
      getOpenCodeRuntimeDiagnostics: resolved({} as any),
      storeApiKey: resolvedArg(undefined),
      deleteApiKey: resolvedArg(undefined),
      listApiKeys: resolved([]),
      verifyApiKey: resolvedArg({
        provider: "mock",
        ok: false,
        message: "browser",
        verifiedAt: now,
      } as any),
      updateConfig: resolvedArg(undefined),
      opencodeAuthMethods: resolved({ methods: {} }),
      opencodeOAuthStart: resolvedArg({ url: "", method: "auto", instructions: "" } as any),
      opencodeOAuthCancel: resolvedArg(undefined),
      setOpencodeProviderKey: resolvedArg({ ok: false, error: "browser" } as any),
      clearOpencodeProviderKey: resolvedArg({ ok: false, error: "browser" } as any),
      refreshModelsDev: resolved({ lastFetchedAt: null }),
      onOpencodeOAuthStatus: () => () => {},
    },
    agentTools: {
      detect: resolved([]),
    },
    devTools: {
      detect: resolved(BROWSER_MOCK_DEVTOOLS_CHECK),
    },
    usage: {
      getAdeStats: getBrowserAdeUsageStats,
      getSnapshot: resolved(BROWSER_USAGE_SNAPSHOT),
      refresh: resolved(BROWSER_USAGE_SNAPSHOT),
      refreshHistory: resolved(BROWSER_USAGE_SNAPSHOT),
      noteDemand: resolved(BROWSER_USAGE_SNAPSHOT),
      checkBudget: resolvedArg({
        allowed: true,
        warnings: [] as string[],
      }),
      getCumulativeUsage: resolvedArg({
        totalTokens: 0,
        totalCostUsd: 0,
        weekKey: "2026-W01",
      }),
      getBudgetConfig: resolved(BROWSER_MOCK_BUDGET_CONFIG),
      saveBudgetConfig: resolvedArg(BROWSER_MOCK_BUDGET_CONFIG),
      onUpdate: (cb: (snapshot: any) => void) => {
        queueMicrotask(() => {
          try {
            cb(BROWSER_USAGE_SNAPSHOT);
          } catch {
            // noop
          }
        });
        return () => {};
      },
    },
    computerUse: {
      listArtifacts: resolvedArg([]),
      getOwnerSnapshot: resolvedArg({} as any),
      routeArtifact: resolvedArg({} as any),
      updateArtifactReview: resolvedArg({} as any),
      readArtifactPreview: resolvedArg(null),
      onEvent: () => () => {},
    },
    onboarding: {
      getStatus: resolved({
        completedAt: new Date().toISOString(),
        dismissedAt: null,
        freshProject: false,
      }),
      detectDefaults: resolved({} as any),
      detectExistingLanes: resolved([]),
      setDismissed: resolvedArg({
        completedAt: null,
        dismissedAt: new Date().toISOString(),
      } as any),
      complete: resolved({
        completedAt: new Date().toISOString(),
        dismissedAt: null,
      }),
      markGlossaryTermSeen: (termId: string) =>
        Promise.resolve(markBrowserMockGlossaryTermSeen(termId)),
    },
    automations: {
      list: resolved(
        USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.rules)
          ? ADE_DB_AUTOMATIONS.rules
          : [
              {
                id: "auto-session-review",
                name: "PR follow-up thread",
                description:
                  "When a pull request changes, send a focused follow-up prompt to an automation-owned chat thread.",
                enabled: true,
                mode: "review",
                triggers: [{ type: "git.pr_updated", branch: "main" }],
                trigger: { type: "git.pr_updated", branch: "main" },
                execution: {
                  kind: "agent-session",
                  session: { title: "PR follow-up thread" },
                },
                executor: { mode: "automation-bot" },
                modelConfig: {
                    modelId: "anthropic/claude-sonnet-5",
                    thinkingLevel: "medium",
                  },
                permissionConfig: {
                  providers: {
                    opencode: "edit",
                    claude: "plan",
                    codexSandbox: "workspace-write",
                    allowedTools: ["git", "github"],
                  },
                },
                prompt:
                  "Review the latest PR update and leave a concise follow-up summary with any high-signal next steps.",
                reviewProfile: "incremental",
                toolPalette: ["repo", "git", "github"],
                contextSources: [],
                guardrails: {},
                outputs: { disposition: "comment-only", createArtifact: true },
                verification: {
                  verifyBeforePublish: false,
                  mode: "intervention",
                },
                billingCode: "auto:session-review",
                actions: [],
                running: false,
                lastRunAt: now,
                lastRunStatus: "succeeded",
                confidence: {
                  value: 0.84,
                  label: "high",
                  reason:
                    "Recent runs consistently produced concise PR follow-up notes.",
                },
              },
            ],
      ),
      toggle: resolvedArg([]),
      triggerManually: resolvedArg({
        id: "run-1",
        automationId: "auto-session-review",
        chatSessionId: "chat-auto-1",
        triggerType: "manual",
        startedAt: now,
        endedAt: now,
        status: "succeeded",
        executionKind: "agent-session",
        actionsCompleted: 1,
        actionsTotal: 1,
        errorMessage: null,
        spendUsd: 0.42,
        confidence: null,
        triggerMetadata: null,
        summary: "Manual run completed.",
        billingCode: "auto:session-review",
      }),
      getHistory: resolvedArg(
        USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.runs)
          ? ADE_DB_AUTOMATIONS.runs
          : [
              {
                id: "run-1",
                automationId: "auto-session-review",
                chatSessionId: "chat-auto-1",
                triggerType: "git.pr_updated",
                startedAt: now,
                endedAt: now,
                status: "succeeded",
                executionKind: "agent-session",
                actionsCompleted: 1,
                actionsTotal: 1,
                errorMessage: null,
                spendUsd: 1.32,
                confidence: {
                  value: 0.81,
                  label: "high",
                  reason: "Automation summarized the latest PR update clearly.",
                },
                triggerMetadata: { repository: "ADE", branch: "main" },
                summary:
                  "Summarized the latest PR update and suggested next review points.",
                billingCode: "auto:session-review",
              },
            ],
      ),
      getRunDetail: resolvedArg({
        run: {
          id: "run-1",
          automationId: "auto-session-review",
          chatSessionId: "chat-auto-1",
          triggerType: "git.pr_updated",
          startedAt: now,
          endedAt: now,
          status: "succeeded",
          executionKind: "agent-session",
          actionsCompleted: 1,
          actionsTotal: 1,
          errorMessage: null,
          spendUsd: 1.32,
          confidence: {
            value: 0.81,
            label: "high",
            reason: "Automation summarized the latest PR update clearly.",
          },
          triggerMetadata: {
            repository: "ADE",
            branch: "main",
            author: "alice",
          },
          summary:
            "Summarized the latest PR update and suggested next review points.",
          billingCode: "auto:session-review",
        },
        rule: null,
        chatSession: {
          sessionId: "chat-auto-1",
          laneId: "lane-1",
          provider: "claude",
          model: "Claude Sonnet 5",
          modelId: "anthropic/claude-sonnet-5",
          title: "PR follow-up thread",
          surface: "automation",
          automationId: "auto-session-review",
          automationRunId: "run-1",
          status: "idle",
          startedAt: now,
          endedAt: now,
          lastActivityAt: now,
          lastOutputPreview:
            "Summarized the latest PR update and suggested next review points.",
          summary: "Automation-owned chat thread for PR follow-up work.",
        },
        actions: [],
        ingressEvent: {
          id: "ingress-1",
          source: "github-relay",
          eventKey: "delivery-1",
          automationIds: ["auto-session-review"],
          triggerType: "git.pr_updated",
          eventName: "pull_request",
          status: "dispatched",
          summary: "PR synchronize event dispatched to matching rules.",
          errorMessage: null,
          cursor: "cursor-1",
          receivedAt: now,
        },
      }),
      listRuns: resolvedArg(
        USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.runs)
          ? ADE_DB_AUTOMATIONS.runs
          : [
              {
                id: "run-1",
                automationId: "auto-session-review",
                chatSessionId: "chat-auto-1",
                triggerType: "git.pr_updated",
                startedAt: now,
                endedAt: now,
                status: "succeeded",
                executionKind: "agent-session",
                actionsCompleted: 1,
                actionsTotal: 1,
                errorMessage: null,
                spendUsd: 1.32,
                confidence: {
                  value: 0.81,
                  label: "high",
                  reason: "Automation summarized the latest PR update clearly.",
                },
                triggerMetadata: { repository: "ADE", branch: "main" },
                summary:
                  "Summarized the latest PR update and suggested next review points.",
                billingCode: "auto:session-review",
              },
            ],
      ),
      getIngressStatus: resolved({
        webhookGateway: {
          enabled: true,
          ready: true,
          status: "online",
          publicUrl: "https://ade-mock.tailnet.ts.net/ade-webhooks",
          localUrl: "http://127.0.0.1:4319/automations/webhook",
          provider: "tailscale",
          tailscale: {
            available: true,
            hostname: "ade-mock.tailnet.ts.net",
            message: "Tailscale is available on ade-mock.tailnet.ts.net.",
          },
          lastCheckedAt: now,
          lastError: null,
        },
        githubRelay: {
          configured: true,
          healthy: true,
          status: "ready",
          apiBaseUrl: "https://relay.mock",
          remoteProjectId: "proj-123",
          lastCursor: "cursor-1",
          lastPolledAt: now,
          lastDeliveryAt: now,
          lastError: null,
        },
        localWebhook: {
          configured: true,
          listening: true,
          status: "listening",
          url: "http://127.0.0.1:4319/automations/webhook",
          githubUrl: "http://127.0.0.1:4319/github-webhooks",
          port: 4319,
          lastDeliveryAt: now,
          lastError: null,
        },
      }),
      refreshWebhookGatewayStatus: resolved({
        enabled: true,
        ready: true,
        status: "online",
        publicUrl: "https://ade-mock.tailnet.ts.net/ade-webhooks",
        localUrl: "http://127.0.0.1:4319/automations/webhook",
        provider: "tailscale",
        tailscale: {
          available: true,
          hostname: "ade-mock.tailnet.ts.net",
          message: "Tailscale is available on ade-mock.tailnet.ts.net.",
        },
        lastCheckedAt: now,
        lastError: null,
      }),
      setWebhookGatewayPublicUrl: resolvedArg({
        enabled: true,
        ready: true,
        status: "online",
        publicUrl: "https://ade-mock.tailnet.ts.net/ade-webhooks",
        localUrl: "http://127.0.0.1:4319/automations/webhook",
        provider: "tailscale",
        tailscale: {
          available: true,
          hostname: "ade-mock.tailnet.ts.net",
          message: "Tailscale is available on ade-mock.tailnet.ts.net.",
        },
        lastCheckedAt: now,
        lastError: null,
      }),
      listIngressEvents: resolvedArg(
        USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.ingressEvents)
          ? ADE_DB_AUTOMATIONS.ingressEvents
          : [
              {
                id: "ingress-1",
                source: "github-relay",
                eventKey: "delivery-1",
                automationIds: ["auto-session-review"],
                triggerType: "git.pr_updated",
                eventName: "pull_request",
                status: "dispatched",
                summary: "PR synchronize event dispatched to matching rules.",
                errorMessage: null,
                cursor: "cursor-1",
                receivedAt: now,
              },
            ],
      ),
      parseNaturalLanguage: resolvedArg({
        draft: {
          name: "Mock automation",
          description: "",
          enabled: true,
          mode: "review",
          triggers: [{ type: "manual" }],
          trigger: { type: "manual" },
          execution: { kind: "agent-session", session: {} },
          executor: { mode: "automation-bot" },
          prompt: "Review the latest changes.",
          reviewProfile: "quick",
          toolPalette: ["repo"],
          contextSources: [],
          guardrails: {},
          outputs: { disposition: "comment-only", createArtifact: true },
          verification: { verifyBeforePublish: false, mode: "intervention" },
          billingCode: "auto:mock",
          actions: [],
          legacyActions: [],
        },
        normalized: null,
        confidence: 0.6,
        ambiguities: [],
        resolutions: [],
        issues: [],
        plannerCommandPreview: "codex automation planner preview",
      }),
      validateDraft: resolvedArg({
        ok: true,
        normalized: null,
        issues: [],
        requiredConfirmations: [],
      }),
      saveDraft: resolvedArg({ rule: { id: "mock-rule" }, rules: [] }),
      simulate: resolvedArg({
        normalized: null,
        actions: [],
        notes: ["Mock simulation"],
        issues: [],
      }),
      onEvent: noop,
    },
    review: {
      listLaunchContext: resolved({
        defaultLaneId: MOCK_LANES[1]?.id ?? MOCK_LANES[0]?.id ?? null,
        defaultBranchName: "main",
        lanes: MOCK_LANES.map((lane) => ({
          id: lane.id,
          name: lane.name,
          laneType: lane.laneType,
          branchRef: lane.branchRef,
          baseRef: lane.baseRef,
          color: lane.color ?? null,
        })),
        recentCommitsByLane: Object.fromEntries(
          MOCK_LANES.map((lane) => [
            lane.id,
            [
              {
                sha: "abc1234567890",
                shortSha: "abc1234",
                subject: `Recent work on ${lane.name}`,
                authoredAt: now,
                pushed: false,
              },
              {
                sha: "def4567890123",
                shortSha: "def4567",
                subject: `Follow-up fix on ${lane.name}`,
                authoredAt: yesterday,
                pushed: true,
              },
            ],
          ]),
        ),
        recommendedModelId: DEFAULT_BROWSER_MOCK_CODEX_MODEL,
      }),
      listRuns: resolvedArg([
        {
          id: "review-run-1",
          projectId: MOCK_PROJECT.id,
          laneId: MOCK_LANES[1]?.id ?? "lane-auth",
          target: {
            mode: "lane_diff",
            laneId: MOCK_LANES[1]?.id ?? "lane-auth",
          },
          config: {
            compareAgainst: { kind: "default_branch" },
            selectionMode: "full_diff",
            dirtyOnly: false,
            modelId: DEFAULT_BROWSER_MOCK_CODEX_MODEL,
            reasoningEffort: "medium",
            publishBehavior: "local_only",
          },
          targetLabel: "feature/auth-flow vs main",
          compareTarget: {
            kind: "default_branch",
            label: "main",
            ref: "main",
            laneId: null,
            branchRef: "main",
          },
          status: "completed",
          summary: "Found two actionable risks in the auth flow changes.",
          errorMessage: null,
          findingCount: 2,
          severitySummary: { critical: 0, high: 1, medium: 1, low: 0, info: 0 },
          chatSessionId: "chat-review-1",
          createdAt: yesterday,
          startedAt: yesterday,
          endedAt: now,
          updatedAt: now,
        },
      ]),
      getRunDetail: resolvedArg({
        id: "review-run-1",
        projectId: MOCK_PROJECT.id,
        laneId: MOCK_LANES[1]?.id ?? "lane-auth",
        target: { mode: "lane_diff", laneId: MOCK_LANES[1]?.id ?? "lane-auth" },
        config: {
          compareAgainst: { kind: "default_branch" },
          selectionMode: "full_diff",
          dirtyOnly: false,
          modelId: DEFAULT_BROWSER_MOCK_CODEX_MODEL,
          reasoningEffort: "medium",
          publishBehavior: "local_only",
        },
        targetLabel: "feature/auth-flow vs main",
        compareTarget: {
          kind: "default_branch",
          label: "main",
          ref: "main",
          laneId: null,
          branchRef: "main",
        },
        status: "completed",
        summary: "Found two actionable risks in the auth flow changes.",
        errorMessage: null,
        findingCount: 2,
        severitySummary: { critical: 0, high: 1, medium: 1, low: 0, info: 0 },
        chatSessionId: "chat-review-1",
        createdAt: yesterday,
        startedAt: yesterday,
        endedAt: now,
        updatedAt: now,
        findings: [
          {
            id: "finding-1",
            runId: "review-run-1",
            title: "Missing rollback when PKCE token exchange fails",
            severity: "high",
            body: "The new auth path persists session state before the token exchange completes, which can leave the lane in a partially authenticated state after a failed callback.",
            confidence: 0.83,
            evidence: [
              {
                kind: "diff_hunk",
                summary:
                  "Session write happens before token exchange success is confirmed.",
                filePath: "src/auth/oauth.ts",
                line: 128,
                quote: "saveSession(session);",
                artifactId: null,
              },
            ],
            filePath: "src/auth/oauth.ts",
            line: 128,
            anchorState: "anchored",
            sourcePass: "single_pass",
            publicationState: "local_only",
          },
          {
            id: "finding-2",
            runId: "review-run-1",
            title: "Callback route still lacks regression coverage",
            severity: "medium",
            body: "The diff updates the callback branching logic but does not add coverage for the rejected-code path, so the new behavior can regress without detection.",
            confidence: 0.68,
            evidence: [],
            filePath: "src/auth/oauth.test.ts",
            line: null,
            anchorState: "file_only",
            sourcePass: "single_pass",
            publicationState: "local_only",
          },
        ],
        artifacts: [
          {
            id: "artifact-review-diff-1",
            runId: "review-run-1",
            artifactType: "diff_bundle",
            title: "Diff bundle",
            mimeType: "text/plain",
            contentText:
              "diff --git a/src/auth/oauth.ts b/src/auth/oauth.ts\n@@ ...",
            metadata: null,
            createdAt: now,
          },
        ],
        publications: [],
        chatSession: {
          sessionId: "chat-review-1",
          laneId: MOCK_LANES[1]?.id ?? "lane-auth",
          provider: "codex",
          model: "GPT-5.4",
          modelId: DEFAULT_BROWSER_MOCK_CODEX_MODEL,
          title: "Review: feature/auth-flow vs main",
          surface: "automation",
          automationId: null,
          automationRunId: null,
          status: "idle",
          startedAt: yesterday,
          endedAt: now,
          lastActivityAt: now,
          lastOutputPreview:
            "Found two actionable risks in the auth flow changes.",
          summary: "Saved review transcript for local diff review.",
        },
      }),
      startRun: resolvedArg({
        id: "review-run-queued",
        projectId: MOCK_PROJECT.id,
        laneId: MOCK_LANES[1]?.id ?? "lane-auth",
        target: { mode: "lane_diff", laneId: MOCK_LANES[1]?.id ?? "lane-auth" },
        config: {
          compareAgainst: { kind: "default_branch" },
          selectionMode: "full_diff",
          dirtyOnly: false,
          modelId: DEFAULT_BROWSER_MOCK_CODEX_MODEL,
          reasoningEffort: "medium",
          publishBehavior: "local_only",
        },
        targetLabel: "feature/auth-flow review",
        compareTarget: null,
        status: "queued",
        summary: null,
        errorMessage: null,
        findingCount: 0,
        severitySummary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        chatSessionId: null,
        createdAt: now,
        startedAt: now,
        endedAt: null,
        updatedAt: now,
      }),
      rerun: resolvedArg({
        id: "review-run-rerun",
        projectId: MOCK_PROJECT.id,
        laneId: MOCK_LANES[1]?.id ?? "lane-auth",
        target: { mode: "lane_diff", laneId: MOCK_LANES[1]?.id ?? "lane-auth" },
        config: {
          compareAgainst: { kind: "default_branch" },
          selectionMode: "full_diff",
          dirtyOnly: false,
          modelId: DEFAULT_BROWSER_MOCK_CODEX_MODEL,
          reasoningEffort: "medium",
          publishBehavior: "local_only",
        },
        targetLabel: "feature/auth-flow review",
        compareTarget: null,
        status: "queued",
        summary: null,
        errorMessage: null,
        findingCount: 0,
        severitySummary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        chatSessionId: null,
        createdAt: now,
        startedAt: now,
        endedAt: null,
        updatedAt: now,
      }),
      cancelRun: resolvedArg(null),
      recordFeedback: resolvedArg({
        id: "rfb_mock",
        findingId: "mock-finding",
        runId: "review-run-1",
        kind: "acknowledge" as const,
        reason: null,
        note: null,
        snoozeUntil: null,
        createdAt: now,
      }),
      listSuppressions: resolvedArg([]),
      deleteSuppression: resolvedArg(true),
      qualityReport: resolved({
        projectId: MOCK_PROJECT.id,
        totalRuns: 3,
        totalFindings: 14,
        addressedCount: 6,
        dismissedCount: 3,
        snoozedCount: 1,
        suppressedCount: 2,
        publishedCount: 5,
        noiseRate: 0.35,
        recentFeedback: [],
        byClass: [
          { findingClass: "intent_drift" as const, total: 4, addressed: 2 },
          {
            findingClass: "incomplete_rollout" as const,
            total: 5,
            addressed: 3,
          },
          {
            findingClass: "late_stage_regression" as const,
            total: 2,
            addressed: 1,
          },
        ],
      }),
      onEvent: noop,
    },
    actions: {
      listRegistry: resolved([]),
    },
    lanes: {
      list: resolved(MOCK_LANES),
      listSnapshots: async () =>
        MOCK_LANES.map((lane) => makeLaneSnapshot(lane)),
      create: resolvedArg({ id: "mock", name: "mock" }),
      createChild: resolvedArg({ id: "mock", name: "mock" }),
      importBranch: resolvedArg({ id: "mock", name: "mock" }),
      previewBranchSwitch: resolvedArg({
        laneId: "mock",
        currentBranchRef: "main",
        targetBranchRef: "main",
        mode: "existing",
        dirty: false,
        duplicateLaneId: null,
        duplicateLaneName: null,
        activeWork: [],
        targetProfile: null,
      }),
      switchBranch: resolvedArg({
        lane: MOCK_LANES[0],
        previousBranchRef: "main",
        activeWork: [],
      }),
      attach: resolvedArg({ id: "mock", name: "mock" }),
      adoptAttached: resolvedArg({ id: "mock", name: "mock" }),
      listUnregisteredWorktrees: resolved([
        { path: "/Users/you/code/app-login", branch: "feat/login" },
        { path: "/Users/you/code/app-api-fix", branch: "bugfix/api-timeout" },
        { path: "/Users/you/experiments/spike", branch: "spike/new-renderer" },
      ]),
      rename: resolvedArg(undefined),
      reparent: resolvedArg({}),
      updateAppearance: resolvedArg(undefined),
      archive: resolvedArg(undefined),
      delete: resolvedArg(undefined),
      listDeleteProgress: resolved([]),
      cancelDelete: resolvedArg({
        cancelled: false,
        reason: "no active delete",
      }),
      getDeleteRisk: resolvedArg({
        laneId: "mock",
        branchRef: null,
        dirty: false,
        hasUnpushedCommits: false,
        unpushedCommitCount: 0,
        remoteBranchExists: false,
        activeChatCount: 0,
        activePtyCount: 0,
        activeWatcherCount: 0,
        envInitialized: false,
      }),
      onDeleteEvent: noop,
      onLifecycleEvent: noop,
      getStackChain: resolvedArg([]),
      getChildren: resolvedArg([]),
      rebaseStart: resolvedArg({
        runId: "mock-run",
        run: {
          runId: "mock-run",
          rootLaneId: "mock",
          scope: "lane_only",
          pushMode: "none",
          state: "completed",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          actor: "user",
          baseBranch: "main",
          lanes: [],
          currentLaneId: null,
          failedLaneId: null,
          error: null,
          pushedLaneIds: [],
          canRollback: false,
        },
      }),
      rebasePush: resolvedArg({
        runId: "mock-run",
        rootLaneId: "mock",
        scope: "lane_only",
        pushMode: "none",
        state: "completed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        actor: "user",
        baseBranch: "main",
        lanes: [],
        currentLaneId: null,
        failedLaneId: null,
        error: null,
        pushedLaneIds: [],
        canRollback: false,
      }),
      rebaseRollback: resolvedArg({
        runId: "mock-run",
        rootLaneId: "mock",
        scope: "lane_only",
        pushMode: "none",
        state: "aborted",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        actor: "user",
        baseBranch: "main",
        lanes: [],
        currentLaneId: null,
        failedLaneId: null,
        error: null,
        pushedLaneIds: [],
        canRollback: false,
      }),
      rebaseAbort: resolvedArg({
        runId: "mock-run",
        rootLaneId: "mock",
        scope: "lane_only",
        pushMode: "none",
        state: "aborted",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        actor: "user",
        baseBranch: "main",
        lanes: [],
        currentLaneId: null,
        failedLaneId: null,
        error: null,
        pushedLaneIds: [],
        canRollback: false,
      }),
      rebaseSubscribe: noop,
      listRebaseSuggestions: resolved([]),
      dismissRebaseSuggestion: resolvedArg(undefined),
      deferRebaseSuggestion: resolvedArg(undefined),
      onRebaseSuggestionsEvent: noop,
      listAutoRebaseStatuses: resolved([]),
      dismissAutoRebaseStatus: resolvedArg(undefined),
      onAutoRebaseEvent: noop,
      openFolder: resolvedArg(undefined),
      initEnv: resolvedArg({
        laneId: "mock",
        steps: [],
        startedAt: now,
        completedAt: now,
        overallStatus: "completed",
      }),
      getEnvStatus: resolvedArg(null),
      getOverlay: resolvedArg({}),
      onEnvEvent: noop,
      listTemplates: resolved([]),
      getTemplate: resolvedArg(null),
      getDefaultTemplate: resolvedArg(null),
      setDefaultTemplate: resolvedArg(undefined),
      applyTemplate: resolvedArg({
        laneId: "mock",
        steps: [],
        startedAt: now,
        completedAt: now,
        overallStatus: "completed",
      }),
      portGetLease: resolvedArg(null),
      portListLeases: resolved([]),
      portAcquire: resolvedArg({
        laneId: "mock",
        rangeStart: 3000,
        rangeEnd: 3099,
        status: "active",
        leasedAt: now,
      }),
      portRelease: resolvedArg(undefined),
      portListConflicts: resolved([]),
      portRecoverOrphans: resolved([]),
      onPortEvent: noop,
      proxyGetStatus: resolved({
        running: false,
        proxyPort: 8080,
        routes: [],
      }),
      proxyStart: resolvedArg({
        running: true,
        proxyPort: 8080,
        routes: [],
        startedAt: now,
      }),
      proxyStop: resolvedArg(undefined),
      proxyAddRoute: resolvedArg({
        laneId: "mock",
        hostname: "mock.localhost",
        targetPort: 3000,
        status: "active",
        createdAt: now,
      }),
      proxyRemoveRoute: resolvedArg(undefined),
      proxyGetPreviewInfo: resolvedArg({
        laneId: "mock",
        hostname: "mock.localhost",
        previewUrl: "http://mock.localhost:8080",
        proxyPort: 8080,
        targetPort: 3000,
        active: false,
      }),
      proxyOpenPreview: resolvedArg(undefined),
      oauthGetStatus: resolved({
        enabled: false,
        routingMode: "state-parameter" as const,
        activeSessions: [],
        callbackPaths: [],
      }),
      oauthUpdateConfig: resolvedArg(undefined),
      oauthGenerateRedirectUris: resolvedArg([
        { provider: "google", uris: [] as string[], instructions: "" },
      ]),
      oauthEncodeState: resolvedArg("ade:mock"),
      oauthDecodeState: resolvedArg(null),
      oauthListSessions: resolved([]),
      onOAuthEvent: noop,
      diagnosticsGetStatus: resolved({
        lanes: [],
        proxyRunning: false,
        proxyPort: 8080,
        totalRoutes: 0,
        activeConflicts: 0,
        fallbackLanes: [] as string[],
      }),
      diagnosticsGetLaneHealth: async (args: { laneId: string }) =>
        typeof args?.laneId === "string"
          ? mockBrowserLaneHealth(args.laneId)
          : null,
      diagnosticsRunHealthCheck: async (args: { laneId: string }) =>
        mockBrowserLaneHealth(
          typeof args?.laneId === "string" ? args.laneId : "mock",
        ),
      diagnosticsRunFullCheck: resolved([]),
      diagnosticsActivateFallback: resolvedArg(undefined),
      diagnosticsDeactivateFallback: resolvedArg(undefined),
      onDiagnosticsEvent: noop,
      onProxyEvent: noop,
    },
    sessions: {
      list: async (args: any = {}) => {
        let rows = MOCK_SESSIONS;
        if (typeof args?.laneId === "string" && args.laneId.trim()) {
          rows = rows.filter(
            (session) => session.laneId === args.laneId.trim(),
          );
        }
        if (typeof args?.status === "string" && args.status.trim()) {
          rows = rows.filter(
            (session) => session.status === args.status.trim(),
          );
        }
        const limit = Number.isFinite(args?.limit)
          ? Math.max(1, Math.floor(args.limit))
          : rows.length;
        return rows.slice(0, limit);
      },
      get: async (sessionId: string) =>
        MOCK_SESSIONS.find((session) => session.id === sessionId) ?? null,
      delete: resolvedArg(undefined),
      updateMeta: resolvedArg(null),
      readTranscriptTail: async (args: any = {}) => {
        const sessionId = String(args?.sessionId ?? "").trim();
        const lines = getMockChatTranscriptEvents(sessionId).map((entry) =>
          JSON.stringify(entry),
        );
        const raw = lines.join("\n");
        const maxBytes = Number.isFinite(args?.maxBytes)
          ? Math.max(0, Math.floor(args.maxBytes))
          : raw.length;
        return raw.length > maxBytes
          ? raw.slice(Math.max(0, raw.length - maxBytes))
          : raw;
      },
      getDelta: resolvedArg(null),
      onChanged: noop,
    },
    personalChats: {
      call: async ({ action, args = {} }: any) => {
        let result: any = null;
        if (action === "list") {
          result = browserMockPersonalChats.filter(
            (chat) => args.includeArchived === true || !chat.archivedAt,
          );
        }
        if (action === "modelCatalog") result = { groups: [], fetchedAt: new Date().toISOString() };
        if (action === "models") result = [];
        if (action === "create") {
          const now = new Date().toISOString();
          result = {
            sessionId: `personal-browser-${Date.now()}-${++browserMockPersonalChatSequence}`,
            title: args.title ?? null,
            goal: null,
            summary: null,
            lastOutputPreview: null,
            provider: args.provider ?? "codex",
            model: args.model ?? DEFAULT_BROWSER_MOCK_CODEX_MODEL,
            modelId: args.modelId ?? DEFAULT_BROWSER_MOCK_CODEX_MODEL,
            status: "idle",
            surface: "personal",
            permissionMode: args.permissionMode ?? "default",
            reasoningEffort: args.reasoningEffort ?? null,
            fastMode: args.fastMode === true,
            startedAt: now,
            endedAt: null,
            archivedAt: null,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
          };
          browserMockPersonalChats.unshift(result);
          browserMockPersonalChatEvents.set(result.sessionId, []);
        }
        if (action === "getSummary") result = browserMockPersonalChats.find((chat) => chat.sessionId === args.sessionId) ?? null;
        if (action === "read") {
          const events = browserMockPersonalChatEvents.get(args.sessionId) ?? [];
          const entries: any[] = events.flatMap((envelope): any[] => {
            if (envelope.event?.type === "user_message") {
              return [{
                role: "user",
                text: envelope.event.text ?? "",
                displayText: envelope.event.displayText,
                timestamp: envelope.timestamp,
                turnId: envelope.event.turnId,
                messageId: envelope.event.messageId,
              }];
            }
            if (envelope.event?.type === "text") {
              return [{
                role: "assistant",
                text: envelope.event.text ?? "",
                timestamp: envelope.timestamp,
                turnId: envelope.event.turnId,
                itemId: envelope.event.itemId,
              }];
            }
            return [];
          });
          const limit = Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : entries.length;
          result = entries.slice(-limit);
        }
        if (action === "send") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          const turnId = `personal-turn-${Date.now()}-${++browserMockPersonalChatSequence}`;
          const timestamp = new Date().toISOString();
          const text = String(args.text ?? "").trim();
          const responseText = text
            ? `Browser preview received: ${text}`
            : "Browser preview received your message.";
          if (chat) {
            Object.assign(chat, {
              status: "idle",
              lastOutputPreview: responseText,
              updatedAt: timestamp,
              lastActivityAt: timestamp,
            });
            appendBrowserMockPersonalChatEvent(chat.sessionId, {
              type: "user_message",
              text,
              displayText: args.displayText ?? text,
              attachments: args.attachments ?? [],
              turnId,
              messageId: `personal-message-${++browserMockPersonalChatSequence}`,
            });
            appendBrowserMockPersonalChatEvent(chat.sessionId, { type: "status", turnStatus: "started", turnId });
            appendBrowserMockPersonalChatEvent(chat.sessionId, {
              type: "text",
              text: responseText,
              turnId,
              itemId: `personal-text-${++browserMockPersonalChatSequence}`,
            });
            appendBrowserMockPersonalChatEvent(chat.sessionId, { type: "status", turnStatus: "completed", turnId });
            appendBrowserMockPersonalChatEvent(chat.sessionId, {
              type: "done",
              turnId,
              status: "completed",
              model: chat.model,
              modelId: chat.modelId,
            });
          }
          result = { accepted: Boolean(chat), sessionId: args.sessionId, turnId };
        }
        if (action === "steer") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          const steerId = `personal-steer-${Date.now()}-${++browserMockPersonalChatSequence}`;
          if (chat) {
            appendBrowserMockPersonalChatEvent(chat.sessionId, {
              type: "user_message",
              text: String(args.text ?? ""),
              displayText: args.displayText ?? args.text ?? "",
              attachments: args.attachments ?? [],
              steerId,
              deliveryState: "queued",
            });
            chat.lastActivityAt = new Date().toISOString();
          }
          result = { queued: Boolean(chat), sessionId: args.sessionId, steerId };
        }
        if (action === "interrupt") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          const turnId = `personal-interrupt-${Date.now()}-${++browserMockPersonalChatSequence}`;
          if (chat) {
            chat.status = "idle";
            chat.lastActivityAt = new Date().toISOString();
            appendBrowserMockPersonalChatEvent(chat.sessionId, { type: "status", turnStatus: "interrupted", turnId });
            appendBrowserMockPersonalChatEvent(chat.sessionId, { type: "done", turnId, status: "interrupted" });
          }
          result = { interrupted: Boolean(chat), sessionId: args.sessionId };
        }
        if (action === "approve" || action === "respondToInput") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          const normalizedDecision = String(args.decision ?? "").toLowerCase();
          const resolution = normalizedDecision === "approve" || normalizedDecision === "accept" || normalizedDecision === "accepted"
            ? "accepted"
            : normalizedDecision === "deny" || normalizedDecision === "decline" || normalizedDecision === "declined"
              ? "declined"
              : "cancelled";
          if (chat && args.itemId) {
            appendBrowserMockPersonalChatEvent(chat.sessionId, {
              type: "pending_input_resolved",
              itemId: args.itemId,
              resolution,
            });
            chat.awaitingInput = false;
            chat.pendingInputItemId = null;
            chat.status = "idle";
          }
          result = { ok: Boolean(chat), sessionId: args.sessionId, itemId: args.itemId ?? null, resolution };
        }
        if (action === "getEventHistory") {
          result = {
            sessionId: args.sessionId ?? "",
            events: [...(browserMockPersonalChatEvents.get(args.sessionId) ?? [])],
            truncated: false,
            sessionFound: browserMockPersonalChats.some((chat) => chat.sessionId === args.sessionId),
          };
        }
        if (action === "getEventHistoryPage") {
          result = {
            sessionId: args.sessionId ?? "",
            events: [],
            startOffset: 0,
            hasMore: false,
            sessionFound: browserMockPersonalChats.some((chat) => chat.sessionId === args.sessionId),
          };
        }
        if (action === "updateSession") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          if (chat) Object.assign(chat, args, { updatedAt: new Date().toISOString() });
          result = chat ?? null;
        }
        if (action === "terminalCreate") {
          const id = `personal-terminal-${Date.now()}`;
          result = { ptyId: id, sessionId: id, pid: null };
        }
        if (action === "terminalWrite") result = { ok: true };
        if (action === "terminalResize") result = { ok: true, cols: args.cols, rows: args.rows };
        if (action === "terminalDispose") result = { disposed: true, reason: "disposed" };
        if (action === "archive") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          if (chat) Object.assign(chat, { archivedAt: new Date().toISOString(), status: "ended" });
          result = { ok: Boolean(chat) };
        }
        if (action === "unarchive") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          if (chat) Object.assign(chat, { archivedAt: null, status: "idle", updatedAt: new Date().toISOString() });
          result = { ok: Boolean(chat) };
        }
        if (action === "delete") {
          const index = browserMockPersonalChats.findIndex((chat) => chat.sessionId === args.sessionId);
          if (index >= 0) {
            browserMockPersonalChats.splice(index, 1);
            browserMockPersonalChatEvents.delete(args.sessionId);
          }
          result = { ok: index >= 0 };
        }
        return { action, result };
      },
      streamEvents: async ({ cursor = 0 }: any = {}) => ({ events: [], nextCursor: cursor, hasMore: false }),
    },
    agentChat: {
      list: async (args: any = {}) => listMockAgentChatSummaries(args),
      getSummary: async (args: any = {}) => {
        const sessionId = String(args?.sessionId ?? "").trim();
        const session = MOCK_SESSIONS.find((row) => row.id === sessionId);
        return mockAgentChatSummaryFromSession(session) ?? null;
      },
      create: resolvedArg({ id: "mock" }),
      suggestLaneName: resolvedArg("browser-mock-chat"),
      parallelLaunchState: {
        get: resolvedArg(null),
        set: resolvedArg(undefined),
      },
      handoff: resolvedArg({ session: { id: "mock" }, events: [] }),
      prepareCrossMachineHandoff: async (args: AgentChatPrepareCrossMachineHandoffArgs) => ({
        capsule: {
          version: 1,
          handoffId: args.handoffId,
          createdAt: new Date().toISOString(),
          source: {
            machineName: "Browser Preview",
            sessionId: args.sourceSessionId,
            provider: "claude",
            model: "claude-sonnet-5",
            title: "Browser preview parity",
            laneName: "main",
            branchRef: "main",
            headSha: "1234567890abcdef1234567890abcdef12345678",
            originUrl: "git@github.com:ade/browser-preview.git",
          },
          target: {
            targetModelId: args.targetModelId,
            reasoningEffort: args.reasoningEffort,
            fastMode: args.fastMode,
            claudePermissionMode: args.claudePermissionMode,
            codexApprovalPolicy: args.codexApprovalPolicy,
            codexSandbox: args.codexSandbox,
            codexConfigSource: args.codexConfigSource,
            opencodePermissionMode: args.opencodePermissionMode,
            droidPermissionMode: args.droidPermissionMode,
            permissionMode: args.permissionMode,
            cursorModeId: args.cursorModeId,
          },
          brief: "## Current goal\n- Continue polishing the browser preview handoff flow.\n\n## Important decisions and preserved context\n- Keep the setup clear and failure-aware.\n\n## Files, commands, and errors to preserve\n- apps/desktop/src/renderer/components/chat/CrossMachineHandoffModal.tsx\n\n## Next action or open issue\n- Verify the destination handoff UI.",
          artifacts: { fileChanges: [], commands: [], errors: [] },
          linearIssues: [],
          continuationPrompt: args.continuationPrompt?.trim() || "Continue from the handoff brief.",
        },
        capsuleFingerprint: "a".repeat(64),
        usedFallbackSummary: false,
        sanitizedSensitiveContext: false,
      }),
      validateCrossMachineSource: resolvedArg(undefined),
      markCrossMachineHandoff: resolvedArg(undefined),
      send: resolvedArg(undefined),
      steer: async () => ({
        steerId: globalThis.crypto.randomUUID(),
        queued: true,
      }),
      cancelSteer: resolvedArg(undefined),
      editSteer: resolvedArg(undefined),
      dispatchSteer: resolvedArg({
        delivered: false,
        reason: "Browser mock does not run chat sessions.",
      }),
      cancelDispatchedSteer: resolvedArg({ cancelled: false }),
      interrupt: resolvedArg<AgentChatInterruptResult>({
        mode: "stop_and_clear",
        cancelledQueuedCount: 0,
      }),
      restoreCancelledQueue: resolvedArg<AgentChatRestoreCancelledQueueResult>({
        restored: false,
        restoredCount: 0,
      }),
      recoverTurn: async (
        args: AgentChatRecoverTurnArgs,
      ): Promise<AgentChatRecoverTurnResult> => ({
        action: args.action,
        turnId: args.turnId,
        status: args.action === "wait"
          ? "waiting"
          : args.action === "nudge"
            ? "nudged"
            : args.action === "restart_resume"
              ? "resumed"
              : "retrying",
      }),
      recoverCodexTurn: async (
        args: AgentChatRecoverCodexTurnArgs,
      ): Promise<AgentChatRecoverCodexTurnResult> => ({
        action: args.action,
        turnId: args.turnId,
        status: args.action === "wait"
          ? "waiting"
          : args.action === "steer"
            ? "nudged"
            : args.action === "restart_resume_thread"
              ? "resumed"
              : "retrying",
      }),
      resolveUnprocessedMessage: async (
        args: AgentChatResolveUnprocessedMessageArgs,
      ): Promise<AgentChatResolveUnprocessedMessageResult> => ({
        steerId: args.steerId,
        action: args.action,
        status: "completed",
      }),
      approve: resolvedArg(undefined),
      respondToInput: resolvedArg(undefined),
      models: resolvedArg([]),
      modelCatalog: resolvedArg({ groups: [], fetchedAt: new Date(0).toISOString() }),
      archive: resolvedArg(undefined),
      unarchive: resolvedArg(undefined),
      delete: resolvedArg(undefined),
      updateSession: resolvedArg({ id: "mock" }),
      createScheduledWork: async () => {
        throw new Error("Scheduled work is unavailable in the browser preview.");
      },
      listScheduledWork: resolved([]),
      cancelScheduledWork: async () => {
        throw new Error("Scheduled work is unavailable in the browser preview.");
      },
      setScheduledWorkPaused: async (args: { sessionId: string; paused: boolean }) => ({
        sessionId: args.sessionId,
        paused: args.paused,
        nextWakeAt: null,
      }),
      warmupModel: resolvedArg(undefined),
      onEvent: noop,
      slashCommands: resolvedArg([]),
      listClaudePlugins: resolvedArg([]),
      reloadClaudePlugins: resolvedArg({
        plugins: [],
        commands: [],
        agents: [],
        errorCount: 0,
      }),
      listClaudeOutputStyles: resolvedArg([
        { name: "Default", source: "builtin" },
        { name: "Proactive", source: "builtin" },
        { name: "Explanatory", source: "builtin" },
        { name: "Learning", source: "builtin" },
      ]),
      setClaudeOutputStyle: resolvedArg({
        id: "mock",
        provider: "claude",
        claudeOutputStyle: "Default",
      }),
      listClaudeSessions: resolvedArg([]),
      getClaudeSessionInfo: resolvedArg(null),
      getClaudeSessionMessages: resolvedArg([]),
      getMainTranscript: resolvedArg(null),
      getSubagentTranscript: resolvedArg(null),
      getContextUsage: resolvedArg(null),
      rewindFiles: resolvedArg({
        canRewind: false,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        dryRun: true,
      }),
      fileSearch: resolvedArg([]),
      getTurnFileDiff: resolvedArg(null),
      listSubagents: resolvedArg([]),
      killDroidWorker: resolvedArg(undefined),
      getSessionCapabilities: resolvedArg({
        supportsSubagentInspection: false,
        supportsSubagentControl: false,
        supportsReviewMode: false,
        subagent: {
          canList: false,
          canViewFullTranscript: false,
          statsFields: [],
          kinds: [],
          hasRichMetadata: false,
        },
      }),
      saveTempAttachment: resolvedArg({ path: "/tmp/browser-mock-attachment" }),
      getImageDataUrl: resolvedArg({ dataUrl: "" }),
      resolveSmartLinkPreview: async ({ url }: { url: string }) => deriveSmartLinkPreview(url),
      getEventHistory: async (arg: {
        sessionId: string;
        maxEvents?: number;
      }) => ({
        sessionId: typeof arg?.sessionId === "string" ? arg.sessionId : "",
        events: (() => {
          const sessionId =
            typeof arg?.sessionId === "string" ? arg.sessionId : "";
          const events = getMockChatTranscriptEvents(sessionId);
          const maxEvents = Number.isFinite(arg?.maxEvents)
            ? Math.max(1, Math.floor(arg.maxEvents!))
            : events.length;
          return events.length > maxEvents ? events.slice(-maxEvents) : events;
        })(),
        truncated: (() => {
          const sessionId =
            typeof arg?.sessionId === "string" ? arg.sessionId : "";
          const events = getMockChatTranscriptEvents(sessionId);
          const maxEvents = Number.isFinite(arg?.maxEvents)
            ? Math.max(1, Math.floor(arg.maxEvents!))
            : events.length;
          return events.length > maxEvents;
        })(),
      }),
    },
    appControl: {
      getStatus: resolved({
        platform: "darwin",
        supported: false,
        activeSession: null,
        providers: [{
          provider: "cdp",
          available: false,
          detail: "Browser preview does not run App Control.",
        }],
      }),
      launch: resolvedArg({} as any),
      launchInTerminal: resolvedArg({} as any),
      connect: resolvedArg({} as any),
      stop: resolved({ ok: true as const, previousSession: null }),
      screenshot: resolvedArg({ dataUrl: null } as any),
      getSnapshot: resolvedArg({
        screenshot: null,
        elements: [],
        hitElement: null,
        screen: { width: 0, height: 0, scale: 1 },
      } as any),
      inspectPoint: resolvedArg({} as any),
      selectPoint: resolvedArg({} as any),
      click: resolved({ ok: true as const }),
      typeText: resolved({ ok: true as const }),
      scroll: resolved({ ok: true as const }),
      dispatchKey: resolved({ ok: true as const }),
      listTargets: resolved([]),
      attachToTarget: resolvedArg({} as any),
      onEvent: () => () => {},
    },
    iosSimulator: {
      getStatus: resolved({
        platform: "darwin",
        supported: false,
        tools: [],
        activeDevice: null,
        activeSession: null,
      }),
      listDevices: resolved([]),
      listLaunchTargets: resolved([]),
      launch: resolvedArg({} as any),
      attachToChatSession: resolved(null),
      shutdown: resolvedArg({ ok: true } as any),
      screenshot: resolvedArg({} as any),
      getScreenSnapshot: resolvedArg({} as any),
      getInspectorSnapshot: resolved(null),
      inspectPoint: resolvedArg({} as any),
      getPreviewCapability: resolvedArg(BROWSER_MOCK_PREVIEW_CAPABILITY_UNSUPPORTED as any),
      listPreviewTargets: resolved([]),
      resolvePreviewMatch: resolvedArg({
        status: "no-context",
        target: null,
        confidence: "none",
        reason: "Browser preview has no iOS simulator context.",
        selectedSourceFile: null,
        selectedSourceLine: null,
        suggestedTitle: null,
        suggestedSourceFile: null,
        suggestedSourceFilePath: null,
      } as any),
      ensurePreviewWorkspace: resolvedArg({
        ok: false,
        opened: false,
        path: null,
        capability: BROWSER_MOCK_PREVIEW_CAPABILITY_UNSUPPORTED,
        error: "Browser preview cannot manage Xcode.",
      } as any),
      renderCurrentPreview: resolvedArg({
        ok: false,
        match: {
          status: "no-context",
          target: null,
          confidence: "none",
          reason: "Browser preview has no iOS simulator context.",
          selectedSourceFile: null,
          selectedSourceLine: null,
          suggestedTitle: null,
          suggestedSourceFile: null,
          suggestedSourceFilePath: null,
        },
        target: null,
        render: null,
        error: "Browser preview cannot manage Xcode.",
      } as any),
      renderPreview: resolvedArg({} as any),
      openPreviewWorkspace: resolved({ ok: true as const, path: "/tmp" }),
      startStream: resolvedArg({ streaming: false, streamUrl: null } as any),
      stopStream: resolvedArg({ streaming: false, streamUrl: null } as any),
      getStreamStatus: resolvedArg({ streaming: false, streamUrl: null } as any),
      getSimulatorWindowState: resolvedArg({ visible: false } as any),
      listSimulatorWindowSources: resolved([]),
      tap: resolved({ ok: true as const }),
      typeText: resolved({ ok: true as const }),
      drag: resolved({ ok: true as const }),
      swipe: resolved({ ok: true as const }),
      selectPoint: resolvedArg({} as any),
      onEvent: () => () => {},
    },
    builtInBrowser: {
      getStatus: resolved({
        attached: false,
        partition: "persist:ade-browser",
        storageProfileKey: "global",
        collectionKey: "personal",
        collectionProjectRoot: null,
        persistentProfile: true,
        visible: false,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        activeTabId: null,
        tabs: [],
        url: null,
        title: null,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        isInspecting: false,
        hasSelection: false,
        ownerLaneId: null,
        ownerChatSessionId: null,
        ownerClaimedAt: null,
        ownerLeaseExpiresAt: null,
      }),
      requestOriginAccess: resolvedArg({
        origin: null,
        required: false,
        granted: true,
        status: {} as any,
      }),
      getProfileDiagnostics: resolved({
        partition: "persist:ade-browser",
        storageProfileKey: "global" as const,
        persistentProfile: true as const,
        cookieCount: 0,
        persistentCookieCount: 0,
        sessionCookieCount: 0,
        cookieDomains: [],
        cacheSizeBytes: 0,
        persistedPermissionDecisionCount: 0,
        tabRestorationEnabled: false,
        lastStorageFlushAt: null,
      }),
      listPermissions: resolved({ permissions: [] }),
      clearPermissions: resolvedArg({ removed: 0, permissions: [] }),
      claim: resolvedArg({} as any),
      showPanel: resolvedArg({} as any),
      setBounds: resolvedArg({} as any),
      attachWebview: resolvedArg({} as any),
      navigate: resolvedArg({} as any),
      createTab: resolvedArg({} as any),
      switchTab: resolvedArg({} as any),
      closeTab: resolvedArg({} as any),
      reload: resolvedArg({} as any),
      goBack: resolvedArg({} as any),
      goForward: resolvedArg({} as any),
      stop: resolvedArg({} as any),
      startInspect: resolvedArg({} as any),
      stopInspect: resolved(async () => {}),
      captureScreenshot: resolvedArg({} as any),
      selectPoint: resolvedArg({} as any),
      selectCurrent: resolvedArg({} as any),
      clearSelection: resolved({ ok: true as const }),
      onEvent: () => () => {},
    },
    terminal: {
      list: async (_args: any = {}) => [] as any[],
      read: async () => ({ output: "", truncated: false, exitCode: null }),
      preview: async () => ({ output: "", truncated: false }),
      write: resolved({ ok: true as const }),
      signal: resolved({ ok: true as const }),
      activeForChat: async () => null,
      reattachChatCli: async () => ({
        ok: false as const,
        reason: "Browser mock does not attach chat CLI terminals.",
      }),
    },
    cto: {
      getState: resolvedArg({
        identity: ADE_DB_SNAPSHOT?.ctoState?.identity ?? {
          name: "CTO",
          version: 1,
          persona: "Mock CTO persona",
          modelPreferences: { provider: "claude", model: "sonnet" },
          updatedAt: now,
        },
        recentSessions: ADE_DB_SNAPSHOT?.ctoState?.recentSessions ?? [],
      }),
      getOnboardingState: resolved({
        completedSteps: ["identity"],
        completedAt: now,
      }),
      completeOnboardingStep: resolvedArg({
        completedSteps: ["identity"],
        completedAt: now,
      }),
      dismissOnboarding: resolved({
        completedSteps: ["identity"],
        dismissedAt: now,
      }),
      resetOnboarding: resolved({ completedSteps: [] }),
      getMemory: resolved({
        memory: [
          "## Facts",
          "- We ship desktop releases from tagged commits on main.",
          "- The team prefers concise status updates with next actions.",
          "- Current focus: hardening the mobile sync transport.",
        ].join("\n"),
        threadState:
          "_Updated just now (compaction)_\n- Reviewing PR queue health.\n- Open loop: flaky sync test on CI.",
        dailyLog: "09:12 — Asked for PR queue summary → 3 PRs ready, 1 blocked on CI.",
        dailyLogDate: now.slice(0, 10),
        updatedAt: now,
      }),
      updateMemory: async (arg: { memory?: string }) => ({
        memory: arg?.memory ?? "",
        threadState: "",
        dailyLog: "",
        dailyLogDate: now.slice(0, 10),
        updatedAt: now,
      }),
      searchMemory: resolvedArg({ query: "", rows: [] }),
      ensureSession: resolvedArg({
        id: "mock-cto-session",
        laneId: "lane-main",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
        capabilityMode: "full_tooling",
        status: "idle",
        createdAt: now,
        lastActivityAt: now,
      }),
      listSessionLogs: resolvedArg([]),
      updateIdentity: resolvedArg({
        identity: {
          name: "CTO",
          version: 1,
          persona: "Mock CTO persona",
          modelPreferences: { provider: "claude", model: "sonnet" },
          updatedAt: now,
        },
        recentSessions: [],
      }),
      previewSystemPrompt: resolvedArg({
        prompt: "You are the CTO for this project inside ADE.",
        tokenEstimate: 10,
        sections: [
          {
            id: "doctrine",
            title: "Immutable ADE doctrine",
            content: "You are the CTO for this project inside ADE.",
          },
          {
            id: "personality",
            title: "Selected personality overlay",
            content: "Operate as a strategic CTO.",
          },
          {
            id: "continuity",
            title: "Continuity model",
            content: "CTO continuity uses the current project context.",
          },
          {
            id: "capabilities",
            title: "Capability manifest",
            content: "ADE capabilities are exposed through registered tools.",
          },
        ],
      }),
      getLinearProjects: resolvedArg(MOCK_LINEAR_PROJECTS),
      getLinearQuickView: resolvedArg({
        connection: MOCK_LINEAR_CONNECTION,
        organization: {
          id: "mock-linear-org",
          name: "ADE",
          urlKey: "ade",
          logoUrl: null,
          gitBranchFormat: null,
          createdIssueCount: 128,
          roadmapEnabled: true,
          customersEnabled: false,
          releasesEnabled: true,
        },
        viewer: {
          id: "mock-linear-user",
          name: "Mock Linear User",
          displayName: "Mock Linear User",
          email: "mock@example.com",
          avatarUrl: null,
          admin: true,
          guest: false,
          url: null,
        },
        projects: [
          {
            id: "mock-linear-project",
            name: "Desktop polish",
            slug: "desktop-polish",
            teamName: "ADE",
            teamKey: "ADE",
            url: "https://linear.app/ade/project/desktop-polish",
            color: "#5E6AD2",
            icon: null,
            description: "Mock Linear project",
            statusName: "Started",
            statusType: "started",
            health: "onTrack",
            progress: 0.42,
            scope: 21,
            priority: 2,
            priorityLabel: "High",
            issueCount: 9,
            completedIssueCount: 4,
            startDate: null,
            targetDate: null,
            leadName: "Mock Linear User",
            teamKeys: ["ADE"],
          },
        ],
        teams: [
          {
            id: "mock-linear-team",
            key: "ADE",
            name: "ADE",
            displayName: "ADE",
            color: "#5E6AD2",
            issueCount: 32,
            cyclesEnabled: true,
            private: false,
          },
        ],
        assignedIssues: MOCK_LINEAR_ISSUES,
        recentIssues: MOCK_LINEAR_ISSUES,
        fetchedAt: now,
        sdk: {
          packageName: "@linear/sdk",
          surfaces: [
            "viewer",
            "organization",
            "projects",
            "teams",
            "assignedIssues",
            "issues",
          ],
        },
      }),
      getLinearIssuePickerData: resolvedArg(MOCK_LINEAR_PICKER),
      searchLinearIssues: resolvedArg({
        issues: MOCK_LINEAR_ISSUES,
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
      getLinearConnectionStatus: resolvedArg(MOCK_LINEAR_CONNECTION),
      setLinearToken: resolvedArg({
        ...MOCK_LINEAR_CONNECTION,
        authMode: "manual" as const,
        message: "Linear token accepted in browser preview.",
      }),
      clearLinearToken: resolvedArg({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        organizationId: null,
        organizationName: null,
        organizationUrlKey: null,
        organizationLogoUrl: null,
        projectCount: 0,
        projectPreview: [],
        checkedAt: now,
        authMode: null,
        oauthAvailable: true,
        tokenExpiresAt: null,
        message: "Linear disconnected in browser preview.",
      }),
      setLinearOAuthClient: resolvedArg({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt: now,
        authMode: null,
        oauthAvailable: true,
        tokenExpiresAt: null,
        message: "Linear OAuth configured.",
      }),
      clearLinearOAuthClient: resolvedArg({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt: now,
        authMode: null,
        oauthAvailable: false,
        tokenExpiresAt: null,
        message: "Linear OAuth configuration cleared.",
      }),
      startLinearOAuth: resolvedArg({
        sessionId: "linear-oauth-mock",
        authUrl: "https://linear.app/oauth/authorize",
        redirectUri: "http://127.0.0.1:3000/oauth/callback",
      }),
      getLinearOAuthSession: resolvedArg({
        status: "completed",
        connection: {
          tokenStored: true,
          connected: true,
          viewerId: "viewer-mock",
          viewerName: "Mock Linear User",
          checkedAt: now,
          authMode: "oauth",
          oauthAvailable: true,
          tokenExpiresAt: null,
          message: null,
        },
      }),
    },
    externalSessions: {
      list: async () => [],
      import: async () => ({ kind: "cli" as const, sessionId: "mock-session", ptyId: "mock", laneId: "mock-lane" }),
    },
    pty: {
      create: resolvedArg({
        ptyId: "mock",
        sessionId: "mock-session",
        pid: 1234,
      }),
      sendToSession: resolvedArg({
        ptyId: "mock",
        sessionId: "mock-session",
        pid: 1234,
        session: null,
        resumed: false,
        reusedExistingRuntime: true,
      }),
      write: resolvedArg(undefined),
      resize: resolvedArg(undefined),
      dispose: resolvedArg(undefined),
      setDataSubscriptions: resolvedArg(undefined),
      onData: noop,
      onExit: noop,
    },
    diff: {
      getChanges: resolvedArg({ unstaged: [], staged: [] }),
      getFile: resolvedArg({
        path: "",
        mode: "unstaged" as const,
        original: { exists: false, text: "" },
        modified: { exists: false, text: "" },
      }),
    },
    files: {
      writeTextAtomic: resolvedArg(undefined),
      listWorkspaces: resolved(getBrowserMockFilesWorkspaces()),
      listTree: async (args: any) => {
        const workspaceId = String(args?.workspaceId ?? "");
        const parentPath = normalizeBrowserMockRelPath(args?.parentPath);
        return getBrowserMockListTreeNodes(workspaceId, parentPath);
      },
      listTreeChildren: async (args: any) => {
        const workspaceId = String(args?.workspaceId ?? "");
        const parentPath = normalizeBrowserMockRelPath(args?.parentPath);
        const all = getBrowserMockListTreeNodes(workspaceId, parentPath);
        const offset = Number.isFinite(args?.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.floor(args.limit)) : 500;
        const pageEnd = Math.min(offset + limit, all.length);
        return {
          parentPath,
          children: all.slice(offset, pageEnd),
          offset,
          limit,
          total: all.length,
          nextOffset: pageEnd < all.length ? pageEnd : null,
        };
      },
      refreshGitDecorations: async (args: any) => ({
        workspaceId: String(args?.workspaceId ?? ""),
        files: [],
        directories: [],
      }),
      openExternalPath: async () => {
        throw new Error("External local files are not available in the browser mock.");
      },
      readFile: async (args: any) => {
        const workspaceId = String(args?.workspaceId ?? "");
        const relPath = String(args?.path ?? "");
        return getBrowserMockReadFilePayload(workspaceId, relPath);
      },
      readFileRange: async (args: any) => {
        const offset = Number.isFinite(args?.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
        return {
          path: String(args?.path ?? ""),
          encoding: "utf-8" as const,
          content: "",
          rangeStart: offset,
          rangeEnd: offset,
          totalSize: offset,
          nextOffset: null,
          eof: true,
        };
      },
      gitBlame: async (args: any) => ({ path: String(args?.path ?? ""), lines: [] }),
      writeText: resolvedArg(undefined),
      createFile: resolvedArg(undefined),
      createDirectory: resolvedArg(undefined),
      rename: resolvedArg(undefined),
      delete: resolvedArg(undefined),
      watchChanges: resolvedArg(undefined),
      stopWatching: resolvedArg(undefined),
      quickOpen: async (args: any) => {
        const workspaceId = String(args?.workspaceId ?? "");
        const q = String(args?.query ?? "")
          .trim()
          .toLowerCase();
        const limit = Number.isFinite(args?.limit)
          ? Math.max(1, Math.floor(args.limit))
          : 25;
        const rootNodes = getBrowserMockListTreeNodes(workspaceId, "");
        const flat: { path: string; score: number }[] = [];
        const maxCollect = 400;
        const walk = (nodes: any[], prefixScore: number) => {
          if (flat.length >= maxCollect) return;
          for (const node of nodes) {
            if (!node?.path) continue;
            const hay = String(node.path).toLowerCase();
            if (!q || hay.includes(q)) {
              flat.push({
                path: node.path,
                score: prefixScore + (node.name?.length ?? 0),
              });
            }
            if (node.type === "directory") {
              const kids = getBrowserMockListTreeNodes(workspaceId, node.path);
              if (kids.length) walk(kids, prefixScore + 1);
            }
            if (flat.length >= maxCollect) return;
          }
        };
        walk(rootNodes, 0);
        return flat.slice(0, limit);
      },
      searchText: resolvedArg([]),
      onChange: noop,
    },
    git: {
      stageFile: resolvedArg({ ok: true }),
      stageAll: resolvedArg({ ok: true }),
      unstageFile: resolvedArg({ ok: true }),
      unstageAll: resolvedArg({ ok: true }),
      discardFile: resolvedArg({ ok: true }),
      restoreStagedFile: resolvedArg({ ok: true }),
      commit: resolvedArg({ ok: true }),
      listRecentCommits: resolvedArg([
        {
          sha: "abcdef1234567890",
          shortSha: "abcdef1",
          parents: [],
          authorName: "ADE Browser Mock",
          authoredAt: now,
          subject: "Browser mock HEAD commit",
          pushed: true,
        },
      ]),
      listCommitFiles: resolvedArg([]),
      getCommitMessage: resolvedArg(""),
      getCommit: resolvedArg(null),
      isCommitInLaneHistory: resolvedArg(true),
      revertCommit: resolvedArg({ ok: true }),
      cherryPickCommit: resolvedArg({ ok: true }),
      createTag: resolvedArg({ ok: true }),
      resetToCommit: resolvedArg({ ok: true }),
      stashPush: resolvedArg({ ok: true }),
      stashList: resolvedArg([]),
      stashApply: resolvedArg({ ok: true }),
      stashPop: resolvedArg({ ok: true }),
      stashDrop: resolvedArg({ ok: true }),
      fetch: resolvedArg({ ok: true }),
      pull: resolvedArg({ ok: true }),
      undoLastHeadChange: resolvedArg({ ok: true }),
      redoLastHeadChange: resolvedArg({ ok: true }),
      getSyncStatus: resolvedArg({
        hasUpstream: true,
        upstreamState: "tracking",
        upstreamRef: "origin/main",
        ahead: 0,
        behind: 0,
        diverged: false,
        recommendedAction: "none",
      }),
      getOriginRemote: resolvedArg({
        remoteUrl: "git@github.com:ade/browser-preview.git",
        branch: "main",
      }),
      getUserIdentity: resolvedArg({ name: "Mock User", email: "mock@example.com" }),
      sync: resolvedArg({ ok: true }),
      push: resolvedArg({ ok: true }),
      getConflictState: resolvedArg({ hasConflicts: false }),
      rebaseContinue: resolvedArg({ ok: true }),
      rebaseAbort: resolvedArg({ ok: true }),
      mergeContinue: resolvedArg({ ok: true }),
      mergeAbort: resolvedArg({ ok: true }),
      listBranches: resolvedArg([]),
      checkoutBranch: resolvedArg({ ok: true }),
    },
    conflicts: {
      getLaneStatus: resolvedArg({ status: "clean" }),
      listOverlaps: resolvedArg([]),
      getRiskMatrix: resolved([]),
      simulateMerge: resolvedArg({ conflicts: [] }),
      runPrediction: resolved({ assessments: [] }),
      getBatchAssessment: resolved({ assessments: [] }),
      listProposals: resolvedArg([]),
      prepareProposal: resolvedArg({}),
      requestProposal: resolvedArg({}),
      applyProposal: resolvedArg({}),
      undoProposal: resolvedArg({}),
      runExternalResolver: resolvedArg({}),
      listExternalResolverRuns: resolved([]),
      commitExternalResolverRun: resolvedArg({}),
      prepareResolverSession: resolvedArg({}),
      attachResolverSession: resolvedArg({}),
      finalizeResolverSession: resolvedArg({}),
      cancelResolverSession: resolvedArg({}),
      suggestResolverTarget: resolvedArg({}),
      onEvent: noop,
    },
    context: {
      getStatus: resolved({ initialized: false }),
      generateDocs: resolvedArg({}),
      openDoc: resolvedArg(undefined),
    },
    feedback: {
      prepareDraft: resolvedArg({
        category: "bug",
        draftInput: {
          category: "bug",
          summary: "Mock feedback",
          stepsToReproduce: "",
          expectedBehavior: "",
          actualBehavior: "",
          environment: "",
          additionalContext: "",
        },
        userDescription: "## Summary\n\nMock feedback",
        modelId: null,
        reasoningEffort: null,
        title: "Mock feedback",
        body: "## Description\n\nMock feedback",
        labels: ["bug"],
        generationMode: "deterministic",
        generationWarning:
          "ADE used a deterministic draft because no AI model was selected.",
      }),
      submitDraft: resolvedArg({
        id: "mock-feedback-1",
        category: "bug",
        userDescription: "Mock feedback",
        modelId: null,
        status: "posted",
        generationMode: null,
        generationWarning: null,
        generatedTitle: null,
        generatedBody: null,
        issueUrl: null,
        issueNumber: null,
        issueState: null,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      }),
      list: resolved([]),
      onUpdate: () => () => {},
    },
    github: {
      getStatus: resolved({
        tokenStored: true,
        patTokenStored: false,
        tokenDecryptionFailed: false,
        storageScope: "app",
        authSource: "gh",
        tokenType: "oauth",
        repo: { owner: "arul28", name: "ADE" },
        hasOrigin: true,
        userLogin: "arul",
        scopes: ["repo", "workflow"],
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
        checkedAt: new Date().toISOString(),
        repoAccessOk: true,
        repoAccessError: null,
        connected: true,
      }),
      getRemoteStatus: resolved({
        repo: { owner: "arul28", name: "ADE" },
        hasOrigin: true,
      }),
      setToken: resolvedArg({
        tokenStored: true,
        patTokenStored: true,
        tokenDecryptionFailed: false,
        storageScope: "app",
        authSource: "pat",
        tokenType: "classic",
        repo: { owner: "arul28", name: "ADE" },
        hasOrigin: true,
        userLogin: "arul",
        scopes: ["repo", "workflow"],
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
        checkedAt: new Date().toISOString(),
        repoAccessOk: true,
        repoAccessError: null,
        connected: true,
      }),
      clearToken: resolved({
        tokenStored: false,
        patTokenStored: false,
        tokenDecryptionFailed: false,
        storageScope: "app",
        authSource: "none",
        tokenType: "unknown",
        repo: { owner: "arul28", name: "ADE" },
        hasOrigin: true,
        userLogin: null,
        scopes: [],
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
        checkedAt: null,
        repoAccessOk: null,
        repoAccessError: null,
        connected: false,
      }),
      getAppUserAuthStatus: resolved({
        configured: true,
        tokenStored: true,
        userLogin: "arul",
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      startAppUserDeviceAuth: resolved({
        sessionId: "mock-github-device-session",
        userCode: "ADE-MOCK",
        verificationUri: "https://github.com/login/device",
        verificationUriComplete: "https://github.com/login/device",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        intervalSec: 5,
      }),
      pollAppUserDeviceAuth: resolved({
        status: "authorized",
        intervalSec: null,
        message: null,
        authStatus: {
          configured: true,
          tokenStored: true,
          userLogin: "arul",
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
          refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
          checkedAt: new Date().toISOString(),
          error: null,
        },
      }),
      clearAppUserAuth: resolved({
        configured: true,
        tokenStored: false,
        userLogin: null,
        expiresAt: null,
        refreshTokenExpiresAt: null,
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      detectRepo: resolved({ owner: "arul28", name: "ADE" }),
      getAppInstallationStatus: resolved({
        repo: { owner: "arul28", name: "ADE" },
        appName: "ADE",
        appSlug: "ade-for-github",
        installUrl: "https://github.com/apps/ade-for-github/installations/new",
        manageUrl: "https://github.com/settings/installations",
        relayConfigured: true,
        installed: true,
        state: "configured",
        installationId: 123,
        repositorySelection: "all",
        lastSeenAt: new Date().toISOString(),
        webhookEvents: ["installation", "installation_repositories", "pull_request"],
        missingWebhookEvents: [],
        webhookState: "active",
        webhookLastSeenAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      listRepoAutolinks: resolved([]),
      createRepoAutolink: resolvedArg({ id: 1, keyPrefix: "ADEPR-", urlTemplate: "https://ade-app.dev/open?type=pr&repo=arul28%2FADE&number=<num>", isAlphanumeric: false }),
      listRepoLabels: resolved([]),
      listRepoCollaborators: resolved([]),
      onStatusChanged: noop,
    },
    prs: {
      createFromLane: resolvedArg(
        USE_ADE_DB_SNAPSHOT ? null : (NORMAL_PRS[0] ?? null),
      ),
      linkToLane: resolvedArg(
        USE_ADE_DB_SNAPSHOT ? null : (NORMAL_PRS[0] ?? null),
      ),
      preflightCreateLaneFromPrBranch: async (args: any) => ({
        preflight: buildCreateLaneFromPrPreflight(args),
        lane: null,
        pr: null,
      }),
      createLaneFromPrBranch: async (args: any) => {
        const preflight = buildCreateLaneFromPrPreflight(args);
        const lane = {
          id: `mock-lane-from-pr-${preflight.githubPrNumber}`,
          name: preflight.targetLaneName,
          laneType: "feature",
          baseRef: preflight.baseBranch ?? "main",
          branchRef: preflight.headBranch,
          worktreePath: `${MOCK_PROJECT.rootPath}/.ade/worktrees/mock-${preflight.githubPrNumber}`,
          attachedRootPath: null,
          isEditProtected: false,
          parentLaneId: null,
          color: null,
          icon: null,
          tags: [],
          folder: null,
          status: {
            dirty: false,
            ahead: 0,
            behind: 0,
            remoteBehind: -1,
            rebaseInProgress: false,
          },
          createdAt: now,
          archivedAt: null,
        };
        const pr =
          ALL_PRS.find(
            (entry: any) =>
              entry.githubPrNumber === preflight.githubPrNumber &&
              entry.repoOwner === preflight.repoOwner &&
              entry.repoName === preflight.repoName,
          ) ??
          ({
            id: `mock-pr-${preflight.githubPrNumber}`,
            laneId: lane.id,
            projectId: MOCK_PROJECT.id,
            repoOwner: preflight.repoOwner,
            repoName: preflight.repoName,
            githubPrNumber: preflight.githubPrNumber,
            githubUrl: preflight.githubUrl,
            githubNodeId: null,
            title: preflight.title,
            state: "open",
            baseBranch: preflight.baseBranch ?? "main",
            headBranch: preflight.headBranch ?? "",
            checksStatus: "none",
            reviewStatus: "none",
            additions: 0,
            deletions: 0,
            lastSyncedAt: now,
            createdAt: now,
            updatedAt: now,
            creationStrategy: "pr_target",
          } as any);
        return { preflight, lane, pr };
      },
      getForLane: async (laneId: string) =>
        ALL_PRS.find((pr: any) => pr.laneId === laneId) ?? null,
      listAll: resolved(ALL_PRS),
      listOpenForRepo: async () =>
        MOCK_GITHUB_SNAPSHOT.repoPullRequests
          .filter((item: any) => item.linkedPrId == null)
          .map((item: any) => ({
            branch: item.headBranch,
            prNumber: item.githubPrNumber,
            title: item.title,
            url: item.githubUrl,
          })),
      refresh: resolved(ALL_PRS),
      getStatus: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.status ??
        MOCK_STATUS_BY_PR[prId] ?? {
          prId,
          state: "open",
          checksStatus: "passing",
          reviewStatus: "none",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 0,
        },
      getChecks: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.checks ??
        MOCK_CHECKS_BY_PR[prId] ??
        [],
      getComments: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.comments ??
        MOCK_COMMENTS_BY_PR[prId] ??
        [],
      getReviews: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.reviews ??
        MOCK_REVIEWS_BY_PR[prId] ??
        [],
      getReviewThreads: resolvedArg([]),
      updateDescription: resolvedArg(undefined),
      delete: resolvedArg({ deleted: true }),
      draftDescription: resolvedArg({
        title: "AI-drafted title",
        body: "AI-drafted body",
      }),
      land: resolvedArg({ success: true, prNumber: 142, sha: "abc123" }),
      landStack: resolvedArg([]),
      retargetBase: resolvedArg(undefined),
      openInGitHub: resolvedArg(undefined),
      createQueue: resolvedArg({}),
      createIntegration: resolvedArg({}),
      simulateIntegration: resolvedArg(MOCK_INTEGRATION_SIMULATION),
      commitIntegration: resolvedArg({
        groupId: "group-int-mock",
        integrationLaneId: "lane-search",
        pr: USE_ADE_DB_SNAPSHOT ? null : (INTEGRATION_PRS[0] ?? null),
        mergeResults: [],
      }),
      landStackEnhanced: resolvedArg([]),
      landQueueNext: resolvedArg({
        success: true,
        prNumber: 161,
        sha: "def456",
      }),
      startQueueAutomation: async (args: {
        groupId: string;
        autoResolve?: boolean;
        archiveLane?: boolean;
        ciGating?: boolean;
        method?: string;
        resolverModel?: string;
        reasoningEffort?: string;
      }) => {
        const state = MOCK_QUEUE_STATE[args.groupId];
        if (!state) throw new Error(`Unknown queue group: ${args.groupId}`);
        state.state = "landing";
        state.config = {
          ...state.config,
          autoResolve: args.autoResolve ?? state.config.autoResolve,
          archiveLane: args.archiveLane ?? state.config.archiveLane,
          ciGating: args.ciGating ?? state.config.ciGating,
          method: args.method ?? state.config.method,
          resolverModel: args.resolverModel ?? state.config.resolverModel,
          reasoningEffort: args.reasoningEffort ?? state.config.reasoningEffort,
        };
        return state;
      },
      pauseQueueAutomation: async (queueId: string) => {
        const state =
          Object.values(MOCK_QUEUE_STATE).find(
            (candidate) => candidate.queueId === queueId,
          ) ?? null;
        if (state) state.state = "paused";
        return state;
      },
      resumeQueueAutomation: async (args: { queueId: string }) => {
        const state =
          Object.values(MOCK_QUEUE_STATE).find(
            (candidate) => candidate.queueId === args.queueId,
          ) ?? null;
        if (state) state.state = "landing";
        return state;
      },
      cancelQueueAutomation: async (queueId: string) => {
        const state =
          Object.values(MOCK_QUEUE_STATE).find(
            (candidate) => candidate.queueId === queueId,
          ) ?? null;
        if (state) state.state = "cancelled";
        return state;
      },
      getHealth: resolvedArg({}),
      getQueueState: async (groupId: string) =>
        MOCK_QUEUE_STATE[groupId] ?? null,
      listQueueStates: async () => Object.values(MOCK_QUEUE_STATE),
      getConflictAnalysis: resolvedArg({}),
      getMergeContext: async (prId: string) =>
        MOCK_MERGE_CONTEXTS[prId] ?? {
          prId,
          groupId: null,
          groupType: null,
          sourceLaneIds: [],
          targetLaneId: null,
          integrationLaneId: null,
          members: [],
        },
      getMergeContexts: async (prIds: string[]) =>
        Object.fromEntries(
          prIds.map((prId) => [
            prId,
            MOCK_MERGE_CONTEXTS[prId] ?? {
              prId,
              groupId: null,
              groupType: null,
              sourceLaneIds: [],
              targetLaneId: null,
              integrationLaneId: null,
              members: [],
            },
          ]),
        ),
      listWithConflicts: resolved(ALL_PRS),
      listSnapshots: async (args?: { prId?: string }) => {
        let snapshots = ADE_DB_PR_SNAPSHOTS;
        const prId = args?.prId?.trim();
        if (prId) {
          snapshots = snapshots.filter((snapshot) => snapshot.prId === prId);
        }
        return snapshots;
      },
      getGitHubSnapshot: resolvedArg(MOCK_GITHUB_SNAPSHOT),
      listIntegrationWorkflows: resolved(MOCK_INTEGRATION_WORKFLOWS),
      aiResolutionStart: async () => ({
        sessionId: "mock-pr-ai-session",
        provider: "codex" as const,
        ptyId: null,
        status: "started" as const,
        error: null,
        context: { sourceTab: "normal" as const, laneId: "lane-1" },
      }),
      aiResolutionInput: resolvedArg(undefined),
      aiResolutionStop: resolvedArg(undefined),
      onAiResolutionEvent: noop,
      onEvent: noop,
      getDetail: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.detail ?? {
          prId,
          body: null,
          labels: [],
          assignees: [],
          requestedReviewers: [],
          author: { login: "", avatarUrl: null },
          isDraft: false,
          milestone: null,
          linkedIssues: [],
        },
      getFiles: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.files ?? [],
      getCommits: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.commits ?? [],
      getDeployments: resolvedArg([]),
      getAiSummary: resolvedArg(null),
      regenerateAiSummary: resolvedArg(null),
      postReviewComment: resolvedArg({
        id: "mock-review-comment",
        author: "you",
        body: "",
        url: null,
        createdAt: now,
        updatedAt: now,
      }),
      setReviewThreadResolved: resolvedArg(undefined),
      reactToComment: resolvedArg(undefined),
      cleanupBranch: resolvedArg({ deleted: false, reason: "browser-mock" }),
      reorderQueuePrs: resolvedArg(undefined),
      aiResolutionGetSession: resolvedArg(null),
      getActionRuns: resolvedArg([]),
      getActivity: resolvedArg([]),
      addComment: resolvedArg({
        id: "mock",
        author: "you",
        body: "",
        source: "issue",
        url: null,
        path: null,
        line: null,
        createdAt: null,
        updatedAt: null,
      }),
      replyToReviewThread: resolvedArg({
        id: "thread-reply",
        author: "you",
        authorAvatarUrl: null,
        body: "",
        url: null,
        createdAt: null,
        updatedAt: null,
      }),
      resolveReviewThread: resolvedArg(undefined),
      updateTitle: resolvedArg(undefined),
      updateBody: resolvedArg(undefined),
      setLabels: resolvedArg(undefined),
      requestReviewers: resolvedArg(undefined),
      submitReview: resolvedArg({
        id: "pr-review-1",
        nodeId: "PRR_mock_1",
        htmlUrl: "https://github.com/mock/repo/pull/1#pullrequestreview-1",
        state: "COMMENTED",
        submittedAt: now,
      }),
      close: resolvedArg(undefined),
      reopen: resolvedArg(undefined),
      rerunChecks: resolvedArg(undefined),
      aiReviewSummary: resolvedArg({
        summary: "AI review summary placeholder",
        potentialIssues: [],
        recommendations: [],
        mergeReadiness: "ready",
      }),
      listProposals: resolved([]),
      dismissIntegrationCleanup: resolvedArg(
        USE_ADE_DB_SNAPSHOT
          ? undefined
          : (BUILTIN_MOCK_INTEGRATION_WORKFLOWS[1] ?? undefined),
      ),
      cleanupIntegrationWorkflow: resolvedArg({
        proposalId: "workflow-int-active",
        archivedLaneIds: ["lane-search"],
        skippedLaneIds: [],
        workflowDisplayState: "history",
        cleanupState: "completed",
      }),
      updateProposal: resolvedArg(undefined),
      deleteProposal: resolvedArg(undefined),
      createIntegrationLaneForProposal: resolvedArg({
        integrationLaneId: "lane-search",
        mergedCleanLanes: [],
        conflictingLanes: [],
      }),
      startIntegrationResolution: resolvedArg({}),
      getIntegrationResolutionState: resolvedArg(null),
      recheckIntegrationStep: resolvedArg({}),
    },
    rebase: {
      scanNeeds: resolved(MOCK_REBASE_NEEDS),
      getNeed: resolvedArg(null),
      dismiss: resolvedArg(undefined),
      defer: resolvedArg2(undefined),
      execute: resolvedArg({}),
      onEvent: noop,
    },
    history: {
      listOperations: async (args: any = {}) => {
        let rows = ADE_DB_OPERATIONS;
        if (typeof args?.laneId === "string" && args.laneId.trim()) {
          rows = rows.filter(
            (operation) => operation.laneId === args.laneId.trim(),
          );
        }
        if (typeof args?.kind === "string" && args.kind.trim()) {
          rows = rows.filter(
            (operation) => operation.kind === args.kind.trim(),
          );
        }
        if (typeof args?.status === "string" && args.status !== "all") {
          rows = rows.filter((operation) => operation.status === args.status);
        }
        const limit = Number.isFinite(args?.limit)
          ? Math.max(1, Math.floor(args.limit))
          : rows.length;
        return rows.slice(0, limit);
      },
      exportOperations: async (args: any = {}) => ({
        operations: await (window as any).ade.history.listOperations(args),
      }),
    },
    layout: {
      get: resolvedArg(null),
      set: resolvedArg2(undefined),
    },
    tilingTree: {
      get: resolvedArg(null),
      set: resolvedArg2(undefined),
    },
    graphState: {
      get: resolvedArg(null),
      set: resolvedArg2(undefined),
    },
    tests: {
      listSuites: resolved([]),
      run: resolvedArg({}),
      stop: resolvedArg(undefined),
      listRuns: resolved([]),
      getLogTail: resolvedArg(""),
      onEvent: noop,
    },
    projectConfig: {
      get: resolved(BROWSER_MOCK_PROJECT_CONFIG_SNAPSHOT),
      validate: resolvedArg({ ok: true, issues: [] as any[] }),
      save: resolvedArg(BROWSER_MOCK_PROJECT_CONFIG_SNAPSHOT),
      diffAgainstDisk: resolved({ changed: false } as any),
      confirmTrust: resolved({
        sharedHash: "mock",
        localHash: "mock",
        approvedSharedHash: null,
        requiresSharedTrust: false,
      } as any),
    },
    adeCli: {
      getStatus: resolved({
        command: "ade",
        platform: "darwin",
        isPackaged: false,
        bundledAvailable: true,
        bundledBinDir: "/tmp/mock/ADE/apps/ade-cli/bin",
        bundledCommandPath: "/tmp/mock/ADE/apps/ade-cli/bin/ade",
        installerPath: null,
        agentPathReady: true,
        terminalInstalled: false,
        terminalCommandPath: null,
        installAvailable: false,
        installTargetPath: "~/.local/bin/ade",
        installTargetDirOnPath: false,
        message:
          "ADE-launched agents can use ade. Terminal access is not installed yet.",
        nextAction: "Run npm link in apps/ade-cli for local development.",
      }),
      installForUser: resolved({
        ok: false,
        message: "Terminal install is available from packaged ADE builds.",
        status: {
          command: "ade",
          platform: "darwin",
          isPackaged: false,
          bundledAvailable: true,
          bundledBinDir: "/tmp/mock/ADE/apps/ade-cli/bin",
          bundledCommandPath: "/tmp/mock/ADE/apps/ade-cli/bin/ade",
          installerPath: null,
          agentPathReady: true,
          terminalInstalled: false,
          terminalCommandPath: null,
          installAvailable: false,
          installTargetPath: "~/.local/bin/ade",
          installTargetDirOnPath: false,
          message:
            "ADE-launched agents can use ade. Terminal access is not installed yet.",
          nextAction: "Run npm link in apps/ade-cli for local development.",
        },
      }),
    },
    orchestration: {
      runCreate: resolvedArg({ runId: MOCK_ORCH_RUN_ID, manifest: MOCK_ORCH_MANIFEST, etag: MOCK_ORCH_MANIFEST.etag }),
      bundleRead: resolvedArg({ manifest: MOCK_ORCH_MANIFEST, planMd: MOCK_ORCH_PLAN_MD, etag: MOCK_ORCH_MANIFEST.etag }),
      manifestReadSection: async (args: any) => ({ section: args?.section ?? "tasks", data: (MOCK_ORCH_MANIFEST as any)[args?.section ?? "tasks"] ?? [], etag: MOCK_ORCH_MANIFEST.etag }),
      manifestPatch: resolvedArg({ ok: true, manifest: MOCK_ORCH_MANIFEST, etag: MOCK_ORCH_MANIFEST.etag }),
      planAppend: resolvedArg({ etag: MOCK_ORCH_MANIFEST.etag }),
      planWrite: resolvedArg({ etag: MOCK_ORCH_MANIFEST.etag }),
      spawnAgent: resolvedArg({ sessionId: "mock-orch-spawn-new", manifest: MOCK_ORCH_MANIFEST, etag: MOCK_ORCH_MANIFEST.etag }),
      agentInject: resolvedArg({ ok: true }),
      assetRegister: resolvedArg({ manifest: MOCK_ORCH_MANIFEST, etag: MOCK_ORCH_MANIFEST.etag }),
      claimTask: resolvedArg({ ok: true, manifest: MOCK_ORCH_MANIFEST, etag: MOCK_ORCH_MANIFEST.etag }),
      releaseTask: resolvedArg({ ok: true, manifest: MOCK_ORCH_MANIFEST, etag: MOCK_ORCH_MANIFEST.etag }),
      runList: resolvedArg([{
        runId: MOCK_ORCH_RUN_ID, laneId: "lane-main", title: MOCK_ORCH_MANIFEST.title, goalSummary: MOCK_ORCH_MANIFEST.goalSummary,
        currentPhase: "developing", etag: MOCK_ORCH_MANIFEST.etag, createdAt: MOCK_ORCH_MANIFEST.createdAt, updatedAt: MOCK_ORCH_MANIFEST.updatedAt,
        status: "active", agentCount: MOCK_ORCH_MANIFEST.agents.length, taskCount: MOCK_ORCH_MANIFEST.tasks.length,
      }]),
      subscribe: (_args: any, _cb: any) => () => {},
      assetDataUrl: resolvedArg({ dataUrl: "data:text/html;base64,PGgxPkRhc2hib2FyZCBXaXJlZnJhbWU8L2gxPg==", mimeType: "text/html", text: "<h1>Dashboard Wireframe</h1><p>Mock wireframe preview</p>" }),
    },
    zoom: {
      getLevel: () => 0,
      setLevel: (_level: number) => {},
      getFactor: () => 1,
      onCommand: () => () => {},
    },
    updateCheckForUpdates: resolved(undefined),
    updateGetState: resolved({
      status: "idle",
      currentVersion: "0.0.0",
      latestKnownVersion: null,
      version: null,
      progressPercent: null,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      releaseNotesUrl: null,
      error: null,
      errorDetails: null,
      recentlyInstalled: null,
      parked: null,
      autoApplyPending: null,
      autoApplySuppressedUntil: null,
    }),
    updateGetInstallImpact: resolved({ connectedPhones: [] }),
    updateQuitAndInstall: resolved(true),
    updateCancelAutoApply: resolved(false),
    updateDismissInstalledNotice: resolved(undefined),
    onUpdateEvent: noop,
  };
  void attachBrowserRuntimeBridge();
} // window
