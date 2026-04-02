/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PendingInputRequest } from "../../../shared/types";
import { AgentQuestionModal } from "./AgentQuestionModal";

afterEach(cleanup);

function renderModal(request: PendingInputRequest) {
  const onClose = vi.fn();
  const onDecline = vi.fn();
  const onSubmit = vi.fn();

  render(
    <AgentQuestionModal
      request={request}
      onClose={onClose}
      onSubmit={onSubmit}
      onDecline={onDecline}
    />,
  );

  return { onClose, onDecline, onSubmit };
}

describe("AgentQuestionModal", () => {
  it("supports multi-select answers and preview rendering", () => {
    const request: PendingInputRequest = {
      requestId: "req-1",
      itemId: "item-1",
      source: "claude",
      kind: "structured_question",
      title: "Task list decision",
      description: "Claude needs help choosing a layout.",
      questions: [
        {
          id: "layout",
          header: "Layout",
          question: "Which layouts should we keep exploring?",
          multiSelect: true,
          allowsFreeform: true,
          options: [
            {
              label: "Cards",
              value: "Cards",
              preview: "<div><strong>Cards preview panel</strong></div>",
              previewFormat: "html",
            },
            {
              label: "Table",
              value: "Table",
              preview: "<div><strong>Table preview panel</strong></div>",
              previewFormat: "html",
              recommended: true,
            },
          ],
        },
      ],
      allowsFreeform: true,
      blocking: true,
      canProceedWithoutAnswer: false,
    };

    const { onSubmit } = renderModal(request);

    expect(screen.getByText("Task list decision")).toBeTruthy();
    expect(screen.getByText("Table preview panel")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Cards/i }));
    expect(screen.getByText("Cards preview panel")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Table/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Kanban, Timeline" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Send answer/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      answers: {
        layout: ["Cards", "Table", "Kanban", "Timeline"],
      },
      responseText: null,
    });
  });

  it("does not allow passive dismissal for blocking requests", () => {
    const request: PendingInputRequest = {
      requestId: "req-blocking",
      itemId: "item-blocking",
      source: "claude",
      kind: "structured_question",
      title: "Blocking clarification",
      description: "Claude needs a decision before it can continue.",
      questions: [
        {
          id: "direction",
          header: "Direction",
          question: "Which direction should we take?",
          allowsFreeform: true,
          options: [
            { label: "Option A", value: "Option A" },
            { label: "Option B", value: "Option B" },
          ],
        },
      ],
      allowsFreeform: true,
      blocking: true,
      canProceedWithoutAnswer: false,
    };

    const { onClose } = renderModal(request);

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("agent-question-modal-overlay"));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Close question modal")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("lets freeform text override a single selected option", () => {
    const request: PendingInputRequest = {
      requestId: "req-2",
      itemId: "item-2",
      source: "claude",
      kind: "structured_question",
      description: "Claude needs a final preference.",
      questions: [
        {
          id: "summary",
          header: "Summary",
          question: "What should the summary card do?",
          allowsFreeform: true,
          options: [
            { label: "Collapse automatically", value: "Collapse automatically" },
            { label: "Stay expanded", value: "Stay expanded" },
          ],
        },
      ],
      allowsFreeform: true,
      blocking: true,
      canProceedWithoutAnswer: false,
    };

    const { onSubmit } = renderModal(request);

    fireEvent.click(screen.getByRole("button", { name: /Collapse automatically/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Collapse unless the agent is actively streaming." },
    });

    fireEvent.click(screen.getByRole("button", { name: /Send answer/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      answers: {
        summary: "Collapse unless the agent is actively streaming.",
      },
      responseText: "Collapse unless the agent is actively streaming.",
    });
  });

  it("submits on Cmd/Ctrl+Enter when answers are ready", () => {
    const request: PendingInputRequest = {
      requestId: "req-shortcut",
      itemId: "item-shortcut",
      source: "claude",
      kind: "question",
      description: "Claude needs a concise answer.",
      questions: [
        {
          id: "reply",
          header: "Reply",
          question: "What should Claude do next?",
          allowsFreeform: true,
        },
      ],
      allowsFreeform: true,
      blocking: true,
      canProceedWithoutAnswer: false,
    };

    const { onSubmit } = renderModal(request);

    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "Use the shared modal everywhere chat questions appear." },
    });

    const expectedPayload = {
      answers: {
        reply: "Use the shared modal everywhere chat questions appear.",
      },
      responseText: "Use the shared modal everywhere chat questions appear.",
    };

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith(expectedPayload);

    onSubmit.mockClear();

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledWith(expectedPayload);
  });
});
