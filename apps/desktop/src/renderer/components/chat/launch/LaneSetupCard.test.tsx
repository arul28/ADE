/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatLaunchSnapshot, ChatLaunchStage, OpenProjectBinding } from "../../../../shared/types";
import {
  applyChatLaunchSnapshot,
  buildOptimisticChatLaunchSnapshot,
  getChatLaunchEntry,
  resetChatLaunchStoreForTests,
  useChatLaunchSnapshot,
} from "../../../state/chatLaunchStore";
import { dismissToast, getToasts } from "../../app/toast/toastStore";
import { LaneSetupCard, LaneSetupTranscriptCard, laneSetupActions } from "./LaneSetupCard";
import { buildLaneSetupCardPayload } from "./chatLaunchSynthetic";
import { resetChatLaunchDraftRestoreForTests, subscribeChatLaunchClosed } from "./chatLaunchDraftRestore";
import { launchClockSubscriberCountForTests } from "./launchClock";

const BINDING: OpenProjectBinding = { kind: "local", key: "local:/p", rootPath: "/p", displayName: "p" };

function stage(id: ChatLaunchStage["id"], status: ChatLaunchStage["status"], extra: Partial<ChatLaunchStage> = {}): ChatLaunchStage {
  return { id, status, startedAt: null, endedAt: null, percent: null, detail: null, error: null, ...extra };
}

function snapshot(overrides: Partial<ChatLaunchSnapshot> = {}): ChatLaunchSnapshot {
  return {
    ...buildOptimisticChatLaunchSnapshot({
      launch: {
        kind: "chat",
        mode: "foreground",
        launchId: "launch-1",
        laneId: "lane-1",
        laneName: "Fix Login Redirect",
        prompt: "Fix the login redirect",
      },
      includeFetch: true,
    }),
    sequence: 1,
    ...overrides,
  };
}

let chatLaunchApi: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  chatLaunchApi = {
    cancel: vi.fn(async () => snapshot({ phase: "cancelled", sequence: 9 })),
    retry: vi.fn(async () => null),
    startNow: vi.fn(async () => null),
  };
  (window as unknown as { ade: unknown }).ade = { chatLaunch: chatLaunchApi };
});

