import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { handleLinearAgentRequest, routeLinearAgentSessionEvent } from "../src/linearAgent";
import { encryptLinearAgentToken, importLinearAgentTokenKey, linearAgentGraphql } from "../src/linearAgentCore";
import type { RelayEnv } from "../src/relay";

const ACCOUNT_ISSUER = "https://clerk.linear-agent.test";
const ACCOUNT_CLIENT = "linear-agent-desktop";
let jwksUrl = "";
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwksUrl = `data:application/json,${encodeURIComponent(JSON.stringify({ keys: [{ ...jwk, alg: "RS256", kid: "agent-test", use: "sig" }] }))}`;
});

async function accountToken(accountId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ client_id: ACCOUNT_CLIENT })
    .setProtectedHeader({ alg: "RS256", kid: "agent-test" })
    .setIssuer(ACCOUNT_ISSUER)
    .setSubject(accountId)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(signingKey);
}

type AgentSession = {
  session_id: string;
  org_id: string;
  issue_id: string | null;
  issue_identifier: string | null;
  creator_linear_user_id: string | null;
  routed_account_id: string | null;
  claimed_by_machine_id: string | null;
  claimed_at: string | null;
  route_reason: string;
  created_at: string;
  updated_at: string;
};

class AgentStatement {
  private values: unknown[] = [];

  constructor(private readonly sql: string, private readonly db: AgentDatabase) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.values);
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    return { success: true, meta: { changes: this.db.run(this.sql, this.values) } };
  }
}

class AgentDatabase {
  install: Record<string, unknown> | null = null;
  members: Array<{ org_id: string; linear_user_id: string; account_id: string }> = [];
  sessions = new Map<string, AgentSession>();
  holdInstallReads = false;
  installReadCount = 0;
  private releaseInstallReads!: () => void;
  readonly bothInstallReads = new Promise<void>((resolve) => { this.releaseInstallReads = resolve; });

  prepare(sql: string): AgentStatement {
    return new AgentStatement(sql, this);
  }

  async first<T>(sql: string, values: unknown[]): Promise<T | null> {
    if (sql.includes("from linear_agent_installs")) {
      const install = this.install ? { ...this.install } : null;
      if (this.holdInstallReads) {
        this.installReadCount += 1;
        if (this.installReadCount === 2) this.releaseInstallReads();
        await this.bothInstallReads;
      }
      return install as T | null;
    }
    if (sql.includes("from linear_agent_members")) {
      const member = this.members.find((row) => row.org_id === values[0] && row.linear_user_id === values[1]);
      return member ? ({ account_id: member.account_id } as T) : null;
    }
    if (sql.includes("from linear_agent_sessions")) {
      const session = this.sessions.get(String(values[0]));
      return session ? ({ ...session } as T) : null;
    }
    return null;
  }

  run(sql: string, values: unknown[]): number {
    if (sql.includes("update linear_agent_sessions")) {
      this.applyClaim(values);
      return 1;
    }
    if (sql.includes("update linear_agent_installs")) {
      const install = this.install;
      if (!install) return 0;
      if (sql.includes("set updated_at = ?")) {
        const [updatedAt, orgId, accessToken, refreshToken, previousUpdatedAt] = values;
        if (install.org_id !== orgId || install.access_token_enc !== accessToken
          || install.refresh_token_enc !== refreshToken || install.updated_at !== previousUpdatedAt) return 0;
        install.updated_at = updatedAt;
        return 1;
      }
      if (sql.includes("set access_token_enc = null")) {
        const [updatedAt, orgId, accessToken, refreshToken, originalUpdatedAt] = values;
        if (install.org_id !== orgId || install.access_token_enc !== accessToken
          || install.refresh_token_enc !== refreshToken || install.updated_at !== originalUpdatedAt) return 0;
        Object.assign(install, { access_token_enc: null, refresh_token_enc: null, expires_at: null, updated_at: updatedAt });
        return 1;
      }
      const [accessToken, refreshToken, expiresAt, updatedAt, orgId, previousAccess, previousRefresh, previousUpdatedAt] = values;
      if (install.org_id !== orgId || install.access_token_enc !== previousAccess
        || install.refresh_token_enc !== previousRefresh || install.updated_at !== previousUpdatedAt) return 0;
      Object.assign(install, { access_token_enc: accessToken, refresh_token_enc: refreshToken, expires_at: expiresAt, updated_at: updatedAt });
      return 1;
    }
    if (!sql.includes("insert or ignore into linear_agent_sessions")) return 0;
    const [sessionId, orgId, issueId, issueIdentifier, creatorId, accountId, reason, at] = values;
    if (this.sessions.has(String(sessionId))) return 0;
    this.sessions.set(String(sessionId), {
      session_id: String(sessionId),
      org_id: String(orgId),
      issue_id: issueId == null ? null : String(issueId),
      issue_identifier: issueIdentifier == null ? null : String(issueIdentifier),
      creator_linear_user_id: creatorId == null ? null : String(creatorId),
      routed_account_id: accountId == null ? null : String(accountId),
      claimed_by_machine_id: null,
      claimed_at: null,
      route_reason: String(reason),
      created_at: String(at),
      updated_at: String(at),
    });
    return 1;
  }

