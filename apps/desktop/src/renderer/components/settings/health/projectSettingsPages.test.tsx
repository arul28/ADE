/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expectNoJargon } from "../../../../test/jargonGuard";
import { LanesSettingsPage, StorageSettingsPage } from "../lanes/LanesSettingsPage";
import { LocationPage } from "../location/LocationPage";
import { ServiceStatusSection } from "./HealthService";
import { ToastStack } from "../../app/toast/ToastStack";
import { dismissToast, getToasts } from "../../app/toast/toastStore";
import { DialogHost } from "../../ui/dialog";
import { readAppleRecordingsTotalBytes } from "../appleRecordingsFootprint";
import { SettingsMachineScopeProvider, settingsMachineScope } from "../SettingsMachineScope";
import type {
  MaintenanceRunReport,
  RuntimeHealthSnapshot,
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
  StorageSnapshot,
  StorageSnapshotExtras,
} from "../../../../shared/types/storage";
import type { ProjectHealthFixResult, ProjectHealthReport, ProjectLaneHealth } from "../../../../shared/types/projectHealth";
import type {
  AppResourceUsageSnapshot,
  LaneCleanupConfig,
  LaneReclaimRisk,
  OpenProjectBinding,
  ProjectConfigCandidate,
} from "../../../../shared/types";

vi.mock("../appleRecordingsFootprint", () => ({
  readAppleRecordingsTotalBytes: vi.fn(async () => 0),
}));

const originalAde = (globalThis.window as any)?.ade;

const PROJECT = "/Users/dev/proj";
const ARCHIVED_PATH = `${PROJECT}/.ade/worktrees/feature-old`;
const ORPHANED_PATH = `${PROJECT}/.ade/worktrees/ghost-lane`;
const ACTIVE_PATH = `${PROJECT}/.ade/worktrees/main-lane`;

function makeSnapshot(): StorageSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    projectRoot: PROJECT,
    volume: { freeBytes: 40 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
    totalAdeBytes: 6 * 1024 ** 3,
    scanDurationMs: 820,
    truncated: false,
    categories: [
      {
        id: "chats_history",
        bytes: 900 * 1024 ** 2,
        fileCount: 40,
        safety: "compressible",
        compressibleBytes: 300 * 1024 ** 2,
        items: [
          { id: "c1", label: "Chat and terminal history", path: `${PROJECT}/.ade/transcripts`, bytes: 900 * 1024 ** 2, fileCount: 40, lastModifiedAt: null, safety: "compressible" },
        ],
      },
      {
        id: "lanes_worktrees",
        bytes: 4 * 1024 ** 3,
        fileCount: 300,
        safety: "review_first",
        items: [
          { id: "l-active", label: "main-lane", path: ACTIVE_PATH, bytes: 2 * 1024 ** 3, fileCount: 150, lastModifiedAt: null, safety: "protected", laneStatus: "active" },
          { id: "l-archived", label: "Old feature", path: ARCHIVED_PATH, bytes: 1.5 * 1024 ** 3, fileCount: 100, lastModifiedAt: null, safety: "review_first", laneStatus: "archived", laneId: "lane-old", ownership: "ADE-managed", ageHours: 45 * 24, reclaimableBytes: 1.5 * 1024 ** 3, detail: "Archived lane — its files are kept until you remove them" },
          { id: "l-orphaned", label: "ghost-lane", path: ORPHANED_PATH, bytes: 512 * 1024 ** 2, fileCount: 50, lastModifiedAt: null, safety: "review_first", laneStatus: "orphaned", ownership: "ADE-managed", ageHours: 20 * 24, reclaimableBytes: 512 * 1024 ** 2, detail: "Left over from a deleted lane" },
        ],
      },
      {
        id: "build_release",
        bytes: 200 * 1024 ** 2,
        fileCount: 10,
        safety: "safe_to_remove",
        items: [
          { id: "b1", label: "iOS build data", path: `${PROJECT}/.ade/cache/ios-simulator/DerivedData`, bytes: 200 * 1024 ** 2, fileCount: 10, lastModifiedAt: null, safety: "safe_to_remove", detail: "Recreated the next time you build" },
        ],
      },
      {
        id: "caches",
        bytes: 350 * 1024 ** 2,
        fileCount: 20,
        safety: "safe_to_remove",
        items: [
          { id: "ca1", label: "npm", path: `${PROJECT}/.ade/cache/npm`, bytes: 250 * 1024 ** 2, fileCount: 15, lastModifiedAt: null, safety: "safe_to_remove", detail: "Recreated when needed" },
          { id: "ca2", label: "Chat session records", path: `${PROJECT}/.ade/cache/chat-sessions`, bytes: 100 * 1024 ** 2, fileCount: 5, lastModifiedAt: null, safety: "protected", detail: "Required to keep existing chats available" },
        ],
      },
      {
        id: "proof_attachments",
        bytes: 120 * 1024 ** 2,
        fileCount: 8,
        safety: "review_first",
        items: [
          { id: "p1", label: "Proof and recordings", path: `${PROJECT}/.ade/artifacts`, bytes: 120 * 1024 ** 2, fileCount: 8, lastModifiedAt: null, safety: "review_first" },
        ],
      },
      {
        id: "recovery_backups",
        bytes: 140 * 1024 ** 2,
        fileCount: 2,
        safety: "review_first",
        items: [
          { id: "r-old", label: "Obsolete recovery backup", path: `${PROJECT}/.ade/ade.db.bak-2026-06-01`, bytes: 60 * 1024 ** 2, fileCount: 1, lastModifiedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), safety: "safe_to_remove" },
          { id: "r-new", label: "Newest recovery backup", path: `${PROJECT}/.ade/ade.db.bak-2026-07-01`, bytes: 80 * 1024 ** 2, fileCount: 1, lastModifiedAt: new Date().toISOString(), safety: "review_first" },
        ],
      },
      {
        id: "database",
        bytes: 24 * 1024 ** 2,
        fileCount: 3,
        safety: "protected",
        items: [
          { id: "db1", label: "Project database", path: `${PROJECT}/.ade/ade.db`, bytes: 24 * 1024 ** 2, fileCount: 1, lastModifiedAt: null, safety: "protected" },
        ],
      },
    ],
  };
}

