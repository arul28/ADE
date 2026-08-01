/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PendingInputQuestion, PendingInputRequest } from "../../../shared/types";
import { AskQuestionComposer } from "./AskQuestionComposer";

const buildRequest = (questions: PendingInputQuestion[], overrides: Partial<PendingInputRequest> = {}): PendingInputRequest => ({
  requestId: "req-ask",
  itemId: "approval-ask",
  source: "ade",
  kind: "structured_question",
  title: "Choose plan",
  description: "Which plan should we follow?",
  questions,
  allowsFreeform: true,
  blocking: true,
  canProceedWithoutAnswer: false,
  ...overrides,
});

const renderComposer = (
  request: PendingInputRequest,
  handlers: { onSubmit?: (answers: Record<string, string | string[]>) => void; onDecline?: () => void } = {},
) => {
  const onSubmit = handlers.onSubmit ?? vi.fn();
  const onDecline = handlers.onDecline ?? vi.fn();
  render(<AskQuestionComposer request={request} onSubmit={onSubmit} onDecline={onDecline} />);
  return { onSubmit, onDecline };
};

const planQuestion = (overrides: Partial<PendingInputQuestion> = {}): PendingInputQuestion => ({
  id: "plan_choice",
  header: "Plan",
  question: "Which plan should we follow?",
  options: [
    { label: "Rebase", value: "rebase" },
    { label: "Merge", value: "merge" },
  ],
  allowsFreeform: true,
  ...overrides,
});

beforeEach(() => {
  cleanup();
});

describe("AskQuestionComposer rendering", () => {
  it("renders the header verb, kicker, question, and one ledger row per option", () => {
    renderComposer(buildRequest([
      planQuestion({
        options: [
          { label: "Rebase", value: "rebase", description: "Fast-forward replay.", recommended: true },
          { label: "Merge", value: "merge", description: "Preserve history." },
        ],
      }),
    ]));

    expect(screen.getByRole("group", { name: /ade asks/i })).toBeTruthy();
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getAllByText("Which plan should we follow?").length).toBeGreaterThan(0);
    const rebase = screen.getByTestId("ask-question-option-plan_choice-rebase");
    expect(rebase.textContent ?? "").toContain("Rebase");
    expect(rebase.textContent ?? "").toContain("Fast-forward replay.");
    expect(rebase.textContent ?? "").toContain("Recommended");
    expect(screen.getByTestId("ask-question-option-plan_choice-merge")).toBeTruthy();
  });

  it("regression: preserves impact and the default assumption in the composer", () => {
    renderComposer(buildRequest([
      planQuestion({
        impact: "This changes every existing lane.",
        defaultAssumption: "Keep the current lane layout.",
      }),
    ]));

    expect(screen.getByTestId("ask-question-impact").textContent).toContain("changes every existing lane");
    expect(screen.getByTestId("ask-question-default-assumption").textContent)
      .toContain("Default: Keep the current lane layout.");
  });

  it("preserves exact structured option values when submitting", () => {
    const { onSubmit } = renderComposer(buildRequest([
      planQuestion({ options: [{ label: "  Rebase  ", value: " rebase " }], allowsFreeform: false }),
    ]));

    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByTestId("ask-question-send"));
    expect(onSubmit).toHaveBeenCalledWith({ plan_choice: " rebase " });
  });

  it("regression: uses legacy request-level options when the first question has none", () => {
    const { onSubmit } = renderComposer(buildRequest(
      [planQuestion({ options: [], allowsFreeform: false })],
      { options: [{ label: "Rebase", value: "rebase" }] },
    ));

    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-rebase"));
    fireEvent.click(screen.getByTestId("ask-question-send"));
    expect(onSubmit).toHaveBeenCalledWith({ plan_choice: "rebase" });
  });

  it.each(["__proto__", "toString"])(
    "regression: provider question id %s cannot collide with object state",
    (id) => {
      const { onSubmit } = renderComposer(buildRequest([
        planQuestion({ id, allowsFreeform: false }),
      ]));

      fireEvent.click(screen.getByTestId(`ask-question-option-${id}-rebase`));
      fireEvent.click(screen.getByTestId("ask-question-send"));
      const answers = vi.mocked(onSubmit).mock.calls[0]?.[0];
      expect(Object.prototype.hasOwnProperty.call(answers, id)).toBe(true);
      expect(answers?.[id]).toBe("rebase");
    },
  );
});

