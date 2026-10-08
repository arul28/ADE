// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionItem,
  type AttentionPhase,
} from "../../../shared/types";
import {
  activityStore,
  resetActivityStoreForTests,
} from "../../state/activityStore";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "../../lib/account";
import { HeaderActivityControl } from "./HeaderActivityControl";

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

let openItem: ReturnType<typeof vi.fn>;
let acknowledge: ReturnType<typeof vi.fn>;
let getSnapshot: ReturnType<typeof vi.fn>;
let captureAnalytics: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  publishAccountStatus(signedInAccount);
  openItem = vi.fn(async () => {});
  acknowledge = vi.fn(async () => {});
  captureAnalytics = vi.fn(async () => ({ accepted: true, reason: "accepted" }));
  getSnapshot = vi.fn(async () => ({
    contractVersion: ATTENTION_CONTRACT_VERSION,
    revision: activityStore.getState().revision,
    generatedAt: "2026-08-01T12:00:00.000Z",
    items: Object.values(activityStore.getState().itemsById),
  }));
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: {
      ...(originalAde ?? {}),
      account: {
        ...(originalAde?.account ?? {}),
        status: vi.fn(async () => signedInAccount),
      },
      attention: {
        openItem,
        acknowledge,
        getSnapshot,
        getPreferences: vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES),
      },
      analytics: { capture: captureAnalytics },
    },
  });
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

function item(
  id: string,
  phase: AttentionPhase,
  patch: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id,
    revision: 1,
    fingerprint: `fingerprint-${id}`,
    kind: "agent",
    eventKind: "agent_needs_you",
    phase,
    machine: {
      machineKey: "studio",
      name: "Studio Mac",
      online: true,
      lastSeenAt: "2026-08-01T11:59:00.000Z",
    },
    project: { projectId: "ade", name: "ADE", rootPath: "/repo/ade" },
    laneName: `lane-${id}`,
    provider: "codex",
    model: "gpt-5.6-sol",
    title: `Task ${id}`,
    preview: "preview",
    privacyPreview: "private preview",
    destination: { kind: "session", sessionId: `session-${id}` },
    actions: [],
    occurredAt: "2026-08-01T11:58:00.000Z",
    updatedAt: "2026-08-01T11:58:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...patch,
  };
}

function seedItems(items: AttentionItem[]): void {
  activityStore.setState({
    itemsById: Object.fromEntries(items.map((entry) => [entry.id, entry])),
    generatedAt: "2026-08-01T12:00:00.000Z",
    syncStatus: "ready",
  });
}

function renderControl(onOpenPane = vi.fn()) {
  render(<HeaderActivityControl onOpenPane={onOpenPane} />);
  return onOpenPane;
}

function openPanel(): HTMLElement {
  fireEvent.click(screen.getByTestId("header-activity-trigger"));
  return screen.getByRole("dialog", { name: "Activity" });
}

