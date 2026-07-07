/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { resolveCtoPrimaryLaneId } from "./ctoSessionViewState";
import { CtoOnboardingCard } from "./CtoOnboardingCard";
import { CtoMemoryPanel } from "./CtoMemoryPanel";
import { CtoPage } from "./CtoPage";
import { useAppStore } from "../../state/appStore";

/* AgentChatPane is heavy; stub it so CtoPage renders synchronously. */
vi.mock("../chat/AgentChatPane", () => ({
  AgentChatPane: () => <div data-testid="cto-agent-chat-pane" />,
}));

/* The model badge/settings row route through these; stub so the picker is a
 * plain button and the id resolves without the real registry. */
vi.mock("./useCtoModelOptions", () => ({
  useCtoModelOptions: () => ({
    availableModelIds: ["anthropic/claude-sonnet-5"],
    loadingModels: false,
    openProviderSettings: vi.fn(),
  }),
  resolveModelSelection: (modelId: string) => ({
    provider: "anthropic",
    model: "sonnet",
    modelId,
    reasoningEffort: null,
  }),
}));

vi.mock("../shared/ModelPicker/ModelPicker", () => ({
  ModelPicker: (props: { value: string; onChange: (id: string) => void }) => (
    <button data-testid="model-picker" onClick={() => props.onChange("anthropic/claude-opus-4-8")}>
      {props.value}
    </button>
  ),
}));

vi.mock("../shared/ModelPicker/ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: () => <div data-testid="reasoning-picker" />,
}));

const IDENTITY = {
  version: 2,
  name: "CTO",
  persona: "Senior CTO",
  personality: "strategic",
  customPersonality: null,
  modelPreferences: {
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelId: "anthropic/claude-sonnet-5",
    reasoningEffort: null,
  },
} as const;

const SESSION = {
  id: "cto-session",
  laneId: "lane-primary",
  provider: "anthropic",
  model: "claude-sonnet-5",
  modelId: "anthropic/claude-sonnet-5",
  sessionProfile: "persistent_identity",
  reasoningEffort: null,
  executionMode: null,
  identityKey: "cto",
  capabilityMode: "full_tooling",
  status: "idle",
  createdAt: "2026-05-01T00:00:00.000Z",
  lastActivityAt: "2026-05-01T00:00:00.000Z",
  threadId: "thread-1",
} as const;

describe("CtoPage model badge", () => {
  const originalAde = globalThis.window.ade;
  const updateSession = vi.fn().mockResolvedValue({ ...SESSION, modelId: "anthropic/claude-opus-4-8" });

  beforeEach(() => {
    updateSession.mockClear();
    useAppStore.setState({
      lanes: [{ id: "lane-primary", name: "Primary", laneType: "primary" } as never],
      lanesLoading: false,
    });
    globalThis.window.ade = {
      ...(originalAde ?? {}),
      agentChat: { ...((originalAde as { agentChat?: object })?.agentChat ?? {}), updateSession },
      cto: {
        getState: vi.fn().mockResolvedValue({ identity: IDENTITY, recentSessions: [] }),
        getOnboardingState: vi.fn().mockResolvedValue({
          completedAt: "2026-05-01T00:00:00.000Z",
          completedSteps: ["identity"],
          dismissedAt: null,
        }),
        ensureSession: vi.fn().mockResolvedValue(SESSION),
        updateIdentity: vi.fn().mockResolvedValue({ identity: IDENTITY, recentSessions: [] }),
      },
    } as never;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAppStore.setState({ lanes: [], lanesLoading: false });
    globalThis.window.ade = originalAde;
  });

  it("renders the persistent thread once the session wakes", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    expect(await screen.findByTestId("cto-agent-chat-pane")).toBeTruthy();
  });

  it("routes a header model switch through agentChat.updateSession on the locked session", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");

    fireEvent.click(screen.getByTestId("model-picker"));

    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1));
    expect(updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "cto-session", modelId: "anthropic/claude-opus-4-8" }),
    );
  });
});

describe("CtoOnboardingCard", () => {
  const originalAde = globalThis.window.ade;
  const updateIdentity = vi.fn().mockResolvedValue({ identity: IDENTITY, recentSessions: [] });
  const completeOnboardingStep = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    updateIdentity.mockClear();
    completeOnboardingStep.mockClear();
    globalThis.window.ade = {
      ...(originalAde ?? {}),
      cto: {
        getState: vi.fn().mockResolvedValue({ identity: IDENTITY, recentSessions: [] }),
        updateIdentity,
        completeOnboardingStep,
      },
    } as never;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    globalThis.window.ade = originalAde;
  });

  it("saves identity + completes the step when the user starts", async () => {
    const onComplete = vi.fn();
    render(<CtoOnboardingCard onComplete={onComplete} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(completeOnboardingStep).toHaveBeenCalledWith({ stepId: "identity" }));
    expect(updateIdentity).toHaveBeenCalledTimes(1);
    const patch = updateIdentity.mock.calls[0][0].patch;
    expect(patch.personality).toBe("strategic");
    expect(patch.communicationStyle).toEqual({
      verbosity: "adaptive",
      proactivity: "balanced",
      escalationThreshold: "medium",
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});

describe("CtoMemoryPanel", () => {
  const originalAde = globalThis.window.ade;
  const updateMemory = vi.fn();

  beforeEach(() => {
    updateMemory.mockReset();
    globalThis.window.ade = {
      ...(originalAde ?? {}),
      cto: {
        getMemory: vi.fn().mockResolvedValue({
          memory: "# Facts\n- ships on Fridays",
          threadState: "",
          dailyLog: "",
          dailyLogDate: "2026-07-04",
          updatedAt: null,
        }),
        updateMemory: updateMemory.mockResolvedValue({
          memory: "# Facts\n- ships on Fridays\n- prefers pnpm",
          threadState: "",
          dailyLog: "",
          dailyLogDate: "2026-07-04",
          updatedAt: "2026-07-04T00:00:00.000Z",
        }),
      },
    } as never;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    globalThis.window.ade = originalAde;
  });

  it("loads MEMORY.md and saves edits through cto.updateMemory", async () => {
    render(<CtoMemoryPanel />);

    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe("# Facts\n- ships on Fridays"));
    fireEvent.change(textarea, { target: { value: "# Facts\n- ships on Fridays\n- prefers pnpm" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateMemory).toHaveBeenCalledTimes(1));
    expect(updateMemory).toHaveBeenCalledWith({ memory: "# Facts\n- ships on Fridays\n- prefers pnpm" });
  });
});

describe("resolveCtoPrimaryLaneId", () => {
  it("prefers the primary lane even when another lane is selected elsewhere", () => {
    expect(resolveCtoPrimaryLaneId([
      { id: "lane-feature", laneType: "worktree" },
      { id: "lane-primary", laneType: "primary" },
    ])).toBe("lane-primary");
  });

  it("falls back to the first lane when no primary lane exists yet", () => {
    expect(resolveCtoPrimaryLaneId([
      { id: "lane-feature", laneType: "worktree" },
      { id: "lane-bugfix", laneType: "worktree" },
    ])).toBe("lane-feature");
  });

  it("returns null when no lanes are available", () => {
    expect(resolveCtoPrimaryLaneId([])).toBeNull();
  });
});
