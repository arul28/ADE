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
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const noop = () => () => {};
const resolved = <T>(v: T) => async () => v;
const resolvedArg = <T>(v: T) => async (_a: any) => v;
const resolvedArg2 = <T>(v: T) => async (_a: any, _b: any) => v;

const MOCK_PROJECT = {
  id: "browser-mock",
  name: "Browser Preview",
  rootPath: "/tmp/mock",
  gitRemoteUrl: "https://github.com/acme/ade",
  gitDefaultBranch: "main",
  createdAt: new Date().toISOString(),
};

// ── Timestamps ────────────────────────────────────────────────
const now = new Date().toISOString();
const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
const yesterday = new Date(Date.now() - 86400000).toISOString();
const twoDaysAgo = new Date(Date.now() - 172800000).toISOString();
const threeDaysAgo = new Date(Date.now() - 259200000).toISOString();
const fourHoursFromNow = new Date(Date.now() + 4 * 3600000).toISOString();

// ── Lane defaults (fields required by LaneSummary) ────────────
function makeLane(id: string, name: string, branchRef: string, opts?: Partial<any>): any {
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
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0 },
    color: null,
    icon: null,
    tags: [],
    createdAt: twoDaysAgo,
    archivedAt: null,
    ...opts,
  };
}

// ── Mock Lanes ────────────────────────────────────────────────
const MOCK_LANES: any[] = [
  // Primary
  makeLane("lane-main", "main", "refs/heads/main"),
  // Normal PR lanes
  makeLane("lane-auth", "feature/auth-flow", "refs/heads/feature/auth-flow"),
  makeLane("lane-dashboard", "feature/dashboard-v2", "refs/heads/feature/dashboard-v2"),
  makeLane("lane-api", "feature/api-refactor", "refs/heads/feature/api-refactor"),
  makeLane("lane-perf", "fix/perf-regression", "refs/heads/fix/perf-regression"),
  makeLane("lane-onboard", "feature/onboarding-wizard", "refs/heads/feature/onboarding-wizard"),
  // Queue PR lanes
  makeLane("lane-payments", "feature/payments", "refs/heads/feature/payments"),
  makeLane("lane-checkout", "feature/checkout-flow", "refs/heads/feature/checkout-flow"),
  makeLane("lane-notifications", "feature/notifications", "refs/heads/feature/notifications"),
  makeLane("lane-billing", "feature/billing-v2", "refs/heads/feature/billing-v2"),
  // Integration PR lanes
  makeLane("lane-search", "feature/search-v2", "refs/heads/feature/search-v2"),
  makeLane("lane-analytics", "feature/analytics", "refs/heads/feature/analytics"),
  makeLane("lane-i18n", "feature/i18n", "refs/heads/feature/i18n"),
  makeLane("lane-a11y", "feature/accessibility", "refs/heads/feature/accessibility"),
];

// ── Helper for PrWithConflicts ────────────────────────────────
function makePr(id: string, laneId: string, num: number, title: string, opts: Partial<any> = {}): any {
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
    headBranch: MOCK_LANES.find((l: any) => l.id === laneId)?.branchRef?.replace("refs/heads/", "") ?? laneId,
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
    conflictAnalysis: { prId: "pr-1", laneId: "lane-auth", riskLevel: "low", overlapCount: 0, conflictPredicted: false, peerConflicts: [], analyzedAt: now },
  }),
  makePr("pr-2", "lane-dashboard", 145, "Dashboard v2 — metric cards & chart widgets", {
    state: "open",
    checksStatus: "failing",
    reviewStatus: "changes_requested",
    additions: 1562,
    deletions: 340,
    createdAt: twoDaysAgo,
    conflictAnalysis: {
      prId: "pr-2", laneId: "lane-dashboard", riskLevel: "medium", overlapCount: 3, conflictPredicted: true,
      peerConflicts: [{ peerId: "pr-3", peerName: "Refactor REST endpoints", riskLevel: "medium", overlapFiles: ["src/lib/metrics.ts"] }],
      analyzedAt: now,
    },
  }),
  makePr("pr-3", "lane-api", 148, "Refactor REST endpoints to use Zod schemas", {
    state: "draft",
    checksStatus: "pending",
    reviewStatus: "requested",
    additions: 2100,
    deletions: 980,
    createdAt: yesterday,
    conflictAnalysis: null,
  }),
  makePr("pr-4", "lane-perf", 151, "Fix N+1 query in session list endpoint", {
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 45,
    deletions: 12,
    createdAt: oneHourAgo,
    conflictAnalysis: { prId: "pr-4", laneId: "lane-perf", riskLevel: "low", overlapCount: 0, conflictPredicted: false, peerConflicts: [], analyzedAt: now },
  }),
  makePr("pr-5", "lane-onboard", 153, "Onboarding wizard with step-by-step project setup", {
    state: "open",
    checksStatus: "passing",
    reviewStatus: "none",
    additions: 620,
    deletions: 80,
    createdAt: now,
    conflictAnalysis: { prId: "pr-5", laneId: "lane-onboard", riskLevel: "high", overlapCount: 5, conflictPredicted: true, peerConflicts: [], analyzedAt: now },
  }),
];

