import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ApprovalPrompt } from "../components/ApprovalPrompt";
import { createPendingQuestionSelectionState } from "../pendingInput";
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
    expect(frame).toContain("enter");
    expect(frame).toContain("next/send");
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
});
