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
 * Optional: generate `browser-mock-ade-snapshot.generated.json` with
 *   npm run export:browser-mock-ade
 * to mirror the current project’s `.ade/ade.db` snapshot. Exported lanes, PRs,
 * queue/rebase/history/session/process rows replace the built-in demo data so
 * browser-only UI work follows the same local state as the desktop app.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDefaultModelDescriptor } from "../shared/modelRegistry";

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
  getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.5-codex";
const DEFAULT_BROWSER_MOCK_CLAUDE_MODEL =
  getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-4-6";

const BUILTIN_MOCK_PROJECT = {
  id: "browser-mock",
  name: "Browser Preview",
  rootPath: "/tmp/mock",
  gitRemoteUrl: "https://github.com/acme/ade",
  gitDefaultBranch: "main",
  createdAt: new Date().toISOString(),
};

const adeDbSnapshotByPath = import.meta.glob<any>("./browser-mock-ade-snapshot.generated.json", {
  eager: true,
  import: "default",
});

const ADE_DB_SNAPSHOT = adeDbSnapshotByPath["./browser-mock-ade-snapshot.generated.json"] ?? null;
const USE_ADE_DB_SNAPSHOT = Boolean(ADE_DB_SNAPSHOT?.project);

const MOCK_PROJECT = USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.project
  ? {
      ...BUILTIN_MOCK_PROJECT,
      id: ADE_DB_SNAPSHOT.project.id,
      name: ADE_DB_SNAPSHOT.project.name,
      rootPath: ADE_DB_SNAPSHOT.project.rootPath,
      gitDefaultBranch: ADE_DB_SNAPSHOT.project.gitDefaultBranch ?? BUILTIN_MOCK_PROJECT.gitDefaultBranch,
      createdAt: ADE_DB_SNAPSHOT.project.createdAt ?? BUILTIN_MOCK_PROJECT.createdAt,
    }
  : BUILTIN_MOCK_PROJECT;

// ── Timestamps ────────────────────────────────────────────────
const now = new Date().toISOString();

/** Browser mock lane health; matches `LaneHealthCheck` in shared types. */
function mockBrowserLaneHealth(laneId: string) {
  return {
    laneId,
    status: "unknown" as const,
    processAlive: false,
    portResponding: false,
    respondingPort: null as number | null,
    proxyRouteActive: false,
    fallbackMode: false,
    lastCheckedAt: now,
    issues: [] as Array<{
      type: "process-dead" | "port-unresponsive" | "proxy-route-missing" | "port-conflict" | "env-init-failed";
      message: string;
      actionLabel?: string;
      actionType?: "reassign-port" | "restart-proxy" | "reinit-env" | "enable-fallback" | "refresh-preview";
    }>,
  };
}

const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
const yesterday = new Date(Date.now() - 86400000).toISOString();
const twoDaysAgo = new Date(Date.now() - 172800000).toISOString();
const threeDaysAgo = new Date(Date.now() - 259200000).toISOString();
const fourHoursFromNow = new Date(Date.now() + 4 * 3600000).toISOString();

function createMockMemoryHealthStats(overrides: Partial<any> = {}): any {
  return {
    scopes: [
      {
        scope: "project",
        current: 0,
        max: 2000,
        counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 },
      },
      {
        scope: "agent",
        current: 0,
        max: 500,
        counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 },
      },
      {
        scope: "mission",
        current: 0,
        max: 200,
        counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 },
      },
    ],
    lastSweep: null,
    lastConsolidation: null,
    embeddings: {
      entriesEmbedded: 0,
      entriesTotal: 0,
      queueDepth: 0,
      processing: false,
      lastBatchProcessedAt: null,
      cacheEntries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
      model: {
        modelId: "Xenova/all-MiniLM-L6-v2",
        state: "idle",
        activity: "idle",
        installState: "missing",
        cacheDir: "/tmp/mock-transformers-cache",
        installPath: "/tmp/mock-transformers-cache/Xenova/all-MiniLM-L6-v2",
        progress: null,
        loaded: null,
        total: null,
        file: null,
        error: null,
      },
    },
    ...overrides,
  };
}

function createMockSweepResult(overrides: Partial<any> = {}): any {
  return {
    sweepId: "browser-mock-sweep",
    projectId: MOCK_PROJECT.id,
    reason: "manual",
    startedAt: now,
    completedAt: now,
    halfLifeDays: 30,
    entriesDecayed: 0,
    entriesDemoted: 0,
    entriesPromoted: 0,
    entriesArchived: 0,
    entriesOrphaned: 0,
    durationMs: 0,
    ...overrides,
  };
}

function createMockConsolidationResult(overrides: Partial<any> = {}): any {
  return {
    consolidationId: "browser-mock-consolidation",
    projectId: MOCK_PROJECT.id,
    reason: "manual",
    startedAt: now,
    completedAt: now,
    clustersFound: 0,
    entriesMerged: 0,
    entriesCreated: 0,
    tokensUsed: 0,
    durationMs: 0,
    ...overrides,
  };
}

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
        raw.laneType === "primary" || raw.laneType === "worktree" || raw.laneType === "attached"
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
      missionId: raw.missionId ?? null,
      laneRole: raw.laneRole ?? null,
      createdAt: raw.createdAt ?? now,
      archivedAt: raw.archivedAt ?? null,
    };
  });
}

const MOCK_LANES: any[] = USE_ADE_DB_SNAPSHOT
  ? buildMockLanesFromAdeSnapshot(Array.isArray(ADE_DB_SNAPSHOT?.lanes) ? ADE_DB_SNAPSHOT.lanes : [])
  : BUILTIN_MOCK_LANES;

const ADE_DB_PR_SNAPSHOTS: any[] = USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.prSnapshots)
  ? ADE_DB_SNAPSHOT.prSnapshots
  : [];
const ADE_DB_PR_SNAPSHOT_BY_ID = new Map<string, any>(
  ADE_DB_PR_SNAPSHOTS.map((snapshot) => [String(snapshot.prId), snapshot]),
);
const ADE_DB_OPERATIONS: any[] = USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.operations)
  ? ADE_DB_SNAPSHOT.operations
  : [];
const ADE_DB_SESSIONS: any[] = USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.sessions)
  ? ADE_DB_SNAPSHOT.sessions
  : [];
const ADE_DB_CHAT_TRANSCRIPTS: Record<string, { events?: any[]; path?: string | null }> =
  USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.chatTranscripts && typeof ADE_DB_SNAPSHOT.chatTranscripts === "object"
    ? ADE_DB_SNAPSHOT.chatTranscripts
    : {};
const ADE_DB_PROCESS_DEFINITIONS: any[] = USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.processDefinitions)
  ? ADE_DB_SNAPSHOT.processDefinitions
  : [];
const ADE_DB_PROCESS_RUNTIME: any[] = USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.processRuntime)
  ? ADE_DB_SNAPSHOT.processRuntime
  : [];
const ADE_DB_AUTOMATIONS = USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.automations
  ? ADE_DB_SNAPSHOT.automations
  : null;

