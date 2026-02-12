import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ApiError } from "./http";

function claimValue(claims: Record<string, unknown> | undefined, keys: string[]): string {
  if (!claims) return "";
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

export function getUserIdFromEvent(event: APIGatewayProxyEventV2): string {
  const context = event.requestContext as unknown as {
    authorizer?: {
      jwt?: {
        claims?: Record<string, unknown>;
      };
    };
  };

  const claims = context.authorizer?.jwt?.claims;
  const userId = claimValue(claims, ["sub", "user_id", "userId", "uid"]);
  if (!userId) {
    const claimKeys = claims ? Object.keys(claims).join(", ") : "";
    throw new ApiError(401, {
      code: "UNAUTHORIZED",
      message: claimKeys
        ? `Missing user identity claim in JWT (available claims: ${claimKeys})`
        : "Missing user identity claim in JWT"
    });
  }
  return userId;
}
