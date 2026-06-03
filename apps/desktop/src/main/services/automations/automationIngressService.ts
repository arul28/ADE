import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import type { AutomationIngressEventRecord, AutomationIngressSource, AutomationRule, AutomationTriggerType } from "../../../shared/types";
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
const GITHUB_WEBHOOK_SECRET_REF = "automations.githubWebhook.secret";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeHeader(headers: Record<string, string | string[] | undefined>, key: string): string {
  const needle = key.toLowerCase();
  for (const [headerKey, headerValue] of Object.entries(headers)) {
    if (headerKey.toLowerCase() !== needle) continue;
    if (Array.isArray(headerValue)) return headerValue[0]?.trim() ?? "";
    return typeof headerValue === "string" ? headerValue.trim() : "";
  }
  return "";
}

function readString(source: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(source: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNested(source: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = source?.[key];
  return isRecord(value) ? value : null;
}

function readRepoName(payload: Record<string, unknown>): string | null {
  const repo = readNested(payload, "repository");
  return readString(repo, "full_name") ?? null;
}

function readUserLogin(source: Record<string, unknown> | null): string | undefined {
  return readString(readNested(source, "user"), "login");
}

function readLogin(source: Record<string, unknown> | null): string | undefined {
  return readString(source, "login") ?? readUserLogin(source);
}

function readHtmlUrl(source: Record<string, unknown> | null): string | undefined {
  return readString(source, "html_url");
}

function buildIssueContext(issue: Record<string, unknown> | null, repo: string | null) {
  const number = readNumber(issue, "number");
  const title = readString(issue, "title");
  if (!number || !title) return null;
  return {
    number,
    title,
    body: readString(issue, "body"),
    author: readUserLogin(issue),
    labels: normalizeLabels(issue?.labels),
    repo: repo ?? undefined,
    url: readHtmlUrl(issue),
  };
}

function buildPrContext(pr: Record<string, unknown> | null, repo: string | null) {
  const number = readNumber(pr, "number");
  const title = readString(pr, "title");
  if (!number || !title) return null;
  return {
    number,
    title,
    body: readString(pr, "body"),
    author: readUserLogin(pr),
    labels: normalizeLabels(pr?.labels),
    repo: repo ?? undefined,
    url: readHtmlUrl(pr),
    baseBranch: readString(readNested(pr, "base"), "ref"),
    headBranch: readString(readNested(pr, "head"), "ref"),
    draft: pr?.draft === true,
    merged: pr?.merged === true,
  };
}

function mapGithubWebhookToTrigger(githubEvent: string, payload: Record<string, unknown>): {
  triggerType: AutomationTriggerType;
  summary: string;
  author?: string;
  labels?: string[];
  branch?: string | null;
  targetBranch?: string | null;
  draftState?: "draft" | "ready" | "any";
  issue?: ReturnType<typeof buildIssueContext>;
  pr?: ReturnType<typeof buildPrContext>;
} | null {
  const action = readString(payload, "action") ?? "";
  const repo = readRepoName(payload);
  if (githubEvent === "issues") {
    const issue = buildIssueContext(readNested(payload, "issue"), repo);
    if (!issue) return null;
    const labeled = action === "labeled";
    const triggerType: AutomationTriggerType | null =
      action === "opened"
        ? "github.issue_opened"
        : action === "edited"
          ? "github.issue_edited"
          : action === "closed"
            ? "github.issue_closed"
            : labeled
              ? "github.issue_labeled"
              : null;
    if (!triggerType) return null;
    const addedLabel = readString(readNested(payload, "label"), "name");
    return {
      triggerType,
      summary: `GitHub issue #${issue.number} ${action}: ${issue.title}`,
      author: readLogin(readNested(payload, "sender")),
      labels: labeled && addedLabel ? [addedLabel] : issue.labels,
      issue,
    };
  }

  if (githubEvent === "issue_comment") {
    if (action && action !== "created") return null;
    const rawIssue = readNested(payload, "issue");
    const comment = readNested(payload, "comment");
    const issueIsPr = Boolean(readNested(rawIssue, "pull_request"));
    const issue = buildIssueContext(rawIssue, repo);
    if (!issue) return null;
    return {
      triggerType: issueIsPr ? "github.pr_commented" : "github.issue_commented",
      summary: `GitHub ${issueIsPr ? "PR" : "issue"} #${issue.number} commented: ${issue.title}`,
      author: readUserLogin(comment) ?? readLogin(readNested(payload, "sender")),
      labels: issue.labels,
      issue: issueIsPr ? null : issue,
      pr: issueIsPr
        ? { ...issue, baseBranch: undefined, headBranch: undefined, draft: false, merged: false }
        : null,
    };
  }

  if (githubEvent === "pull_request") {
    const pr = buildPrContext(readNested(payload, "pull_request"), repo);
    if (!pr) return null;
    const triggerType: AutomationTriggerType | null =
      action === "opened" || action === "reopened"
        ? "github.pr_opened"
        : action === "closed" && pr.merged
          ? "github.pr_merged"
          : action === "closed"
            ? "github.pr_closed"
            : ["edited", "synchronize", "ready_for_review", "converted_to_draft", "labeled", "unlabeled"].includes(action)
              ? "github.pr_updated"
              : null;
    if (!triggerType) return null;
    return {
      triggerType,
      summary: `GitHub PR #${pr.number} ${action}: ${pr.title}`,
      author: readLogin(readNested(payload, "sender")) ?? pr.author,
      labels: pr.labels,
      branch: pr.headBranch ?? null,
      targetBranch: pr.baseBranch ?? null,
      draftState: pr.draft ? "draft" : "ready",
      pr,
    };
  }

  if (githubEvent === "pull_request_review") {
    if (action && action !== "submitted") return null;
    const pr = buildPrContext(readNested(payload, "pull_request"), repo);
    if (!pr) return null;
    return {
      triggerType: "github.pr_review_submitted",
      summary: `GitHub PR #${pr.number} review submitted: ${pr.title}`,
      author: readUserLogin(readNested(payload, "review")) ?? readLogin(readNested(payload, "sender")),
      labels: pr.labels,
      branch: pr.headBranch ?? null,
      targetBranch: pr.baseBranch ?? null,
      draftState: pr.draft ? "draft" : "ready",
      pr,
    };
  }

  return null;
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

  const verifyGithubWebhookSignature = (rawBody: Buffer, signature: string): void => {
    const secret = args.secretService.getSecret(GITHUB_WEBHOOK_SECRET_REF);
    if (!secret) {
      throw new Error(`GitHub webhook secret '${GITHUB_WEBHOOK_SECRET_REF}' could not be resolved.`);
    }
    if (!signature.startsWith("sha256=")) {
      throw new Error("Missing x-hub-signature-256 header.");
    }
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    if (!safeCompareSignature(expected, signature)) {
      throw new Error("GitHub webhook signature mismatch.");
    }
  };

  const dispatchGithubWebhook = async (
    githubEvent: string,
    deliveryId: string,
    payload: Record<string, unknown>,
  ): Promise<AutomationIngressEventRecord | null> => {
    const mapped = mapGithubWebhookToTrigger(githubEvent, payload);
    if (!mapped) {
      return await args.automationService.dispatchIngressTrigger({
        source: "local-webhook",
        eventKey: `github:${deliveryId || Date.now()}:${githubEvent}:unsupported`,
        triggerType: "github-webhook",
        eventName: githubEvent,
        summary: `GitHub ${githubEvent} webhook received`,
        rawPayload: payload,
      });
    }
    const repo = mapped.issue?.repo ?? mapped.pr?.repo ?? readRepoName(payload);
    return await args.automationService.dispatchIngressTrigger({
      source: "local-webhook",
      eventKey: `github:${deliveryId || Date.now()}:${mapped.triggerType}`,
      triggerType: mapped.triggerType,
      eventName: githubEvent,
      summary: mapped.summary,
      author: mapped.author ?? readLogin(readNested(payload, "sender")) ?? null,
      labels: mapped.labels,
      branch: mapped.branch,
      targetBranch: mapped.targetBranch,
      draftState: mapped.draftState,
      rawPayload: payload,
      repo,
      issue: mapped.issue,
      pr: mapped.pr,
    });
  };

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

  const normalizeWebhookPath = (pathname: string): string =>
    pathname.startsWith("/ade-webhooks/")
      ? pathname.slice("/ade-webhooks".length)
      : pathname;

  const handleWebhookRequest = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = normalizeWebhookPath(url.pathname);
    const match = /^\/automation-webhooks\/([^/]+)$/.exec(pathname);
    const isGithubWebhook = pathname === "/github-webhooks";
    if (request.method !== "POST" || (!match?.[1] && !isGithubWebhook)) {
      response.writeHead(404).end("not found");
      return;
    }
    const automationId = match?.[1] ? decodeURIComponent(match[1]) : null;
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", async () => {
      const body = Buffer.concat(chunks);
      try {
        const payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        const record = isGithubWebhook
          ? await (async () => {
              verifyGithubWebhookSignature(body, normalizeHeader(request.headers, "x-hub-signature-256"));
              return await dispatchGithubWebhook(
                normalizeHeader(request.headers, "x-github-event"),
                normalizeHeader(request.headers, "x-github-delivery"),
                payload,
              );
            })()
          : await (async () => {
              if (!automationId) throw new Error("Automation id is required.");
              payload.signatureHeader = request.headers["x-ade-signature"] ?? "";
              return await dispatchLocalWebhook(automationId, payload, body);
            })();
        updateStatus("local-webhook", {
          healthy: true,
          status: "listening",
          lastDeliveryAt: record?.receivedAt ?? new Date().toISOString(),
          lastError: null,
        });
        response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, eventId: record?.id ?? null }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        args.logger.warn("automations.local_webhook_failed", { automationId, path: url.pathname, error: message });
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
          githubUrl: port ? `http://127.0.0.1:${port}/github-webhooks` : null,
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
