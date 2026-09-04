/**
 * The seam test.
 *
 * The plugin is two programs now: a page that draws, and a child process that
 * holds the `review.*` action domain. They are joined by nothing but a list of
 * action ids and their argument shapes — no compiler checks the join, because
 * the page is built separately from the plugin it ships inside, and no type
 * crosses the bridge.
 *
 * So this test walks the product the way a reader does, against a scripted
 * `window.adePlugin` (`fakeBridge.ts`), and asserts the CALLS rather than the
 * pixels: an id the page invokes that the fake does not script throws by name,
 * and an argument shape that drifts fails on the assertion that reads it. It is
 * deliberately owned by neither half — a page change and a change to
 * `pageActions.js` both have to keep it passing.
 *
 * The walk: an empty runs list → the launch form with the host pickers → start a
 * run → live progress over `host.subscribe` kind `review` → the run detail with
 * its findings → each of the four feedback verbs → learnings and a suppression
 * removed → the quality report. Then the two degradations that let an older host
 * draw the same page: a refused `review` kind falling back to the poll, and a
 * missing `ui.openPathInEditor`.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { LaunchEntry } from "../src/entries/LaunchEntry";
import { RunsEntry } from "../src/entries/RunsEntry";
import { REVIEW_POLL_MS } from "../src/host/liveRuns";
import {
  fakeRun,
  fakeSuppression,
  installFakeBridge,
  uninstallFakeBridge,
  type FakeBridge,
  type FakeBridgeOptions,
} from "./fakeBridge";

/**
 * A fresh project root per test.
 *
 * The browser stores the reader's selected run and sidebar width in the
 * `ui-state` collection, keyed on the project root. Across tests in one module
 * that store is a fresh Map per fake, but keying on a distinct root as well
 * keeps a stored run from one walk out of the next — the same isolation a
 * distinct project gives in the product.
 */
let root = 0;

function tabContext(overrides: Record<string, unknown> = {}) {
  return {
    subject: null,
    surfaceId: "runs",
    placement: "tab" as const,
    project: { projectId: `project-${root}`, root: `/repo-${root}`, binding: "local" as const },
    ...overrides,
  };
}

let host: FakeBridge;

beforeEach(() => {
  root += 1;
  host = installFakeBridge();
});

/** Re-install the fake with different host capabilities, mid-file. */
function reinstall(options: FakeBridgeOptions): void {
  uninstallFakeBridge();
  host = installFakeBridge(options);
}

afterEach(() => {
  cleanup();
  uninstallFakeBridge();
  vi.useRealTimers();
});

async function runsPane(): Promise<HTMLElement> {
  return await waitFor(() => {
    const pane = document.querySelector('[data-review-pane="runs"]');
    if (!pane) throw new Error("The runs pane has not rendered yet.");
    return pane as HTMLElement;
  });
}

