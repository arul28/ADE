import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdeChat } from "../src/AdeChat";
import type {
  AdeChatClient,
  AdeThread,
  AgentChatEventEnvelope,
  ModelDescriptor,
  ProviderStatus,
  ThreadOpenOptions,
  Unsubscribe,
} from "../src/sdkTypes";

/**
 * Regression cover for a defect found by running `<AdeChat>` against a real
 * `@ade-dev/sdk` client for the first time: with neither `modelId` nor
 * `defaultModelId`, the component opened the thread with no model at all. The
 * fake client used by the other tests accepted that; the SDK rejects it, and
 * the user's first sight of the product was a developer-facing error.
 */

const statuses: ProviderStatus[] = [
  { id: "claude", displayName: "Claude", installed: true, authenticated: true },
  { id: "codex", displayName: "Codex", installed: true, authenticated: false },
];

const models: ModelDescriptor[] = [
  // Deliberately first and unusable: its provider is not authenticated, so the
  // fallback must skip it rather than take models[0].
  { id: "codex/gpt", providerId: "codex", displayName: "GPT" },
  { id: "claude/haiku", providerId: "claude", displayName: "Haiku" },
  // A second selectable model, so a switch test has somewhere to go. "GPT"
  // above is deliberately unusable and its row stays disabled.
  { id: "claude/opus", providerId: "claude", displayName: "Opus" },
];

function stubThread(
  setModel?: AdeThread["setModel"],
  /** Drives the "status" channel so a test can put the thread mid-turn. */
  statusFeed?: (emit: (status: { state: "idle" | "running" | "error" }) => void) => void,
): AdeThread {
  return {
    key: "main",
    send: async () => {},
    steer: async () => {},
    interrupt: async () => {},
    history: async () => [] as AgentChatEventEnvelope[],
    on: ((channel: string, cb: (value: unknown) => void) => {
      if (channel === "status" && statusFeed) statusFeed(cb as never);
      return () => {};
    }) as AdeThread["on"],
    // Omitted entirely when unsupported — `canSetModel` distinguishes an absent
    // property from one holding undefined.
    ...(setModel ? { setModel } : {}),
  };
}

/** Opens the rail and clicks a model row by its display name. */
async function pickModel(railLabel: string, modelLabel: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: railLabel }));
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(modelLabel) }));
}

