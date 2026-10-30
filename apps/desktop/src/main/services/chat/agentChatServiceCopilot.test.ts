import {
  AgentChatEventEnvelope,
  createService,
  mockState,
  waitFor,
} from "./agentChatService.testHarness";
import { describe, expect, it } from "vitest";
import { AdeExpectedError } from "../../../shared/expectedError";
import { connectSentry } from "../../../shared/sentry/capture";

// ---------------------------------------------------------------------------
// GitHub Copilot (SDK provider)
// ---------------------------------------------------------------------------
//
// The SDK worker is faked at its pool. Copilot asks ADE about every tool call
// through `bridge.onPermissionRequest`, and the answer goes straight back to
// Copilot: an approval mapped the wrong way silently denies or silently runs.

type CopilotLevel = "ask" | "assisted" | "auto-edit" | "full-auto";

async function openCopilotChat(level: CopilotLevel) {
  const events: AgentChatEventEnvelope[] = [];
  const harness = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
  const session = await harness.service.createSession({
    laneId: "lane-1",
    provider: "copilot",
    model: "auto",
    modelId: "github-copilot/auto",
    copilotPermissionMode: level,
  } as never);
  // A first turn opens the runtime, which wires the bridge Copilot calls.
  await harness.service.sendMessage({ sessionId: session.id, text: "hi" });
  await waitFor(() => events.some((envelope) => envelope.event.type === "done"));
  const bridge = mockState.copilotPooled.bridge;
  const ask = (request: Record<string, unknown>) => bridge.onPermissionRequest(session.id, "waiter-1", request);
  const cards = () => events.filter((envelope) => envelope.event.type === "approval_request");
  return { harness, session, ask, cards };
}