describe("the page and the plugin agree on every verb", () => {
  it("walks an empty list, a launch, live progress, findings, feedback and learnings", async () => {
    // ── An empty runs list ──────────────────────────────────────────────────
    // A fresh workspace. The page opens with exactly the two reads the compiled
    // tab opened with, and draws the empty state rather than a spinner forever.
    render(<RunsEntry context={tabContext()} />);

    await waitFor(() => {
      expect(host.callsTo("invoke:pageRuns").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("invoke:pageLaunchContext").length).toBeGreaterThan(0);

    // The read's argument shape is the contract `pageActions.js:pageRuns` reads.
    // A drift here is the bug this test exists to catch.
    expect(host.callsTo("invoke:pageRuns")[0]!.args).toMatchObject({ limit: 120, status: "all" });

    const pane = await runsPane();
    expect(within(pane).getByText(/No review runs yet in this workspace/)).toBeTruthy();

    // ── The launch form ─────────────────────────────────────────────────────
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Launch new review"));
    });
    const form = await waitFor(() => {
      const node = document.querySelector('[data-review-pane="launch"]');
      if (!node) throw new Error("The launch form has not opened yet.");
      return node as HTMLElement;
    });

    // The lane, model and reasoning fields are the HOST's pickers, not
    // re-implemented comboboxes.
    await act(async () => {
      fireEvent.click(within(form).getByLabelText("Lane to review"));
    });
    await waitFor(() => {
      expect(host.callsTo("ui.pickLane").length).toBe(1);
    });
    expect(host.lastCall("ui.pickLane")!.args).toEqual({ value: "lane-1" });

    await act(async () => {
      fireEvent.click(within(form).getByLabelText("Model"));
    });
    await waitFor(() => {
      expect(host.callsTo("ui.pickModel").length).toBe(1);
    });
    expect(host.lastCall("ui.pickModel")!.args).toEqual({ value: "openai/gpt-5.6-sol" });

    await act(async () => {
      fireEvent.click(within(form).getByLabelText("Reasoning effort"));
    });
    await waitFor(() => {
      expect(host.callsTo("ui.pickReasoningEffort").length).toBe(1);
    });
    // The ladder is per MODEL, so the picker is asked with the model the reader
    // just chose — not with the one the form opened on — and with the current
    // rung so ADE's list opens on it.
    expect(host.lastCall("ui.pickReasoningEffort")!.args).toEqual({
      model: "anthropic/claude-opus-5",
      value: "low",
    });

    // ── Start a run ─────────────────────────────────────────────────────────
    await act(async () => {
      fireEvent.click(within(form).getByText("Start review"));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStartRun").length).toBe(1);
    });

    // `{target, config}` verbatim — the compiled pair `review.startRun` takes.
    const started = host.lastCall("invoke:pageStartRun")!.args;
    expect(started.target).toEqual({ mode: "lane_diff", laneId: "lane-1" });
    expect(started.config).toMatchObject({
      compareAgainst: { kind: "default_branch" },
      selectionMode: "full_diff",
      dirtyOnly: false,
      modelId: "anthropic/claude-opus-5",
      reasoningEffort: "high",
      fastMode: true,
      publishBehavior: "local_only",
    });

    const runId = host.runs[0]!.id;
    await waitFor(() => {
      expect(host.callsTo("invoke:pageRunDetail").some((call) => call.args.runId === runId)).toBe(true);
    });

    // ── Live progress over the `review` kind ────────────────────────────────
    // The page asked for the new host kind and got it, so it is NOT polling.
    expect(host.lastCall("host.subscribe")!.args).toEqual({ kinds: ["review"] });
    await waitFor(() => {
      expect(document.querySelector('[data-review-live="subscribed"]')).toBeTruthy();
    });

    const beforeFrame = host.callsTo("invoke:pageRuns").length;
    host.advanceRun(runId, {
      status: "completed",
      summary: "One finding on the login path.",
      findingCount: 1,
      severitySummary: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      findings: fakeRun().findings,
    });
    await act(async () => {
      host.emit("host", { kind: "review", ids: [runId], overflow: false });
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageRuns").length).toBeGreaterThan(beforeFrame);
    });

    // ── The run detail, with its findings ───────────────────────────────────
    const card = await waitFor(() => {
      const node = document.querySelector("[data-review-finding]");
      if (!node) throw new Error("The finding card has not rendered yet.");
      return node as HTMLElement;
    });
    expect(within(card).getByText("Missing null check on the session lookup")).toBeTruthy();

    // ── The four feedback verbs ─────────────────────────────────────────────
    // 1. Acknowledge, straight from the card.
    await act(async () => {
      fireEvent.click(within(card).getByText("Useful"));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageRecordFeedback").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageRecordFeedback")!.args).toEqual({
      findingId: "finding-1",
      kind: "acknowledge",
      reason: null,
      note: null,
      snoozeDurationMs: null,
      suppression: null,
    });

    // 2, 3, 4. Dismiss, snooze and suppress all go through the same modal, and
    // each sends a different shape — the reason, the duration, the scope.
    const openModal = async (verb: string) => {
      const current = document.querySelector("[data-review-finding]") as HTMLElement;
      await act(async () => {
        fireEvent.click(within(current).getByText(verb));
      });
      return await waitFor(() => {
        const node = document.querySelector('[data-review-modal="feedback"]');
        if (!node) throw new Error(`The ${verb} modal has not opened yet.`);
        return node as HTMLElement;
      });
    };
    const submit = async (modal: HTMLElement) => {
      await act(async () => {
        fireEvent.click(modal.querySelector('[data-review-action="submit-feedback"]')!);
      });
    };

    const dismissModal = await openModal("Dismiss");
    await act(async () => {
      fireEvent.click(dismissModal.querySelector('[data-review-reason="not_a_bug"]')!);
    });
    await submit(dismissModal);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageRecordFeedback").length).toBe(2);
    });
    expect(host.lastCall("invoke:pageRecordFeedback")!.args).toMatchObject({
      findingId: "finding-1",
      kind: "dismiss",
      reason: "not_a_bug",
      snoozeDurationMs: null,
      suppression: null,
    });

    const snoozeModal = await openModal("Snooze");
    await submit(snoozeModal);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageRecordFeedback").length).toBe(3);
    });
    // Seven days, in milliseconds — the compiled modal's own default.
    expect(host.lastCall("invoke:pageRecordFeedback")!.args).toMatchObject({
      kind: "snooze",
      snoozeDurationMs: 7 * 24 * 60 * 60 * 1000,
    });

    const suppressModal = await openModal("Suppress");
    await act(async () => {
      fireEvent.click(suppressModal.querySelector('[data-review-suppression-scope="path"]')!);
    });
    await submit(suppressModal);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageRecordFeedback").length).toBe(4);
    });
    // A `path` suppression carries the finding's own path — silencing the repo
    // when the reader chose one file is the one wrong answer here.
    expect(host.lastCall("invoke:pageRecordFeedback")!.args).toMatchObject({
      kind: "suppress",
      suppression: { scope: "path", pathPattern: "src/auth.ts" },
    });

    // ── Learnings, and a suppression removed ────────────────────────────────
    await act(async () => {
      fireEvent.click(document.querySelector('[data-review-action="learnings"]')!);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageSuppressions").length).toBeGreaterThan(0);
    });
    expect(host.lastCall("invoke:pageSuppressions")!.args).toEqual({ limit: 100 });

    // ── The quality report ──────────────────────────────────────────────────
    // Read alongside the suppressions, and drawn as numbers rather than dashes.
    expect(host.callsTo("invoke:pageQualityReport").length).toBeGreaterThan(0);
    const learnings = await waitFor(() => {
      const node = document.querySelector('[data-review-pane="learnings"]');
      if (!node) throw new Error("The learnings pane has not rendered yet.");
      return node as HTMLElement;
    });
    await waitFor(() => {
      expect(within(learnings).getByText("43%")).toBeTruthy();
    });

    const remove = await waitFor(() => {
      const node = learnings.querySelector('[data-review-action="remove-suppression"]');
      if (!node) throw new Error("No suppression row to remove yet.");
      return node as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(remove);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageDeleteSuppression").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageDeleteSuppression")!.args).toEqual({ suppressionId: "suppression-1" });
  });

  it("cancels a running review and reruns a finished one", async () => {
    reinstall({ runs: [fakeRun({ status: "running", findings: [], findingCount: 0 })] });
    render(<RunsEntry context={tabContext()} />);

    const cancel = await waitFor(() => {
      const node = document.querySelector('[data-review-action="cancel-run"]');
      if (!node) throw new Error("The cancel control has not rendered yet.");
      return node as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(cancel);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageCancelRun").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageCancelRun")!.args).toEqual({ runId: "run-1" });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-review-action="rerun"]')!);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageRerun").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageRerun")!.args).toEqual({ runId: "run-1" });
  });

  it("polls when the host refuses the review kind", async () => {
    // The whole point of the fallback: a host that predates the `review` kind
    // must still show a run moving, a second and a half later.
    reinstall({ refuseReviewKind: true, runs: [fakeRun({ status: "running", findings: [], findingCount: 0 })] });
    // `shouldAdvanceTime` keeps the clock moving with real time, so `waitFor`
    // still settles; the explicit advance below is what jumps the poll interval.
    // Fake timers are installed BEFORE the render because the interval has to be
    // registered against this clock — one installed afterwards would never see
    // it, and the test would pass or fail for the wrong reason.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<RunsEntry context={tabContext()} />);

    await waitFor(() => {
      expect(host.callsTo("host.subscribe").length).toBe(1);
    });
    expect(host.lastCall("host.subscribe")!.args).toEqual({ kinds: ["review"] });
    await waitFor(() => {
      expect(document.querySelector('[data-review-live="polling"]')).toBeTruthy();
    });

    const before = host.callsTo("invoke:pageRuns").length;
    await act(async () => {
      vi.advanceTimersByTime(REVIEW_POLL_MS + 100);
    });
    expect(host.callsTo("invoke:pageRuns").length).toBeGreaterThan(before);
    vi.useRealTimers();
  });

  it("keeps drawing the card when the host cannot open an editor", async () => {
    // With the verb: the press reaches the host with a root and a relative path.
    reinstall({ runs: [fakeRun()] });
    render(<RunsEntry context={tabContext()} />);
    const card = await waitFor(() => {
      const node = document.querySelector("[data-review-finding]");
      if (!node) throw new Error("The finding card has not rendered yet.");
      return node as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(card.querySelector('[data-review-action="open-editor"]')!);
    });
    await waitFor(() => {
      expect(host.callsTo("ui.openPathInEditor").length).toBe(1);
    });
    // The lane's own worktree, which rides on the launch context's lanes — the
    // compiled page read the same value out of the app store.
    expect(host.lastCall("ui.openPathInEditor")!.args).toEqual({
      rootPath: "/repo/.ade/worktrees/fix-login",
      relativePath: "src/auth.ts",
      target: "default",
    });

    // Without it: the same card, the same button, and a press that does nothing
    // rather than an exception — which is what the compiled card did for a host
    // whose app bridge had no `openPathInEditor`.
    cleanup();
    root += 1;
    reinstall({ runs: [fakeRun()], withoutEditor: true });
    render(<RunsEntry context={tabContext()} />);
    const guarded = await waitFor(() => {
      const node = document.querySelector("[data-review-finding]");
      if (!node) throw new Error("The finding card has not rendered yet.");
      return node as HTMLElement;
    });
    const button = guarded.querySelector('[data-review-action="open-editor"]')!;
    expect(button).toBeTruthy();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(host.callsTo("ui.openPathInEditor")).toHaveLength(0);
  });

  it("moves the app through the deeplinks ADE actually parses", async () => {
    // The two renderer navigations the compiled page made — `navigate("/files",
    // {state})` and selectLane + focusSession + navigate("/work") — have no
    // guest equivalent, so both are deeplinks. Both are asserted against the
    // real grammar in `shared/deeplinks.ts`, because a route that does not parse
    // opens nothing and says nothing.
    reinstall({ runs: [fakeRun()] });
    render(<RunsEntry context={tabContext()} />);
    const card = await waitFor(() => {
      const node = document.querySelector("[data-review-finding]");
      if (!node) throw new Error("The finding card has not rendered yet.");
      return node as HTMLElement;
    });

    await act(async () => {
      fireEvent.click(card.querySelector('[data-review-action="open-files"]')!);
    });
    await waitFor(() => {
      expect(host.callsTo("openDeeplink").length).toBe(1);
    });
    // The path is a segment of the route, not a query value, and the line rides
    // as `line`. `lane` is absent because "lane-1" is not a UUID and a malformed
    // one fails the WHOLE link rather than being dropped.
    expect(host.lastCall("openDeeplink")!.args.url).toBe("ade://file/src/auth.ts?line=42");

    await act(async () => {
      fireEvent.click(document.querySelector('[data-review-action="open-transcript"]')!);
    });
    await waitFor(() => {
      expect(host.callsTo("openDeeplink").length).toBe(2);
    });
    // The SESSION is the route: `ade://lane/<id>` takes no session parameter.
    expect(host.lastCall("openDeeplink")!.args.url).toBe("ade://session/session-1");
  });

  it("locks the launch popover to the PR the toolbar button opened it at", async () => {
    reinstall({ suppressions: [fakeSuppression()] });
    render(
      <LaunchEntry
        context={{
          ...tabContext({ surfaceId: "launch", placement: "popover" }),
          subject: { kind: "pr", id: "pr-9", laneId: "lane-1", number: 42 },
        }}
      />,
    );

    await waitFor(() => {
      expect(host.callsTo("invoke:pageLaunchContext").length).toBe(1);
    });
    // No target-mode toggle: a PR review has exactly one target.
    expect(document.querySelector("[data-review-target-mode]")).toBeNull();

    await waitFor(() => {
      expect(screen.getByText("Start review")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Start review"));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStartRun").length).toBe(1);
    });
    const started = host.lastCall("invoke:pageStartRun")!.args;
    expect(started.target).toEqual({ mode: "pr", laneId: "lane-1", prId: "pr-9" });
    // The compiled dialog's own choice: a PR review posts back to GitHub.
    expect(started.config).toMatchObject({ publishBehavior: "auto_publish" });

    // It sends the reader to the run and then asks the host to close the
    // popover — the compiled dialog closed and left the run to be found.
    await waitFor(() => {
      expect(host.callsTo("openDeeplink").length).toBe(1);
    });
    // `ctx` is the only query key `ade://plugin/<id>/<panel>` passes through; a
    // bare `runId=` would be discarded in silence and the reader would land on
    // whichever run they last had open.
    const url = new URL(String(host.lastCall("openDeeplink")!.args.url));
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("ade://plugin/ade-review/runs");
    expect(JSON.parse(url.searchParams.get("ctx")!)).toEqual({ runId: host.runs[0]!.id });
    expect(host.callsTo("surface.close").length).toBe(1);
  });

  it("falls back to plain fields when the host has no pickers", async () => {
    // G1: a host without the pickers still launches. The triggers become a
    // native lane select and two text fields, which is worse than ADE's own
    // pickers and far better than a form the reader cannot fill.
    reinstall({ withoutPickers: true });
    render(<RunsEntry context={tabContext()} />);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLaunchContext").length).toBeGreaterThan(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Launch new review"));
    });
    const form = await waitFor(() => {
      const node = document.querySelector('[data-review-pane="launch"]');
      if (!node) throw new Error("The launch form has not opened yet.");
      return node as HTMLElement;
    });
    expect(within(form).getByLabelText("Lane to review").tagName).toBe("SELECT");
    expect(within(form).getByLabelText("Model").tagName).toBe("INPUT");
    expect(within(form).getByLabelText("Reasoning effort").tagName).toBe("INPUT");
    expect(host.callsTo("ui.pickLane")).toHaveLength(0);
    expect(host.callsTo("ui.pickModel")).toHaveLength(0);
    expect(host.callsTo("ui.pickReasoningEffort")).toHaveLength(0);

    await waitFor(() => {
      expect((within(form).getByLabelText("Lane to review") as HTMLSelectElement).value).toBe("lane-1");
    });

    await act(async () => {
      fireEvent.click(within(form).getByText("Start review"));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStartRun").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageStartRun")!.args.target).toEqual({
      mode: "lane_diff",
      laneId: "lane-1",
    });
  });
});
