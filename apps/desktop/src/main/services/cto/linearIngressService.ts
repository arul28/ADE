import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type {
  LinearIngressEventRecord,
  LinearIngressSource,
  LinearIngressStatus,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { nowIso, safeJsonParse } from "../shared/utils";
import type { AutomationSecretService } from "../automations/automationSecretService";
import type { LinearClient } from "./linearClient";

const RELAY_API_BASE_REF = "linearRelay.apiBaseUrl";
const RELAY_PROJECT_REF = "linearRelay.remoteProjectId";
const RELAY_TOKEN_REF = "linearRelay.accessToken";

type LinearIngressServiceArgs = {
  db: AdeDb;
  projectId: string;
  logger?: Logger | null;
  linearClient: LinearClient;
  secretService: AutomationSecretService;
  onEvent?: (event: LinearIngressEventRecord) => Promise<void> | void;
  reconciliationIntervalSec?: number;
};

type RelayConfig = {
  apiBaseUrl: string | null;
  remoteProjectId: string | null;
  accessToken: string | null;
  configured: boolean;
};

type RelayEnsureWebhookResponse = {
  endpointId: string;
  webhookUrl: string;
  signingSecret: string;
  lastDeliveredAt: string | null;
};

type RelayEventResponse = {
  events?: Array<Record<string, unknown>>;
  cursor?: string | null;
  timedOut?: boolean;
};

function normalizeHeader(headers: Record<string, string | string[] | undefined>, key: string): string {
  const needle = key.toLowerCase();
  for (const [headerKey, headerValue] of Object.entries(headers)) {
    if (headerKey.toLowerCase() !== needle) continue;
    if (Array.isArray(headerValue)) return headerValue[0]?.trim() ?? "";
    return typeof headerValue === "string" ? headerValue.trim() : "";
  }
  return "";
}

function createSecret(): string {
  return randomBytes(32).toString("hex");
}

function safeCompare(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readIssueDetails(payload: Record<string, unknown>): {
  issueId: string | null;
  issueIdentifier: string | null;
  summary: string;
} {
  const data = payload.data;
  const issue = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const issueId = typeof issue.id === "string" ? issue.id.trim() : null;
  const issueIdentifier =
    typeof issue.identifier === "string"
      ? issue.identifier.trim()
      : typeof issue.number === "number"
        ? String(issue.number)
        : null;
  const title = typeof issue.title === "string" ? issue.title.trim() : "";
  const entityType = typeof payload.type === "string" ? payload.type.trim() : "issue";
  const action = typeof payload.action === "string" ? payload.action.trim() : null;
  const summary = [entityType, action, issueIdentifier, title].filter(Boolean).join(" · ") || "Linear webhook received";
  return { issueId, issueIdentifier, summary };
}

export function createLinearIngressService(args: LinearIngressServiceArgs) {
  let disposed = false;
  let localServer: http.Server | null = null;
  let relayAbortController: AbortController | null = null;
  let relayWebhook: RelayEnsureWebhookResponse | null = null;
  let localSigningSecret = createSecret();

  const loadStatus = (): LinearIngressStatus => {
    const row = args.db.get<{
      local_webhook_json: string;
      relay_json: string;
      reconciliation_json: string;
    }>(
      `select local_webhook_json, relay_json, reconciliation_json from linear_ingress_state where project_id = ? limit 1`,
      [args.projectId]
    );
    return {
      localWebhook: safeJsonParse(row?.local_webhook_json ?? "{}", {
        configured: false,
        healthy: false,
        status: "disabled",
      }),
      relay: safeJsonParse(row?.relay_json ?? "{}", {
        configured: false,
        healthy: false,
        status: "disabled",
      }),
      reconciliation: safeJsonParse(row?.reconciliation_json ?? "{}", {
        enabled: true,
        intervalSec: Math.max(15, Math.floor(args.reconciliationIntervalSec ?? 30)),
        lastRunAt: null,
      }),
    };
  };

  const persistStatus = (status: LinearIngressStatus): void => {
    args.db.run(
      `
        insert into linear_ingress_state(project_id, local_webhook_json, relay_json, reconciliation_json, updated_at)
        values(?, ?, ?, ?, ?)
        on conflict(project_id) do update set
          local_webhook_json = excluded.local_webhook_json,
          relay_json = excluded.relay_json,
          reconciliation_json = excluded.reconciliation_json,
          updated_at = excluded.updated_at
      `,
      [
        args.projectId,
        JSON.stringify(status.localWebhook),
        JSON.stringify(status.relay),
        JSON.stringify(status.reconciliation),
        nowIso(),
      ]
    );
  };

  const updateStatus = (patch: Partial<LinearIngressStatus>): LinearIngressStatus => {
    const current = loadStatus();
    const next: LinearIngressStatus = {
      localWebhook: { ...current.localWebhook, ...(patch.localWebhook ?? {}) },
      relay: { ...current.relay, ...(patch.relay ?? {}) },
      reconciliation: { ...current.reconciliation, ...(patch.reconciliation ?? {}) },
    };
    persistStatus(next);
    return next;
  };

  const persistEvent = (event: Omit<LinearIngressEventRecord, "id" | "createdAt"> & { createdAt?: string }): LinearIngressEventRecord => {
    const createdAt = event.createdAt ?? nowIso();
    const record: LinearIngressEventRecord = {
      id: randomUUID(),
      createdAt,
      ...event,
    };
    try {
      args.db.run(
        `
          insert into linear_ingress_events(
            id, project_id, source, delivery_id, event_id, entity_type, action, issue_id, issue_identifier, summary, payload_json, created_at
          )
          values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          record.id,
          args.projectId,
          record.source,
          record.deliveryId,
          record.eventId,
          record.entityType,
          record.action ?? null,
          record.issueId ?? null,
          record.issueIdentifier ?? null,
          record.summary,
          record.payload ? JSON.stringify(record.payload) : null,
          record.createdAt,
        ]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/unique|constraint/i.test(message)) throw error;
      const existing = args.db.get<{
        id: string;
        source: LinearIngressSource;
        delivery_id: string;
        event_id: string;
        entity_type: string;
        action: string | null;
        issue_id: string | null;
        issue_identifier: string | null;
        summary: string;
        payload_json: string | null;
        created_at: string;
      }>(
        `select * from linear_ingress_events where project_id = ? and event_id = ? limit 1`,
        [args.projectId, record.eventId]
      );
      if (!existing) throw error;
      return {
        id: existing.id,
        source: existing.source,
        deliveryId: existing.delivery_id,
        eventId: existing.event_id,
        entityType: existing.entity_type,
        action: existing.action,
        issueId: existing.issue_id,
        issueIdentifier: existing.issue_identifier,
        summary: existing.summary,
        payload: safeJsonParse(existing.payload_json ?? "null", null),
        createdAt: existing.created_at,
      };
    }
    return record;
  };

  const listRecentEvents = (limit = 20): LinearIngressEventRecord[] => {
    const rows = args.db.all<{
      id: string;
      source: LinearIngressSource;
      delivery_id: string;
      event_id: string;
      entity_type: string;
      action: string | null;
      issue_id: string | null;
      issue_identifier: string | null;
      summary: string;
      payload_json: string | null;
      created_at: string;
    }>(
      `
        select *
        from linear_ingress_events
        where project_id = ?
        order by datetime(created_at) desc
        limit ?
      `,
      [args.projectId, Math.max(1, Math.min(200, Math.floor(limit)))]
    );
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      deliveryId: row.delivery_id,
      eventId: row.event_id,
      entityType: row.entity_type,
      action: row.action,
      issueId: row.issue_id,
      issueIdentifier: row.issue_identifier,
      summary: row.summary,
      payload: safeJsonParse(row.payload_json ?? "null", null),
      createdAt: row.created_at,
    }));
  };

  const buildRelayConfig = (): RelayConfig => {
    const apiBaseUrl = args.secretService.getSecret(RELAY_API_BASE_REF)?.trim() ?? null;
    const remoteProjectId = args.secretService.getSecret(RELAY_PROJECT_REF)?.trim() ?? null;
    const accessToken = args.secretService.getSecret(RELAY_TOKEN_REF)?.trim() ?? null;
    return {
      apiBaseUrl,
      remoteProjectId,
      accessToken,
      configured: Boolean(apiBaseUrl && remoteProjectId && accessToken),
    };
  };

  const ensureRelayWebhook = async (force = false): Promise<RelayEnsureWebhookResponse | null> => {
    const config = buildRelayConfig();
    if (!config.configured) {
      updateStatus({
        relay: {
          configured: false,
          healthy: false,
          status: "disabled",
          webhookUrl: null,
          endpointId: null,
        },
      });
      return null;
    }

    if (relayWebhook && !force) return relayWebhook;

    const response = await fetch(
      `${config.apiBaseUrl}/projects/${encodeURIComponent(config.remoteProjectId!)}/linear/webhook/ensure`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.accessToken}`,
        },
      }
    );
    if (!response.ok) {
      throw new Error(`Linear relay webhook ensure failed (${response.status}).`);
    }
    const payload = (await response.json()) as RelayEnsureWebhookResponse;
    relayWebhook = payload;

    try {
      const existing = await args.linearClient.listWebhooks();
      if (!existing.some((entry) => entry.url === payload.webhookUrl)) {
        await args.linearClient.createWebhook({
          url: payload.webhookUrl,
          secret: payload.signingSecret,
          label: `ADE ${args.projectId} workflow ingress`,
          resourceTypes: ["Issue", "IssueLabel"],
          allPublicTeams: true,
        });
      }
    } catch (error) {
      args.logger?.warn("linear_ingress.ensure_linear_webhook_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    updateStatus({
      relay: {
        configured: true,
        healthy: true,
        status: "ready",
        webhookUrl: payload.webhookUrl,
        endpointId: payload.endpointId,
        lastDeliveryAt: payload.lastDeliveredAt,
        lastError: null,
      },
    });
    return payload;
  };

  const dispatchEvent = async (event: LinearIngressEventRecord): Promise<void> => {
    const current = loadStatus();
    updateStatus({
      relay:
        event.source === "relay"
          ? {
              ...current.relay,
              configured: current.relay.configured || Boolean(current.relay.endpointId || current.relay.webhookUrl),
              lastDeliveryAt: event.createdAt,
              healthy: true,
              status: "ready",
            }
          : undefined,
      localWebhook:
        event.source === "local-webhook"
          ? {
              ...current.localWebhook,
              configured: true,
              lastDeliveryAt: event.createdAt,
              healthy: true,
              status: "listening",
            }
          : undefined,
    });
    await args.onEvent?.(event);
  };

  const pollRelay = async (): Promise<void> => {
    const config = buildRelayConfig();
    if (!config.configured) return;
    await ensureRelayWebhook();
    const status = loadStatus();
    const after = status.relay.lastCursor ?? null;
    const response = await fetch(
      `${config.apiBaseUrl}/projects/${encodeURIComponent(config.remoteProjectId!)}/linear/events/stream?after=${encodeURIComponent(after ?? "")}&waitSeconds=20&limit=50`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.accessToken}`,
        },
        signal: relayAbortController?.signal,
      }
    );
    if (!response.ok) {
      throw new Error(`Linear relay stream failed (${response.status}).`);
    }
    const payload = (await response.json()) as RelayEventResponse;
    const events = Array.isArray(payload.events) ? payload.events : [];
    let lastCursor = after;
    for (const entry of events) {
      const eventRecord = persistEvent({
        source: "relay",
        deliveryId: typeof entry.deliveryId === "string" ? entry.deliveryId : randomUUID(),
        eventId: typeof entry.eventId === "string" ? entry.eventId : `${Date.now()}-${randomUUID()}`,
        entityType: typeof entry.entityType === "string" ? entry.entityType : "issue",
        action: typeof entry.action === "string" ? entry.action : null,
        issueId: typeof entry.issueId === "string" ? entry.issueId : null,
        issueIdentifier: typeof entry.issueIdentifier === "string" ? entry.issueIdentifier : null,
        summary: typeof entry.summary === "string" ? entry.summary : "Linear relay event",
        payload: entry,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : nowIso(),
      });
      lastCursor = eventRecord.eventId;
      await dispatchEvent(eventRecord);
    }
    updateStatus({
      relay: {
        configured: true,
        healthy: true,
        status: "ready",
        lastPolledAt: nowIso(),
        lastCursor: payload.cursor ?? lastCursor,
        lastError: null,
      },
    });
  };

  const startRelayLoop = async (): Promise<void> => {
    relayAbortController = new AbortController();
    while (!disposed) {
      try {
        await pollRelay();
      } catch (error) {
        if (disposed) break;
        updateStatus({
          relay: {
            configured: buildRelayConfig().configured,
            healthy: false,
            status: "error",
            lastError: error instanceof Error ? error.message : String(error),
            lastPolledAt: nowIso(),
          },
        });
      }
    }
  };

  const startLocalWebhook = async (): Promise<void> => {
    if (localServer) return;
    updateStatus({
      localWebhook: {
        configured: true,
        healthy: true,
        status: "starting",
      },
    });
    localServer = http.createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/linear-webhooks") {
        response.writeHead(404).end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", async () => {
        const body = Buffer.concat(chunks);
        try {
          const signature = normalizeHeader(request.headers, "linear-signature");
          const expected = createHmac("sha256", localSigningSecret).update(body).digest("hex");
          if (!safeCompare(expected, signature)) {
            throw new Error("Linear local webhook signature mismatch.");
          }
          const payload = body.length ? JSON.parse(body.toString("utf8")) as Record<string, unknown> : {};
          const details = readIssueDetails(payload);
          const eventRecord = persistEvent({
            source: "local-webhook",
            deliveryId: normalizeHeader(request.headers, "linear-delivery") || randomUUID(),
            eventId: `${Date.now()}#${normalizeHeader(request.headers, "linear-delivery") || randomUUID()}`,
            entityType: typeof payload.type === "string" ? payload.type : "issue",
            action: typeof payload.action === "string" ? payload.action : null,
            issueId: details.issueId,
            issueIdentifier: details.issueIdentifier,
            summary: details.summary,
            payload,
          });
          await dispatchEvent(eventRecord);
          response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, eventId: eventRecord.eventId }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateStatus({
            localWebhook: {
              configured: true,
              healthy: false,
              status: "error",
              lastError: message,
            },
          });
          response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: message }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      localServer!.once("error", reject);
      localServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = localServer.address();
    const port = typeof address === "object" && address ? address.port : null;
    updateStatus({
      localWebhook: {
        configured: true,
        healthy: true,
        status: "listening",
        port,
        url: port ? `http://127.0.0.1:${port}/linear-webhooks` : null,
        lastError: null,
      },
    });
  };

  return {
    async start(): Promise<void> {
      await startLocalWebhook();
      void startRelayLoop();
    },

    async ensureRelayWebhook(force = false): Promise<void> {
      await ensureRelayWebhook(force);
    },

    getStatus(): LinearIngressStatus {
      return loadStatus();
    },

    listRecentEvents(limit = 20): LinearIngressEventRecord[] {
      return listRecentEvents(limit);
    },

    dispose(): void {
      disposed = true;
      relayAbortController?.abort();
      relayAbortController = null;
      if (localServer) {
        localServer.close();
        localServer = null;
      }
    },
  };
}

export type LinearIngressService = ReturnType<typeof createLinearIngressService>;