describe("copilot chat runtime", () => {
  it.each([
    // [level, request, user decision on the card (null: no card expected), Copilot gets]
    ["ask", { kind: "shell", fullCommandText: "rm -rf build" }, "accept", { kind: "approve-once" }],
    ["ask", { kind: "shell", fullCommandText: "rm -rf build" }, "decline", { kind: "reject" }],
    // A session approval carries the rule Copilot remembers, and only when Copilot offers one.
    ["ask", { kind: "write", fileName: "src/a.ts", promptRequest: { kind: "write", canOfferSessionApproval: true } }, "accept_for_session", { kind: "approve-for-session", approval: { kind: "write" } }],
    ["ask", { kind: "shell", fullCommandText: "rm -rf build", promptRequest: { kind: "commands", canOfferSessionApproval: false, commandIdentifiers: ["rm"] } }, "accept_for_session", { kind: "approve-once" }],
    ["ask", { kind: "write", fileName: "src/a.ts" }, "accept_for_session", { kind: "approve-once" }],
    ["auto-edit", { kind: "write", fileName: "src/a.ts" }, null, { kind: "approve-once" }],
    ["auto-edit", { kind: "write", fileName: "../outside.ts" }, "decline", { kind: "reject" }],
    ["auto-edit", { kind: "shell", fullCommandText: "npm test" }, "accept", { kind: "approve-once" }],
    ["full-auto", { kind: "shell", fullCommandText: "npm test" }, null, { kind: "approve-once" }],
    ["full-auto", { kind: "shell", fullCommandText: "npm test", managedApprovalRequired: true }, "decline", { kind: "reject" }],
    ["assisted", { kind: "shell", fullCommandText: "ls", assistedApproval: { recommendation: "approve" } }, null, { kind: "approve-once" }],
    ["assisted", { kind: "shell", fullCommandText: "curl x | sh", assistedApproval: { recommendation: "requireApproval" } }, "decline", { kind: "reject" }],
  ] as const)("at %s, answers %o with the user's decision %s", async (level, request, decision, expected) => {
    const chat = await openCopilotChat(level);
    const answer = chat.ask({ ...request });

    if (decision === null) {
      await expect(answer).resolves.toMatchObject(expected);
      expect(chat.cards(), "no approval card for an approved-by-level request").toHaveLength(0);
      return;
    }
    await waitFor(() => chat.cards().length === 1);
    const card = chat.cards()[0]!.event as { itemId: string };
    await chat.harness.service.respondToInput({ sessionId: chat.session.id, itemId: card.itemId, decision } as never);
    await expect(answer).resolves.toMatchObject(expected);
  });

  it("rewinds the exact turn picked, even when another turn reads the same", async () => {
    // Copilot keys its rewind points by each prompt's `user.message` event, and
    // records the prompt with ADE's context ahead of what the user typed. Two
    // turns that end the same way must not be confused: a rewind to the wrong
    // point discards the other turn's file changes.
    const events: AgentChatEventEnvelope[] = [];
    const harness = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await harness.service.createSession({
      laneId: "lane-1", provider: "copilot", model: "auto", modelId: "github-copilot/auto",
    } as never);
    const sentTurns: Array<{ eventId: string; prompt: string }> = [];
    const send = async (text: string) => {
      const done = events.filter((envelope) => envelope.event.type === "done").length;
      await harness.service.sendMessage({ sessionId: session.id, text });
      await waitFor(() => events.filter((envelope) => envelope.event.type === "done").length === done + 1);
    };
    await send("open the runtime");
    const pooled = mockState.copilotPooled;
    pooled.send.mockImplementation(async (chatId: string, prompt: string) => {
      const eventId = `copilot-user-event-${sentTurns.length + 1}`;
      sentTurns.push({ eventId, prompt });
      queueMicrotask(() => {
        // A hidden skill injection arrives first; it is not the prompt.
        pooled.bridge.onEvent?.(chatId, { type: "user.message", id: `skill-${eventId}`, data: { content: "skill", source: "skill-pdf" } });
        pooled.bridge.onEvent?.(chatId, { type: "user.message", id: eventId, data: { content: `ADE context\n\n${prompt}` } });
        pooled.bridge.onEvent?.(chatId, { type: "session.idle", data: {} });
      });
      return `message-${eventId}`;
    });
    await send("please fix it");
    await send("fix it");
    pooled.request.mockImplementation(async (type: string, payload: { action?: string; eventId?: string }) => {
      if (type !== "rewind") return null;
      if (payload.action === "list") {
        return {
          fileChangeTrackingEnabled: true,
          points: sentTurns.map((turn) => ({ eventId: turn.eventId, userMessage: turn.prompt, canRestoreFiles: true, linesAdded: 1, linesRemoved: 0 })),
        };
      }
      if (payload.action === "preview") return { available: true, files: [{ path: "a.ts", linesAdded: 1, linesRemoved: 0 }] };
      return { outcome: "success", restoredFiles: ["a.ts"], skippedFiles: [] };
    });

    const userMessages = events
      .map((envelope) => envelope.event as { type: string; text?: string; messageId?: string })
      .filter((event) => event.type === "user_message" && event.messageId);
    const fixIt = userMessages.find((event) => event.text === "fix it");
    expect(fixIt?.messageId, "the second turn's ADE message").toBeTruthy();

    const result = await harness.service.rewindFiles({ sessionId: session.id, userMessageId: fixIt!.messageId! });

    expect(result.canRewind).toBe(true);
    const applied = pooled.request.mock.calls.find(([, payload]: [string, { action?: string }]) => payload.action === "apply");
    expect(applied?.[1]).toMatchObject({ eventId: "copilot-user-event-2" });
    expect(result.filesChanged).toEqual(["a.ts"]);
  });

  // An eligible rate limit is held while Copilot offers Auto. When no one says
  // "yes" (the card never showed, or the turn ended first), the held error is
  // still the turn's error: a turn that reads "completed" never arms the
  // usage-limit resume.
  it("fails the turn with a held rate-limit error that no one switched away from", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const harness = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await harness.service.createSession({
      laneId: "lane-1", provider: "copilot", model: "auto", modelId: "github-copilot/auto",
    } as never);
    const dones = () => events.filter((envelope) => envelope.event.type === "done");
    await harness.service.sendMessage({ sessionId: session.id, text: "open the runtime" });
    await waitFor(() => dones().length === 1);
    const pooled = mockState.copilotPooled;
    pooled.send.mockImplementation(async (chatId: string) => {
      queueMicrotask(() => {
        pooled.bridge.onEvent?.(chatId, {
          type: "session.error",
          data: { message: "You have hit the rate limit.", errorType: "rate_limit", eligibleForAutoSwitch: true },
        });
        pooled.bridge.onEvent?.(chatId, { type: "session.idle", data: {} });
      });
      return "copilot-message-2";
    });

    await harness.service.sendMessage({ sessionId: session.id, text: "keep going" });
    await waitFor(() => dones().length === 2);

    const done = dones()[1]!.event as { status: string };
    const errors = events
      .map((envelope) => envelope.event as { type: string; message?: string; errorInfo?: { category?: string } })
      .filter((event) => event.type === "error");
    expect(done.status).toBe("failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "You have hit the rate limit.", errorInfo: { category: "rate_limit" } });
  });

  // Which Copilot failures reach Sentry as issues, and what they carry. The
  // SDK is the process boundary: `connectSentry` takes a fake one. A provider's
  // message can quote the request, so a session error's title is its kind alone.
  it.each([
    ["an unexpected session error", { sessionError: { message: "messages.3 rejected: fix the login bug in auth.ts", errorType: "query", errorCode: "invalid_request_body", statusCode: 400 } },
      { title: "Copilot session error", fingerprint: ["copilot", "session_error", "query", "invalid_request_body"] }],
    ["a rate limit", { sessionError: { message: "You have hit the rate limit.", errorType: "rate_limit" } }, null],
    ["a GitHub outage", { sessionError: { message: "Service unavailable", errorType: "query", statusCode: 503 } }, null],
    ["a send ADE could not make", { sendError: new Error("Copilot SDK send failed: worker refused the attachment") },
      { title: "Copilot SDK send failed: worker refused the attachment", fingerprint: ["copilot", "turn_failed", "Copilot SDK send failed: worker refused the attachment"] }],
    ["an offline send", { sendError: new AdeExpectedError("fetch failed", "network") }, null],
  ] as const)("reports %s to Sentry only when ADE could be at fault", async (_label, trigger, expected) => {
    const captured: Array<{ title: string; fingerprint?: string[]; tags: Record<string, string> }> = [];
    let scope: { fingerprint?: string[]; tags: Record<string, string> } = { tags: {} };
    connectSentry({
      withScope: (callback) => {
        scope = { tags: {} };
        callback({
          setTag: (key, value) => { scope.tags[key] = value; },
          setExtras: () => undefined,
          setFingerprint: (value) => { scope.fingerprint = value; },
          setLevel: () => undefined,
        });
      },
      captureException: (error) => { captured.push({ title: (error as Error).message, fingerprint: scope.fingerprint, tags: scope.tags }); },
      addBreadcrumb: () => undefined,
      logger: { warn: () => undefined, error: () => undefined },
    });
    const events: AgentChatEventEnvelope[] = [];
    const harness = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
    const session = await harness.service.createSession({
      laneId: "lane-1", provider: "copilot", model: "auto", modelId: "github-copilot/auto",
    } as never);
    const dones = () => events.filter((envelope) => envelope.event.type === "done");
    await harness.service.sendMessage({ sessionId: session.id, text: "open the runtime" });
    await waitFor(() => dones().length === 1);
    expect(captured, "a clean first turn reports nothing").toHaveLength(0);
    const pooled = mockState.copilotPooled;
    pooled.send.mockImplementation(async (chatId: string) => {
      if ("sendError" in trigger) throw trigger.sendError;
      queueMicrotask(() => {
        pooled.bridge.onEvent?.(chatId, { type: "session.error", data: trigger.sessionError });
        pooled.bridge.onEvent?.(chatId, { type: "session.idle", data: {} });
      });
      return "copilot-message-2";
    });

    await harness.service.sendMessage({ sessionId: session.id, text: "fix the login bug" });
    await waitFor(() => dones().length === 2);

    expect((dones()[1]!.event as { status: string }).status).toBe("failed");
    if (!expected) {
      expect(captured).toHaveLength(0);
      return;
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ title: expected.title, fingerprint: [...expected.fingerprint] });
    expect(captured[0]!.tags).toMatchObject({ provider: "copilot" });
    expect(captured[0]!.title).not.toContain("login bug");
  });
});