  applyClaim(values: unknown[]): void {
    const [machineId, now, updatedAt, sessionId, accountId, holder, staleBefore] = values.map(String);
    const session = this.sessions.get(sessionId!);
    if (!session || session.routed_account_id !== accountId) return;
    const mayClaim = !session.claimed_by_machine_id
      || session.claimed_by_machine_id === holder
      || !session.claimed_at
      || session.claimed_at < staleBefore!;
    if (!mayClaim) return;
    session.claimed_by_machine_id = machineId!;
    session.claimed_at = now!;
    session.updated_at = updatedAt!;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Linear agent session routing", () => {
  it.each([
    { name: "registered creator", memberAccountId: "account-member", fallbackMode: "runner", runnerAccountId: "account-runner", expectedAccountId: "account-member", expectedReason: "member" },
    { name: "configured runner", memberAccountId: null, fallbackMode: "runner", runnerAccountId: "account-runner", expectedAccountId: "account-runner", expectedReason: "runner" },
    { name: "unrouted creator", memberAccountId: null, fallbackMode: "reply", runnerAccountId: null, expectedAccountId: null, expectedReason: "unrouted" },
  ])("routes a created session to the $name", async ({ memberAccountId, fallbackMode, runnerAccountId, expectedAccountId, expectedReason }) => {
    const db = new AgentDatabase();
    db.install = {
      org_id: "org-1",
      access_token_enc: "encrypted-token",
      fallback_mode: fallbackMode,
      runner_account_id: runnerAccountId,
    };
    if (memberAccountId) db.members.push({ org_id: "org-1", linear_user_id: "linear-user-1", account_id: memberAccountId });

    const result = await routeLinearAgentSessionEvent(
      { DB: db } as unknown as RelayEnv,
      "org-1",
      "created",
      {
        agentSession: {
          id: "session-1",
          creator: { id: "linear-user-1", name: "Ada" },
          issue: { id: "issue-1", identifier: "ADE-123" },
        },
      },
      "2026-09-29T12:00:00.000Z",
    );

    expect(result).toMatchObject({ routed: expectedAccountId != null, ...(expectedAccountId ? { accountId: expectedAccountId } : {}) });
    expect(db.sessions.get("session-1")).toMatchObject({
      routed_account_id: expectedAccountId,
      route_reason: expectedReason,
      issue_identifier: "ADE-123",
    });
  });

  it.each([
    { name: "an unclaimed session", claimedBy: null, claimedAt: null, machineId: "machine-a", expectedClaimed: true },
    { name: "a claim already held by this machine", claimedBy: "machine-a", claimedAt: new Date().toISOString(), machineId: "machine-a", expectedClaimed: true },
    { name: "a stale claim", claimedBy: "machine-old", claimedAt: new Date(Date.now() - 20 * 60_000).toISOString(), machineId: "machine-new", expectedClaimed: true },
    { name: "another machine's active claim", claimedBy: "machine-a", claimedAt: new Date().toISOString(), machineId: "machine-b", expectedClaimed: false },
  ])("protects session ownership when claiming $name", async ({ claimedBy, claimedAt, machineId, expectedClaimed }) => {
    const db = new AgentDatabase();
    db.sessions.set("session-1", {
      session_id: "session-1",
      org_id: "org-1",
      issue_id: "issue-1",
      issue_identifier: "ADE-123",
      creator_linear_user_id: "linear-user-1",
      routed_account_id: "account-owner",
      claimed_by_machine_id: claimedBy,
      claimed_at: claimedAt,
      route_reason: "member",
      created_at: "2026-09-29T12:00:00.000Z",
      updated_at: "2026-09-29T12:00:00.000Z",
    });
    const env = {
      DB: db,
      CLERK_ISSUER: ACCOUNT_ISSUER,
      CLERK_JWKS_URL: jwksUrl,
      CLERK_OAUTH_CLIENT_ID: ACCOUNT_CLIENT,
    } as unknown as RelayEnv;
    const makeClaimRequest = async (accountId: string) => new Request(
      "https://relay.test/linear/agent/sessions/session-1/claim",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ade-account-token": `Bearer ${await accountToken(accountId)}`,
        },
        body: JSON.stringify({ machineId }),
      },
    );

    const forbidden = await handleLinearAgentRequest(await makeClaimRequest("account-other"), env, "/linear/agent/sessions/session-1/claim");
    expect(forbidden.status).toBe(403);
    expect(db.sessions.get("session-1")?.claimed_by_machine_id).toBe(claimedBy);

    const response = await handleLinearAgentRequest(await makeClaimRequest("account-owner"), env, "/linear/agent/sessions/session-1/claim");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ claimed: expectedClaimed });
    expect(db.sessions.get("session-1")?.claimed_by_machine_id).toBe(expectedClaimed ? machineId : claimedBy);
  });
});

