import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import type { AutomationIngressEventRecord, AutomationIngressSource, AutomationIngressStatus, AutomationRule, AutomationTriggerType, GitHubRepoRef } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createAutomationService } from "./automationService";
import type { AutomationSecretService } from "./automationSecretService";
import type { createPrService } from "../prs/prService";
import {
  createGitHubRelayAuthAuditLog,
  ACCOUNT_RELAY_TOKEN_HEADER,
  gitHubRelayAuthorizationToken,
  readGitHubRelayConfig,
  resolveHostedGitHubRelayAuthToken,
  shouldUseLegacyGitHubRelayProjectRoute,
} from "../github/githubRelayConfig";

export type AutomationIngressCursorStore = {
  get(source: AutomationIngressSource): string | null;
  set(args: { source: AutomationIngressSource; cursor: string | null }): void;
};

// Canonical kv-backed cursor store. The key template is a persistence
// contract — keep it defined once here so desktop and daemon wiring cannot
// drift apart (a drifted key silently resets the relay cursor).
export function createKvIngressCursorStore(
  db: Pick<AdeDb, "getJson" | "setJson">,
): AutomationIngressCursorStore {
  const key = (source: AutomationIngressSource) => `automations.ingress.cursor.${source}`;
  return {
    get: (source) => db.getJson<string>(key(source)),
    set: ({ source, cursor }) => db.setJson(key(source), cursor),
  };
}

type AutomationIngressServiceArgs = {
  logger: Logger;
  // Null when the automations feature is unavailable (packaged builds,
  // installed daemons). The ingress still polls the GitHub relay and feeds
  // prService.ingestGithubWebhook so PR state stays fresh; only automation
  // rule dispatch, the local webhook server, and ingress status reporting
  // require the automation service.
  automationService: ReturnType<typeof createAutomationService> | null;
  prService?: ReturnType<typeof createPrService> | null;
  /**
   * Fired when a polled webhook event changed PR state — wired to the PR
   * poller's poke() so freshness rides the webhook, not the next poll tick.
   */
  onPrStateIngested?: () => void;
  secretService: AutomationSecretService;
  githubService?: {
    detectRepo: () => Promise<GitHubRepoRef | null> | GitHubRepoRef | null;
    getAppUserTokenForRelay: () => Promise<string>;
  } | null;
  getAccountAccessToken?: () => Promise<string | null>;
  listRules: () => AutomationRule[];
  // Cursor persistence fallback. REQUIRED when automationService is null —
  // without it the relay cursor would silently reset on every restart
  // (enforced at construction).
  ingressCursorStore?: AutomationIngressCursorStore | null;
  pollIntervalMs?: number;
  /** Test seam; production uses the repo's established Node `ws` client. */
  webSocketFactory?: (url: string, options: ClientOptions) => WebSocket;
  /** Test seam for reconnect jitter. */
  random?: () => number;
};

const GITHUB_WEBHOOK_SECRET_REF = "automations.githubWebhook.secret";
const GITHUB_RELAY_POLL_TIMEOUT_MS = 20_000;
const GITHUB_RELAY_PAGE_LIMIT = 100;
export const GITHUB_RELAY_MIN_POLL_INTERVAL_MS = 30_000;
export const GITHUB_RELAY_CONNECTED_SAFETY_POLL_MS = 5 * 60_000;
export const GITHUB_RELAY_SUBSCRIPTION_CONNECT_TIMEOUT_MS = 20_000;
export const GITHUB_RELAY_SUBSCRIPTION_BACKOFF_BASE_MS = 1_000;
export const GITHUB_RELAY_SUBSCRIPTION_BACKOFF_CAP_MS = 60_000;

export function computeGithubRelaySubscriptionBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    GITHUB_RELAY_SUBSCRIPTION_BACKOFF_CAP_MS,
    GITHUB_RELAY_SUBSCRIPTION_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt),
  );
  return Math.floor(random() * ceiling);
}