describe("HeaderActivityControl", () => {
  it("badges only work that needs you, and records a bounded header open", async () => {
    seedItems([
      item("a", "needs_you"),
      item("b", "running"),
      item("c", "failed"),
      item("d", "merge_ready", { kind: "pull_request", eventKind: "pr_merge_ready" }),
    ]);
    renderControl();

    const trigger = screen.getByTestId("header-activity-trigger");
    // The badge is the Needs you column: a raised hand and a failure (the
    // user's move too). A pull request is not a session at all.
    expect(trigger.textContent).toContain("2");
    expect(trigger.getAttribute("aria-label"))
      .toBe("Activity · 2 need you · 1 working");
    expect(trigger.getAttribute("data-state")).toBe("waiting");

    fireEvent.click(trigger);
    await waitFor(() => {
      // Analytics identity is deliberately unchanged by the rename.
      expect(captureAnalytics).toHaveBeenCalledWith({
        event: "ade_feature_used",
        properties: {
          feature: "attention",
          action: "header_opened",
          outcome: "opened",
          source: "renderer_route",
        },
        dedupeKey: "attention_header_opened",
        minimumIntervalMs: 60 * 60_000,
      });
    });
  });

  it("shows a live pulse without a count when nothing needs you", () => {
    seedItems([item("b", "running")]);
    renderControl();

    const trigger = screen.getByTestId("header-activity-trigger");
    expect(trigger.getAttribute("data-state")).toBe("live");
    expect(trigger.textContent).toBe("");
    expect(trigger.getAttribute("aria-label")).toBe("Activity · 1 working");
  });

  /**
   * Done is the most common state and the least urgent, so it folds into one
   * "N done" line. The line opens it in place and its heading folds it back.
   */
  it("groups rows by column and folds Done until it is opened", () => {
    seedItems([
      item("done", "completed"),
      item("live", "running"),
      item("asks", "needs_you"),
      item("broke", "failed"),
    ]);
    renderControl();
    const dialog = openPanel();

    expect(activityStore.getState().headerSurfaceVisible).toBe(true);
    const columns = () => Array.from(
      dialog.querySelectorAll<HTMLElement>("[data-activity-column]"),
    ).map((section) => section.getAttribute("data-activity-column"));
    const rows = () => Array.from(dialog.querySelectorAll("[data-activity-row]"))
      .map((row) => row.getAttribute("data-activity-row"));
    expect(columns()).toEqual(["needs_you", "working"]);
    expect(rows()).not.toContain("done");

    const fold = () => dialog.querySelector<HTMLButtonElement>("[data-activity-done-fold]");
    expect(fold()?.textContent).toContain("1 done");
    fireEvent.click(fold()!);
    expect(columns()).toEqual(["needs_you", "working", "done"]);
    expect(rows()).toContain("done");

    fireEvent.click(dialog.querySelector<HTMLButtonElement>('[data-activity-section-toggle="done"]')!);
    expect(rows()).not.toContain("done");
    expect(fold()).toBeTruthy();
  });

  /**
   * The chips are the summary and the filter at once: picking one lists only
   * that column, and every chip keeps its count so the way back stays visible.
   */
  it("narrows to one column from the chips and keeps every chip's count", () => {
    seedItems([
      item("asks", "needs_you"),
      item("live", "running"),
      item("ci", "running", { boardColumn: "waiting", waitingReason: "ci" }),
    ]);
    renderControl();
    const dialog = openPanel();
    const chips = within(screen.getByTestId("activity-column-chips"));
    const rows = () => Array.from(dialog.querySelectorAll("[data-activity-row]"))
      .map((row) => row.getAttribute("data-activity-row"));

    fireEvent.click(chips.getByRole("radio", { name: /Waiting/ }));
    expect(rows()).toEqual(["ci"]);
    expect(within(dialog).getByText("CI running")).toBeTruthy();
    expect(chips.getByRole("radio", { name: /Needs you/ }).textContent).toContain("1");
    expect(chips.getByRole("radio", { name: /Working/ }).textContent).toContain("1");

    fireEvent.click(chips.getByRole("radio", { name: /All/ }));
    expect(rows()).toEqual(expect.arrayContaining(["asks", "live", "ci"]));
  });

  /**
   * Per-surface memory for the Inbox's project groups: the dropdown is a
   * glance and the pane is a work session, so folding a group in one must not
   * fold it in the other.
   */
  it("remembers a folded Inbox group for the popover only", () => {
    seedItems([
      item("pr", "checks_failing", { kind: "pull_request", eventKind: "pr_checks_failing" }),
    ]);
    renderControl();
    openPanel();

    fireEvent.click(screen.getByRole("tab", { name: /Inbox/ }));
    fireEvent.click(document.body.querySelector<HTMLButtonElement>(
      '[data-activity-section-toggle="notifications:ADE"]',
    )!);

    expect(window.localStorage.getItem("ade:activity:collapsed-sections-popover"))
      .toBe(JSON.stringify(["notifications:ADE"]));
    expect(window.localStorage.getItem("ade:activity:collapsed-sections-pane")).toBeNull();
  });

  it("gives every row a way out, and clears it with one call", async () => {
    seedItems([item("live", "running")]);
    renderControl();
    openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Task live" }));

    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ itemIds: ["live"] }),
    ));
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("omits a section with nothing in it rather than showing an empty heading", () => {
    seedItems([item("live", "running")]);
    renderControl();
    const dialog = openPanel();

    expect(Array.from(dialog.querySelectorAll("[data-activity-column]"))
      .map((section) => section.getAttribute("data-activity-column"))).toEqual(["working"]);
    expect(screen.queryByRole("heading", { name: /Needs you/ })).toBeNull();
  });

  it("caps a section at six rows and offers the rest to the pane", () => {
    seedItems(
      Array.from({ length: 8 }, (_unused, index) => item(`n${index}`, "needs_you")),
    );
    const onOpenPane = renderControl();
    const dialog = openPanel();

    expect(dialog.querySelectorAll("[data-activity-row]").length).toBe(6);
    const overflow = screen.getByRole("button", { name: /2 more/ });
    fireEvent.click(overflow);
    expect(onOpenPane).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("designs the all-clear state instead of apologising for empty space", () => {
    seedItems([]);
    renderControl();
    const dialog = openPanel();

    expect(within(dialog).getByText("Nothing running")).toBeTruthy();
    expect(screen.getByTestId("header-activity-trigger").getAttribute("aria-label"))
      .toBe("Activity · nothing running");
  });

  it("never restates its own name in a filler caption", () => {
    seedItems([item("a", "needs_you")]);
    renderControl();
    const dialog = openPanel();

    const head = dialog.querySelector(".activity-hdr-panel-head");
    expect(head?.querySelector("p")).toBeNull();
    expect(dialog.textContent).not.toContain("Activity is live");
    expect(dialog.textContent).not.toContain("Across every machine");
  });

  it("counts sessions and machines in the footer and hands off to the pane", () => {
    seedItems([
      item("a", "needs_you"),
      item("b", "running", {
        machine: {
          machineKey: "laptop",
          name: "MacBook Pro",
          online: false,
          lastSeenAt: "2026-08-01T10:00:00.000Z",
        },
      }),
      item("pr", "checks_failing", {
        kind: "pull_request",
        eventKind: "pr_checks_failing",
      }),
    ]);
    const onOpenPane = renderControl();
    const dialog = openPanel();

    const footer = dialog.querySelector(".activity-hdr-panel-foot") as HTMLElement;
    // Sessions are sessions; the pull request is counted as what it is.
    expect(within(footer).getByText(
      "2 sessions · 1 notification · 1 of 2 machines online",
    )).toBeTruthy();
    expect(dialog.textContent).toContain("last-known state from an offline machine");

    fireEvent.click(within(footer).getByRole("button", { name: /Open all/ }));
    expect(onOpenPane).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /**
   * "Some of this is remembered, not observed" is the headline; "which machines
   * and how long ago" is the follow-up, and it costs four lines of a dropdown
   * to answer unprompted.
   */
  it("names the offline machines behind a disclosure", () => {
    seedItems([
      item("a", "running", {
        machine: {
          machineKey: "laptop",
          name: "MacBook Pro",
          online: false,
          lastSeenAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        },
      }),
      item("b", "running", {
        machine: {
          machineKey: "cloud",
          name: "Cloud Mac",
          online: false,
          lastSeenAt: null,
        },
      }),
    ]);
    renderControl();
    openPanel();

    const disclosure = screen.getByRole("button", { name: /2 machines/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    const list = document.getElementById(disclosure.getAttribute("aria-controls")!)!;
    expect(list.hidden).toBe(true);

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(list.hidden).toBe(false);
    expect(list.textContent).toContain("Cloud Mac");
    expect(list.textContent).toContain("never seen");
    expect(list.textContent).toContain("MacBook Pro");
    expect(list.textContent).toContain("last seen");
  });

  /**
   * The one unambiguously good transition in Activity, and until now the only
   * one with no representation: the section just stopped existing.
   */
  it("plays an all-clear beat when the last raised hand goes down", async () => {
    seedItems([item("a", "needs_you")]);
    renderControl();
    openPanel();
    expect(document.body.querySelector("[data-activity-all-clear]")).toBeNull();

    act(() => {
      seedItems([item("a", "completed")]);
    });

    await waitFor(() => expect(
      document.body.querySelector("[data-activity-all-clear]")?.textContent,
    ).toContain("All clear"));
  });

  it("never celebrates an account that was already quiet when it opened", () => {
    seedItems([]);
    renderControl();
    openPanel();

    expect(document.body.querySelector("[data-activity-all-clear]")).toBeNull();
  });

  it("opens the exact destination through the Activity bridge, then marks it seen", async () => {
    seedItems([item("a", "needs_you")]);
    renderControl();
    openPanel();

    fireEvent.click(document.body.querySelector<HTMLButtonElement>('[data-activity-row="a"]')!);

    await waitFor(() =>
      expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ id: "a" })),
    );
    await waitFor(() =>
      expect(acknowledge).toHaveBeenCalledWith(
        expect.objectContaining({ itemIds: ["a"] }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the item unseen and explains a failed navigation", async () => {
    seedItems([item("a", "needs_you")]);
    openItem.mockRejectedValueOnce(new Error("Studio Mac is offline"));
    renderControl();
    openPanel();

    fireEvent.click(document.body.querySelector<HTMLButtonElement>('[data-activity-row="a"]')!);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Studio Mac is offline"),
    );
    expect(acknowledge).not.toHaveBeenCalled();
    expect(activityStore.getState().itemsById.a?.seenAt).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("supports keyboard open, roving row navigation, and Escape returning focus", () => {
    seedItems([
      item("a", "needs_you"),
      item("b", "needs_you"),
      item("pr", "checks_failing", { kind: "pull_request", eventKind: "pr_checks_failing" }),
    ]);
    renderControl();

    const trigger = screen.getByTestId("header-activity-trigger");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const dialog = screen.getByRole("dialog", { name: "Activity" });

    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-activity-row")).toBe("a");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-activity-row")).toBe("b");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-activity-row")).toBe("a");
    fireEvent.keyDown(dialog, { key: "End" });
    expect(document.activeElement?.getAttribute("data-activity-row")).toBe("b");
    fireEvent.keyDown(dialog, { key: "Home" });
    expect(document.activeElement?.getAttribute("data-activity-row")).toBe("a");

    // The Inbox moves the same way.
    fireEvent.click(within(dialog).getByRole("tab", { name: /Inbox/ }));
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-activity-row")).toBe("pr");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("hides agent text on every row when the account asks for hide-details", () => {
    seedItems([item("a", "needs_you")]);
    activityStore.setState({
      preferences: {
        ...DEFAULT_ATTENTION_PREFERENCES,
        account: { ...DEFAULT_ATTENTION_PREFERENCES.account, hideDetails: true },
      },
    });
    renderControl();
    openPanel();

    expect(screen.getByText("private preview")).toBeTruthy();
    expect(screen.queryByText("preview")).toBeNull();
  });

  it("offers a retry instead of pretending a failed sync is current", async () => {
    seedItems([item("a", "needs_you")]);
    getSnapshot.mockRejectedValue(new Error("Relay unreachable"));
    renderControl();

    fireEvent.click(screen.getByTestId("header-activity-trigger"));
    const retry = await screen.findByRole("button", {
      name: /Activity is unavailable · Retry/,
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
  });

  it("stays honest when signed out instead of showing an empty account", () => {
    publishAccountStatus(SIGNED_OUT_ACCOUNT);
    renderControl();

    const trigger = screen.getByTestId("header-activity-trigger");
    expect(trigger.getAttribute("data-state")).toBe("signed-out");
    expect(trigger.getAttribute("aria-label")).toBe(
      "Activity · sign in to sync across machines",
    );

    fireEvent.click(trigger);
    expect(
      screen.getByText(/Sign in to ADE to follow agents and pull requests/),
    ).toBeTruthy();
  });

  it("keeps machine-local work visible while signed out", () => {
    publishAccountStatus(SIGNED_OUT_ACCOUNT);
    seedItems([item("local", "needs_you")]);
    activityStore.setState({
      snapshotScope: "machine",
      availability: {
        state: "signed_out",
        title: "Showing this computer",
        message: "Sign in to combine Activity across every ADE machine.",
        recovery: "sign_in",
        hostName: "This computer",
      },
    });
    renderControl();

    const trigger = screen.getByTestId("header-activity-trigger");
    expect(trigger.getAttribute("data-state")).toBe("waiting");
    expect(trigger.textContent).toContain("1");
    expect(trigger.getAttribute("aria-label")).toContain("this machine only");

    fireEvent.click(trigger);
    expect(screen.getByRole("heading", { name: /Needs you/ })).toBeTruthy();
    expect(
      screen.getByText(/Sign in to combine Activity across every ADE machine/),
    ).toBeTruthy();
  });
});
