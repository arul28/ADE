/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AiFeaturesSection } from "./AiFeaturesSection";

function installAdeMocks() {
  (window as any).ade = {
    ai: {
      updateConfig: vi.fn().mockResolvedValue(undefined),
    },
    projectConfig: {
      get: vi.fn().mockResolvedValue({
        effective: {
          ai: {
            chat: { scheduledWorkPaused: false },
          },
        },
      }),
    },
    agentChat: {
      listScheduledWork: vi.fn().mockResolvedValue([]),
      cancelScheduledWork: vi.fn().mockResolvedValue({
        schedule: { id: "wake-1", status: "cancelled" },
        providerCancellationRequested: false,
        providerCancellationConfirmed: true,
      }),
    },
  };
}

afterEach(() => {
  cleanup();
  delete (window as any).ade;
});

describe("AiFeaturesSection", () => {
  it("does not offer background-helper model pickers", async () => {
    installAdeMocks();
    render(
      <MemoryRouter>
        <AiFeaturesSection />
      </MemoryRouter>,
    );
    await screen.findByText("Pause all scheduled work");
    expect(screen.queryByText("Auto-name chats, lanes, and branches")).toBeNull();
    expect(screen.queryByText("Commit messages")).toBeNull();
    expect(screen.queryByText("PR description drafting")).toBeNull();
    expect(screen.queryByText("Conflict proposals")).toBeNull();
    expect(screen.queryByText("Summarize completed chats and terminals")).toBeNull();
  });

  it("persists the global scheduled-work pause toggle", async () => {
    installAdeMocks();

    render(
      <MemoryRouter>
        <AiFeaturesSection />
      </MemoryRouter>,
    );

    const label = await screen.findByText("Pause all scheduled work");
    const row = label.closest(".ai-feature-row");
    const toggle = row?.querySelector("button");
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle!);

    await waitFor(() => {
      expect((window as any).ade.ai.updateConfig).toHaveBeenCalledWith({
        chat: { scheduledWorkPaused: true },
      });
    });
  });

  it("lists and cancels an active durable job", async () => {
    installAdeMocks();
    (window as any).ade.agentChat.listScheduledWork.mockResolvedValueOnce([{
      id: "action:chat-12345678:job-1",
      sessionId: "chat-12345678",
      kind: "cron",
      status: "scheduled",
      title: "Check PR CI",
      prompt: "Check PR CI",
      cron: "*/20 * * * *",
      createdAt: "2026-07-14T00:00:00.000Z",
      durable: true,
      cancellable: true,
    }, {
      id: "wake-2",
      sessionId: "chat-87654321",
      kind: "wakeup",
      status: "scheduled",
      title: "Provider-only wakeup",
      prompt: "Continue",
      createdAt: "2026-07-14T00:01:00.000Z",
      durable: true,
      cancellable: false,
    }]);

    render(
      <MemoryRouter>
        <AiFeaturesSection />
      </MemoryRouter>,
    );

    await screen.findByText("Check PR CI");
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    expect((cancelButtons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((cancelButtons[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cancelButtons[0]!);
    await waitFor(() => {
      expect((window as any).ade.agentChat.cancelScheduledWork).toHaveBeenCalledWith({
        sessionId: "chat-12345678",
        scheduleId: "action:chat-12345678:job-1",
      });
    });
  });

  it("shows scheduled-work loading failures instead of claiming there are no jobs", async () => {
    installAdeMocks();
    (window as any).ade.agentChat.listScheduledWork.mockRejectedValueOnce(new Error("scheduler offline"));

    render(
      <MemoryRouter>
        <AiFeaturesSection />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Scheduled work is unavailable: scheduler offline/)).toBeTruthy();
    expect(screen.queryByText("No active durable jobs.")).toBeNull();
  });

  it("does not enable the pause toggle when project configuration fails to load", async () => {
    installAdeMocks();
    (window as any).ade.projectConfig.get.mockRejectedValueOnce(new Error("config unavailable"));

    render(
      <MemoryRouter>
        <AiFeaturesSection />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Couldn't load AI features/)).toBeTruthy();
    expect(screen.queryByText("Pause all scheduled work")).toBeNull();
  });
});