// ── Queue PRs (2 groups) ──────────────────────────────────────
//
// Group 1: "Release v3.0 — Commerce" (3 PRs: one landed, one active, one pending)
// Group 2: "Billing Upgrade" (1 PR in queue)
const QUEUE_PRS: any[] = [
  makePr("pr-q1", "lane-payments", 160, "Payment gateway integration (Stripe + PayPal)", {
    state: "merged",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 1200,
    deletions: 150,
    createdAt: threeDaysAgo,
    updatedAt: yesterday,
  }),
  makePr("pr-q2", "lane-checkout", 161, "Checkout flow with cart validation", {
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 890,
    deletions: 210,
    createdAt: twoDaysAgo,
  }),
  makePr("pr-q3", "lane-notifications", 162, "Order confirmation & shipping notifications", {
    state: "open",
    checksStatus: "pending",
    reviewStatus: "requested",
    additions: 430,
    deletions: 60,
    createdAt: yesterday,
  }),
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
      prId: "pr-i1", laneId: "lane-search", riskLevel: "medium", overlapCount: 2, conflictPredicted: false,
      peerConflicts: [{ peerId: "pr-i2", peerName: "i18n + a11y integration", riskLevel: "low", overlapFiles: ["src/App.tsx"] }],
      analyzedAt: now,
    },
  }),
  makePr("pr-i2", "lane-i18n", 185, "Internationalization & accessibility bundle", {
    state: "open",
    checksStatus: "failing",
    reviewStatus: "changes_requested",
    headBranch: "integration/i18n-a11y",
    additions: 1800,
    deletions: 420,
    createdAt: yesterday,
    conflictAnalysis: {
      prId: "pr-i2", laneId: "lane-i18n", riskLevel: "high", overlapCount: 7, conflictPredicted: true,
      peerConflicts: [
        { peerId: "pr-2", peerName: "Dashboard v2", riskLevel: "medium", overlapFiles: ["src/components/Dashboard.tsx", "src/styles/global.css"] },
      ],
      analyzedAt: now,
    },
  }),
];

// ── All PRs combined ──────────────────────────────────────────
const ALL_PRS = [...NORMAL_PRS, ...QUEUE_PRS, ...INTEGRATION_PRS];

