import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ApprovalPrompt } from "../components/ApprovalPrompt";
import { createPendingQuestionSelectionState, movePendingQuestionOption } from "../pendingInput";
import type { PendingApproval } from "../types";

function stripAnsi(text: string): string {
  return text.replace(/\u001b(?:\[[0-9;]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "");
}

describe("ApprovalPrompt", () => {
  it("renders every structured question with visible option labels", () => {
    const approval: PendingApproval = {
      itemId: "item-1",
      description: "Claude needs a few answers.",
      highStakes: false,
      mode: "question",
      request: {
        requestId: "req-1",
        source: "claude",
        kind: "structured_question",
        title: "Questions from Claude",
        description: "Claude needs a few answers before it can continue.",
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        questions: [
          {
            id: "timing",
            header: "Timing",
            question: "On mobile, should the lane wait for the AI-generated name?",
            options: [
              { label: "Wait for the name", value: "wait" },
              { label: "Open instantly", value: "instant" },
            ],
          },
          {
            id: "banner",
            header: "Banner text",
            question: "Which status banner should be shown?",
            options: [
              { label: "Compact", value: "compact" },
              { label: "Detailed", value: "detailed" },
            ],
          },
        ],
      },
    };

    const frame = stripAnsi(render(
      <ApprovalPrompt
        approval={approval}
        questionState={createPendingQuestionSelectionState(approval)}
        width={100}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("0 of 2 answered");
    expect(frame).toContain("Timing");
    expect(frame).toContain("Wait for the name");
    expect(frame).toContain("Open instantly");
    expect(frame).toContain("Banner text");
    expect(frame).toContain("Compact");
    expect(frame).toContain("Detailed");
    expect(frame).toContain("1-9");
    expect(frame).toContain("pick");
    expect(frame).toContain("enter");
    expect(frame).toContain("next/send");
    // The card carries the same two shared strings the desktop card does: what
    // the note is for right now, and what Enter will actually send. Nothing is
    // picked yet — the seeded highlight is a cursor, not a selection — so the
    // note row reads as the answer.
    expect(frame).toContain("Or send your own response instead");
  });

  // Parity with the desktop regression: the Send label is derived from the
  // answer state, so a note typed alongside a pick reads as BOTH travelling.
  it("regression: the send label reports the pick and the note together", () => {
    const approval: PendingApproval = {
      itemId: "item-send-label",
      description: "Claude needs an answer.",
      highStakes: false,
      mode: "question",
      request: {
        requestId: "req-send-label",
        source: "claude",
        kind: "structured_question",
        title: "One question",
        description: "How separate should it be?",
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        questions: [
          {
            id: "isolation",
            header: "Isolation",
            question: "How separate should it be?",
            options: [
              { label: "Hide it", value: "hide" },
              { label: "Own lane", value: "lane" },
            ],
          },
        ],
      },
    };
    const state = createPendingQuestionSelectionState(approval);

    // Untouched: the highlight is a cursor, so there is nothing to send yet.
    const untouched = stripAnsi(render(
      <ApprovalPrompt approval={approval} questionState={state} width={100} />,
    ).lastFrame() ?? "");
    expect(untouched).toContain("Or send your own response instead");

    // Moving the highlight makes it a real pick.
    const moved = movePendingQuestionOption(approval.request, state!, 1);
    const picked = stripAnsi(render(
      <ApprovalPrompt approval={approval} questionState={moved} width={100} />,
    ).lastFrame() ?? "");
    expect(picked).toContain("Send 1");
    expect(picked).toContain("Add a note (sent with your pick)");

    const withNote = stripAnsi(render(
      <ApprovalPrompt
        approval={approval}
        questionState={moved}
        width={100}
        draft="only if the pin survives a restart"
      />,
    ).lastFrame() ?? "");
    expect(withNote).toContain("Send 1 + note");
  });

  it("labels the note row as the answer when the question offers no options", () => {
    const approval: PendingApproval = {
      itemId: "item-freeform",
      description: "Claude needs an answer.",
      highStakes: false,
      mode: "question",
      request: {
        requestId: "req-freeform",
        source: "claude",
        kind: "question",
        title: "Name it",
        description: "What should I name it?",
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        questions: [{ id: "name", header: "Name", question: "What should I name it?" }],
      },
    };

    const frame = stripAnsi(render(
      <ApprovalPrompt
        approval={approval}
        questionState={createPendingQuestionSelectionState(approval)}
        width={100}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("Your answer");
    expect(frame).toContain("Send");
  });

  it("regression: an untouched option is only highlighted and forbidden freeform is not advertised", () => {
    const approval: PendingApproval = {
      itemId: "item-no-freeform",
      description: "Pick one.",
      highStakes: false,
      mode: "question",
      request: {
        requestId: "req-no-freeform",
        source: "claude",
        kind: "structured_question",
        questions: [{
          id: "choice",
          question: "Which path?",
          options: [
            { label: "Recommended", value: "recommended", recommended: true },
            { label: "Manual", value: "manual" },
          ],
          allowsFreeform: false,
        }],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
      },
    };

    const frame = stripAnsi(render(
      <ApprovalPrompt
        approval={approval}
        questionState={createPendingQuestionSelectionState(approval)}
        draft="this must not count"
        width={100}
      />,
    ).lastFrame() ?? "");

    expect(frame).not.toContain("type custom");
    expect(frame).not.toContain("✎");
    expect(frame).toContain("○ Recommended");
    expect(frame).not.toContain("● Recommended");
  });

  it("regression: an unanswerable no-freeform question tells the user to decline", () => {
    const approval: PendingApproval = {
      itemId: "item-unanswerable",
      description: "Provider sent no valid choices.",
      highStakes: false,
      mode: "question",
      request: {
        requestId: "req-unanswerable",
        source: "claude",
        kind: "question",
        questions: [{
          id: "choice",
          question: "Which path?",
          options: [],
          allowsFreeform: false,
        }],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
      },
    };

    const frame = stripAnsi(render(
      <ApprovalPrompt
        approval={approval}
        questionState={createPendingQuestionSelectionState(approval)}
        width={100}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("No answer options are available. Decline this request.");
    expect(frame).not.toContain("Type an answer in the prompt.");
    expect(frame).not.toContain("1-9");
    expect(frame).not.toContain("next/send");
    expect(frame).not.toContain("↵ Send");
    expect(frame).toContain("decline");
  });

  it("regression: renders the default assumption that Enter can submit", () => {
    const approval: PendingApproval = {
      itemId: "item-default",
      description: "Use the provider fallback if appropriate.",
      highStakes: false,
      mode: "question",
      request: {
        requestId: "req-default",
        source: "cursor",
        kind: "question",
        questions: [{
          id: "choice",
          question: "Which path?",
          options: [],
          allowsFreeform: false,
          defaultAssumption: "Keep the current path.",
        }],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: true,
      },
    };

    const frame = stripAnsi(render(
      <ApprovalPrompt
        approval={approval}
        questionState={createPendingQuestionSelectionState(approval)}
        width={100}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("Default: Keep the current path.");
    expect(frame).toContain("Press Enter to use the default assumption.");
    expect(frame).not.toContain("Decline this request.");
    expect(frame).toContain("next/send");
    expect(frame).toContain("↵ Send");
    expect(frame).not.toContain("1-9");
  });

  it("renders every legacy request-level option", () => {
    const approval: PendingApproval = {
      itemId: "legacy-question",
      description: "Choose one option.",
      highStakes: false,
      mode: "question",
      request: {
        requestId: "legacy-question",
        source: "codex",
        kind: "question",
        title: "Choose one option",
        description: "Choose one option.",
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        questions: [],
        options: Array.from({ length: 8 }, (_, index) => ({
          label: `Option ${index + 1}`,
          value: `option-${index + 1}`,
        })),
      },
    };

    const frame = stripAnsi(render(
      <ApprovalPrompt approval={approval} width={100} />,
    ).lastFrame() ?? "");

    expect(frame).toContain("1 Option 1");
    expect(frame).toContain("6 Option 6");
    expect(frame).toContain("7 Option 7");
    expect(frame).toContain("8 Option 8");
  });

  it("renders orchestration model-selection briefing metadata", () => {
    const approval: PendingApproval = {
      itemId: "model-1",
      description: "Build the orchestration roster.",
      highStakes: false,
      mode: "question",
      request: {
        requestId: "model-1",
        source: "ade",
        kind: "model_selection",
        title: "Pick a model for the web-ui worker",
        description: "Build the orchestration roster.",
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        providerMetadata: {
          role: "worker",
          tag: "web-ui",
          workDescription: "Build the orchestration roster.",
          filesHint: [" OrchestrationPanel.tsx ", "TaskCard.tsx"],
          dependsOn: [" planning-rounds ", "model-routing"],
        },
        questions: [
          {
            id: "model",
            header: "Model",
            question: "Which model should the web-ui worker use?",
          },
        ],
      },
    };

    const frame = stripAnsi(render(
      <ApprovalPrompt
        approval={approval}
        questionState={createPendingQuestionSelectionState(approval)}
        width={100}
      />,
    ).lastFrame() ?? "");

    expect(frame).toContain("MODEL SELECTION");
    expect(frame).toContain("Description: Build the orchestration roster.");
    expect(frame).toContain("Files: OrchestrationPanel.tsx, TaskCard.tsx");
    expect(frame).toContain("Runs after: planning-rounds, model-routing");
    expect(frame).toContain("Which model should the web-ui worker use?");
  });

  it("renders plan approval metadata as a multiline plan preview", () => {
    const approval: PendingApproval = {
      itemId: "plan-1",
      description: "# Plan\n\n## Goal\nShip the work.\n\n## Validation plan\nRun the focused checks.",
      highStakes: false,
      mode: "approval",
      request: {
        requestId: "plan-1",
        source: "ade",
        kind: "plan_approval",
        title: "Plan ready",
        description: "# Plan\n\n## Goal\nShip the work.\n\n## Validation plan\nRun the focused checks.",
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        providerMetadata: {
          orchestrationPlanApproval: true,
          planContent: "# Plan\n\n## Goal\nShip the work.\n\n## Validation plan\nRun the focused checks.",
        },
        questions: [],
      },
    };

    const frame = stripAnsi(render(
      <ApprovalPrompt approval={approval} width={100} />,
    ).lastFrame() ?? "");

    expect(frame).toContain("Plan ready");
    expect(frame).toContain("## Goal");
    expect(frame).toContain("Ship the work.");
    expect(frame).toContain("## Validation plan");
  });
});
