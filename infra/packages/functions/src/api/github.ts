import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createHmac, randomUUID, timingSafeEqual, createSign } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, nowIso } from "../common/awsClients";
import { getUserIdFromEvent } from "../common/auth";
import { sharedEnv } from "../common/env";
import { ApiError, json, parseJsonBody, parsePathParam, toApiResponse } from "../common/http";
import { isRecord, optionalString, requireString } from "../common/validation";

type ProjectItem = {
  userId: string;
  projectId: string;
  name: string;
  repoUrl?: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  blobCount: number;
  totalSize: number;
  githubInstallationId?: string;
  githubConnectedAt?: string;
};

type ConnectStateItem = {
  state: string;
  userId: string;
  projectId: string;
  createdAt: string;
  expiresAt: number;
};

type InstallationItem = {
  installationId: string;
  projectId: string;
  userId: string;
  connectedAt: string;
};

type GitHubEventItem = {
  projectId: string;
  eventId: string;
  deliveryId: string;
  installationId: string;
  githubEvent: string;
  action: string | null;
  repoFullName: string | null;
  prNumber: number | null;
  summary: string;
  createdAt: string;
  expiresAt: number;
};

function normalizeHeader(headers: Record<string, string | undefined> | undefined, key: string): string {
  if (!headers) return "";
  const needle = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === needle && typeof v === "string") return v.trim();
  }
  return "";
}

function rawBodyFromEvent(event: APIGatewayProxyEventV2): Buffer {
  if (!event.body) return Buffer.from("");
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
}

function html(statusCode: number, body: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    },
    body
  };
}

function ensureGithubAppConfigured(): { appId: string; appSlug: string; privateKeyPem: string } {
  const appId = (sharedEnv.githubAppId ?? "").trim();
  const appSlug = (sharedEnv.githubAppSlug ?? "").trim();
  const pkB64 = (sharedEnv.githubAppPrivateKeyBase64 ?? "").trim();
  if (!appId || !appSlug || !pkB64) {
    throw new ApiError(501, {
      code: "GITHUB_APP_NOT_CONFIGURED",
      message:
        "GitHub App is not configured. Set GITHUB_APP_ID, GITHUB_APP_SLUG, and GITHUB_APP_PRIVATE_KEY_BASE64 in the API environment."
    });
  }

  const maybePem = pkB64.includes("BEGIN ") ? pkB64 : Buffer.from(pkB64, "base64").toString("utf8");
  if (!/BEGIN (?:RSA )?PRIVATE KEY/.test(maybePem)) {
    throw new ApiError(500, {
      code: "GITHUB_APP_KEY_INVALID",
      message: "GITHUB_APP_PRIVATE_KEY_BASE64 did not decode to a PEM private key."
    });
  }

  return { appId, appSlug, privateKeyPem: maybePem };
}