// ── Merge Contexts ────────────────────────────────────────────
const MOCK_MERGE_CONTEXTS: Record<string, any> = {
  // Normal PRs — no group
  "pr-1": { prId: "pr-1", groupId: null, groupType: null, sourceLaneIds: ["lane-auth"], targetLaneId: "lane-main", members: [] },
  "pr-2": { prId: "pr-2", groupId: null, groupType: null, sourceLaneIds: ["lane-dashboard"], targetLaneId: "lane-main", members: [] },
  "pr-3": { prId: "pr-3", groupId: null, groupType: null, sourceLaneIds: ["lane-api"], targetLaneId: "lane-main", members: [] },
  "pr-4": { prId: "pr-4", groupId: null, groupType: null, sourceLaneIds: ["lane-perf"], targetLaneId: "lane-main", members: [] },
  "pr-5": { prId: "pr-5", groupId: null, groupType: null, sourceLaneIds: ["lane-onboard"], targetLaneId: "lane-main", members: [] },

  // Queue group 1: "Release v3.0 — Commerce"
  "pr-q1": {
    prId: "pr-q1", groupId: "queue-commerce-v3", groupType: "queue",
    sourceLaneIds: ["lane-payments"], targetLaneId: "lane-main",
    members: [
      { prId: "pr-q1", laneId: "lane-payments", laneName: "feature/payments", prNumber: 160, position: 0, role: "source" },
      { prId: "pr-q2", laneId: "lane-checkout", laneName: "feature/checkout-flow", prNumber: 161, position: 1, role: "source" },
      { prId: "pr-q3", laneId: "lane-notifications", laneName: "feature/notifications", prNumber: 162, position: 2, role: "source" },
    ],
  },
  "pr-q2": {
    prId: "pr-q2", groupId: "queue-commerce-v3", groupType: "queue",
    sourceLaneIds: ["lane-checkout"], targetLaneId: "lane-main",
    members: [
      { prId: "pr-q1", laneId: "lane-payments", laneName: "feature/payments", prNumber: 160, position: 0, role: "source" },
      { prId: "pr-q2", laneId: "lane-checkout", laneName: "feature/checkout-flow", prNumber: 161, position: 1, role: "source" },
      { prId: "pr-q3", laneId: "lane-notifications", laneName: "feature/notifications", prNumber: 162, position: 2, role: "source" },
    ],
  },
  "pr-q3": {
    prId: "pr-q3", groupId: "queue-commerce-v3", groupType: "queue",
    sourceLaneIds: ["lane-notifications"], targetLaneId: "lane-main",
    members: [
      { prId: "pr-q1", laneId: "lane-payments", laneName: "feature/payments", prNumber: 160, position: 0, role: "source" },
      { prId: "pr-q2", laneId: "lane-checkout", laneName: "feature/checkout-flow", prNumber: 161, position: 1, role: "source" },
      { prId: "pr-q3", laneId: "lane-notifications", laneName: "feature/notifications", prNumber: 162, position: 2, role: "source" },
    ],
  },
  // Queue group 2: "Billing Upgrade"
  "pr-q4": {
    prId: "pr-q4", groupId: "queue-billing-upgrade", groupType: "queue",
    sourceLaneIds: ["lane-billing"], targetLaneId: "lane-main",
    members: [
      { prId: "pr-q4", laneId: "lane-billing", laneName: "feature/billing-v2", prNumber: 170, position: 0, role: "source" },
    ],
  },

  // Integration PRs — multi-source
  "pr-i1": {
    prId: "pr-i1", groupId: "integration-search-analytics", groupType: "integration",
    sourceLaneIds: ["lane-search", "lane-analytics"], targetLaneId: "lane-main",
    members: [
      { prId: "pr-i1", laneId: "lane-search", laneName: "feature/search-v2", prNumber: 180, position: 0, role: "source" },
      { prId: "pr-i1", laneId: "lane-analytics", laneName: "feature/analytics", prNumber: null, position: 1, role: "source" },
    ],
  },
  "pr-i2": {
    prId: "pr-i2", groupId: "integration-i18n-a11y", groupType: "integration",
    sourceLaneIds: ["lane-i18n", "lane-a11y"], targetLaneId: "lane-main",
    members: [
      { prId: "pr-i2", laneId: "lane-i18n", laneName: "feature/i18n", prNumber: 185, position: 0, role: "source" },
      { prId: "pr-i2", laneId: "lane-a11y", laneName: "feature/accessibility", prNumber: null, position: 1, role: "source" },
    ],
  },
};

