/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { CtoSettingsPanel } from "./CtoSettingsPanel";
import type { CtoIdentity, CtoCoreMemory, CtoSessionLogEntry } from "../../../shared/types";

/* ── Mocks ── */

vi.mock("./IdentityEditor", () => ({
  IdentityEditor: vi.fn(({ onCancel }: { onCancel: () => void }) => (
    <div data-testid="identity-editor">
      <button onClick={onCancel}>Cancel Edit</button>
    </div>
  )),
}));

vi.mock("./shared/TimelineEntry", () => ({
  TimelineEntry: vi.fn(({ title }: { title: string }) => (
    <div data-testid="timeline-entry">{title}</div>
  )),
}));

vi.mock("./OpenclawConnectionPanel", () => ({
  OpenclawConnectionPanel: vi.fn(() => <div data-testid="openclaw-panel" />),
}));

vi.mock("./CtoPromptPreview", () => ({
  CtoPromptPreview: vi.fn(() => <div data-testid="prompt-preview" />),
}));

vi.mock("./identityPresets", () => ({
  getCtoPersonalityPreset: vi.fn((key: string) => ({
    label: key === "strategic" ? "Strategic" : key,
    description: `Personality: ${key}`,
  })),
}));

/* ── Fixtures ── */

function makeIdentity(overrides: Partial<CtoIdentity> = {}): CtoIdentity {
  return {
    version: 2,
    persona: "Senior CTO",
    personality: "strategic",
    customPersonality: null,
    modelPreferences: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      reasoningEffort: null,
    },
    ...overrides,
  } as CtoIdentity;
}

function makeCoreMemory(overrides: Partial<CtoCoreMemory> = {}): CtoCoreMemory {
  return {
    projectSummary: "A project about testing.",
    criticalConventions: ["TypeScript"],
    userPreferences: [],
    activeFocus: [],
    notes: [],
    ...overrides,
  } as CtoCoreMemory;
}

/* ── Tests ── */

