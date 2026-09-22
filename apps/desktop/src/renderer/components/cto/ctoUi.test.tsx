/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { resolveCtoPrimaryLaneId } from "./ctoSessionViewState";
import {
  CtoHistoryList,
  dayLabel,
  sessionDuration,
  sessionRetirementNote,
  sessionTitle,
} from "./CtoHistoryList";
import { CTO_PAST_THREADS_DESCRIPTION, CtoSettingsPage, VOICE_GRID_COLUMNS } from "./CtoSettingsPage";
import { CtoMemoryPanel } from "./CtoMemoryPanel";
import { CtoPage } from "./CtoPage";
import { useAppStore } from "../../state/appStore";
import { CTO_VOICE_INITIAL_STATE, CTO_VOICE_VOICES, type CtoVoiceState } from "../../../shared/types/ctoVoice";
import { CtoVoiceHud } from "./CtoVoiceHud";

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
  // The second argument is the reasoning tier the choice must not rewrite; the
  // real resolver passes it straight through, and so does this.
  resolveModelSelection: (modelId: string, preferredReasoning?: string | null) => ({
    provider: "anthropic",
    model: "sonnet",
    modelId,
    reasoningEffort: preferredReasoning ?? null,
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
  const startFreshSession = vi.fn();
  const getThreadHealth = vi.fn();

  /** A healthy thread: plenty of room, nothing to offer. */
  const HEALTHY = {
    sessionId: "cto-session",
    canTakeTurn: true,
    blockedReason: null,
    lastTurnFailure: null,
    context: { occupancyPct: 12, aboveHighWaterTurns: 0, compactionSeen: false, updatedAt: "2026-05-01T00:00:00.000Z" },
    rotationAdvised: false,
  } as const;

  beforeEach(() => {
    ensureSession.mockReset().mockResolvedValue(SESSION);
    updateSession.mockClear();
    getThreadHealth.mockReset().mockResolvedValue(HEALTHY);
    startFreshSession.mockReset().mockResolvedValue({
      sessionId: "cto-session-2",
      previousSessionId: "cto-session",
      handoff: { written: true, thin: false, source: "model" },
    });
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
        startFreshSession,
        getThreadHealth,
        updateIdentity: vi.fn().mockResolvedValue({ identity: IDENTITY, recentSessions: [] }),
        previewSystemPrompt: vi.fn().mockResolvedValue({
          prompt: "doctrine text\n\nstate text",
          tokenEstimate: 1234,
          sections: [
            { id: "doctrine", title: "IMMUTABLE ADE DOCTRINE", content: "doctrine text" },
            { id: "continuity", title: "PROJECT CONTINUITY", content: "state text" },
          ],
        }),
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

  it("opens settings on the model section", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));

    // The first thing anyone opens these settings for is the model, so that is
    // the section that is already open.
    expect(screen.getByRole("button", { name: /^Model/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("model-picker")).toBeTruthy();
  });

  it("offers every voice in one grid rather than a wrapping row", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Voice/ }));

    // A wrapping pill row left the last voice alone on a line of its own. The
    // grid's column count has to divide the voice count for that to be
    // impossible, which is the part worth asserting.
    const voices = within(screen.getByRole("radiogroup", { name: "Voice" })).getAllByRole("radio");
    expect(voices).toHaveLength(CTO_VOICE_VOICES.length);
    expect(CTO_VOICE_VOICES.length % VOICE_GRID_COLUMNS).toBe(0);
  });

  it("says what the chosen model is, not just its name", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));

    // The Model pane must state the chosen model's facts, not only its name.
    const card = await screen.findByTestId("cto-model-facts");
    expect(card.textContent).toContain("Provider");
    expect(card.textContent).toContain("Anthropic");
    expect(card.textContent).toContain("Context");
    expect(card.textContent).toContain("Reasoning");
    expect(card.textContent).toContain("Fast mode");
    expect(card.textContent).toContain("Runs on");
  });

  it("keeps saying why a call failed after the HUD has gone", async () => {
    // The bridge the renderer half reads. Only `onState` matters here: the
    // service pushes the whole call state, and the page has to keep the
    // reason once the call is over and the HUD has unmounted.
    let push: ((state: Record<string, unknown>) => void) | null = null;
    const ade = globalThis.window.ade as Record<string, unknown>;
    // The settings button is macOS and Windows only — there is no vetted pane
    // URL on Linux — so the platform has to be a real one for it to appear.
    ade.app = { ...(ade.app as Record<string, unknown> | undefined), runtimeTarget: { platform: "darwin", arch: "arm64" } };
    ade.ctoVoice = {
      start: vi.fn().mockResolvedValue({ ok: true }),
      end: vi.fn().mockResolvedValue(undefined),
      pushAudio: vi.fn(),
      setMuted: vi.fn().mockResolvedValue(undefined),
      approve: vi.fn().mockResolvedValue(undefined),
      deny: vi.fn().mockResolvedValue(undefined),
      attachImage: vi.fn().mockResolvedValue(undefined),
      hasKey: vi.fn().mockResolvedValue(true),
      onState: (handler: (state: Record<string, unknown>) => void) => {
        push = handler;
        return () => { push = null; };
      },
      onAudio: () => () => {},
    };

    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");

    const emit = (patch: Record<string, unknown>) => {
      act(() => {
        push?.({
          callId: "call-1",
          elapsedMs: 0,
          muted: false,
          inputLevel: 0,
          interrupted: false,
          captions: [],
          pendingConfirmation: null,
          sceneSource: null,
          isCallOwner: true,
          error: null,
          ...patch,
        });
      });
    };

    emit({ phase: "connecting" });
    // The HUD says "Call failed" inside its pill and nothing more, so the page
    // is the one surface that gives the reason — from the moment it is known.
    emit({ phase: "failed", error: "The voice connection failed." });
    expect(screen.getByTestId("cto-talk-error").textContent)
      .toBe("The voice connection failed.");

    // The sentence must outlive the call: it stays on the page after the
    // service has dropped the error and the HUD has unmounted.
    emit({ phase: "ended", error: null });
    expect(screen.getByTestId("cto-talk-error").textContent)
      .toBe("The voice connection failed.");

    // A new call is not the old call's failure.
    emit({ phase: "connecting" });
    expect(screen.queryByTestId("cto-talk-error")).toBeNull();

    // A microphone verdict arrives with its KIND on the state, and the kind is
    // what puts a button beside the sentence. It used to be recovered by
    // matching the sentence against the renderer's own store word for word,
    // which meant a reworded sentence silently lost the button.
    emit({
      phase: "failed",
      error: "No microphone is connected to this Mac. Plug one in, or choose an input under macOS System Settings › Sound › Input.",
      errorKind: "no-device",
    });
    expect(screen.getByTestId("cto-talk-error").textContent)
      .toContain("No microphone is connected");
    expect(screen.getByTestId("cto-talk-open-mic-settings")).toBeTruthy();

    // And a failure with no kind gets the sentence and nothing to press.
    emit({ phase: "connecting" });
    emit({ phase: "failed", error: "The voice connection failed." });
    expect(screen.queryByTestId("cto-talk-open-mic-settings")).toBeNull();

    emit({ phase: "idle" });
  });

  it("shows the prompt itself, under headings in plain words", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Prompt/ }));

    // The prompt must be readable where it is, not behind a disclosure inside
    // a card, and its sections must be named in words rather than shouted in
    // the backend's own enum casing.
    const preview = await screen.findByTestId("cto-prompt-preview");
    expect(screen.queryByRole("button", { name: /Show the full prompt/ })).toBeNull();
    expect(preview.textContent).toContain("Doctrine");
    expect(preview.textContent).toContain("Project state");
    expect(preview.textContent).not.toContain("IMMUTABLE ADE DOCTRINE");
    expect(preview.textContent).toContain("doctrine text");
  });

  it("puts the voice key somewhere other than the Talk button", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Voice/ }));

    // Before this, the only way to reach the key was to press Talk without one.
    expect(screen.getByText(/\$0.05 a minute/i)).toBeTruthy();
  });

  it("routes a settings model switch through agentChat.updateSession on the locked session", async () => {
    ensureSession.mockResolvedValueOnce({ ...SESSION, fastMode: true });
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");

    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    fireEvent.click(screen.getByTestId("model-picker"));

    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1));
    expect(updateSession).toHaveBeenCalledWith({
      sessionId: "cto-session",
      modelId: "anthropic/claude-opus-4-8",
      // Fast mode does not travel to a model that has no fast tier: the picked
      // model is the one the stub marks as lacking one, so the switch turns it
      // off rather than asking the chat service for a mode that does not exist.
      fastMode: false,
    });
  });

  it("keeps Fast mode in settings and updates the locked CTO session", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");

    expect(screen.queryByTestId("model-fast-toggle")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    fireEvent.click(screen.getByTestId("model-fast-toggle"));

    await waitFor(() => expect(updateSession).toHaveBeenCalledWith({
      sessionId: "cto-session",
      fastMode: true,
    }));
  });

  /**
   * The defect that made the CTO feel vague.
   *
   * The owner picked Claude Opus 5 with a live session open. The page showed it
   * — `currentModelId` prefers the session's model — but the durable identity
   * preference was only written when NO session existed, so it silently stayed
   * on `codex/gpt-5.6-luna` at low effort. The next fresh thread was created
   * from that preference, on a smaller model at a lower reasoning tier than the
   * one on screen.
   */
  describe("the model the CTO keeps", () => {
    /** The identity preference, as the CTO state service would hold it. */
    function ctoWithStalePreference() {
      let prefs: Record<string, unknown> = {
        provider: "codex",
        model: "gpt-5.6-luna",
        modelId: "codex/gpt-5.6-luna",
        reasoningEffort: "low",
      };
      const snapshot = () => ({
        identity: { ...IDENTITY, modelPreferences: prefs },
        recentSessions: [],
      });
      const updateIdentity = vi.fn(async ({ patch }: { patch: Record<string, any> }) => {
        if (patch.modelPreferences) prefs = { ...prefs, ...patch.modelPreferences };
        return snapshot();
      });
      // The stand-in for `ensureIdentitySession`, which builds a CTO session out
      // of `modelPreferences.modelId` and `modelPreferences.reasoningEffort`.
      const sessions: Array<Record<string, unknown>> = [];
      ensureSession.mockImplementation(async () => {
        const next = sessions.length === 0
          ? { ...SESSION, provider: "codex", model: "gpt-5.6-luna", modelId: "codex/gpt-5.6-luna", reasoningEffort: "high" }
          : {
            ...SESSION,
            id: "cto-session-2",
            provider: prefs.provider,
            model: prefs.model,
            modelId: prefs.modelId,
            reasoningEffort: prefs.reasoningEffort ?? null,
          };
        sessions.push(next);
        return next;
      });
      (globalThis.window.ade as any).cto.updateIdentity = updateIdentity;
      (globalThis.window.ade as any).cto.getState = vi.fn(async () => snapshot());
      return { updateIdentity, sessions, readPrefs: () => prefs };
    }

    it("writes the pick into the identity even with a live session open", async () => {
      const cto = ctoWithStalePreference();
      render(<MemoryRouter><CtoPage /></MemoryRouter>);
      await screen.findByTestId("cto-agent-chat-pane");

      fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
      fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
      // The live session has to have landed before the pick, or the effort the
      // pick carries is read off the module's warm cache instead of this thread.
      await waitFor(() => expect(screen.getByTestId("model-picker").textContent)
        .toBe("codex/gpt-5.6-luna"));
      fireEvent.click(screen.getByTestId("model-picker"));

      // Both, not one: the running thread moves AND the durable record changes.
      await waitFor(() => expect(cto.updateIdentity).toHaveBeenCalledTimes(1));
      expect(cto.updateIdentity).toHaveBeenCalledWith({
        patch: {
          modelPreferences: {
            provider: "anthropic",
            model: "sonnet",
            modelId: "anthropic/claude-opus-4-8",
            reasoningEffort: "high",
          },
        },
      });
      await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1));
      expect(cto.readPrefs()).toMatchObject({
        modelId: "anthropic/claude-opus-4-8",
        reasoningEffort: "high",
      });
    });

    it("starts a fresh session on the picked model and effort, not a stale one", async () => {
      const cto = ctoWithStalePreference();
      render(<MemoryRouter><CtoPage /></MemoryRouter>);
      await screen.findByTestId("cto-agent-chat-pane");

      fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
      fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
      // The live session has to have landed before the pick, or the effort the
      // pick carries is read off the module's warm cache instead of this thread.
      await waitFor(() => expect(screen.getByTestId("model-picker").textContent)
        .toBe("codex/gpt-5.6-luna"));
      fireEvent.click(screen.getByTestId("model-picker"));
      await waitFor(() => expect(cto.updateIdentity).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByTestId("cto-fresh-session-start"));
      fireEvent.click(screen.getByTestId("cto-fresh-session-confirm"));
      await waitFor(() => expect(startFreshSession).toHaveBeenCalledTimes(1));

      // The thread the owner lands on is the model they picked, at the tier they
      // picked — before this, it was gpt-5.6-luna at low effort.
      await waitFor(() => expect(cto.sessions.length).toBeGreaterThan(1));
      expect(cto.sessions.at(-1)).toMatchObject({
        provider: "anthropic",
        modelId: "anthropic/claude-opus-4-8",
        reasoningEffort: "high",
      });
      await waitFor(() => expect(screen.getByTestId("model-picker").textContent)
        .toBe("anthropic/claude-opus-4-8"));
    });
  });

  it("confirms before starting a fresh session, and starts exactly one", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));

    // The first press is a question, not the action: nothing has been retired.
    fireEvent.click(screen.getByTestId("cto-fresh-session-start"));
    expect(startFreshSession).not.toHaveBeenCalled();
    // And the question says what survives rather than asking "are you sure".
    expect(screen.getByTestId("cto-fresh-session-confirm-text").textContent).toBe(
      "Everything the CTO remembers is kept, and this conversation moves to Past threads."
      + " Only the live thread starts over.",
    );

    fireEvent.click(screen.getByTestId("cto-fresh-session-confirm"));

    await waitFor(() => expect(startFreshSession).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId("cto-fresh-session-result")).textContent)
      .toBe("Fresh session started. The CTO wrote a hand-off note.");
  });

  it("shows the renamed section, and its description, in the settings rail", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Past threads/ }));

    expect(screen.getByText(CTO_PAST_THREADS_DESCRIPTION)).toBeTruthy();
    // The old word is what made it read as a pile of separate assistants.
    expect(screen.queryByRole("button", { name: /^History/ })).toBeNull();
  });

  it("backs out of the confirm without retiring anything", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));

    fireEvent.click(screen.getByTestId("cto-fresh-session-start"));
    fireEvent.click(screen.getByTestId("cto-fresh-session-cancel"));

    expect(startFreshSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("cto-fresh-session-start")).toBeTruthy();
  });

  it("says the hand-off was thin when it was, rather than claiming a note", async () => {
    startFreshSession.mockResolvedValueOnce({
      sessionId: "cto-session-2",
      previousSessionId: "cto-session",
      handoff: { written: true, thin: true, source: "deterministic" },
    });
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    fireEvent.click(screen.getByTestId("cto-fresh-session-start"));
    fireEvent.click(screen.getByTestId("cto-fresh-session-confirm"));

    expect((await screen.findByTestId("cto-fresh-session-result")).textContent)
      .toContain("kept in Past threads in full");
  });

  it("keeps the rotation prompt away while the thread has room", async () => {
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");
    await waitFor(() => expect(getThreadHealth).toHaveBeenCalled());

    expect(screen.queryByTestId("cto-rotation-prompt")).toBeNull();
  });

  it("offers a fresh session once ADE advises rotating, and never rotates itself", async () => {
    getThreadHealth.mockResolvedValue({ ...HEALTHY, rotationAdvised: true });
    render(<MemoryRouter><CtoPage /></MemoryRouter>);

    const prompt = await screen.findByTestId("cto-rotation-prompt");
    expect(prompt.textContent).toContain("This conversation is getting full");
    expect(prompt.textContent).toContain("keeps everything the CTO remembers");
    // Advice with a button. Nothing was retired by drawing it.
    expect(startFreshSession).not.toHaveBeenCalled();
    // And it is not a wall: the thread is still there behind it.
    expect(screen.getByTestId("cto-agent-chat-pane")).toBeTruthy();

    fireEvent.click(screen.getByTestId("cto-rotation-start"));
    await waitFor(() => expect(startFreshSession).toHaveBeenCalledTimes(1));
  });

  it("says the harder thing when the thread already cannot answer", async () => {
    getThreadHealth.mockResolvedValue({
      ...HEALTHY,
      canTakeTurn: false,
      blockedReason: "context_overflow",
      rotationAdvised: true,
    });
    render(<MemoryRouter><CtoPage /></MemoryRouter>);

    const prompt = await screen.findByTestId("cto-rotation-prompt");
    expect(prompt.textContent).toContain("over its context limit");
    expect(prompt.textContent).toContain("Nothing it remembers is lost");
  });

  it("lets the rotation prompt be dismissed", async () => {
    getThreadHealth.mockResolvedValue({ ...HEALTHY, rotationAdvised: true });
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-rotation-prompt");

    fireEvent.click(screen.getByTestId("cto-rotation-dismiss"));

    await waitFor(() => expect(screen.queryByTestId("cto-rotation-prompt")).toBeNull());
  });

  it("turns Fast mode off from settings on the locked CTO session", async () => {
    ensureSession.mockResolvedValueOnce({ ...SESSION, fastMode: true });
    render(<MemoryRouter><CtoPage /></MemoryRouter>);
    await screen.findByTestId("cto-agent-chat-pane");

    fireEvent.click(screen.getByRole("button", { name: "CTO settings" }));
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

  it("lays the brief, facts, and directed threads out as fields and rows", async () => {
    globalThis.window.ade = {
      ...globalThis.window.ade,
      cto: {
        getMemory: vi.fn().mockResolvedValue({
          memory: "",
          threadState: "",
          dailyLog: "",
          dailyLogDate: "2026-07-04",
          updatedAt: null,
          projectBrief: "Goal: Ship the coordinator\nDone when: One CTO directs every thread",
          projectItems: "- (pinned) The installer needs a GUI prompt.\n- (active) Prefer sentence case.",
          projectThreads: "- Installer · lane lane-installer · chat chat-child · Fix the prompt",
        }),
        updateMemory,
      },
    } as never;

    render(<CtoMemoryPanel />);

    expect(await screen.findByText("Ship the coordinator")).toBeTruthy();
    expect(screen.getByText("One CTO directs every thread")).toBeTruthy();
    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(screen.getByText("The installer needs a GUI prompt.")).toBeTruthy();
    expect(screen.getByText("Installer")).toBeTruthy();
    expect(screen.getByText(/Lane lane-installer/)).toBeTruthy();
    expect(screen.getByText("2 facts")).toBeTruthy();
  });
});

