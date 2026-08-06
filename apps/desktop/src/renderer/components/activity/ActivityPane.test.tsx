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
  window.localStorage.clear();
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

function agentsColumn(): HTMLElement {
  return screen.getByRole("region", { name: "Agents" });
}

function notificationsColumn(): HTMLElement {
  return screen.getByRole("region", { name: "Notifications" });
}

function openDetail(title: string) {
  fireEvent.click(within(agentsColumn()).getByTitle(new RegExp(`^${title} —`)));
}

function sessionRow(title: string) {
  return within(agentsColumn()).queryByTitle(new RegExp(`^${title} —`));
}

function prItem(id: string, patch: Partial<AttentionItem> = {}): AttentionItem {
  return item(id, {
    kind: "pull_request",
    eventKind: "pr_checks_failing",
    phase: "checks_failing",
    provider: null,
    model: null,
    title: `PR ${id}`,
    ...patch,
  });
}

describe("ActivityPane", () => {
  it("splits agents from notifications so one lane cannot render twice", () => {
    const needsYou = item("approval");
    const running = item("running", {
      phase: "running",
      eventKind: "agent_running",
      title: "Task running",
    });
    const pr = prItem("checks");
    activityStore.setState({ itemsById: { approval: needsYou, running, checks: pr } });

    render(<ActivityPane open onClose={() => {}} />);

    const agents = agentsColumn();
    const notifications = notificationsColumn();
    expect(within(agents).getByTitle(/^Task approval —/)).toBeTruthy();
    expect(within(agents).getByTitle(/^Task running —/)).toBeTruthy();
    // The pull request is a notification, not a session — and it appears once.
    expect(within(agents).queryByTitle(/^PR checks —/)).toBeNull();
    expect(within(notifications).getByText("PR checks")).toBeTruthy();
    // A raised hand is a session, so it does not double as a notification row.
    expect(within(notifications).queryByText("Task approval")).toBeNull();
  });

  it("counts sessions and notifications apart in the header", () => {
    activityStore.setState({
      itemsById: { approval: item("approval"), checks: prItem("checks") },
    });
    render(<ActivityPane open onClose={() => {}} />);

    expect(screen.getByText(/1 session · 1 notification · 1 machine online/)).toBeTruthy();
  });

  it("reveals long session lists one bounded page at a time", () => {
    const itemsById = Object.fromEntries(Array.from({ length: 61 }, (_unused, index) => {
      const id = `running-${String(index).padStart(2, "0")}`;
      return [id, item(id, {
        eventKind: "agent_running",
        phase: "running",
        title: `Running ${index}`,
      })];
    }));
    activityStore.setState({ itemsById });
    render(<ActivityPane open onClose={() => {}} />);

    const sessions = agentsColumn();
    expect(sessions.querySelectorAll("[data-activity-row]")).toHaveLength(60);
    fireEvent.click(within(sessions).getByRole("button", { name: "Show 1 more" }));
    expect(sessions.querySelectorAll("[data-activity-row]")).toHaveLength(61);
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
    // The state, in words, is the first thing the sheet says.
    expect(within(sheet).getByText("Codex is asking a question")).toBeTruthy();
    expect(within(sheet).getByText("Waiting for a safe decision")).toBeTruthy();
    expect(within(sheet).getByText("GPT-5")).toBeTruthy();
    expect(within(sheet).getByText("Edited AuthService.ts")).toBeTruthy();
    // One primary action. Approve/deny would only sometimes work — the machine
    // is frequently not this one — and a button that sometimes lies is worse
    // than a button that sends you where it always works.
    expect(within(sheet).getByRole("button", { name: /Open chat/ })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /Deny/ })).toBeNull();

    const progress = within(sheet).getByRole("progressbar", { name: "Plan progress" });
    expect(progress.getAttribute("aria-valuenow")).toBe("2");
    expect(progress.getAttribute("aria-valuemax")).toBe("4");
    expect(within(sheet).getByText(/2 of 4 · Verify the approval flow/)).toBeTruthy();

    // The columns are still mounted underneath — that is the point of a sheet.
    expect(agentsColumn()).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: /Open chat/ }));

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
    fireEvent.click(screen.getByRole("button", { name: /Open chat/ }));

    await waitFor(() => {
      expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ id: "approval" }));
      expect(activityStore.getState().itemsById.approval?.seenAt).not.toBeNull();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("says a machine is offline without disabling the way in", () => {
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
    // Opening reconnects, so it stays live; dismiss is local bookkeeping and
    // never needed the machine at all.
    expect(
      (within(sheet).getByRole("button", { name: /Open chat/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
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

  it("dismisses one notification row without touching the rest", async () => {
    const acknowledge = vi.fn(async () => {});
    installAde({ acknowledge });
    activityStore.setState({
      itemsById: { first: prItem("first"), second: prItem("second") },
    });
    render(<ActivityPane open onClose={() => {}} />);

    fireEvent.click(within(notificationsColumn())
      .getByRole("button", { name: "Dismiss PR first" }));

    await waitFor(() => {
      expect(activityStore.getState().itemsById.first?.dismissedAt).not.toBeNull();
    });
    expect(activityStore.getState().itemsById.second?.dismissedAt).toBeNull();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  /**
   * Clear all fired one acknowledge per row before this: N races against the
   * revision fence, N rollbacks, and a bare `.catch(() => {})` swallowing every
   * explanation — which is exactly what "the button does nothing" looked like.
   */
  it("clears the whole inbox in a single acknowledge", async () => {
    const acknowledge = vi.fn(async () => {});
    installAde({ acknowledge });
    activityStore.setState({
      itemsById: { first: prItem("first"), second: prItem("second") },
    });
    render(<ActivityPane open onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    await waitFor(() => {
      expect(activityStore.getState().itemsById.first?.dismissedAt).not.toBeNull();
      expect(activityStore.getState().itemsById.second?.dismissedAt).not.toBeNull();
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ itemIds: ["first", "second"] }),
    );
  });

  it("says so, and puts the rows back, when clearing fails", async () => {
    const acknowledge = vi.fn(async () => {
      throw new Error("One or more Activity items changed after they loaded.");
    });
    installAde({ acknowledge });
    activityStore.setState({
      itemsById: { first: prItem("first"), second: prItem("second") },
    });
    render(<ActivityPane open onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("couldn’t clear 2 items");
    });
    expect(screen.getByRole("alert").textContent).toContain("changed after they loaded");
    // Rolled back together: a half-cleared list is a state nobody believes.
    expect(activityStore.getState().itemsById.first?.dismissedAt).toBeNull();
    expect(activityStore.getState().itemsById.second?.dismissedAt).toBeNull();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  /**
   * A genuine per-item refusal: the row moved underneath the user, so refresh
   * IS the right instruction and the copy has to say what changed.
   */
  it("names the rows that changed when the host refuses part of a clear", async () => {
    const acknowledge = vi.fn(async () => ({
      acknowledged: ["first"],
      stale: ["second"],
    }));
    installAde({ acknowledge });
    activityStore.setState({
      itemsById: { first: prItem("first"), second: prItem("second") },
    });
    render(<ActivityPane open onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent)
        .toContain("Cleared 1 of 2. 1 item changed while you were reading");
    });
    expect(screen.getByRole("alert").textContent).toContain("refresh Activity");
    expect(activityStore.getState().itemsById.first?.dismissedAt).not.toBeNull();
    expect(activityStore.getState().itemsById.second?.dismissedAt).toBeNull();
  });

  /**
   * The same rollback, a different truth. A "Clear all" bigger than one relay
   * batch aborts at the first chunk that fails, so the rest was never answered
   * for — expired auth, a 5xx, a rejected preflight. Those rows did NOT change
   * underneath anyone, and sending the user to refresh a list that is already
   * correct is the lie this copy replaces.
   */
  it("says the request could not be reached rather than claiming rows changed", async () => {
    const acknowledge = vi.fn(async () => ({
      acknowledged: ["first"],
      stale: [],
      unreached: ["second"],
      unreachedReason: "Failed to fetch",
    }));
    installAde({ acknowledge });
    activityStore.setState({
      itemsById: { first: prItem("first"), second: prItem("second") },
    });
    render(<ActivityPane open onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent)
        .toContain("Cleared 1 of 2. ADE couldn’t reach 1 item");
    });
    const alert = screen.getByRole("alert").textContent!;
    expect(alert).toContain("try again");
    // The failure itself, so the user is not left guessing at the cause.
    expect(alert).toContain("Failed to fetch");
    // The stale sentence must not appear: nothing changed, and refreshing
    // Activity would show exactly the same list back.
    expect(alert).not.toContain("changed while you were reading");
    expect(alert).not.toContain("refresh Activity");
    // Rollback is unchanged: the unreached row comes back.
    expect(activityStore.getState().itemsById.first?.dismissedAt).not.toBeNull();
    expect(activityStore.getState().itemsById.second?.dismissedAt).toBeNull();
  });

  /**
   * Idle roster rows never expire and were dismissable from nowhere: the rows
   * that outlive everything were the only ones with no way out.
   */
  it("gives every session row a way out, including the idle tail", async () => {
    const acknowledge = vi.fn(async () => {});
    installAde({ acknowledge });
    activityStore.setState({
      itemsById: {
        idle: item("idle", {
          phase: "stale",
          eventKind: "agent_running",
          activityTier: "idle",
          title: "Task idle",
        }),
      },
    });
    render(<ActivityPane open onClose={() => {}} />);

    fireEvent.click(within(agentsColumn())
      .getByRole("button", { name: "Dismiss Task idle" }));

    await waitFor(() => {
      expect(activityStore.getState().itemsById.idle?.dismissedAt).not.toBeNull();
    });
  });

  it("collapses a section and remembers it for the next open", () => {
    activityStore.setState({ itemsById: { approval: item("approval") } });
    const view = render(<ActivityPane open onClose={() => {}} />);

    const header = () => document.body.querySelector<HTMLButtonElement>(
      '[data-activity-section-toggle="needs-you"]',
    )!;
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(sessionRow("Task approval")).toBeTruthy();

    fireEvent.click(header());
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(sessionRow("Task approval")).toBeNull();
    // The region the header claims to control is the one that went away.
    expect(document.getElementById(header().getAttribute("aria-controls")!)?.hidden).toBe(true);

    view.unmount();
    render(<ActivityPane open onClose={() => {}} />);
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(sessionRow("Task approval")).toBeNull();
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

  it("filters to one project and makes the counts follow", async () => {
    activityStore.setState({
      itemsById: {
        here: item("here", { phase: "running", eventKind: "agent_running" }),
        elsewhere: item("elsewhere", {
          phase: "running",
          eventKind: "agent_running",
          project: { projectId: "notes", name: "Notes", rootPath: "/repo/notes" },
        }),
      },
    });
    render(<ActivityPane open onClose={() => {}} />);

    expect(screen.getByText(/2 sessions ·/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Notes" }));

    await waitFor(() => expect(sessionRow("Task here")).toBeNull());
    expect(sessionRow("Task elsewhere")).toBeTruthy();
    // The number the user reads has to describe the list they are looking at.
    expect(screen.getByText(/1 session ·/)).toBeTruthy();
  });

  it("reads an over-filtered column as a filter result, not as all-clear", async () => {
    activityStore.setState({
      itemsById: {
        here: item("here", { phase: "running", eventKind: "agent_running" }),
        elsewhere: item("elsewhere", {
          phase: "running",
          eventKind: "agent_running",
          machine: {
            machineKey: "laptop",
            name: "MacBook",
            online: true,
            lastSeenAt: null,
          },
          project: { projectId: "notes", name: "Notes", rootPath: "/repo/notes" },
        }),
      },
    });
    render(<ActivityPane open onClose={() => {}} />);

    // One machine, the other machine's project: an intersection with nothing
    // in it, which is a filter result and must not read as "all agents idle".
    fireEvent.click(screen.getByRole("button", { name: "Filter by machine" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Studio Mac" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Notes" }));

    await waitFor(() => expect(screen.getByText("No sessions match")).toBeTruthy());
    expect(screen.queryByText("All agents idle")).toBeNull();
    expect(screen.getByText("Nothing here matches")).toBeTruthy();
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

    expect(screen.getByText(/2 sessions · 1 of 2 machines online/)).toBeTruthy();
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
