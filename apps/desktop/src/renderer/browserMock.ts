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

import { getDefaultModelDescriptor } from "../shared/modelRegistry";

const noop = () => () => {};
const resolved = <T>(v: T) => async () => v;
const resolvedArg = <T>(v: T) => async (_a: any) => v;
const resolvedArg2 = <T>(v: T) => async (_a: any, _b: any) => v;
const DEFAULT_BROWSER_MOCK_CODEX_MODEL = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4-codex";

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

function createMockMemoryHealthStats(overrides: Partial<any> = {}): any {
  return {
    scopes: [
      { scope: "project", current: 0, max: 2000, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
      { scope: "agent", current: 0, max: 500, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
      { scope: "mission", current: 0, max: 200, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
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
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
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
  "pr-1": { prId: "pr-1", groupId: null, groupType: null, sourceLaneIds: ["lane-auth"], targetLaneId: "lane-main", integrationLaneId: null, members: [] },
  "pr-2": { prId: "pr-2", groupId: null, groupType: null, sourceLaneIds: ["lane-dashboard"], targetLaneId: "lane-main", integrationLaneId: null, members: [] },
  "pr-3": { prId: "pr-3", groupId: null, groupType: null, sourceLaneIds: ["lane-api"], targetLaneId: "lane-main", integrationLaneId: null, members: [] },
  "pr-4": { prId: "pr-4", groupId: null, groupType: null, sourceLaneIds: ["lane-perf"], targetLaneId: "lane-main", integrationLaneId: null, members: [] },
  "pr-5": { prId: "pr-5", groupId: null, groupType: null, sourceLaneIds: ["lane-onboard"], targetLaneId: "lane-main", integrationLaneId: null, members: [] },

  // Queue group 1: "Release v3.0 — Commerce"
  "pr-q1": {
    prId: "pr-q1", groupId: "queue-commerce-v3", groupType: "queue",
    sourceLaneIds: ["lane-payments"], targetLaneId: "lane-main", integrationLaneId: null,
    members: [
      { prId: "pr-q1", laneId: "lane-payments", laneName: "feature/payments", prNumber: 160, position: 0, role: "source" },
      { prId: "pr-q2", laneId: "lane-checkout", laneName: "feature/checkout-flow", prNumber: 161, position: 1, role: "source" },
      { prId: "pr-q3", laneId: "lane-notifications", laneName: "feature/notifications", prNumber: 162, position: 2, role: "source" },
    ],
  },
  "pr-q2": {
    prId: "pr-q2", groupId: "queue-commerce-v3", groupType: "queue",
    sourceLaneIds: ["lane-checkout"], targetLaneId: "lane-main", integrationLaneId: null,
    members: [
      { prId: "pr-q1", laneId: "lane-payments", laneName: "feature/payments", prNumber: 160, position: 0, role: "source" },
      { prId: "pr-q2", laneId: "lane-checkout", laneName: "feature/checkout-flow", prNumber: 161, position: 1, role: "source" },
      { prId: "pr-q3", laneId: "lane-notifications", laneName: "feature/notifications", prNumber: 162, position: 2, role: "source" },
    ],
  },
  "pr-q3": {
    prId: "pr-q3", groupId: "queue-commerce-v3", groupType: "queue",
    sourceLaneIds: ["lane-notifications"], targetLaneId: "lane-main", integrationLaneId: null,
    members: [
      { prId: "pr-q1", laneId: "lane-payments", laneName: "feature/payments", prNumber: 160, position: 0, role: "source" },
      { prId: "pr-q2", laneId: "lane-checkout", laneName: "feature/checkout-flow", prNumber: 161, position: 1, role: "source" },
      { prId: "pr-q3", laneId: "lane-notifications", laneName: "feature/notifications", prNumber: 162, position: 2, role: "source" },
    ],
  },
  // Queue group 2: "Billing Upgrade"
  "pr-q4": {
    prId: "pr-q4", groupId: "queue-billing-upgrade", groupType: "queue",
    sourceLaneIds: ["lane-billing"], targetLaneId: "lane-main", integrationLaneId: null,
    members: [
      { prId: "pr-q4", laneId: "lane-billing", laneName: "feature/billing-v2", prNumber: 170, position: 0, role: "source" },
    ],
  },

  // Integration PRs — multi-source
  "pr-i1": {
    prId: "pr-i1", groupId: "integration-search-analytics", groupType: "integration",
    sourceLaneIds: ["lane-search", "lane-analytics"], targetLaneId: "lane-main", integrationLaneId: "lane-search",
    members: [
      { prId: "pr-i1", laneId: "lane-search", laneName: "integration/search-analytics", prNumber: 180, position: 0, role: "integration" },
      { prId: "pr-i1", laneId: "lane-search", laneName: "feature/search-v2", prNumber: 180, position: 0, role: "source" },
      { prId: "pr-i1", laneId: "lane-analytics", laneName: "feature/analytics", prNumber: null, position: 1, role: "source" },
    ],
  },
  "pr-i2": {
    prId: "pr-i2", groupId: "integration-i18n-a11y", groupType: "integration",
    sourceLaneIds: ["lane-i18n", "lane-a11y"], targetLaneId: "lane-main", integrationLaneId: "lane-i18n",
    members: [
      { prId: "pr-i2", laneId: "lane-i18n", laneName: "integration/i18n-a11y", prNumber: 185, position: 0, role: "integration" },
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
    groupName: "Release v3.0 - Commerce",
    targetBranch: "main",
    state: "landing",
    entries: [
      { prId: "pr-q1", laneId: "lane-payments", laneName: "feature/payments", position: 0, prNumber: 160, githubUrl: "https://github.com/mock/repo/pull/160", state: "landed", updatedAt: yesterday },
      { prId: "pr-q2", laneId: "lane-checkout", laneName: "feature/checkout-flow", position: 1, prNumber: 161, githubUrl: "https://github.com/mock/repo/pull/161", state: "landing", updatedAt: now },
      { prId: "pr-q3", laneId: "lane-notifications", laneName: "feature/notifications", position: 2, prNumber: 162, githubUrl: "https://github.com/mock/repo/pull/162", state: "pending", updatedAt: null },
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
      { prId: "pr-q4", laneId: "lane-billing", laneName: "feature/billing-v2", position: 0, prNumber: 170, githubUrl: "https://github.com/mock/repo/pull/170", state: "pending", updatedAt: null },
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

const MOCK_QUEUE_REHEARSAL_STATE: Record<string, any> = {
  "queue-commerce-v3": {
    rehearsalId: "rehearsal-commerce-v3",
    groupId: "queue-commerce-v3",
    groupName: "Release v3.0 - Commerce",
    targetBranch: "main",
    state: "completed",
    entries: [
      { prId: "pr-q1", laneId: "lane-payments", laneName: "feature/payments", position: 0, prNumber: 160, githubUrl: "https://github.com/mock/repo/pull/160", state: "ready", changedFiles: ["payments.ts"], updatedAt: yesterday },
      { prId: "pr-q2", laneId: "lane-checkout", laneName: "feature/checkout-flow", position: 1, prNumber: 161, githubUrl: "https://github.com/mock/repo/pull/161", state: "resolved", resolvedByAi: true, changedFiles: ["checkout.ts"], conflictPaths: ["checkout.ts"], updatedAt: now },
    ],
    currentPosition: 2,
    scratchLaneId: "lane-queue-rehearsal",
    activePrId: null,
    activeResolverRunId: null,
    lastError: null,
    waitReason: null,
    config: {
      method: "squash",
      autoResolve: true,
      resolverProvider: "claude",
      resolverModel: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "medium",
      permissionMode: "guarded_edit",
      preserveScratchLane: true,
      originSurface: "queue",
      originMissionId: null,
      originRunId: null,
      originLabel: "Release v3.0 - Commerce",
    },
    startedAt: yesterday,
    completedAt: now,
    updatedAt: now,
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

const MOCK_INTEGRATION_WORKFLOWS: any[] = [
  {
    proposalId: "workflow-int-active",
    sourceLaneIds: ["lane-search", "lane-analytics"],
    baseBranch: "main",
    pairwiseResults: [],
    laneSummaries: [
      { laneId: "lane-search", laneName: "feature/search-v2", outcome: "clean", commitHash: "abc1234", commitCount: 4, conflictsWith: [], diffStat: { insertions: 1420, deletions: 180, filesChanged: 22 } },
      { laneId: "lane-analytics", laneName: "feature/analytics", outcome: "clean", commitHash: "def5678", commitCount: 3, conflictsWith: [], diffStat: { insertions: 980, deletions: 120, filesChanged: 14 } },
    ],
    steps: MOCK_INTEGRATION_SIMULATION.steps,
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
      { laneId: "lane-i18n", laneName: "feature/i18n", outcome: "conflict", commitHash: "ghi9012", commitCount: 6, conflictsWith: ["lane-a11y"], diffStat: { insertions: 1100, deletions: 220, filesChanged: 19 } },
      { laneId: "lane-a11y", laneName: "feature/accessibility", outcome: "conflict", commitHash: "jkl3456", commitCount: 2, conflictsWith: ["lane-i18n"], diffStat: { insertions: 700, deletions: 90, filesChanged: 9 } },
    ],
    steps: [
      {
        laneId: "lane-i18n",
        laneName: "feature/i18n",
        position: 0,
        outcome: "conflict",
        conflictingFiles: [{ path: "src/App.tsx", conflictMarkers: "<<<<<<< HEAD...", oursExcerpt: null, theirsExcerpt: null, diffHunk: null }],
        diffStat: { insertions: 1100, deletions: 220, filesChanged: 19 },
      },
      {
        laneId: "lane-a11y",
        laneName: "feature/accessibility",
        position: 1,
        outcome: "conflict",
        conflictingFiles: [{ path: "src/App.tsx", conflictMarkers: "<<<<<<< HEAD...", oursExcerpt: null, theirsExcerpt: null, diffHunk: null }],
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

const MOCK_GITHUB_SNAPSHOT: any = {
  repo: { owner: "acme", name: "ade" },
  viewerLogin: "mock-user",
  syncedAt: now,
  repoPullRequests: [
    ...ALL_PRS.map((pr: any) => {
      const ctx = MOCK_MERGE_CONTEXTS[pr.id] ?? null;
      const workflow = MOCK_INTEGRATION_WORKFLOWS.find((item) => item.linkedPrId === pr.id) ?? null;
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
        linkedLaneName: MOCK_LANES.find((lane: any) => lane.id === pr.laneId)?.name ?? pr.laneId,
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
      complete: resolved({ completedAt: new Date().toISOString() }),
    },
    ci: {
      scan: resolved({ configs: [] }),
      import: resolvedArg({ imported: [] }),
    },
    automations: {
      list: resolved([
        {
          id: "auto-session-review",
          name: "Session review follow-through",
          description: "Queue end-of-session review work and escalate findings in the morning.",
          enabled: true,
          mode: "review",
          triggers: [{ type: "github-webhook", event: "pull_request", branch: "main" }],
          trigger: { type: "github-webhook", event: "pull_request", branch: "main" },
          executor: { mode: "employee", targetId: "native-reviewer" },
          modelConfig: { orchestratorModel: { modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" } },
          permissionConfig: { providers: { unified: "edit", claude: "plan", codexSandbox: "workspace-write", allowedTools: ["git", "linear"] } },
          prompt: "Review incoming GitHub activity and prepare a concise follow-up summary.",
          reviewProfile: "incremental",
          toolPalette: ["repo", "git", "github", "memory", "mission"],
          contextSources: [{ type: "project-memory" }, { type: "worker-memory" }],
          memory: { mode: "automation-plus-employee" },
          guardrails: {},
          outputs: { disposition: "queue-overnight", createArtifact: true },
          verification: { verifyBeforePublish: true, mode: "intervention" },
          billingCode: "auto:session-review",
          queueStatus: "queued-for-night-shift",
          actions: [],
          running: false,
          lastRunAt: now,
          lastRunStatus: "needs_review",
          queueCount: 2,
          paused: false,
          ignoredRunCount: 0,
          confidence: { value: 0.84, label: "high", reason: "Night Shift found actionable follow-up." },
        },
      ]),
      toggle: resolvedArg([]),
      triggerManually: resolvedArg({ id: "run-1", automationId: "auto-session-review", missionId: "mission-1", workerRunId: null, workerAgentId: null, queueItemId: null, triggerType: "manual", startedAt: now, endedAt: now, status: "succeeded", queueStatus: "completed-clean", executorMode: "automation-bot", actionsCompleted: 0, actionsTotal: 0, errorMessage: null, spendUsd: 0.42, verificationRequired: false, confidence: null, triggerMetadata: null, summary: "Manual run completed.", billingCode: "auto:session-review" }),
      getHistory: resolvedArg([
        { id: "run-1", automationId: "auto-session-review", missionId: "mission-1", workerRunId: "worker-run-1", workerAgentId: "native-reviewer", queueItemId: "queue-1", triggerType: "github-webhook", startedAt: now, endedAt: now, status: "needs_review", queueStatus: "verification-required", executorMode: "employee", actionsCompleted: 1, actionsTotal: 1, errorMessage: null, spendUsd: 1.32, verificationRequired: true, confidence: { value: 0.81, label: "high", reason: "Review found releasable changes." }, triggerMetadata: { repository: "ADE", branch: "main" }, summary: "Prepared a publish-ready review draft.", billingCode: "auto:session-review" },
      ]),
      getRunDetail: resolvedArg({
        run: { id: "run-1", automationId: "auto-session-review", missionId: "mission-1", workerRunId: "worker-run-1", workerAgentId: "native-reviewer", queueItemId: "queue-1", triggerType: "github-webhook", startedAt: now, endedAt: now, status: "needs_review", queueStatus: "verification-required", executorMode: "employee", actionsCompleted: 1, actionsTotal: 1, errorMessage: null, spendUsd: 1.32, verificationRequired: true, confidence: { value: 0.81, label: "high", reason: "Review found releasable changes." }, triggerMetadata: { repository: "ADE", branch: "main", author: "alice" }, summary: "Prepared a publish-ready review draft.", billingCode: "auto:session-review" },
        rule: null,
        actions: [{ id: "action-1", runId: "run-1", actionIndex: 0, actionType: "run-command", startedAt: now, endedAt: now, status: "succeeded", errorMessage: null, output: "Queued release review and staged publish continuation." }],
        queueItem: { id: "queue-1", automationId: "auto-session-review", runId: "run-1", missionId: "mission-1", title: "Release follow-up review", mode: "review", queueStatus: "verification-required", triggerType: "github-webhook", summary: "Needs approval before publishing.", severitySummary: "medium", confidence: { value: 0.81, label: "high", reason: "Review found releasable changes." }, fileCount: 3, spendUsd: 1.32, verificationRequired: true, suggestedActions: ["open-pr-draft"], procedureSignals: ["release-risk"], createdAt: now, updatedAt: now },
        procedureFeedback: [{ procedureId: "release-risk", outcome: "observation", reason: "Recommended a gated publish step." }],
        ingressEvent: { id: "ingress-1", source: "github-relay", eventKey: "delivery-1", automationIds: ["auto-session-review"], triggerType: "github-webhook", eventName: "pull_request", status: "dispatched", summary: "PR synchronize event dispatched to matching rules.", errorMessage: null, cursor: "cursor-1", receivedAt: now },
        pendingPublish: { id: "publish-1", runId: "run-1", automationId: "auto-session-review", queueItemId: "queue-1", summary: "Publish draft comment to GitHub after review.", toolPalette: ["github", "mission"], createdAt: now },
      }),
      listRuns: resolvedArg([
        { id: "run-1", automationId: "auto-session-review", missionId: "mission-1", workerRunId: "worker-run-1", workerAgentId: "native-reviewer", queueItemId: "queue-1", triggerType: "github-webhook", startedAt: now, endedAt: now, status: "needs_review", queueStatus: "verification-required", executorMode: "employee", actionsCompleted: 1, actionsTotal: 1, errorMessage: null, spendUsd: 1.32, verificationRequired: true, confidence: { value: 0.81, label: "high", reason: "Review found releasable changes." }, triggerMetadata: { repository: "ADE", branch: "main" }, summary: "Prepared a publish-ready review draft.", billingCode: "auto:session-review" },
      ]),
      listQueueItems: resolvedArg([
        { id: "queue-1", automationId: "auto-session-review", runId: "run-1", missionId: "mission-1", title: "Release follow-up review", mode: "review", queueStatus: "verification-required", triggerType: "github-webhook", summary: "Needs approval before publishing.", severitySummary: "medium", confidence: { value: 0.81, label: "high", reason: "Review found releasable changes." }, fileCount: 3, spendUsd: 1.32, verificationRequired: true, suggestedActions: ["open-pr-draft"], procedureSignals: ["release-risk"], createdAt: now, updatedAt: now },
      ]),
      updateQueueItem: resolvedArg(null),
      getNightShiftState: resolved({ settings: { activeHours: { start: "22:00", end: "06:00", timezone: "America/New_York" }, utilizationPreset: "conservative", paused: false, updatedAt: now }, queue: [{ id: "night-1", automationId: "auto-session-review", title: "Release follow-up review", reviewProfile: "incremental", executorMode: "employee", targetLabel: "native-reviewer", scheduledWindow: "22:00-06:00", status: "queued", position: 0, createdAt: now, updatedAt: now }], latestBriefing: { id: "briefing-1", createdAt: now, completedAt: now, totalRuns: 2, succeededRuns: 1, failedRuns: 1, totalSpendUsd: 2.42, cards: [{ queueItemId: "queue-1", title: "Release follow-up review", summary: "Prepared a gated publish draft for GitHub.", confidence: { value: 0.81, label: "high", reason: "Review found releasable changes." }, spendUsd: 1.32, suggestedActions: ["accept"], procedureSignals: ["release-risk"] }] } }),
      updateNightShiftSettings: resolvedArg({ settings: { activeHours: { start: "22:00", end: "06:00", timezone: "America/New_York" }, utilizationPreset: "conservative", paused: false, updatedAt: now }, queue: [{ id: "night-1", automationId: "auto-session-review", title: "Release follow-up review", reviewProfile: "incremental", executorMode: "employee", targetLabel: "native-reviewer", scheduledWindow: "22:00-06:00", status: "queued", position: 0, createdAt: now, updatedAt: now }], latestBriefing: null }),
      mutateNightShiftQueue: resolvedArg({ settings: { activeHours: { start: "22:00", end: "06:00", timezone: "America/New_York" }, utilizationPreset: "conservative", paused: false, updatedAt: now }, queue: [{ id: "night-1", automationId: "auto-session-review", title: "Release follow-up review", reviewProfile: "incremental", executorMode: "employee", targetLabel: "native-reviewer", scheduledWindow: "22:00-06:00", status: "queued", position: 0, createdAt: now, updatedAt: now }], latestBriefing: null }),
      getMorningBriefing: resolved({ id: "briefing-1", createdAt: now, completedAt: now, totalRuns: 2, succeededRuns: 1, failedRuns: 1, totalSpendUsd: 2.42, cards: [{ queueItemId: "queue-1", title: "Release follow-up review", summary: "Prepared a gated publish draft for GitHub.", confidence: { value: 0.81, label: "high", reason: "Review found releasable changes." }, spendUsd: 1.32, suggestedActions: ["accept"], procedureSignals: ["release-risk"] }] }),
      acknowledgeMorningBriefing: resolvedArg(null),
      getIngressStatus: resolved({
        githubRelay: { configured: true, healthy: true, status: "ready", apiBaseUrl: "https://relay.mock", remoteProjectId: "proj-123", lastCursor: "cursor-1", lastPolledAt: now, lastDeliveryAt: now, lastError: null },
        localWebhook: { configured: true, listening: true, status: "listening", url: "http://127.0.0.1:4319/automations/webhook", port: 4319, lastDeliveryAt: now, lastError: null },
      }),
      listIngressEvents: resolvedArg([{ id: "ingress-1", source: "github-relay", eventKey: "delivery-1", automationIds: ["auto-session-review"], triggerType: "github-webhook", eventName: "pull_request", status: "dispatched", summary: "PR synchronize event dispatched to matching rules.", errorMessage: null, cursor: "cursor-1", receivedAt: now }]),
      parseNaturalLanguage: resolvedArg({
        draft: {
          name: "Mock automation",
          description: "",
          enabled: true,
          mode: "review",
          triggers: [{ type: "manual" }],
          trigger: { type: "manual" },
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
      validateDraft: resolvedArg({ ok: true, normalized: null, issues: [], requiredConfirmations: [] }),
      saveDraft: resolvedArg({ rule: { id: "mock-rule" }, rules: [] }),
      simulate: resolvedArg({ normalized: null, actions: [], notes: ["Mock simulation"], issues: [] }),
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
        laneErrors: []
      }),
      heartbeatClaims: resolvedArg(0),
      listTimeline: resolvedArg([]),
      getGateReport: resolved({}),
      getWorkerStates: resolvedArg([]),
      startMissionRun: resolvedArg({}),
      steerMission: resolvedArg({}),
      getTeamMembers: async (args: { runId?: string } = {}) => {
        const runId = typeof args.runId === "string" && args.runId.trim().length > 0 ? args.runId.trim() : "mock-run";
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
            metadata: { teamRole: "validator", source: "ade-subagent", parentWorkerId: "implement-api", isSubAgent: true },
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
            metadata: { source: "claude-native", parentWorkerId: "implement-api", teamRole: "specialist" },
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
      getMissionBudgetTelemetry: resolvedArg({ computedAt: new Date().toISOString(), perProvider: [], dataSources: [] }),
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
      adoptAttached: resolvedArg({ id: "mock", name: "mock" }),
      rename: resolvedArg(undefined),
      reparent: resolvedArg({}),
      updateAppearance: resolvedArg(undefined),
      archive: resolvedArg(undefined),
      delete: resolvedArg(undefined),
      getStackChain: resolvedArg([]),
      getChildren: resolvedArg([]),
      rebaseStart: resolvedArg({ runId: "mock-run", run: { runId: "mock-run", rootLaneId: "mock", scope: "lane_only", pushMode: "none", state: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), actor: "user", baseBranch: "main", lanes: [], currentLaneId: null, failedLaneId: null, error: null, pushedLaneIds: [], canRollback: false } }),
      rebasePush: resolvedArg({ runId: "mock-run", rootLaneId: "mock", scope: "lane_only", pushMode: "none", state: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), actor: "user", baseBranch: "main", lanes: [], currentLaneId: null, failedLaneId: null, error: null, pushedLaneIds: [], canRollback: false }),
      rebaseRollback: resolvedArg({ runId: "mock-run", rootLaneId: "mock", scope: "lane_only", pushMode: "none", state: "aborted", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), actor: "user", baseBranch: "main", lanes: [], currentLaneId: null, failedLaneId: null, error: null, pushedLaneIds: [], canRollback: false }),
      rebaseAbort: resolvedArg({ runId: "mock-run", rootLaneId: "mock", scope: "lane_only", pushMode: "none", state: "aborted", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), actor: "user", baseBranch: "main", lanes: [], currentLaneId: null, failedLaneId: null, error: null, pushedLaneIds: [], canRollback: false }),
      rebaseSubscribe: noop,
      listRebaseSuggestions: resolved([]),
      dismissRebaseSuggestion: resolvedArg(undefined),
      deferRebaseSuggestion: resolvedArg(undefined),
      onRebaseSuggestionsEvent: noop,
      listAutoRebaseStatuses: resolved([]),
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
      onProxyEvent: noop,
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
      updateSession: resolvedArg({ id: "mock" }),
      onEvent: noop,
      listContextPacks: resolved([]),
      fetchContextPack: resolvedArg({ content: "" }),
      changePermissionMode: resolvedArg(undefined),
    },
    cto: {
      getState: resolvedArg({
        identity: {
          name: "CTO",
          version: 1,
          persona: "Mock CTO persona",
          modelPreferences: { provider: "claude", model: "sonnet" },
          memoryPolicy: {
            autoCompact: true,
            compactionThreshold: 0.7,
            preCompactionFlush: true,
            temporalDecayHalfLifeDays: 30
          },
          updatedAt: now
        },
        coreMemory: {
          version: 1,
          updatedAt: now,
          projectSummary: "Mock project summary",
          criticalConventions: [],
          userPreferences: [],
          activeFocus: [],
          notes: []
        },
        recentSessions: []
      }),
      ensureSession: resolvedArg({
        id: "mock-cto-session",
        laneId: "lane-main",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
        capabilityMode: "full_mcp",
        status: "idle",
        createdAt: now,
        lastActivityAt: now
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
            temporalDecayHalfLifeDays: 30
          },
          updatedAt: now
        },
        coreMemory: {
          version: 2,
          updatedAt: now,
          projectSummary: "Mock project summary",
          criticalConventions: [],
          userPreferences: [],
          activeFocus: [],
          notes: []
        },
        recentSessions: []
      }),
      listSessionLogs: resolvedArg([]),
      updateIdentity: resolvedArg({
        identity: { name: "CTO", version: 1, persona: "Mock CTO persona", modelPreferences: { provider: "claude", model: "sonnet" }, memoryPolicy: { autoCompact: true, compactionThreshold: 0.7, preCompactionFlush: true, temporalDecayHalfLifeDays: 30 }, updatedAt: now },
        coreMemory: { version: 1, updatedAt: now, projectSummary: "Mock project summary", criticalConventions: [], userPreferences: [], activeFocus: [], notes: [] },
        recentSessions: []
      }),
      listAgents: resolved([]),
      saveAgent: resolvedArg({ id: "mock-agent", name: "Mock Agent", slug: "mock-agent", role: "engineer", reportsTo: null, capabilities: [], status: "idle", adapterType: "claude-local", adapterConfig: {}, runtimeConfig: {}, budgetMonthlyCents: 0, spentMonthlyCents: 0, createdAt: now, updatedAt: now, deletedAt: null }),
      removeAgent: resolvedArg(undefined),
      listAgentRevisions: resolvedArg([]),
      rollbackAgentRevision: resolvedArg({ id: "mock-agent", name: "Mock Agent", slug: "mock-agent", role: "engineer", reportsTo: null, capabilities: [], status: "idle", adapterType: "claude-local", adapterConfig: {}, runtimeConfig: {}, budgetMonthlyCents: 0, spentMonthlyCents: 0, createdAt: now, updatedAt: now, deletedAt: null }),
      ensureAgentSession: resolvedArg({ id: "mock-agent-session", laneId: "lane-main", provider: "claude", model: "sonnet", identityKey: "cto", capabilityMode: "full_mcp", status: "idle", createdAt: now, lastActivityAt: now }),
      getBudgetSnapshot: resolvedArg({ computedAt: now, monthKey: "2026-03", companyBudgetMonthlyCents: 0, companySpentMonthlyCents: 0, companyExactSpentCents: 0, companyEstimatedSpentCents: 0, companyRemainingCents: null, workers: [] }),
      triggerAgentWakeup: resolvedArg({ runId: "mock-run", status: "completed" }),
      listAgentRuns: resolved([]),
      getAgentCoreMemory: resolvedArg({ version: 1, updatedAt: now, projectSummary: "Mock worker memory", criticalConventions: [], userPreferences: [], activeFocus: [], notes: [] }),
      updateAgentCoreMemory: resolvedArg({ version: 2, updatedAt: now, projectSummary: "Mock worker memory", criticalConventions: [], userPreferences: [], activeFocus: [], notes: [] }),
      listAgentSessionLogs: resolvedArg([])
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
      draftDescription: resolvedArg({ title: "AI-drafted title", body: "AI-drafted body" }),
      land: resolvedArg({ success: true, prNumber: 142, sha: "abc123" }),
      landStack: resolvedArg([]),
      openInGitHub: resolvedArg(undefined),
      createQueue: resolvedArg({}),
      createIntegration: resolvedArg({}),
      simulateIntegration: resolvedArg(MOCK_INTEGRATION_SIMULATION),
      commitIntegration: resolvedArg({
        groupId: "group-int-mock",
        integrationLaneId: "lane-search",
        pr: INTEGRATION_PRS[0],
        mergeResults: [],
      }),
      landStackEnhanced: resolvedArg([]),
      landQueueNext: resolvedArg({ success: true, prNumber: 161, sha: "def456" }),
      startQueueAutomation: async (args: { groupId: string; autoResolve?: boolean; archiveLane?: boolean; ciGating?: boolean; method?: string; resolverModel?: string; reasoningEffort?: string }) => {
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
        const state = Object.values(MOCK_QUEUE_STATE).find((candidate) => candidate.queueId === queueId) ?? null;
        if (state) state.state = "paused";
        return state;
      },
      resumeQueueAutomation: async (args: { queueId: string }) => {
        const state = Object.values(MOCK_QUEUE_STATE).find((candidate) => candidate.queueId === args.queueId) ?? null;
        if (state) state.state = "landing";
        return state;
      },
      cancelQueueAutomation: async (queueId: string) => {
        const state = Object.values(MOCK_QUEUE_STATE).find((candidate) => candidate.queueId === queueId) ?? null;
        if (state) state.state = "cancelled";
        return state;
      },
      startQueueRehearsal: async (args: { groupId: string; autoResolve?: boolean; method?: string; resolverModel?: string; reasoningEffort?: string }) => {
        const state = MOCK_QUEUE_REHEARSAL_STATE[args.groupId];
        if (!state) throw new Error(`Unknown queue group: ${args.groupId}`);
        state.state = "running";
        state.config = {
          ...state.config,
          autoResolve: args.autoResolve ?? state.config.autoResolve,
          method: args.method ?? state.config.method,
          resolverModel: args.resolverModel ?? state.config.resolverModel,
          reasoningEffort: args.reasoningEffort ?? state.config.reasoningEffort,
        };
        return state;
      },
      cancelQueueRehearsal: async (rehearsalId: string) => {
        const state = Object.values(MOCK_QUEUE_REHEARSAL_STATE).find((candidate) => candidate.rehearsalId === rehearsalId) ?? null;
        if (state) state.state = "cancelled";
        return state;
      },
      getHealth: resolvedArg({}),
      getQueueState: async (groupId: string) => MOCK_QUEUE_STATE[groupId] ?? null,
      listQueueStates: async () => Object.values(MOCK_QUEUE_STATE),
      getQueueRehearsalState: async (groupId: string) => MOCK_QUEUE_REHEARSAL_STATE[groupId] ?? null,
      listQueueRehearsals: async () => Object.values(MOCK_QUEUE_REHEARSAL_STATE),
      getConflictAnalysis: resolvedArg({}),
      getMergeContext: async (prId: string) =>
        MOCK_MERGE_CONTEXTS[prId] ?? { prId, groupId: null, groupType: null, sourceLaneIds: [], targetLaneId: null, integrationLaneId: null, members: [] },
      listWithConflicts: resolved(ALL_PRS),
      getGitHubSnapshot: resolved(MOCK_GITHUB_SNAPSHOT),
      listIntegrationWorkflows: resolved(MOCK_INTEGRATION_WORKFLOWS),
      aiResolutionStart: async () => ({
        sessionId: "mock-pr-ai-session",
        provider: "codex" as const,
        ptyId: null,
        status: "started" as const,
        error: null,
        context: { sourceTab: "normal" as const, laneId: "lane-1" }
      }),
      aiResolutionInput: resolvedArg(undefined),
      aiResolutionStop: resolvedArg(undefined),
      onAiResolutionEvent: noop,
      onEvent: noop,
      getDetail: resolvedArg({ prId: "", body: null, labels: [], assignees: [], requestedReviewers: [], author: { login: "", avatarUrl: null }, isDraft: false, milestone: null, linkedIssues: [] }),
      getFiles: resolvedArg([]),
      getActionRuns: resolvedArg([]),
      getActivity: resolvedArg([]),
      addComment: resolvedArg({ id: "mock", author: "you", body: "", source: "issue", url: null, path: null, line: null, createdAt: null, updatedAt: null }),
      updateTitle: resolvedArg(undefined),
      updateBody: resolvedArg(undefined),
      setLabels: resolvedArg(undefined),
      requestReviewers: resolvedArg(undefined),
      submitReview: resolvedArg(undefined),
      close: resolvedArg(undefined),
      reopen: resolvedArg(undefined),
      rerunChecks: resolvedArg(undefined),
      aiReviewSummary: resolvedArg({ summary: "AI review summary placeholder", potentialIssues: [], recommendations: [], mergeReadiness: "ready" }),
      listProposals: resolved([]),
      dismissIntegrationCleanup: resolvedArg(MOCK_INTEGRATION_WORKFLOWS[1]),
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
    memory: {
      pin: resolvedArg(undefined),
      updateCore: resolvedArg({
        identity: { name: "CTO", version: 1, persona: "Mock CTO persona", modelPreferences: { provider: "claude", model: "sonnet" }, memoryPolicy: { autoCompact: true, compactionThreshold: 0.7, preCompactionFlush: true, temporalDecayHalfLifeDays: 30 }, updatedAt: now },
        recent: [],
        coreMemory: { responsibilities: [], activePriorities: [], constraints: [], preferences: [] },
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
      getHealthStats: resolved(createMockMemoryHealthStats()),
      downloadEmbeddingModel: resolved(createMockMemoryHealthStats({
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
            state: "ready",
            progress: 100,
            loaded: 1,
            total: 1,
            file: "/tmp/mock-model.onnx",
            error: null,
          },
        },
      })),
      runSweep: resolved(createMockSweepResult()),
      runConsolidation: resolved(createMockConsolidationResult()),
    },
    zoom: {
      getLevel: () => 0,
      setLevel: (_level: number) => {},
      getFactor: () => 1,
    },
  };
}