describe("CtoHistoryList", () => {
  const entry = {
    id: "log-1",
    sessionId: "session-1",
    summary: "Session closed: reviewed the sync lane",
    startedAt: "2026-05-01T10:00:00.000Z",
    endedAt: "2026-05-01T10:12:00.000Z",
    provider: "anthropic",
    modelId: "anthropic/claude-sonnet-5",
    capabilityMode: "full_tooling",
    createdAt: "2026-05-01T10:12:00.000Z",
  } as const;

  afterEach(cleanup);

  it("leads with the work, not the log line that recorded it", () => {
    // And reads as a sentence: what is left after the prefix started mid-line.
    expect(sessionTitle(entry)).toBe("Reviewed the sync lane");
    // A log line with nothing but its own prefix still needs a title.
    expect(sessionTitle({ ...entry, summary: "Session closed:" })).toBe("Untitled session");
  });

  it("states a duration only once the session has ended", () => {
    expect(sessionDuration(entry)).toBe("12m");
    expect(sessionDuration({ ...entry, endedAt: null })).toBeNull();
  });

  it("names the day in the words a person uses for it", () => {
    const now = new Date("2026-05-03T09:00:00.000Z");
    expect(dayLabel("2026-05-03T08:00:00.000Z", now)).toBe("Today");
    expect(dayLabel("2026-05-02T08:00:00.000Z", now)).toBe("Yesterday");
    expect(dayLabel("2026-04-28T08:00:00.000Z", now)).toMatch(/Apr 28/);
  });

  it("never prints the capability enum on an ordinary session", () => {
    render(<CtoHistoryList sessions={[entry]} />);
    const list = screen.getByTestId("session-history-list");
    expect(list.textContent).not.toMatch(/full_tooling/i);
    expect(list.textContent).not.toContain("Limited tools");
    // The unusual case is the one worth a word.
    cleanup();
    render(<CtoHistoryList sessions={[{ ...entry, capabilityMode: "fallback" }]} />);
    expect(screen.getByTestId("session-history-list").textContent).toContain("Limited tools");
  });

  it("says what a retired thread cost and what survived it", () => {
    expect(sessionRetirementNote({ ...entry, turnCount: 12 }))
      .toBe("Retired after 12 turns · memory carried over");
    // A thread from before the count still says the part that matters.
    expect(sessionRetirementNote(entry)).toBe("Retired · memory carried over");
    // Nothing has been carried over from a thread that is still going.
    expect(sessionRetirementNote({ ...entry, endedAt: null }))
      .toBe("Still running · this is the live thread");
  });

  it("puts the note on the row, so the list never reads as separate assistants", () => {
    render(<CtoHistoryList sessions={[{ ...entry, turnCount: 3 }]} />);
    expect(screen.getByTestId("cto-history-row-note").textContent)
      .toBe("Retired after 3 turns · memory carried over");
  });

  it("says the current thread is still running when nothing has been retired", () => {
    render(<CtoHistoryList sessions={[]} />);
    expect(screen.getByText(/No thread has been retired in this project yet/)).toBeTruthy();
  });
});

