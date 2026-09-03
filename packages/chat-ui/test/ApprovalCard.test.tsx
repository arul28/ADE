import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdeChat } from "../src/AdeChat";
import { ApprovalCard } from "../src/transcript/ApprovalCard";
import { Transcript } from "../src/transcript/Transcript";
import { buildTranscriptRows, type ApprovalRow } from "../src/transcript/transcriptRows";
import type {
  AdeChatClient,
  AdeThread,
  AgentChatEventEnvelope,
  ApprovalRequest,
  ModelDescriptor,
  ProviderStatus,
  ThreadOpenOptions,
  Unsubscribe,
} from "../src/sdkTypes";

/**
 * The approval card is the only interactive row in the transcript, and the only
 * one whose absence hangs the conversation: a provider that asks for permission
 * parks its turn until someone answers. These tests pin the three things that
 * make it usable — the answer reaches the thread, the card stays on screen once
 * answered, and a client that cannot answer says so instead of throwing.
 */

function approvalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    type: "approval",
    id: "item-1",
    kind: "command",
    description: "Run a shell command",
    detail: { command: "ls -la /tmp" },
    turnId: "t1",
    state: "pending",
    ...overrides,
  };
}

function rowsFor(row: ApprovalRow) {
  return [{ key: `approval:${row.id}`, timestamp: "2026-09-02T04:00:00.000Z", event: row }];
}

