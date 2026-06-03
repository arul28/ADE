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
  });

  it("accepts signed GitHub issue label webhooks and dispatches canonical issue triggers", async () => {
    const updates: Array<Record<string, unknown>> = [];
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
});
