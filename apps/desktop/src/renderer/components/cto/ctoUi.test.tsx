/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { resolveCtoPrimaryLaneId } from "./ctoSessionViewState";
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
    supportsFastMode: modelId !== "anthropic/claude-opus-4-8",
  }),
  // The CTO pickers pass this straight to ModelPicker's `filter`, so the mock
  // has to supply it or every settings render throws.
  ctoModelSupportsLiveRedirect: () => true,
}));

vi.mock("../shared/ModelPicker/ModelPicker", () => ({
  ModelPicker: (props: {
    value: string;
    onChange: (id: string) => void;
    fastModeActive?: boolean;
    onFastModeToggle?: (next: boolean) => void;
  }) => (
    <>
      <button data-testid="model-picker" onClick={() => props.onChange("anthropic/claude-opus-4-8")}>
        {props.value}
      </button>
      {props.onFastModeToggle ? (
        <button
          data-testid="model-fast-toggle"
          aria-pressed={props.fastModeActive === true}
          onClick={() => props.onFastModeToggle?.(!(props.fastModeActive === true))}
        >
          Fast
        </button>
      ) : null}
    </>
  ),
}));

vi.mock("../shared/ModelPicker/ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: () => <div data-testid="reasoning-picker" />,
}));

const IDENTITY = {
  version: 2,
  name: "CTO",
  persona: "Senior CTO",
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
  fastMode: false,
  executionMode: null,
  identityKey: "cto",
  capabilityMode: "full_tooling",
  status: "idle",
  createdAt: "2026-05-01T00:00:00.000Z",
  lastActivityAt: "2026-05-01T00:00:00.000Z",
  threadId: "thread-1",
} as const;

describe("CtoPage settings", () => {
  const originalAde = globalThis.window.ade;
  const ensureSession = vi.fn().mockResolvedValue(SESSION);
  const updateSession = vi.fn().mockResolvedValue({ ...SESSION, modelId: "anthropic/claude-opus-4-8" });

  beforeEach(() => {
    ensureSession.mockReset().mockResolvedValue(SESSION);
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
        ensureSession,
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

  it("shows the picker card instead of the thread while no live-steer model is picked", async () => {
    const getState = vi.fn().mockResolvedValue({
      identity: { ...IDENTITY, modelPreferences: null },
      recentSessions: [],
    });
    globalThis.window.ade = {
      ...(globalThis.window.ade as object),
      cto: { ...((globalThis.window.ade as { cto: object }).cto), getState },
    } as never;

    render(<MemoryRouter><CtoPage /></MemoryRouter>);

    const card = await screen.findByTestId("cto-model-pick");
    // The welcome screen is the CTO speaking, not a settings form: it introduces
    // itself and the picker is the reply affordance.
    expect(card.textContent).toContain("I run point on this project");
    expect(card.textContent).toContain("steer live turns");
    expect(screen.queryByTestId("cto-agent-chat-pane")).toBeNull();
    // The existing thread is never recreated to force a pick — ensureSession
    // simply does not run until there is a model it could run on.
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("keeps model controls off the main chat header", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");

    expect(screen.queryByTestId("model-picker")).toBeNull();
  });

  it("gives settings the whole surface instead of a drawer over the thread", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");

    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    // A page, not an overlay: the thread is not underneath it competing for
    // the same 440px the old sheet had.
    await screen.findByTestId("cto-settings-page");
    expect(screen.getByRole("button", { name: /Back to the thread/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Back to the thread/ }));
    expect(screen.queryByTestId("cto-settings-page")).toBeNull();
  });

  it("keeps memory and the prompt closed until they are asked for", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Prompt/ }));

    // The old panel opened onto 4.5k tokens of prompt. This one opens onto a
    // line you can choose to expand.
    const toggle = screen.getByRole("button", { name: /Preview effective prompt/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("puts the voice key somewhere other than the Talk button", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Voice/ }));

    // Before this, the only way to reach the key was to press Talk without one.
    expect(screen.getByText(/billed by the second/i)).toBeTruthy();
  });

  it("routes a settings model switch through agentChat.updateSession on the locked session", async () => {
    ensureSession.mockResolvedValueOnce({ ...SESSION, fastMode: true });
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");

    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    // Settings is a page with sections now, and it opens on Identity — the
    // model controls live one click away rather than at the top of a column.
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    fireEvent.click(screen.getByTestId("model-picker"));

    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1));
    expect(updateSession).toHaveBeenCalledWith({
      sessionId: "cto-session",
      modelId: "anthropic/claude-opus-4-8",
      fastMode: true,
    });
  });

  it("keeps Fast mode in settings and updates the locked CTO session", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");

    expect(screen.queryByTestId("model-fast-toggle")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    // Settings is a page with sections now, and it opens on Identity — the
    // model controls live one click away rather than at the top of a column.
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    fireEvent.click(screen.getByTestId("model-fast-toggle"));

    await waitFor(() => expect(updateSession).toHaveBeenCalledWith({
      sessionId: "cto-session",
      fastMode: true,
    }));
  });

  it("turns Fast mode off from settings on the locked CTO session", async () => {
    ensureSession.mockResolvedValueOnce({ ...SESSION, fastMode: true });
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");

    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    // Settings is a page with sections now, and it opens on Identity — the
    // model controls live one click away rather than at the top of a column.
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    const fastToggle = screen.getByTestId("model-fast-toggle");
    expect(fastToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(fastToggle);

    await waitFor(() => expect(updateSession).toHaveBeenCalledWith({
      sessionId: "cto-session",
      fastMode: false,
    }));
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
