// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrActionStep, PrCheckLogExcerpt, PrWorkflowGraphNode } from "../../../../shared/types";
import { PrCheckLogDrawer } from "./PrCheckLogDrawer";

function step(
  number: number,
  name: string,
  overrides: Partial<PrActionStep> = {},
): PrActionStep {
  return {
    name,
    number,
    status: "completed",
    conclusion: "success",
    startedAt: `2026-07-27T11:0${number}:00.000Z`,
    completedAt: `2026-07-27T11:0${number}:12.000Z`,
    ...overrides,
  };
}

function node(overrides: Partial<PrWorkflowGraphNode> = {}): PrWorkflowGraphNode {
  return {
    jobId: "test-desktop",
    displayName: "test-desktop",
    workflowName: "CI",
    state: "passed",
    tier: 0,
    durationMs: 36_000,
    startedAt: "2026-07-27T11:01:00.000Z",
    completedAt: "2026-07-27T11:03:00.000Z",
    legs: [],
    steps: [step(1, "Set up job"), step(2, "Run npm ci"), step(3, "Run vitest")],
    checkRunId: null,
    actionsJobId: 42,
    runId: 4821,
    detailsUrl: "https://github.com/ade-dev/ade/actions/runs/4821/job/42",
    ...overrides,
  };
}

function excerptOf(overrides: Partial<PrCheckLogExcerpt> = {}): PrCheckLogExcerpt {
  return {
    jobId: 42,
    jobName: "test-desktop",
    failingStepName: null,
    failingStepNumber: null,
    stepTotal: 3,
    headline: null,
    lines: [],
    truncated: false,
    htmlUrl: "https://github.com/ade-dev/ade/actions/runs/4821/job/42",
    ...overrides,
  };
}

