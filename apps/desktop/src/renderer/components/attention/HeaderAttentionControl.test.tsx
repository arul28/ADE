// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_CONTRACT_VERSION,
  type AttentionItem,
  type AttentionPhase,
} from "../../../shared/types";
import {
  attentionStore,
  resetAttentionStoreForTests,
} from "../../state/attentionStore";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "../../lib/account";
import { HeaderAttentionControl } from "./HeaderAttentionControl";
import {
  attentionHeaderTriggerLabel,
  summarizeAttentionForHeader,
} from "./attentionHeaderSummary";

const originalAde = window.ade;
const NOW = Date.parse("2026-07-29T12:00:00.000Z");
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
  publishAccountStatus(signedInAccount);
  openItem = vi.fn(async () => {});
  acknowledge = vi.fn(async () => {});
  captureAnalytics = vi.fn(async () => ({ accepted: true, reason: "accepted" }));
  getSnapshot = vi.fn(async () => ({
    contractVersion: ATTENTION_CONTRACT_VERSION,
    revision: attentionStore.getState().revision,
    generatedAt: "2026-07-29T12:00:00.000Z",
    items: Object.values(attentionStore.getState().itemsById),
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
      attention: { openItem, acknowledge, getSnapshot },
      analytics: {
        capture: captureAnalytics,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  resetAttentionStoreForTests();
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
      lastSeenAt: "2026-07-29T11:59:00.000Z",
    },
    project: { projectId: "ade", name: "ADE", rootPath: "/repo/ade" },
    provider: "codex",
    model: "GPT-5",
    title: `Task ${id}`,
    preview: "preview",
    privacyPreview: "private preview",
    destination: { kind: "session", sessionId: `session-${id}` },
    actions: [],
    occurredAt: "2026-07-29T11:58:00.000Z",
    updatedAt: "2026-07-29T11:58:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...patch,
  };
}

function seedItems(items: AttentionItem[]): void {
  attentionStore.setState({
    itemsById: Object.fromEntries(items.map((entry) => [entry.id, entry])),
    generatedAt: "2026-07-29T12:00:00.000Z",
    syncStatus: "ready",
  });
}

function byId(items: AttentionItem[]): Record<string, AttentionItem> {
  return Object.fromEntries(items.map((entry) => [entry.id, entry]));
}

function renderControl(onOpenCenter = vi.fn()) {
  render(<HeaderAttentionControl onOpenCenter={onOpenCenter} />);
  return onOpenCenter;
}

describe("HeaderAttentionControl", () => {
  it("badges only work waiting on you and records a bounded header open", async () => {
    seedItems([item("a", "needs_you"), item("b", "running"), item("c", "merge_ready")]);
    renderControl();

    const trigger = screen.getByTestId("header-attention-trigger");
    expect(trigger.textContent).toContain("2");
    expect(trigger.getAttribute("aria-label")).toBe(
      "Attention · 1 needs you · 1 to review · 1 live",
    );
    expect(trigger.getAttribute("data-state")).toBe("waiting");
    fireEvent.click(trigger);
    await waitFor(() => {
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

  it("shows a live pulse without a count when nothing is waiting", () => {
    seedItems([item("b", "running")]);
    renderControl();

    const trigger = screen.getByTestId("header-attention-trigger");
    expect(trigger.getAttribute("data-state")).toBe("live");
    expect(trigger.textContent).toBe("");
    expect(trigger.getAttribute("aria-label")).toBe("Attention · 1 live");
  });

  it("groups the popover across machines and projects", () => {
    seedItems([
      item("a", "needs_you"),
      item("b", "failed", {
        machine: {
          machineKey: "laptop",
          name: "Laptop",
          online: false,
          lastSeenAt: "2026-07-29T10:00:00.000Z",
        },
        project: { projectId: "web", name: "Web", rootPath: "/repo/web" },
      }),
      item("c", "running"),
      item("d", "completed"),
    ]);
    renderControl();

    fireEvent.click(screen.getByTestId("header-attention-trigger"));

    const dialog = screen.getByRole("dialog", { name: "Attention" });
    expect(attentionStore.getState().headerSurfaceVisible).toBe(true);
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Needs you/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Failing or blocked/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Done, unreviewed/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Live now/ })).toBeTruthy();
    expect(screen.getByText("1 of 2 machines online")).toBeTruthy();
    expect(screen.getByText("Web · Laptop (offline)")).toBeTruthy();
    expect(dialog.textContent).toContain("last-known state from an offline machine");
  });

  it("opens the exact destination through the attention bridge, then marks it seen", async () => {
    seedItems([item("a", "needs_you")]);
    renderControl();

    fireEvent.click(screen.getByTestId("header-attention-trigger"));
    fireEvent.click(screen.getByRole("button", { name: /Task a/ }));

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

    fireEvent.click(screen.getByTestId("header-attention-trigger"));
    fireEvent.click(screen.getByRole("button", { name: /Task a/ }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(
      "Studio Mac is offline",
    ));
    expect(acknowledge).not.toHaveBeenCalled();
    expect(attentionStore.getState().itemsById.a?.seenAt).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("hands off to the full center from Open all and from a truncated section", () => {
    seedItems([
      item("a", "needs_you"),
      item("b", "needs_you"),
      item("c", "needs_you"),
      item("d", "needs_you"),
      item("e", "needs_you"),
    ]);
    const onOpenCenter = renderControl();

    fireEvent.click(screen.getByTestId("header-attention-trigger"));
    expect(screen.getByText("1 more in Attention")).toBeTruthy();

    fireEvent.click(screen.getByText("1 more in Attention"));
    expect(onOpenCenter).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("header-attention-trigger"));
    fireEvent.click(screen.getByRole("button", { name: /Open all/ }));
    expect(onOpenCenter).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("supports keyboard open, arrow navigation, and Escape returning focus", () => {
    seedItems([item("a", "needs_you"), item("b", "needs_you")]);
    renderControl();

    const trigger = screen.getByTestId("header-attention-trigger");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const dialog = screen.getByRole("dialog", { name: "Attention" });

    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-attention-header-row")).toBe("a");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-attention-header-row")).toBe("b");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-attention-header-row")).toBe("a");
    fireEvent.keyDown(dialog, { key: "End" });
    expect(document.activeElement?.getAttribute("data-attention-header-row")).toBe("b");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("offers a retry instead of pretending a failed sync is current", async () => {
    seedItems([item("a", "needs_you")]);
    getSnapshot.mockRejectedValue(new Error("Relay unreachable"));
    renderControl();

    fireEvent.click(screen.getByTestId("header-attention-trigger"));
    const retry = await screen.findByRole("button", {
      name: /Attention is unavailable · Retry/,
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
  });

  it("surfaces a missing native notch helper with recovery guidance", async () => {
    seedItems([]);
    const retry = vi.fn(async () => ({
      state: "missing" as const,
      title: "ADE Notch needs reinstalling",
      message: "Reinstall or update ADE, then restart the app.",
      recovery: "reinstall_or_update" as const,
      surface: null,
    }));
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(window.ade ?? {}),
        attentionNotch: {
          publishSnapshot: vi.fn(),
          updateSettings: vi.fn(),
          getHealth: retry,
          retry,
          onAcknowledgeRequested: vi.fn(() => () => {}),
        },
      },
    });
    renderControl();

    fireEvent.click(screen.getByTestId("header-attention-trigger"));

    expect(await screen.findByText("ADE Notch needs reinstalling")).toBeTruthy();
    expect(screen.getByText(/Reinstall or update ADE/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
  });

  it("stays honest when signed out instead of showing an empty account", () => {
    publishAccountStatus(SIGNED_OUT_ACCOUNT);
    renderControl();

    const trigger = screen.getByTestId("header-attention-trigger");
    expect(trigger.getAttribute("data-state")).toBe("signed-out");
    expect(trigger.getAttribute("aria-label")).toBe(
      "Attention · sign in to sync across machines",
    );

    fireEvent.click(trigger);
    expect(
      screen.getByText(/Sign in to ADE to follow agents and pull requests/),
    ).toBeTruthy();
  });

  it("keeps machine-local work visible while signed out", () => {
    publishAccountStatus(SIGNED_OUT_ACCOUNT);
    seedItems([item("local", "needs_you")]);
    attentionStore.setState({
      snapshotScope: "machine",
      availability: {
        state: "signed_out",
        title: "Showing this computer",
        message: "Sign in to combine Attention across every ADE machine.",
        recovery: "sign_in",
        hostName: "This computer",
      },
    });
    renderControl();

    const trigger = screen.getByTestId("header-attention-trigger");
    expect(trigger.getAttribute("data-state")).toBe("waiting");
    expect(trigger.textContent).toContain("1");
    expect(trigger.getAttribute("aria-label")).toContain("this machine only");

    fireEvent.click(trigger);
    expect(screen.getByText("Showing this computer")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Needs you/ })).toBeTruthy();
    expect(
      screen.getByText(/Sign in to combine Attention across every ADE machine/),
    ).toBeTruthy();
  });
});

describe("header Attention summary", () => {
  it("separates waiting work from ambient live work and leads with urgency", () => {
    const summary = summarizeAttentionForHeader(
      byId([
        item("needs", "needs_you"),
        item("failing", "checks_failing", { kind: "pull_request" }),
        item("running", "running"),
        item("starting", "starting"),
      ]),
      NOW,
    );

    expect(summary.waitingCount).toBe(2);
    expect(summary.liveCount).toBe(2);
    expect(summary.headline).toBe("1 needs you");
    expect(summary.tone).toBe("amber");
    expect(summary.buckets.map((bucket) => bucket.id)).toEqual([
      "needs_you",
      "blocked",
      "live",
    ]);
  });

  it("stops counting reviewed, dismissed, and expired outcomes without losing tracked history", () => {
    const summary = summarizeAttentionForHeader(
      byId([
        item("reviewed", "completed", { seenAt: "2026-07-29T11:59:00.000Z" }),
        item("dismissed", "needs_you", { dismissedAt: "2026-07-29T11:00:00.000Z" }),
        item("expired", "needs_you", { expiresAt: "2026-07-29T11:00:00.000Z" }),
        item("live", "running"),
      ]),
      NOW,
    );

    expect(summary.waitingCount).toBe(0);
    expect(summary.trackedCount).toBe(2);
    expect(summary.buckets.map((bucket) => bucket.id)).toEqual(["live"]);
  });

  it("reports offline ownership and orders each bucket by shared priority", () => {
    const summary = summarizeAttentionForHeader(
      byId([
        item("older", "failed", {
          updatedAt: "2026-07-29T10:00:00.000Z",
          machine: {
            machineKey: "laptop",
            name: "Laptop",
            online: false,
            lastSeenAt: "2026-07-29T10:00:00.000Z",
          },
        }),
        item("newer", "failed", { updatedAt: "2026-07-29T11:59:00.000Z" }),
      ]),
      NOW,
    );

    expect(summary.machinesTotal).toBe(2);
    expect(summary.machinesOnline).toBe(1);
    expect(summary.staleMachineCount).toBe(1);
    expect(summary.buckets[0]?.items.map((entry) => entry.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("enumerates each bucket in the trigger label and stays calm when clear", () => {
    const summary = summarizeAttentionForHeader(
      byId([
        item("needs", "needs_you"),
        item("review", "merge_ready"),
        item("live", "running"),
      ]),
      NOW,
    );

    expect(attentionHeaderTriggerLabel(summary)).toBe(
      "Attention · 1 needs you · 1 to review · 1 live",
    );
    expect(attentionHeaderTriggerLabel(summarizeAttentionForHeader({}, NOW)))
      .toBe("Attention · nothing waiting");
    expect(summarizeAttentionForHeader({}, NOW).tone).toBe("neutral");
  });

  /**
   * The header is the loudest surface ADE has, so amber there has to keep
   * meaning exactly one thing. A run that merely finished is an outcome, not a
   * request: it may collect in the badge, but it must not colour the bell.
   */
  it("lights amber only for work that needs the user, and emerald for finished work", () => {
    const doneOnly = summarizeAttentionForHeader(
      byId([item("done", "completed"), item("merged", "merged", { kind: "pull_request" })]),
      NOW,
    );

    expect(doneOnly.buckets.map((bucket) => bucket.id)).toEqual(["done"]);
    expect(doneOnly.tone).toBe("emerald");
    expect(doneOnly.headline).toBe("2 done");

    const raisedHand = summarizeAttentionForHeader(
      byId([item("done", "completed"), item("asks", "needs_you")]),
      NOW,
    );

    expect(raisedHand.tone).toBe("amber");
    expect(raisedHand.buckets.map((bucket) => bucket.id)).toEqual(["needs_you", "done"]);
    expect(raisedHand.buckets.map((bucket) => bucket.tone)).toEqual(["amber", "emerald"]);
  });

  it("separates an outstanding PR review from work that is simply finished", () => {
    const summary = summarizeAttentionForHeader(
      byId([
        item("review", "review_requested", { kind: "pull_request" }),
        item("done", "completed"),
      ]),
      NOW,
    );

    expect(summary.buckets.map((bucket) => bucket.id)).toEqual(["review", "done"]);
    expect(summary.buckets.map((bucket) => bucket.tone)).toEqual(["violet", "emerald"]);
    expect(attentionHeaderTriggerLabel(summary)).toBe("Attention · 1 to review · 1 done");
  });

  /**
   * Stale is a silence, not a signal. It used to share amber with a raised
   * hand; it must now neither colour the header nor inflate the badge.
   */
  it("keeps stale and already-open work out of every count", () => {
    const summary = summarizeAttentionForHeader(
      byId([
        item("quiet", "stale"),
        item("open", "open", { kind: "pull_request" }),
        item("closed", "closed", { kind: "pull_request" }),
      ]),
      NOW,
    );

    expect(summary.buckets).toEqual([]);
    expect(summary.waitingCount).toBe(0);
    expect(summary.liveCount).toBe(0);
    expect(summary.tone).toBe("neutral");
    expect(summary.headline).toBe("All clear");
    // Still tracked — the full Attention center can show them; the header just
    // stays quiet about them.
    expect(summary.trackedCount).toBe(3);
  });
});