const MB = 1024 ** 2;

function makeExtras(): StorageSnapshotExtras {
  const nowIso = new Date().toISOString();
  const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return {
    dbBreakdown: [
      { table: "automation_ingress_events", label: "Webhook history", bytes: 40 * MB, category: "webhooks", action: "prunable" },
      { table: "operations", label: "Sync bookkeeping", bytes: 20 * MB, category: "sync_bookkeeping", action: "compactable" },
      { table: "pull_request_snapshots", label: "Pull request cache", bytes: 4 * MB, category: "pr_cache", action: "compaction_pending" },
      { table: "core", label: "Core data", bytes: 8 * MB, category: "core", action: null },
    ],
    maintenance: {
      lastRun: {
        startedAt: yesterdayIso,
        finishedAt: yesterdayIso,
        trigger: "daily",
        actions: [
          { ledgerId: "db.automation_ingress_events", kind: "prune", itemsAffected: 200, bytesReclaimed: 450 * MB, durationMs: 40 },
          { ledgerId: "db.operations_crsql", kind: "compact", itemsAffected: 0, bytesReclaimed: 30 * MB, durationMs: 60 },
        ],
        reclaimedBytes: 480 * MB,
        dbSizeBytes: 60 * MB,
      },
      journal: [
        {
          startedAt: yesterdayIso,
          finishedAt: yesterdayIso,
          trigger: "daily",
          actions: [
            { ledgerId: "db.automation_ingress_events", kind: "prune", itemsAffected: 200, bytesReclaimed: 450 * MB, durationMs: 40 },
            { ledgerId: "db.operations_crsql", kind: "compact", itemsAffected: 0, bytesReclaimed: 30 * MB, durationMs: 60 },
          ],
          reclaimedBytes: 480 * MB,
          dbSizeBytes: 60 * MB,
        },
        {
          startedAt: nowIso,
          finishedAt: nowIso,
          trigger: "manual",
          actions: [],
          reclaimedBytes: 0,
          dbSizeBytes: 32 * MB,
        },
      ],
    },
    safeReclaimableBytes: 460 * MB,
    policyChips: {
      chats_history: "Compressed after 14 days",
      build_release: "Auto-cleans · 7 days",
      caches: "Rebuilt on demand",
    },
  };
}

function makeSnapshotWithExtras(): StorageSnapshot {
  return { ...makeSnapshot(), extras: makeExtras() };
}

function makeUsage(): AppResourceUsageSnapshot {
  return {
    sampledAt: new Date().toISOString(),
    processCount: 4,
    cpuPercent: 2,
    mainCpuPercent: 1,
    rendererCpuPercent: 1,
    memoryMB: 500,
    mainMemoryMB: 200,
    rendererMemoryMB: 300,
    activePtyCount: 0,
    ptyProcessCount: 0,
    ptyCpuPercent: null,
    ptyMemoryMB: null,
    freeMemoryMB: 8_000,
    totalMemoryMB: 16_000,
    roleUsage: [
      { role: "ade-runtime", processCount: 1, cpuPercent: 2, memoryMB: 280 },
      { role: "electron-main", processCount: 1, cpuPercent: 3, memoryMB: 500 },
    ],
  } as AppResourceUsageSnapshot;
}