function isMockChatToolType(toolType: unknown): boolean {
  const normalized = String(toolType ?? "").trim().toLowerCase();
  return Boolean(
    normalized
      && (
        normalized === "codex-chat"
        || normalized === "claude-chat"
        || normalized === "opencode-chat"
        || normalized === "cursor"
        || normalized.endsWith("-chat")
      ),
  );
}

function inferMockChatProvider(session: any): "claude" | "codex" | "cursor" | "opencode" {
  const metadataProvider = String(session?.resumeMetadata?.provider ?? "").trim().toLowerCase();
  if (metadataProvider === "claude" || metadataProvider === "codex" || metadataProvider === "cursor" || metadataProvider === "opencode") {
    return metadataProvider;
  }
  const toolType = String(session?.toolType ?? "").trim().toLowerCase();
  if (toolType.startsWith("claude")) return "claude";
  if (toolType.startsWith("codex")) return "codex";
  if (toolType === "cursor" || toolType.startsWith("cursor")) return "cursor";
  return "opencode";
}

function getMockChatTranscriptEvents(sessionId: string): any[] {
  const events = ADE_DB_CHAT_TRANSCRIPTS[sessionId]?.events;
  return Array.isArray(events) ? events.filter((entry) => entry?.sessionId === sessionId && entry?.event) : [];
}

function latestMockDoneEvent(events: any[]): any | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "done") return event;
  }
  return null;
}

function fallbackMockModelForProvider(provider: "claude" | "codex" | "cursor" | "opencode"): string {
  if (provider === "claude") return "sonnet";
  if (provider === "codex") return DEFAULT_BROWSER_MOCK_CODEX_MODEL;
  if (provider === "cursor") return "auto";
  return "opencode/mock";
}

function fallbackMockModelIdForProvider(provider: "claude" | "codex" | "cursor" | "opencode"): string {
  if (provider === "claude") return DEFAULT_BROWSER_MOCK_CLAUDE_MODEL;
  if (provider === "codex") return DEFAULT_BROWSER_MOCK_CODEX_MODEL;
  if (provider === "cursor") return "cursor/auto";
  return "opencode/mock";
}

function mockAgentChatSummaryFromSession(session: any): any | null {
  if (!session || !isMockChatToolType(session.toolType)) return null;
  const provider = inferMockChatProvider(session);
  const events = getMockChatTranscriptEvents(String(session.id));
  const done = latestMockDoneEvent(events);
  const modelId = String(
    session.resumeMetadata?.modelId
      ?? session.resumeMetadata?.launch?.modelId
      ?? done?.modelId
      ?? fallbackMockModelIdForProvider(provider),
  );
  const model = String(
    session.resumeMetadata?.model
      ?? session.resumeMetadata?.launch?.model
      ?? done?.model
      ?? fallbackMockModelForProvider(provider),
  );
  const endedAt = session.endedAt ?? null;
  const lastActivityAt = session.lastActivityAt ?? session.endedAt ?? session.startedAt ?? now;
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
    executionMode: session.resumeMetadata?.executionMode ?? null,
    permissionMode: session.resumeMetadata?.permissionMode ?? null,
    interactionMode: session.resumeMetadata?.interactionMode ?? null,
    claudePermissionMode: session.resumeMetadata?.claudePermissionMode ?? undefined,
    codexApprovalPolicy: session.resumeMetadata?.codexApprovalPolicy ?? undefined,
    codexSandbox: session.resumeMetadata?.codexSandbox ?? undefined,
    codexConfigSource: session.resumeMetadata?.codexConfigSource ?? undefined,
    opencodePermissionMode: session.resumeMetadata?.opencodePermissionMode ?? undefined,
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
  };
}

