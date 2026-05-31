export const LINEAR_GRAPHQL_MAX_RETRIES = 10;

export type LinearGraphQLInput = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  maxRetries?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseMaxRetries(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error("--max-retries must be a number.");
  }
  return Math.max(0, Math.min(LINEAR_GRAPHQL_MAX_RETRIES, Math.floor(parsed)));
}

export function parseLinearGraphQLInput(raw: unknown): LinearGraphQLInput {
  if (!isRecord(raw)) {
    throw new Error("GraphQL input must be a JSON object.");
  }

  const query = optionalString(raw.query);
  if (!query) {
    throw new Error("GraphQL query is required.");
  }

  const variables = raw.variables;
  if (variables != null && !isRecord(variables)) {
    throw new Error("--variables-json must be a JSON object.");
  }

  const operationName = optionalString(raw.operationName);
  const maxRetries = parseMaxRetries(raw.maxRetries);

  return {
    query,
    ...(variables != null ? { variables } : {}),
    ...(operationName ? { operationName } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  };
}
