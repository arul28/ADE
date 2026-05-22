/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OrchestrationEventPayload,
  OrchestrationManifest,
} from "../../../shared/types/orchestration";
import {
  OrchestrationPanel,
  ORCHESTRATION_PANEL_EMPTY_QA_TEST_ID,
  ORCHESTRATION_PANEL_PLAN_TEST_ID,
  ORCHESTRATION_PANEL_TASK_CARD_TEST_ID,
  ORCHESTRATION_PANEL_TEST_ID,
  filterPlanningQuestions,
} from "./OrchestrationPanel";

vi.mock("../../lib/openExternal", () => ({
  openUrlInAdeBrowser: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

function makeManifest(overrides: Partial<OrchestrationManifest> = {}): OrchestrationManifest {
  return {
    version: 1,
    runId: "run-1",
    laneId: "lane-1",
    bundlePath: "/tmp/run-1",
    etag: "etag-1",
    serverGeneration: 1,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
    title: "Build login flow",
    goalSummary: "Build login form + auth route",
    currentPhase: "planning",
    phases: [
      { id: "planning", title: "Planning", status: "active" },
      { id: "developing", title: "Developing", status: "pending" },
      { id: "validating", title: "Validating", status: "pending" },
    ],
    agents: [
      {
        sessionId: "lead-session",
        role: "lead",
        goalSummary: "Lead orchestrator",
        displayName: "Lead",
        status: "running",
        spawnedAt: "2026-05-22T00:00:00.000Z",
      },
    ],
    tasks: [],
    validationStrategy: { steps: [], checklist: [] },
    modelRouting: {},
    assets: [],
    decisions: [],
    userOverrides: [],
    leadState: {},
    history: [],
    ...overrides,
  };
}

function makeSource(initial: { manifest: OrchestrationManifest; planMd?: string }) {
  let cb: ((p: OrchestrationEventPayload) => void) | null = null;
  return {
    read: vi.fn(async () => ({
      manifest: initial.manifest,
      planMd: initial.planMd ?? "",
      etag: initial.manifest.etag,
    })),
    subscribe: vi.fn((_args: { runId: string }, callback: (p: OrchestrationEventPayload) => void) => {
      cb = callback;
      return vi.fn(() => {
        cb = null;
      });
    }),
    emit: (payload: OrchestrationEventPayload) => {
      if (cb) cb(payload);
    },
  };
}

describe("OrchestrationPanel", () => {
  it("loads manifest via source.read on mount", async () => {
    const manifest = makeManifest();
    const source = makeSource({ manifest });
    render(
      <OrchestrationPanel
        runId="run-1"
        laneId="lane-1"
        laneName="main"
        source={source}
      />,
    );
    expect(source.read).toHaveBeenCalledWith({ runId: "run-1", laneId: "lane-1" });
    await screen.findByTestId(ORCHESTRATION_PANEL_TEST_ID);
    expect(screen.getByText(/Build login flow/)).toBeTruthy();
    expect(screen.getByText(/main/)).toBeTruthy();
  });

  it("renders the planning empty Q&A state when no tasks exist", async () => {
    const manifest = makeManifest({
      decisions: [
        { id: "d1", at: "2026-05-22T00:01:00Z", source: "lead", summary: "Q: What is the goal? / A: Rebuild login" },
        { id: "d2", at: "2026-05-22T00:02:00Z", source: "lead", summary: "Q: Confirm tags" },
      ],
    });
    const source = makeSource({ manifest });
    render(
      <OrchestrationPanel
        runId="run-1"
        laneId="lane-1"
        source={source}
        initialManifest={manifest}
      />,
    );
    const empty = await screen.findByTestId(ORCHESTRATION_PANEL_EMPTY_QA_TEST_ID);
    expect(empty).toBeTruthy();
    expect(empty.textContent ?? "").toMatch(/Planning in progress/);
    expect(empty.textContent ?? "").toMatch(/What is the goal/);
    expect(empty.textContent ?? "").toMatch(/Rebuild login/);
    expect(empty.textContent ?? "").toMatch(/Confirm tags/);
  });

  it("re-renders task cards when a manifest event arrives", async () => {
    const initial = makeManifest();
    const source = makeSource({ manifest: initial });
    render(
      <OrchestrationPanel
        runId="run-1"
        laneId="lane-1"
        source={source}
        initialManifest={initial}
        viewerRole="lead"
      />,
    );
    // No task cards yet — initial manifest has empty tasks.
    expect(screen.queryByTestId(ORCHESTRATION_PANEL_TASK_CARD_TEST_ID)).toBeNull();

    const next = makeManifest({
      etag: "etag-2",
      currentPhase: "developing",
      phases: [
        { id: "planning", title: "Planning", status: "done" },
        { id: "developing", title: "Developing", status: "active" },
        { id: "validating", title: "Validating", status: "pending" },
      ],
      tasks: [
        {
          id: "T-01",
          phaseId: "developing",
          title: "Build login form",
          description: "Form with email + password inputs",
          status: "in_progress",
          tag: "web-ui",
          filesHint: ["src/login.tsx"],
          validationGate: { required: true, stepIds: [] },
        },
      ],
    });

    act(() => {
      source.emit({ runId: "run-1", kind: "manifest", etag: "etag-2", manifest: next });
    });

    const card = await screen.findByTestId(ORCHESTRATION_PANEL_TASK_CARD_TEST_ID);
    expect(card.getAttribute("data-orchestration-task-id")).toBe("T-01");
    expect(card.getAttribute("data-orchestration-task-status")).toBe("in_progress");
    expect(card.textContent ?? "").toMatch(/Build login form/);
    expect(card.textContent ?? "").toMatch(/src\/login.tsx/);
  });

  it("renders the plan.md narrative when populated", async () => {
    const manifest = makeManifest();
    const source = makeSource({
      manifest,
      planMd: "# Plan\n\nThis is the plan.",
    });
    render(
      <OrchestrationPanel
        runId="run-1"
        laneId="lane-1"
        source={source}
        initialManifest={manifest}
        initialPlanMd={"# Plan\n\nThis is the plan."}
      />,
    );
    const plan = await screen.findByTestId(ORCHESTRATION_PANEL_PLAN_TEST_ID);
    expect(plan.textContent ?? "").toMatch(/This is the plan/);
  });

  it("collapses into the icon rail and expands back", async () => {
    const manifest = makeManifest({
      tasks: [
        {
          id: "T-01",
          phaseId: "developing",
          title: "x",
          description: "",
          status: "in_progress",
          validationGate: { required: false, stepIds: [] },
        },
      ],
    });
    const source = makeSource({ manifest });
    render(
      <OrchestrationPanel
        runId="run-1"
        laneId="lane-1"
        source={source}
        initialManifest={manifest}
        defaultCollapsed={false}
      />,
    );
    const panel = await screen.findByTestId(ORCHESTRATION_PANEL_TEST_ID);
    expect(panel.getAttribute("data-orchestration-panel-collapsed")).toBeNull();

    const collapse = screen.getByLabelText(/Collapse plan panel/i);
    fireEvent.click(collapse);

    const rail = screen.getByTestId(ORCHESTRATION_PANEL_TEST_ID);
    expect(rail.getAttribute("data-orchestration-panel-collapsed")).toBe("true");
    // Open arrow renders inside the rail.
    expect(screen.getByLabelText(/Expand plan panel/i)).toBeTruthy();
  });

  it("expands/collapses phase accordions", async () => {
    const manifest = makeManifest({
      currentPhase: "developing",
      phases: [
        { id: "planning", title: "Planning", status: "done" },
        { id: "developing", title: "Developing", status: "active" },
        { id: "validating", title: "Validating", status: "pending" },
      ],
      tasks: [
        {
          id: "T-01",
          phaseId: "validating",
          title: "v",
          description: "",
          status: "pending",
          validationGate: { required: false, stepIds: [] },
        },
      ],
    });
    const source = makeSource({ manifest });
    render(
      <OrchestrationPanel
        runId="run-1"
        laneId="lane-1"
        source={source}
        initialManifest={manifest}
      />,
    );
    // Validating phase is not the current phase and has tasks — it should
    // open (since tasks > 0). Click the heading to collapse.
    const validatingHeader = await screen.findByText("Validating");
    const validatingButton = validatingHeader.closest("button");
    expect(validatingButton).toBeTruthy();
    if (!validatingButton) throw new Error("no validating button");
    expect(validatingButton.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(validatingButton);
    await waitFor(() =>
      expect(validatingButton.getAttribute("aria-expanded")).toBe("false"),
    );
  });
});

describe("filterPlanningQuestions", () => {
  it("matches Q/A pairs", () => {
    const decisions = [
      { id: "1", at: "x", source: "lead" as const, summary: "Q: foo / A: bar" },
      { id: "2", at: "x", source: "lead" as const, summary: "Q: baz" },
      { id: "3", at: "x", source: "lead" as const, summary: "question: hi" },
      { id: "4", at: "x", source: "lead" as const, summary: "irrelevant note" },
    ];
    const out = filterPlanningQuestions(decisions);
    expect(out.length).toBe(3);
    expect(out[0]).toMatchObject({ kind: "question-answered", question: "foo", answer: "bar" });
    expect(out[1]).toMatchObject({ kind: "question-pending", question: "baz" });
    expect(out[2]).toMatchObject({ kind: "question-pending", question: "hi" });
  });
});