describe("CTO settings sections", () => {
  afterEach(cleanup);

  it("calls the section Past threads and explains that the CTO itself carries on", () => {
    // The owner read "History" as a list of different CTOs and asked why it is
    // not one ever-learning session. It is: only the thread underneath rotates.
    expect(CTO_PAST_THREADS_DESCRIPTION).toContain("one assistant with one memory");
    expect(CTO_PAST_THREADS_DESCRIPTION).toContain("retired");
    expect(CTO_PAST_THREADS_DESCRIPTION).toContain("carry over");
    expect(CTO_PAST_THREADS_DESCRIPTION.split(". ").length).toBe(2);
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

/**
 * The identity fields, against an identity that arrives late.
 *
 * `CtoPage` draws the gear before the snapshot lands, so this page mounts with
 * `identity` null often enough that Save writing an empty standing-instruction
 * block over a real one is the ordinary case, not the edge one.
 */
describe("CtoSettingsPage identity fields", () => {
  afterEach(cleanup);

  function settingsProps(identity: Record<string, unknown> | null) {
    return {
      identity: identity as never,
      sessionLogs: [],
      currentModelId: "anthropic/claude-sonnet-5",
      currentReasoningEffort: null,
      currentFastMode: false,
      availableModelIds: ["anthropic/claude-sonnet-5"],
      loadingModels: false,
      switchingModel: false,
      onModelChange: vi.fn(),
      onFastModeChange: vi.fn(),
      onOpenProviderSettings: vi.fn(),
      onIdentityChange: vi.fn(),
      onClose: vi.fn(),
    };
  }

  const LANDED = {
    version: 2,
    name: "Ada",
    persona: "Senior CTO",
    systemPromptExtension: "We ship on Fridays.",
  };

  function openIdentity() {
    // The rail entry, which is the first of the two things called Identity.
    fireEvent.click(screen.getAllByRole("button", { name: /Identity/ })[0]);
  }

  it("fills the fields from an identity that arrives after the page", () => {
    const { rerender } = render(<CtoSettingsPage {...settingsProps(null)} />);
    openIdentity();
    expect((screen.getByLabelText("Standing instructions") as HTMLTextAreaElement).value).toBe("");

    rerender(<CtoSettingsPage {...settingsProps(LANDED)} />);

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ada");
    expect((screen.getByLabelText("Standing instructions") as HTMLTextAreaElement).value)
      .toBe("We ship on Fridays.");
    // Nothing was typed, so there is nothing to save.
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps an unsaved edit when the identity changes underneath it", () => {
    const { rerender } = render(<CtoSettingsPage {...settingsProps(LANDED)} />);
    openIdentity();

    const extra = screen.getByLabelText("Standing instructions") as HTMLTextAreaElement;
    fireEvent.change(extra, { target: { value: "Never touch billing." } });

    rerender(<CtoSettingsPage {...settingsProps({ ...LANDED, name: "Grace", systemPromptExtension: "From the phone." })} />);

    // The typed field is the user's; the untouched one follows the identity.
    expect((screen.getByLabelText("Standing instructions") as HTMLTextAreaElement).value)
      .toBe("Never touch billing.");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Grace");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  it("saves the standing instructions it was given, not an empty block", () => {
    const props = settingsProps(null);
    const { rerender } = render(<CtoSettingsPage {...props} />);
    openIdentity();
    rerender(<CtoSettingsPage {...props} identity={LANDED as never} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada L" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(props.onIdentityChange).toHaveBeenCalledWith({
      name: "Ada L",
      systemPromptExtension: "We ship on Fridays.",
    });
  });
});

/* --- The call HUD (CtoVoiceHud.tsx). --- */

/**
 * What the person on the call can see about what was heard.
 *
 * Two failures from the call of 2026-09-16, both of them the HUD's to answer: a
 * user who said three sentences and watched nothing appear until the finals
 * arrived at once, and an answer cut off by a barge-in whose caption claimed
 * the half sentence was the whole of it.
 */

function renderHud(patch: Partial<CtoVoiceState>) {
  const state: CtoVoiceState = { ...CTO_VOICE_INITIAL_STATE, phase: "listening", ...patch };
  render(
    <CtoVoiceHud
      state={state}
      onToggleMute={vi.fn()}
      onEnd={vi.fn()}
      onApproveConfirmation={vi.fn()}
      onDenyConfirmation={vi.fn()}
    />,
  );
}

describe("the call HUD's captions", () => {
  afterEach(cleanup);

  it("shows the words still being transcribed", () => {
    renderHud({ pendingUserText: "what merged yester" });
    expect(screen.getByTestId("cto-voice-pending-caption").textContent)
      .toContain("what merged yester");
  });

  it("shows nothing extra when nothing is part-heard", () => {
    renderHud({ captions: [{ role: "user", text: "hello", atMs: 10 }] });
    expect(screen.queryByTestId("cto-voice-pending-caption")).toBeNull();
    expect(screen.getByTestId("cto-voice-caption").textContent).toContain("hello");
  });

  it("marks a caption the user cut off", () => {
    renderHud({
      captions: [{ role: "assistant", text: "I'm the CTO", atMs: 10, interrupted: true }],
    });
    expect(screen.getByTestId("cto-voice-caption-cut")).toBeTruthy();
  });

  it("leaves a finished answer unmarked", () => {
    renderHud({ captions: [{ role: "assistant", text: "Three merged yesterday.", atMs: 10 }] });
    expect(screen.queryByTestId("cto-voice-caption-cut")).toBeNull();
  });
});

/**
 * A call is a surface where nothing is clicked and everything moves on its own.
 *
 * The captions are the only record of what was said and the phase label is the
 * only word for what the call is doing, so both have to be announced; and a
 * strip that can authorise a destructive action must arrive where the keyboard
 * already is rather than somewhere the user has to go and find — without the
 * destructive answer itself being one keypress away.
 */
describe("the call HUD's announcements", () => {
  afterEach(cleanup);

  it("announces the captions and the phase without interrupting", () => {
    renderHud({ captions: [{ role: "assistant", text: "Two checks are red.", atMs: 10 }] });
    expect(screen.getByTestId("cto-voice-captions").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("cto-voice-phase-label").getAttribute("aria-live")).toBe("polite");
  });

  it("keeps the caption region in the accessibility tree before anything is said", () => {
    // `empty:hidden` is `display: none`, which takes a live region back OUT of
    // the tree — and a region that appears with its content already in it
    // announces nothing at all, which is the failure it was meant to avoid.
    renderHud({ captions: [] });
    const captions = screen.getByTestId("cto-voice-captions");
    expect(captions.className).not.toContain("empty:hidden");
  });

  it("raises the confirmation strip as an alert, and puts the keyboard on the strip", () => {
    renderHud({
      phase: "confirming",
      pendingConfirmation: {
        id: "confirm-1",
        prompt: "Force-push the sync lane?",
        toolName: "gitForcePush",
        destructive: true,
        utteranceId: null,
        expiresAtMs: 0,
      },
    });
    const strip = screen.getByTestId("cto-voice-confirm");
    expect(strip.getAttribute("role")).toBe("alert");
    // The STRIP, never the approve button: a focused "Yes, do it" turns one
    // stray Enter or Space into an authorised force-push.
    expect(document.activeElement).toBe(strip);
    expect(document.activeElement).not.toBe(screen.getByTestId("cto-voice-confirm-approve"));
  });
});
