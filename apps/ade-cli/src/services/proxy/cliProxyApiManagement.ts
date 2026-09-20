export const CLI_PROXY_API_MANAGEMENT_TIMEOUT_MS = 15_000;

export type CliProxyApiQuota = {
  signals?: Record<string, string>;
  [key: string]: unknown;
};

export type CliProxyApiIdToken = {
  chatgpt_plan_type?: string;
  [key: string]: unknown;
};

export type CliProxyApiAuthFile = {
  id: string;
  auth_index: string;
  provider: string;
  email?: string | null;
  disabled: boolean;
  quota?: CliProxyApiQuota | null;
  cooldowns?: unknown;
  id_token?: CliProxyApiIdToken | null;
  [key: string]: unknown;
};

export type CliProxyApiAuthUrlResponse = {
  status: string;
  url?: string;
  state?: string;
  [key: string]: unknown;
};

export type CliProxyApiAuthStatusResponse = {
  status: string;
  error?: string;
  [key: string]: unknown;
};

export type CliProxyApiManagementResponse = {
  status: string;
  [key: string]: unknown;
};

export type CliProxyApiQuotaResponse = {
  [key: string]: unknown;
};

export type CliProxyApiCallResponse = {
  status_code: number;
  header: Record<string, string[]>;
  body: string;
};

export type CliProxyApiManagementClientOptions = {
  port: number;
  managementKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type CliProxyApiProvider = "claude" | "codex";

export type CliProxyApiCallInput = {
  authIndex?: string;
  method: string;
  url: string;
  header?: Record<string, string>;
  data?: string;
};

export class CliProxyApiHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    endpoint: string,
  ) {
    super(`CLIProxyAPI management request failed with HTTP ${statusCode}: ${endpoint}`);
    this.name = "CliProxyApiHttpError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function queryValue(value: string): string {
  return encodeURIComponent(value);
}

export class CliProxyApiManagementClient {
  private readonly baseUrl: string;
  private readonly managementKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CliProxyApiManagementClientOptions) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error("CLIProxyAPI management port must be an integer between 1 and 65535");
    }
    if (!options.managementKey) {
      throw new Error("CLIProxyAPI management key is required");
    }
    this.baseUrl = `http://127.0.0.1:${options.port}/v0/management`;
    this.managementKey = options.managementKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? CLI_PROXY_API_MANAGEMENT_TIMEOUT_MS;
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: string;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const hasBody = options.body !== undefined;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.managementKey}`,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw new CliProxyApiHttpError(response.status, endpoint);
      const text = await response.text();
      if (text.trim().length === 0) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`CLIProxyAPI management returned invalid JSON: ${endpoint}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async listAuthFiles(): Promise<CliProxyApiAuthFile[]> {
    const result = await this.request<unknown>("/auth-files");
    if (Array.isArray(result)) return result as CliProxyApiAuthFile[];
    if (isRecord(result) && Array.isArray(result.files)) {
      return result.files as CliProxyApiAuthFile[];
    }
    throw new Error("CLIProxyAPI management returned an invalid auth-files response");
  }

  async getAuthUrl(provider: CliProxyApiProvider): Promise<CliProxyApiAuthUrlResponse> {
    const endpoint = provider === "claude" ? "/anthropic-auth-url" : "/codex-auth-url";
    return this.request<CliProxyApiAuthUrlResponse>(endpoint);
  }

  async getAuthStatus(state: string): Promise<CliProxyApiAuthStatusResponse> {
    return this.request<CliProxyApiAuthStatusResponse>(`/get-auth-status?state=${queryValue(state)}`);
  }

  async deleteAuthFile(name: string): Promise<CliProxyApiManagementResponse> {
    return this.request<CliProxyApiManagementResponse>(`/auth-files?name=${queryValue(name)}`, {
      method: "DELETE",
    });
  }

  async patchAuthFileFields(args: { name: string; prefix: string }): Promise<CliProxyApiManagementResponse> {
    return this.request<CliProxyApiManagementResponse>("/auth-files/fields", {
      method: "PATCH",
      body: args,
    });
  }

  async setAuthFileStatus(args: { name: string; disabled: boolean }): Promise<CliProxyApiManagementResponse> {
    return this.request<CliProxyApiManagementResponse>("/auth-files/status", {
      method: "PATCH",
      body: args,
    });
  }

  async resetQuota(authIndex: string): Promise<CliProxyApiManagementResponse> {
    return this.request<CliProxyApiManagementResponse>("/reset-quota", {
      method: "POST",
      body: { auth_index: authIndex },
    });
  }

  async quotaFetch(authIndex: string): Promise<CliProxyApiQuotaResponse> {
    return this.request<CliProxyApiQuotaResponse>("/quota/fetch", {
      method: "POST",
      body: { auth_index: authIndex },
    });
  }

  async apiCall(args: CliProxyApiCallInput): Promise<CliProxyApiCallResponse> {
    const body: Record<string, unknown> = {
      auth_index: args.authIndex,
      method: args.method.toUpperCase(),
      url: args.url,
      header: args.header,
    };
    if (args.data !== undefined) body.data = args.data;
    return this.request<CliProxyApiCallResponse>("/api-call", {
      method: "POST",
      body,
    });
  }
}

export function createCliProxyApiManagementClient(
  options: CliProxyApiManagementClientOptions,
): CliProxyApiManagementClient {
  return new CliProxyApiManagementClient(options);
}
