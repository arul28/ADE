import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import type { AutomationIngressEventRecord, AutomationIngressSource, AutomationRule } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createAutomationService } from "./automationService";
import type { AutomationSecretService } from "./automationSecretService";

type AutomationIngressServiceArgs = {
  logger: Logger;
  automationService: ReturnType<typeof createAutomationService>;
  secretService: AutomationSecretService;
  listRules: () => AutomationRule[];
  pollIntervalMs?: number;
};

const GITHUB_RELAY_API_BASE_REF = "automations.githubRelay.apiBaseUrl";
const GITHUB_RELAY_PROJECT_REF = "automations.githubRelay.remoteProjectId";
const GITHUB_RELAY_TOKEN_REF = "automations.githubRelay.accessToken";

function safeCompareSignature(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
        return (entry as { name: string }).name.trim();
      }
      return "";
    })
    .filter(Boolean);
}

export function createAutomationIngressService(args: AutomationIngressServiceArgs) {
  let server: http.Server | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  const updateStatus = (source: AutomationIngressSource, patch: Record<string, unknown>) => {
    args.automationService.updateIngressStatus({
      githubRelay: source === "github-relay" ? patch as never : undefined,
      localWebhook: source === "local-webhook" ? patch as never : undefined,
    });
  };

  const buildGithubRelayConfig = () => {
    const apiBaseUrl = args.secretService.getSecret(GITHUB_RELAY_API_BASE_REF);
    const remoteProjectId = args.secretService.getSecret(GITHUB_RELAY_PROJECT_REF);
    const accessToken = args.secretService.getSecret(GITHUB_RELAY_TOKEN_REF);
    return {
      apiBaseUrl: apiBaseUrl?.trim() || null,
      remoteProjectId: remoteProjectId?.trim() || null,
      accessToken: accessToken?.trim() || null,
      configured: Boolean(apiBaseUrl && remoteProjectId && accessToken),
    };
  };

  const findTrigger = (automationId: string, type: "webhook" | "github-webhook") =>
    args.listRules()
      .find((rule) => rule.id === automationId)
      ?.triggers.find((trigger) => trigger.type === type);

  const dispatchLocalWebhook = async (automationId: string, payload: Record<string, unknown>, rawBody: Buffer): Promise<AutomationIngressEventRecord | null> => {
    const trigger = findTrigger(automationId, "webhook");
    if (!trigger?.secretRef?.trim()) {
      throw new Error(`Automation '${automationId}' is missing webhook secretRef.`);
    }
    const secret = args.secretService.getSecret(trigger.secretRef);
    if (!secret) {
      throw new Error(`Webhook secretRef '${trigger.secretRef}' could not be resolved.`);
    }
    const signature = String(payload.signatureHeader ?? payload.signature ?? "").trim();
    if (!signature.startsWith("sha256=")) {
      throw new Error("Missing x-ade-signature header.");
    }
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    if (!safeCompareSignature(expected, signature)) {
      throw new Error("Webhook signature mismatch.");
    }

    const summary = typeof payload.summary === "string"
      ? payload.summary
      : typeof payload.message === "string"
        ? payload.message
        : `Webhook ${typeof payload.event === "string" ? payload.event : "delivery"} received`;

    return await args.automationService.dispatchIngressTrigger({
      source: "local-webhook",
      eventKey:
        (typeof payload.deliveryId === "string" && payload.deliveryId.trim())
        || (typeof payload.eventId === "string" && payload.eventId.trim())
        || `${automationId}:${Date.now()}:${summary.slice(0, 64)}`,
      triggerType: "webhook",
      automationId,
      eventName: typeof payload.event === "string" ? payload.event : null,
      summary,
      author: typeof payload.author === "string" ? payload.author : null,
      labels: normalizeLabels(payload.labels),
      paths: normalizePathList(payload.paths),
      keywords: normalizePathList(payload.keywords),
      draftState: payload.draft === true ? "draft" : payload.draft === false ? "ready" : "any",
      rawPayload: payload,
    });
  };

  const handleWebhookRequest = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = /^\/automation-webhooks\/([^/]+)$/.exec(url.pathname);
    if (request.method !== "POST" || !match?.[1]) {
      response.writeHead(404).end("not found");
      return;
    }
    const automationId = decodeURIComponent(match[1]);
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", async () => {
      const body = Buffer.concat(chunks);
      try {
        const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        payload.signatureHeader = request.headers["x-ade-signature"] ?? "";
        const record = await dispatchLocalWebhook(automationId, payload, body);
        updateStatus("local-webhook", {
          healthy: true,
          status: "listening",
          lastDeliveryAt: record?.receivedAt ?? new Date().toISOString(),
          lastError: null,
        });
        response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, eventId: record?.id ?? null }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        args.logger.warn("automations.local_webhook_failed", { automationId, error: message });
        updateStatus("local-webhook", {
          healthy: false,
          status: "error",
          lastError: message,
        });
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: message }));
      }
    });
  };

  const pollGithubRelay = async () => {
    const config = buildGithubRelayConfig();
    updateStatus("github-relay", {
      configured: config.configured,
      apiBaseUrl: config.apiBaseUrl,
      remoteProjectId: config.remoteProjectId,
      status: config.configured ? "polling" : "disabled",
    });
    if (!config.configured) return;
    try {
      const response = await fetch(
        `${config.apiBaseUrl}/projects/${encodeURIComponent(config.remoteProjectId!)}/github/events`,
        {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${config.accessToken}`,
          },
        }
      );
      if (!response.ok) {
        throw new Error(`GitHub relay poll failed (${response.status})`);
      }
      const payload = await response.json() as { events?: Array<Record<string, unknown>> };
      const events = Array.isArray(payload.events) ? [...payload.events].reverse() : [];
      const cursor = args.automationService.getIngressCursor("github-relay");
      let lastSeenCursor = cursor;
      for (const event of events) {
        const eventId = typeof event.eventId === "string" ? event.eventId : "";
        if (!eventId || eventId === cursor) continue;
        const githubEvent = typeof event.githubEvent === "string" ? event.githubEvent : "pull_request";
        const summary = typeof event.summary === "string" ? event.summary : `GitHub ${githubEvent} event`;
        await args.automationService.dispatchIngressTrigger({
          source: "github-relay",
          eventKey: eventId,
          triggerType: "github-webhook",
          eventName: githubEvent,
          summary,
          cursor: eventId,
          keywords: summary.split(/\s+/g).filter(Boolean),
          rawPayload: event,
        });
        lastSeenCursor = eventId;
      }
      if (lastSeenCursor && lastSeenCursor !== cursor) {
        args.automationService.setIngressCursor({ source: "github-relay", cursor: lastSeenCursor });
      }
      updateStatus("github-relay", {
        healthy: true,
        status: "ready",
        lastPolledAt: new Date().toISOString(),
        lastCursor: lastSeenCursor,
        lastDeliveryAt: events.length ? String(events[events.length - 1]?.createdAt ?? new Date().toISOString()) : null,
        lastError: null,
      });
    } catch (error) {
      args.logger.warn("automations.github_relay_poll_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      updateStatus("github-relay", {
        healthy: false,
        status: "error",
        lastPolledAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    async start() {
      if (!server) {
        server = http.createServer((request, response) => {
          void handleWebhookRequest(request, response);
        });
        await new Promise<void>((resolve, reject) => {
          server!.once("error", reject);
          server!.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : null;
        updateStatus("local-webhook", {
          configured: true,
          healthy: true,
          listening: true,
          status: "listening",
          port,
          url: port ? `http://127.0.0.1:${port}/automation-webhooks/:automationId` : null,
          lastError: null,
        });
      }
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          void pollGithubRelay();
        }, Math.max(30_000, Math.floor(args.pollIntervalMs ?? 60_000)));
      }
      await pollGithubRelay();
    },

    getStatus() {
      return args.automationService.getIngressStatus();
    },

    listRecentEvents(limit = 20) {
      return args.automationService.listIngressEvents(limit);
    },

    async pollNow() {
      await pollGithubRelay();
    },

    dispose() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    },
  };
}

export type AutomationIngressService = ReturnType<typeof createAutomationIngressService>;