function installAdeMock(options: {
  withCompress?: boolean;
  withExtras?: boolean;
  extras?: StorageSnapshotExtras;
  withApp?: boolean;
  maintenanceReport?: MaintenanceRunReport;
  resourceUsage?: AppResourceUsageSnapshot;
  reclaimRisk?: Partial<LaneReclaimRisk>;
  report?: ProjectHealthReport;
  config?: {
    shared?: { laneCleanup?: LaneCleanupConfig };
    local?: { laneCleanup?: LaneCleanupConfig };
    effective?: { laneCleanup?: LaneCleanupConfig };
  };
} = {}) {
  const cleanupPreview = vi.fn(
    async (targets: StorageCleanupTarget[]): Promise<StorageCleanupPreview> => ({
      items: targets.map((target) => ({ path: target.path, bytes: 1.5 * 1024 ** 3, label: "Old feature" })),
      totalBytes: targets.length * 1.5 * 1024 ** 3,
      blocked: [],
    }),
  );
  const cleanupResult: StorageCleanupResult = {
    removed: [{ path: ARCHIVED_PATH, bytes: 1.5 * 1024 ** 3 }],
    failed: [],
    freedBytes: 1.5 * 1024 ** 3,
  };
  const cleanupFn = vi.fn(
    async (_targets: StorageCleanupTarget[], _opts: { preview: StorageCleanupPreview }) => cleanupResult,
  );
  const compressNow = vi.fn(async () => ({ filesCompressed: 12, savedBytes: 300 * 1024 ** 2 }));
  const runMaintenanceNow = vi.fn(
    async (): Promise<MaintenanceRunReport> => options.maintenanceReport ?? ({
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      trigger: "manual",
      actions: [
        { ledgerId: "db.automation_ingress_events", kind: "prune", itemsAffected: 200, bytesReclaimed: 450 * MB, durationMs: 40 },
      ],
      reclaimedBytes: 481 * MB,
      dbSizeBytes: 30 * MB,
    }),
  );
  const getRuntimeHealth = vi.fn(
    async (): Promise<RuntimeHealthSnapshot> => ({ slowActions24h: 3, slowActionP95Ms: 5_200, failedActions24h: 1, sampledAt: new Date().toISOString() }),
  );
  const getResourceUsage = vi.fn(async () => options.resourceUsage ?? makeUsage());

  const storage: Record<string, unknown> = {
    getSnapshot: vi.fn(async () => options.extras
      ? { ...makeSnapshot(), extras: options.extras }
      : options.withExtras ? makeSnapshotWithExtras() : makeSnapshot()),
    getPressure: vi.fn(async () => ({ state: "normal", freeBytes: 40 * 1024 ** 3, totalBytes: 500 * 1024 ** 3, freeFraction: 0.08, perRoot: [], sampledAt: new Date().toISOString() })),
    cleanupPreview,
    cleanup: cleanupFn,
  };
  if (options.withCompress) storage.compressNow = compressNow;
  if (options.withExtras || options.extras) storage.runMaintenanceNow = runMaintenanceNow;

  const includeApp = options.withApp ?? (options.withExtras || options.extras != null);
  const getReclaimRisk = vi.fn(async ({ laneId }: { laneId: string }) => ({
    laneId,
    laneName: "Old feature",
    branchRef: "feature/old",
    worktreePath: ARCHIVED_PATH,
    dirty: false,
    hasUnpushedCommits: false,
    unpushedCommitCount: 0,
    remoteBranchExists: true,
    activeChatCount: 0,
    activePtyCount: 0,
    activeWatcherCount: 0,
    envInitialized: false,
    worktreeBytes: 1.5 * 1024 ** 3,
    generatedBytes: 0,
    reclaimableBytes: 1.5 * 1024 ** 3,
    worktreeAvailable: true,
    blockedReasons: [],
    lastFailure: null,
    retryCount: 0,
    ...options.reclaimRisk,
  }));
  const archiveAndReclaim = vi.fn(async ({ laneId }: { laneId: string }) => ({
    laneId,
    reclaimedBytes: 1.5 * 1024 ** 3,
    worktreeRemoved: true,
    generatedDataRemoved: true,
    warnings: [],
  }));
  const saveProjectConfig = vi.fn(async (_candidate: ProjectConfigCandidate) => undefined);
  const report = options.report ?? makeReport();
  const getReport = vi.fn(async (_args?: { forceRefresh?: boolean }, _pin?: unknown) => report);
  const fix = vi.fn(async (args: { fixId: string }, _pin?: unknown): Promise<ProjectHealthFixResult> => ({
    ok: true,
    done: ["Updated 14 saved paths."],
    problems: [],
    report: { ...report, issues: report.issues.filter((issue) => issue.fix?.id !== args.fixId) },
  }));
  (globalThis.window as any).ade = {
    storage,
    lanes: {
      list: vi.fn(async () => [
        { id: "lane-old", name: "Old feature", worktreePath: ARCHIVED_PATH, archivedAt: "2026-07-02T00:00:00.000Z", status: { dirty: false } },
        { id: "lane-main", name: "main-lane", worktreePath: ACTIVE_PATH, archivedAt: null, status: { dirty: false } },
      ]),
      getReclaimRisk,
      archiveAndReclaim,
      unarchive: vi.fn(async () => ({
        lane: { id: "lane-old", name: "Old feature" },
        worktreeRecreated: true,
      })),
    },
    projectConfig: {
      get: vi.fn(async () => ({
        shared: options.config?.shared ?? {},
        local: options.config?.local ?? {},
        effective: options.config?.effective ?? { laneCleanup: {} },
      })),
      save: saveProjectConfig,
    },
    projectHealth: { getReport, fix },
    ...(includeApp ? { app: { getResourceUsage, getRuntimeHealth } } : {}),
  };
  return {
    cleanupPreview,
    cleanup: cleanupFn,
    compressNow,
    runMaintenanceNow,
    getRuntimeHealth,
    getResourceUsage,
    getReclaimRisk,
    archiveAndReclaim,
    saveProjectConfig,
    getReport,
    fix,
  };
}

