/**
 * The four gaps this wave closed, each against the same scripted bridge the
 * seam test uses.
 *
 * The seam test walks the product end to end and asserts the CALLS; this file
 * is narrower on purpose — one behaviour per test, each one a thing a reader
 * would look for and, before this wave, not find:
 *
 * - the fast-mode toggle, drawn only over a model that has a fast service tier
 *   (`chat.capabilities().models[].fastMode`) and able to turn the tier back
 *   OFF, which ADE's own picker cannot do without being reopened;
 * - the model allow-list, so ADE's picker offers the models a review can
 *   actually run rather than the whole catalogue;
 * - the `pr` arm of the scope diagram, which used to fall through to the
 *   lane-diff shape and name the wrong two refs;
 * - a rerun, a cancel and a feedback whose CALL failed, which used to fall out
 *   of the promise with nothing on screen.
 *
 * Nothing here sleeps. Every wait is on a call the fake recorded or on a node
 * the page rendered.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { LaunchEntry } from "../src/entries/LaunchEntry";
import { RunsEntry } from "../src/entries/RunsEntry";
import {
  fakeRun,
  installFakeBridge,
  uninstallFakeBridge,
  type FakeBridge,
  type FakeBridgeOptions,
} from "./fakeBridge";

/** A fresh project root per test, so no stored selection crosses a walk. */
let root = 0;

function pageContext(overrides: Record<string, unknown> = {}) {
  return {
    subject: null,
    surfaceId: "launch",
    placement: "popover" as const,
    project: { projectId: `project-${root}`, root: `/repo-${root}`, binding: "local" as const },
    ...overrides,
  };
}

let host: FakeBridge;

beforeEach(() => {
  root += 1;
  host = installFakeBridge();
});

function reinstall(options: FakeBridgeOptions): void {
  uninstallFakeBridge();
  host = installFakeBridge(options);
}

afterEach(() => {
  cleanup();
  uninstallFakeBridge();
});

/** The launch popover, mounted and past its two mount reads. */
async function launchForm(context = pageContext()): Promise<HTMLElement> {
  render(<LaunchEntry context={context} />);
  await waitFor(() => {
    expect(host.callsTo("invoke:pageLaunchContext").length).toBeGreaterThan(0);
  });
  return await waitFor(() => {
    const node = document.querySelector('[data-review-pane="launch"]');
    if (!node) throw new Error("The launch form has not opened yet.");
    return node as HTMLElement;
  });
}

const fastToggle = (): HTMLElement | null =>
  document.querySelector('[data-review-toggle="fast-mode"]');

describe("the launch form's model controls", () => {
  it("narrows ADE's picker to the models this page can launch", async () => {
    const form = await launchForm();
    // The list is a MOUNT read — the registry cannot change while the page is
    // open — so the press below must find it already answered.
    await waitFor(() => {
      expect(host.callsTo("invoke:pageChatModels").length).toBe(1);
    });

    await act(async () => {
      fireEvent.click(within(form).getByLabelText("Model"));
    });
    await waitFor(() => {
      expect(host.callsTo("ui.pickModel").length).toBe(1);
    });
    // Both halves: the row the picker opens ON, and the rows it may offer.
    expect(host.lastCall("ui.pickModel")!.args).toMatchObject({
      value: "openai/gpt-5.6-sol",
      availableModelIds: ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"],
    });
  });

  it("passes no allow-list at all when the host answers no capabilities", async () => {
    // The right degradation, and the behaviour before this existed: ADE reads
    // an EMPTY list as "narrow to nothing", so a host that cannot answer must
    // leave the field off rather than send `[]` and empty the picker.
    reinstall({ withoutChatModels: true });
    const form = await launchForm();
    await waitFor(() => {
      expect(host.callsTo("invoke:pageChatModels").length).toBe(1);
    });

    await act(async () => {
      fireEvent.click(within(form).getByLabelText("Model"));
    });
    await waitFor(() => {
      expect(host.callsTo("ui.pickModel").length).toBe(1);
    });
    expect(host.lastCall("ui.pickModel")!.args).not.toHaveProperty("availableModelIds");
    // And no toggle, because nothing said the model has a tier to toggle.
    expect(fastToggle()).toBeNull();
  });

  it("draws no fast-mode toggle over a model with no fast tier", async () => {
    const form = await launchForm();
    await waitFor(() => {
      expect(host.callsTo("invoke:pageChatModels").length).toBe(1);
    });
    // The form opens on `openai/gpt-5.6-sol`, whose capability row says
    // `fastMode: false`. A toggle here would be a switch that fails the launch.
    expect(within(form).getByLabelText("Model").textContent).toContain("openai/gpt-5.6-sol");
    expect(fastToggle()).toBeNull();
  });

  it("draws the toggle over a fast-tier model, and turns the tier back off", async () => {
    const form = await launchForm();
    await waitFor(() => {
      expect(host.callsTo("invoke:pageChatModels").length).toBe(1);
    });

    // ADE's picker sets the model and the tier in one gesture — the scripted
    // one answers `anthropic/claude-opus-5` with `fastMode: true`.
    await act(async () => {
      fireEvent.click(within(form).getByLabelText("Model"));
    });
    const toggle = await waitFor(() => {
      const node = fastToggle();
      if (!node) throw new Error("The fast-mode toggle has not appeared yet.");
      return node;
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    // The whole point of drawing it: the reader can undo the picker's choice
    // without reopening the picker.
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(fastToggle()!.getAttribute("aria-pressed")).toBe("false");
    });

    await act(async () => {
      fireEvent.click(within(form).getByText("Start review"));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStartRun").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageStartRun")!.args.config).toMatchObject({
      modelId: "anthropic/claude-opus-5",
      fastMode: false,
    });
  });

  it("clears a fast launch when the reader moves to a model with no fast tier", async () => {
    const form = await launchForm();
    await waitFor(() => {
      expect(host.callsTo("invoke:pageChatModels").length).toBe(1);
    });

    await act(async () => {
      fireEvent.click(within(form).getByLabelText("Model"));
    });
    await waitFor(() => {
      expect(fastToggle()).toBeTruthy();
    });

    // A second pick that lands on a model the capabilities say has NO fast
    // tier, while still claiming the tier. The draft must not keep it: the
    // launch would be refused, and the toggle that said so is gone from the
    // screen.
    host.bridge.ui!.pickModel = async () => ({ modelId: "openai/gpt-5.6-sol", fastMode: true });
    await act(async () => {
      fireEvent.click(within(form).getByLabelText("Model"));
    });
    await waitFor(() => {
      expect(fastToggle()).toBeNull();
    });

    await act(async () => {
      fireEvent.click(within(form).getByText("Start review"));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStartRun").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageStartRun")!.args.config).toMatchObject({
      modelId: "openai/gpt-5.6-sol",
      fastMode: false,
    });
  });
});