// ── Per-PR detail data (keyed by prId) ────────────────────────
const MOCK_CHECKS_BY_PR: Record<string, any[]> = {
  "pr-1": [
    { name: "CI / Build", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: yesterday, completedAt: now },
    { name: "CI / Lint", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: yesterday, completedAt: now },
    { name: "CI / Unit Tests", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: yesterday, completedAt: now },
    { name: "CI / E2E Tests", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: yesterday, completedAt: now },
    { name: "Deploy Preview", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: yesterday, completedAt: now },
  ],
  "pr-2": [
    { name: "CI / Build", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: yesterday, completedAt: now },
    { name: "CI / Lint", status: "completed", conclusion: "failure", detailsUrl: "#", startedAt: yesterday, completedAt: now },
    { name: "CI / Unit Tests", status: "completed", conclusion: "failure", detailsUrl: "#", startedAt: yesterday, completedAt: now },
    { name: "CI / E2E Tests", status: "completed", conclusion: "skipped", detailsUrl: "#", startedAt: yesterday, completedAt: now },
  ],
  "pr-3": [
    { name: "CI / Build", status: "in_progress", conclusion: null, detailsUrl: "#", startedAt: now, completedAt: null },
    { name: "CI / Lint", status: "queued", conclusion: null, detailsUrl: "#", startedAt: null, completedAt: null },
    { name: "CI / Unit Tests", status: "queued", conclusion: null, detailsUrl: "#", startedAt: null, completedAt: null },
  ],
  "pr-4": [
    { name: "CI / Build", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: oneHourAgo, completedAt: now },
    { name: "CI / Unit Tests", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: oneHourAgo, completedAt: now },
  ],
  "pr-5": [
    { name: "CI / Build", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: now, completedAt: now },
    { name: "CI / Lint", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: now, completedAt: now },
    { name: "CI / Unit Tests", status: "completed", conclusion: "success", detailsUrl: "#", startedAt: now, completedAt: now },
  ],
};

const MOCK_REVIEWS_BY_PR: Record<string, any[]> = {
  "pr-1": [
    { reviewer: "alice", state: "approved", body: "LGTM! Clean implementation.", submittedAt: now },
    { reviewer: "carol", state: "commented", body: "Nice work overall. Left a few minor suggestions.", submittedAt: yesterday },
  ],
  "pr-2": [
    { reviewer: "bob", state: "changes_requested", body: "Please add error handling for the token refresh edge case.", submittedAt: now },
    { reviewer: "dave", state: "changes_requested", body: "Dashboard layout breaks on mobile viewports.", submittedAt: yesterday },
  ],
  "pr-3": [
    { reviewer: "alice", state: "pending", body: null, submittedAt: null },
  ],
  "pr-4": [
    { reviewer: "eve", state: "approved", body: "Quick fix, looks good.", submittedAt: now },
  ],
  "pr-5": [],
};

const MOCK_COMMENTS_BY_PR: Record<string, any[]> = {
  "pr-1": [
    { id: "c1", author: "alice", body: "Have you considered using the `useAuth` hook from our shared lib?", source: "review", url: null, path: "src/hooks/useLogin.ts", line: 42, createdAt: yesterday, updatedAt: null },
    { id: "c2", author: "ci-bot", body: "Coverage report: 94.2% (+1.3%)", source: "issue", url: null, path: null, line: null, createdAt: now, updatedAt: null },
  ],
  "pr-2": [
    { id: "c3", author: "bob", body: "The `metricReducer` doesn't handle negative values.", source: "review", url: null, path: "src/lib/metrics.ts", line: 87, createdAt: twoDaysAgo, updatedAt: null },
    { id: "c4", author: "dave", body: "CSS grid is breaking at <768px — need a media query.", source: "review", url: null, path: "src/styles/dashboard.css", line: 15, createdAt: yesterday, updatedAt: null },
    { id: "c5", author: "ci-bot", body: "Coverage report: 78.1% (-3.4%)", source: "issue", url: null, path: null, line: null, createdAt: now, updatedAt: null },
  ],
  "pr-3": [
    { id: "c6", author: "alice", body: "Should we keep backwards-compat for the old `/api/v1` routes?", source: "issue", url: null, path: null, line: null, createdAt: yesterday, updatedAt: null },
  ],
  "pr-4": [
    { id: "c7", author: "ci-bot", body: "Performance benchmark: p95 latency down from 420ms to 12ms", source: "issue", url: null, path: null, line: null, createdAt: now, updatedAt: null },
  ],
  "pr-5": [],
};

