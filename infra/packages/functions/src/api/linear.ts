import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, nowIso } from "../common/awsClients";
import { getUserIdFromEvent } from "../common/auth";
import { sharedEnv } from "../common/env";
import { ApiError, json, parsePathParam, toApiResponse } from "../common/http";
import { isRecord, optionalString } from "../common/validation";

type ProjectItem = {
  userId: string;
  projectId: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
};

type LinearWebhookEndpointItem = {
  endpointId: string;
  projectId: string;
  userId: string;
  secret: string;
  createdAt: string;
  updatedAt: string;
  lastDeliveredAt?: string;
};

type LinearEventItem = {
  projectId: string;
  eventId: string;
  deliveryId: string;
  endpointId: string;
  entityType: string;
  action: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  teamId: string | null;
  teamKey: string | null;
  summary: string;
  createdAt: string;
  webhookTimestamp: number | null;
  expiresAt: number;
};

type LinearWebhookPayload = Record<string, unknown> & {
  action?: unknown;
  type?: unknown;
  data?: unknown;
  webhookTimestamp?: unknown;
};

function normalizeHeader(headers: Record<string, string | undefined> | undefined, key: string): string {
  if (!headers) return "";
  const needle = key.toLowerCase();
  for (const [headerKey, headerValue] of Object.entries(headers)) {
    if (headerKey.toLowerCase() === needle && typeof headerValue === "string") {
      return headerValue.trim();
    }
  }
  return "";
}