describe("AskQuestionComposer answer semantics", () => {
  // Bug 2. The old card submitted on click for a single single-select question
  // — unless the freeform field happened to hold text, in which case the same
  // click only selected. One gesture, two outcomes, no signal.
  it("regression: selecting an option marks it and never submits on click", () => {
    const { onSubmit } = renderComposer(buildRequest([planQuestion({ allowsFreeform: false })]));

    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-rebase"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("ask-question-option-plan_choice-rebase").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByTestId("ask-question-send"));
    expect(onSubmit).toHaveBeenCalledWith({ plan_choice: "rebase" });
  });

  // The same click, with and without a note, must do the same thing.
  it("regression: a click behaves identically whether or not a note is typed", () => {
    const { onSubmit } = renderComposer(buildRequest([planQuestion()]));

    fireEvent.change(screen.getByTestId("ask-question-note-plan_choice"), {
      target: { value: "Keep the release note." },
    });
    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-rebase"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("ask-question-option-plan_choice-rebase").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByTestId("ask-question-send"));
    expect(onSubmit).toHaveBeenCalledWith({ plan_choice: ["rebase", "Keep the release note."] });
  });

  it("keeps the note when a pick lands after it, and the pick when a note lands after it", () => {
    const { onSubmit } = renderComposer(buildRequest([planQuestion()]));

    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-rebase"));
    fireEvent.change(screen.getByTestId("ask-question-note-plan_choice"), { target: { value: "only if CI is green" } });

    expect(screen.getByTestId("ask-question-option-plan_choice-rebase").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("ask-question-send"));
    expect(onSubmit).toHaveBeenCalledWith({ plan_choice: ["rebase", "only if CI is green"] });
  });

  it("accumulates multi-select values and sends them as an array", () => {
    const { onSubmit } = renderComposer(buildRequest([
      {
        id: "areas",
        header: "Areas",
        question: "Which surfaces should regression tests cover?",
        multiSelect: true,
        options: [
          { label: "Desktop", value: "desktop" },
          { label: "iOS", value: "ios" },
          { label: "Sync", value: "sync" },
        ],
        allowsFreeform: false,
      },
    ]));

    fireEvent.click(screen.getByTestId("ask-question-option-areas-desktop"));
    fireEvent.click(screen.getByTestId("ask-question-option-areas-sync"));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("ask-question-send"));
    expect(onSubmit).toHaveBeenCalledWith({ areas: ["desktop", "sync"] });
  });

  it("sends a note-only answer when nothing is picked", () => {
    const { onSubmit } = renderComposer(buildRequest([planQuestion()]));

    fireEvent.change(screen.getByTestId("ask-question-note-plan_choice"), { target: { value: "neither, actually" } });
    expect(screen.getByTestId("ask-question-send").textContent).toBe("Send note");
    fireEvent.click(screen.getByTestId("ask-question-send"));
    expect(onSubmit).toHaveBeenCalledWith({ plan_choice: "neither, actually" });
  });
});

