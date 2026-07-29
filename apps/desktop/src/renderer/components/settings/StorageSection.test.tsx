/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expectNoJargon } from "../../../test/jargonGuard";
import { StorageSection } from "./StorageSection";
import type {
  MaintenanceRunReport,
  RuntimeHealthSnapshot,
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
  StorageSnapshot,
  StorageSnapshotExtras,
} from "../../../shared/types/storage";
import type {
  AppResourceUsageSnapshot,
  LaneCleanupConfig,
  LaneReclaimRisk,
  ProjectConfigCandidate,
} from "../../../shared/types";

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
          { ledgerId: "automation.ingress_events", kind: "prune", itemsAffected: 200, bytesReclaimed: 450 * MB, durationMs: 40 },
          { ledgerId: "operations", kind: "compact", itemsAffected: 0, bytesReclaimed: 30 * MB, durationMs: 60 },
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
            { ledgerId: "automation.ingress_events", kind: "prune", itemsAffected: 200, bytesReclaimed: 450 * MB, durationMs: 40 },
            { ledgerId: "operations", kind: "compact", itemsAffected: 0, bytesReclaimed: 30 * MB, durationMs: 60 },
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
        { ledgerId: "automation.ingress_events", kind: "prune", itemsAffected: 200, bytesReclaimed: 450 * MB, durationMs: 40 },
      ],
      reclaimedBytes: 481 * MB,
      dbSizeBytes: 30 * MB,
    }),
  );
  const getRuntimeHealth = vi.fn(
    async (): Promise<RuntimeHealthSnapshot> => ({ slowActions24h: 3, slowActionP95Ms: 5_200, sampledAt: new Date().toISOString() }),
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
  };
}

