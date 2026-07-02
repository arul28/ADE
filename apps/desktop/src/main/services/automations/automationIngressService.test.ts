import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationIngressEventRecord } from "../../../shared/types";
import { createAutomationIngressService, type AutomationIngressService } from "./automationIngressService";

const receivedAt = "2026-06-02T00:00:00.000Z";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("automationIngressService", () => {
  let service: AutomationIngressService | null = null;

  afterEach(() => {
    service?.dispose();
    service = null;
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

  it("polls the hosted repo relay with the existing GitHub token when no relay secret is configured", async () => {
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
        getTokenOrThrow: vi.fn(() => "ghp_user_token"),
      },
      listRules: () => [],
    });

    await service.pollNow();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/arul28/ADE/events",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer ghp_user_token",
        }),
      }),
    );
    expect(updates).toContainEqual(expect.objectContaining({
      githubRelay: expect.objectContaining({
        configured: true,
        apiBaseUrl: "https://ade-github-webhook-relay.arulsharma1028.workers.dev",
        remoteProjectId: "arul28/ADE",
        status: "polling",
      }),
    }));
  });

  it("deduplicates overlapping GitHub relay polls", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
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

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch(new Response(JSON.stringify({
      events: [],
      nextCursor: "seq:2",
    }), { headers: { "content-type": "application/json" } }));
    await Promise.all([firstPoll, secondPoll]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
