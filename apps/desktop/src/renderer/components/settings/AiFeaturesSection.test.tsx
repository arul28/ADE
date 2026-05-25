/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AiFeaturesSection } from "./AiFeaturesSection";

const modelPickerProps = vi.hoisted(() =>
  [] as Array<{ surfaceKey: string; onOpenSignIn?: () => void }>,
);

vi.mock("../shared/ModelPicker/ModelPicker", () => {
  return {
    ModelPicker: (props: { surfaceKey: string; onOpenSignIn?: () => void }) => {
      modelPickerProps.push(props);
      return (
        <button type="button" onClick={props.onOpenSignIn}>
          {`Set up ${props.surfaceKey}`}
        </button>
      );
    },
  };
});

vi.mock("../shared/ModelPicker/ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: () => null,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

function installAdeMocks() {
  (window as any).ade = {
    ai: {
      getStatus: vi.fn().mockResolvedValue({
        mode: "subscription",
        availableProviders: {
          claude: {
            binary: { present: false, source: "missing", path: null },
            auth: { ready: false, mode: "none", detail: null },
          },
          codex: true,
          cursor: false,
          droid: false,
        },
        models: { claude: [], codex: [], cursor: [], droid: [] },
        features: [
          { feature: "terminal_summaries", enabled: true, dailyUsage: 0 },
          { feature: "pr_descriptions", enabled: true, dailyUsage: 0 },
          { feature: "commit_messages", enabled: true, dailyUsage: 0 },
        ],
        detectedAuth: [{ type: "cli-subscription", cli: "codex", authenticated: true }],
        availableModelIds: ["openai/gpt-5.4"],
      }),
      updateConfig: vi.fn().mockResolvedValue(undefined),
    },
    projectConfig: {
      get: vi.fn().mockResolvedValue({
        effective: {
          ai: {
            featureModelOverrides: {
              terminal_summaries: "openai/gpt-5.4",
              pr_descriptions: "openai/gpt-5.4",
              commit_messages: "openai/gpt-5.4",
            },
            sessionIntelligence: {
              titles: {
                enabled: true,
                modelId: "openai/gpt-5.4",
                refreshOnComplete: true,
              },
            },
          },
        },
      }),
    },
  };
}

afterEach(() => {
  cleanup();
  modelPickerProps.length = 0;
  delete (window as any).ade;
});

describe("AiFeaturesSection", () => {
  it("passes provider setup actions to every AI feature model picker", async () => {
    installAdeMocks();

    render(
      <MemoryRouter initialEntries={["/settings?tab=ai"]}>
        <AiFeaturesSection />
      </MemoryRouter>,
    );
    const expectedSurfaceKeys = [
      "ai-feature-terminal_summaries",
      "ai-feature-pr_descriptions",
      "ai-feature-commit_messages",
      "ai-feature-chat-auto-title",
    ];
    await waitFor(() => {
      for (const surfaceKey of expectedSurfaceKeys) {
        expect(
          modelPickerProps.find((props) => props.surfaceKey === surfaceKey)
            ?.onOpenSignIn,
          `${surfaceKey} should route setup to AI providers`,
        ).toEqual(expect.any(Function));
      }
    });
  });

  it("routes the chat auto-title provider setup action to the AI providers settings section", async () => {
    installAdeMocks();

    render(
      <MemoryRouter initialEntries={["/settings?tab=ai"]}>
        <AiFeaturesSection />
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: "Set up ai-feature-chat-auto-title" });
    fireEvent.click(screen.getByRole("button", { name: "Set up ai-feature-chat-auto-title" }));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/settings?tab=ai#ai-providers");
    });
  });
});
