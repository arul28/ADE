import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { createOpenclawBridgeService } from "./openclawBridgeService";

function writeOpenclawConfig(adeDir: string, patch: Record<string, unknown>): void {
  fs.mkdirSync(adeDir, { recursive: true });
  fs.writeFileSync(
    path.join(adeDir, "local.secret.yaml"),
    YAML.stringify({
      openclaw: {
        bridgePort: 0,
        hooksToken: "test-hook-token",
        ...patch,
      },
    }),
    "utf8",
  );
}

describe("openclawBridgeService", () => {
  const services: Array<ReturnType<typeof createOpenclawBridgeService>> = [];

  afterEach(async () => {
    while (services.length) {
      const service = services.pop();
      await service?.stop();
    }
  });

  it("handles synchronous query replies end to end", async () => {
    const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-query-"));
    writeOpenclawConfig(adeDir, { enabled: false });

    let service!: ReturnType<typeof createOpenclawBridgeService>;
    const sentMessages: Array<{ sessionId: string; text: string; displayText?: string }> = [];
    const agentChatService = {
      listSessions: vi.fn(async () => []),
      ensureIdentitySession: vi.fn(async () => ({ id: "session-cto", laneId: "lane-1" })),
      sendMessage: vi.fn(async ({ sessionId, text, displayText }: { sessionId: string; text: string; displayText?: string }) => {
        sentMessages.push({ sessionId, text, displayText });
        const turnId = "turn-1";
        queueMicrotask(() => {
          service.onAgentChatEvent({
            sessionId,
            timestamp: new Date().toISOString(),
            event: { type: "user_message", text: displayText ?? text, turnId },
          });
          service.onAgentChatEvent({
            sessionId,
            timestamp: new Date().toISOString(),
            event: { type: "text", text: "CTO reply from ADE", turnId },
          });
          service.onAgentChatEvent({
            sessionId,
            timestamp: new Date().toISOString(),
            event: { type: "done", turnId, status: "completed" },
          });
        });
      }),
    } as any;

    service = createOpenclawBridgeService({
      projectRoot: "/tmp/project",
      adeDir,
      laneService: {
        list: vi.fn(async () => [{ id: "lane-1" }]),
      } as any,
      agentChatService,
      ctoStateService: {
        getIdentity: vi.fn(() => ({
          openclawContextPolicy: { shareMode: "filtered", blockedCategories: ["secret"] },
        })),
      } as any,
    });
    services.push(service);
    await service.start();

    const state = service.getState();
    const res = await fetch(state.endpoints.queryUrl!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-hook-token",
      },
      body: JSON.stringify({
        requestId: "req-query-1",
        agentId: "discord-cto",
        sessionKey: "discord:thread:123",
        message: "What changed?",
        context: { channel: "discord", secret: "redact-me" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBe("CTO reply from ADE");
    expect(agentChatService.ensureIdentitySession).toHaveBeenCalledWith(
      expect.objectContaining({ identityKey: "cto", laneId: "lane-1" }),
    );
    expect(sentMessages[0]?.text).toContain("Treat this routing context as turn-scoped bridge metadata only.");
    expect(sentMessages[0]?.text).toContain("What changed?");
  });

  it("routes worker targets by slug and falls back unknown targets to CTO", async () => {
    const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-target-"));
    writeOpenclawConfig(adeDir, { enabled: false, allowEmployeeTargets: true });

    let service!: ReturnType<typeof createOpenclawBridgeService>;
    const ensureIdentitySession = vi.fn(async ({ identityKey }: { identityKey: string }) => ({
      id: identityKey === "cto" ? "session-cto" : "session-worker",
      laneId: "lane-1",
    }));
    const sendMessage = vi.fn(async ({ sessionId, text, displayText }: { sessionId: string; text: string; displayText?: string }) => {
      const turnId = sessionId === "session-worker" ? "turn-worker" : "turn-cto";
      queueMicrotask(() => {
        service.onAgentChatEvent({
          sessionId,
          timestamp: new Date().toISOString(),
          event: { type: "user_message", text: displayText ?? text, turnId },
        });
        service.onAgentChatEvent({
          sessionId,
          timestamp: new Date().toISOString(),
          event: { type: "text", text: sessionId === "session-worker" ? "worker reply" : "cto fallback reply", turnId },
        });
        service.onAgentChatEvent({
          sessionId,
          timestamp: new Date().toISOString(),
          event: { type: "done", turnId, status: "completed" },
        });
      });
    });

    service = createOpenclawBridgeService({
      projectRoot: "/tmp/project",
      adeDir,
      laneService: { list: vi.fn(async () => [{ id: "lane-1" }]) } as any,
      agentChatService: {
        listSessions: vi.fn(async () => []),
        ensureIdentitySession,
        sendMessage,
      } as any,
      workerAgentService: {
        listAgents: vi.fn(() => [
          { id: "worker-1", slug: "frontend", status: "active", deletedAt: null },
        ]),
      } as any,
      ctoStateService: {
        getIdentity: vi.fn(() => ({
          openclawContextPolicy: { shareMode: "filtered", blockedCategories: [] },
        })),
      } as any,
    });
    services.push(service);
    await service.start();

    const state = service.getState();
    const good = await fetch(state.endpoints.queryUrl!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-hook-token",
      },
      body: JSON.stringify({
        requestId: "req-good-target",
        message: "Ping frontend worker",
        targetHint: "agent:frontend",
      }),
    });
    expect(good.status).toBe(200);
    expect(ensureIdentitySession).toHaveBeenCalledWith(expect.objectContaining({ identityKey: "agent:worker-1" }));

    const fallback = await fetch(state.endpoints.queryUrl!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-hook-token",
      },
      body: JSON.stringify({
        requestId: "req-bad-target",
        message: "Ping unknown worker",
        targetHint: "agent:ghost",
      }),
    });
    expect(fallback.status).toBe(200);
    const latestInbound = service.listMessages(4).find((entry) => entry.requestId === "req-bad-target" && entry.direction === "inbound");
    expect(latestInbound?.resolvedTarget).toBe("cto");
    expect(latestInbound?.metadata).toEqual(expect.objectContaining({
      fallbackReason: expect.stringContaining("ghost"),
    }));
  });

  it("deduplicates async hook requests by idempotency key", async () => {
    const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-hook-"));
    writeOpenclawConfig(adeDir, { enabled: false });

    let service!: ReturnType<typeof createOpenclawBridgeService>;
    const sendMessage = vi.fn(async ({ sessionId, text, displayText }: { sessionId: string; text: string; displayText?: string }) => {
      queueMicrotask(() => {
        service.onAgentChatEvent({
          sessionId,
          timestamp: new Date().toISOString(),
          event: { type: "user_message", text: displayText ?? text, turnId: "turn-hook" },
        });
      });
    });

    service = createOpenclawBridgeService({
      projectRoot: "/tmp/project",
      adeDir,
      laneService: { list: vi.fn(async () => [{ id: "lane-1" }]) } as any,
      agentChatService: {
        listSessions: vi.fn(async () => []),
        ensureIdentitySession: vi.fn(async () => ({ id: "session-cto", laneId: "lane-1" })),
        sendMessage,
      } as any,
      ctoStateService: {
        getIdentity: vi.fn(() => ({
          openclawContextPolicy: { shareMode: "filtered", blockedCategories: [] },
        })),
      } as any,
    });
    services.push(service);
    await service.start();

    const state = service.getState();
    const request = {
      requestId: "dup-key-1",
      message: "Fire and forget",
    };
    const first = await fetch(state.endpoints.hookUrl!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-hook-token",
      },
      body: JSON.stringify(request),
    });
    const second = await fetch(state.endpoints.hookUrl!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-hook-token",
      },
      body: JSON.stringify(request),
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(await second.json()).toEqual(expect.objectContaining({ duplicate: true }));
  });

  it("queues outbound messages when the operator socket is unavailable", async () => {
    const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-outbox-"));
    writeOpenclawConfig(adeDir, { enabled: false });

    const service = createOpenclawBridgeService({
      projectRoot: "/tmp/project",
      adeDir,
      laneService: { list: vi.fn(async () => [{ id: "lane-1" }]) } as any,
      agentChatService: {
        listSessions: vi.fn(async () => []),
        ensureIdentitySession: vi.fn(async () => ({ id: "session-cto", laneId: "lane-1" })),
        sendMessage: vi.fn(async () => {}),
      } as any,
      ctoStateService: {
        getIdentity: vi.fn(() => ({
          openclawContextPolicy: { shareMode: "filtered", blockedCategories: ["secret"] },
        })),
      } as any,
    });
    services.push(service);
    await service.start();

    const record = await service.sendMessage({
      requestId: "queued-message-1",
      agentId: "discord-cto",
      message: "Mission finished",
      context: { secret: "hide-me", lane: "lane-1" },
    });

    expect(record.status).toBe("queued");
    expect(service.getState().status.queuedMessages).toBe(1);
    expect(record.context).toEqual({ lane: "lane-1" });
  });
});
