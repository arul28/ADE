function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

export function normalizeCliMcpServers(
  provider: "claude" | "codex",
  mcpServers?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> | undefined {
  if (!mcpServers) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(mcpServers).map(([name, server]) => {
      if (typeof server !== "object" || server === null) {
        return [name, server];
      }

      const record = server as Record<string, unknown>;
      const { type, transport, ...rest } = record;

      if (provider === "codex") {
        const resolvedTransport = firstNonEmptyString(transport, type) ?? "stdio";
        return [name, { ...rest, transport: resolvedTransport }];
      }

      const resolvedType = firstNonEmptyString(type, transport)
        ?? (typeof rest.command === "string" && rest.command.trim().length > 0 ? "stdio" : undefined);
      return [name, resolvedType ? { ...rest, type: resolvedType } : { ...rest }];
    }),
  );
}