describe("CtoSettingsPanel", () => {
  const onSaveIdentity = vi.fn().mockResolvedValue(undefined);
  const onSaveCoreMemory = vi.fn().mockResolvedValue(undefined);
  const onResetOnboarding = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    onSaveIdentity.mockResolvedValue(undefined);
    onSaveCoreMemory.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders identity section with model info when identity is provided", () => {
    render(
      <CtoSettingsPanel
        identity={makeIdentity()}
        coreMemory={makeCoreMemory()}
        sessionLogs={[]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
      />,
    );
    expect(screen.getByText("anthropic/claude-sonnet-4-6")).toBeTruthy();
  });

  it("shows Loading when identity is null", () => {
    render(
      <CtoSettingsPanel
        identity={null}
        coreMemory={null}
        sessionLogs={[]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
      />,
    );
    const loadingElements = screen.getAllByText("Loading...");
    expect(loadingElements.length).toBeGreaterThanOrEqual(1);
  });

  it("displays core memory project summary in view mode", () => {
    render(
      <CtoSettingsPanel
        identity={makeIdentity()}
        coreMemory={makeCoreMemory({ projectSummary: "ADE is an agentic IDE." })}
        sessionLogs={[]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    expect(screen.getByText("ADE is an agentic IDE.")).toBeTruthy();
  });

  it("shows the reset onboarding button when callback is provided", () => {
    render(
      <CtoSettingsPanel
        identity={makeIdentity()}
        coreMemory={makeCoreMemory()}
        sessionLogs={[]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
        onResetOnboarding={onResetOnboarding}
      />,
    );
    expect(screen.getByText("Re-run setup")).toBeTruthy();
  });

  it("does not show reset onboarding when callback is omitted", () => {
    render(
      <CtoSettingsPanel
        identity={makeIdentity()}
        coreMemory={makeCoreMemory()}
        sessionLogs={[]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
      />,
    );
    expect(screen.queryByText("Re-run setup")).toBeNull();
  });

  it("calls onSaveCoreMemory with parsed arrays when saving memory edits", async () => {
    render(
      <CtoSettingsPanel
        identity={makeIdentity()}
        coreMemory={makeCoreMemory()}
        sessionLogs={[]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    const editBtns = screen.getAllByTestId("core-memory-edit-btn");
    expect(editBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(editBtns[0]);

    const saveBtn = screen.getByTestId("core-memory-save-btn");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onSaveCoreMemory).toHaveBeenCalledTimes(1);
    });

    const callArgs = onSaveCoreMemory.mock.calls[0][0];
    expect(callArgs).toHaveProperty("projectSummary");
    expect(Array.isArray(callArgs.criticalConventions)).toBe(true);
    expect(Array.isArray(callArgs.userPreferences)).toBe(true);
    expect(Array.isArray(callArgs.activeFocus)).toBe(true);
    expect(Array.isArray(callArgs.notes)).toBe(true);
  });

  it("can cancel memory editing and return to view mode", () => {
    render(
      <CtoSettingsPanel
        identity={makeIdentity()}
        coreMemory={makeCoreMemory()}
        sessionLogs={[]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    const editBtns = screen.getAllByTestId("core-memory-edit-btn");
    fireEvent.click(editBtns[0]);
    expect(screen.getByTestId("core-memory-cancel-btn")).toBeTruthy();

    fireEvent.click(screen.getByTestId("core-memory-cancel-btn"));
    expect(screen.getAllByTestId("core-memory-view").length).toBeGreaterThanOrEqual(1);
  });

  it("displays memory save error when save fails", async () => {
    onSaveCoreMemory.mockRejectedValueOnce(new Error("Network error"));

    render(
      <CtoSettingsPanel
        identity={makeIdentity()}
        coreMemory={makeCoreMemory()}
        sessionLogs={[]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    const editBtns = screen.getAllByTestId("core-memory-edit-btn");
    fireEvent.click(editBtns[0]);
    fireEvent.click(screen.getByTestId("core-memory-save-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("core-memory-save-error")).toBeTruthy();
    });
    expect(screen.getByText("Network error")).toBeTruthy();
  });

  it("renders model and personality tags for identity", () => {
    render(
      <CtoSettingsPanel
        identity={makeIdentity({
          personality: "strategic",
          modelPreferences: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            reasoningEffort: "high",
          },
        })}
        coreMemory={makeCoreMemory()}
        sessionLogs={[]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
      />,
    );
    expect(screen.getByText("anthropic/claude-sonnet-4-6")).toBeTruthy();
    expect(screen.getByText("reasoning: high")).toBeTruthy();
    expect(screen.getByText("Strategic")).toBeTruthy();
  });

  // Removed tests ("shows Configured", "shows Needs work", "renders the CTO
  // runtime header card"): the sub-tab refactor removed the status badges and
  // the "CTO runtime" / "Identity, brief, and continuity" header card. Those
  // UI elements no longer exist in the component.

  it("renders sub-tab navigation", () => {
    render(
      <CtoSettingsPanel
        identity={makeIdentity()}
        coreMemory={makeCoreMemory()}
        sessionLogs={[]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
      />,
    );
    expect(screen.getByRole("button", { name: "Identity" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Brief" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Integrations" })).toBeTruthy();
  });

  it("shows session history timeline entries in the Brief tab", () => {
    render(
      <CtoSettingsPanel
        identity={makeIdentity()}
        coreMemory={makeCoreMemory()}
        sessionLogs={[
          {
            id: "s1",
            createdAt: "2026-03-26T00:00:00.000Z",
            summary: "Fixed deployment pipeline",
            capabilityMode: "full_tooling",
          } as CtoSessionLogEntry,
        ]}
        onSaveIdentity={onSaveIdentity}
        onSaveCoreMemory={onSaveCoreMemory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    const entries = screen.getAllByTestId("timeline-entry");
    expect(entries).toHaveLength(1);
  });
});
