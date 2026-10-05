/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ArchiveSection } from "./ArchiveSection";
import { confirmDialog } from "../ui/dialog/confirm";
import type { ArchivedItem, ArchiveActionArgs, ArchiveActionResult } from "../../../shared/types/archive";

/**
 * Settings → Archive. The piece worth pinning is the delete batching: a lane
 * delete is slow and one request has a budget, so lanes go a handful at a time,
 * and a dirty lane is retried once with `force` only after the person confirms.
 * The rest of the page is presentation.
 */

vi.mock("../ui/dialog/confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/dialog/confirm")>()),
  confirmDialog: vi.fn(async () => true),
}));

vi.mock("../app/toast/toastStore", () => ({
  showToast: vi.fn(),
}));

const OLD = "2020-01-01T00:00:00.000Z";
const originalAde = (globalThis.window as any)?.ade;

function laneItem(id: string, title: string): ArchivedItem {
  return {
    kind: "lane",
    id,
    title,
    laneId: id,
    laneName: title,
    archivedAt: OLD,
    sizeBytes: null,
    worktreePresent: true,
    branchRef: `feat/${id}`,
  };
}

function installArchiveMock(
  items: ArchivedItem[],
  deleteImpl: (args: ArchiveActionArgs) => Promise<ArchiveActionResult>,
) {
  const deleteMock = vi.fn(deleteImpl);
  (globalThis.window as any).ade = {
    archive: {
      list: vi.fn(async () => ({ items })),
      summary: vi.fn(async () => ({})),
      restore: vi.fn(async () => ({ done: [], failed: [] })),
      delete: deleteMock,
    },
  };
  return deleteMock;
}

afterEach(() => {
  cleanup();
  if (originalAde === undefined) delete (globalThis.window as any).ade;
  else (globalThis.window as any).ade = originalAde;
  vi.mocked(confirmDialog).mockReset();
  vi.mocked(confirmDialog).mockResolvedValue(true);
});

describe("ArchiveSection delete batching", () => {
  it("sends archived lanes at most five per request", async () => {
    const items = Array.from({ length: 7 }, (_, index) => laneItem(`lane-${index}`, `Old lane ${index}`));
    const deleteMock = installArchiveMock(items, async ({ items: refs }) => ({ done: refs, failed: [] }));

    render(<ArchiveSection />);
    fireEvent.click(await screen.findByRole("button", { name: /delete all/i }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2));
    const batches = deleteMock.mock.calls.map((call) => call[0].items);
    expect(batches.map((batch) => batch.length)).toEqual([5, 2]);
    expect(batches.flat().every((ref) => ref.kind === "lane")).toBe(true);
    // The first pass is not forced: a dirty lane must be surfaced, not discarded.
    expect(deleteMock.mock.calls.every((call) => call[0].force == null)).toBe(true);
  });

  it("retries a dirty lane once with force after the person confirms", async () => {
    const items = [laneItem("lane-dirty", "Busy lane")];
    const deleteMock = installArchiveMock(items, async ({ items: refs, force }) => {
      if (!force) {
        return { done: [], failed: [{ kind: "lane", id: refs[0]!.id, error: "Lane 'lane-dirty' has uncommitted changes." }] };
      }
      return { done: refs, failed: [] };
    });
    vi.mocked(confirmDialog).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    render(<ArchiveSection />);
    fireEvent.click(await screen.findByRole("button", { name: /delete all/i }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2));
    expect(deleteMock.mock.calls[0]![0].force).toBeUndefined();
    expect(deleteMock.mock.calls[0]![0].items).toEqual([{ kind: "lane", id: "lane-dirty" }]);
    expect(deleteMock.mock.calls[1]![0].force).toBe(true);
    expect(deleteMock.mock.calls[1]![0].items).toEqual([{ kind: "lane", id: "lane-dirty" }]);
  });
});
