import {
  AgentChatEventEnvelope,
  claudeSdkCreateSessionCompat,
  createService,
  fs,
  installClaudeResponseFixture,
  path,
  tmpRoot,
  waitForEvent,
} from "./agentChatService.testHarness";
import { formatThreadReviewBlock } from "../../../shared/threadComments";
import { describe, expect, it, vi } from "vitest";

type Service = ReturnType<typeof createService>["service"];

async function startHeldClaudeTurn() {
  const events: AgentChatEventEnvelope[] = [];
  const send = vi.fn().mockResolvedValue(undefined);
  const setPermissionMode = vi.fn().mockResolvedValue(undefined);
  let streamCall = 0;
  let finishActiveTurn!: () => void;
  const activeTurnGate = new Promise<void>((resolve) => { finishActiveTurn = resolve; });

  const stream = vi.fn(() => (async function* () {
    streamCall += 1;
    if (streamCall === 1) {
      yield { type: "system", subtype: "init", session_id: "sdk-thread-comments", slash_commands: [] };
      return;
    }
    if (streamCall === 2) {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Still working" }], usage: { input_tokens: 1, output_tokens: 1 } },
      };
      await activeTurnGate;
      yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      return;
    }
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "Delivered" }], usage: { input_tokens: 1, output_tokens: 1 } },
    };
    yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
  })());

  vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
    send,
    stream,
    close: vi.fn(),
    sessionId: "sdk-thread-comments",
    setPermissionMode,
  } as any);

  const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
  const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
  const activeTurn = service.runSessionTurn({ sessionId: session.id, text: "Foreground work", timeoutMs: 15_000 });
  await waitForEvent(
    events,
    (event): event is AgentChatEventEnvelope =>
      event.event.type === "text" && event.event.text.includes("Still working"),
  );
  return { service, session, events, activeTurn, finishActiveTurn, send };
}

function createComment(service: Service, sessionId: string) {
  return service.createThreadComment({
    sessionId,
    messageKey: "message:1",
    messageExcerpt: "an earlier reply",
    anchor: { kind: "text", quote: "the quoted part", prefix: "", suffix: "" },
    body: "my note",
  });
}

describe("thread comments riding a steer", () => {
  it("puts the comments back when a full queue drops the steer", async () => {
    const { service, session, activeTurn, finishActiveTurn } = await startHeldClaudeTurn();
    // Fill Claude's pending-steer queue so the next steer is refused.
    for (let i = 0; i < 10; i += 1) {
      await service.steer({ sessionId: session.id, text: `filler ${i}` });
    }
    await createComment(service, session.id);

    const dropped = await service.steer({
      sessionId: session.id,
      text: "carry my comments",
      includeThreadComments: true,
    });

    expect(dropped).toMatchObject({ queued: false, reason: "queue_full" });
    // The drop delivered nothing, so the comments are still pending.
    expect(service.listThreadComments({ sessionId: session.id })).toHaveLength(1);
    finishActiveTurn();
    await activeTurn;
    service.forceDisposeAll();
  });

  it("puts the comments back when a queued steer is cancelled", async () => {
    const { service, session, activeTurn, finishActiveTurn } = await startHeldClaudeTurn();
    await createComment(service, session.id);

    const queued = await service.steer({
      sessionId: session.id,
      text: "carry my comments",
      includeThreadComments: true,
    });
    expect(queued).toMatchObject({ queued: true, steerId: expect.any(String) });
    expect(service.listThreadComments({ sessionId: session.id })).toHaveLength(0);

    await service.cancelSteer({ sessionId: session.id, steerId: queued.steerId });

    expect(service.listThreadComments({ sessionId: session.id })).toHaveLength(1);
    finishActiveTurn();
    await activeTurn;
    service.forceDisposeAll();
  });

  it("puts the comments back when a queued steer is emptied", async () => {
    const { service, session, activeTurn, finishActiveTurn } = await startHeldClaudeTurn();
    await createComment(service, session.id);

    const queued = await service.steer({
      sessionId: session.id,
      text: "carry my comments",
      includeThreadComments: true,
    });
    expect(queued.queued).toBe(true);
    expect(service.listThreadComments({ sessionId: session.id })).toHaveLength(0);

    await service.editSteer({ sessionId: session.id, steerId: queued.steerId, text: "   " });

    expect(service.listThreadComments({ sessionId: session.id })).toHaveLength(1);
    finishActiveTurn();
    await activeTurn;
    service.forceDisposeAll();
  });

  it("leaves the comments spent after the steer has been delivered", async () => {
    const { service, session, activeTurn, finishActiveTurn } = await startHeldClaudeTurn();
    await createComment(service, session.id);

    // Inline dispatch delivers the steer without ever queueing it, so there is
    // no queued review to restore.
    const delivered = await service.steer({
      sessionId: session.id,
      text: "carry my comments",
      includeThreadComments: true,
      dispatchMode: "inline",
    });
    expect(delivered).toMatchObject({ queued: false });
    expect(service.listThreadComments({ sessionId: session.id })).toHaveLength(0);

    await service.cancelSteer({ sessionId: session.id, steerId: delivered.steerId });
    expect(service.listThreadComments({ sessionId: session.id })).toHaveLength(0);
    finishActiveTurn();
    await activeTurn;
    service.forceDisposeAll();
  });
});

describe("thread review block ordering", () => {
  it("keeps the review block first when a pasted prompt is folded into the send", async () => {
    const { service, send, events } = createServiceWithClaudeResponse();
    const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
    const block = formatThreadReviewBlock([{
      messageExcerpt: "an earlier reply",
      anchor: { kind: "text", quote: "the quoted part", prefix: "", suffix: "" },
      body: "my note",
    }])!;
    const pastedPath = path.join(tmpRoot, "pasted-review.txt");
    fs.writeFileSync(pastedPath, "PASTED BODY");

    await service.sendMessage({
      sessionId: session.id,
      text: `${block}\n\nUSER TYPED`,
      attachments: [{ path: pastedPath, type: "file", intent: "user_prompt" }],
    });
    await vi.waitFor(() => {
      expect(send.mock.calls.some((call) => String(call[0]).includes("PASTED BODY"))).toBe(true);
    });

    const prompt = send.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes("PASTED BODY"))!;
    const blockIndex = prompt.indexOf("<ade-review>");
    const pastedIndex = prompt.indexOf("PASTED BODY");
    const typedIndex = prompt.indexOf("USER TYPED");
    expect(blockIndex).toBeGreaterThanOrEqual(0);
    expect(pastedIndex).toBeGreaterThan(blockIndex);
    expect(typedIndex).toBeGreaterThan(pastedIndex);
    expect(prompt).toContain(path.basename(pastedPath));
    expect(prompt.match(/copy and paste/i)).toHaveLength(1);
    const userMessage = events.find((entry): entry is AgentChatEventEnvelope & {
      event: Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>;
    } =>
      entry.event.type === "user_message" && Boolean(entry.event.attachments?.some((attachment) => attachment.path === pastedPath)),
    );
    expect(userMessage?.event).toMatchObject({ displayText: "USER TYPED" });
    expect(userMessage?.event.attachments?.map((attachment) => attachment.path)).toContain(pastedPath);
    service.forceDisposeAll();
  });
});

function createServiceWithClaudeResponse() {
  const { send } = installClaudeResponseFixture({
    sdkSessionId: "sdk-review-paste",
    responseText: "ok",
  });
  const events: AgentChatEventEnvelope[] = [];
  const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
  return { service, send, events };
}
