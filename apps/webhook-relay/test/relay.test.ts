import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveProjectRelayAccessToken, handleRequest, signGitHubWebhookBody, type RelayEnv } from "../src/relay";

type StoredEvent = {
  event_seq: number;
  project_id: string;
  event_id: string;
  github_event: string;
  github_delivery: string | null;
  repository_full_name: string | null;
  installation_id: number | null;
  summary: string;
  payload_json: string;
  received_at: string;
};

type StoredAppRepository = {
  repository_key: string;
  repository_full_name: string;
  owner: string;
  name: string;
  installation_id: number | null;
  repository_selection: string | null;
  installed: number;
  last_seen_at: string;
  removed_at: string | null;
  source_event: string;
};

class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly db: FakeD1Database,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.values);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.all<T>(this.sql, this.values) };
  }

  async run(): Promise<{ success: boolean }> {
    this.db.run(this.sql, this.values);
    return { success: true };
  }
}

class FakeD1Database {
  events: StoredEvent[] = [];
  appRepositories: StoredAppRepository[] = [];
  nextEventSeq = 1;

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(sql, this);
  }

  first<T>(sql: string, values: unknown[]): T | null {
    if (sql.includes("json_extract(payload_json, '$.hook.events')")) {
      const ping = [...this.events].reverse().find((event) => event.github_event === "ping");
      if (!ping) return null;
      const payload = JSON.parse(ping.payload_json) as { hook?: { events?: unknown } };
      return {
        hook_events_json: JSON.stringify(Array.isArray(payload.hook?.events) ? payload.hook.events : []),
        received_at: ping.received_at,
      } as T;
    }
    if (sql.includes("where github_event = 'meta'")) {
      const meta = [...this.events].reverse().find((event) => event.github_event === "meta");
      return meta
        ? ({
            payload_json: meta.payload_json,
            received_at: meta.received_at,
          } as T)
        : null;
    }
    if (sql.includes("select event_id from github_events")) {
      const [projectId, eventId] = values;
      return (this.events.find((event) => event.project_id === projectId && event.event_id === eventId) ?? null) as T | null;
    }
    if (sql.includes("select rowid as event_seq, event_id from github_events")) {
      const [scope, eventId] = values;
      const scopeValue = String(scope);
      const repoScoped = sql.includes("repository_full_name") && !sql.includes("project_id = ?");
      const event = repoScoped
        ? this.events.find((entry) => entry.repository_full_name?.toLowerCase() === scopeValue && entry.event_id === eventId)
        : this.events.find((entry) => entry.project_id === scope && entry.event_id === eventId);
      return event ? ({ event_seq: event.event_seq, event_id: event.event_id } as T) : null;
    }
    if (sql.includes("from github_app_repositories")) {
      const [repositoryKey] = values;
      const row = this.appRepositories.find((entry) => entry.repository_key === repositoryKey);
      return row
        ? ({
            repository_full_name: row.repository_full_name,
            installation_id: row.installation_id,
            repository_selection: row.repository_selection,
            installed: row.installed,
            last_seen_at: row.last_seen_at,
            removed_at: row.removed_at,
          } as T)
        : null;
    }
    return null;
  }

  all<T>(sql: string, values: unknown[]): T[] {
    if (!sql.includes("from github_events")) return [];
    const [scope] = values;
    const repoScoped = sql.includes("repository_full_name") && !sql.includes("project_id = ?");
    let rows = repoScoped
      ? this.events.filter((event) => event.repository_full_name?.toLowerCase() === String(scope))
      : this.events.filter((event) => event.project_id === scope);
    let limit = Number(values[1]);
    if (sql.includes("rowid >")) {
      const [, eventSeq, requestedLimit] = values;
      rows = rows.filter((event) => event.event_seq > Number(eventSeq));
      limit = Number(requestedLimit);
    }
    return [...rows]
      .sort((left, right) => right.event_seq - left.event_seq)
      .slice(0, limit)
      .map((event) => ({
        event_seq: event.event_seq,
        event_id: event.event_id,
        github_event: event.github_event,
        github_delivery: event.github_delivery,
        repository_full_name: event.repository_full_name,
        summary: event.summary,
        payload_json: event.payload_json,
        received_at: event.received_at,
      } as T));
  }

  run(sql: string, values: unknown[]): void {
    if (sql.includes("insert into github_events")) {
      this.events.push({
        event_seq: this.nextEventSeq++,
        project_id: String(values[0]),
        event_id: String(values[1]),
        github_event: String(values[2]),
        github_delivery: values[3] == null ? null : String(values[3]),
        repository_full_name: values[4] == null ? null : String(values[4]),
        installation_id: values[5] == null ? null : Number(values[5]),
        summary: String(values[6]),
        payload_json: String(values[7]),
        received_at: String(values[8]),
      });
    }
    if (sql.includes("delete from github_events")) {
      const cutoff = String(values[0]);
      this.events = this.events.filter((event) => event.received_at >= cutoff);
    }
    if (sql.includes("insert into github_app_repositories")) {
      const row: StoredAppRepository = {
        repository_key: String(values[0]),
        repository_full_name: String(values[1]),
        owner: String(values[2]),
        name: String(values[3]),
        installation_id: values[4] == null ? null : Number(values[4]),
        repository_selection: values[5] == null ? null : String(values[5]),
        installed: sql.includes("values (?, ?, ?, ?, ?, ?, 0") ? 0 : 1,
        last_seen_at: String(values[6]),
        removed_at: sql.includes("values (?, ?, ?, ?, ?, ?, 0") ? String(values[7]) : null,
        source_event: String(sql.includes("values (?, ?, ?, ?, ?, ?, 0") ? values[8] : values[7]),
      };
      const index = this.appRepositories.findIndex((entry) => entry.repository_key === row.repository_key);
      if (index >= 0) {
        const previous = this.appRepositories[index]!;
        this.appRepositories[index] = {
          ...previous,
          ...row,
          installation_id: row.installation_id ?? previous.installation_id,
        };
      } else {
        this.appRepositories.push(row);
      }
    }
    if (sql.includes("update github_app_repositories")) {
      const [lastSeenAt, removedAt, sourceEvent, installationId] = values;
      this.appRepositories = this.appRepositories.map((entry) =>
        entry.installation_id === Number(installationId)
          ? {
              ...entry,
              installed: 0,
              last_seen_at: String(lastSeenAt),
              removed_at: String(removedAt),
              source_event: String(sourceEvent),
            }
          : entry
      );
    }
  }
}