describe("Linear agent token refresh", () => {
  it("shares one refresh across concurrent requests so an invalid_grant cannot erase a rotation", async () => {
    const db = new AgentDatabase();
    const keyBytes = Buffer.alloc(32, 7);
    const env = {
      DB: db,
      LINEAR_API_BASE_URL: "https://linear.test/graphql",
      LINEAR_APP_CLIENT_ID: "linear-agent-test-client",
      LINEAR_AGENT_TOKEN_KEY: keyBytes.toString("base64"),
    } as unknown as RelayEnv;
    const encryptionKey = await importLinearAgentTokenKey(env);
    if (!encryptionKey) throw new Error("test encryption key is invalid");
    const priorAccess = await encryptLinearAgentToken(encryptionKey, "org-1", "old-access");
    const priorRefresh = await encryptLinearAgentToken(encryptionKey, "org-1", "old-refresh");
    db.install = {
      org_id: "org-1",
      org_name: "ADE",
      app_user_id: "linear-agent-app",
      access_token_enc: priorAccess,
      refresh_token_enc: priorRefresh,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      installed_by_account_id: "account-owner",
      installed_by_linear_user_id: "linear-user-1",
      fallback_mode: "reply",
      runner_account_id: null,
      installed_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    };
    db.holdInstallReads = true;

    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    let refreshCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://linear.test/oauth/token") {
        refreshCount += 1;
        markRefreshStarted();
        if (refreshCount === 1) {
          await refreshGate;
          return new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = linearAgentGraphql(env, "org-1", "query { viewer { id } }", {});
    const second = linearAgentGraphql(env, "org-1", "query { viewer { id } }", {});
    await db.bothInstallReads;
    await refreshStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRefresh();

    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(refreshCount).toBe(1);
    expect(db.install?.access_token_enc).not.toBe(priorAccess);
    expect(db.install?.refresh_token_enc).not.toBe(priorRefresh);
    expect(Date.parse(String(db.install?.expires_at))).toBeGreaterThan(Date.now());
  });
});
