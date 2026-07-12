/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StorageSection } from "./StorageSection";
import type {
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
  StorageSnapshot,
} from "../../../shared/types/storage";

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
          { id: "l-archived", label: "Old feature", path: ARCHIVED_PATH, bytes: 1.5 * 1024 ** 3, fileCount: 100, lastModifiedAt: null, safety: "review_first", laneStatus: "archived", detail: "Archived lane — its files are kept until you remove them" },
          { id: "l-orphaned", label: "ghost-lane", path: ORPHANED_PATH, bytes: 512 * 1024 ** 2, fileCount: 50, lastModifiedAt: null, safety: "review_first", laneStatus: "orphaned", detail: "Left over from a deleted lane" },
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
        bytes: 80 * 1024 ** 2,
        fileCount: 2,
        safety: "review_first",
        items: [
          { id: "r1", label: "Recovery backup", path: `${PROJECT}/.ade/ade.db.bak-2026-07-01`, bytes: 80 * 1024 ** 2, fileCount: 1, lastModifiedAt: new Date().toISOString(), safety: "review_first" },
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

function installAdeMock(options: { withCompress?: boolean } = {}) {
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

  const storage: Record<string, unknown> = {
    getSnapshot: vi.fn(async () => makeSnapshot()),
    getPressure: vi.fn(async () => ({ state: "normal", freeBytes: 40 * 1024 ** 3, totalBytes: 500 * 1024 ** 3, freeFraction: 0.08, perRoot: [], sampledAt: new Date().toISOString() })),
    cleanupPreview,
    cleanup: cleanupFn,
  };
  if (options.withCompress) storage.compressNow = compressNow;

  (globalThis.window as any).ade = {
    storage,
    lanes: {
      list: vi.fn(async () => [
        { id: "lane-old", name: "Old feature", worktreePath: ARCHIVED_PATH, archivedAt: "2026-07-02T00:00:00.000Z", status: { dirty: false } },
        { id: "lane-main", name: "main-lane", worktreePath: ACTIVE_PATH, archivedAt: null, status: { dirty: false } },
      ]),
    },
  };
  return { cleanupPreview, cleanup: cleanupFn, compressNow };
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
    expect(await screen.findByText("Old feature")).toBeTruthy();
    expect(screen.getByText("1.5 GB")).toBeTruthy();
    // Orphaned lane.
    expect(screen.getByText("ghost-lane")).toBeTruthy();
    expect(screen.getByText(/Left over from a deleted lane/)).toBeTruthy();
    // Active lane is shown but protected.
    expect(screen.getByText("main-lane")).toBeTruthy();

    // One remove control per actionable lane (archived + orphaned), never the active one.
    const removeButtons = screen.getAllByRole("button", { name: /remove files/i });
    expect(removeButtons).toHaveLength(2);

    // Protected data has no destructive affordance.
    expect(screen.getByText("Chat session records")).toBeTruthy();
    expect(screen.getByText(/This is your project's live data/)).toBeTruthy();
  });

  it("runs the cleanup flow: previews then removes the same targets and reports freed space", async () => {
    const { cleanupPreview, cleanup: cleanupFn } = installAdeMock();
    render(<StorageSection />);

    const removeButtons = await screen.findAllByRole("button", { name: /remove files/i });
    fireEvent.click(removeButtons[0]);

    // Dialog previews the archived lane target.
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledTimes(1));
    const previewTargets = cleanupPreview.mock.calls[0][0];
    expect(previewTargets).toEqual([
      { kind: "archived_lane_worktree", laneId: "lane-old", path: ARCHIVED_PATH },
    ]);

    const confirm = await within(dialog).findByRole("button", { name: /remove 1 item/i });
    fireEvent.click(confirm);

    await waitFor(() => expect(cleanupFn).toHaveBeenCalledTimes(1));
    // Cleanup uses the exact same targets it previewed.
    expect(cleanupFn.mock.calls[0][0]).toEqual(previewTargets);
    expect(await within(dialog).findByText(/Freed 1\.5 GB/)).toBeTruthy();
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
    expect(container.textContent ?? "").not.toMatch(/CRR|JSONL|WAL|ENOSPC|SQLite|socket/i);
  });
});