function rawDataToText(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

type GithubRelaySubscriptionTarget = {
  key: string;
  repo: GitHubRepoRef;
  url: string;
};

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

const HOSTED_RELAY_AUTH_PENDING_RETRY_MS = 5 * 60_000;

export function createAutomationIngressService(args: AutomationIngressServiceArgs) {
  if (!args.automationService && !args.ingressCursorStore) {
    throw new Error(
      "automationIngressService requires an ingressCursorStore when automationService is unavailable — without one the relay cursor resets on every restart.",
    );
  }
  let server: http.Server | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let pollInFlight: Promise<void> | null = null;
  let pollRerunRequested = false;
  let pollAbortController: AbortController | null = null;
  let started = false;
  let stopped = false;
  let subscriptionSocket: WebSocket | null = null;
  let subscriptionTargetKey: string | null = null;
  let subscriptionRepo: string | null = null;
  let subscriptionReconnectTimer: NodeJS.Timeout | null = null;
  let subscriptionConnectTimer: NodeJS.Timeout | null = null;
  let subscriptionReconnectAttempt = 0;
  let subscriptionConnected = false;
  let subscriptionLoggedState: "connected" | "disconnected" | null = null;
  // When the hosted relay needs a GitHub App user token that the user has not
  // granted yet, that is an idle state, not an error: skip polling for a
  // while and log the transition once instead of warning every tick.
  let hostedAuthPendingUntilMs = 0;
  let hostedAuthPendingLogged = false;
  const auditHostedRelayAuthTokenUse = createGitHubRelayAuthAuditLog(
    (event, metadata) => args.logger.info(event, metadata),
  );

  const updateGithubRelayStatus = (patch: Partial<AutomationIngressStatus["githubRelay"]>) => {
    args.automationService?.updateIngressStatus({
      githubRelay: patch,
    });
  };

  const updateLocalWebhookStatus = (patch: Partial<AutomationIngressStatus["localWebhook"]>) => {
    args.automationService?.updateIngressStatus({
      localWebhook: patch,
    });
  };

  const getIngressCursor = (source: AutomationIngressSource): string | null => {
    if (args.automationService) return args.automationService.getIngressCursor(source);
    return args.ingressCursorStore?.get(source) ?? null;
  };

  const setIngressCursor = (entry: { source: AutomationIngressSource; cursor: string | null }): void => {
    if (args.automationService) {
      args.automationService.setIngressCursor(entry);
      return;
    }
    args.ingressCursorStore?.set(entry);
  };

  const buildGithubRelayConfig = () => {
    return readGitHubRelayConfig((ref) => args.secretService.getSecret(ref));
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
    const ingested = await args.prService?.ingestGithubWebhook({
      eventName: githubEvent,
      deliveryId,
      payload,
    }).catch((error) => {
      args.logger.warn("automations.github_webhook_pr_ingest_failed", {
        githubEvent,
        deliveryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    // Webhook-driven PR changes used to sit silently in the DB until the PR
    // poller's next scheduled tick — throwing away the webhook's speed
    // advantage. Notify the poller so it re-reads and emits `prs-updated` now.
    if (ingested?.processed && !ingested.duplicate && ingested.linkedPrIds.length > 0) {
      args.onPrStateIngested?.();
    }

    if (!args.automationService) return null;
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
    if (!args.automationService) {
      throw new Error("Automations are not available in this runtime.");
    }
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
        updateLocalWebhookStatus({
          healthy: true,
          status: "listening",
          lastDeliveryAt: record?.receivedAt ?? new Date().toISOString(),
          lastError: null,
        });
        response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, eventId: record?.id ?? null }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        args.logger.warn("automations.local_webhook_failed", { automationId, path: url.pathname, error: message });
        updateLocalWebhookStatus({
          healthy: false,
          status: "error",
          lastError: message,
        });
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: message }));
      }
    });
  };

  const regularPollIntervalMs = Math.max(
    GITHUB_RELAY_MIN_POLL_INTERVAL_MS,
    Math.floor(args.pollIntervalMs ?? 60_000),
  );

  const rearmPollTimer = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (!started || stopped) return;
    const intervalMs = subscriptionConnected
      ? Math.max(regularPollIntervalMs, GITHUB_RELAY_CONNECTED_SAFETY_POLL_MS)
      : regularPollIntervalMs;
    pollTimer = setInterval(() => {
      void pollGithubRelayOnce();
    }, intervalMs);
    pollTimer.unref?.();
  };

  const clearSubscriptionReconnectTimer = (): void => {
    if (!subscriptionReconnectTimer) return;
    clearTimeout(subscriptionReconnectTimer);
    subscriptionReconnectTimer = null;
  };

  const clearSubscriptionConnectTimer = (): void => {
    if (!subscriptionConnectTimer) return;
    clearTimeout(subscriptionConnectTimer);
    subscriptionConnectTimer = null;
  };

  const setSubscriptionConnected = (connected: boolean): void => {
    if (subscriptionConnected === connected) return;
    subscriptionConnected = connected;
    rearmPollTimer();
    const state = connected ? "connected" : "disconnected";
    if (subscriptionLoggedState === state) return;
    subscriptionLoggedState = state;
    args.logger.info("automations.github_relay_subscription_state", {
      state,
      repo: subscriptionRepo,
    });
  };

  const closeRelaySubscription = (clearTarget: boolean): void => {
    clearSubscriptionConnectTimer();
    const socket = subscriptionSocket;
    subscriptionSocket = null;
    setSubscriptionConnected(false);
    if (clearTarget) {
      clearSubscriptionReconnectTimer();
      subscriptionTargetKey = null;
      subscriptionRepo = null;
      subscriptionReconnectAttempt = 0;
    }
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // The socket may already be closing. Its listeners are generation-gated.
    }
  };

  const disableRelaySubscription = (): void => {
    closeRelaySubscription(true);
  };

  const scheduleSubscriptionReconnect = (): void => {
    if (stopped || !started || subscriptionReconnectTimer || !subscriptionTargetKey) return;
    const delayMs = computeGithubRelaySubscriptionBackoffMs(
      subscriptionReconnectAttempt,
      args.random,
    );
    subscriptionReconnectAttempt += 1;
    subscriptionReconnectTimer = setTimeout(() => {
      subscriptionReconnectTimer = null;
      // A poll re-resolves config, repository, and fresh auth before opening the
      // next socket. Opening the socket then triggers a second catch-up drain.
      void pollGithubRelayOnce();
    }, delayMs);
    subscriptionReconnectTimer.unref?.();
  };

  const reconcileRelaySubscription = (
    target: GithubRelaySubscriptionTarget,
    headers: Record<string, string>,
    tokenSource: "github-app-user-token" | "account-token",
  ): void => {
    if (!started || stopped) return;
    if (subscriptionTargetKey !== target.key) {
      closeRelaySubscription(true);
      subscriptionTargetKey = target.key;
      subscriptionRepo = `${target.repo.owner}/${target.repo.name}`;
    }
    if (subscriptionSocket) return;
    clearSubscriptionReconnectTimer();
    let socket: WebSocket;
    try {
      socket = args.webSocketFactory
        ? args.webSocketFactory(target.url, { headers })
        : new WebSocket(target.url, { headers });
    } catch {
      scheduleSubscriptionReconnect();
      return;
    }
    subscriptionSocket = socket;
    if (tokenSource === "github-app-user-token") {
      auditHostedRelayAuthTokenUse("automations.github_hosted_relay_auth_token_used", {
        origin: new URL(target.url).origin,
        repo: `${target.repo.owner}/${target.repo.name}`,
        tokenSource,
        route: "subscribe",
      });
    }
    subscriptionConnectTimer = setTimeout(() => {
      if (subscriptionSocket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      try {
        socket.terminate();
      } catch {
        // A concurrent close will schedule the same reconnect path.
      }
    }, GITHUB_RELAY_SUBSCRIPTION_CONNECT_TIMEOUT_MS);
    subscriptionConnectTimer.unref?.();

    socket.on("open", () => {
      if (subscriptionSocket !== socket) return;
      clearSubscriptionConnectTimer();
      clearSubscriptionReconnectTimer();
      subscriptionReconnectAttempt = 0;
      setSubscriptionConnected(true);
      // The durable cursor may have advanced while the socket was unavailable.
      void pollGithubRelayOnce();
    });
    socket.on("message", (raw: RawData) => {
      if (subscriptionSocket !== socket) return;
      try {
        const frame = JSON.parse(rawDataToText(raw)) as unknown;
        if (isRecord(frame) && frame.t === "github_delivery") {
          void pollGithubRelayOnce();
        }
      } catch {
        // Wake-up frames are hints only; malformed/unknown frames are ignored.
      }
    });
    socket.on("error", () => {
      // `close` owns the state transition and reconnect. Keeping this listener
      // prevents EventEmitter error escalation without logging every attempt.
    });
    socket.on("close", () => {
      if (subscriptionSocket !== socket) return;
      subscriptionSocket = null;
      clearSubscriptionConnectTimer();
      setSubscriptionConnected(false);
      scheduleSubscriptionReconnect();
    });
  };

  const enterHostedAuthPending = (message: string): void => {
    hostedAuthPendingUntilMs = Date.now() + HOSTED_RELAY_AUTH_PENDING_RETRY_MS;
    disableRelaySubscription();
    if (!hostedAuthPendingLogged) {
      hostedAuthPendingLogged = true;
      args.logger.info("automations.github_relay_auth_pending", { error: message });
    }
    updateGithubRelayStatus({
      healthy: false,
      status: "disabled",
      lastPolledAt: new Date().toISOString(),
      lastError: message,
    });
  };

  const pollGithubRelay = async () => {
    const config = buildGithubRelayConfig();
    const useLegacyProjectRoute = shouldUseLegacyGitHubRelayProjectRoute(config);
    const accountAccessToken = args.getAccountAccessToken
      ? (await args.getAccountAccessToken().catch(() => null))?.trim() || null
      : null;
    // Account auth may become available during the GitHub-token cooldown, so
    // it is checked first. Without either credential, neither HTTP nor socket
    // attempts run until the same five-minute retry window expires.
    if (config.configured && !useLegacyProjectRoute && !accountAccessToken && Date.now() < hostedAuthPendingUntilMs) {
      disableRelaySubscription();
      return;
    }
    updateGithubRelayStatus({
      configured: config.configured,
      apiBaseUrl: config.apiBaseUrl,
      remoteProjectId: config.remoteProjectId,
      status: config.configured ? "polling" : "disabled",
    });
    if (!config.configured) {
      disableRelaySubscription();
      return;
    }
    try {
      const initialCursor = getIngressCursor("github-relay");
      const baseUrl = config.apiBaseUrl!.replace(/\/+$/, "");
      const legacyAuthToken = gitHubRelayAuthorizationToken(config);
      if (useLegacyProjectRoute) {
        disableRelaySubscription();
      } else if (subscriptionTargetKey && !subscriptionTargetKey.startsWith(`${baseUrl}|`)) {
        // Close the old relay immediately even if repository detection for the
        // new config later fails.
        disableRelaySubscription();
      }
      const repo = useLegacyProjectRoute ? null : await args.githubService?.detectRepo();
      const eventsUrl = useLegacyProjectRoute
        ? new URL(`${baseUrl}/projects/${encodeURIComponent(config.remoteProjectId!)}/github/events`)
        : repo
          ? new URL(`${baseUrl}/github/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/events`)
          : null;
      if (!eventsUrl) {
        disableRelaySubscription();
        updateGithubRelayStatus({
          configured: true,
          apiBaseUrl: config.apiBaseUrl,
          remoteProjectId: null,
          healthy: false,
          status: "disabled",
          lastError: null,
        });
        return;
      }
      if (!useLegacyProjectRoute) {
        eventsUrl.searchParams.set("order", "asc");
        eventsUrl.searchParams.set("limit", String(GITHUB_RELAY_PAGE_LIMIT));
      }

      let githubAppUserToken: string | null = null;
      if (!useLegacyProjectRoute) {
        try {
          githubAppUserToken = ((await args.githubService?.getAppUserTokenForRelay()) ?? "").trim() || null;
        } catch (error) {
          if (!accountAccessToken) {
            enterHostedAuthPending(error instanceof Error ? error.message : String(error));
            return;
          }
        }
      }
      const hostedAuth = useLegacyProjectRoute
        ? null
        : resolveHostedGitHubRelayAuthToken({ githubAppUserToken });
      if (hostedAuth && !hostedAuth.ok && !accountAccessToken) {
        enterHostedAuthPending(hostedAuth.error);
        return;
      }
      hostedAuthPendingUntilMs = 0;
      hostedAuthPendingLogged = false;
      const authToken = useLegacyProjectRoute
        ? legacyAuthToken
        : hostedAuth?.ok
          ? hostedAuth.token
          : null;
      if (!authToken && (!accountAccessToken || useLegacyProjectRoute)) {
        throw new Error("GitHub auth is required for relay polling.");
      }
      const requestHeaders: Record<string, string> = {
        accept: "application/json",
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        ...(accountAccessToken && !useLegacyProjectRoute
          ? { [ACCOUNT_RELAY_TOKEN_HEADER]: accountAccessToken }
          : {}),
      };
      if (hostedAuth?.ok && repo) {
        auditHostedRelayAuthTokenUse("automations.github_hosted_relay_auth_token_used", {
          origin: new URL(baseUrl).origin,
          repo: `${repo.owner}/${repo.name}`,
          tokenSource: "github-app-user-token",
          route: "events",
        });
      }
      if (repo) {
        const subscriptionUrl = new URL(
          `${baseUrl}/github/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/subscribe`,
        );
        if (subscriptionUrl.protocol === "https:") subscriptionUrl.protocol = "wss:";
        else if (subscriptionUrl.protocol === "http:") subscriptionUrl.protocol = "ws:";
        reconcileRelaySubscription(
          {
            key: `${baseUrl}|${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`,
            repo,
            url: subscriptionUrl.toString(),
          },
          requestHeaders,
          hostedAuth?.ok ? "github-app-user-token" : "account-token",
        );
      }
      updateGithubRelayStatus({
        configured: true,
        apiBaseUrl: config.apiBaseUrl,
        remoteProjectId: useLegacyProjectRoute ? config.remoteProjectId : repo ? `${repo.owner}/${repo.name}` : null,
        status: "polling",
      });

      let pageCursor = initialCursor;
      let lastSeenCursor = initialCursor;
      let lastDeliveryAt: string | null = null;
      while (true) {
        const pageUrl = new URL(eventsUrl);
        if (pageCursor) pageUrl.searchParams.set("after", pageCursor);
        else pageUrl.searchParams.delete("after");
        const controller = new AbortController();
        pollAbortController = controller;
        const timeout = setTimeout(() => controller.abort(), GITHUB_RELAY_POLL_TIMEOUT_MS);
        timeout.unref?.();
        const response = await fetch(pageUrl.toString(), {
          headers: requestHeaders,
          signal: controller.signal,
        }).finally(() => {
          clearTimeout(timeout);
          if (pollAbortController === controller) pollAbortController = null;
        });
        if (!response.ok) {
          throw new Error(`GitHub relay poll failed (${response.status})`);
        }
        const payload = await response.json() as {
          events?: Array<Record<string, unknown>>;
          nextCursor?: unknown;
          cursorExpired?: unknown;
          hasMore?: unknown;
        };
        const events = Array.isArray(payload.events)
          ? useLegacyProjectRoute ? [...payload.events].reverse() : payload.events
          : [];
        let pageLastCursor = pageCursor;
        for (const event of events) {
          const eventId = typeof event.eventId === "string" ? event.eventId : "";
          const eventCursor = typeof event.cursor === "string" && event.cursor ? event.cursor : null;
          if (!eventId) throw new Error("GitHub relay returned an event without an eventId.");
          if (eventCursor && eventCursor === pageCursor) continue;
          const githubEvent = typeof event.githubEvent === "string" ? event.githubEvent : "pull_request";
          const summary = typeof event.summary === "string" ? event.summary : `GitHub ${githubEvent} event`;
          const rawPayload = isRecord(event.payload) ? event.payload : event;
          lastDeliveryAt = String(event.createdAt ?? new Date().toISOString());
          // Per-event failures must not stall the drain: the delivery is
          // already durably recorded (status="error") for diagnosis, and the
          // direct GitHub poller corrects PR state independently. A throwing
          // event would otherwise replay from the same cursor forever and
          // freeze all ingest for the repo.
          const ingested = await args.prService?.ingestGithubWebhook({
            eventName: githubEvent,
            deliveryId: eventId,
            payload: rawPayload,
          }).catch((error) => {
            args.logger.warn("automations.github_relay_pr_ingest_failed", {
              githubEvent,
              eventId,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          });
          // Same as the local-webhook path: a relay-delivered PR change should
          // refresh the poller immediately instead of waiting for its next tick.
          if (ingested?.processed && !ingested.duplicate && ingested.linkedPrIds.length > 0) {
            args.onPrStateIngested?.();
          }
          try {
            await args.automationService?.dispatchIngressTrigger({
              source: "github-relay",
              eventKey: eventId,
              triggerType: "github-webhook",
              eventName: githubEvent,
              summary,
              cursor: eventCursor ?? eventId,
              keywords: summary.split(/\s+/g).filter(Boolean),
              rawPayload,
            });
          } catch (error) {
            args.logger.warn("automations.github_relay_dispatch_failed", {
              githubEvent,
              eventId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          pageLastCursor = eventCursor ?? eventId;
        }
        const responseCursor = typeof payload.nextCursor === "string" && payload.nextCursor
          ? payload.nextCursor
          : null;
        if (responseCursor) pageLastCursor = responseCursor;
        // Commit only after every event in this page has completed. A failed
        // page is replayed from its previous durable cursor on the next drain.
        if (pageLastCursor && pageLastCursor !== pageCursor) {
          setIngressCursor({ source: "github-relay", cursor: pageLastCursor });
        }
        lastSeenCursor = pageLastCursor;
        if (useLegacyProjectRoute || payload.hasMore !== true) break;
        if (!pageLastCursor || pageLastCursor === pageCursor) {
          throw new Error("GitHub relay pagination did not advance its cursor.");
        }
        pageCursor = pageLastCursor;
      }
      updateGithubRelayStatus({
        healthy: true,
        status: "ready",
        lastPolledAt: new Date().toISOString(),
        lastCursor: lastSeenCursor,
        lastDeliveryAt,
        lastError: null,
      });
    } catch (error) {
      if (stopped && error instanceof Error && error.name === "AbortError") return;
      args.logger.warn("automations.github_relay_poll_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      updateGithubRelayStatus({
        healthy: false,
        status: "error",
        lastPolledAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const pollGithubRelayOnce = async () => {
    if (pollInFlight) {
      pollRerunRequested = true;
      return await pollInFlight;
    }
    pollInFlight = (async () => {
      do {
        pollRerunRequested = false;
        await pollGithubRelay();
      } while (pollRerunRequested && !stopped);
    })().finally(() => {
      pollInFlight = null;
    });
    return await pollInFlight;
  };

  return {
    async start() {
      if (started && !stopped) return;
      started = true;
      stopped = false;
      // The local webhook server exists to receive automation webhooks; in
      // PR-freshness-only mode (no automation service) only the relay poll runs.
      if (!server && args.automationService) {
        server = http.createServer((request, response) => {
          void handleWebhookRequest(request, response);
        });
        await new Promise<void>((resolve, reject) => {
          server!.once("error", reject);
          server!.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : null;
        updateLocalWebhookStatus({
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
      rearmPollTimer();
      await pollGithubRelayOnce();
    },

    getStatus() {
      return args.automationService?.getIngressStatus() ?? null;
    },

    listRecentEvents(limit = 20) {
      return args.automationService?.listIngressEvents(limit) ?? [];
    },

    async pollNow() {
      // Explicit polls (e.g. right after the user authorizes the GitHub App)
      // bypass the auth-pending cooldown.
      hostedAuthPendingUntilMs = 0;
      await pollGithubRelayOnce();
    },

    stop() {
      stopped = true;
      started = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      clearSubscriptionReconnectTimer();
      clearSubscriptionConnectTimer();
      pollAbortController?.abort();
      pollAbortController = null;
      closeRelaySubscription(true);
      if (server) {
        server.close();
        server = null;
      }
    },

    dispose() {
      this.stop();
    },
  };
}

export type AutomationIngressService = ReturnType<typeof createAutomationIngressService>;
