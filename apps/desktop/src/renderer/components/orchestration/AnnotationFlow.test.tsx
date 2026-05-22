/* @vitest-environment jsdom */

/**
 * Annotation popover end-to-end (renderer): user selects text or clicks
 * "Annotate spec" → popover opens → types comment → CustomEvent dispatches
 * with correct payload → composer attachment merge listener fires.
 *
 * See `goal.md` §10.7 + §17 step 5.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AnnotationPopover,
  dispatchOrchestrationAnnotation,
  openAnnotationFromTextSelection,
  useAnnotationPopoverController,
  type AnnotationPopoverAnchor,
} from "./AnnotationPopover";
import { SpecPreviewCard } from "./SpecPreviewCard";
import { ORCHESTRATION_ANNOTATION_EVENT, type OrchestrationAnnotationEventDetail, type OrchestrationContextItem } from "../../../shared/types/orchestration";

afterEach(() => {
  cleanup();
});

describe("AnnotationPopover", () => {
  const RUN_ID = "run-test-1";
  const SESSION_ID = "session-lead-1";

  it("dispatches `ade:agent-chat:add-plan-annotation` on submit with the anchor + comment", async () => {
    const events: OrchestrationAnnotationEventDetail[] = [];
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OrchestrationAnnotationEventDetail>).detail;
      events.push(detail);
    };
    window.addEventListener(ORCHESTRATION_ANNOTATION_EVENT, handler);

    const anchor: AnnotationPopoverAnchor = {
      kind: "text",
      preview: "build the login form",
      selectionExcerpt: "build the login form",
    };
    const onClose = vi.fn();
    render(
      <AnnotationPopover
        runId={RUN_ID}
        sessionId={SESSION_ID}
        anchor={anchor}
        onClose={onClose}
      />,
    );

    const textarea = await screen.findByPlaceholderText(/Comment \(Enter to inject/i);
    fireEvent.change(textarea, { target: { value: "this should be a single primary button" } });

    const submitBtn = screen.getByTestId("orchestration-annotation-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.sessionId).toBe(SESSION_ID);
    expect(events[0]!.item.runId).toBe(RUN_ID);
    expect(events[0]!.item.anchor.kind).toBe("text");
    expect(events[0]!.item.anchor.preview).toBe("build the login form");
    expect(events[0]!.item.selectionExcerpt).toBe("build the login form");
    expect(events[0]!.item.comment).toBe("this should be a single primary button");
    expect(events[0]!.item.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(onClose).toHaveBeenCalledTimes(1);

    window.removeEventListener(ORCHESTRATION_ANNOTATION_EVENT, handler);
  });

  it("allows anchor-only submits (empty comment) so the user can pin context", async () => {
    const events: OrchestrationAnnotationEventDetail[] = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent<OrchestrationAnnotationEventDetail>).detail);
    };
    window.addEventListener(ORCHESTRATION_ANNOTATION_EVENT, handler);

    render(
      <AnnotationPopover
        runId={RUN_ID}
        sessionId={SESSION_ID}
        anchor={{ kind: "image", id: "asset-1", preview: "screenshot.png" }}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("orchestration-annotation-submit"));

    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.item.comment).toBe("");
    expect(events[0]!.item.anchor.id).toBe("asset-1");

    window.removeEventListener(ORCHESTRATION_ANNOTATION_EVENT, handler);
  });

  it("Escape closes the popover without dispatching", async () => {
    const onClose = vi.fn();
    const events: OrchestrationAnnotationEventDetail[] = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent<OrchestrationAnnotationEventDetail>).detail);
    };
    window.addEventListener(ORCHESTRATION_ANNOTATION_EVENT, handler);

    render(
      <AnnotationPopover
        runId={RUN_ID}
        sessionId={SESSION_ID}
        anchor={{ kind: "text", preview: "abc" }}
        onClose={onClose}
      />,
    );
    const textarea = await screen.findByPlaceholderText(/Comment \(Enter to inject/i);
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);

    window.removeEventListener(ORCHESTRATION_ANNOTATION_EVENT, handler);
  });
});

describe("dispatchOrchestrationAnnotation", () => {
  it("dispatches the named CustomEvent with the supplied detail", () => {
    const events: OrchestrationAnnotationEventDetail[] = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent<OrchestrationAnnotationEventDetail>).detail);
    };
    window.addEventListener(ORCHESTRATION_ANNOTATION_EVENT, handler);

    const item: OrchestrationContextItem = {
      type: "orchestration_annotation",
      runId: "run-x",
      anchor: { kind: "spec", id: "spec-1", preview: "spec preview" },
      selectionExcerpt: "",
      comment: "look at this",
      capturedAt: "2026-05-22T00:00:00.000Z",
    };
    dispatchOrchestrationAnnotation({ sessionId: "session-x", item });

    expect(events).toHaveLength(1);
    expect(events[0]!.item).toEqual(item);

    window.removeEventListener(ORCHESTRATION_ANNOTATION_EVENT, handler);
  });
});

describe("SpecPreviewCard right-click → annotate", () => {
  beforeEach(() => {
    // jsdom doesn't open iframes; nothing to mock.
  });

  it("renders the iframe + opens the popover on the Annotate spec affordance", async () => {
    render(
      <SpecPreviewCard
        href="artifacts/ui/login.html"
        resolvedUrl="file:///tmp/bundle/artifacts/ui/login.html"
        label="login.html"
        runId="run-spec-1"
        assetId="asset-login"
        sessionId="session-1"
      />,
    );

    // Card itself
    const card = screen.getByTestId("orchestration-spec-preview-card");
    expect(card).toBeTruthy();

    // Annotate button surfaces when runId is provided.
    const annotateBtn = screen.getByTestId("orchestration-spec-annotate-button");
    fireEvent.click(annotateBtn);
    const popover = await screen.findByTestId("orchestration-annotation-popover");
    expect(popover.getAttribute("data-annotation-kind")).toBe("spec");
  });

  it("hides the Annotate spec button when runId is not supplied", () => {
    render(
      <SpecPreviewCard
        href="artifacts/ui/login.html"
        resolvedUrl="file:///tmp/x.html"
        label="login.html"
      />,
    );
    expect(screen.queryByTestId("orchestration-spec-annotate-button")).toBeNull();
  });

  it("right-click on the card opens the popover when runId is provided", async () => {
    render(
      <SpecPreviewCard
        href="artifacts/ui/x.html"
        resolvedUrl="file:///tmp/x.html"
        label="x.html"
        runId="run-1"
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("orchestration-spec-preview-card"));
    const popover = await screen.findByTestId("orchestration-annotation-popover");
    expect(popover).toBeTruthy();
  });
});

describe("openAnnotationFromTextSelection", () => {
  it("returns false when the selection is empty/collapsed", () => {
    const controller = makeStubController();
    // jsdom default selection is collapsed → false.
    const sel = window.getSelection();
    sel?.removeAllRanges();
    const result = openAnnotationFromTextSelection(controller);
    expect(result).toBe(false);
    expect(controller.open).not.toHaveBeenCalled();
  });

  it("opens the controller with a text anchor when there is a selection", () => {
    const node = document.createElement("p");
    node.textContent = "hello selection world";
    document.body.appendChild(node);

    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const controller = makeStubController();
    const result = openAnnotationFromTextSelection(controller, { sectionId: "section-1" });
    expect(result).toBe(true);
    expect(controller.open).toHaveBeenCalledTimes(1);
    const args = controller.open.mock.calls[0]!;
    expect(args[0]).toMatchObject({
      kind: "text",
      sectionId: "section-1",
      preview: "hello selection world",
      selectionExcerpt: "hello selection world",
    });
  });
});

function makeStubController() {
  return {
    open: vi.fn(),
    close: vi.fn(),
    anchor: null,
    position: null,
    isOpen: false,
  };
}

describe("useAnnotationPopoverController", () => {
  it("opens and closes via the hook handles", () => {
    function Probe({ trigger }: { trigger: () => void }) {
      const ctrl = useAnnotationPopoverController();
      const triggerOpen = () => {
        ctrl.open({ kind: "text", preview: "hi" });
        // Surface state so the assertion can read it.
        if (ctrl.isOpen) trigger();
      };
      return (
        <div>
          <button data-testid="probe-open" onClick={triggerOpen}>
            open
          </button>
          <button data-testid="probe-close" onClick={ctrl.close}>
            close
          </button>
          <span data-testid="probe-status">{ctrl.isOpen ? "open" : "closed"}</span>
        </div>
      );
    }
    const trigger = vi.fn();
    render(<Probe trigger={trigger} />);

    expect(screen.getByTestId("probe-status").textContent).toBe("closed");
    fireEvent.click(screen.getByTestId("probe-open"));
    expect(screen.getByTestId("probe-status").textContent).toBe("open");
    fireEvent.click(screen.getByTestId("probe-close"));
    expect(screen.getByTestId("probe-status").textContent).toBe("closed");
  });
});