function rawBodyFromEvent(event: APIGatewayProxyEventV2): Buffer {
  if (!event.body) return Buffer.from("");
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getProjectForUser(args: { userId: string; projectId: string }): Promise<ProjectItem> {
  const item = await ddb.send(
    new GetCommand({
      TableName: sharedEnv.projectsTableName,
      Key: {
        userId: args.userId,
        projectId: args.projectId
      }
    })
  );

  if (!item.Item) {
    throw new ApiError(404, {
      code: "NOT_FOUND",
      message: `Project '${args.projectId}' was not found`
    });
  }

  return item.Item as ProjectItem;
}

function endpointUrlForEvent(event: APIGatewayProxyEventV2, endpointId: string): string {
  const domain = event.requestContext.domainName?.trim();
  if (!domain) {
    throw new ApiError(500, {
      code: "API_URL_NOT_AVAILABLE",
      message: "API URL is not available in the request context."
    });
  }

  const stage = event.requestContext.stage?.trim();
  const stagePrefix = stage && stage !== "$default" ? `/${stage}` : "";
  return `https://${domain}${stagePrefix}/linear/webhooks/${encodeURIComponent(endpointId)}`;
}

function createWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const raw = optionalString(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function verifyWebhookSignature(args: {
  body: Buffer;
  signatureHeader: string;
  secret: string;
  webhookTimestamp: number | null;
}): void {
  const signature = args.signatureHeader.trim();
  if (!signature) {
    throw new ApiError(401, {
      code: "UNAUTHORIZED",
      message: "Missing webhook signature"
    });
  }

  const expected = createHmac("sha256", args.secret).update(args.body).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApiError(401, {
      code: "UNAUTHORIZED",
      message: "Webhook signature mismatch"
    });
  }

  if (args.webhookTimestamp != null) {
    const skewMs = Math.abs(Date.now() - args.webhookTimestamp);
    if (skewMs > 5 * 60_000) {
      throw new ApiError(401, {
        code: "UNAUTHORIZED",
        message: "Webhook timestamp is outside the accepted replay window"
      });
    }
  }
}

function readIssueDetails(data: unknown): {
  issueId: string | null;
  issueIdentifier: string | null;
  teamId: string | null;
  teamKey: string | null;
  title: string | null;
} {
  if (!isRecord(data)) {
    return {
      issueId: null,
      issueIdentifier: null,
      teamId: null,
      teamKey: null,
      title: null
    };
  }

  const identifierValue =
    typeof data.identifier === "string"
      ? data.identifier
      : typeof data.number === "number"
        ? String(data.number)
        : null;

  const teamRecord = isRecord(data.team) ? data.team : null;
  return {
    issueId: typeof data.id === "string" ? data.id : null,
    issueIdentifier: identifierValue,
    teamId: typeof data.teamId === "string" ? data.teamId : teamRecord && typeof teamRecord.id === "string" ? teamRecord.id : null,
    teamKey: typeof data.teamKey === "string" ? data.teamKey : teamRecord && typeof teamRecord.key === "string" ? teamRecord.key : null,
    title: typeof data.title === "string" ? data.title : null
  };
}

function buildSummary(args: {
  entityType: string;
  action: string | null;
  issueIdentifier: string | null;
  title: string | null;
}): string {
  const parts = [args.entityType];
  if (args.action) parts.push(args.action);
  if (args.issueIdentifier) parts.push(args.issueIdentifier);
  if (args.title) parts.push(args.title);
  return parts.join(" · ");
}

async function fetchEventsAfter(args: {
  projectId: string;
  after?: string;
  limit: number;
  ascending: boolean;
}): Promise<LinearEventItem[]> {
  const expressionValues: Record<string, unknown> = {
    ":pid": args.projectId
  };
  let keyConditionExpression = "projectId = :pid";
  if (args.after) {
    expressionValues[":after"] = args.after;
    keyConditionExpression += " and eventId > :after";
  }

  const res = await ddb.send(
    new QueryCommand({
      TableName: sharedEnv.linearEventsTableName,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionValues,
      ScanIndexForward: args.ascending,
      Limit: args.limit
    })
  );

  return (res.Items ?? []) as LinearEventItem[];
}

export async function ensureWebhook(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const existing = await queryEndpointsForProject(projectId);
    const endpoint = existing.find((item) => item.userId === userId) ?? (await createEndpoint({ userId, projectId }));

    return json(200, {
      endpointId: endpoint.endpointId,
      webhookUrl: endpointUrlForEvent(event, endpoint.endpointId),
      signingSecret: endpoint.secret,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
      lastDeliveredAt: endpoint.lastDeliveredAt ?? null
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function listEvents(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const limit = parsePositiveInt(event.queryStringParameters?.limit, 50, 1, 100);
    const items = await fetchEventsAfter({
      projectId,
      after: undefined,
      limit,
      ascending: false
    });

    return json(200, {
      events: items.map(formatEvent),
      cursor: items[0]?.eventId ?? null
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function streamEvents(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const after = optionalString(event.queryStringParameters?.after);
    const waitSeconds = parsePositiveInt(event.queryStringParameters?.waitSeconds, 20, 1, 25);
    const limit = parsePositiveInt(event.queryStringParameters?.limit, 50, 1, 100);
    const deadline = Date.now() + waitSeconds * 1000;

    while (true) {
      const items = await fetchEventsAfter({
        projectId,
        after: after ?? undefined,
        limit,
        ascending: true
      });
      if (items.length > 0 || Date.now() >= deadline) {
        return json(200, {
          events: items.map(formatEvent),
          cursor: items.at(-1)?.eventId ?? after ?? null,
          timedOut: items.length === 0,
          pollAfterMs: 0
        });
      }
      await sleep(1_000);
    }
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function webhook(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const endpointId = parsePathParam(event, "endpointId");
    const endpoints = await queryEndpointsById(endpointId);
    if (endpoints.length === 0) {
      throw new ApiError(404, {
        code: "NOT_FOUND",
        message: "Linear webhook endpoint was not found"
      });
    }

    const bodyBytes = rawBodyFromEvent(event);
    const payload = bodyBytes.length ? (JSON.parse(bodyBytes.toString("utf8")) as LinearWebhookPayload) : {};
    const webhookTimestamp =
      typeof payload.webhookTimestamp === "number"
        ? payload.webhookTimestamp
        : typeof payload.webhookTimestamp === "string"
          ? Number(payload.webhookTimestamp)
          : null;
    const signature = normalizeHeader(event.headers, "linear-signature");
    const deliveryId = normalizeHeader(event.headers, "linear-delivery") || randomUUID();
    const entityType = normalizeHeader(event.headers, "linear-event") || (typeof payload.type === "string" ? payload.type : "unknown");
    const action = typeof payload.action === "string" ? payload.action : null;
    const issue = readIssueDetails(payload.data);
    const summary = buildSummary({
      entityType,
      action,
      issueIdentifier: issue.issueIdentifier,
      title: issue.title
    });
    const createdAt = nowIso();
    const expiresAt = Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60;

    let verifiedCount = 0;
    for (const endpointItem of endpoints) {
      try {
        verifyWebhookSignature({
          body: bodyBytes,
          signatureHeader: signature,
          secret: endpointItem.secret,
          webhookTimestamp: Number.isFinite(webhookTimestamp) ? webhookTimestamp : null
        });
      } catch (error) {
        if (endpoints.length === 1) {
          throw error;
        }
        continue;
      }

      verifiedCount += 1;
      const item: LinearEventItem = {
        projectId: endpointItem.projectId,
        eventId: `${createdAt}#${deliveryId}#${endpointItem.projectId}`,
        deliveryId,
        endpointId,
        entityType,
        action,
        issueId: issue.issueId,
        issueIdentifier: issue.issueIdentifier,
        teamId: issue.teamId,
        teamKey: issue.teamKey,
        summary,
        createdAt,
        webhookTimestamp: Number.isFinite(webhookTimestamp) ? webhookTimestamp : null,
        expiresAt
      };

      await ddb.send(
        new PutCommand({
          TableName: sharedEnv.linearEventsTableName,
          Item: item
        })
      );

      await ddb.send(
        new PutCommand({
          TableName: sharedEnv.linearWebhookEndpointsTableName,
          Item: {
            ...endpointItem,
            lastDeliveredAt: createdAt,
            updatedAt: createdAt
          }
        })
      );
    }

    if (verifiedCount === 0) {
      throw new ApiError(401, {
        code: "UNAUTHORIZED",
        message: "Webhook signature mismatch"
      });
    }

    return json(200, { ok: true, projectsMatched: verifiedCount });
  } catch (error) {
    return toApiResponse(error);
  }
}

async function createEndpoint(args: { userId: string; projectId: string }): Promise<LinearWebhookEndpointItem> {
  const now = nowIso();
  const item: LinearWebhookEndpointItem = {
    endpointId: randomUUID(),
    projectId: args.projectId,
    userId: args.userId,
    secret: createWebhookSecret(),
    createdAt: now,
    updatedAt: now
  };

  await ddb.send(
    new PutCommand({
      TableName: sharedEnv.linearWebhookEndpointsTableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(endpointId) and attribute_not_exists(projectId)"
    })
  );

  return item;
}

async function queryEndpointsById(endpointId: string): Promise<LinearWebhookEndpointItem[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: sharedEnv.linearWebhookEndpointsTableName,
      KeyConditionExpression: "endpointId = :eid",
      ExpressionAttributeValues: {
        ":eid": endpointId
      }
    })
  );
  return (res.Items ?? []) as LinearWebhookEndpointItem[];
}

async function queryEndpointsForProject(projectId: string): Promise<LinearWebhookEndpointItem[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: sharedEnv.linearWebhookEndpointsTableName,
      IndexName: "projectIndex",
      KeyConditionExpression: "projectId = :pid",
      ExpressionAttributeValues: {
        ":pid": projectId
      },
      ScanIndexForward: false
    })
  );
  return (res.Items ?? []) as LinearWebhookEndpointItem[];
}

function formatEvent(entry: LinearEventItem): Record<string, unknown> {
  return {
    eventId: entry.eventId,
    deliveryId: entry.deliveryId,
    endpointId: entry.endpointId,
    entityType: entry.entityType,
    action: entry.action,
    issueId: entry.issueId,
    issueIdentifier: entry.issueIdentifier,
    teamId: entry.teamId,
    teamKey: entry.teamKey,
    summary: entry.summary,
    createdAt: entry.createdAt,
    webhookTimestamp: entry.webhookTimestamp
  };
}