const MOCK_STATUS_BY_PR: Record<string, any> = {
  "pr-1": { prId: "pr-1", state: "open", checksStatus: "passing", reviewStatus: "approved", isMergeable: true, mergeConflicts: false, behindBaseBy: 0 },
  "pr-2": { prId: "pr-2", state: "open", checksStatus: "failing", reviewStatus: "changes_requested", isMergeable: false, mergeConflicts: true, behindBaseBy: 12 },
  "pr-3": { prId: "pr-3", state: "draft", checksStatus: "pending", reviewStatus: "requested", isMergeable: false, mergeConflicts: false, behindBaseBy: 7 },
  "pr-4": { prId: "pr-4", state: "open", checksStatus: "passing", reviewStatus: "approved", isMergeable: true, mergeConflicts: false, behindBaseBy: 0 },
  "pr-5": { prId: "pr-5", state: "open", checksStatus: "passing", reviewStatus: "none", isMergeable: true, mergeConflicts: false, behindBaseBy: 3 },
};

// ── Rebase Needs (all urgency categories) ─────────────────────
const MOCK_REBASE_NEEDS: any[] = [
  // Attention: behind + conflicts predicted
  { laneId: "lane-dashboard", laneName: "feature/dashboard-v2", baseBranch: "main", behindBy: 12, conflictPredicted: true, conflictingFiles: ["src/components/Dashboard.tsx", "src/lib/metrics.ts", "src/styles/dashboard.css"], prId: "pr-2", groupContext: null, dismissedAt: null, deferredUntil: null },
  { laneId: "lane-i18n", laneName: "feature/i18n", baseBranch: "main", behindBy: 8, conflictPredicted: true, conflictingFiles: ["src/i18n/translations.json", "src/App.tsx"], prId: "pr-i2", groupContext: "integration-i18n-a11y", dismissedAt: null, deferredUntil: null },
  // Clean rebase: behind but no conflicts
  { laneId: "lane-api", laneName: "feature/api-refactor", baseBranch: "main", behindBy: 7, conflictPredicted: false, conflictingFiles: [], prId: "pr-3", groupContext: null, dismissedAt: null, deferredUntil: null },
  { laneId: "lane-onboard", laneName: "feature/onboarding-wizard", baseBranch: "main", behindBy: 3, conflictPredicted: false, conflictingFiles: [], prId: "pr-5", groupContext: null, dismissedAt: null, deferredUntil: null },
  // Up to date (behind 0)
  { laneId: "lane-auth", laneName: "feature/auth-flow", baseBranch: "main", behindBy: 0, conflictPredicted: false, conflictingFiles: [], prId: "pr-1", groupContext: null, dismissedAt: null, deferredUntil: null },
  // Deferred (still behind but snoozed — categorized as upToDate)
  { laneId: "lane-search", laneName: "feature/search-v2", baseBranch: "main", behindBy: 5, conflictPredicted: false, conflictingFiles: [], prId: "pr-i1", groupContext: "integration-search-analytics", dismissedAt: null, deferredUntil: fourHoursFromNow },
  // Dismissed
  { laneId: "lane-checkout", laneName: "feature/checkout-flow", baseBranch: "main", behindBy: 2, conflictPredicted: false, conflictingFiles: [], prId: "pr-q2", groupContext: "queue-commerce-v3", dismissedAt: yesterday, deferredUntil: null },
];

// ── Queue Landing State ───────────────────────────────────────
const MOCK_QUEUE_STATE: Record<string, any> = {
  "queue-commerce-v3": {
    queueId: "queue-commerce-v3",
    groupId: "queue-commerce-v3",
    state: "landing",
    entries: [
      { prId: "pr-q1", laneId: "lane-payments", laneName: "feature/payments", position: 0, state: "landed" },
      { prId: "pr-q2", laneId: "lane-checkout", laneName: "feature/checkout-flow", position: 1, state: "landing" },
      { prId: "pr-q3", laneId: "lane-notifications", laneName: "feature/notifications", position: 2, state: "pending" },
    ],
    currentPosition: 1,
    startedAt: yesterday,
    completedAt: null,
  },
  "queue-billing-upgrade": {
    queueId: "queue-billing-upgrade",
    groupId: "queue-billing-upgrade",
    state: "idle",
    entries: [
      { prId: "pr-q4", laneId: "lane-billing", laneName: "feature/billing-v2", position: 0, state: "pending" },
    ],
    currentPosition: 0,
    startedAt: now,
    completedAt: null,
  },
};

