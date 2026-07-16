import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type ClientOptions } from "ws";
import type { AutomationIngressEventRecord } from "../../../shared/types";
import {
  createAutomationIngressService,
  GITHUB_RELAY_CONNECTED_SAFETY_POLL_MS,
  GITHUB_RELAY_MIN_POLL_INTERVAL_MS,
  type AutomationIngressService,
} from "./automationIngressService";

const receivedAt = "2026-06-02T00:00:00.000Z";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

class MockRelayWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
  });
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006, Buffer.alloc(0));
  });

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  receive(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }

  serverClose(code = 4401): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from("subscription expired"));
  }
}

function makeWebSocketHarness() {
  const sockets: MockRelayWebSocket[] = [];
  const factory = vi.fn((_: string, _options: ClientOptions) => {
    const socket = new MockRelayWebSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { sockets, factory };
}

describe("automationIngressService", () => {
  let service: AutomationIngressService | null = null;

  afterEach(() => {
    service?.dispose();
    service = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accepts signed GitHub issue label webhooks and dispatches canonical issue triggers", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const ingestGithubWebhook = vi.fn(async () => ({
      processed: true,
      duplicate: false,
      repoOwner: "arul28",
      repoName: "ADE",
      githubPrNumber: null,
      linkedPrIds: [],
      reason: null,
    }));
    const dispatchIngressTrigger = vi.fn(async (args: Record<string, unknown>): Promise<AutomationIngressEventRecord> => ({
      id: "ingress-event-1",
      source: "local-webhook",
      eventKey: String(args.eventKey),
      automationIds: ["smoke-github-label-webhook-gate"],
      triggerType: "github.issue_labeled",
      eventName: "issues",
      status: "dispatched",
      summary: typeof args.summary === "string" ? args.summary : null,
      errorMessage: null,
      cursor: null,
      receivedAt,
    }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: {
        updateIngressStatus: (patch: Record<string, unknown>) => updates.push(patch),
        dispatchIngressTrigger,
        getIngressStatus: () => ({}),
      } as never,
      prService: { ingestGithubWebhook } as never,
      secretService: {
        getSecret: (ref: string) => ref === "automations.githubWebhook.secret" ? "github-secret" : null,
      } as never,
      listRules: () => [],
    });

    await service.start();
    const localStatus = updates
      .map((entry) => entry.localWebhook)
      .find((entry): entry is { port: number } => Boolean(entry && typeof (entry as { port?: unknown }).port === "number"));
    expect(localStatus?.port).toBeGreaterThan(0);

    const body = JSON.stringify({
      action: "labeled",
      repository: { full_name: "arul28/ADE" },
      sender: { login: "octocat" },
      label: { name: "ade-webhook-smoke" },
      issue: {
        number: 75,
        title: "Smoke webhook issue",
        body: "Webhook body",
        html_url: "https://github.com/arul28/ADE/issues/75",
        user: { login: "octocat" },
        labels: [{ name: "ade-webhook-smoke" }],
      },
    });
    const signature = `sha256=${createHmac("sha256", "github-secret").update(Buffer.from(body)).digest("hex")}`;

    const response = await fetch(`http://127.0.0.1:${localStatus!.port}/github-webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": signature,
      },
      body,
    });

    expect(response.status).toBe(202);
    expect(ingestGithubWebhook).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "issues",
      deliveryId: "delivery-1",
      payload: expect.objectContaining({
        repository: expect.objectContaining({ full_name: "arul28/ADE" }),
      }),
    }));
    expect(dispatchIngressTrigger).toHaveBeenCalledWith(expect.objectContaining({
      source: "local-webhook",
      eventKey: "github:delivery-1:github.issue_labeled",
      triggerType: "github.issue_labeled",
      eventName: "issues",
      repo: "arul28/ADE",
      labels: ["ade-webhook-smoke"],
      author: "octocat",
      issue: expect.objectContaining({
        number: 75,
        title: "Smoke webhook issue",
        repo: "arul28/ADE",
        labels: ["ade-webhook-smoke"],
      }),
    }));
  });

  it("polls GitHub relay events with the stored cursor and fans PR payloads into the PR cache", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const cursors = new Map<string, string | null>([["github-relay", "delivery-1"]]);
    const ingestGithubWebhook = vi.fn(async () => ({
      processed: true,
      duplicate: false,
      repoOwner: "arul28",
      repoName: "ADE",
      githubPrNumber: 42,
      linkedPrIds: [],
      reason: null,
    }));
    const dispatchIngressTrigger = vi.fn(async (args: Record<string, unknown>): Promise<AutomationIngressEventRecord> => ({
      id: "ingress-event-2",
      source: "github-relay",
      eventKey: String(args.eventKey),
      automationIds: [],
      triggerType: "github-webhook",
      eventName: "pull_request",
      status: "dispatched",
      summary: typeof args.summary === "string" ? args.summary : null,
      errorMessage: null,
      cursor: typeof args.cursor === "string" ? args.cursor : null,
      receivedAt,
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      events: [
        {
          cursor: "seq:2",
          eventId: "delivery-2",
          githubEvent: "pull_request",
          summary: "GitHub pull_request · synchronize · arul28/ADE · #42",
          createdAt: receivedAt,
          payload: {
            action: "synchronize",
            repository: { full_name: "arul28/ADE" },
            pull_request: {
              number: 42,
              title: "Wire webhook relay",
              html_url: "https://github.com/arul28/ADE/pull/42",
              head: { ref: "feature/webhooks" },
              base: { ref: "main" },
            },
          },
        },
      ],
      nextCursor: "seq:2",
    }), { headers: { "content-type": "application/json" } }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: {
        updateIngressStatus: (patch: Record<string, unknown>) => updates.push(patch),
        dispatchIngressTrigger,
        getIngressCursor: (source: string) => cursors.get(source) ?? null,
        setIngressCursor: ({ source, cursor }: { source: string; cursor: string | null }) => {
          cursors.set(source, cursor);
        },
        getIngressStatus: () => ({}),
      } as never,
      prService: { ingestGithubWebhook } as never,
      secretService: {
        getSecret: (ref: string) => {
          if (ref === "automations.githubRelay.apiBaseUrl") return "https://relay.example.com/";
          if (ref === "automations.githubRelay.remoteProjectId") return "project 1";
          if (ref === "automations.githubRelay.accessToken") return "relay-token";
          return null;
        },
      } as never,
      getAccountAccessToken: vi.fn(async () => "clerk-account-token"),
      listRules: () => [],
    });

    await service.pollNow();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://relay.example.com/projects/project%201/github/events?after=delivery-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer ade_proj_[0-9a-f]{64}$/),
        }),
      }),
    );
    const headers = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-ade-account-token")).toBeNull();
    expect(ingestGithubWebhook).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "pull_request",
      deliveryId: "delivery-2",
      payload: expect.objectContaining({
        repository: expect.objectContaining({ full_name: "arul28/ADE" }),
      }),
    }));
    expect(dispatchIngressTrigger).toHaveBeenCalledWith(expect.objectContaining({
      source: "github-relay",
      eventKey: "delivery-2",
      cursor: "seq:2",
      rawPayload: expect.objectContaining({
        pull_request: expect.objectContaining({ number: 42 }),
      }),
    }));
    expect(cursors.get("github-relay")).toBe("seq:2");
    expect(updates).toContainEqual(expect.objectContaining({
      githubRelay: expect.objectContaining({
        healthy: true,
        status: "ready",
        lastCursor: "seq:2",
      }),
    }));
  });

  it("still ingests relay PR webhooks when the automations feature is unavailable", async () => {
    const webSockets = makeWebSocketHarness();
    const cursors = new Map<string, string | null>();
    const onPrStateIngested = vi.fn();
    const ingestGithubWebhook = vi.fn(async () => ({
      processed: true,
      duplicate: false,
      repoOwner: "arul28",
      repoName: "ADE",
      githubPrNumber: 687,
      linkedPrIds: ["pr-687"],
      reason: null,
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      events: [
        {
          cursor: "seq:3",
          eventId: "delivery-3",
          githubEvent: "pull_request",
          summary: "GitHub pull_request · closed · arul28/ADE · #687",
          createdAt: receivedAt,
          payload: {
            action: "closed",
            repository: { full_name: "arul28/ADE" },
            pull_request: { number: 687, title: "Github Auth Checks Failed", merged: true },
          },
        },
      ],
      nextCursor: "seq:3",
    }), { headers: { "content-type": "application/json" } }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: null,
      prService: { ingestGithubWebhook } as never,
      secretService: {
        getSecret: () => null,
      } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay: vi.fn(async () => "ghu_app_user_token"),
      },
      onPrStateIngested,
      listRules: () => [],
      ingressCursorStore: {
        get: (source) => cursors.get(source) ?? null,
        set: ({ source, cursor }) => {
          cursors.set(source, cursor);
        },
      },
      webSocketFactory: webSockets.factory,
    });

    // start() must not bind the local automation webhook server in this mode.
    await service.start();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/arul28/ADE/events?order=asc&limit=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer ghu_app_user_token",
        }),
      }),
    );
    expect(ingestGithubWebhook).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "pull_request",
      deliveryId: "delivery-3",
      payload: expect.objectContaining({
        pull_request: expect.objectContaining({ number: 687 }),
      }),
    }));
    expect(onPrStateIngested).toHaveBeenCalledTimes(1);
    expect(webSockets.factory).toHaveBeenCalledWith(
      "wss://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/arul28/ADE/subscribe",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer ghu_app_user_token" }),
      }),
    );
    expect(cursors.get("github-relay")).toBe("seq:3");
    expect(service.getStatus()).toBeNull();
    expect(service.listRecentEvents()).toEqual([]);
  });

  it("refuses construction without cursor persistence when automations are unavailable", () => {
    expect(() => createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: null,
      prService: { ingestGithubWebhook: vi.fn() } as never,
      secretService: { getSecret: () => null } as never,
      listRules: () => [],
    })).toThrowError(/ingressCursorStore/);
  });

  it("treats missing GitHub App authorization as quiet auth-pending, not a per-tick error", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const webSockets = makeWebSocketHarness();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const getAppUserTokenForRelay = vi.fn(async () => {
      throw new Error("Authorize the ADE GitHub App with GitHub before using the hosted relay.");
    });

    service = createAutomationIngressService({
      logger: logger as never,
      automationService: null,
      prService: { ingestGithubWebhook: vi.fn() } as never,
      secretService: {
        getSecret: () => null,
      } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay,
      },
      listRules: () => [],
      ingressCursorStore: {
        get: () => null,
        set: () => {},
      },
      pollIntervalMs: GITHUB_RELAY_MIN_POLL_INTERVAL_MS,
      webSocketFactory: webSockets.factory,
    });

    await service.start();
    expect(getAppUserTokenForRelay).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("automations.github_relay_auth_pending", expect.objectContaining({
      error: expect.stringContaining("Authorize the ADE GitHub App"),
    }));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webSockets.factory).not.toHaveBeenCalled();

    // Scheduled re-entry inside the cooldown window skips the token attempt.
    await vi.advanceTimersByTimeAsync(GITHUB_RELAY_MIN_POLL_INTERVAL_MS);
    expect(getAppUserTokenForRelay).toHaveBeenCalledTimes(1);

    // Explicit pollNow (e.g. right after authorizing) bypasses the cooldown
    // and the transition log fires only once.
    await service.pollNow();
    expect(getAppUserTokenForRelay).toHaveBeenCalledTimes(2);
    const authPendingLogs = (logger.info.mock.calls as unknown[][])
      .filter((call) => call[0] === "automations.github_relay_auth_pending");
    expect(authPendingLogs).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("can read GitHub relay config from runtime environment variables", async () => {
    const previousApiBase = process.env.ADE_GITHUB_RELAY_API_BASE_URL;
    const previousProjectId = process.env.ADE_GITHUB_RELAY_REMOTE_PROJECT_ID;
    const previousToken = process.env.ADE_GITHUB_RELAY_ACCESS_TOKEN;
    process.env.ADE_GITHUB_RELAY_API_BASE_URL = "https://relay-env.example.com/";
    process.env.ADE_GITHUB_RELAY_REMOTE_PROJECT_ID = "project-env";
    process.env.ADE_GITHUB_RELAY_ACCESS_TOKEN = "relay-token-env";

    try {
      const updates: Array<Record<string, unknown>> = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
        events: [],
      }), { headers: { "content-type": "application/json" } }));

      service = createAutomationIngressService({
        logger: makeLogger() as never,
        automationService: {
          updateIngressStatus: (patch: Record<string, unknown>) => updates.push(patch),
          dispatchIngressTrigger: vi.fn(),
          getIngressCursor: () => null,
          setIngressCursor: vi.fn(),
          getIngressStatus: () => ({}),
        } as never,
        secretService: {
          getSecret: () => null,
        } as never,
        listRules: () => [],
      });

      await service.pollNow();

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://relay-env.example.com/projects/project-env/github/events",
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: expect.stringMatching(/^Bearer ade_proj_[0-9a-f]{64}$/),
          }),
        }),
      );
      expect(updates).toContainEqual(expect.objectContaining({
        githubRelay: expect.objectContaining({
          configured: true,
          apiBaseUrl: "https://relay-env.example.com/",
          remoteProjectId: "project-env",
          status: "polling",
        }),
      }));
    } finally {
      if (previousApiBase === undefined) delete process.env.ADE_GITHUB_RELAY_API_BASE_URL;
      else process.env.ADE_GITHUB_RELAY_API_BASE_URL = previousApiBase;
      if (previousProjectId === undefined) delete process.env.ADE_GITHUB_RELAY_REMOTE_PROJECT_ID;
      else process.env.ADE_GITHUB_RELAY_REMOTE_PROJECT_ID = previousProjectId;
      if (previousToken === undefined) delete process.env.ADE_GITHUB_RELAY_ACCESS_TOKEN;
      else process.env.ADE_GITHUB_RELAY_ACCESS_TOKEN = previousToken;
    }
  });

  it("refuses to poll the hosted repo relay without GitHub App user authorization", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      events: [],
      nextCursor: null,
    }), { headers: { "content-type": "application/json" } }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: {
        updateIngressStatus: (patch: Record<string, unknown>) => updates.push(patch),
        dispatchIngressTrigger: vi.fn(),
        getIngressCursor: () => null,
        setIngressCursor: vi.fn(),
        getIngressStatus: () => ({}),
      } as never,
      secretService: {
        getSecret: () => null,
      } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay: vi.fn(async () => {
          throw new Error("Authorize the ADE GitHub App with GitHub before using the hosted relay.");
        }),
      },
      listRules: () => [],
    });

    await service.pollNow();

    expect(fetchSpy).not.toHaveBeenCalled();
    // Missing authorization is an idle "disabled" state (quiet auth-pending
    // cooldown), not a recurring error.
    expect(updates).toContainEqual(expect.objectContaining({
      githubRelay: expect.objectContaining({
        healthy: false,
        status: "disabled",
        lastError: "Authorize the ADE GitHub App with GitHub before using the hosted relay.",
      }),
    }));
  });

  it("polls the hosted repo relay with only the signed-in account credential", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      events: [],
      nextCursor: null,
    }), { headers: { "content-type": "application/json" } }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: {
        updateIngressStatus: vi.fn(),
        dispatchIngressTrigger: vi.fn(),
        getIngressCursor: () => null,
        setIngressCursor: vi.fn(),
        getIngressStatus: () => ({}),
      } as never,
      secretService: { getSecret: () => null } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay: vi.fn(async () => {
          throw new Error("GitHub App user auth is absent on this machine.");
        }),
      },
      getAccountAccessToken: vi.fn(async () => "clerk-account-token"),
      listRules: () => [],
    });

    await service.pollNow();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/arul28/ADE/events?order=asc&limit=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-ade-account-token": "clerk-account-token",
        }),
      }),
    );
    const headers = (fetchSpy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("polls the hosted repo relay with a GitHub App user token", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      events: [],
      nextCursor: null,
    }), { headers: { "content-type": "application/json" } }));
    const getAppUserTokenForRelay = vi.fn(async () => "ghu_app_user_token");

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: {
        updateIngressStatus: (patch: Record<string, unknown>) => updates.push(patch),
        dispatchIngressTrigger: vi.fn(),
        getIngressCursor: () => null,
        setIngressCursor: vi.fn(),
        getIngressStatus: () => ({}),
      } as never,
      secretService: {
        getSecret: () => null,
      } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay,
      },
      listRules: () => [],
    });

    await service.pollNow();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/arul28/ADE/events?order=asc&limit=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer ghu_app_user_token",
        }),
      }),
    );
    expect(getAppUserTokenForRelay).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual(expect.objectContaining({
      githubRelay: expect.objectContaining({
        configured: true,
        apiBaseUrl: "https://ade-github-webhook-relay.arulsharma1028.workers.dev",
        remoteProjectId: "arul28/ADE",
        status: "polling",
      }),
    }));
  });

  it("queues one rerun when a GitHub relay poll is requested in flight", async () => {
    const fetchResolvers: Array<(response: Response) => void> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => {
      fetchResolvers.push(resolve);
    }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: {
        updateIngressStatus: vi.fn(),
        dispatchIngressTrigger: vi.fn(),
        getIngressCursor: () => "seq:2",
        setIngressCursor: vi.fn(),
        getIngressStatus: () => ({}),
      } as never,
      secretService: {
        getSecret: (ref: string) => {
          if (ref === "automations.githubRelay.apiBaseUrl") return "https://relay.example.com/";
          if (ref === "automations.githubRelay.remoteProjectId") return "project 1";
          if (ref === "automations.githubRelay.accessToken") return "relay-token";
          return null;
        },
      } as never,
      listRules: () => [],
    });

    const firstPoll = service.pollNow();
    const secondPoll = service.pollNow();
    const thirdPoll = service.pollNow();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchResolvers[0]!(new Response(JSON.stringify({
      events: [],
      nextCursor: "seq:2",
    }), { headers: { "content-type": "application/json" } }));
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    fetchResolvers[1]!(new Response(JSON.stringify({
      events: [],
      nextCursor: "seq:2",
    }), { headers: { "content-type": "application/json" } }));
    await Promise.all([firstPoll, secondPoll, thirdPoll]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("drains hosted repo pages oldest-first and persists each completed page cursor", async () => {
    const cursors = new Map<string, string | null>([["github-relay", "seq:2"]]);
    const setIngressCursor = vi.fn(({ source, cursor }: { source: string; cursor: string | null }) => {
      cursors.set(source, cursor);
    });
    const dispatchOrder: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        events: [
          { cursor: "seq:3", eventId: "delivery-3", githubEvent: "pull_request", payload: {} },
          { cursor: "seq:4", eventId: "delivery-4", githubEvent: "pull_request", payload: {} },
        ],
        nextCursor: "seq:4",
        hasMore: true,
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        events: [
          { cursor: "seq:5", eventId: "delivery-5", githubEvent: "pull_request", payload: {} },
        ],
        nextCursor: "seq:5",
        hasMore: false,
      }), { headers: { "content-type": "application/json" } }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: {
        updateIngressStatus: vi.fn(),
        dispatchIngressTrigger: vi.fn(async ({ eventKey }: { eventKey: string }) => {
          dispatchOrder.push(eventKey);
        }),
        getIngressCursor: (source: string) => cursors.get(source) ?? null,
        setIngressCursor,
        getIngressStatus: () => ({}),
      } as never,
      secretService: { getSecret: () => null } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay: vi.fn(async () => "ghu_app_user_token"),
      },
      listRules: () => [],
    });

    await service.pollNow();

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/arul28/ADE/events?order=asc&limit=100&after=seq%3A2",
      expect.any(Object),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/arul28/ADE/events?order=asc&limit=100&after=seq%3A4",
      expect.any(Object),
    );
    expect(dispatchOrder).toEqual(["delivery-3", "delivery-4", "delivery-5"]);
    expect(setIngressCursor.mock.calls.map(([entry]) => entry.cursor)).toEqual(["seq:4", "seq:5"]);
    expect(cursors.get("github-relay")).toBe("seq:5");
  });

  it("does not advance the relay cursor when processing a page fails", async () => {
    const logger = makeLogger();
    const setIngressCursor = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      events: [
        { cursor: "seq:3", eventId: "delivery-3", githubEvent: "pull_request", payload: {} },
        { cursor: "seq:4", eventId: "delivery-4", githubEvent: "pull_request", payload: {} },
      ],
      nextCursor: "seq:4",
      hasMore: false,
    }), { headers: { "content-type": "application/json" } }));
    const dispatchIngressTrigger = vi.fn(async ({ eventKey }: { eventKey: string }) => {
      if (eventKey === "delivery-4") throw new Error("dispatch failed");
    });

    service = createAutomationIngressService({
      logger: logger as never,
      automationService: {
        updateIngressStatus: vi.fn(),
        dispatchIngressTrigger,
        getIngressCursor: () => "seq:2",
        setIngressCursor,
        getIngressStatus: () => ({}),
      } as never,
      secretService: { getSecret: () => null } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay: vi.fn(async () => "ghu_app_user_token"),
      },
      listRules: () => [],
    });

    await service.pollNow();

    expect(dispatchIngressTrigger).toHaveBeenCalledTimes(2);
    expect(setIngressCursor).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("automations.github_relay_poll_failed", {
      error: "dispatch failed",
    });
  });

  it("polls immediately for subscription wake-up frames", async () => {
    const webSockets = makeWebSocketHarness();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }), {
        headers: { "content-type": "application/json" },
      }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: null,
      secretService: { getSecret: () => null } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay: vi.fn(async () => "ghu_app_user_token"),
      },
      listRules: () => [],
      ingressCursorStore: { get: () => null, set: () => {} },
      webSocketFactory: webSockets.factory,
    });

    await service.start();
    expect(webSockets.sockets).toHaveLength(1);
    webSockets.sockets[0]!.open();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    webSockets.sockets[0]!.receive({ t: "github_delivery", repo: "arul28/ADE" });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
  });

  it("opens the repo subscription with the signed-in account credential", async () => {
    const webSockets = makeWebSocketHarness();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }), {
        headers: { "content-type": "application/json" },
      }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: null,
      secretService: { getSecret: () => null } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay: vi.fn(async () => {
          throw new Error("GitHub App user auth is absent on this machine.");
        }),
      },
      getAccountAccessToken: vi.fn(async () => "clerk-account-token"),
      listRules: () => [],
      ingressCursorStore: { get: () => null, set: () => {} },
      webSocketFactory: webSockets.factory,
    });

    await service.start();

    expect(webSockets.sockets).toHaveLength(1);
    expect(webSockets.factory).toHaveBeenCalledWith(
      "wss://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/arul28/ADE/subscribe",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-ade-account-token": "clerk-account-token" }),
      }),
    );
    const options = webSockets.factory.mock.calls[0]?.[1];
    expect(options?.headers).not.toHaveProperty("authorization");
  });

  it("reconnects with fresh auth and catch-up polls after each socket opens", async () => {
    const logger = makeLogger();
    const webSockets = makeWebSocketHarness();
    let tokenNumber = 0;
    const getAppUserTokenForRelay = vi.fn(async () => `ghu_token_${++tokenNumber}`);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }), {
        headers: { "content-type": "application/json" },
      }));

    service = createAutomationIngressService({
      logger: logger as never,
      automationService: null,
      secretService: { getSecret: () => null } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay,
      },
      listRules: () => [],
      ingressCursorStore: { get: () => null, set: () => {} },
      webSocketFactory: webSockets.factory,
      random: () => 0,
    });

    await service.start();
    webSockets.sockets[0]!.open();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    webSockets.sockets[0]!.serverClose();
    await vi.waitFor(() => expect(webSockets.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
    webSockets.sockets[1]!.open();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4));

    expect(getAppUserTokenForRelay.mock.calls.length).toBeGreaterThanOrEqual(4);
    const subscriptionStates = logger.info.mock.calls
      .filter(([event]) => event === "automations.github_relay_subscription_state")
      .map(([, data]) => data?.state);
    expect(subscriptionStates).toEqual(["connected", "disconnected", "connected"]);
  });

  it("stretches polling while connected and restores the configured interval on close", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const webSockets = makeWebSocketHarness();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }), {
        headers: { "content-type": "application/json" },
      }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: null,
      secretService: { getSecret: () => null } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay: vi.fn(async () => "ghu_app_user_token"),
      },
      listRules: () => [],
      ingressCursorStore: { get: () => null, set: () => {} },
      pollIntervalMs: GITHUB_RELAY_MIN_POLL_INTERVAL_MS,
      webSocketFactory: webSockets.factory,
    });

    await service.start();
    expect(setIntervalSpy.mock.calls.at(-1)?.[1]).toBe(GITHUB_RELAY_MIN_POLL_INTERVAL_MS);
    webSockets.sockets[0]!.open();
    expect(setIntervalSpy.mock.calls.at(-1)?.[1]).toBe(GITHUB_RELAY_CONNECTED_SAFETY_POLL_MS);
    webSockets.sockets[0]!.serverClose();
    expect(setIntervalSpy.mock.calls.at(-1)?.[1]).toBe(GITHUB_RELAY_MIN_POLL_INTERVAL_MS);
  });

  it("closes the subscription and clears all timers on stop", async () => {
    vi.useFakeTimers();
    const webSockets = makeWebSocketHarness();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }), {
        headers: { "content-type": "application/json" },
      }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: null,
      secretService: { getSecret: () => null } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay: vi.fn(async () => "ghu_app_user_token"),
      },
      listRules: () => [],
      ingressCursorStore: { get: () => null, set: () => {} },
      pollIntervalMs: GITHUB_RELAY_MIN_POLL_INTERVAL_MS,
      webSocketFactory: webSockets.factory,
    });

    await service.start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    service.stop();

    expect(webSockets.sockets[0]!.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the repo subscription when relay config switches to the legacy route", async () => {
    const webSockets = makeWebSocketHarness();
    const secrets = new Map<string, string>();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ events: [], nextCursor: null }), {
        headers: { "content-type": "application/json" },
      }));

    service = createAutomationIngressService({
      logger: makeLogger() as never,
      automationService: null,
      secretService: { getSecret: (ref: string) => secrets.get(ref) ?? null } as never,
      githubService: {
        detectRepo: vi.fn(async () => ({ owner: "arul28", name: "ADE" })),
        getAppUserTokenForRelay: vi.fn(async () => "ghu_app_user_token"),
      },
      listRules: () => [],
      ingressCursorStore: { get: () => null, set: () => {} },
      webSocketFactory: webSockets.factory,
    });

    await service.start();
    expect(webSockets.sockets).toHaveLength(1);
    secrets.set("automations.githubRelay.apiBaseUrl", "https://relay.example.com");
    secrets.set("automations.githubRelay.remoteProjectId", "project-1");
    secrets.set("automations.githubRelay.accessToken", "relay-token");
    await service.pollNow();

    expect(webSockets.sockets[0]!.close).toHaveBeenCalledTimes(1);
    expect(webSockets.sockets).toHaveLength(1);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://relay.example.com/projects/project-1/github/events",
      expect.any(Object),
    );
  });
});