describe("AskQuestionComposer send label", () => {
  it("reads back the payload as the state changes", () => {
    renderComposer(buildRequest([planQuestion({ multiSelect: true })]));
    const send = () => screen.getByTestId("ask-question-send");

    expect(send().textContent).toBe("Send");
    expect(send()).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-rebase"));
    expect(send().textContent).toBe("Send 1");
    expect(send()).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-merge"));
    expect(send().textContent).toBe("Send 2 picks");

    fireEvent.change(screen.getByTestId("ask-question-note-plan_choice"), { target: { value: "note" } });
    expect(send().textContent).toBe("Send 2 + note");
  });

  it("switches the note placeholder between answer and qualifier", () => {
    renderComposer(buildRequest([planQuestion({ multiSelect: true })]));
    const note = () => screen.getByTestId("ask-question-note-plan_choice") as HTMLInputElement;

    expect(note().placeholder).toBe("Or send your own response instead");
    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-rebase"));
    expect(note().placeholder).toBe("Add a note (sent with your pick)");
    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-merge"));
    expect(note().placeholder).toBe("Add a note (sent with your 2 picks)");
  });

  it("uses a plain answer placeholder when the question offers no options", () => {
    renderComposer(buildRequest([
      { id: "free", header: "Free", question: "What should I name it?", allowsFreeform: true },
    ]));
    expect((screen.getByTestId("ask-question-note-free") as HTMLInputElement).placeholder).toBe("Your answer");
  });
});