// ── Integration simulation result ─────────────────────────────
const MOCK_INTEGRATION_SIMULATION: any = {
  proposalId: "sim-mock-1",
  sourceLaneIds: ["lane-search", "lane-analytics"],
  baseBranch: "main",
  overallOutcome: "conflict",
  steps: [
    {
      laneId: "lane-search", laneName: "feature/search-v2", position: 0,
      outcome: "clean", conflictingFiles: [],
      diffStat: { insertions: 1420, deletions: 180, filesChanged: 22 },
    },
    {
      laneId: "lane-analytics", laneName: "feature/analytics", position: 1,
      outcome: "conflict",
      conflictingFiles: [{ path: "src/lib/analytics.ts", conflictMarkers: "<<<<<<< HEAD..." }, { path: "src/App.tsx", conflictMarkers: "<<<<<<< HEAD..." }],
      diffStat: { insertions: 980, deletions: 120, filesChanged: 14 },
    },
  ],
  createdAt: now,
};

// ═══════════════════════════════════════════════════════════════
// Wire it up
// ═══════════════════════════════════════════════════════════════

if (typeof window !== "undefined" && !(window as any).ade) {
  console.warn("[ADE] Running outside Electron — injecting browser mock for window.ade");

  // Flag for App.tsx to switch to BrowserRouter
  (window as any).__adeBrowserMock = true;

  (window as any).ade = {
    app: {
      ping: resolved("pong" as const),
      getInfo: resolved({ version: "0.0.0-browser", platform: "browser", arch: "web" }),
      getProject: resolved(MOCK_PROJECT),
      openExternal: resolvedArg(undefined),
      revealPath: resolvedArg(undefined),
    },
    project: {
      openRepo: resolved(MOCK_PROJECT),
      openAdeFolder: resolved(undefined),
      clearLocalData: resolved({ cleared: [] }),
      exportConfig: resolved({ files: [] }),
      listRecent: resolved([]),
      switchToPath: resolvedArg(MOCK_PROJECT),
      forgetRecent: resolvedArg([]),
      onMissing: noop,
    },
    keybindings: {
      get: resolved({ definitions: [], overrides: [] }),
      set: resolvedArg({ definitions: [], overrides: [] }),
    },
    ai: {
      getStatus: resolved({ provider: "none", status: "unconfigured" }),
    },
    agentTools: {
      detect: resolved([]),
    },
    terminalProfiles: {
      get: resolved({ profiles: [], defaultProfileId: null }),
      set: resolvedArg({ profiles: [], defaultProfileId: null }),
    },
    onboarding: {
      getStatus: resolved({ completedAt: new Date().toISOString() }),
      detectDefaults: resolved({}),
      detectExistingLanes: resolved([]),
      generateInitialPacks: resolved(undefined),
      complete: resolved({ completedAt: new Date().toISOString() }),
    },
    ci: {
      scan: resolved({ configs: [] }),
      import: resolvedArg({ imported: [] }),
    },
    automations: {
      list: resolved([]),
      toggle: resolvedArg([]),
      triggerManually: resolvedArg({ id: "", status: "completed" }),
      getHistory: resolvedArg([]),
      getRunDetail: resolvedArg(null),
      parseNaturalLanguage: resolvedArg({ rules: [] }),
      validateDraft: resolvedArg({ valid: true }),
      saveDraft: resolvedArg({ id: "" }),
      simulate: resolvedArg({ events: [] }),
      onEvent: noop,
    },
    missions: {
      list: resolved([]),
      get: resolvedArg(null),
      create: resolvedArg({ id: "mock" }),
      update: resolvedArg({ id: "mock" }),
      delete: resolvedArg(undefined),
      updateStep: resolvedArg({ id: "mock" }),
      addArtifact: resolvedArg({ id: "mock" }),
      addIntervention: resolvedArg({ id: "mock" }),
      resolveIntervention: resolvedArg({ id: "mock" }),
      onEvent: noop,
    },
    planner: {
      planMission: resolvedArg({ plan: null }),
      getRuns: resolved([]),
      getAttempt: resolvedArg(null),
    },
    orchestrator: {
      listRuns: resolved([]),
      getRunGraph: resolvedArg({ nodes: [], edges: [] }),
      startRun: resolvedArg({ run: {}, steps: [] }),
      startRunFromMission: resolvedArg({ run: {}, steps: [] }),
      approveMissionPlan: resolvedArg({ run: {}, steps: [] }),
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
        laneErrors: []
      }),
      heartbeatClaims: resolvedArg(0),
      listTimeline: resolvedArg([]),
      getGateReport: resolved({}),
      getWorkerStates: resolvedArg([]),
      startMissionRun: resolvedArg({}),
      steerMission: resolvedArg({}),
      getDepthConfig: resolvedArg({}),
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
      sendAgentMessage: resolvedArg({}),
      getGlobalChat: resolvedArg([]),
      getActiveAgents: resolvedArg([]),
      getAggregatedUsage: resolvedArg({ totalTokens: 0, totalCost: 0, byModel: [] }),
      onEvent: noop,
      onThreadEvent: noop,
      onDagMutation: noop,
    },
    lanes: {
      list: resolved(MOCK_LANES),
      create: resolvedArg({ id: "mock", name: "mock" }),
      createChild: resolvedArg({ id: "mock", name: "mock" }),
      importBranch: resolvedArg({ id: "mock", name: "mock" }),
      attach: resolvedArg({ id: "mock", name: "mock" }),
      rename: resolvedArg(undefined),
      reparent: resolvedArg({}),
      updateAppearance: resolvedArg(undefined),
      archive: resolvedArg(undefined),
      delete: resolvedArg(undefined),
      getStackChain: resolvedArg([]),
      getChildren: resolvedArg([]),
      restack: resolvedArg({}),
      listRestackSuggestions: resolved([]),
      dismissRestackSuggestion: resolvedArg(undefined),
      deferRestackSuggestion: resolvedArg(undefined),
      onRestackSuggestionsEvent: noop,
      listAutoRebaseStatuses: resolved([]),
      onAutoRebaseEvent: noop,
      openFolder: resolvedArg(undefined),
    },
    sessions: {
      list: resolved([]),
      get: resolvedArg(null),
      updateMeta: resolvedArg(null),
      readTranscriptTail: resolvedArg(""),
      getDelta: resolvedArg(null),
    },
    agentChat: {
      list: resolved([]),
      create: resolvedArg({ id: "mock" }),
      send: resolvedArg(undefined),
      steer: resolvedArg(undefined),
      interrupt: resolvedArg(undefined),
      resume: resolvedArg({ id: "mock" }),
      approve: resolvedArg(undefined),
      models: resolvedArg([]),
      dispose: resolvedArg(undefined),
      onEvent: noop,
      listContextPacks: resolved([]),
      fetchContextPack: resolvedArg({ content: "" }),
    },
    pty: {
      create: resolvedArg({ ptyId: "mock" }),
      write: resolvedArg(undefined),
      resize: resolvedArg(undefined),
      dispose: resolvedArg(undefined),
      onData: noop,
      onExit: noop,
    },
    diff: {
      getChanges: resolvedArg({ files: [] }),
      getFile: resolvedArg({ hunks: [] }),
    },
    files: {
      writeTextAtomic: resolvedArg(undefined),
      listWorkspaces: resolved([]),
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
      listRecentCommits: resolvedArg([]),
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
      finalizeResolverSession: resolvedArg({}),
      suggestResolverTarget: resolvedArg({}),
      onEvent: noop,
    },
    context: {
      getStatus: resolved({ initialized: false }),
      getInventory: resolved({ items: [] }),
      generateDocs: resolvedArg({}),
      prepareDocGeneration: resolvedArg({}),
      installGeneratedDocs: resolvedArg({}),
      openDoc: resolvedArg(undefined),
    },
    packs: {
      getProjectPack: resolved({ key: "project", version: "" }),
      getLanePack: resolvedArg({ key: "", version: "" }),
      getFeaturePack: resolvedArg({ key: "", version: "" }),
      getConflictPack: resolvedArg({ key: "", version: "" }),
      getPlanPack: resolvedArg({ key: "", version: "" }),
      getMissionPack: resolvedArg({ key: "", version: "" }),
      getProjectExport: resolvedArg({ content: "" }),
      getLaneExport: resolvedArg({ content: "" }),
      getConflictExport: resolvedArg({ content: "" }),
      getFeatureExport: resolvedArg({ content: "" }),
      getPlanExport: resolvedArg({ content: "" }),
      getMissionExport: resolvedArg({ content: "" }),
      refreshLanePack: resolvedArg({ key: "", version: "" }),
      refreshProjectPack: resolved({ key: "project", version: "" }),
      refreshFeaturePack: resolvedArg({ key: "", version: "" }),
      refreshConflictPack: resolvedArg({ key: "", version: "" }),
      savePlanPack: resolvedArg({ key: "", version: "" }),
      refreshMissionPack: resolvedArg({ key: "", version: "" }),
      refreshPlanPack: resolvedArg({ key: "", version: "" }),
      listVersions: resolvedArg([]),
      getVersion: resolvedArg({ id: "", content: "" }),
      diffVersions: resolvedArg(""),
      updateNarrative: resolvedArg({ key: "", version: "" }),
      listEvents: resolvedArg([]),
      listEventsSince: resolvedArg([]),
      listCheckpoints: resolved([]),
      getHeadVersion: resolvedArg({ versionId: null }),
      getDeltaDigest: resolvedArg({ sections: [] }),
      onEvent: noop,
    },
    github: {
      getStatus: resolved({ authenticated: true, user: "arul" }),
      setToken: resolvedArg({ authenticated: true, user: "arul" }),
      clearToken: resolved({ authenticated: false, user: null }),
    },
    prs: {
      createFromLane: resolvedArg(NORMAL_PRS[0]),
      linkToLane: resolvedArg(NORMAL_PRS[0]),
      getForLane: resolvedArg(null),
      listAll: resolved(ALL_PRS),
      refresh: resolved(ALL_PRS),
      getStatus: async (prId: string) =>
        MOCK_STATUS_BY_PR[prId] ?? { prId, state: "open", checksStatus: "passing", reviewStatus: "none", isMergeable: true, mergeConflicts: false, behindBaseBy: 0 },
      getChecks: async (prId: string) => MOCK_CHECKS_BY_PR[prId] ?? [],
      getComments: async (prId: string) => MOCK_COMMENTS_BY_PR[prId] ?? [],
      getReviews: async (prId: string) => MOCK_REVIEWS_BY_PR[prId] ?? [],
      updateDescription: resolvedArg(undefined),
      delete: resolvedArg({ deleted: true }),
      draftDescription: resolvedArg2({ title: "AI-drafted title", body: "AI-drafted body" }),
      land: resolvedArg({ success: true, prNumber: 142, sha: "abc123" }),
      landStack: resolvedArg([]),
      openInGitHub: resolvedArg(undefined),
      createStacked: resolvedArg({}),
      createQueue: resolvedArg({}),
      createIntegration: resolvedArg({}),
      simulateIntegration: resolvedArg(MOCK_INTEGRATION_SIMULATION),
      commitIntegration: resolvedArg({}),
      landStackEnhanced: resolvedArg([]),
      landQueueNext: resolvedArg({ success: true, prNumber: 161, sha: "def456" }),
      getHealth: resolvedArg({}),
      getQueueState: async (groupId: string) => MOCK_QUEUE_STATE[groupId] ?? null,
      getConflictAnalysis: resolvedArg({}),
      getMergeContext: async (prId: string) =>
        MOCK_MERGE_CONTEXTS[prId] ?? { prId, groupId: null, groupType: null, sourceLaneIds: [], targetLaneId: null, members: [] },
      listWithConflicts: resolved(ALL_PRS),
      onEvent: noop,
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
      listOperations: resolved([]),
      exportOperations: resolvedArg({ operations: [] }),
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
      listDefinitions: resolved([]),
      listRuntime: resolvedArg([]),
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
      get: resolved({ effective: { providerMode: "guest" }, overrides: {} }),
      validate: resolvedArg({ valid: true }),
      save: resolvedArg({ effective: { providerMode: "guest" }, overrides: {} }),
      diffAgainstDisk: resolved({ changed: false }),
      confirmTrust: resolved({ trusted: true }),
    },
  };
}