describe("StorageSection", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else (globalThis.window as any).ade = originalAde;
  });

  it("renders every storage category from the snapshot", async () => {
    installAdeMock();
    render(<StorageSection />);

    // Category names appear on both the card and the breakdown-bar legend.
    await screen.findByText(/ADE is using/);
    for (const name of [
      "Chats & terminal history",
      "Lanes & worktrees",
      "Build & release files",
      "Caches",
      "Proof & attachments",
      "Recovery backups",
      "Project database",
    ]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    // Headline usage sentence with free-space context.
    expect(screen.getByText(/free on this disk/)).toBeTruthy();
  });

  it("shows archived and orphaned lane rows with sizes, and no action for protected items", async () => {
    installAdeMock();
    render(<StorageSection />);

    // Archived lane (label prominent) and its size.
    expect((await screen.findAllByText("Old feature")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.5 GB").length).toBeGreaterThan(0);
    // Orphaned lane.
    expect(screen.getAllByText("ghost-lane").length).toBeGreaterThan(0);
    expect(screen.getByText(/Left over from a deleted lane/)).toBeTruthy();
    expect(screen.getByText("45 days")).toBeTruthy();
    expect(screen.getByText("20 days")).toBeTruthy();
    // Active lane is shown but protected.
    expect(screen.getAllByText("main-lane").length).toBeGreaterThan(0);

    // Archived lanes use the guarded reclaim flow; only the orphan uses generic file cleanup.
    const removeButtons = screen.getAllByRole("button", { name: /remove files/i });
    expect(removeButtons).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /archive & reclaim/i }).length).toBeGreaterThan(0);

    // Protected data has no destructive affordance.
    expect(screen.getByText("Chat session records")).toBeTruthy();
    expect(screen.getByText(/This is your project's live data/)).toBeTruthy();
  });

  it("preserves ADE casing in proof cleanup", async () => {
    installAdeMock();
    render(<StorageSection />);

    const proofCard = (await screen.findByRole("heading", { name: "Proof & attachments" })).closest("section")!;
    fireEvent.click(within(proofCard).getByRole("button", { name: "Remove…" }));
    expect(await screen.findByRole("dialog", { name: "Remove Proof and recordings" })).toBeTruthy();
  });

  it("directs blocked proof cleanup to the proof drawer", async () => {
    installAdeMock();
    const blockedSnapshot = makeSnapshot();
    const proof = blockedSnapshot.categories.find((category) => category.id === "proof_attachments")!;
    proof.items = [];
    vi.mocked(window.ade.storage.getSnapshot).mockResolvedValue(blockedSnapshot);
    render(<StorageSection />);

    expect(await screen.findByText(/Open the proof drawer in a chat to delete individual items/)).toBeTruthy();
  });

  it("runs the cleanup flow: previews then removes the same targets and reports freed space", async () => {
    const { cleanupPreview, cleanup: cleanupFn } = installAdeMock();
    render(<StorageSection />);

    const removeButtons = await screen.findAllByRole("button", { name: /remove files/i });
    fireEvent.click(removeButtons[0]);

    // Generic cleanup is reserved for the orphaned worktree.
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledTimes(1));
    const previewTargets = cleanupPreview.mock.calls[0][0];
    expect(previewTargets).toEqual([
      { kind: "orphaned_worktree", path: ORPHANED_PATH },
    ]);

    const confirm = await within(dialog).findByRole("button", { name: /remove 1 item/i });
    fireEvent.click(confirm);

    await waitFor(() => expect(cleanupFn).toHaveBeenCalledTimes(1));
    // Cleanup uses the exact same targets it previewed.
    expect(cleanupFn.mock.calls[0][0]).toEqual(previewTargets);
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
    render(<StorageSection />);

    const trigger = (await screen.findAllByRole("button", { name: /archive & reclaim/i }))[0]!;
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: /archive & reclaim old feature/i });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "RECLAIM" } });

    const confirm = within(dialog).getByRole("button", { name: /confirm discarded changes/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /discard uncommitted changes/i }));
    expect((within(dialog).getByRole("button", { name: /reclaim 1\.5 GB/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: /reclaim 1\.5 GB/i }));

    await waitFor(() => expect(archiveAndReclaim).toHaveBeenCalledWith({
      laneId: "lane-old",
      confirmation: "RECLAIM",
      forceDirty: true,
    }));
  });

  it("keeps reclaim focus inside the dialog and closes it on Escape", async () => {
    installAdeMock();
    render(<StorageSection />);

    const trigger = (await screen.findAllByRole("button", { name: /archive & reclaim/i }))[0]!;
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: /archive & reclaim old feature/i });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /archive & reclaim/i })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("saves only local lane cleanup overrides and shows inherited values as guidance", async () => {
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
    render(<StorageSection />);

    const inherited = await screen.findByLabelText(/Archive after inactivity/i);
    expect((inherited as HTMLInputElement).value).toBe("");
    expect((inherited as HTMLInputElement).placeholder).toBe("Inherited: 24");
    fireEvent.click(screen.getByRole("button", { name: /save storage rules/i }));

    await waitFor(() => expect(saveProjectConfig).toHaveBeenCalledTimes(1));
    const saved = saveProjectConfig.mock.calls[0]![0];
    const savedLaneCleanup = saved.local.laneCleanup;
    expect(savedLaneCleanup).toBeDefined();
    expect(savedLaneCleanup!.maxActiveLanes).toBe(3);
    expect(savedLaneCleanup!.autoArchiveAfterHours).toBeUndefined();
    expect(savedLaneCleanup!.cleanupIntervalHours).toBeUndefined();
    expect(savedLaneCleanup!.reclaimArchivedAfterHours).toBeUndefined();
  });

  it("hides the compress action when compressNow is unavailable", async () => {
    installAdeMock({ withCompress: false });
    render(<StorageSection />);

    await screen.findByText(/ADE is using/);
    expect(screen.queryByRole("button", { name: /compress old history/i })).toBeNull();
  });

  it("shows and runs the compress action when compressNow exists", async () => {
    const { compressNow } = installAdeMock({ withCompress: true });
    render(<StorageSection />);

    const compressButton = await screen.findByRole("button", { name: /compress old history/i });
    fireEvent.click(compressButton);

    await waitFor(() => expect(compressNow).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Compressed 12 files, freed 300 MB/)).toBeTruthy();
  });

  it("uses plain language with no internal jargon", async () => {
    installAdeMock();
    const { container } = render(<StorageSection />);
    await screen.findByText(/ADE is using/);
    expectNoJargon(container.textContent ?? "");
  });

  it("still offers safe cleanup for an obsolete backup when the daemon cache estimate is zero", async () => {
    installAdeMock({ extras: { ...makeExtras(), safeReclaimableBytes: 0 } });
    render(<StorageSection />);
    await screen.findByText(/ADE is using/);
    expect(screen.getByRole("button", { name: /clean up safely/i })).toBeTruthy();
  });

  it("previews and removes safe filesystem targets before running maintenance", async () => {
    const { cleanupPreview, cleanup: cleanupFn, runMaintenanceNow } = installAdeMock({ withExtras: true });
    render(<StorageSection />);

    const primary = await screen.findByRole("button", { name: /clean up safely/i });
    fireEvent.click(primary);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("iOS build data")).toBeTruthy();
    expect(within(dialog).getByText("npm")).toBeTruthy();
    expect(within(dialog).getByText("Obsolete recovery backup")).toBeTruthy();
    expect(within(dialog).queryByText("Newest recovery backup")).toBeNull();
    expect(within(dialog).getAllByText(/newest (recovery )?backup/i).length).toBeGreaterThan(0);
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledTimes(1));
    const previewTargets = cleanupPreview.mock.calls[0][0];
    expect(previewTargets).toEqual([
      { kind: "rebuildable_cache", path: `${PROJECT}/.ade/cache/ios-simulator/DerivedData` },
      { kind: "rebuildable_cache", path: `${PROJECT}/.ade/cache/npm` },
      { kind: "recovery_backup", path: `${PROJECT}/.ade/ade.db.bak-2026-06-01` },
    ]);
    const confirm = await within(dialog).findByRole("button", { name: /clean up safely/i });
    fireEvent.click(confirm);

    await waitFor(() => expect(cleanupFn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runMaintenanceNow).toHaveBeenCalledTimes(1));
    expect(cleanupFn).toHaveBeenCalledWith(previewTargets, {
      preview: await cleanupPreview.mock.results[0]!.value,
    });
    expect(cleanupFn.mock.invocationCallOrder[0]).toBeLessThan(runMaintenanceNow.mock.invocationCallOrder[0]!);
    expect(await within(dialog).findByText(/Freed 2\.0 GB/)).toBeTruthy();
  });

  it("shows the database breakdown and runs maintenance from an inline action", async () => {
    const { runMaintenanceNow } = installAdeMock({ withExtras: true });
    render(<StorageSection />);

    // Human-labeled breakdown rows replace the blanket "Protected" body.
    expect(await screen.findByText("Webhook history")).toBeTruthy();
    expect(screen.getByText("Sync bookkeeping")).toBeTruthy();
    expect(screen.getByText("Core data")).toBeTruthy();
    // Pending compaction is surfaced without jargon and without an action.
    expect(screen.getByText(/Waiting to compact/)).toBeTruthy();

    const compact = screen.getByRole("button", { name: /compact now/i });
    fireEvent.click(compact);
    await waitFor(() => expect(runMaintenanceNow).toHaveBeenCalledTimes(1));
  });

  it("reports a zero-byte partial maintenance failure instead of calling storage tidy", async () => {
    const failedReport: MaintenanceRunReport = {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      trigger: "manual",
      actions: [
        { ledgerId: "db.operations_crsql", kind: "compact", itemsAffected: 0, bytesReclaimed: 0, durationMs: 3, error: "database busy" },
      ],
      reclaimedBytes: 0,
      dbSizeBytes: 30 * MB,
    };
    const { runMaintenanceNow } = installAdeMock({ withExtras: true, maintenanceReport: failedReport });
    render(<StorageSection />);

    fireEvent.click(await screen.findByRole("button", { name: /compact now/i }));
    await waitFor(() => expect(runMaintenanceNow).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Some cleanup steps couldn't finish")).toBeTruthy();
    expect(screen.queryByText("Storage is already tidy")).toBeNull();
  });

  it("shows a partial maintenance failure in the safe-cleanup dialog", async () => {
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
    render(<StorageSection />);

    fireEvent.click(await screen.findByRole("button", { name: /clean up safely/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /clean up safely/i }));
    expect(await within(dialog).findByText(/some cleanup steps couldn't finish/i)).toBeTruthy();
    expect(within(dialog).queryByText("Storage is already tidy.")).toBeNull();
  });

  it("renders diagnostics from resource usage and the maintenance journal", async () => {
    installAdeMock({ withExtras: true });
    render(<StorageSection />);

    expect(await screen.findByText(/Health & diagnostics/)).toBeTruthy();
    // Daemon resident memory from the ade-runtime role.
    expect(await screen.findByText("280 MB")).toBeTruthy();
    // Overall health chip from the resource-pressure level.
    expect(await screen.findByText("Healthy")).toBeTruthy();
    // Slow-actions tile from getRuntimeHealth.
    expect(screen.getByText(/3 slow responses in 24h/)).toBeTruthy();

    // Journal expands to show a humanized run summary.
    fireEvent.click(screen.getByRole("button", { name: /recent cleanups/i }));
    expect(await screen.findByText(/reclaimed 450 MB/)).toBeTruthy();
  });

  it("does not label unavailable resource-pressure data as healthy", async () => {
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
    render(<StorageSection />);

    await waitFor(() => expect(getResourceUsage).toHaveBeenCalledTimes(1));
    await screen.findByText("Health & diagnostics");
    expect(screen.queryByText("Healthy")).toBeNull();
  });

  it("keeps plain language across the diagnostics and database surfaces", async () => {
    installAdeMock({ withExtras: true });
    const { container } = render(<StorageSection />);
    await screen.findByText("Webhook history");
    fireEvent.click(screen.getByRole("button", { name: /recent cleanups/i }));
    fireEvent.click(await screen.findByRole("button", { name: /clean up safely/i }));
    await screen.findByRole("dialog");
    expectNoJargon(container.textContent ?? "");
  });
});
