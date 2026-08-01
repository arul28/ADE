// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionItem,
} from "../../../shared/types";
import {
  activityStore,
  resetActivityStoreForTests,
} from "../../state/activityStore";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "../../lib/account";
import { ActivityPane } from "./ActivityPane";

const originalAde = window.ade;
const signedInAccount = {
  signedIn: true as const,
  userId: "account-a",
  email: null,
  name: null,
  expiresAt: null,
  provider: null,
  imageUrl: null,
};

function item(id: string, patch: Partial<AttentionItem> = {}): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id,
    revision: 1,
    fingerprint: `fingerprint-${id}`,
    kind: "agent",
    eventKind: "agent_needs_you",
    phase: "needs_you",
    machine: {
      machineKey: "studio",
      name: "Studio Mac",
      online: true,
      lastSeenAt: "2026-07-28T14:00:00.000Z",
    },
    project: { projectId: "ade", name: "ADE", rootPath: "/repo/ade" },
    laneName: "attention-revamp",
    provider: "codex",
    model: "GPT-5",
    title: `Task ${id}`,
    preview: "Waiting for a safe decision",
    privacyPreview: "Agent needs your attention",
    detail: "The agent reached an approval checkpoint.",
    recentActivity: ["Edited AuthService.ts", "Ran focused tests"],
    planProgress: { completed: 2, total: 4, current: "Verify the approval flow" },
    destination: { kind: "session", sessionId: `session-${id}` },
    actions: [
      { id: `approve-${id}`, kind: "approve", label: "Approve" },
      { id: `deny-${id}`, kind: "deny", label: "Deny" },
    ],
    occurredAt: "2026-07-28T14:00:00.000Z",
    updatedAt: "2026-07-28T14:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...patch,
  };
}

function installAde(overrides: Record<string, unknown> = {}) {
  const attention = {
    getSnapshot: vi.fn(),
    acknowledge: vi.fn(async () => {}),
    reportPresence: vi.fn(),
    getPreferences: vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES),
    putPreferences: vi.fn(async () => {}),
    openItem: vi.fn(async () => {}),
    ...overrides,
  };
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: {
      ...(originalAde ?? {}),
      account: { status: vi.fn(async () => signedInAccount) },
      attention,
    },
  });
  return attention;
}

beforeEach(() => {
  publishAccountStatus(signedInAccount);
  installAde();
});

afterEach(() => {
  cleanup();
  resetActivityStoreForTests();
  publishAccountStatus(SIGNED_OUT_ACCOUNT);
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: originalAde,
  });
});

/** Rows appear in both columns; the sessions card is the one under test. */
function openDetail(title: string) {
  const sessions = screen.getByRole("region", { name: "Sessions" });
  fireEvent.click(within(sessions).getByTitle(new RegExp(`^${title} —`)));
}

function sessionRow(title: string) {
  const sessions = screen.getByRole("region", { name: "Sessions" });
  return within(sessions).queryByTitle(new RegExp(`^${title} —`));
}