function listMockAgentChatSummaries(args: any = {}): any[] {
  let rows = ADE_DB_SESSIONS
    .map(mockAgentChatSummaryFromSession)
    .filter((session): session is any => Boolean(session));
  if (typeof args?.laneId === "string" && args.laneId.trim()) {
    rows = rows.filter((session) => session.laneId === args.laneId.trim());
  }
  if (!args?.includeAutomation) {
    rows = rows.filter((session) => session.surface !== "automation");
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
  ? (Array.isArray(ADE_DB_SNAPSHOT?.prs) ? ADE_DB_SNAPSHOT.prs : [])
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

const MOCK_CONVERGENCE_RUNTIME: Record<string, any> = {};

function createDefaultConvergenceRuntime(prId: string) {
  const nowIso = new Date().toISOString();
  return {
    prId,
    autoConvergeEnabled: false,
    status: "idle",
    pollerStatus: "idle",
    currentRound: 0,
    activeSessionId: null,
    activeLaneId: null,
    activeHref: null,
    pauseReason: null,
    errorMessage: null,
    lastStartedAt: null,
    lastPolledAt: null,
    lastPausedAt: null,
    lastStoppedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

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
  ? (Array.isArray(ADE_DB_SNAPSHOT?.rebaseNeeds) ? ADE_DB_SNAPSHOT.rebaseNeeds : [])
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
      resolverModel: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "medium",
      permissionMode: "guarded_edit",
      confidenceThreshold: null,
      originSurface: "queue",
      originMissionId: null,
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
      resolverModel: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "medium",
      permissionMode: "guarded_edit",
      confidenceThreshold: null,
      originSurface: "queue",
      originMissionId: null,
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
      (Array.isArray(ADE_DB_SNAPSHOT?.queueStates) ? ADE_DB_SNAPSHOT.queueStates : []).flatMap(
        (state: any) => {
          const keys = [state?.groupId, state?.queueId].filter(Boolean).map(String);
          return keys.map((key) => [key, state]);
        },
      ),
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
  ? (Array.isArray(ADE_DB_SNAPSHOT?.integrationWorkflows) ? ADE_DB_SNAPSHOT.integrationWorkflows : [])
  : BUILTIN_MOCK_INTEGRATION_WORKFLOWS;

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

const MOCK_GITHUB_SNAPSHOT: any = USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.githubSnapshot
  ? ADE_DB_SNAPSHOT.githubSnapshot
  : BUILTIN_MOCK_GITHUB_SNAPSHOT;

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
  return !(w.ade && !w.__adeBrowserMock && typeof w.ade.sync?.getStatus === "function");
}

if (typeof window !== "undefined" && shouldInstallBrowserMock(window)) {
  const w = window as any;
  if (w.ade) {
    console.warn("[ADE] Re-applying full window.ade browser mock (e.g. Vite HMR).");
  } else {
    console.warn(
      "[ADE] Running outside Electron — injecting browser mock for window.ade",
    );
  }
  w.__adeBrowserMock = true;
  const sharedMemoryHealthStats = createMockMemoryHealthStats();
  const resolveDownloadedMemoryHealthStats = async () => {
    sharedMemoryHealthStats.embeddings = {
      ...sharedMemoryHealthStats.embeddings,
      model: {
        ...sharedMemoryHealthStats.embeddings.model,
        state: "ready",
        activity: "ready",
        installState: "installed",
        progress: 100,
        loaded: 1,
        total: 1,
        file: "/tmp/mock-model.onnx",
        error: null,
      },
    };
    return sharedMemoryHealthStats;
  };

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
    provider: "claude" | "codex" | "cursor",
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
    availableProviders: { claude: false, codex: false, cursor: false },
    models: { claude: [], codex: [], cursor: [] },
    features: [],
    providerConnections: {
      claude: BROWSER_MOCK_PROVIDER_CONNECTION("claude"),
      codex: BROWSER_MOCK_PROVIDER_CONNECTION("codex"),
      cursor: BROWSER_MOCK_PROVIDER_CONNECTION("cursor"),
    },
  };

  const BROWSER_MOCK_TOUR_PROGRESS: any = {
    wizardCompletedAt: now,
    wizardDismissedAt: null,
    tours: {},
    tourVariants: {},
    glossaryTermsSeen: [],
    tutorial: {
      completedAt: null,
      dismissedAt: null,
      silenced: false,
      inProgress: false,
      lastActIndex: 0,
      ctxSnapshot: {},
    },
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
    extraUsage: [],
    lastPolledAt: now,
    errors: [],
  };
  const BROWSER_USAGE_SNAPSHOT: any = USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.usageSnapshot
    ? ADE_DB_SNAPSHOT.usageSnapshot
    : BROWSER_MOCK_USAGE_SNAPSHOT;

  const BROWSER_MOCK_BUDGET_CONFIG: any = {
    refreshIntervalMin: 15,
    budgetCaps: [] as any[],
    preset: "conservative",
  };

  /** Full enough for Settings, lane behavior, and Missions `applyMissionSettingsSnapshot` in the dev browser. */
  const BROWSER_MOCK_PROJECT_CONFIG_SNAPSHOT: any = {
    shared: {
      version: 1,
      processes: ADE_DB_PROCESS_DEFINITIONS,
      stackButtons: [],
      processGroups: [],
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
    },
    local: {
      version: 1,
      processes: ADE_DB_PROCESS_DEFINITIONS,
      stackButtons: [],
      processGroups: [],
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
      git: { autoRebaseOnHeadChange: false },
      laneCleanup: {},
      ai: {
        orchestrator: {
          defaultOrchestratorModel: { modelId: "anthropic/claude-sonnet-4-6" },
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
      processes: ADE_DB_PROCESS_DEFINITIONS,
      stackButtons: [],
      processGroups: [],
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
      git: { autoRebaseOnHeadChange: false },
      ai: {
        orchestrator: {
          defaultOrchestratorModel: { modelId: "anthropic/claude-sonnet-4-6" },
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

  const BROWSER_MOCK_MISSION_DASHBOARD: any = {
    active: [],
    recent: [],
    weekly: {
      missions: 0,
      successRate: 0,
      avgDurationMs: 0,
      totalCostUsd: 0,
    },
  };
  const BROWSER_MISSION_DASHBOARD: any = USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.missionDashboard
    ? ADE_DB_SNAPSHOT.missionDashboard
    : BROWSER_MOCK_MISSION_DASHBOARD;

  const BROWSER_MOCK_EMPTY_FULL_MISSION_VIEW: any = {
    mission: null,
    runGraph: null,
    artifacts: [],
    checkpoints: [],
    dashboard: null,
  };

  const BROWSER_MOCK_PHASE_PROFILE: any = {
    id: "mock-profile",
    name: "Mock profile",
    description: "Browser mock phase profile",
    phases: [] as any[],
    isBuiltIn: true,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
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

  const BROWSER_MOCK_APNS_STATUS: any = {
    enabled: false,
    configured: false,
    keyStored: false,
    keyId: null,
    teamId: null,
    bundleId: null,
    env: "sandbox" as const,
  };

  (window as any).ade = {
    app: {
      ping: resolved("pong" as const),
      getInfo: resolved({
        appVersion: "0.0.0-browser",
        isPackaged: false,
        platform: "browser",
        arch: "web",
        versions: {
          electron: "0.0.0-browser",
          chrome: "0.0.0-browser",
          node: "0.0.0-browser",
          v8: "0.0.0-browser",
        },
        env: {},
      }),
      getProject: resolved(MOCK_PROJECT),
      onProjectChanged: () => () => {},
      openExternal: resolvedArg(undefined),
      revealPath: resolvedArg(undefined),
      writeClipboardText: resolvedArg(undefined),
      getImageDataUrl: resolvedArg({ dataUrl: "" }),
      writeClipboardImage: resolvedArg(undefined),
      openPath: resolvedArg(undefined),
      openPathInEditor: resolvedArg(undefined),
      logDebugEvent: () => {},
    },
    project: {
      openRepo: resolved(MOCK_PROJECT),
      chooseDirectory: resolvedArg(null),
      browseDirectories: async (args?: { inputPath?: string }) => {
        const inputPath =
          typeof args?.inputPath === "string" && args.inputPath.trim().length > 0
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
      closeCurrent: resolved(undefined),
      resolveIcon: resolvedArg({ dataUrl: null, sourcePath: null, mimeType: null }),
      chooseIcon: resolvedArg(null),
      removeIcon: resolvedArg({ dataUrl: null, sourcePath: null, mimeType: null }),
      switchToPath: resolvedArg(MOCK_PROJECT),
      forgetRecent: resolvedArg([]),
      reorderRecent: resolvedArg([]),
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
    keybindings: {
      get: resolved({ definitions: [], overrides: [] }),
      set: resolvedArg({ definitions: [], overrides: [] }),
    },
    sync: {
      getStatus: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
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
      clearPin: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
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
    },
    agentTools: {
      detect: resolved([]),
    },
    notifications: {
      apns: {
        getStatus: resolved(BROWSER_MOCK_APNS_STATUS),
        saveConfig: resolvedArg({ ...BROWSER_MOCK_APNS_STATUS }),
        uploadKey: resolvedArg({ ...BROWSER_MOCK_APNS_STATUS }),
        clearKey: resolved(BROWSER_MOCK_APNS_STATUS),
        sendTestPush: resolvedArg({ ok: false, reason: "browser mock" }),
      },
    },
    devTools: {
      detect: resolved(BROWSER_MOCK_DEVTOOLS_CHECK),
    },
    usage: {
      getSnapshot: resolved(BROWSER_USAGE_SNAPSHOT),
      refresh: resolved(BROWSER_USAGE_SNAPSHOT),
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
      getTourProgress: resolved(BROWSER_MOCK_TOUR_PROGRESS),
      markWizardCompleted: resolved(BROWSER_MOCK_TOUR_PROGRESS),
      markWizardDismissed: resolved(BROWSER_MOCK_TOUR_PROGRESS),
      markTourCompleted: resolvedArg(BROWSER_MOCK_TOUR_PROGRESS),
      markTourDismissed: resolvedArg(BROWSER_MOCK_TOUR_PROGRESS),
      updateTourStep: resolvedArg2(BROWSER_MOCK_TOUR_PROGRESS),
      markGlossaryTermSeen: resolvedArg(BROWSER_MOCK_TOUR_PROGRESS),
      resetTourProgress: resolvedArg(BROWSER_MOCK_TOUR_PROGRESS),
      markTourCompletedVariant: resolvedArg2(BROWSER_MOCK_TOUR_PROGRESS),
      markTourDismissedVariant: resolvedArg2(BROWSER_MOCK_TOUR_PROGRESS),
      updateTourStepVariant: async (_a: any, _b: any, _c: any) => BROWSER_MOCK_TOUR_PROGRESS,
      tutorial: {
        start: resolved(BROWSER_MOCK_TOUR_PROGRESS),
        dismiss: resolvedArg(BROWSER_MOCK_TOUR_PROGRESS),
        complete: resolved(BROWSER_MOCK_TOUR_PROGRESS),
        updateAct: resolvedArg2(BROWSER_MOCK_TOUR_PROGRESS),
        setSilenced: resolvedArg(BROWSER_MOCK_TOUR_PROGRESS),
        clearSessionDismissal: resolved(BROWSER_MOCK_TOUR_PROGRESS),
        shouldPrompt: resolved(false),
      },
    },
    automations: {
      list: resolved(USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.rules) ? ADE_DB_AUTOMATIONS.rules : [
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
            orchestratorModel: {
              modelId: "anthropic/claude-sonnet-4-6",
              thinkingLevel: "medium",
            },
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
          toolPalette: ["repo", "git", "github", "memory", "mission"],
          contextSources: [
            { type: "project-memory" },
            { type: "automation-memory" },
          ],
          memory: { mode: "automation-plus-project" },
          guardrails: {},
          outputs: { disposition: "comment-only", createArtifact: true },
          verification: { verifyBeforePublish: false, mode: "intervention" },
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
      ]),
      toggle: resolvedArg([]),
      triggerManually: resolvedArg({
        id: "run-1",
        automationId: "auto-session-review",
        chatSessionId: "chat-auto-1",
        missionId: null,
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
      getHistory: resolvedArg(USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.runs) ? ADE_DB_AUTOMATIONS.runs : [
        {
          id: "run-1",
          automationId: "auto-session-review",
          chatSessionId: "chat-auto-1",
          missionId: null,
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
      ]),
      getRunDetail: resolvedArg({
        run: {
          id: "run-1",
          automationId: "auto-session-review",
          chatSessionId: "chat-auto-1",
          missionId: null,
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
          model: "Claude Sonnet 4.6",
          modelId: "anthropic/claude-sonnet-4-6",
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
        procedureFeedback: [
          {
            procedureId: "pr-review",
            outcome: "observation",
            reason: "Captured a concise PR follow-up summary.",
          },
        ],
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
      listRuns: resolvedArg(USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.runs) ? ADE_DB_AUTOMATIONS.runs : [
        {
          id: "run-1",
          automationId: "auto-session-review",
          chatSessionId: "chat-auto-1",
          missionId: null,
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
      ]),
      getIngressStatus: resolved({
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
          port: 4319,
          lastDeliveryAt: now,
          lastError: null,
        },
      }),
      listIngressEvents: resolvedArg(USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.ingressEvents) ? ADE_DB_AUTOMATIONS.ingressEvents : [
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
      ]),
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
          toolPalette: ["repo", "memory", "mission"],
          contextSources: [{ type: "project-memory" }],
          memory: { mode: "automation-plus-project" },
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
          MOCK_LANES.map((lane) => [lane.id, [
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
          ]]),
        ),
        recommendedModelId: DEFAULT_BROWSER_MOCK_CODEX_MODEL,
      }),
      listRuns: resolvedArg([
        {
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
            budgets: { maxFiles: 60, maxDiffChars: 180000, maxPromptChars: 220000, maxFindings: 12 },
            publishBehavior: "local_only",
          },
          targetLabel: "feature/auth-flow vs main",
          compareTarget: { kind: "default_branch", label: "main", ref: "main", laneId: null, branchRef: "main" },
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
          budgets: { maxFiles: 60, maxDiffChars: 180000, maxPromptChars: 220000, maxFindings: 12 },
          publishBehavior: "local_only",
        },
        targetLabel: "feature/auth-flow vs main",
        compareTarget: { kind: "default_branch", label: "main", ref: "main", laneId: null, branchRef: "main" },
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
                summary: "Session write happens before token exchange success is confirmed.",
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
            contentText: "diff --git a/src/auth/oauth.ts b/src/auth/oauth.ts\n@@ ...",
            metadata: null,
            createdAt: now,
          },
        ],
        publications: [],
        chatSession: {
          sessionId: "chat-review-1",
          laneId: MOCK_LANES[1]?.id ?? "lane-auth",
          provider: "codex",
          model: "GPT-5.4 Codex",
          modelId: DEFAULT_BROWSER_MOCK_CODEX_MODEL,
          title: "Review: feature/auth-flow vs main",
          surface: "automation",
          automationId: null,
          automationRunId: null,
          status: "idle",
          startedAt: yesterday,
          endedAt: now,
          lastActivityAt: now,
          lastOutputPreview: "Found two actionable risks in the auth flow changes.",
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
          budgets: { maxFiles: 60, maxDiffChars: 180000, maxPromptChars: 220000, maxFindings: 12 },
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
          budgets: { maxFiles: 60, maxDiffChars: 180000, maxPromptChars: 220000, maxFindings: 12 },
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
          { findingClass: "incomplete_rollout" as const, total: 5, addressed: 3 },
          { findingClass: "late_stage_regression" as const, total: 2, addressed: 1 },
        ],
      }),
      onEvent: noop,
    },
    actions: {
      listRegistry: resolved([]),
    },
    missions: {
      list: async (args: any = {}) => {
        const rows = USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.missions)
          ? ADE_DB_SNAPSHOT.missions
          : [];
        const status = typeof args?.status === "string" ? args.status : null;
        const laneId = typeof args?.laneId === "string" ? args.laneId : null;
        const includeArchived = args?.includeArchived === true;
        const activeStatuses = new Set(["queued", "planning", "plan_review", "in_progress", "intervention_required"]);
        let filtered = rows;
        if (!includeArchived) filtered = filtered.filter((mission: any) => !mission.archivedAt);
        if (laneId) filtered = filtered.filter((mission: any) => mission.laneId === laneId);
        if (status === "active") {
          filtered = filtered.filter((mission: any) => activeStatuses.has(mission.status));
        } else if (status === "in_progress") {
          filtered = filtered.filter((mission: any) => mission.status === "in_progress" || mission.status === "plan_review");
        } else if (status) {
          filtered = filtered.filter((mission: any) => mission.status === status);
        }
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.floor(args.limit)) : filtered.length;
        return filtered.slice(0, limit);
      },
      get: async (missionId: string) => {
        const rows = USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.missions)
          ? ADE_DB_SNAPSHOT.missions
          : [];
        return rows.find((mission: any) => mission.id === missionId) ?? null;
      },
      create: resolvedArg({ id: "mock" }),
      update: resolvedArg({ id: "mock" }),
      archive: resolvedArg(undefined),
      delete: resolvedArg(undefined),
      updateStep: resolvedArg({ id: "mock" }),
      addArtifact: resolvedArg({ id: "mock" }),
      addIntervention: resolvedArg({ id: "mock" }),
      resolveIntervention: resolvedArg({ id: "mock" }),
      listPhaseItems: resolved([]),
      savePhaseItem: resolvedArg({} as any),
      deletePhaseItem: resolvedArg(undefined),
      importPhaseItems: resolvedArg([]),
      exportPhaseItems: resolvedArg({ items: [], savedPath: null }),
      listPhaseProfiles: resolved([]),
      savePhaseProfile: resolvedArg({
        ...BROWSER_MOCK_PHASE_PROFILE,
        id: "mock-profile-saved",
        name: "Saved profile",
      } as any),
      deletePhaseProfile: resolvedArg(undefined),
      clonePhaseProfile: resolvedArg({
        ...BROWSER_MOCK_PHASE_PROFILE,
        id: "mock-profile-clone",
        isBuiltIn: false,
        isDefault: false,
        name: "Cloned profile",
      } as any),
      exportPhaseProfile: resolvedArg({
        profile: BROWSER_MOCK_PHASE_PROFILE,
        savedPath: null,
      } as any),
      importPhaseProfile: resolvedArg({
        ...BROWSER_MOCK_PHASE_PROFILE,
        id: "mock-profile-imported",
        isBuiltIn: false,
        isDefault: false,
        name: "Imported profile",
      } as any),
      getPhaseConfiguration: resolvedArg(null),
      getDashboard: resolved(BROWSER_MISSION_DASHBOARD),
      getFullMissionView: async (missionId: string) =>
        (USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.missionFullViews?.[missionId])
          ? ADE_DB_SNAPSHOT.missionFullViews[missionId]
          : BROWSER_MOCK_EMPTY_FULL_MISSION_VIEW,
      preflight: resolvedArg({
        canLaunch: true,
        checkedAt: now,
        profileName: null,
        selectedPhaseCount: 0,
        hardFailures: 0,
        warnings: 0,
        checklist: [] as any[],
        budgetEstimate: null,
      } as any),
      getRunView: resolvedArg(null),
      subscribeRunView: () => () => {},
      onEvent: noop,
    },
    orchestrator: {
      listRuns: resolved([]),
      getRunGraph: resolvedArg({ nodes: [], edges: [] }),
      startRun: resolvedArg({ run: {}, steps: [] }),
      startRunFromMission: resolvedArg({ run: {}, steps: [] }),
      startAttempt: resolvedArg({}),
      completeAttempt: resolvedArg({}),
      tickRun: resolvedArg({}),
      resumeRun: resolvedArg({}),
      cancelRun: resolvedArg({}),
      cleanupTeamResources: resolvedArg({
        missionId: "mock",
        runId: null,
        laneIds: [],
        lanesArchived: [],
        lanesSkipped: [],
        laneErrors: [],
      }),
      heartbeatClaims: resolvedArg(0),
      listTimeline: resolvedArg([]),
      getGateReport: resolved({}),
      getWorkerStates: resolvedArg([]),
      startMissionRun: resolvedArg({}),
      steerMission: resolvedArg({}),
      getTeamMembers: async (args: { runId?: string } = {}) => {
        const runId =
          typeof args.runId === "string" && args.runId.trim().length > 0
            ? args.runId.trim()
            : "mock-run";
        const missionId = "mock-mission";
        const nowIso = new Date().toISOString();
        return [
          {
            id: "coordinator",
            runId,
            missionId,
            provider: "claude",
            model: "anthropic/claude-sonnet-4-6",
            role: "coordinator",
            source: "ade-worker",
            parentWorkerId: null,
            sessionId: "session-coordinator",
            status: "active",
            claimedTaskIds: ["plan_phase"],
            metadata: { teamRole: "coordinator", source: "ade-worker" },
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: "implement-api",
            runId,
            missionId,
            provider: "codex",
            model: DEFAULT_BROWSER_MOCK_CODEX_MODEL,
            role: "worker",
            source: "ade-worker",
            parentWorkerId: null,
            sessionId: "session-impl-api",
            status: "active",
            claimedTaskIds: ["api_step"],
            metadata: { teamRole: "implementer", source: "ade-worker" },
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: "api-tests",
            runId,
            missionId,
            provider: "claude",
            model: "anthropic/claude-3-5-haiku",
            role: "teammate",
            source: "ade-subagent",
            parentWorkerId: "implement-api",
            sessionId: "session-api-tests",
            status: "idle",
            claimedTaskIds: [],
            metadata: {
              teamRole: "validator",
              source: "ade-subagent",
              parentWorkerId: "implement-api",
              isSubAgent: true,
            },
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          {
            id: "native-reviewer",
            runId,
            missionId,
            provider: "claude",
            model: "anthropic/claude-sonnet-4-6",
            role: "teammate",
            source: "claude-native",
            parentWorkerId: "implement-api",
            sessionId: "session-native-reviewer",
            status: "active",
            claimedTaskIds: [],
            metadata: {
              source: "claude-native",
              parentWorkerId: "implement-api",
              teamRole: "specialist",
            },
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ];
      },
      listArtifacts: resolvedArg([]),
      listWorkerCheckpoints: resolvedArg([]),
      getPromptInspector: resolvedArg({
        target: "coordinator",
        runId: "mock-run",
        missionId: "mock-mission",
        stepId: null,
        phaseKey: null,
        phaseName: null,
        title: "Mock prompt inspector",
        notes: [],
        layers: [],
        fullPrompt: "",
      }),
      getTeamRuntimeState: resolvedArg(null),
      finalizeRun: resolvedArg({ success: true, blockers: [] }),
      getModelCapabilities: resolved({ models: [] }),
      sendChat: resolvedArg({}),
      getChat: resolvedArg([]),
      listChatThreads: resolvedArg([]),
      getThreadMessages: resolvedArg([]),
      sendThreadMessage: resolvedArg({}),
      getWorkerDigest: resolvedArg(null),
      listWorkerDigests: resolvedArg([]),
      getContextCheckpoint: resolvedArg(null),
      listLaneDecisions: resolvedArg([]),
      getMissionMetrics: resolvedArg({ config: null, samples: [] }),
      setMissionMetricsConfig: resolvedArg({}),
      getExecutionPlanPreview: resolvedArg(null),
      getMissionStateDocument: resolvedArg(null),
      getCheckpointStatus: resolvedArg(null),
      sendAgentMessage: resolvedArg({}),
      getGlobalChat: resolvedArg([]),
      getActiveAgents: resolvedArg([]),
      getMissionBudgetTelemetry: resolvedArg({
        computedAt: new Date().toISOString(),
        perProvider: [],
        dataSources: [],
      }),
      getAggregatedUsage: resolvedArg({
        totalTokens: 0,
        totalCost: 0,
        byModel: [],
      }),
      onEvent: noop,
      onThreadEvent: noop,
      onDagMutation: noop,
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
      rename: resolvedArg(undefined),
      reparent: resolvedArg({}),
      updateAppearance: resolvedArg(undefined),
      archive: resolvedArg(undefined),
      delete: resolvedArg(undefined),
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
      oauthGenerateRedirectUris: resolvedArg([{ provider: "google", uris: [] as string[], instructions: "" }]),
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
        typeof args?.laneId === "string" ? mockBrowserLaneHealth(args.laneId) : null,
      diagnosticsRunHealthCheck: async (args: { laneId: string }) =>
        mockBrowserLaneHealth(typeof args?.laneId === "string" ? args.laneId : "mock"),
      diagnosticsRunFullCheck: resolved([]),
      diagnosticsActivateFallback: resolvedArg(undefined),
      diagnosticsDeactivateFallback: resolvedArg(undefined),
      onDiagnosticsEvent: noop,
      onProxyEvent: noop,
    },
    sessions: {
      list: async (args: any = {}) => {
        let rows = ADE_DB_SESSIONS;
        if (typeof args?.laneId === "string" && args.laneId.trim()) {
          rows = rows.filter((session) => session.laneId === args.laneId.trim());
        }
        if (typeof args?.status === "string" && args.status.trim()) {
          rows = rows.filter((session) => session.status === args.status.trim());
        }
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.floor(args.limit)) : rows.length;
        return rows.slice(0, limit);
      },
      get: async (sessionId: string) =>
        ADE_DB_SESSIONS.find((session) => session.id === sessionId) ?? null,
      delete: resolvedArg(undefined),
      updateMeta: resolvedArg(null),
      readTranscriptTail: async (args: any = {}) => {
        const sessionId = String(args?.sessionId ?? "").trim();
        const lines = getMockChatTranscriptEvents(sessionId).map((entry) => JSON.stringify(entry));
        const raw = lines.join("\n");
        const maxBytes = Number.isFinite(args?.maxBytes) ? Math.max(0, Math.floor(args.maxBytes)) : raw.length;
        return raw.length > maxBytes ? raw.slice(Math.max(0, raw.length - maxBytes)) : raw;
      },
      getDelta: resolvedArg(null),
      onChanged: noop,
    },
    agentChat: {
      list: async (args: any = {}) => listMockAgentChatSummaries(args),
      getSummary: async (args: any = {}) => {
        const sessionId = String(args?.sessionId ?? "").trim();
        const session = ADE_DB_SESSIONS.find((row) => row.id === sessionId);
        return mockAgentChatSummaryFromSession(session) ?? null;
      },
      create: resolvedArg({ id: "mock" }),
      suggestLaneName: resolvedArg("browser-mock-chat"),
      parallelLaunchState: {
        get: resolvedArg(null),
        set: resolvedArg(undefined),
      },
      handoff: resolvedArg({ session: { id: "mock" }, events: [] }),
      send: resolvedArg(undefined),
      steer: resolvedArg(undefined),
      cancelSteer: resolvedArg(undefined),
      editSteer: resolvedArg(undefined),
      dispatchSteer: resolvedArg({ delivered: false, reason: "Browser mock does not run chat sessions." }),
      cancelDispatchedSteer: resolvedArg({ cancelled: false }),
      interrupt: resolvedArg(undefined),
      resume: resolvedArg({ id: "mock" }),
      approve: resolvedArg(undefined),
      respondToInput: resolvedArg(undefined),
      models: resolvedArg([]),
      dispose: resolvedArg(undefined),
      archive: resolvedArg(undefined),
      unarchive: resolvedArg(undefined),
      delete: resolvedArg(undefined),
      updateSession: resolvedArg({ id: "mock" }),
      warmupModel: resolvedArg(undefined),
      onEvent: noop,
      slashCommands: resolvedArg([]),
      fileSearch: resolvedArg([]),
      getTurnFileDiff: resolvedArg(null),
      listSubagents: resolvedArg([]),
      getSessionCapabilities: resolvedArg({
        supportsModelSwitch: false,
        supportsSteer: false,
        supportsInterrupt: false,
      }),
      saveTempAttachment: resolvedArg({ path: "/tmp/browser-mock-attachment" }),
      getEventHistory: async (arg: { sessionId: string; maxEvents?: number }) => ({
        sessionId: typeof arg?.sessionId === "string" ? arg.sessionId : "",
        events: (() => {
          const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId : "";
          const events = getMockChatTranscriptEvents(sessionId);
          const maxEvents = Number.isFinite(arg?.maxEvents)
            ? Math.max(1, Math.floor(arg.maxEvents!))
            : events.length;
          return events.length > maxEvents ? events.slice(-maxEvents) : events;
        })(),
        truncated: (() => {
          const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId : "";
          const events = getMockChatTranscriptEvents(sessionId);
          const maxEvents = Number.isFinite(arg?.maxEvents)
            ? Math.max(1, Math.floor(arg.maxEvents!))
            : events.length;
          return events.length > maxEvents;
        })(),
      }),
    },
    cto: {
      getState: resolvedArg({
        identity: ADE_DB_SNAPSHOT?.ctoState?.identity ?? {
          name: "CTO",
          version: 1,
          persona: "Mock CTO persona",
          modelPreferences: { provider: "claude", model: "sonnet" },
          memoryPolicy: {
            autoCompact: true,
            compactionThreshold: 0.7,
            preCompactionFlush: true,
            temporalDecayHalfLifeDays: 30,
          },
          updatedAt: now,
        },
        coreMemory: ADE_DB_SNAPSHOT?.ctoState?.coreMemory ?? {
          version: 1,
          updatedAt: now,
          projectSummary: "Mock project summary",
          criticalConventions: [],
          userPreferences: [],
          activeFocus: [],
          notes: [],
        },
        recentSessions: ADE_DB_SNAPSHOT?.ctoState?.recentSessions ?? [],
      }),
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
      updateCoreMemory: resolvedArg({
        identity: {
          name: "CTO",
          version: 1,
          persona: "Mock CTO persona",
          modelPreferences: { provider: "claude", model: "sonnet" },
          memoryPolicy: {
            autoCompact: true,
            compactionThreshold: 0.7,
            preCompactionFlush: true,
            temporalDecayHalfLifeDays: 30,
          },
          updatedAt: now,
        },
        coreMemory: {
          version: 2,
          updatedAt: now,
          projectSummary: "Mock project summary",
          criticalConventions: [],
          userPreferences: [],
          activeFocus: [],
          notes: [],
        },
        recentSessions: [],
      }),
      listSessionLogs: resolvedArg([]),
      updateIdentity: resolvedArg({
        identity: {
          name: "CTO",
          version: 1,
          persona: "Mock CTO persona",
          modelPreferences: { provider: "claude", model: "sonnet" },
          memoryPolicy: {
            autoCompact: true,
            compactionThreshold: 0.7,
            preCompactionFlush: true,
            temporalDecayHalfLifeDays: 30,
          },
          updatedAt: now,
        },
        coreMemory: {
          version: 1,
          updatedAt: now,
          projectSummary: "Mock project summary",
          criticalConventions: [],
          userPreferences: [],
          activeFocus: [],
          notes: [],
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
            id: "memory",
            title: "Memory and continuity model",
            content: "Project continuity comes from memory layers.",
          },
        ],
      }),
      listAgents: resolved([]),
      saveAgent: resolvedArg({
        id: "mock-agent",
        name: "Mock Agent",
        slug: "mock-agent",
        role: "engineer",
        reportsTo: null,
        capabilities: [],
        status: "idle",
        adapterType: "claude-local",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
      removeAgent: resolvedArg(undefined),
      listAgentRevisions: resolvedArg([]),
      rollbackAgentRevision: resolvedArg({
        id: "mock-agent",
        name: "Mock Agent",
        slug: "mock-agent",
        role: "engineer",
        reportsTo: null,
        capabilities: [],
        status: "idle",
        adapterType: "claude-local",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
      ensureAgentSession: resolvedArg({
        id: "mock-agent-session",
        laneId: "lane-main",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
        capabilityMode: "full_tooling",
        status: "idle",
        createdAt: now,
        lastActivityAt: now,
      }),
      getBudgetSnapshot: resolvedArg({
        computedAt: now,
        monthKey: "2026-03",
        companyBudgetMonthlyCents: 0,
        companySpentMonthlyCents: 0,
        companyExactSpentCents: 0,
        companyEstimatedSpentCents: 0,
        companyRemainingCents: null,
        workers: [],
      }),
      triggerAgentWakeup: resolvedArg({
        runId: "mock-run",
        status: "completed",
      }),
      listAgentRuns: resolved([]),
      getAgentCoreMemory: resolvedArg({
        version: 1,
        updatedAt: now,
        projectSummary: "Mock worker memory",
        criticalConventions: [],
        userPreferences: [],
        activeFocus: [],
        notes: [],
      }),
      updateAgentCoreMemory: resolvedArg({
        version: 2,
        updatedAt: now,
        projectSummary: "Mock worker memory",
        criticalConventions: [],
        userPreferences: [],
        activeFocus: [],
        notes: [],
      }),
      listAgentSessionLogs: resolvedArg([]),
      getLinearWorkflowCatalog: resolvedArg({
        users: [],
        labels: [],
        states: [],
      }),
      getLinearIngressStatus: resolvedArg({
        localWebhook: { configured: false, healthy: false, status: "disabled" },
        relay: { configured: false, healthy: false, status: "disabled" },
        reconciliation: { enabled: true, intervalSec: 30, lastRunAt: null },
      }),
      listLinearIngressEvents: resolvedArg([]),
      ensureLinearWebhook: resolvedArg({
        localWebhook: { configured: false, healthy: false, status: "disabled" },
        relay: {
          configured: true,
          healthy: true,
          status: "ready",
          webhookUrl: "https://example.com/linear/webhooks/mock",
          endpointId: "mock-endpoint",
        },
        reconciliation: { enabled: true, intervalSec: 30, lastRunAt: null },
      }),
      onLinearWorkflowEvent: noop,
      getLinearProjects: resolvedArg([]),
      getLinearConnectionStatus: resolvedArg({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt: now,
        authMode: null,
        oauthAvailable: true,
        tokenExpiresAt: null,
        message: "Linear token not configured.",
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
    pty: {
      create: resolvedArg({ ptyId: "mock", sessionId: "mock-session", pid: 1234 }),
      write: resolvedArg(undefined),
      resize: resolvedArg(undefined),
      dispose: resolvedArg(undefined),
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
      listWorkspaces: resolved(
        MOCK_LANES.map((lane) => ({
          id: `lane:${lane.id}`,
          kind: "lane",
          laneId: lane.id,
          name: lane.name,
          rootPath: lane.worktreePath ?? MOCK_PROJECT.rootPath,
          isReadOnlyByDefault: false,
          mobileReadOnly: true,
          updatedAt: lane.createdAt ?? now,
        })),
      ),
      listTree: resolvedArg([]),
      readFile: resolvedArg({ content: "" }),
      writeText: resolvedArg(undefined),
      createFile: resolvedArg(undefined),
      createDirectory: resolvedArg(undefined),
      rename: resolvedArg(undefined),
      delete: resolvedArg(undefined),
      watchChanges: resolvedArg(undefined),
      stopWatching: resolvedArg(undefined),
      quickOpen: resolvedArg([]),
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
      revertCommit: resolvedArg({ ok: true }),
      cherryPickCommit: resolvedArg({ ok: true }),
      stashPush: resolvedArg({ ok: true }),
      stashList: resolvedArg([]),
      stashApply: resolvedArg({ ok: true }),
      stashPop: resolvedArg({ ok: true }),
      stashDrop: resolvedArg({ ok: true }),
      fetch: resolvedArg({ ok: true }),
      pull: resolvedArg({ ok: true }),
      getSyncStatus: resolvedArg({ ahead: 0, behind: 0 }),
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
        generationWarning: "ADE used a deterministic draft because no AI model was selected.",
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
        tokenDecryptionFailed: false,
        storageScope: "app",
        tokenType: "classic",
        repo: { owner: "arul28", name: "ADE" },
        userLogin: "arul",
        scopes: ["repo", "workflow"],
        checkedAt: new Date().toISOString(),
        repoAccessOk: true,
        repoAccessError: null,
        connected: true,
      }),
      setToken: resolvedArg({
        tokenStored: true,
        tokenDecryptionFailed: false,
        storageScope: "app",
        tokenType: "classic",
        repo: { owner: "arul28", name: "ADE" },
        userLogin: "arul",
        scopes: ["repo", "workflow"],
        checkedAt: new Date().toISOString(),
        repoAccessOk: true,
        repoAccessError: null,
        connected: true,
      }),
      clearToken: resolved({
        tokenStored: false,
        tokenDecryptionFailed: false,
        storageScope: "app",
        tokenType: "unknown",
        repo: { owner: "arul28", name: "ADE" },
        userLogin: null,
        scopes: [],
        checkedAt: null,
        repoAccessOk: null,
        repoAccessError: null,
        connected: false,
      }),
      detectRepo: resolved({ owner: "arul28", name: "ADE" }),
      listRepoLabels: resolved([]),
      listRepoCollaborators: resolved([]),
      onStatusChanged: noop,
    },
    prs: {
      createFromLane: resolvedArg(
        USE_ADE_DB_SNAPSHOT ? null : NORMAL_PRS[0] ?? null,
      ),
      linkToLane: resolvedArg(
        USE_ADE_DB_SNAPSHOT ? null : NORMAL_PRS[0] ?? null,
      ),
      getForLane: async (laneId: string) =>
        ALL_PRS.find((pr: any) => pr.laneId === laneId) ?? null,
      listAll: resolved(ALL_PRS),
      refresh: resolved(ALL_PRS),
      getStatus: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.status ?? MOCK_STATUS_BY_PR[prId] ?? {
          prId,
          state: "open",
          checksStatus: "passing",
          reviewStatus: "none",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 0,
        },
      getChecks: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.checks ?? MOCK_CHECKS_BY_PR[prId] ?? [],
      getComments: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.comments ?? MOCK_COMMENTS_BY_PR[prId] ?? [],
      getReviews: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.reviews ?? MOCK_REVIEWS_BY_PR[prId] ?? [],
      getReviewThreads: resolvedArg([]),
      updateDescription: resolvedArg(undefined),
      delete: resolvedArg({ deleted: true }),
      draftDescription: resolvedArg({
        title: "AI-drafted title",
        body: "AI-drafted body",
      }),
      land: resolvedArg({ success: true, prNumber: 142, sha: "abc123" }),
      landStack: resolvedArg([]),
      openInGitHub: resolvedArg(undefined),
      createQueue: resolvedArg({}),
      createIntegration: resolvedArg({}),
      simulateIntegration: resolvedArg(MOCK_INTEGRATION_SIMULATION),
      commitIntegration: resolvedArg({
        groupId: "group-int-mock",
        integrationLaneId: "lane-search",
        pr: USE_ADE_DB_SNAPSHOT ? null : INTEGRATION_PRS[0] ?? null,
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
      listWithConflicts: resolved(ALL_PRS),
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
      issueResolutionStart: async () => ({
        sessionId: "mock-pr-issue-session",
        laneId: "lane-dashboard",
        href: "/work?laneId=lane-dashboard&sessionId=mock-pr-issue-session",
      }),
      convergenceStateGet: async (prId: string) => {
        const stored =
          MOCK_CONVERGENCE_RUNTIME[prId] ??
          createDefaultConvergenceRuntime(prId);
        return { ...stored };
      },
      convergenceStateSave: async (
        prId: string,
        state: Record<string, any>,
      ) => {
        const nowIso = new Date().toISOString();
        const existing =
          MOCK_CONVERGENCE_RUNTIME[prId] ??
          createDefaultConvergenceRuntime(prId);
        // Only allow known ConvergenceRuntimeState keys (mirror real backend validation)
        const allowedKeys = new Set([
          "autoConvergeEnabled",
          "status",
          "pollerStatus",
          "currentRound",
          "activeSessionId",
          "activeLaneId",
          "activeHref",
          "pauseReason",
          "errorMessage",
          "lastStartedAt",
          "lastPolledAt",
          "lastPausedAt",
          "lastStoppedAt",
        ]);
        const filtered: Record<string, any> = {};
        for (const key of Object.keys(state)) {
          if (allowedKeys.has(key)) filtered[key] = state[key];
        }
        const next = {
          ...existing,
          ...filtered,
          prId,
          createdAt: existing.createdAt,
          updatedAt: nowIso,
        };
        MOCK_CONVERGENCE_RUNTIME[prId] = next;
        return { ...next };
      },
      convergenceStateDelete: async (prId: string) => {
        delete MOCK_CONVERGENCE_RUNTIME[prId];
      },
      rebaseResolutionStart: async () => ({
        sessionId: "mock-rebase-session",
        laneId: "lane-dashboard",
        href: "/work?laneId=lane-dashboard&sessionId=mock-rebase-session",
      }),
      issueResolutionPreviewPrompt: async () => ({
        title: "Resolve PR #1 issues",
        prompt: "Mock PR issue resolver prompt",
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
          : BUILTIN_MOCK_INTEGRATION_WORKFLOWS[1] ?? undefined,
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
          rows = rows.filter((operation) => operation.laneId === args.laneId.trim());
        }
        if (typeof args?.kind === "string" && args.kind.trim()) {
          rows = rows.filter((operation) => operation.kind === args.kind.trim());
        }
        if (typeof args?.status === "string" && args.status !== "all") {
          rows = rows.filter((operation) => operation.status === args.status);
        }
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.floor(args.limit)) : rows.length;
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
    processes: {
      listDefinitions: resolved(ADE_DB_PROCESS_DEFINITIONS),
      listRuntime: async (laneId: string) =>
        ADE_DB_PROCESS_RUNTIME.filter((runtime) => runtime.laneId === laneId),
      start: resolvedArg({}),
      stop: resolvedArg({}),
      restart: resolvedArg({}),
      kill: resolvedArg({}),
      startStack: resolvedArg(undefined),
      stopStack: resolvedArg(undefined),
      restartStack: resolvedArg(undefined),
      startAll: resolvedArg(undefined),
      stopAll: resolvedArg(undefined),
      getLogTail: resolvedArg(""),
      onEvent: noop,
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
        message: "ADE-launched agents can use ade. Terminal access is not installed yet.",
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
          message: "ADE-launched agents can use ade. Terminal access is not installed yet.",
          nextAction: "Run npm link in apps/ade-cli for local development.",
        },
      }),
    },
    memory: {
      pin: resolvedArg(undefined),
      updateCore: resolvedArg({
        identity: {
          name: "CTO",
          version: 1,
          persona: "Mock CTO persona",
          modelPreferences: { provider: "claude", model: "sonnet" },
          memoryPolicy: {
            autoCompact: true,
            compactionThreshold: 0.7,
            preCompactionFlush: true,
            temporalDecayHalfLifeDays: 30,
          },
          updatedAt: now,
        },
        recent: [],
        coreMemory: {
          responsibilities: [],
          activePriorities: [],
          constraints: [],
          preferences: [],
        },
      }),
      getBudget: resolved([]),
      getCandidates: resolved([]),
      promote: resolvedArg(undefined),
      archive: resolvedArg(undefined),
      promoteMissionEntry: resolvedArg(null),
      listMissionEntries: resolvedArg([]),
      listProcedures: resolvedArg([]),
      getProcedureDetail: resolvedArg(null),
      exportProcedureSkill: resolvedArg(null),
      listIndexedSkills: resolved([]),
      reindexSkills: resolvedArg([]),
      syncKnowledge: resolved(null),
      getKnowledgeSyncStatus: resolved({
        syncing: false,
        lastSeenHeadSha: null,
        currentHeadSha: null,
        diverged: false,
        lastDigestAt: null,
        lastDigestMemoryId: null,
        lastError: null,
      }),
      search: resolvedArg([]),
      getHealthStats: resolved(sharedMemoryHealthStats),
      downloadEmbeddingModel: resolveDownloadedMemoryHealthStats,
      runSweep: resolved(createMockSweepResult()),
      runConsolidation: resolved(createMockConsolidationResult()),
    },
    zoom: {
      getLevel: () => 0,
      setLevel: (_level: number) => {},
      getFactor: () => 1,
    },
    updateCheckForUpdates: resolved(undefined),
    updateGetState: resolved({
      status: "idle",
      version: null,
      progressPercent: null,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      releaseNotesUrl: null,
      error: null,
      recentlyInstalled: null,
    }),
    updateQuitAndInstall: resolved(undefined),
    updateDismissInstalledNotice: resolved(undefined),
    onUpdateEvent: noop,
  };
} // window