describe("AskQuestionComposer previews", () => {
  const strategyRequest = buildRequest([
    {
      id: "strategy",
      header: "Strategy",
      question: "Pick a merge strategy",
      options: [
        { label: "Squash", value: "squash", recommended: true, preview: "Squash preview", previewFormat: "markdown" },
        { label: "Rebase", value: "rebase", preview: "Rebase preview", previewFormat: "markdown" },
      ],
    },
  ]);

  it("opens a preview only on its own disclosure control, and does not select the option", () => {
    const { onSubmit } = renderComposer(strategyRequest);

    expect(screen.queryByTestId("ask-question-preview-strategy-squash")).toBeNull();
    fireEvent.click(screen.getByTestId("ask-question-preview-toggle-strategy-squash"));

    const preview = screen.getByTestId("ask-question-preview-strategy-squash");
    expect(preview.textContent ?? "").toContain("Squash preview");
    expect(screen.getByTestId("ask-question-option-strategy-squash").getAttribute("aria-checked")).toBe("false");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("regression: reserves a fixed option viewport before preview disclosure", () => {
    renderComposer(strategyRequest);
    const viewport = screen.getByTestId("ask-question-options-viewport-strategy");
    const heightBefore = viewport.style.height;

    expect(heightBefore).not.toBe("");
    fireEvent.click(screen.getByTestId("ask-question-preview-toggle-strategy-squash"));
    expect(viewport.style.height).toBe(heightBefore);
  });

  // Bug 3. Hover used to set the focused option, which swapped the preview,
  // which changed the card height, which made the virtualizer re-measure and
  // reconcile scroll — so the row walked out from under the cursor.
  it("regression: mouseEnter on an option changes no state and no preview", () => {
    renderComposer(strategyRequest);

    fireEvent.click(screen.getByTestId("ask-question-preview-toggle-strategy-squash"));
    const before = screen.getByTestId("ask-question-composer").innerHTML;

    fireEvent.mouseEnter(screen.getByTestId("ask-question-option-strategy-rebase"));
    fireEvent.mouseOver(screen.getByTestId("ask-question-option-strategy-rebase"));

    expect(screen.getByTestId("ask-question-composer").innerHTML).toBe(before);
    expect(screen.queryByTestId("ask-question-preview-strategy-rebase")).toBeNull();
    expect(screen.getByTestId("ask-question-preview-strategy-squash").textContent ?? "").toContain("Squash preview");
  });

  it("regression: no preview is open until one is explicitly disclosed, recommended included", () => {
    renderComposer(strategyRequest);
    expect(screen.queryByTestId("ask-question-preview-strategy-squash")).toBeNull();
    expect(screen.queryByTestId("ask-question-preview-strategy-rebase")).toBeNull();
  });

  it("renders a wireframe preview in an aligned monospace block", () => {
    const wireframe = "┌──────────┐\n│ Home     │\n├──────────┤\n│ ▸ item   │\n└──────────┘";
    renderComposer(buildRequest([
      {
        id: "layout",
        header: "Layout",
        question: "Pick a layout",
        options: [
          // previewFormat is "markdown" but the content is ASCII art — it must
          // still render column-preserved, not collapsed into prose.
          { label: "Boxed", value: "boxed", preview: wireframe, previewFormat: "markdown" },
          { label: "Plain", value: "plain" },
        ],
      },
    ]));

    fireEvent.click(screen.getByTestId("ask-question-preview-toggle-layout-boxed"));
    const pre = screen.getByTestId("ask-question-preview-layout-boxed").querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre?.textContent ?? "").toContain("│ Home     │");
  });

  it("offers Compare only when two options carry previews", () => {
    renderComposer(strategyRequest);
    fireEvent.click(screen.getByTestId("ask-question-compare-toggle"));
    const compare = screen.getByTestId("ask-question-compare");
    expect(compare.textContent ?? "").toContain("Squash preview");
    expect(compare.textContent ?? "").toContain("Rebase preview");

    cleanup();
    renderComposer(buildRequest([planQuestion()]));
    expect(screen.queryByTestId("ask-question-compare-toggle")).toBeNull();
  });
});

describe("AskQuestionComposer keyboard", () => {
  it("number keys mark an option without submitting, and Enter sends", () => {
    const { onSubmit } = renderComposer(buildRequest([planQuestion()]));
    const card = screen.getByRole("group", { name: /ade asks/i });

    fireEvent.keyDown(card, { key: "1" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("ask-question-option-plan_choice-rebase").getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(card, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ plan_choice: "rebase" });
  });

  // B1. The note input handles its own Enter; `preventDefault` does not stop
  // propagation, so an unguarded root handler ran `advance()` a second time in
  // the same dispatch — two chat.respondToInput for one itemId.
  it("regression: Enter in the note field submits exactly once", () => {
    const { onSubmit } = renderComposer(buildRequest([planQuestion()]));

    fireEvent.change(screen.getByTestId("ask-question-note-plan_choice"), { target: { value: "just this" } });
    fireEvent.keyDown(screen.getByTestId("ask-question-note-plan_choice"), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ plan_choice: "just this" });
  });

  it("regression: Enter in the note field advances a paged set exactly once", () => {
    const { onSubmit } = renderComposer(buildRequest([
      planQuestion(),
      { id: "scope", header: "Scope", question: "How wide?", allowsFreeform: true },
    ]));

    fireEvent.change(screen.getByTestId("ask-question-note-plan_choice"), { target: { value: "rebase-ish" } });
    fireEvent.keyDown(screen.getByTestId("ask-question-note-plan_choice"), { key: "Enter" });

    // One advance, not two: we land on question 2, not past the end.
    expect(screen.getByText("How wide?")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("escape declines", () => {
    const { onDecline } = renderComposer(buildRequest([planQuestion()]));
    fireEvent.keyDown(screen.getByRole("group", { name: /ade asks/i }), { key: "Escape" });
    expect(onDecline).toHaveBeenCalled();
  });

  it("does not hijack digits typed into the note field", () => {
    const { onSubmit } = renderComposer(buildRequest([planQuestion()]));
    const note = screen.getByTestId("ask-question-note-plan_choice");
    fireEvent.keyDown(note, { key: "1" });
    expect(screen.getByTestId("ask-question-option-plan_choice-rebase").getAttribute("aria-checked")).toBe("false");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("AskQuestionComposer paging", () => {
  const pagedRequest = buildRequest([
    planQuestion(),
    {
      id: "scope",
      header: "Scope",
      question: "How wide should the change be?",
      options: [
        { label: "Narrow", value: "narrow" },
        { label: "Wide", value: "wide" },
      ],
      allowsFreeform: true,
    },
  ]);

  it("advances with Next, keeps per-question answers, and sends them together", () => {
    const { onSubmit } = renderComposer(pagedRequest);

    expect(screen.getByTestId("ask-question-send").textContent).toBe("Next");
    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-rebase"));
    fireEvent.click(screen.getByTestId("ask-question-send"));

    expect(screen.getByText("How wide should the change be?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ask-question-option-scope-wide"));
    expect(screen.getByTestId("ask-question-send").textContent).toBe("Send 2 answers");

    fireEvent.click(screen.getByTestId("ask-question-send"));
    expect(onSubmit).toHaveBeenCalledWith({ plan_choice: "rebase", scope: "wide" });
  });

  it("keeps Send disabled until every question is answered", () => {
    renderComposer(pagedRequest);
    fireEvent.click(screen.getByTestId("ask-question-dot-scope"));
    expect(screen.getByTestId("ask-question-send")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByTestId("ask-question-option-scope-wide"));
    expect(screen.getByTestId("ask-question-send")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("ask-question-send").textContent).toBe("Send 1 answers");
  });

  it("jumps between questions from the dot rail without losing answers", () => {
    renderComposer(pagedRequest);
    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-rebase"));
    fireEvent.click(screen.getByTestId("ask-question-dot-scope"));
    fireEvent.click(screen.getByTestId("ask-question-dot-plan_choice"));
    expect(screen.getByTestId("ask-question-option-plan_choice-rebase").getAttribute("aria-checked")).toBe("true");
  });
});

describe("AskQuestionComposer minimize", () => {
  it("folds to a single line that keeps the gate open, and expands back", () => {
    const { onSubmit, onDecline } = renderComposer(buildRequest([planQuestion()]));

    fireEvent.click(screen.getByTestId("ask-question-minimize"));
    const folded = screen.getByTestId("ask-question-composer-folded");
    expect(folded.textContent ?? "").toContain("Plan");
    expect(folded.textContent ?? "").toContain("Which plan should we follow?");
    // Minimize is not a dismiss and not a decline: nothing was sent.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();

    fireEvent.click(folded.querySelector("button")!);
    expect(screen.getByTestId("ask-question-composer")).toBeTruthy();
  });

  it("keeps picks across a fold and unfold", () => {
    const { onSubmit } = renderComposer(buildRequest([planQuestion()]));
    fireEvent.click(screen.getByTestId("ask-question-option-plan_choice-rebase"));
    fireEvent.click(screen.getByTestId("ask-question-minimize"));
    fireEvent.click(screen.getByTestId("ask-question-composer-folded").querySelector("button")!);
    fireEvent.click(screen.getByTestId("ask-question-send"));
    expect(onSubmit).toHaveBeenCalledWith({ plan_choice: "rebase" });
  });
});

describe("AskQuestionComposer teardown", () => {
  // The ref callback's teardown call passes null, so anything registered
  // against the old node has to be disconnected from a closure that still holds
  // it. Registering in the callback leaked a live ResizeObserver and scroll
  // listener per resolved question, each still calling setState on an unmounted
  // tree.
  it("regression: disconnects its observers on unmount", () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    } as unknown as typeof ResizeObserver;

    try {
      const view = render(
        <AskQuestionComposer
          request={buildRequest([planQuestion()])}
          onSubmit={vi.fn()}
          onDecline={vi.fn()}
        />,
      );
      expect(observe).toHaveBeenCalled();
      view.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});

describe("AskQuestionComposer freeform opt-out", () => {
  // A provider that declined freeform must not be shown a note field, or we
  // send it text it never agreed to accept.
  it("regression: renders no note row when allowsFreeform is explicitly false", () => {
    renderComposer(buildRequest([planQuestion({ allowsFreeform: false })]));
    expect(screen.queryByTestId("ask-question-note-plan_choice")).toBeNull();
  });

  it("renders the note row when allowsFreeform is unspecified", () => {
    const question = planQuestion();
    delete (question as { allowsFreeform?: boolean }).allowsFreeform;
    renderComposer(buildRequest([question]));
    expect(screen.getByTestId("ask-question-note-plan_choice")).toBeTruthy();
  });
});

describe("AskQuestionComposer decline", () => {
  it("declines from the footer button and from the header ×", () => {
    const { onDecline } = renderComposer(buildRequest([planQuestion()]));
    fireEvent.click(screen.getByTestId("ask-question-decline"));
    fireEvent.click(screen.getByTestId("ask-question-decline-x"));
    expect(onDecline).toHaveBeenCalledTimes(2);
  });
});
