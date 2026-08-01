// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_CONTRACT_VERSION,
  type AttentionItem,
  type AttentionPhase,
} from "../../../shared/types";
import { ActivityCard } from "./ActivityCard";

afterEach(cleanup);

function item(patch: Partial<AttentionItem> = {}): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id: "item-a",
    revision: 1,
    fingerprint: "fingerprint-item-a",
    kind: "agent",
    eventKind: "agent_running",
    phase: "running" as AttentionPhase,
    machine: {
      machineKey: "studio",
      name: "Studio Mac",
      online: true,
      lastSeenAt: "2026-08-01T11:59:00.000Z",
    },
    project: { projectId: "ade", name: "ADE", rootPath: "/repo/ade" },
    laneId: "lane-1",
    laneName: "attention-revamp",
    provider: "codex",
    model: "gpt-5.6-sol",
    title: "Rewrite the header popover",
    preview: "Editing HeaderActivityControl.tsx",
    privacyPreview: "Agent is working",
    destination: { kind: "session", sessionId: "session-a" },
    actions: [],
    occurredAt: "2026-08-01T11:58:00.000Z",
    updatedAt: "2026-08-01T11:59:30.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...patch,
  };
}

describe("ActivityCard", () => {
  it("renders the whole row: lane, machine, status, title, note, and model", () => {
    render(<ActivityCard item={item()} onOpen={vi.fn()} />);

    const row = screen.getByRole("button");
    expect(row.getAttribute("data-activity-row")).toBe("item-a");
    expect(screen.getByText("attention-revamp")).toBeTruthy();
    expect(screen.getByText("Studio Mac")).toBeTruthy();
    expect(screen.getByText("Rewrite the header popover")).toBeTruthy();
    expect(screen.getByText("Editing HeaderActivityControl.tsx")).toBeTruthy();
    expect(screen.getByText("gpt-5.6-sol")).toBeTruthy();
    // The shared status vocabulary, not a second table: a running agent reads
    // exactly as it does on a Work sidebar row, elapsed ticker included.
    expect(screen.getByRole("status").textContent).toBe("Working");
    expect(row.getAttribute("data-activity-tone")).toBe("blue");
  });

  it("anchors elapsed on statusSince so a cosmetic republish cannot reset it", () => {
    const { container } = render(
      <ActivityCard
        item={item({ statusSince: new Date(Date.now() - 90_000).toISOString() })}
        onOpen={vi.fn()}
      />,
    );

    expect(container.textContent).toContain("1m");
  });

  it("shows only the redacted preview when hide-details is on", () => {
    render(<ActivityCard item={item()} onOpen={vi.fn()} hideDetails />);

    expect(screen.getByText("Agent is working")).toBeTruthy();
    expect(screen.queryByText("Editing HeaderActivityControl.tsx")).toBeNull();
  });

  it("dims an offline machine's row and says when it was last seen", () => {
    render(
      <ActivityCard
        item={item({
          machine: {
            machineKey: "laptop",
            name: "MacBook Pro",
            online: false,
            lastSeenAt: "2026-08-01T09:00:00.000Z",
          },
        })}
        onOpen={vi.fn()}
      />,
    );

    const chip = screen.getByText("MacBook Pro").parentElement;
    expect(chip?.getAttribute("data-machine-online")).toBe("false");
    expect(chip?.getAttribute("title")).toContain("offline");
    expect(screen.getByRole("button").className).toContain("opacity-70");
  });

  it("falls back to the project name when an item has no lane", () => {
    render(<ActivityCard item={item({ laneName: null })} onOpen={vi.fn()} />);

    expect(screen.getByText("ADE")).toBeTruthy();
  });

  it("hands the whole item back on open and does nothing else", () => {
    const onOpen = vi.fn();
    render(<ActivityCard item={item()} onOpen={onOpen} />);

    fireEvent.click(screen.getByRole("button"));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "item-a" }));
  });

  it("keeps the compact form to two lines without losing the status word", () => {
    const { container } = render(<ActivityCard item={item()} onOpen={vi.fn()} compact />);

    expect(container.querySelector(".h-\\[2\\.75rem\\]")).toBeTruthy();
    expect(container.querySelector(".h-\\[4\\.875rem\\]")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Working");
  });

  it("marks a pull request seen-state without pretending it has a provider", () => {
    render(
      <ActivityCard
        item={item({
          kind: "pull_request",
          phase: "merge_ready",
          provider: null,
          model: null,
          seenAt: "2026-08-01T11:59:00.000Z",
        })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Ready to merge");
    expect(screen.queryByLabelText("Unseen")).toBeNull();
  });
});