describe("ActivityPane", () => {
  it("renders both columns at once so neither question hides the other", () => {
    const needsYou = item("approval");
    const running = item("running", {
      phase: "running",
      eventKind: "agent_running",
      title: "Task running",
    });
    activityStore.setState({ itemsById: { approval: needsYou, running } });

    render(<ActivityPane open onClose={() => {}} />);

    const sessions = screen.getByRole("region", { name: "Sessions" });
    const inbox = screen.getByRole("region", { name: "Inbox" });
    expect(within(sessions).getByTitle(/^Task approval —/)).toBeTruthy();
    expect(within(sessions).getByTitle(/^Task running —/)).toBeTruthy();
    // Running work is not an inbox item: nothing is waiting on the reader.
    expect(within(inbox).queryByText("Task running")).toBeNull();
    expect(within(inbox).getByText("Task approval")).toBeTruthy();
  });

  it("never offers the placeholder copy the old center apologised with", () => {
    activityStore.setState({ itemsById: { approval: item("approval") } });
    render(<ActivityPane open onClose={() => {}} />);

    expect(screen.queryByText(/Ready when you are/i)).toBeNull();
    expect(screen.queryByText(/Nothing selected/i)).toBeNull();
  });

  it("designs the all-clear state instead of leaving a gap", async () => {
    render(<ActivityPane open onClose={() => {}} />);

    // Opening the pane kicks a refresh, so the all-clear is what is left once
    // that settles — not what shows while it is in flight.
    expect(await screen.findByText("All agents idle")).toBeTruthy();
    expect(screen.getByText("Inbox zero")).toBeTruthy();
  });

  it("holds placeholders rather than claiming all-clear before the first snapshot", () => {
    activityStore.setState({ syncStatus: "syncing" });
    render(<ActivityPane open onClose={() => {}} />);

    // "All agents idle" is a claim, and before a snapshot lands it is one ADE
    // has no grounds for — a user would read it and stop looking.
    expect(screen.queryByText("All agents idle")).toBeNull();
    expect(
      document.body.querySelectorAll("[data-activity-skeleton]").length,
    ).toBeGreaterThan(0);
  });

  it("slides the detail over the columns with the item's real content", () => {
    activityStore.setState({ itemsById: { approval: item("approval") } });
    render(<ActivityPane open onClose={() => {}} />);

    openDetail("Task approval");

    const sheet = screen.getByRole("dialog", { name: "Task approval detail" });
    expect(within(sheet).getByText("Waiting for a safe decision")).toBeTruthy();
    expect(within(sheet).getByText("GPT-5")).toBeTruthy();
    expect(within(sheet).getByText("Edited AuthService.ts")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /Approve/ })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /Deny/ })).toBeTruthy();

    const progress = within(sheet).getByRole("progressbar", { name: "Plan progress" });
    expect(progress.getAttribute("aria-valuenow")).toBe("2");
    expect(progress.getAttribute("aria-valuemax")).toBe("4");
    expect(within(sheet).getByText(/2 of 4 · Verify the approval flow/)).toBeTruthy();

    // The columns are still mounted underneath — that is the point of a sheet.
    expect(screen.getByRole("region", { name: "Sessions" })).toBeTruthy();
  });

  it("closes the detail before the pane, one layer per Escape", () => {
    const onClose = vi.fn();
    activityStore.setState({ itemsById: { approval: item("approval") } });
    render(<ActivityPane open onClose={onClose} />);

    openDetail("Task approval");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Task approval detail" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a click outside and on the backdrop", () => {
    const onClose = vi.fn();
    render(<ActivityPane open onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close Activity backdrop" }));
    expect(onClose).toHaveBeenCalled();

    onClose.mockClear();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps clicks inside the pane from closing it", () => {
    const onClose = vi.fn();
    activityStore.setState({ itemsById: { approval: item("approval") } });
    render(<ActivityPane open onClose={onClose} />);

    fireEvent.mouseDown(screen.getByTestId("activity-pane"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens exact context before acknowledging, and reports a failure honestly", async () => {
    const openItem = vi.fn(async () => {
      throw new Error("Studio Mac stopped responding.");
    });
    installAde({ openItem });
    activityStore.setState({ itemsById: { approval: item("approval") } });
    render(<ActivityPane open onClose={() => {}} />);

    openDetail("Task approval");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Studio Mac stopped responding.");
    });
    expect(activityStore.getState().itemsById.approval?.seenAt).toBeNull();
  });

  it("marks an item seen only once its destination resolved", async () => {
    const onClose = vi.fn();
    const openItem = vi.fn(async () => {});
    installAde({ openItem });
    activityStore.setState({ itemsById: { approval: item("approval") } });
    render(<ActivityPane open onClose={onClose} />);

    openDetail("Task approval");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ id: "approval" }));
      expect(activityStore.getState().itemsById.approval?.seenAt).not.toBeNull();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("disables remote actions for last-known state from an offline machine", () => {
    activityStore.setState({
      itemsById: {
        offline: item("offline", {
          machine: {
            machineKey: "cloud",
            name: "Cloud Mac",
            online: false,
            lastSeenAt: "2026-07-28T13:00:00.000Z",
          },
        }),
      },
    });
    render(<ActivityPane open onClose={() => {}} />);

    openDetail("Task offline");
    const sheet = screen.getByRole("dialog", { name: "Task offline detail" });
    expect(within(sheet).getByText(/Cloud Mac is offline\./)).toBeTruthy();
    expect(
      (within(sheet).getByRole("button", { name: /Approve/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // Dismiss is local bookkeeping, so it stays live while the machine is away.
    expect(
      (within(sheet).getByRole("button", { name: /Dismiss/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("files an offline machine's sessions under a last-seen divider", () => {
    activityStore.setState({
      itemsById: {
        here: item("here"),
        gone: item("gone", {
          machine: {
            machineKey: "cloud",
            name: "Cloud Mac",
            online: false,
            lastSeenAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
          },
        }),
      },
    });
    render(<ActivityPane open onClose={() => {}} />);

    // The pane is portalled to the body, so the render container is empty.
    const divider = document.body.querySelector('[data-activity-offline-machine="cloud"]');
    expect(divider).toBeTruthy();
    expect(divider!.textContent).toContain("Cloud Mac");
    expect(divider!.textContent).toContain("last seen");
    // The dimmed group holds that machine's row, and only that machine's row.
    const group = divider!.closest(".activity-offline-group")!;
    expect(group.querySelector('[data-activity-row="gone"]')).toBeTruthy();
    expect(group.querySelector('[data-activity-row="here"]')).toBeNull();
  });

  it("dismisses one inbox row without touching the rest", async () => {
    const acknowledge = vi.fn(async () => {});
    installAde({ acknowledge });
    activityStore.setState({
      itemsById: { first: item("first"), second: item("second") },
    });
    render(<ActivityPane open onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Task first" }));

    await waitFor(() => {
      expect(activityStore.getState().itemsById.first?.dismissedAt).not.toBeNull();
    });
    expect(activityStore.getState().itemsById.second?.dismissedAt).toBeNull();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("clears the whole inbox from its header", async () => {
    installAde();
    activityStore.setState({
      itemsById: { first: item("first"), second: item("second") },
    });
    render(<ActivityPane open onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    await waitFor(() => {
      expect(activityStore.getState().itemsById.first?.dismissedAt).not.toBeNull();
      expect(activityStore.getState().itemsById.second?.dismissedAt).not.toBeNull();
    });
  });

  it("filters both columns by machine and says so when nothing matches", async () => {
    activityStore.setState({
      itemsById: {
        studio: item("studio"),
        laptop: item("laptop", {
          machine: {
            machineKey: "laptop",
            name: "MacBook",
            online: true,
            lastSeenAt: null,
          },
        }),
      },
    });
    render(<ActivityPane open onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Filter by machine" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "MacBook" }));

    await waitFor(() => expect(sessionRow("Task studio")).toBeNull());
    expect(sessionRow("Task laptop")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(sessionRow("Task studio")).toBeTruthy());
  });

  it("explains an empty column as a filter result, not as all-clear", async () => {
    activityStore.setState({
      itemsById: {
        studio: item("studio", { model: "GPT-5" }),
      },
    });
    render(<ActivityPane open onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Filter by type" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Agents" }));
    // Selecting the only kind present keeps everything visible…
    expect(sessionRow("Task studio")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter by model" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "GPT-5" }));
    expect(sessionRow("Task studio")).toBeTruthy();
  });

  it("counts machines and sessions in the header", () => {
    activityStore.setState({
      itemsById: {
        studio: item("studio"),
        cloud: item("cloud", {
          machine: {
            machineKey: "cloud",
            name: "Cloud Mac",
            online: false,
            lastSeenAt: "2026-07-28T13:00:00.000Z",
          },
        }),
      },
    });
    render(<ActivityPane open onClose={() => {}} />);

    expect(screen.getByText(/1 of 2 machines online · 2 sessions/)).toBeTruthy();
  });

  it("renders nothing at all when closed", () => {
    activityStore.setState({ itemsById: { approval: item("approval") } });
    render(<ActivityPane open={false} onClose={() => {}} />);

    expect(screen.queryByTestId("activity-pane")).toBeNull();
  });

  it("drops the detail when its item leaves the snapshot", async () => {
    activityStore.setState({ itemsById: { approval: item("approval") } });
    render(<ActivityPane open onClose={() => {}} />);
    openDetail("Task approval");

    act(() => {
      activityStore.setState({ itemsById: {} });
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Task approval detail" })).toBeNull();
    });
  });
});