function base64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signJwtRs256(args: { appId: string; privateKeyPem: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: now - 30,
      exp: now + 9 * 60,
      iss: args.appId
    })
  );
  const data = `${header}.${payload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const sig = signer.sign(args.privateKeyPem);
  return `${data}.${base64Url(sig)}`;
}

const installationTokenCache = new Map<string, { token: string; expiresAtMs: number }>();

async function getInstallationToken(installationId: string): Promise<string> {
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAtMs - Date.now() > 60_000) {
    return cached.token;
  }

  const { appId, privateKeyPem } = ensureGithubAppConfigured();
  const jwt = signJwtRs256({ appId, privateKeyPem });

  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "ade-cloud-api"
    }
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(response.status, {
      code: "GITHUB_INSTALLATION_TOKEN_FAILED",
      message: (typeof payload.message === "string" && payload.message.trim()) ? payload.message.trim() : `Failed to mint installation token (HTTP ${response.status})`
    });
  }

  const token = typeof payload.token === "string" ? payload.token : "";
  const expiresAt = typeof payload.expires_at === "string" ? payload.expires_at : "";
  if (!token || !expiresAt) {
    throw new ApiError(500, {
      code: "GITHUB_INSTALLATION_TOKEN_INVALID",
      message: "GitHub returned an invalid installation token payload."
    });
  }

  const expiresAtMs = Date.parse(expiresAt);
  installationTokenCache.set(installationId, { token, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 55 * 60_000 });

  return token;
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

export async function connectStart(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const { appSlug } = ensureGithubAppConfigured();

    const createdAt = nowIso();
    const state = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;

    const item: ConnectStateItem = {
      state,
      userId,
      projectId,
      createdAt,
      expiresAt
    };

    await ddb.send(
      new PutCommand({
        TableName: sharedEnv.githubConnectStatesTableName,
        Item: item
      })
    );

    const installUrl = `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`;

    return json(200, {
      installUrl,
      state,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      callbackUrl: "/github/connect/callback"
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function connectCallback(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const state = optionalString(event.queryStringParameters?.state) ?? "";
  const installationId = optionalString(event.queryStringParameters?.installation_id) ?? "";

  if (!state || !installationId) {
    return html(
      400,
      `<h2>ADE GitHub App</h2><p>Missing required query parameters.</p><p>Return to ADE and retry the connection flow.</p>`
    );
  }

  try {
    const lookup = await ddb.send(
      new GetCommand({
        TableName: sharedEnv.githubConnectStatesTableName,
        Key: { state }
      })
    );

    const item = lookup.Item as ConnectStateItem | undefined;
    if (!item) {
      return html(
        410,
        `<h2>ADE GitHub App</h2><p>This connection link has expired or was already used.</p><p>Return to ADE and start the connection again.</p>`
      );
    }

    if (typeof item.expiresAt !== "number" || item.expiresAt * 1000 < Date.now()) {
      return html(
        410,
        `<h2>ADE GitHub App</h2><p>This connection link has expired.</p><p>Return to ADE and start the connection again.</p>`
      );
    }

    const connectedAt = nowIso();

    await ddb.send(
      new UpdateCommand({
        TableName: sharedEnv.projectsTableName,
        Key: { userId: item.userId, projectId: item.projectId },
        UpdateExpression: "set githubInstallationId = :iid, githubConnectedAt = :connectedAt, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":iid": installationId,
          ":connectedAt": connectedAt,
          ":updatedAt": connectedAt
        }
      })
    );

    const installItem: InstallationItem = {
      installationId,
      projectId: item.projectId,
      userId: item.userId,
      connectedAt
    };

    await ddb.send(
      new PutCommand({
        TableName: sharedEnv.githubInstallationsTableName,
        Item: installItem
      })
    );

    await ddb.send(
      new DeleteCommand({
        TableName: sharedEnv.githubConnectStatesTableName,
        Key: { state }
      })
    );

    return html(
      200,
      `<h2>ADE GitHub App</h2><p>Connected successfully.</p><p>You can now return to ADE.</p>`
    );
  } catch (error) {
    console.error("[github.connectCallback] failed", error);
    return html(
      500,
      `<h2>ADE GitHub App</h2><p>Something went wrong while completing setup.</p><p>Return to ADE and try again.</p>`
    );
  }
}

export async function getStatus(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    const project = await getProjectForUser({ userId, projectId });

    const configured = Boolean((sharedEnv.githubAppId ?? "").trim() && (sharedEnv.githubAppSlug ?? "").trim() && (sharedEnv.githubAppPrivateKeyBase64 ?? "").trim());
    const connected = Boolean((project.githubInstallationId ?? "").trim());

    return json(200, {
      configured,
      connected,
      installationId: connected ? project.githubInstallationId : null,
      connectedAt: connected ? (project.githubConnectedAt ?? null) : null,
      appSlug: (sharedEnv.githubAppSlug ?? "").trim() || null
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function disconnect(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    const project = await getProjectForUser({ userId, projectId });
    const installationId = (project.githubInstallationId ?? "").trim();

    await ddb.send(
      new UpdateCommand({
        TableName: sharedEnv.projectsTableName,
        Key: { userId, projectId },
        UpdateExpression: "remove githubInstallationId, githubConnectedAt set updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":updatedAt": nowIso()
        }
      })
    );

    if (installationId) {
      await ddb.send(
        new DeleteCommand({
          TableName: sharedEnv.githubInstallationsTableName,
          Key: { installationId, projectId }
        })
      ).catch(() => {});
    }

    return json(200, {
      disconnected: true
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function proxy(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    const project = await getProjectForUser({ userId, projectId });

    const installationId = (project.githubInstallationId ?? "").trim();
    if (!installationId) {
      throw new ApiError(400, {
        code: "GITHUB_NOT_CONNECTED",
        message: "GitHub App is not connected for this project."
      });
    }

    const body = parseJsonBody<Record<string, unknown>>(event);
    const methodRaw = requireString(body.method, "method").toUpperCase();
    const pathRaw = requireString(body.path, "path");
    const query = isRecord(body.query) ? body.query : undefined;
    const requestBody = body.body;

    const method = methodRaw === "GET" || methodRaw === "POST" || methodRaw === "PATCH" || methodRaw === "PUT" || methodRaw === "DELETE"
      ? methodRaw
      : null;
    if (!method) {
      throw new ApiError(400, {
        code: "VALIDATION_ERROR",
        message: `Unsupported method '${methodRaw}'`
      });
    }

    const path = pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`;
    if (!path.startsWith("/repos/") && !path.startsWith("/app/")) {
      throw new ApiError(400, {
        code: "VALIDATION_ERROR",
        message: "GitHub proxy path must start with /repos/ or /app/"
      });
    }

    const url = new URL(`https://api.github.com${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v == null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const token = await getInstallationToken(installationId);

    const response = await fetch(url.toString(), {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": requestBody != null ? "application/json" : "text/plain",
        "user-agent": "ade-cloud-api"
      },
      body: requestBody != null ? JSON.stringify(requestBody) : undefined
    });

    const text = await response.text();
    let data: unknown = text;
    try {
      data = text.trim().length ? JSON.parse(text) : {};
    } catch {
      // leave as text
    }

    if (!response.ok) {
      const message = isRecord(data) && typeof data.message === "string" && data.message.trim().length
        ? data.message.trim()
        : `GitHub API request failed (HTTP ${response.status})`;
      throw new ApiError(response.status, {
        code: "GITHUB_ERROR",
        message,
        details: {
          status: response.status,
          path,
          method
        }
      });
    }

    return json(200, { data });
  } catch (error) {
    return toApiResponse(error);
  }
}

export async function listEvents(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const userId = getUserIdFromEvent(event);
    const projectId = parsePathParam(event, "id");
    await getProjectForUser({ userId, projectId });

    const res = await ddb.send(
      new QueryCommand({
        TableName: sharedEnv.githubEventsTableName,
        KeyConditionExpression: "projectId = :pid",
        ExpressionAttributeValues: {
          ":pid": projectId
        },
        ScanIndexForward: false,
        Limit: 50
      })
    );

    const items = (res.Items ?? []) as GitHubEventItem[];
    return json(200, {
      events: items.map((entry) => ({
        eventId: entry.eventId,
        githubEvent: entry.githubEvent,
        action: entry.action,
        repoFullName: entry.repoFullName,
        prNumber: entry.prNumber,
        summary: entry.summary,
        createdAt: entry.createdAt
      }))
    });
  } catch (error) {
    return toApiResponse(error);
  }
}

function verifyWebhookSignature(args: { body: Buffer; signatureHeader: string; secret: string }): void {
  const sig = args.signatureHeader.trim();
  if (!sig.startsWith("sha256=")) {
    throw new ApiError(401, {
      code: "UNAUTHORIZED",
      message: "Missing or invalid webhook signature"
    });
  }

  const expectedDigest = createHmac("sha256", args.secret).update(args.body).digest("hex");
  const expected = `sha256=${expectedDigest}`;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApiError(401, {
      code: "UNAUTHORIZED",
      message: "Webhook signature mismatch"
    });
  }
}

export async function webhook(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const secret = (sharedEnv.githubWebhookSecret ?? "").trim();
    if (!secret) {
      throw new ApiError(501, {
        code: "GITHUB_WEBHOOK_NOT_CONFIGURED",
        message: "Webhook secret not configured."
      });
    }

    const bodyBytes = rawBodyFromEvent(event);
    const signature = normalizeHeader(event.headers, "x-hub-signature-256");
    verifyWebhookSignature({ body: bodyBytes, signatureHeader: signature, secret });

    const payload = bodyBytes.length ? JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown> : {};
    const githubEvent = normalizeHeader(event.headers, "x-github-event") || "unknown";
    const deliveryId = normalizeHeader(event.headers, "x-github-delivery") || randomUUID();

    const installationIdRaw =
      isRecord(payload.installation) && (payload.installation as any).id != null
        ? String((payload.installation as any).id)
        : "";
    const installationId = installationIdRaw.trim();
    if (!installationId) {
      // Not all events include installation context; nothing to do.
      return json(200, { ok: true });
    }

    const action = typeof payload.action === "string" ? payload.action : null;
    const repoFullName =
      isRecord(payload.repository) && typeof (payload.repository as any).full_name === "string"
        ? String((payload.repository as any).full_name)
        : null;

    const prNumber =
      isRecord(payload.pull_request) && typeof (payload.pull_request as any).number === "number"
        ? Number((payload.pull_request as any).number)
        : null;

    const summaryParts: string[] = [];
    summaryParts.push(githubEvent);
    if (action) summaryParts.push(action);
    if (repoFullName) summaryParts.push(repoFullName);
    if (prNumber != null) summaryParts.push(`#${prNumber}`);
    const summary = summaryParts.join(" · ");

    const createdAt = nowIso();
    const expiresAt = Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60;

    const installs = await ddb.send(
      new QueryCommand({
        TableName: sharedEnv.githubInstallationsTableName,
        KeyConditionExpression: "installationId = :iid",
        ExpressionAttributeValues: {
          ":iid": installationId
        }
      })
    );

    const installationItems = (installs.Items ?? []) as InstallationItem[];
    for (const install of installationItems) {
      const eventId = `${createdAt}#${deliveryId}`;
      const item: GitHubEventItem = {
        projectId: install.projectId,
        eventId,
        deliveryId,
        installationId,
        githubEvent,
        action,
        repoFullName,
        prNumber,
        summary,
        createdAt,
        expiresAt
      };

      await ddb.send(
        new PutCommand({
          TableName: sharedEnv.githubEventsTableName,
          Item: item
        })
      ).catch((err) => {
        console.error("[github.webhook] failed to write event", err);
      });
    }

    return json(200, { ok: true });
  } catch (error) {
    return toApiResponse(error);
  }
}