describe("a launch that is in flight", () => {
  it("freezes the form and holds the dialog open until it answers", async () => {
    reinstall({});
    render(<RunsEntry context={pageContext({ surfaceId: "runs", placement: "tab" })} />);
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

    // A launch the host never answers, which is what "in flight" means here.
    host.setAction("pageStartRun", () => new Promise(() => {}));
    await act(async () => {
      fireEvent.click(within(form).getByText("Start review"));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageStartRun").length).toBe(1);
    });

    // Every control the reader could otherwise change the launch with, while
    // the launch it was built from is already on the wire.
    const disabled = (node: Element | null): boolean => (node as HTMLButtonElement | null)?.disabled === true;
    expect(disabled(within(form).getByLabelText("Lane to review"))).toBe(true);
    expect(disabled(within(form).getByLabelText("Model"))).toBe(true);
    expect(disabled(within(form).getByLabelText("Reasoning effort"))).toBe(true);
    expect(disabled(form.querySelector('[data-review-target-mode="commit_range"]'))).toBe(true);
    expect(disabled(form.querySelector('[data-review-compare-kind="lane"]'))).toBe(true);
    expect(disabled(within(form).getByText("Cancel").closest("button"))).toBe(true);
    expect(disabled(form.querySelector('[data-review-action="start-run"]'))).toBe(true);

    // And the chrome around it: Escape must not dismiss the reader into a
    // half-started run.
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    });
    expect(document.querySelector('[data-review-pane="launch"]')).toBeTruthy();
  });
});

describe("the scope diagram's pr arm", () => {
  it("draws the pull request's head against its base, captioned as such", async () => {
    const form = await launchForm(
      pageContext({
        subject: {
          kind: "pr",
          id: "pr-9",
          laneId: "lane-1",
          number: 42,
          title: "Fix the login redirect",
          branch: "refs/heads/feature/pr-head",
        },
      }),
    );

    const scope = await waitFor(() => {
      const node = within(form).getByText("PR #42").closest("[data-review-scope]");
      if (!node) throw new Error("The scope card has not rendered yet.");
      return node as HTMLElement;
    });
    // The attribute the runs browser and the form both key off stays the mode.
    expect(scope.getAttribute("data-review-scope")).toBe("pr");

    // The head ref is the PR's own, not the lane's branch, and the base is the
    // plain base ref — the lane-diff fallback drew "fix-login" against
    // "local main", which names neither end of a pull request.
    expect(within(scope).getByText("feature/pr-head")).toBeTruthy();
    expect(within(scope).getByText("Fix the login redirect")).toBeTruthy();
    expect(within(scope).getByText("main")).toBeTruthy();
    expect(within(scope).getByText("Merges into")).toBeTruthy();
  });

  it("falls back to the lane's branch when the host sent no head ref", async () => {
    // A thinner `pr` subject — the shape the seam test's own PR walk uses.
    // Nothing is invented: the lane IS the PR's checkout, so its branch stands
    // in, and the caption still says which end of a pull request this is.
    const form = await launchForm(
      pageContext({ subject: { kind: "pr", id: "pr-9", laneId: "lane-1", number: 42 } }),
    );
    const scope = await waitFor(() => {
      // "PR #42" twice over: the card's title, and the left node's caption
      // standing in for the title the host did not send.
      const node = within(form).getAllByText("PR #42")[0]?.closest("[data-review-scope]");
      if (!node) throw new Error("The scope card has not rendered yet.");
      return node as HTMLElement;
    });
    expect(scope.getAttribute("data-review-scope")).toBe("pr");
    expect(within(scope).getByText("fix-login")).toBeTruthy();
    expect(within(scope).getAllByText("PR #42").length).toBe(2);
    expect(within(scope).getByText("Merges into")).toBeTruthy();
  });
});