afterEach(() => {
  cleanup();
  resetChatLaunchStoreForTests();
  resetChatLaunchDraftRestoreForTests();
  for (const toast of getToasts()) dismissToast(toast.id);
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("laneSetupActions", () => {
  it("offers Cancel while running and Start now only while the environment runs", () => {
    expect(laneSetupActions(snapshot())).toEqual({ cancel: true, startNow: false, retry: false, startAnyway: false, delete: false });
    const envRunning = snapshot({ stages: [stage("checkout", "done"), stage("environment", "running"), stage("agent", "pending")] });
    expect(laneSetupActions(envRunning).startNow).toBe(true);
    expect(laneSetupActions({ ...envRunning, agentStarted: true }).startNow).toBe(false);
  });

  it("offers Retry and Delete on failure, and Start anyway only for an environment failure with a lane", () => {
    const fetchFailed = snapshot({ phase: "failed", stages: [stage("fetch", "failed"), stage("checkout", "pending"), stage("agent", "pending")] });
    expect(laneSetupActions(fetchFailed)).toMatchObject({ retry: true, delete: true, startAnyway: false, cancel: false });
    const envFailed = snapshot({
      phase: "failed",
      laneCreated: true,
      stages: [stage("checkout", "done"), stage("environment", "failed"), stage("agent", "pending")],
    });
    expect(laneSetupActions(envFailed).startAnyway).toBe(true);
    expect(laneSetupActions({ ...envFailed, laneCreated: false }).startAnyway).toBe(false);
  });
});

describe("LaneSetupCard", () => {
  it("renders one row per stage with its status, detail and live percent", () => {
    render(
      <LaneSetupCard
        snapshot={snapshot({
          stages: [
            stage("fetch", "done", { detail: "origin/main at 807fb2c", startedAt: "2026-09-22T10:00:00.000Z", endedAt: "2026-09-22T10:00:00.443Z" }),
            stage("checkout", "running", { percent: 62, startedAt: "2026-09-22T10:00:00.500Z" }),
            stage("environment", "warning", { detail: "Default template" }),
            stage("agent", "pending"),
          ],
        })}
      />,
    );
    const rows = screen.getAllByTestId("lane-setup-stage");
    expect(rows.map((row) => row.getAttribute("data-stage-status"))).toEqual(["done", "running", "warning", "pending"]);
    expect(within(rows[0]!).getByText("Fetch base branch")).toBeTruthy();
    expect(within(rows[0]!).getByText("origin/main at 807fb2c")).toBeTruthy();
    expect(within(rows[0]!).getByTestId("lane-setup-stage-duration").textContent).toBe("443ms");
    expect(within(rows[1]!).getByText("62%")).toBeTruthy();
    expect(screen.getByTestId("lane-setup-title").textContent).toBe("Setting up lane…");
    expect(screen.getByTestId("lane-setup-cancel")).toBeTruthy();
    expect(screen.queryByTestId("lane-setup-retry")).toBeNull();
  });

  it("shows the failure in amber with Retry, Start anyway and Delete", () => {
    render(
      <LaneSetupCard
        snapshot={snapshot({
          phase: "failed",
          laneCreated: true,
          error: "npm install failed",
          stages: [stage("checkout", "done"), stage("environment", "failed", { error: "npm install failed" }), stage("agent", "pending")],
        })}
      />,
    );
    expect(screen.getByTestId("lane-setup-title").textContent).toBe("Lane setup failed");
    expect(screen.getAllByText("npm install failed").length).toBeGreaterThan(0);
    expect(screen.getByTestId("lane-setup-retry")).toBeTruthy();
    expect(screen.getByTestId("lane-setup-start-anyway")).toBeTruthy();
    expect(screen.getByTestId("lane-setup-delete")).toBeTruthy();
    expect(screen.queryByTestId("lane-setup-cancel")).toBeNull();
  });

  it("cancels only after confirmation and hands the prompt back to the draft", async () => {
    applyChatLaunchSnapshot(BINDING, snapshot());
    const closed = vi.fn();
    const unsubscribe = subscribeChatLaunchClosed(closed);
    try {
      render(<LaneSetupCard snapshot={snapshot()} />);
      fireEvent.click(screen.getByTestId("lane-setup-cancel"));
      expect(chatLaunchApi.cancel).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Delete lane and chat" }));
      await waitFor(() => {
        expect(chatLaunchApi.cancel).toHaveBeenCalledWith({ launchId: "launch-1" }, BINDING);
      });
      await waitFor(() => expect(closed).toHaveBeenCalledWith({
        launchId: "launch-1",
        sessionId: "launch-1",
        kind: "chat",
        restoresPrompt: true,
      }));
      expect(getChatLaunchEntry("launch-1")?.snapshot.phase).toBe("cancelled");
    } finally {
      unsubscribe();
    }
  });

  it("re-checks the launch at confirm time and never cancels a chat that already started", async () => {
    applyChatLaunchSnapshot(BINDING, snapshot());
    // The card was rendered from an older snapshot; the store has moved on.
    render(<LaneSetupCard snapshot={snapshot()} />);
    fireEvent.click(screen.getByTestId("lane-setup-cancel"));
    applyChatLaunchSnapshot(BINDING, snapshot({ agentStarted: true, sessionCreated: true, sequence: 4 }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete lane and chat" }));
    expect(await screen.findByText("Setup finished — nothing to cancel")).toBeTruthy();
    expect(chatLaunchApi.cancel).not.toHaveBeenCalled();
  });

  it("closes an open cancel confirmation with a notice when setup finishes meanwhile", async () => {
    applyChatLaunchSnapshot(BINDING, snapshot());
    function Live() {
      const live = useChatLaunchSnapshot("launch-1");
      return live ? <LaneSetupCard snapshot={live} /> : null;
    }
    render(<Live />);
    fireEvent.click(screen.getByTestId("lane-setup-cancel"));
    expect(await screen.findByRole("button", { name: "Delete lane and chat" })).toBeTruthy();
    act(() => {
      applyChatLaunchSnapshot(BINDING, snapshot({ agentStarted: true, sessionCreated: true, sequence: 4 }));
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete lane and chat" })).toBeNull());
    expect(screen.getByTestId("lane-setup-notice").textContent).toBe("Setup finished — nothing to cancel");
    expect(chatLaunchApi.cancel).not.toHaveBeenCalled();
  });

  it("says so in a toast when finishing collapses the card under an open confirmation", async () => {
    applyChatLaunchSnapshot(BINDING, snapshot());
    render(<LaneSetupTranscriptCard card={buildLaneSetupCardPayload(snapshot())} />);
    fireEvent.click(screen.getByTestId("lane-setup-cancel"));
    expect(await screen.findByRole("button", { name: "Delete lane and chat" })).toBeTruthy();
    act(() => {
      applyChatLaunchSnapshot(BINDING, snapshot({
        phase: "completed",
        agentStarted: true,
        sessionCreated: true,
        sequence: 4,
        stages: [stage("fetch", "done"), stage("checkout", "done"), stage("agent", "done")],
      }));
    });
    expect(screen.getByTestId("lane-setup-summary")).toBeTruthy();
    expect(getToasts().map((toast) => toast.title)).toContain("Setup finished — nothing to cancel");
    expect(chatLaunchApi.cancel).not.toHaveBeenCalled();
  });

  it("shows the host's reason when it refuses the cancel", async () => {
    chatLaunchApi.cancel.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'ade.chatLaunch.cancel': Error: This chat already started — delete its lane from the lane menu instead.",
    ));
    applyChatLaunchSnapshot(BINDING, snapshot());
    render(<LaneSetupCard snapshot={snapshot()} />);
    fireEvent.click(screen.getByTestId("lane-setup-cancel"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete lane and chat" }));
    expect(await screen.findByText("This chat already started — delete its lane from the lane menu instead.")).toBeTruthy();
  });

  it("routes Start now to the host", async () => {
    const envRunning = snapshot({ stages: [stage("checkout", "done"), stage("environment", "running"), stage("agent", "pending")] });
    applyChatLaunchSnapshot(BINDING, envRunning);
    render(<LaneSetupCard snapshot={envRunning} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("lane-setup-start-now"));
    });
    expect(chatLaunchApi.startNow).toHaveBeenCalledWith({ launchId: "launch-1" }, BINDING);
  });
});

describe("LaneSetupCard progress rail and clock", () => {
  it("carries the shared segmented rail, scaling checkout by its percent with a transform", () => {
    render(
      <LaneSetupCard
        snapshot={snapshot({
          stages: [
            stage("fetch", "done"),
            stage("checkout", "running", { percent: 40, startedAt: new Date().toISOString() }),
            stage("agent", "pending"),
          ],
        })}
      />,
    );
    const rail = screen.getByTestId("launch-rail");
    const segments = Array.from(rail.children) as HTMLElement[];
    expect(segments.map((segment) => segment.getAttribute("data-stage-status"))).toEqual(["done", "running", "pending"]);
    const checkoutFill = segments[1]!.firstElementChild as HTMLElement;
    expect(checkoutFill.style.transform).toBe("scaleX(0.4)");
    expect(segments[1]!.querySelector("[data-launch-rail-sheen]")).toBeTruthy();
    expect(segments[0]!.querySelector("[data-launch-rail-sheen]")).toBeNull();
  });

  it("runs one shared clock only while a live duration is mounted", () => {
    const running = snapshot({
      stages: [stage("fetch", "running", { startedAt: new Date().toISOString() }), stage("checkout", "pending"), stage("agent", "pending")],
    });
    const { unmount } = render(<LaneSetupCard snapshot={running} />);
    // The running stage's duration and the header's elapsed share one clock.
    expect(launchClockSubscriberCountForTests()).toBe(2);
    unmount();
    expect(launchClockSubscriberCountForTests()).toBe(0);
  });
});

describe("LaneSetupTranscriptCard", () => {
  it("renders the live card while the launch is pending", () => {
    applyChatLaunchSnapshot(BINDING, snapshot());
    render(<LaneSetupTranscriptCard card={buildLaneSetupCardPayload(snapshot())} />);
    expect(screen.getByTestId("lane-setup-card").getAttribute("data-launch-phase")).toBe("running");
  });

  it("collapses a finished launch to one line that expands to the stages", () => {
    const done = snapshot({
      phase: "completed",
      agentStarted: true,
      sessionCreated: true,
      startedAt: "2026-09-22T10:00:00.000Z",
      endedAt: "2026-09-22T10:00:04.200Z",
      stages: [stage("fetch", "done"), stage("checkout", "done"), stage("agent", "done")],
    });
    applyChatLaunchSnapshot(BINDING, done);
    render(<LaneSetupTranscriptCard card={buildLaneSetupCardPayload(done)} />);
    const summary = screen.getByTestId("lane-setup-summary");
    expect(within(summary).getByText("Lane set up in 4.2s")).toBeTruthy();
    expect(screen.queryAllByTestId("lane-setup-stage")).toHaveLength(0);
    fireEvent.click(within(summary).getByRole("button"));
    expect(screen.getAllByTestId("lane-setup-stage")).toHaveLength(3);
  });

  it("falls back to the transcript payload when no live launch is known", () => {
    const failedLaunch = snapshot({ phase: "failed", stages: [stage("fetch", "done"), stage("checkout", "failed", { error: "disk full" })] });
    render(<LaneSetupTranscriptCard card={buildLaneSetupCardPayload(failedLaunch)} />);
    expect(screen.getByText("Lane setup failed")).toBeTruthy();
  });

  it("reads payload rows by stage key, with warnings and the template from the Template metric", () => {
    const done = snapshot({
      phase: "completed",
      templateName: "Node API",
      stages: [stage("fetch", "warning", { detail: "used last-known origin/main" }), stage("checkout", "done"), stage("environment", "done"), stage("agent", "done")],
    });
    const card = buildLaneSetupCardPayload(done);
    expect(card.metrics).toEqual([{ label: "Template", value: "Node API" }]);
    // Labels are display copy; a renamed label must not change what a row is.
    const relabelled = { ...card, rows: card.rows!.map((row) => ({ ...row, text: `Renamed ${row.key}` })) };
    render(<LaneSetupTranscriptCard card={relabelled} />);
    fireEvent.click(within(screen.getByTestId("lane-setup-summary")).getByRole("button"));
    const rows = screen.getAllByTestId("lane-setup-stage");
    expect(rows.map((row) => row.getAttribute("data-stage-id"))).toEqual(["fetch", "checkout", "environment", "agent"]);
    expect(rows.map((row) => row.getAttribute("data-stage-status"))).toEqual(["warning", "done", "done", "done"]);
  });

});
