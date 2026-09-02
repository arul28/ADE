/**
 * Structured Claude `/context` occupancy. Classify rows by `categories[].kind`
 * (`used` / `free` / `buffer` / `deferred`), never by matching the name string
 * `"free"` — the SDK docs say so, and a name match is a latent bug.
 */

export const CLAUDE_CONTEXT_CATEGORY_KINDS = ["used", "free", "buffer", "deferred"] as const;
export type ClaudeContextCategoryKind = (typeof CLAUDE_CONTEXT_CATEGORY_KINDS)[number];

export type ClaudeContextMcpServerUsage = {
  name: string;
  tokens: number;
};

export type ClaudeContextUsageCategory = {
  name: string;
  tokens: number;
  percentage: number;
  kind: ClaudeContextCategoryKind;
  color?: string;
  mcpServers?: ClaudeContextMcpServerUsage[];
};

export type ClaudeContextUsage = {
  categories: ClaudeContextUsageCategory[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens?: number;
  percentage: number;
  model?: string;
};

export function isClaudeContextCategoryKind(value: unknown): value is ClaudeContextCategoryKind {
  return typeof value === "string"
    && (CLAUDE_CONTEXT_CATEGORY_KINDS as readonly string[]).includes(value);
}

/**
 * Kind is authoritative. `isDeferred` is a fallback for older payloads that
 * never set `kind`. The category *name* is never consulted — a row named
 * "Free" with `kind: "used"` stays used.
 */
export function classifyClaudeContextCategory(category: {
  kind?: unknown;
  isDeferred?: unknown;
}): ClaudeContextCategoryKind {
  if (isClaudeContextCategoryKind(category.kind)) return category.kind;
  if (category.isDeferred === true) return "deferred";
  return "used";
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function readMcpServers(category: Record<string, unknown>): ClaudeContextMcpServerUsage[] {
  const fromArray = (raw: unknown): ClaudeContextMcpServerUsage[] => {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const name = typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : typeof record.serverName === "string" && record.serverName.trim()
          ? record.serverName.trim()
          : typeof record.server === "string" && record.server.trim()
            ? record.server.trim()
            : "";
      const tokens = nonNegativeInt(record.tokens ?? record.tokenCount);
      if (!name && tokens === 0) return [];
      return [{ name: name || "MCP", tokens }];
    });
  };
  const listed = fromArray(category.mcpServers ?? category.servers ?? category.mcp_servers);
  if (listed.length) return listed;
  const map = category.mcpServers ?? category.servers;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>).flatMap(([name, tokens]) => {
    const count = nonNegativeInt(tokens);
    if (!name.trim() && count === 0) return [];
    return [{ name: name.trim() || "MCP", tokens: count }];
  });
}

export function normalizeClaudeContextUsage(usage: {
  categories?: unknown;
  totalTokens?: unknown;
  maxTokens?: unknown;
  rawMaxTokens?: unknown;
  percentage?: unknown;
  model?: unknown;
} | null | undefined): ClaudeContextUsage {
  const totalTokens = nonNegativeInt(usage?.totalTokens);
  const maxTokens = nonNegativeInt(usage?.maxTokens);
  const denominator = maxTokens > 0 ? maxTokens : totalTokens > 0 ? totalTokens : 1;
  const rawCategories = Array.isArray(usage?.categories) ? usage.categories : [];
  const categories: ClaudeContextUsageCategory[] = rawCategories.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const category = raw as Record<string, unknown>;
    const name = typeof category.name === "string" ? category.name.trim() : "";
    const tokens = nonNegativeInt(category.tokens);
    if (!name.length && tokens === 0) return [];
    const kind = classifyClaudeContextCategory(category);
    const mcpServers = readMcpServers(category);
    return [{
      name: name || "Other",
      tokens,
      percentage: tokens > 0 ? (tokens / denominator) * 100 : 0,
      kind,
      ...(typeof category.color === "string" && category.color.trim().length
        ? { color: category.color.trim() }
        : {}),
      ...(mcpServers.length ? { mcpServers } : {}),
    }];
  });

  if (maxTokens > totalTokens && !categories.some((category) => category.kind === "free")) {
    const freeTokens = maxTokens - totalTokens;
    categories.push({
      name: "Free",
      tokens: freeTokens,
      percentage: maxTokens > 0 ? (freeTokens / maxTokens) * 100 : 0,
      kind: "free",
    });
  }

  const rawMaxTokens = nonNegativeInt(usage?.rawMaxTokens);
  return {
    categories,
    totalTokens,
    maxTokens,
    rawMaxTokens: rawMaxTokens > 0 ? rawMaxTokens : maxTokens,
    percentage: typeof usage?.percentage === "number" && Number.isFinite(usage.percentage)
      ? Math.max(0, Math.min(100, usage.percentage))
      : maxTokens > 0
        ? (totalTokens / maxTokens) * 100
        : 0,
    ...(typeof usage?.model === "string" && usage.model.trim().length
      ? { model: usage.model.trim() }
      : {}),
  };
}