function makeReport(): ProjectHealthReport {
  return {
    projectRoot: PROJECT,
    checkedAt: new Date().toISOString(),
    previousRoots: ["/Users/dev/old/proj"],
    drive: { name: "Macintosh HD", internal: true, freeBytes: 40 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
    issues: [
      {
        id: "stale-paths",
        area: "location",
        severity: "problem",
        title: "14 saved paths still name the old folder",
        detail: "Chats and proof that point at the old folder open nothing.",
        items: ["Chat transcripts (9)", "Proof items (5)"],
        fix: { id: "update-paths", label: "Update paths", description: "Points every saved path at the new folder.", kind: "change" },
      },
      {
        id: "dependencies",
        area: "dependencies",
        severity: "warning",
        title: "1 checkout needs its dependencies installed",
        detail: "Builds fail there until packages are installed.",
        fix: { id: "install-dependencies", label: "Install", description: "Opens a terminal and runs npm install.", kind: "terminal" },
      },
    ],
    lanes: [],
    staleAfterDays: 14,
    checks: [
      { id: "stale-paths", label: "Saved paths point at this folder", ok: false },
      { id: "lane-folders", label: "Every lane has its folder", ok: true },
    ],
  };
}

function makeLane(laneId: string, overrides: Partial<ProjectLaneHealth> = {}): ProjectLaneHealth {
  return {
    laneId,
    name: laneId,
    laneType: "worktree",
    worktreePath: `${PROJECT}/.ade/worktrees/${laneId}`,
    branch: `ade/${laneId}`,
    folderExists: true,
    pr: null,
    lastActivityAt: new Date().toISOString(),
    dirty: false,
    changedFileCount: 0,
    unpushedCommits: 0,
    runningSessions: 0,
    stale: null,
    safeToArchive: true,
    ...overrides,
  };
}

type ScopeInput = Parameters<typeof settingsMachineScope>[0];

function renderPage(node: React.ReactNode, entry = "/settings?tab=lanes-git", scope?: ScopeInput) {
  const page = (
    <MemoryRouter initialEntries={[entry]}>
      {node}
      <ToastStack />
      <DialogHost />
    </MemoryRouter>
  );
  return render(scope ? <SettingsMachineScopeProvider scope={settingsMachineScope(scope)}>{page}</SettingsMachineScopeProvider> : page);
}

/** Project → Lanes: the lane list and the rules for new lanes, one view each. */
function renderLanes(entry?: string, scope?: ScopeInput) {
  return renderPage(<LanesSettingsPage />, entry, scope);
}

/** Project → Storage & cleanup: space, the archive and the cleanup rules, one view each. */
function renderStorage(entry = "/settings?tab=storage", scope?: ScopeInput) {
  return renderPage(<StorageSettingsPage />, entry, scope);
}

/** Shows one of the page's views (New lanes, Your lanes, Space, Archive, Rules) by its tab. */
async function openView(name: string) {
  fireEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${name}`) }));
}

async function openDetails() {
  fireEvent.click(await screen.findByRole("button", { name: "Storage details" }));
}

describe("Project → Lanes, Location, and Computer → ADE service", () => {
  afterEach(() => {
    cleanup();
    for (const toast of getToasts()) dismissToast(toast.id);
    vi.restoreAllMocks();
    vi.mocked(readAppleRecordingsTotalBytes).mockResolvedValue(0);
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else (globalThis.window as any).ade = originalAde;
  });

  it("shows what ADE keeps as at most four categories plus Other, with free space", async () => {
    installAdeMock();
    renderStorage();
    await openView("Space");

    await screen.findByRole("img", { name: /Lanes & worktrees/ });
    const legend = screen.getByRole("group", { name: /What ADE keeps, by category/ });
    // Lanes 4 GB, chats 900 MB, caches 350 MB, build 200 MB; the rest fold into Other.
    for (const name of ["Lanes & worktrees", "Chats & terminal history", "Caches", "Build & release files", "Other"]) {
      expect(within(legend).getByText(name)).toBeTruthy();
    }
    expect(within(legend).queryByText("Project database")).toBeNull();
    expect(screen.getAllByText("40.0 GB").length).toBeGreaterThan(0);
  });

  it("marks sizes the scan could not finish as lower bounds", async () => {
    installAdeMock();
    const partial = makeSnapshot();
    partial.truncated = true;
    const lanes = partial.categories.find((category) => category.id === "lanes_worktrees")!;
    lanes.partial = true;
    lanes.items[0]!.partial = true;
    vi.mocked(window.ade.storage.getSnapshot).mockResolvedValue(partial);
    renderStorage();
    await openView("Space");

    expect((await screen.findAllByText("≥ 4.0 GB")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Sizes marked ≥ are at least that much/)).toBeTruthy();
  });

  it("lists archived and left-over lanes with their actions, and keeps active lanes", async () => {
    installAdeMock();
    renderStorage();
    await openView("Space");
    await openDetails();

    expect((await screen.findAllByText("Old feature")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("ghost-lane").length).toBeGreaterThan(0);
    expect(screen.getAllByText("main-lane").length).toBeGreaterThan(0);
    // Archived lanes use the guarded reclaim flow; only the leftover uses file cleanup.
    expect(screen.getAllByRole("button", { name: /remove files/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /archive & reclaim/i }).length).toBeGreaterThan(0);
    expect(screen.getByText("Chat session records")).toBeTruthy();
  });

  it("opens proof removal by its own name, and points blocked proof at the proof drawer", async () => {
    installAdeMock();
    renderStorage();
    await openView("Space");
    await openDetails();
    const proofRow = (await screen.findByText("Proof and recordings")).closest(".ade-st-item") as HTMLElement;
    fireEvent.click(within(proofRow).getByRole("button", { name: "Remove…" }));
    expect(await screen.findByRole("dialog", { name: "Remove Proof and recordings" })).toBeTruthy();
    cleanup();

    installAdeMock();
    const blockedSnapshot = makeSnapshot();
    blockedSnapshot.categories.find((category) => category.id === "proof_attachments")!.items = [];
    vi.mocked(window.ade.storage.getSnapshot).mockResolvedValue(blockedSnapshot);
    renderStorage();
    await openView("Space");
    await openDetails();
    expect(await screen.findByText(/Open the proof drawer in a chat to delete individual items/)).toBeTruthy();
  });

  it("removes a leftover lane folder: previews, then removes the same targets and reports freed space", async () => {
    const { cleanupPreview, cleanup: cleanupFn } = installAdeMock();
    renderStorage();
    await openView("Space");
    await openDetails();

    fireEvent.click((await screen.findAllByRole("button", { name: /remove files/i }))[0]!);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledTimes(1));
    const previewTargets = cleanupPreview.mock.calls[0]![0];
    expect(previewTargets).toEqual([{ kind: "orphaned_worktree", path: ORPHANED_PATH }]);

    fireEvent.click(await within(dialog).findByRole("button", { name: /remove 1 item/i }));
    await waitFor(() => expect(cleanupFn).toHaveBeenCalledTimes(1));
    expect(cleanupFn.mock.calls[0]![0]).toEqual(previewTargets);
    expect(await within(dialog).findByText(/Freed 1\.5 GB/)).toBeTruthy();
  });

  it("requires a separate acknowledgement before discarding dirty lane changes", async () => {
    const { archiveAndReclaim } = installAdeMock({
      reclaimRisk: {
        dirty: true,
        blockedReasons: [{
          code: "dirty_worktree",
          disposition: "confirmation_required",
          message: "This lane has uncommitted changes.",
        }],
      },
    });
    renderStorage();
    await openView("Space");
    await openDetails();

    fireEvent.click((await screen.findAllByRole("button", { name: /archive & reclaim/i }))[0]!);
    const dialog = await screen.findByRole("dialog", { name: /archive & reclaim old feature/i });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "RECLAIM" } });

    const confirm = within(dialog).getByRole("button", { name: /confirm discarded changes/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /discard uncommitted changes/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /reclaim 1\.5 GB/i }));

    await waitFor(() => expect(archiveAndReclaim).toHaveBeenCalledWith({
      laneId: "lane-old",
      confirmation: "RECLAIM",
      forceDirty: true,
    }, null));
  });

  it("keeps reclaim focus inside the dialog and closes it on Escape", async () => {
    installAdeMock();
    renderStorage();
    await openView("Space");
    await openDetails();

    const trigger = (await screen.findAllByRole("button", { name: /archive & reclaim/i }))[0]!;
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: /archive & reclaim old feature/i });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /archive & reclaim/i })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the archive rule in force and saves an edit, debounced, as a local override only", async () => {
    const { saveProjectConfig } = installAdeMock({
      config: {
        shared: { laneCleanup: { autoArchiveAfterHours: 24 } },
        local: { laneCleanup: { maxActiveLanes: 3 } },
        effective: {
          laneCleanup: {
            maxActiveLanes: 3,
            autoArchiveAfterHours: 24,
            cleanupIntervalHours: 6,
            reclaimArchivedAfterHours: 72,
          },
        },
      },
    });
    // The Rules view also draws the session and .ade folder sections.
    (window.ade as any).sessions = { getLifecycleSettings: vi.fn(async () => ({ autoSettleLaneSessionsOnPrMerge: true })) };
    (window.ade as any).project = { getSnapshot: vi.fn(() => new Promise(() => undefined)), onStateEvent: vi.fn(() => () => undefined) };
    renderStorage();
    await openView("Rules");

    // An inherited rule shows the value in force, not an empty box.
    const inherited = await screen.findByLabelText(/Archive after inactivity/i);
    await waitFor(() => expect((inherited as HTMLInputElement).value).toBe("24"));

    fireEvent.change(screen.getByLabelText(/Keep at most/i), { target: { value: "5" } });
    expect(saveProjectConfig).not.toHaveBeenCalled();
    await waitFor(() => expect(saveProjectConfig).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const saved = saveProjectConfig.mock.calls[0]![0].local.laneCleanup!;
    expect(saved.maxActiveLanes).toBe(5);
    // Untouched rules stay inherited rather than being frozen as overrides.
    expect(saved.autoArchiveAfterHours).toBeUndefined();
    expect(saved.cleanupIntervalHours).toBeUndefined();
    expect(saved.reclaimArchivedAfterHours).toBeUndefined();
  });

  it("offers history compression only when the machine can compress, and reports what it saved", async () => {
    installAdeMock({ withCompress: false });
    renderStorage();
    await openView("Space");
    await openDetails();
    await screen.findByText("Older than two weeks").catch(() => null);
    expect(screen.queryByRole("button", { name: /compress now/i })).toBeNull();
    cleanup();

    const { compressNow } = installAdeMock({ withCompress: true });
    renderStorage();
    await openView("Space");
    await openDetails();
    fireEvent.click(await screen.findByRole("button", { name: /compress now/i }));
    await waitFor(() => expect(compressNow).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Compressed 12 files, saved 300 MB/)).toBeTruthy();
  });

  it("uses plain language with no internal jargon on every page", async () => {
    installAdeMock({ withExtras: true });
    const lanes = renderStorage();
    await openView("Space");
    await openDetails();
    expectNoJargon(lanes.container.textContent ?? "");
    cleanup();

    installAdeMock({ withExtras: true });
    const location = renderPage(<LocationPage />, "/settings?tab=location");
    await screen.findByText("2 things need attention");
    expectNoJargon(location.container.textContent ?? "");
    cleanup();

    installAdeMock({ withExtras: true });
    const service = renderPage(<ServiceStatusSection />, "/settings?tab=service");
    await screen.findAllByText("280 MB");
    expectNoJargon(service.container.textContent ?? "");
  });

  it("offers safe cleanup for an obsolete backup even when the cache estimate is zero", async () => {
    installAdeMock({ extras: { ...makeExtras(), safeReclaimableBytes: 0 } });
    renderStorage();
    await openView("Space");
    expect(await screen.findByRole("button", { name: /clean up safely/i })).toBeTruthy();
  });

  it("puts on the Clean up button what it removes, previews those files, then runs maintenance", async () => {
    const { cleanupPreview, cleanup: cleanupFn, runMaintenanceNow } = installAdeMock({ withExtras: true });
    renderStorage();
    await openView("Space");

    // npm 250 MB + iOS build data 200 MB + the obsolete backup 60 MB.
    const primary = await screen.findByRole("button", { name: "Clean up safely · 510 MB" });
    fireEvent.click(primary);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledTimes(1));
    const previewTargets = cleanupPreview.mock.calls[0]![0];
    expect([...previewTargets].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { kind: "recovery_backup", path: `${PROJECT}/.ade/ade.db.bak-2026-06-01` },
      { kind: "rebuildable_cache", path: `${PROJECT}/.ade/cache/ios-simulator/DerivedData` },
      { kind: "rebuildable_cache", path: `${PROJECT}/.ade/cache/npm` },
    ]);
    expect(within(dialog).getByText(/never touched/)).toBeTruthy();
    fireEvent.click(await within(dialog).findByRole("button", { name: /clean up safely/i }));

    await waitFor(() => expect(runMaintenanceNow).toHaveBeenCalledTimes(1));
    expect(cleanupFn).toHaveBeenCalledWith(previewTargets, {
      preview: await cleanupPreview.mock.results[0]!.value,
    }, null);
    expect(cleanupFn.mock.invocationCallOrder[0]).toBeLessThan(runMaintenanceNow.mock.invocationCallOrder[0]!);
    // Files removed plus what maintenance returned, with the parts.
    expect(await within(dialog).findByText(/Freed 2\.0 GB/)).toBeTruthy();
    expect(within(dialog).getByText(/files 1\.5 GB · database 450 MB/)).toBeTruthy();
  });

  it("reports a zero-byte partial maintenance failure instead of calling storage tidy", async () => {
    const failedReport: MaintenanceRunReport = {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      trigger: "manual",
      actions: [
        { ledgerId: "fs.tmp", kind: "delete", itemsAffected: 0, bytesReclaimed: 0, durationMs: 3, error: "files in use" },
      ],
      reclaimedBytes: 0,
      dbSizeBytes: 30 * MB,
    };
    installAdeMock({ withExtras: true, maintenanceReport: failedReport });
    renderStorage();
    await openView("Space");

    fireEvent.click(await screen.findByRole("button", { name: /clean up safely/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /clean up safely/i }));
    expect(await within(dialog).findByText(/some cleanup steps couldn't finish/i)).toBeTruthy();
    expect(getToasts().find((toast) => toast.title === "Some cleanup steps couldn't finish")?.tone).toBe("warning");
    expect(within(dialog).queryByText("Storage is already tidy.")).toBeNull();
  });

  it("shows the database breakdown in plain words", async () => {
    installAdeMock({ withExtras: true });
    renderStorage();
    await openView("Space");
    await openDetails();
    expect(await screen.findByText("Webhook history")).toBeTruthy();
    expect(screen.getByText("Sync bookkeeping")).toBeTruthy();
    expect(screen.getByText("Core data")).toBeTruthy();
    expect(screen.getByText(/Waiting to compact/)).toBeTruthy();
  });

  it("lists cleanups with what each freed, by kind", async () => {
    installAdeMock({ withExtras: true });
    renderStorage();
    await openView("Space");
    expect(await screen.findByText(/database 480 MB/)).toBeTruthy();
    expect(screen.getByText(/2 cleanups freed 480 MB/)).toBeTruthy();
  });

  it("shows the background service: slow and failed apart, p95, memory and load", async () => {
    installAdeMock({ withExtras: true });
    renderPage(<ServiceStatusSection />, "/settings?tab=service");

    expect((await screen.findAllByText("280 MB")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Load: Light/)).toBeTruthy();
    expect(screen.getByText(/95% of slow ones finished within 5\.2 s/)).toBeTruthy();
    const responses = screen.getByRole("list", { name: /slow and failed responses/i });
    const failed = within(responses).getByText("Failed").closest("li") as HTMLElement;
    expect(within(failed).getByText("1")).toBeTruthy();
    const slow = within(responses).getByText(/^Slow/).closest("li") as HTMLElement;
    expect(within(slow).getByText("3")).toBeTruthy();
  });

  it("does not show a load reading when resource pressure is unavailable", async () => {
    const unavailableUsage = {
      ...makeUsage(),
      cpuPercent: null,
      mainCpuPercent: null,
      rendererCpuPercent: null,
      ptyCpuPercent: null,
      memoryMB: null,
      freeMemoryMB: null,
    } as AppResourceUsageSnapshot;
    const { getResourceUsage } = installAdeMock({ withExtras: true, resourceUsage: unavailableUsage });
    renderPage(<ServiceStatusSection />, "/settings?tab=service");

    await waitFor(() => expect(getResourceUsage).toHaveBeenCalledTimes(1));
    await screen.findByText("Service status");
    expect(screen.queryByText(/Load:/)).toBeNull();
  });

  it("warns when Apple recordings exceed the warning size, without a delete action", async () => {
    vi.mocked(readAppleRecordingsTotalBytes).mockResolvedValue(6 * 1024 ** 3);
    installAdeMock({ withExtras: true });
    renderStorage();
    await openView("Space");
    await openDetails();

    expect(await screen.findByText("Apple recordings")).toBeTruthy();
    expect(screen.getByText(/over the 5\.0 GB warning size/)).toBeTruthy();
    const card = screen.getByText("Apple recordings").closest("section");
    expect(within(card as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("runs a project fix after confirming what it changes, and shows the report it returns", async () => {
    const { fix, getReport } = installAdeMock();
    renderPage(<LocationPage />, "/settings?tab=location");

    expect(await screen.findByText("2 things need attention")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update paths" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Update paths?" });
    expect(within(confirm).getByText("Points every saved path at the new folder.")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Update paths" }));

    await waitFor(() => expect(fix).toHaveBeenCalledWith({ fixId: "update-paths" }, null));
    expect(await screen.findByText("1 thing needs attention")).toBeTruthy();
    expect(await screen.findByText("Updated 14 saved paths.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    await waitFor(() => expect(getReport).toHaveBeenLastCalledWith({ forceRefresh: true }, null));
  });

  it("shows the view that holds the card a link names", async () => {
    installAdeMock({ withExtras: true });
    (window.ade as any).sessions = { getLifecycleSettings: vi.fn(async () => ({ autoSettleLaneSessionsOnPrMerge: true })) };
    (window.ade as any).project = { getSnapshot: vi.fn(() => new Promise(() => undefined)), onStateEvent: vi.fn(() => () => undefined) };
    // jsdom draws no layout; the page scrolls the named card into view.
    Element.prototype.scrollIntoView = vi.fn();
    renderStorage("/settings?tab=storage#session-lifecycle");
    expect(await screen.findByRole("tab", { name: /^Rules/, selected: true })).toBeTruthy();
    expect(await screen.findByText("Auto-settle sessions when lane PR merges")).toBeTruthy();
    // The lane list belongs to another view and is not drawn.
    expect(screen.queryByRole("button", { name: /check again/i })).toBeNull();
  });

  it("reads the project's machine through its pin and keeps this computer's service numbers off another machine's page", async () => {
    const { getReport, getResourceUsage, getRuntimeHealth } = installAdeMock({ withExtras: true });
    const binding = { key: "remote:studio" } as unknown as OpenProjectBinding;
    const studio: ScopeInput = {
      machineId: "studio",
      machineName: "Mac Studio",
      target: { kind: "pinned", binding },
      isThisMachine: false,
      isActiveBinding: true,
      online: true,
    };
    renderLanes("/settings?tab=lanes-git", studio);
    await waitFor(() => expect(window.ade.storage.getSnapshot).toHaveBeenCalledWith({ forceRefresh: undefined }, binding));
    expect(getReport).toHaveBeenCalledWith({ forceRefresh: undefined }, binding);
    cleanup();

    renderPage(<ServiceStatusSection />, "/settings?tab=service&machine=studio", { ...studio, isActiveBinding: false });
    expect(await screen.findByText(/Only on this computer/)).toBeTruthy();
    expect(getResourceUsage).not.toHaveBeenCalled();
    expect(getRuntimeHealth).not.toHaveBeenCalled();
  });

  it("bulk-archives only lanes that lose nothing, checks each again first, and names the ones it skipped", async () => {
    const report = makeReport();
    report.lanes = [
      makeLane("primary", { laneType: "primary", name: "main" }),
      makeLane("merged-clean", { stale: "pr-merged", pr: { number: 12, state: "merged", url: null, mergedAt: null } }),
      makeLane("idle-picked-up-work", { stale: "idle" }),
      makeLane("closed-dirty", { stale: "pr-closed", dirty: true, changedFileCount: 2, safeToArchive: false }),
      makeLane("merged-then-committed", { stale: "pr-merged", pr: { number: 13, state: "merged", url: null, mergedAt: null } }),
    ];
    const { archiveAndReclaim, getReclaimRisk, getReport } = installAdeMock({ report });
    // Since the list was read, a chat started in one lane, and another lane
    // whose PR merged got new commits: the merged PR no longer covers them.
    getReport.mockImplementation(async (args?: { forceRefresh?: boolean }) => (args?.forceRefresh
      ? { ...report, lanes: report.lanes!.map((lane) => (lane.laneId === "merged-then-committed" ? { ...lane, unpushedCommits: 2 } : lane)) }
      : report));
    getReclaimRisk.mockImplementation(async ({ laneId }: { laneId: string }) => ({
      laneId,
      laneName: laneId,
      worktreePath: `${PROJECT}/.ade/worktrees/${laneId}`,
      hasUnpushedCommits: laneId === "merged-then-committed",
      blockedReasons: laneId === "idle-picked-up-work"
        ? [{ code: "active_work", disposition: "confirmation_required", message: "A chat is running" }]
        : [],
    }) as unknown as LaneReclaimRisk);
    renderLanes();
    await openView("Your lanes");

    // A lane with unsaved work can't be picked for the bulk archive.
    const dirty = await screen.findByRole("checkbox", { name: /closed-dirty: It has uncommitted changes/ });
    expect((dirty as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("checkbox", { name: /main/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Select 3 safe to archive" }));
    fireEvent.click(screen.getByRole("button", { name: /^Archive 3 lanes/ }));
    const confirm = await screen.findByRole("alertdialog", { name: "Archive 3 lanes?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Archive 3 lanes" }));

    await waitFor(() => expect(getReclaimRisk).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/Skipped idle-picked-up-work: A chat is running/)).toBeTruthy();
    expect(screen.getByText(/Skipped merged-then-committed: It has commits that aren't pushed/)).toBeTruthy();
    expect(archiveAndReclaim).toHaveBeenCalledTimes(1);
    expect(archiveAndReclaim).toHaveBeenCalledWith({ laneId: "merged-clean", confirmation: "RECLAIM" }, null);
  });
});
