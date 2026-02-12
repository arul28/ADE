import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { sharedEnv } from "./env";

type ErrorPayload = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export class ApiError extends Error {
  readonly statusCode: number;
  readonly payload: ErrorPayload;

  constructor(statusCode: number, payload: ErrorPayload) {
    super(payload.message);
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

function headers(contentType = "application/json"): Record<string, string> {
  const out: Record<string, string> = {
    "content-type": contentType,
    "cache-control": "no-store"
  };

  if (sharedEnv.corsOrigin) {
    out["access-control-allow-origin"] = sharedEnv.corsOrigin;
    out["access-control-allow-headers"] = "authorization,content-type";
    out["access-control-allow-methods"] = "GET,POST,DELETE,OPTIONS";
  }

  return out;
}

export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: headers(),
    body: JSON.stringify(body)
  };
}

export function noContent(): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 204,
    headers: headers()
  };
}

export function parseJsonBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) {
    throw new ApiError(400, {
      code: "VALIDATION_ERROR",
      message: "Request body is required"
    });
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(400, {
      code: "VALIDATION_ERROR",
      message: "Request body is not valid JSON"
    });
  }
}

export function parsePathParam(event: APIGatewayProxyEventV2, key: string): string {
  const value = event.pathParameters?.[key];
  if (!value || !value.trim()) {
    throw new ApiError(400, {
      code: "VALIDATION_ERROR",
      message: `Path parameter '${key}' is required`
    });
  }
  return value.trim();
}

export function toApiResponse(error: unknown): APIGatewayProxyStructuredResultV2 {
  if (error instanceof ApiError) {
    return json(error.statusCode, {
      error: error.payload
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return json(500, {
    error: {
      code: "INTERNAL_ERROR",
      message
    }
  });
}

export function createOptionsResponse(): APIGatewayProxyStructuredResultV2 {
  return noContent();
}