function stubClient(open: (key: string, opts?: ThreadOpenOptions) => Promise<AdeThread>): AdeChatClient {
  return {
    providers: {
      status: async () => statuses,
      onChange: (): Unsubscribe => () => {},
    },
    models: { list: async () => models },
    threads: { open },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("<AdeChat> model resolution", () => {
  it("never opens a thread without a model, and picks the first selectable one", async () => {
    const open = vi.fn(async (_key: string, _opts?: ThreadOpenOptions) => stubThread());
    render(<AdeChat client={stubClient(open)} threadKey="main" />);

    await waitFor(() => expect(open).toHaveBeenCalled());
    for (const call of open.mock.calls) {
      expect(call[1]?.modelId).toBeTruthy();
    }
    expect(open.mock.calls.at(-1)?.[1]?.modelId).toBe("claude/haiku");
  });

  it("labels the rail with the resolved model rather than 'Choose model'", async () => {
    const open = vi.fn(async (_key: string, _opts?: ThreadOpenOptions) => stubThread());
    render(<AdeChat client={stubClient(open)} threadKey="main" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Haiku" })).toBeTruthy());
  });

  it("still honours an explicit defaultModelId", async () => {
    const open = vi.fn(async (_key: string, _opts?: ThreadOpenOptions) => stubThread());
    render(<AdeChat client={stubClient(open)} threadKey="main" defaultModelId="codex/gpt" />);
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(open.mock.calls.at(-1)?.[1]?.modelId).toBe("codex/gpt");
  });
});

/**
 * Mid-thread model switching. Before this, `modelId` was a dependency of the
 * thread-open effect, so choosing a model on an OPEN conversation tore it down
 * and re-opened it — dropping the transcript for what should be an in-place
 * switch. The SDK had no `setModel` to call at all.
 */
describe("<AdeChat> mid-thread model switching", () => {
  it("switches the open thread in place instead of re-opening it", async () => {
    const setModel = vi.fn(async () => {});
    const open = vi.fn(async (_key: string, _opts?: ThreadOpenOptions) => stubThread(setModel));
    render(<AdeChat client={stubClient(open)} threadKey="main" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Haiku" })).toBeTruthy());
    const opensAfterReady = open.mock.calls.length;

    await pickModel("Haiku", "Opus");

    await waitFor(() => expect(setModel).toHaveBeenCalledWith("claude/opus"));
    // THE regression: a second open() would mean the conversation was torn down
    // and rebuilt, losing the local transcript.
    expect(open).toHaveBeenCalledTimes(opensAfterReady);
  });

  it("does not call setModel for the model the thread opened with", async () => {
    const setModel = vi.fn(async () => {});
    const open = vi.fn(async (_key: string, _opts?: ThreadOpenOptions) => stubThread(setModel));
    render(<AdeChat client={stubClient(open)} threadKey="main" defaultModelId="claude/haiku" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Haiku" })).toBeTruthy());
    // The open() call already applied it. Firing setModel here would tear down
    // a freshly created provider thread on every mount.
    expect(setModel).not.toHaveBeenCalled();
  });

  it("disables the picker with a reason when the thread cannot change models", async () => {
    // A client whose SDK predates setModel. The alternative to switching is a
    // disabled control that says why — never a click that silently does nothing.
    const open = vi.fn(async (_key: string, _opts?: ThreadOpenOptions) => stubThread());
    render(<AdeChat client={stubClient(open)} threadKey="main" />);

    const rail = await screen.findByRole("button", { name: "Haiku" });
    await waitFor(() => expect((rail as HTMLButtonElement).disabled).toBe(true));
    expect(rail.getAttribute("title")).toMatch(/cannot change models/i);
  });

  it("surfaces a failed switch instead of leaving the rail lying", async () => {
    const setModel = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const open = vi.fn(async (_key: string, _opts?: ThreadOpenOptions) => stubThread(setModel));
    render(<AdeChat client={stubClient(open)} threadKey="main" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Haiku" })).toBeTruthy());
    await pickModel("Haiku", "Opus");

    // Worst possible outcome is a silent failure: the rail shows the new model
    // while the OLD one keeps answering, and the user attributes its replies to
    // the model they think they picked.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not switch model/i);
    expect(alert.textContent).toMatch(/model unavailable/);
  });
});

/**
 * The SDK refuses a mid-turn switch, because tearing the runtime down kills the
 * in-flight turn with no `error` or `done` — the consumer just sees events
 * stop. Correct, but its message is written for a developer. This component has
 * to close the door before that message can reach a user.
 */
describe("<AdeChat> model switching during a live turn", () => {
  it("disables the picker while a turn is running, with a human reason", async () => {
    const setModel = vi.fn(async () => {});
    const open = vi.fn(async (_key: string, _opts?: ThreadOpenOptions) =>
      stubThread(setModel, (emit) => {
        // Runs on subscribe, so the thread is mid-turn from the first render.
        emit({ state: "running" });
      }),
    );
    render(<AdeChat client={stubClient(open)} threadKey="main" />);

    const rail = await screen.findByRole("button", { name: "Haiku" });
    await waitFor(() => expect((rail as HTMLButtonElement).disabled).toBe(true));
    // A person can act on this. "pass { force: true }" is not that.
    expect(rail.getAttribute("title")).toMatch(/wait for the current reply/i);
    expect(rail.getAttribute("title")).not.toMatch(/force|interrupt\(\)/i);
  });

  it("does not attempt a switch that the SDK would refuse", async () => {
    const setModel = vi.fn(async () => {});
    const open = vi.fn(async (_key: string, _opts?: ThreadOpenOptions) =>
      stubThread(setModel, (emit) => emit({ state: "running" })),
    );
    render(
      <AdeChat client={stubClient(open)} threadKey="main" modelId="claude/opus" />,
    );

    await waitFor(() => expect(open).toHaveBeenCalled());
    // Calling anyway would surface the SDK's developer-facing refusal in the
    // alert region, which is worse than not offering the control.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(setModel).not.toHaveBeenCalled();
  });

  it("applies a model chosen mid-turn once the turn finishes", async () => {
    const setModel = vi.fn(async () => {});
    let emitStatus: ((status: { state: "idle" | "running" | "error" }) => void) | null = null;
    const open = vi.fn(async (_key: string, _opts?: ThreadOpenOptions) =>
      stubThread(setModel, (emit) => {
        emitStatus = emit;
        emit({ state: "running" });
      }),
    );
    // One stable client across both renders: a fresh object would change the
    // `client` prop and re-open the thread, which is not what this tests.
    const client = stubClient(open);
    // Opens on haiku, so the later switch to opus is a real change rather than
    // a no-op against the model the thread was already bound to.
    const view = render(
      <AdeChat client={client} threadKey="main" modelId="claude/haiku" />,
    );
    await waitFor(() => expect(open).toHaveBeenCalled());

    // The host changes model while the turn is still streaming.
    view.rerender(<AdeChat client={client} threadKey="main" modelId="claude/opus" />);
    expect(setModel).not.toHaveBeenCalled();

    // The turn ends. A pick made while it was running must NOT be dropped —
    // silently discarding it is the same class of bug as the ignored picker
    // this whole change set out to remove.
    await waitFor(() => expect(emitStatus).not.toBeNull());
    // act(): the emit originates outside React, so without it the state update
    // is not flushed before the assertion.
    await act(async () => {
      emitStatus!({ state: "idle" });
    });
    await waitFor(() => expect(setModel).toHaveBeenCalledWith("claude/opus"));
  });
});