function renderDrawer(props: Partial<React.ComponentProps<typeof PrCheckLogDrawer>> = {}) {
  return render(
    <PrCheckLogDrawer
      drawer={{ node: node(), jobId: 42 }}
      excerpt={null}
      loading={false}
      error={null}
      elapsedLabel="2m"
      onCopy={vi.fn()}
      copied={false}
      onRerunJob={undefined}
      onFixInChat={undefined}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

beforeEach(() => {
  Object.assign(window, { ade: { app: { openExternal: vi.fn() } } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PrCheckLogDrawer — a job that passed", () => {
  /**
   * The reported defect. Opening a green job said "Fetching the failing step's
   * output…", then "tail of the failing step", over content the service had
   * picked by falling back to the *last* log section — the `Post Run …` cleanup
   * group. Nothing on a passed job's drawer may narrate failure.
   */
  it("says passed, never failed, and shows no log pane", () => {
    renderDrawer();
    const drawer = screen.getByTestId("pr-checks-log-drawer");

    expect(drawer.getAttribute("data-job-state")).toBe("passed");
    expect(screen.getByTestId("pr-checks-drawer-outcome").textContent).toBe("Passed");
    expect(screen.getByTestId("pr-checks-drawer-summary").textContent).toBe("3 steps, all passed");
    expect(drawer.textContent?.toLowerCase()).not.toContain("fail");
    expect(screen.queryByTestId("pr-checks-log-body")).toBeNull();
    expect(screen.queryByTestId("pr-checks-log-headline")).toBeNull();
  });

  /**
   * Even while the tab is mid-fetch, a green job must not be described as
   * failing. This is the exact string the user saw.
   */
  it("does not show the fetching-failing-step copy while a fetch is in flight", () => {
    renderDrawer({ loading: true });
    expect(screen.getByTestId("pr-checks-log-drawer").textContent)
      .not.toContain("Fetching the failing step's output");
  });

  it("shows the step breakdown with per-step durations and offers the full log", () => {
    renderDrawer();
    const rows = screen.getAllByTestId("pr-checks-step-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "1Set up jobPassed12s",
      "2Run npm ciPassed12s",
      "3Run vitestPassed12s",
    ]);
    expect(screen.getByTestId("pr-checks-drawer-note").textContent)
      .toBe("step times from this run · no log fetched · 36s in steps");

    const fullLog = screen.getByTestId("pr-checks-drawer-full-log") as HTMLButtonElement;
    expect(fullLog.disabled).toBe(false);
    fullLog.click();
    expect(window.ade.app.openExternal)
      .toHaveBeenCalledWith("https://github.com/ade-dev/ade/actions/runs/4821/job/42");
  });

  it("offers no Fix in chat, and only offers a log fetch when a handler is wired", () => {
    const { rerender } = renderDrawer();
    expect(screen.queryByTestId("pr-checks-drawer-fix-in-chat")).toBeNull();
    expect(screen.queryByTestId("pr-checks-drawer-load-log")).toBeNull();

    const onLoadLogExcerpt = vi.fn();
    rerender(
      <PrCheckLogDrawer
        drawer={{ node: node(), jobId: 42 }}
        excerpt={excerptOf({ jobState: "passed", jobStatus: "completed", jobConclusion: "success", logStatus: "not-fetched" })}
        loading={false}
        error={null}
        elapsedLabel="2m"
        onCopy={vi.fn()}
        copied={false}
        onRerunJob={undefined}
        onFixInChat={undefined}
        onClose={vi.fn()}
        onLoadLogExcerpt={onLoadLogExcerpt}
      />,
    );
    screen.getByTestId("pr-checks-drawer-load-log").click();
    expect(onLoadLogExcerpt).toHaveBeenCalledTimes(1);
  });

  it("renders the log once it arrives, keeping the step breakdown above it", () => {
    // The button used to download a whole log the drawer had no branch to
    // render: the log pane was gated on `failed`, so a passed job showed the
    // same step list before and after and the click looked inert.
    renderDrawer({
      excerpt: excerptOf({
        jobState: "passed",
        jobStatus: "completed",
        jobConclusion: "success",
        logStatus: "excerpt",
        lines: ["npm test", "42 passed"],
      }),
      onLoadLogExcerpt: vi.fn(),
    });
    expect(screen.getByTestId("pr-checks-log-body").textContent).toContain("42 passed");
    expect(screen.queryByTestId("pr-checks-step-breakdown")).not.toBeNull();
    expect(screen.getByTestId("pr-checks-drawer-outcome").textContent).toBe("Passed");
  });

  /**
   * A read that came back empty-handed is still an answer. The log pane used to
   * be gated on having lines, so a failed fetch left the drawer byte-identical
   * to before the click — down to a footer still claiming "no log fetched".
   */
  it("shows a non-failed on-demand log read failure", () => {
    const { rerender } = renderDrawer({
      excerpt: excerptOf({
        jobState: "passed",
        jobStatus: "completed",
        jobConclusion: "success",
        logStatus: "unavailable",
        logUnavailableReason: "ADE couldn't download this job's log from GitHub.",
      }),
      onLoadLogExcerpt: vi.fn(),
    });
    expect(screen.getByTestId("pr-checks-log-body").textContent)
      .toContain("ADE couldn't download this job's log");
    expect(screen.getByTestId("pr-checks-drawer-note").textContent)
      .toContain("ADE couldn't read the log");
    // The steps are why the drawer was opened; the read failure is additive.
    expect(screen.queryByTestId("pr-checks-step-breakdown")).not.toBeNull();

    // A transport-level failure reports through `error` rather than the
    // excerpt, and has to reach the same pane.
    rerender(
      <PrCheckLogDrawer
        drawer={{ node: node(), jobId: 42 }}
        excerpt={null}
        loading={false}
        error="GitHub rate limit exceeded."
        elapsedLabel="2m"
        onCopy={vi.fn()}
        copied={false}
        onRerunJob={undefined}
        onFixInChat={undefined}
        onClose={vi.fn()}
        onLoadLogExcerpt={vi.fn()}
      />,
    );
    expect(screen.getByTestId("pr-checks-log-body").textContent)
      .toContain("GitHub rate limit exceeded.");
  });
});

describe("PrCheckLogDrawer — other states", () => {
  it("names the step in flight for a running job without claiming a log exists", () => {
    renderDrawer({
      drawer: {
        node: node({
          state: "running",
          completedAt: null,
          steps: [
            step(1, "Set up job"),
            step(2, "Run vitest", { status: "in_progress", conclusion: null, completedAt: null }),
          ],
        }),
        jobId: 42,
      },
    });
    expect(screen.getByTestId("pr-checks-drawer-outcome").textContent).toBe("Running");
    expect(screen.getByTestId("pr-checks-drawer-summary").textContent)
      .toBe("Running step 2 of 2 · Run vitest");
    expect(screen.getByTestId("pr-checks-drawer-note").textContent)
      .toContain("the job log isn't complete yet");
    expect(screen.queryByTestId("pr-checks-log-body")).toBeNull();
  });

  it("states a queued job plainly and offers no log fetch", () => {
    renderDrawer({
      drawer: { node: node({ state: "queued", steps: [], startedAt: null, completedAt: null }), jobId: 42 },
      onLoadLogExcerpt: vi.fn(),
    });
    expect(screen.getByTestId("pr-checks-drawer-summary").textContent)
      .toBe("Queued. GitHub hasn't started this job yet.");
    expect(screen.queryByTestId("pr-checks-drawer-load-log")).toBeNull();
  });

  it("calls a cancelled job cancelled, not failed", () => {
    renderDrawer({
      drawer: { node: node({ state: "failed" }), jobId: 42 },
      excerpt: excerptOf({ jobState: "failed", jobStatus: "completed", jobConclusion: "cancelled" }),
    });
    expect(screen.getByTestId("pr-checks-drawer-outcome").textContent).toBe("Cancelled");
  });

  it("states a skipped job's outcome without inventing a failure", () => {
    renderDrawer({ drawer: { node: node({ state: "skipped" }), jobId: 42 } });
    expect(screen.getByTestId("pr-checks-drawer-outcome").textContent).toBe("Skipped");
    expect(screen.getByTestId("pr-checks-drawer-summary").textContent)
      .toBe("Didn't run · 3 steps skipped");
  });
});

describe("PrCheckLogDrawer — a job that failed", () => {
  const failedNode = node({
    state: "failed",
    steps: [step(1, "Set up job"), step(2, "Run vitest", { conclusion: "failure" })],
  });
  const failedExcerpt = excerptOf({
    failingStepName: "Run vitest",
    failingStepNumber: 2,
    stepTotal: 2,
    headline: "Tests  1 failed | 412 passed (413)",
    lines: ["✗ updateService.test.ts", "AssertionError: expected 'held' to be 'released'"],
    jobState: "failed",
    jobStatus: "completed",
    jobConclusion: "failure",
    logStatus: "excerpt",
    logScope: "failing-step",
  });

  it("keeps the named failing step, the headline, and the tail", () => {
    renderDrawer({ drawer: { node: failedNode, jobId: 42 }, excerpt: failedExcerpt, onFixInChat: vi.fn() });
    expect(screen.getByTestId("pr-checks-drawer-summary").textContent)
      .toBe("Failed at step 2 of 2 · Run vitest");
    expect(screen.getByTestId("pr-checks-log-headline").textContent)
      .toBe("Tests  1 failed | 412 passed (413)");
    expect(screen.getByTestId("pr-checks-log-body").textContent).toContain("AssertionError");
    expect(screen.getByTestId("pr-checks-drawer-note").textContent)
      .toBe("tail of the failing step · fetched on open");
    expect(screen.getByTestId("pr-checks-drawer-fix-in-chat")).toBeTruthy();
  });

  it("still says it is fetching the failing step's output while loading", () => {
    renderDrawer({ drawer: { node: failedNode, jobId: 42 }, loading: true });
    expect(within(screen.getByTestId("pr-checks-log-body")).queryByText(/Fetching the failing step/))
      .not.toBeNull();
  });

  /**
   * "ADE could not read the log" and "the job produced no output" are different
   * claims. Collapsing them is what let a swallowed GitHub failure read as
   * "nothing here yet" and keep a poll running against a spent quota.
   */
  it("reports an unreadable log as a read failure, not as an empty log", () => {
    renderDrawer({
      drawer: { node: failedNode, jobId: 42 },
      excerpt: excerptOf({
        jobState: "failed",
        jobStatus: "completed",
        jobConclusion: "failure",
        logStatus: "unavailable",
        logUnavailableReason: "ADE couldn't download this job's log from GitHub.",
      }),
    });
    const body = screen.getByTestId("pr-checks-log-body").textContent ?? "";
    expect(body).toContain("ADE couldn't download this job's log");
    expect(body).not.toContain("no output");
  });

  it("labels a whole-log tail as such rather than claiming a failing step", () => {
    renderDrawer({
      drawer: { node: failedNode, jobId: 42 },
      excerpt: { ...failedExcerpt, logScope: "whole-log" },
    });
    expect(screen.getByTestId("pr-checks-drawer-note").textContent)
      .toBe("tail of the whole job log · GitHub didn't mark a failing step");
  });
});
