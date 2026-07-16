import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubRepoAuthCacheForTests,
  deriveProjectRelayAccessToken,
  handleRequest,
  signGitHubWebhookBody,
  type RelayEnv,
} from "../src/relay";
import { RepoEventsDurableObject } from "../src/repoEventsDurableObject";

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
    let limit = Number(values.at(-1));
    if (sql.includes("rowid >")) {
      const eventSeq = values.at(-2);
      rows = rows.filter((event) => event.event_seq > Number(eventSeq));
    }
    return [...rows]
      .sort((left, right) => sql.includes("order by rowid asc")
        ? left.event_seq - right.event_seq
        : right.event_seq - left.event_seq)
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
    REPO_EVENTS: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => ({
        fetch: async () => new Response(null, { status: 202 }),
      }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
    GITHUB_WEBHOOK_SECRET: "github-secret",
    RELAY_ACCESS_TOKEN: "relay-token",
  } as unknown as RelayEnv & { DB: FakeD1Database };
}

afterEach(() => {
  vi.useRealTimers();
  clearGitHubRepoAuthCacheForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    return stubRepoAccessWithPermissions({ admin: false, push: true, pull: true }, token);
  }

  function stubRepoAccessWithPermissions(permissions: Record<string, boolean>, token = "ghp_repo_token") {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/repos/owner/repo");
      expect(init?.headers).toEqual(expect.objectContaining({
        authorization: `Bearer ${token}`,
        "user-agent": "ADE GitHub Webhook Relay",
      }));
      return new Response(JSON.stringify({ full_name: "owner/repo", permissions }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  // A valid GitHub token whose access to the repo is denied by GitHub
  // (403 forbidden / 404 not-found-to-this-token). The relay must refuse
  // and must not leak stored webhook events.
  function stubRepoAccessDenied(githubStatus: 403 | 404 = 403) {
    return vi.fn(async () => new Response(
      JSON.stringify({ message: "Not Found" }),
      { status: githubStatus, headers: { "content-type": "application/json" } },
    ));
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

  it("keeps the committed webhook successful when the repo wake-up fails", async () => {
    const env = makeEnv();
    const notifyFetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId);
    env.REPO_EVENTS = {
      idFromName,
      get: vi.fn(() => ({ fetch: notifyFetch }) as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await handleRequest(
      await signedWebhookRequest({ repository: { full_name: "Owner/Repo" } }),
      env,
    );

    expect(response.status).toBe(202);
    expect(env.DB.events).toHaveLength(1);
    expect(idFromName).toHaveBeenCalledWith("owner/repo");
    expect(notifyFetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("github_repo_notify_failed"));
  });

  it("slims check_run reports while preserving every field ADE consumes", async () => {
    const env = makeEnv();
    const body = {
      action: "completed",
      repository: {
        full_name: "owner/repo",
        name: "repo",
        owner: { login: "owner", avatar_url: "https://avatars.example/owner" },
      },
      installation: { id: 123, repository_selection: "selected" },
      organization: { login: "acme", avatar_url: "https://avatars.example/org" },
      enterprise: { slug: "acme-enterprise", avatar_url: "https://avatars.example/enterprise" },
      sender: { login: "octocat", avatar_url: "https://avatars.example/sender" },
      check_run: {
        id: 987,
        name: "build",
        head_sha: "abc123",
        status: "completed",
        conclusion: "success",
        details_url: "https://github.example/checks/987",
        pull_requests: [{ number: 42, base: { repo: { full_name: "owner/repo" } } }],
        output: {
          title: "Build output",
          summary: "A long markdown summary",
          text: "A very long log body",
          annotations: [{ path: "src/index.ts", message: "warning" }],
        },
      },
    };

    const response = await handleRequest(
      await signedWebhookRequest(body, {
        "x-github-event": "check_run",
        "x-github-delivery": "check-run-1",
      }),
      env,
    );

    expect(response.status).toBe(202);
    const stored = JSON.parse(env.DB.events[0]!.payload_json) as Record<string, any>;
    expect(stored).toEqual(expect.objectContaining({
      action: "completed",
      repository: body.repository,
      installation: body.installation,
      check_run: expect.objectContaining({
        id: 987,
        name: "build",
        head_sha: "abc123",
        status: "completed",
        conclusion: "success",
        details_url: "https://github.example/checks/987",
        pull_requests: body.check_run.pull_requests,
      }),
    }));
    expect(stored.check_run.output).toBeUndefined();
    expect(stored.organization).toBeUndefined();
    expect(stored.enterprise).toBeUndefined();
    expect(stored.sender).toBeUndefined();
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

  it("drains a 150-event repo burst in ascending cursor pages without gaps", async () => {
    const env = makeEnv();
    for (let index = 1; index <= 150; index += 1) {
      env.DB.run("insert into github_events", [
        "github-app",
        `delivery-${index}`,
        "check_run",
        `delivery-${index}`,
        "owner/repo",
        123,
        `GitHub check_run ${index}`,
        JSON.stringify({
          action: "completed",
          repository: { full_name: "owner/repo" },
          check_run: { id: index, name: "build", head_sha: `sha-${index}`, pull_requests: [] },
        }),
        new Date(1_750_000_000_000 + index).toISOString(),
      ]);
    }
    const fetchMock = stubRepoAccess();
    vi.stubGlobal("fetch", fetchMock);

    let cursor = "seq:0";
    let hasMore = true;
    const received: Array<{ id: string; cursor: string }> = [];
    while (hasMore) {
      const url = new URL("https://relay.example.com/github/repos/owner/repo/events");
      url.searchParams.set("after", cursor);
      url.searchParams.set("order", "asc");
      url.searchParams.set("limit", "100");
      const response = await handleRequest(new Request(url, { headers: githubAuthHeaders() }), env);
      expect(response.status).toBe(200);
      const page = await response.json() as {
        events: Array<{ eventId: string; cursor: string }>;
        nextCursor: string;
        hasMore: boolean;
      };
      received.push(...page.events.map((event) => ({ id: event.eventId, cursor: event.cursor })));
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }

    expect(received.map((event) => event.id)).toEqual(
      Array.from({ length: 150 }, (_, index) => `delivery-${index + 1}`),
    );
    expect(received.map((event) => event.cursor)).toEqual(
      Array.from({ length: 150 }, (_, index) => `seq:${index + 1}`),
    );
    expect(cursor).toBe("seq:150");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses positive repo authorization for polls and subscriptions but never caches denials", async () => {
    const env = makeEnv();
    const subscriptionFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId);
    env.REPO_EVENTS = {
      idFromName,
      get: vi.fn(() => ({ fetch: subscriptionFetch }) as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;
    const authorizedFetch = stubRepoAccess();
    vi.stubGlobal("fetch", authorizedFetch);

    const poll = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/events", { headers: githubAuthHeaders() }),
      env,
    );
    const subscribe = await handleRequest(
      new Request("https://relay.example.com/github/repos/OWNER/Repo/subscribe", {
        headers: { ...githubAuthHeaders(), upgrade: "websocket" },
      }),
      env,
    );

    expect(poll.status).toBe(200);
    expect(subscribe.status).toBe(204);
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(idFromName).toHaveBeenCalledWith("owner/repo");
    expect(subscriptionFetch).toHaveBeenCalledTimes(1);

    clearGitHubRepoAuthCacheForTests();
    const deniedFetch = stubRepoAccessDenied();
    vi.stubGlobal("fetch", deniedFetch);
    const deniedRequest = () => new Request("https://relay.example.com/github/repos/owner/repo/events", {
      headers: githubAuthHeaders("ghp_denied"),
    });
    expect((await handleRequest(deniedRequest(), env)).status).toBe(403);
    expect((await handleRequest(deniedRequest(), env)).status).toBe(403);
    expect(deniedFetch).toHaveBeenCalledTimes(2);
  });

  it("refuses repo events when the token is valid but denied access to the repo", async () => {
    const env = makeEnv();
    await handleRequest(
      await signedWebhookRequest(
        { repository: { full_name: "owner/repo" }, pull_request: { number: 42, title: "Secret" } },
        { "x-github-delivery": "delivery-1" },
      ),
      env,
    );
    const fetchMock = stubRepoAccessDenied(403);
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/events", {
        headers: githubAuthHeaders("ghp_unauthorized_token"),
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await response.json() as { ok: boolean; events?: unknown };
    expect(body.ok).toBe(false);
    // The denied caller must never receive the stored webhook stream.
    expect(body.events).toBeUndefined();
  });

  it("refuses repo events when the token only has read access to the repo", async () => {
    const env = makeEnv();
    await handleRequest(
      await signedWebhookRequest(
        { repository: { full_name: "owner/repo" }, pull_request: { number: 42, title: "Secret" } },
        { "x-github-delivery": "delivery-1" },
      ),
      env,
    );
    const fetchMock = stubRepoAccessWithPermissions({ admin: false, push: false, pull: true }, "ghp_readonly_token");
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/events", {
        headers: githubAuthHeaders("ghp_readonly_token"),
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await response.json() as { ok: boolean; events?: unknown };
    expect(body.ok).toBe(false);
    expect(body.events).toBeUndefined();
  });

  it("authorizes repo events via the collaborator-permission fallback when the repo payload has no permissions field", async () => {
    const env = makeEnv();
    await handleRequest(
      await signedWebhookRequest(
        { repository: { full_name: "owner/repo" }, pull_request: { number: 42, title: "Visible" } },
        { "x-github-delivery": "delivery-fallback-1" },
      ),
      env,
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/owner/repo") {
        return new Response(JSON.stringify({ full_name: "owner/repo" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ login: "collab-user" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/repos/owner/repo/collaborators/collab-user/permission") {
        return new Response(JSON.stringify({ permission: "write" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/events", {
        headers: githubAuthHeaders("ghu_app_user_token"),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body = await response.json() as { events: Array<{ summary: string }> };
    expect(body.events).toHaveLength(1);
  });

  it("refuses repo events via the collaborator-permission fallback when the user only has read", async () => {
    const env = makeEnv();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/owner/repo") {
        return new Response(JSON.stringify({ full_name: "owner/repo" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ login: "reader-user" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/repos/owner/repo/collaborators/reader-user/permission") {
        return new Response(JSON.stringify({ permission: "read" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/events", {
        headers: githubAuthHeaders("ghu_readonly_app_token"),
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body = await response.json() as { ok: boolean; events?: unknown };
    expect(body.ok).toBe(false);
    expect(body.events).toBeUndefined();
  });

  it("refuses repo status when the token is valid but denied access to the repo", async () => {
    const env = makeEnv();
    const fetchMock = stubRepoAccessDenied(404);
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/status", {
        headers: githubAuthHeaders("ghp_unauthorized_token"),
      }),
      env,
    );

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await response.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("refuses repo status when the token only has read access to the repo", async () => {
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
    const fetchMock = stubRepoAccessWithPermissions({ admin: false, push: false, pull: true }, "ghp_readonly_token");
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/status", {
        headers: githubAuthHeaders("ghp_readonly_token"),
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await response.json() as { ok: boolean; installed?: unknown };
    expect(body.ok).toBe(false);
    expect(body.installed).toBeUndefined();
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

  it("reports repo installation status for an admin token", async () => {
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
    const fetchMock = stubRepoAccessWithPermissions({ admin: true, push: true, pull: true }, "ghp_admin_token");
    vi.stubGlobal("fetch", fetchMock);

    const status = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/status", {
        headers: githubAuthHeaders("ghp_admin_token"),
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

  it("requires a GitHub token to heal the webhook secret", async () => {
    const env = makeEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/webhook/heal", { method: "POST" }),
      env,
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses webhook heal for tokens without admin access", async () => {
    const env = makeEnv();
    env.GITHUB_APP_ID = "4180227";
    env.GITHUB_APP_PRIVATE_KEY = await generateTestPrivateKeyPem();
    const fetchMock = stubRepoAccessWithPermissions({ admin: false, push: true, pull: true });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/webhook/heal", {
        method: "POST",
        headers: githubAuthHeaders(),
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("heals the GitHub App webhook secret to the worker's current secret", async () => {
    const env = makeEnv();
    env.GITHUB_APP_ID = "4180227";
    env.GITHUB_APP_PRIVATE_KEY = await generateTestPrivateKeyPem();
    let patchedBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/owner/repo") {
        return new Response(JSON.stringify({ id: 4242, full_name: "owner/repo", permissions: { admin: true, push: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/repos/owner/repo/installation") {
        expect(String((init?.headers as Record<string, string>)?.authorization)).toMatch(/^Bearer eyJ/);
        return new Response(JSON.stringify({ id: 123, repository_selection: "selected" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/app/hook/config") {
        expect(init?.method).toBe("PATCH");
        expect(String((init?.headers as Record<string, string>)?.authorization)).toMatch(/^Bearer eyJ/);
        patchedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ url: "https://relay.example.com/github/webhook", content_type: "json" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/webhook/heal", {
        method: "POST",
        headers: githubAuthHeaders(),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(patchedBody).toEqual({ secret: "github-secret" });
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      healed: true,
      webhookUrl: "https://relay.example.com/github/webhook",
    }));
  });

  it("refuses webhook heal when the app is not installed on the repository", async () => {
    const env = makeEnv();
    env.GITHUB_APP_ID = "4180227";
    env.GITHUB_APP_PRIVATE_KEY = await generateTestPrivateKeyPem();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/owner/repo") {
        return new Response(JSON.stringify({ id: 4242, full_name: "owner/repo", permissions: { admin: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/repos/owner/repo/installation") {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/webhook/heal", {
        method: "POST",
        headers: githubAuthHeaders(),
      }),
      env,
    );

    expect(response.status).toBe(409);
    const body = await response.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("lists webhook deliveries filtered to the requested repository", async () => {
    const env = makeEnv();
    env.GITHUB_APP_ID = "4180227";
    env.GITHUB_APP_PRIVATE_KEY = await generateTestPrivateKeyPem();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/owner/repo") {
        return new Response(JSON.stringify({ id: 4242, full_name: "owner/repo", permissions: { admin: false, push: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.github.com/app/hook/deliveries")) {
        // The GitHub fetch always pulls the max page; the caller's `limit`
        // applies to the repo-filtered output instead.
        expect(url).toBe("https://api.github.com/app/hook/deliveries?per_page=100");
        expect(String((init?.headers as Record<string, string>)?.authorization)).toMatch(/^Bearer eyJ/);
        return new Response(JSON.stringify([
          { id: 1, guid: "g-1", event: "pull_request", action: "closed", status: "Invalid HTTP Response: 401", status_code: 401, delivered_at: "2026-07-02T00:00:00Z", redelivery: false, repository_id: 4242, installation_id: 123 },
          { id: 2, guid: "g-2", event: "pull_request", action: "opened", status: "OK", status_code: 202, delivered_at: "2026-07-02T00:01:00Z", redelivery: false, repository_id: 999, installation_id: 456 },
          { id: 3, guid: "g-3", event: "ping", action: null, status: "OK", status_code: 202, delivered_at: "2026-06-30T00:00:00Z", redelivery: false, repository_id: null, installation_id: null },
          // Repo-scoped but with an unprovable repo id — must fail closed.
          { id: 4, guid: "g-4", event: "pull_request", action: "closed", status: "OK", status_code: 202, delivered_at: "2026-07-02T00:02:00Z", redelivery: false, repository_id: "not-a-number", installation_id: 789 },
        ]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/webhook/deliveries?limit=50", {
        headers: githubAuthHeaders(),
      }),
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; deliveries: Array<{ guid: string | null; statusCode: number | null }> };
    expect(body.ok).toBe(true);
    expect(body.deliveries.map((delivery) => delivery.guid)).toEqual(["g-1", "g-3"]);
    expect(body.deliveries[0]).toEqual(expect.objectContaining({
      event: "pull_request",
      action: "closed",
      statusCode: 401,
      redelivery: false,
      installationId: 123,
    }));

    // `limit` bounds the post-filter result, not the GitHub fetch.
    const limited = await handleRequest(
      new Request("https://relay.example.com/github/repos/owner/repo/webhook/deliveries?limit=1", {
        headers: githubAuthHeaders(),
      }),
      env,
    );
    expect(limited.status).toBe(200);
    const limitedBody = await limited.json() as { deliveries: Array<{ guid: string | null }> };
    expect(limitedBody.deliveries.map((delivery) => delivery.guid)).toEqual(["g-1"]);
  });
});

class FakeRepoEventsSocket {
  attachment: unknown = null;
  sent: Array<string | ArrayBuffer> = [];
  closed: { code: number; reason: string } | null = null;

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  send(value: string | ArrayBuffer): void {
    this.sent.push(value);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

class FakeRepoEventsStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }

  async transaction<T>(callback: (transaction: FakeRepoEventsStorage) => Promise<T>): Promise<T> {
    return await callback(this);
  }
}

function makeRepoEventsState() {
  const storage = new FakeRepoEventsStorage();
  const sockets: FakeRepoEventsSocket[] = [];
  const accepted: Array<{ socket: FakeRepoEventsSocket; tags: string[] }> = [];
  const autoResponses: unknown[] = [];
  return {
    storage,
    sockets,
    accepted,
    autoResponses,
    state: {
      storage,
      setWebSocketAutoResponse: (pair: unknown) => autoResponses.push(pair),
      acceptWebSocket: (socket: FakeRepoEventsSocket, tags: string[]) => {
        accepted.push({ socket, tags });
        sockets.push(socket);
      },
      getWebSockets: (tag?: string) => tag === "subscriber" || tag == null ? sockets : [],
    } as unknown as DurableObjectState,
  };
}

describe("RepoEventsDurableObject", () => {
  it("accepts hibernating subscriptions with heartbeat auto-response and a four-hour expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const now = Date.now();
    const client = new FakeRepoEventsSocket();
    const server = new FakeRepoEventsSocket();
    class FakeAutoResponsePair {
      constructor(readonly request: string, readonly response: string) {}
    }
    vi.stubGlobal("WebSocketRequestResponsePair", FakeAutoResponsePair);
    vi.stubGlobal("WebSocketPair", class {
      0 = client;
      1 = server;
    });
    vi.stubGlobal("Response", class {
      readonly status: number;
      readonly webSocket: unknown;

      constructor(_body?: unknown, init: { status?: number; webSocket?: unknown } = {}) {
        this.status = init.status ?? 200;
        this.webSocket = init.webSocket;
      }
    });
    const fixture = makeRepoEventsState();
    const object = new RepoEventsDurableObject(fixture.state);

    const response = await object.fetch(new Request(
      "https://repo-events.internal/subscribe?repo=Owner%2FRepo",
      { headers: { upgrade: "websocket" } },
    ));

    expect(response.status).toBe(101);
    expect((response as unknown as { webSocket: unknown }).webSocket).toBe(client);
    expect(fixture.autoResponses).toEqual([
      expect.objectContaining({ request: "ping", response: "pong" }),
    ]);
    expect(fixture.accepted).toEqual([{ socket: server, tags: ["subscriber", "repo:owner/repo"] }]);
    expect(server.attachment).toEqual({ expiresAt: now + 4 * 60 * 60_000 });
    expect(fixture.storage.alarm).toBe(now + 4 * 60 * 60_000);
  });

  it("coalesces notifications into one frame and closes expired subscribers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    vi.stubGlobal("WebSocketRequestResponsePair", class {
      constructor(readonly request: string, readonly response: string) {}
    });
    const fixture = makeRepoEventsState();
    const live = new FakeRepoEventsSocket();
    live.attachment = { expiresAt: Date.now() + 10_000 };
    const expired = new FakeRepoEventsSocket();
    expired.attachment = { expiresAt: Date.now() - 1 };
    fixture.sockets.push(live, expired);
    const object = new RepoEventsDurableObject(fixture.state);

    const notify = () => object.fetch(new Request("https://repo-events.internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "owner/repo" }),
    }));
    expect((await notify()).status).toBe(202);
    const firstAlarm = fixture.storage.alarm;
    expect((await notify()).status).toBe(202);
    expect(fixture.storage.alarm).toBe(firstAlarm);

    // Cloudflare clears the fired alarm before invoking alarm().
    fixture.storage.alarm = null;
    await object.alarm();

    expect(live.sent).toEqual([JSON.stringify({ t: "github_delivery", repo: "owner/repo" })]);
    expect(expired.sent).toEqual([]);
    expect(expired.closed).toEqual({ code: 4401, reason: "subscription expired" });
    expect(fixture.storage.alarm).toBe((live.attachment as { expiresAt: number }).expiresAt);
  });
});