async function projectAuthHeaders(projectId = "project-1"): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await deriveProjectRelayAccessToken("relay-token", projectId)}`,
  };
}

function githubAuthHeaders(token = "ghp_repo_token"): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
  };
}

function makeEnv(): RelayEnv & { DB: FakeD1Database } {
  return {
    DB: new FakeD1Database(),
    GITHUB_WEBHOOK_SECRET: "github-secret",
    RELAY_ACCESS_TOKEN: "relay-token",
  } as unknown as RelayEnv & { DB: FakeD1Database };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function generateTestPrivateKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const base64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").trim();
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

async function signedWebhookRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Request> {
  const raw = JSON.stringify(body);
  return new Request("https://relay.example.com/projects/project-1/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": await signGitHubWebhookBody("github-secret", raw),
      ...headers,
    },
    body: raw,
  });
}

describe("webhook relay", () => {
  function stubRepoAccess(token = "ghp_repo_token") {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/repos/owner/repo");
      expect(init?.headers).toEqual(expect.objectContaining({
        authorization: `Bearer ${token}`,
        "user-agent": "ADE GitHub Webhook Relay",
      }));
      return new Response(JSON.stringify({ full_name: "owner/repo" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("rejects unsigned GitHub webhook deliveries", async () => {
    const env = makeEnv();
    const response = await handleRequest(
      await signedWebhookRequest({ repository: { full_name: "owner/repo" } }, {
        "x-hub-signature-256": "sha256=wrong",
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(env.DB.events).toHaveLength(0);
  });

  it("rejects malformed GitHub webhook signatures before storing events", async () => {
    const env = makeEnv();
    const response = await handleRequest(
      await signedWebhookRequest({ repository: { full_name: "owner/repo" } }, {
        "x-hub-signature-256": "not-a-github-signature",
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(env.DB.events).toHaveLength(0);
  });

  it("rejects oversized GitHub webhook deliveries before storing events", async () => {
    const env = makeEnv();
    const response = await handleRequest(
      await signedWebhookRequest({ repository: { full_name: "owner/repo" } }, {
        "content-length": String(25 * 1024 * 1024 + 1),
      }),
      env,
    );

    expect(response.status).toBe(413);
    expect(env.DB.events).toHaveLength(0);
  });

  it("rejects oversized GitHub webhook content-length values that exceed safe integers", async () => {
    const env = makeEnv();
    const response = await handleRequest(
      await signedWebhookRequest({ repository: { full_name: "owner/repo" } }, {
        "content-length": "999999999999999999999999",
      }),
      env,
    );

    expect(response.status).toBe(413);
    expect(env.DB.events).toHaveLength(0);
  });

  it("stores signed GitHub deliveries and deduplicates delivery ids", async () => {
    const env = makeEnv();
    const body = {
      action: "opened",
      repository: { full_name: "owner/repo" },
      pull_request: { number: 42, title: "Wire webhook relay" },
    };

    const first = await handleRequest(await signedWebhookRequest(body), env);
    const duplicate = await handleRequest(await signedWebhookRequest(body), env);

    expect(first.status).toBe(202);
    expect(await first.json()).toEqual(expect.objectContaining({ ok: true, duplicate: false, eventId: "delivery-1" }));
    expect(await duplicate.json()).toEqual(expect.objectContaining({ ok: true, duplicate: true, eventId: "delivery-1" }));
    expect(env.DB.events).toHaveLength(1);
    expect(env.DB.events[0]).toEqual(expect.objectContaining({
      github_event: "pull_request",
      github_delivery: "delivery-1",
      repository_full_name: "owner/repo",
      summary: expect.stringContaining("#42"),
    }));
  });

  it("lists events after a cursor for ADE polling", async () => {
    const env = makeEnv();
    const first = await handleRequest(await signedWebhookRequest({ repository: { full_name: "owner/repo" } }), env);
    expect(first.status).toBe(202);

    await handleRequest(
      await signedWebhookRequest(
        { repository: { full_name: "owner/repo" }, pull_request: { number: 43, title: "Second" } },
        { "x-github-delivery": "delivery-2" },
      ),
      env,
    );

    const response = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/events?after=delivery-1", {
        headers: await projectAuthHeaders(),
      }),
      env,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      events: Array<{ eventId: string; cursor: string; payload: Record<string, unknown> }>;
      nextCursor: string;
    };
    expect(payload.events.map((event) => event.eventId)).toEqual(["delivery-2"]);
    expect(payload.nextCursor).toBe(payload.events[0]?.cursor);
    expect(payload.events[0]?.payload.pull_request).toEqual(expect.objectContaining({ number: 43 }));
  });

  it("lists repo events with the user's GitHub token", async () => {
    const env = makeEnv();
    await handleRequest(
      await signedWebhookRequest(
        { repository: { full_name: "owner/repo" }, pull_request: { number: 42, title: "First" } },
        { "x-github-delivery": "delivery-1" },
      ),
      env,
    );
    await handleRequest(
      await signedWebhookRequest(
        { repository: { full_name: "other/repo" }, pull_request: { number: 99, title: "Other" } },
        { "x-github-delivery": "delivery-other" },
      ),
      env,
    );
    await handleRequest(
      await signedWebhookRequest(
        { repository: { full_name: "owner/repo" }, pull_request: { number: 43, title: "Second" } },
        { "x-github-delivery": "delivery-2" },
      ),
      env,
    );
    const fetchMock = stubRepoAccess();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/events?after=seq:1", {
        headers: githubAuthHeaders(),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = await response.json() as { events: Array<{ eventId: string }>; nextCursor: string };
    expect(payload.events.map((event) => event.eventId)).toEqual(["delivery-2"]);
    expect(payload.nextCursor).toBe("seq:3");
  });

  it("uses a monotonic cursor so same-timestamp delivery ids cannot be skipped", async () => {
    const env = makeEnv();
    await handleRequest(
      await signedWebhookRequest(
        { repository: { full_name: "owner/repo" }, pull_request: { number: 1, title: "First" } },
        { "x-github-delivery": "delivery-z" },
      ),
      env,
    );
    await handleRequest(
      await signedWebhookRequest(
        { repository: { full_name: "owner/repo" }, pull_request: { number: 2, title: "Second" } },
        { "x-github-delivery": "delivery-a" },
      ),
      env,
    );

    const response = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/events?after=delivery-z", {
        headers: await projectAuthHeaders(),
      }),
      env,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { events: Array<{ eventId: string }> };
    expect(payload.events.map((event) => event.eventId)).toEqual(["delivery-a"]);
  });

  it("recovers when the client sends an expired cursor", async () => {
    const env = makeEnv();
    await handleRequest(await signedWebhookRequest({ repository: { full_name: "owner/repo" } }), env);

    const response = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/events?after=missing-cursor", {
        headers: await projectAuthHeaders(),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      cursorExpired: true,
      events: expect.arrayContaining([expect.objectContaining({ eventId: "delivery-1" })]),
      nextCursor: "seq:1",
    }));
  });

  it("requires the ADE relay token for event polling", async () => {
    const response = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/events"),
      makeEnv(),
    );

    expect(response.status).toBe(401);
  });

  it("requires GitHub repo access for repo-scoped event polling", async () => {
    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/events"),
      makeEnv(),
    );

    expect(response.status).toBe(401);
  });

  it("tracks GitHub App installation state per repository", async () => {
    const env = makeEnv();
    const missing = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/repos/owner/repo/status", {
        headers: await projectAuthHeaders(),
      }),
      env,
    );
    expect(await missing.json()).toEqual(expect.objectContaining({
      installed: false,
      state: "not_installed",
      installationId: null,
    }));

    const installationBody = {
      action: "created",
      installation: { id: 123, repository_selection: "all" },
      repositories: [{ full_name: "owner/repo", name: "repo" }],
    };
    const raw = JSON.stringify(installationBody);
    const installed = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "installation",
          "x-github-delivery": "installation-1",
          "x-hub-signature-256": await signGitHubWebhookBody("github-secret", raw),
        },
        body: raw,
      }),
      env,
    );
    expect(installed.status).toBe(202);

    const status = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/repos/owner/repo/status", {
        headers: await projectAuthHeaders(),
      }),
      env,
    );
    expect(await status.json()).toEqual(expect.objectContaining({
      installed: true,
      state: "configured",
      installationId: 123,
      repositorySelection: "all",
    }));
  });

  it("reports repo installation status through GitHub-token auth", async () => {
    const env = makeEnv();
    env.DB.appRepositories.push({
      repository_key: "owner/repo",
      repository_full_name: "owner/repo",
      owner: "owner",
      name: "repo",
      installation_id: 123,
      repository_selection: "selected",
      installed: 1,
      last_seen_at: "2026-06-30T00:00:00.000Z",
      removed_at: null,
      source_event: "installation",
    });
    const fetchMock = stubRepoAccess();
    vi.stubGlobal("fetch", fetchMock);

    const status = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/status", {
        headers: githubAuthHeaders(),
      }),
      env,
    );

    expect(status.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await status.json()).toEqual(expect.objectContaining({
      installed: true,
      state: "configured",
      installationId: 123,
      repositorySelection: "selected",
    }));
  });

  it("does not treat default install-status deliveries as missing selectable webhook events", async () => {
    const env = makeEnv();
    const pingBody = {
      hook: {
        events: ["pull_request", "status"],
      },
    };
    const raw = JSON.stringify(pingBody);
    await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "ping",
          "x-github-delivery": "ping-1",
          "x-hub-signature-256": await signGitHubWebhookBody("github-secret", raw),
        },
        body: raw,
      }),
      env,
    );

    const status = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/repos/owner/repo/status", {
        headers: await projectAuthHeaders(),
      }),
      env,
    );

    expect(await status.json()).toEqual(expect.objectContaining({
      webhookEvents: ["pull_request", "status"],
      missingWebhookEvents: [],
      webhookState: "active",
    }));
  });

  it("reports when GitHub says the App webhook was removed", async () => {
    const env = makeEnv();
    const metaBody = {
      action: "deleted",
      hook_id: 123,
    };
    const raw = JSON.stringify(metaBody);
    await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "meta",
          "x-github-delivery": "meta-1",
          "x-hub-signature-256": await signGitHubWebhookBody("github-secret", raw),
        },
        body: raw,
      }),
      env,
    );

    const status = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/repos/owner/repo/status", {
        headers: await projectAuthHeaders(),
      }),
      env,
    );

    expect(await status.json()).toEqual(expect.objectContaining({
      installed: false,
      state: "not_installed",
      webhookState: "deleted",
      webhookLastSeenAt: expect.any(String),
    }));
  });

  it("backfills repository install status from the GitHub App API when webhook state is missing", async () => {
    const env = {
      ...makeEnv(),
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: await generateTestPrivateKeyPem(),
      GITHUB_API_BASE_URL: "https://api.github.test",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.test/repos/owner/repo/installation");
      expect(init?.headers).toEqual(expect.objectContaining({
        accept: "application/vnd.github+json",
        authorization: expect.stringMatching(/^Bearer [-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/),
        "user-agent": "ADE GitHub Webhook Relay",
      }));
      return new Response(JSON.stringify({
        id: 456,
        repository_selection: "selected",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const status = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/repos/owner/repo/status", {
        headers: await projectAuthHeaders(),
      }),
      env,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await status.json()).toEqual(expect.objectContaining({
      installed: true,
      state: "configured",
      installationId: 456,
      repositorySelection: "selected",
    }));
    expect(env.DB.appRepositories).toEqual([
      expect.objectContaining({
        repository_key: "owner/repo",
        repository_full_name: "owner/repo",
        installation_id: 456,
        installed: 1,
        source_event: "github_app_api",
      }),
    ]);
  });

  it("marks repositories removed from an installation as not installed", async () => {
    const env = makeEnv();
    const addedBody = {
      action: "added",
      installation: { id: 123, repository_selection: "selected" },
      repository: { full_name: "owner/repo" },
    };
    const addedRaw = JSON.stringify(addedBody);
    await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "pr-1",
          "x-hub-signature-256": await signGitHubWebhookBody("github-secret", addedRaw),
        },
        body: addedRaw,
      }),
      env,
    );

    const removedBody = {
      action: "removed",
      installation: { id: 123, repository_selection: "selected" },
      repositories_removed: [{ full_name: "owner/repo", name: "repo" }],
    };
    const removedRaw = JSON.stringify(removedBody);
    await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "installation_repositories",
          "x-github-delivery": "installation-repos-1",
          "x-hub-signature-256": await signGitHubWebhookBody("github-secret", removedRaw),
        },
        body: removedRaw,
      }),
      env,
    );

    const status = await handleRequest(
      new Request("https://relay.example.com/projects/project-1/github/repos/owner/repo/status", {
        headers: await projectAuthHeaders(),
      }),
      env,
    );
    expect(await status.json()).toEqual(expect.objectContaining({
      installed: false,
      state: "not_installed",
      installationId: 123,
    }));
  });
});
