export type ProxySubscriptionProvider = "claude" | "codex";
export type ProxySubscriptionHarness = "claude" | "codex" | "opencode";

/**
 * The harnesses ADE can point at the proxy. Everything else reads its identity
 * from its own sign-in and takes no endpoint.
 *
 * Exported beside the type it narrows to, so a fourth proxy-capable harness is
 * one edit rather than two — a caller keeping its own copy of this set is how
 * `proxyEnvForSubscription` ends up being asked for a harness it will throw on.
 */
export const PROXY_SUBSCRIPTION_HARNESSES = ["claude", "codex", "opencode"] as const satisfies
  readonly ProxySubscriptionHarness[];

export function isProxySubscriptionHarness(harness: string): harness is ProxySubscriptionHarness {
  return (PROXY_SUBSCRIPTION_HARNESSES as readonly string[]).includes(harness);
}

export type ProxySubscriptionConnection = {
  port: number;
  apiKey: string;
  prefix: string;
  model: string;
};

export type ProxySubscriptionProviderConnection = ProxySubscriptionConnection & {
  provider: ProxySubscriptionProvider;
};

export type ProxySubscriptionHarnessConfig = ProxySubscriptionConnection & {
  harness: ProxySubscriptionHarness;
};

export type ProxySubscriptionEnvironment = {
  model: string;
  env: Record<string, string>;
  codexConfigToml?: string;
  opencodeProvider?: {
    baseURL: string;
    apiKey: string;
    model: string;
  };
};

function requireConnection(connection: ProxySubscriptionConnection): ProxySubscriptionConnection {
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65_535) {
    throw new Error("A subscription proxy port is required.");
  }
  for (const [field, value] of Object.entries(connection)) {
    if (field === "port") continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`A subscription proxy ${field} is required.`);
    }
  }
  return {
    port: connection.port,
    apiKey: connection.apiKey,
    prefix: connection.prefix,
    model: connection.model,
  };
}

/**
 * Build the harness-specific connection settings for a subscription login.
 * The provider connection form keeps the call site readable when the login
 * record already carries its provider; the three-argument form is convenient
 * for callers that keep provider and connection metadata separately.
 */
export function proxyEnvForSubscription(
  provider: ProxySubscriptionProviderConnection | ProxySubscriptionProvider,
  harness: ProxySubscriptionHarness | ProxySubscriptionHarnessConfig,
  connection?: ProxySubscriptionConnection,
): ProxySubscriptionEnvironment {
  const providerName = typeof provider === "string" ? provider : provider.provider;
  const harnessName = typeof harness === "string" ? harness : harness.harness;
  const rawConnection = typeof provider === "string"
    ? (typeof harness === "string" ? connection : harness)
    : provider;
  if (!rawConnection) throw new Error("A subscription proxy connection is required.");
  const resolved = requireConnection(rawConnection);
  const baseURL = `http://127.0.0.1:${resolved.port}/v1`;
  const model = `${resolved.prefix}/${resolved.model}`;

  if (providerName !== "claude" && providerName !== "codex") {
    throw new Error("A subscription proxy provider must be claude or codex.");
  }
  if (harnessName === "claude") {
    return {
      model,
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${resolved.port}`,
        ANTHROPIC_AUTH_TOKEN: resolved.apiKey,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_MODEL: model,
      },
    };
  }
  if (harnessName === "codex") {
    return {
      model,
      env: {},
      codexConfigToml: [
        "[model_providers.ade-proxy]",
        `base_url = \"${baseURL}\"`,
        'wire_api = "responses"',
        `experimental_bearer_token = \"${resolved.apiKey}\"`,
        "requires_openai_auth = true",
      ].join("\n"),
    };
  }
  if (harnessName === "opencode") {
    return {
      model,
      env: {},
      opencodeProvider: {
        baseURL,
        apiKey: resolved.apiKey,
        model,
      },
    };
  }
  throw new Error(`Unsupported subscription proxy harness: ${harnessName}`);
}