describe("a call that never reached the host", () => {
  /** The runs browser, mounted on one run and past its reads. */
  async function browser(options: FakeBridgeOptions): Promise<void> {
    reinstall(options);
    render(<RunsEntry context={pageContext({ surfaceId: "runs", placement: "tab" })} />);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageRunDetail").length).toBeGreaterThan(0);
    });
  }

  it("toasts the host's own message when a rerun cannot be sent", async () => {
    await browser({ runs: [fakeRun()] });
    host.setAction("pageRerun", () => {
      throw new Error("The plugin host is gone.");
    });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-review-action="rerun"]')!);
    });
    await waitFor(() => {
      expect(host.callsTo("ui.toast").length).toBe(1);
    });
    // The host's OWN sentence, not one of ours: it is the only description of
    // what actually broke.
    expect(host.lastCall("ui.toast")!.args).toMatchObject({
      level: "error",
      message: "The plugin host is gone.",
    });
    // And the button is released rather than left saying "Rerunning".
    await waitFor(() => {
      expect(document.querySelector('[data-review-action="rerun"]')!.textContent).toContain("Rerun");
    });
  });

  it("toasts when a cancel cannot be sent, and leaves the run running", async () => {
    await browser({ runs: [fakeRun({ status: "running", endedAt: null, summary: null })] });
    host.setAction("pageCancelRun", () => {
      throw new Error("The review daemon is not answering.");
    });

    const cancel = await waitFor(() => {
      const node = document.querySelector('[data-review-action="cancel-run"]');
      if (!node) throw new Error("The running banner has not rendered yet.");
      return node as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(cancel);
    });
    await waitFor(() => {
      expect(host.callsTo("ui.toast").length).toBe(1);
    });
    expect(host.lastCall("ui.toast")!.args).toMatchObject({
      level: "error",
      message: "The review daemon is not answering.",
    });
    // The run is still running, and the banner still says so — the reader must
    // not be left believing they stopped it.
    expect(host.runs[0]!.status).toBe("running");
    expect(document.querySelector('[data-review-action="cancel-run"]')).toBeTruthy();
  });

  it("toasts a failed acknowledge from the finding card", async () => {
    await browser({ runs: [fakeRun()] });
    host.setAction("pageRecordFeedback", () => {
      throw new Error("The feedback never left the page.");
    });

    const card = await waitFor(() => {
      const node = document.querySelector("[data-review-finding]");
      if (!node) throw new Error("The finding card has not rendered yet.");
      return node as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(within(card).getByText("Useful"));
    });
    await waitFor(() => {
      expect(host.callsTo("ui.toast").length).toBe(1);
    });
    expect(host.lastCall("ui.toast")!.args).toMatchObject({
      level: "error",
      message: "The feedback never left the page.",
    });
    expect(host.feedback).toHaveLength(0);
  });

  it("keeps the feedback modal open when the submit cannot be sent", async () => {
    await browser({ runs: [fakeRun()] });
    host.setAction("pageRecordFeedback", () => {
      throw new Error("The feedback never left the page.");
    });

    const card = document.querySelector("[data-review-finding]") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(card).getByText("Dismiss"));
    });
    const modal = await waitFor(() => {
      const node = document.querySelector('[data-review-modal="feedback"]');
      if (!node) throw new Error("The dismiss modal has not opened yet.");
      return node as HTMLElement;
    });

    await act(async () => {
      fireEvent.click(modal.querySelector('[data-review-action="submit-feedback"]')!);
    });
    await waitFor(() => {
      expect(host.callsTo("ui.toast").length).toBe(1);
    });
    // Closing the modal is the card's one optimistic act, and it is reversed:
    // a note the reader typed must not go with a feedback that never arrived.
    expect(document.querySelector('[data-review-modal="feedback"]')).toBeTruthy();
  });
});