describe("<ApprovalCard>", () => {
  it("shows the description and the command it is asking about", () => {
    render(<ApprovalCard row={approvalRow()} onApprove={vi.fn()} />);
    expect(screen.getByText("Run a shell command")).toBeTruthy();
    expect(screen.getByText("ls -la /tmp")).toBeTruthy();
  });

  it("reads a command nested under the tool input", () => {
    render(
      <ApprovalCard
        row={approvalRow({ detail: { input: { command: ["git", "status"] } } })}
        onApprove={vi.fn()}
      />,
    );
    expect(screen.getByText("git status")).toBeTruthy();
  });

  it("shows the path and grant root of a file change", () => {
    render(
      <ApprovalCard
        row={approvalRow({
          kind: "file_change",
          description: "Write a file",
          detail: { path: "/work/notes.md", grantRoot: "/work" },
        })}
        onApprove={vi.fn()}
      />,
    );
    expect(screen.getByText("/work/notes.md")).toBeTruthy();
    expect(screen.getByText("Inside /work")).toBeTruthy();
  });

  it.each([
    ["Allow once", "accept"],
    ["Always allow", "accept_always"],
    ["Reject", "reject"],
  ] as const)("sends %s as %s", (label, decision) => {
    const onApprove = vi.fn();
    render(<ApprovalCard row={approvalRow()} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onApprove).toHaveBeenCalledWith("item-1", decision);
  });

  it("stops accepting clicks the moment one is pressed", () => {
    // Two answers to one request is one too many: the second reaches a settled
    // item and the runtime has nothing to do with it.
    const onApprove = vi.fn();
    render(<ApprovalCard row={approvalRow()} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("keeps the card on screen in a settled state after the decision", () => {
    render(<ApprovalCard row={approvalRow({ state: "accepted" })} onApprove={vi.fn()} />);
    expect(screen.getByText("Allowed")).toBeTruthy();
    // Still there, still readable, and no longer answerable — a card that
    // vanished would look exactly like one nobody ever answered.
    for (const label of ["Allow once", "Always allow", "Reject"]) {
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("remembers that the reader allowed everything, not just this call", () => {
    // `pending_input_resolved` says only "accepted", so this distinction exists
    // nowhere but in the card that took the click.
    const { rerender } = render(<ApprovalCard row={approvalRow()} onApprove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    rerender(<ApprovalCard row={approvalRow({ state: "accepted" })} onApprove={vi.fn()} />);
    expect(screen.getByText("Allowed for the rest of this session")).toBeTruthy();
  });

  it("says the turn ended when a request expired unanswered", () => {
    render(<ApprovalCard row={approvalRow({ state: "expired" })} onApprove={vi.fn()} />);
    expect(screen.getByText("The turn ended before this was answered.")).toBeTruthy();
  });

  it("renders read-only when the thread cannot answer approvals", () => {
    render(<ApprovalCard row={approvalRow()} />);
    expect(screen.getByText("This host cannot answer approvals.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });

  it.each(["question", "structured_question", "plan_approval", "model_selection"])(
    "renders %s read-only, because Allow means nothing to it",
    (requestKind) => {
      render(<ApprovalCard row={approvalRow({ requestKind })} onApprove={vi.fn()} />);
      expect(
        screen.getByText("The assistant is waiting for an answer this UI cannot provide."),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    },
  );

  it("re-offers the buttons and says why when the answer failed to send", async () => {
    // The turn is still blocked. A reader who believes they answered would wait
    // forever for a reply that cannot come.
    const onApprove = vi.fn(async () => {
      throw new Error("approval_not_found");
    });
    render(<ApprovalCard row={approvalRow()} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/approval_not_found/);
    expect((screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("uses the host's own wording", () => {
    render(
      <ApprovalCard
        row={approvalRow()}
        onApprove={vi.fn()}
        options={{
          labels: {
            title: (request) => `Let the assistant ${request.description.toLowerCase()}?`,
            accept: "Just this once",
            acceptAlways: "Always",
            reject: "No",
          },
        }}
      />,
    );
    expect(screen.getByText("Let the assistant run a shell command?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Just this once" })).toBeTruthy();
  });

  it("hands a custom renderer the request and a respond callback", () => {
    const onApprove = vi.fn();
    render(
      <ApprovalCard
        row={approvalRow()}
        onApprove={onApprove}
        options={{
          render: (request, respond) => (
            <button type="button" onClick={() => respond("accept")}>
              Custom: {request.description}
            </button>
          ),
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Custom: Run a shell command" });
    fireEvent.click(button);
    expect(onApprove).toHaveBeenCalledWith("item-1", "accept");
    // The built-in card is replaced, not decorated.
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });
});

describe("<Transcript> approval rows", () => {
  it("draws the card inline at the request's position, not as a modal", () => {
    const rows = buildTranscriptRows([
      {
        sessionId: "s1",
        timestamp: "2026-09-02T04:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "Let me check that." },
      },
      {
        sessionId: "s1",
        timestamp: "2026-09-02T04:00:01.000Z",
        sequence: 2,
        event: {
          type: "approval_request",
          itemId: "item-1",
          kind: "command",
          description: "Run a shell command",
        },
      },
    ]);
    const { container } = render(<Transcript rows={rows} onApprove={vi.fn()} />);
    const drawn = Array.from(container.querySelectorAll(".adechat-assistant, .adechat-approval"));
    expect(drawn).toHaveLength(2);
    // The card follows the text it belongs to rather than covering it.
    expect(drawn[1]!.className).toContain("adechat-approval");
  });

  it("says it is waiting on the reader rather than claiming to be working", () => {
    render(<Transcript rows={rowsFor(approvalRow())} status="running" onApprove={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toMatch(/Waiting for your approval/);
    expect(screen.getByRole("status").textContent).not.toMatch(/Working/);
  });

  it("stops saying so once the request is answered", () => {
    render(
      <Transcript
        rows={rowsFor(approvalRow({ state: "accepted" }))}
        status="running"
        onApprove={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Working/);
  });
});

/* -------------------------------------------------------------------------- */
/* Integration through <AdeChat>                                               */
/* -------------------------------------------------------------------------- */

const statuses: ProviderStatus[] = [
  { id: "claude", displayName: "Claude", installed: true, authenticated: true },
];
const models: ModelDescriptor[] = [
  { id: "claude/haiku", providerId: "claude", displayName: "Haiku" },
];

type ThreadParts = {
  history?: AgentChatEventEnvelope[];
  approve?: AdeThread["approve"];
  pendingApprovals?: AdeThread["pendingApprovals"];
};

function stubThread(parts: ThreadParts = {}): AdeThread {
  return {
    key: "main",
    send: async () => {},
    steer: async () => {},
    interrupt: async () => {},
    history: async () => parts.history ?? [],
    on: (() => () => {}) as AdeThread["on"],
    // Omitted entirely when unsupported: an absent property is what
    // `canApprove` reads, and it is what renders the card read-only.
    ...(parts.approve ? { approve: parts.approve } : {}),
    ...(parts.pendingApprovals ? { pendingApprovals: parts.pendingApprovals } : {}),
  };
}

function stubClient(thread: AdeThread): AdeChatClient {
  return {
    providers: { status: async () => statuses, onChange: (): Unsubscribe => () => {} },
    models: { list: async () => models },
    threads: { open: async (_key: string, _opts?: ThreadOpenOptions) => thread },
  };
}

const requestEnvelope: AgentChatEventEnvelope = {
  sessionId: "s1",
  timestamp: "2026-09-02T04:00:00.000Z",
  sequence: 1,
  event: {
    type: "approval_request",
    itemId: "item-1",
    kind: "command",
    description: "Run a shell command",
    detail: { command: "ls -la" },
  },
};

describe("<AdeChat> approvals", () => {
  it("answers through the thread's approve", async () => {
    const approve = vi.fn(async () => {});
    render(
      <AdeChat
        client={stubClient(stubThread({ history: [requestEnvelope], approve }))}
        threadKey="main"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("item-1", "accept_always"));
  });

  it("renders read-only against a client whose thread has no approve", async () => {
    render(
      <AdeChat client={stubClient(stubThread({ history: [requestEnvelope] }))} threadKey="main" />,
    );
    // A proxy, a fake, or an older SDK. It must explain itself, not throw and
    // not offer a button that would.
    expect(await screen.findByText("This host cannot answer approvals.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });

  it("never takes focus from the composer", async () => {
    const approve = vi.fn(async () => {});
    render(
      <AdeChat
        client={stubClient(stubThread({ history: [requestEnvelope], approve }))}
        threadKey="main"
      />,
    );
    const composer = await screen.findByRole("textbox");
    composer.focus();
    expect(document.activeElement).toBe(composer);

    // The card arriving must not move the caret out of a half-typed sentence.
    await screen.findByRole("button", { name: "Allow once" });
    expect(document.activeElement).toBe(composer);
  });

  it("restores a card for a request the transcript no longer carries", async () => {
    // After a reload the live events that carried the request are gone, and
    // history may not reach back to it. Without this the thread comes back
    // looking merely silent, and nothing on screen can unblock it.
    const request: ApprovalRequest = {
      itemId: "item-restored",
      kind: "command",
      description: "Run a shell command",
      detail: { command: "ls -la" },
    };
    const pendingApprovals = vi.fn(async () => [request]);
    const approve = vi.fn(async () => {});
    render(
      <AdeChat
        client={stubClient(stubThread({ history: [], approve, pendingApprovals }))}
        threadKey="main"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("item-restored", "accept"));
  });

  it("places a restored card after history the engine stamped later than this clock", async () => {
    // The restored card sorts against timestamps the ENGINE stamped. An
    // embedder over a WebSocket proxy or a remote runtime is a different
    // machine, and a client clock behind the host used to bury the live card up
    // in history. Anchoring to the transcript's own last timestamp removes the
    // client clock from the answer.
    const future: AgentChatEventEnvelope = {
      sessionId: "s1",
      timestamp: "2099-01-01T00:00:00.000Z",
      sequence: 1,
      event: { type: "text", text: "engine stamped this far ahead", messageId: "m1" },
    };
    const request: ApprovalRequest = {
      itemId: "item-restored",
      kind: "command",
      description: "Run a shell command",
      detail: { command: "ls -la" },
    };
    render(
      <AdeChat
        client={stubClient(
          stubThread({
            history: [future],
            approve: async () => {},
            pendingApprovals: async () => [request],
          }),
        )}
        threadKey="main"
      />,
    );
    const button = await screen.findByRole("button", { name: "Allow once" });
    const message = screen.getByText("engine stamped this far ahead");
    // DOCUMENT_POSITION_FOLLOWING: the card is after the message, not before it.
    expect(message.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not draw a restored request twice when history already has it", async () => {
    const pendingApprovals = vi.fn(async () => [
      { itemId: "item-1", kind: "command" as const, description: "Run a shell command" },
    ]);
    render(
      <AdeChat
        client={stubClient(
          stubThread({ history: [requestEnvelope], approve: async () => {}, pendingApprovals }),
        )}
        threadKey="main"
      />,
    );
    await screen.findByRole("button", { name: "Allow once" });
    expect(screen.getAllByRole("button", { name: "Allow once" })).toHaveLength(1);
  });

  it("opens the thread even when pendingApprovals fails", async () => {
    const pendingApprovals = vi.fn(async () => {
      throw new Error("runtime is busy");
    });
    render(
      <AdeChat
        client={stubClient(stubThread({ history: [requestEnvelope], approve: async () => {}, pendingApprovals }))}
        threadKey="main"
      />,
    );
    // The transcript still arrives; a failed restore is not a failed open.
    expect(await screen.findByText("Run a shell command")).toBeTruthy();
  });
});
