import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDisableGhAuthFallback = process.env.ADE_DISABLE_GH_AUTH_FALLBACK;

afterAll(() => {
  if (originalDisableGhAuthFallback == null) {
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
  } else {
    process.env.ADE_DISABLE_GH_AUTH_FALLBACK = originalDisableGhAuthFallback;
  }
});

vi.mock("../../desktop/src/main/services/cto/linearClient", () => ({
  createLinearClient: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/cto/linearIssueTracker", () => ({
  createLinearIssueTracker: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/files/fileService", () => ({
  createFileService: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("../../desktop/src/main/services/prs/prService", () => ({
  createPrService: vi.fn(() => ({ setAgentChatService: vi.fn() })),
}));

vi.mock("../../desktop/src/main/services/automations/automationSecretService", () => ({
  createAutomationSecretService: vi.fn(() => ({})),
}));

import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";
import { createHeadlessGitHubService, createHeadlessLinearServices } from "./headlessLinearServices";
import {
  clearGithubCredentialHealth,
  githubCredentialCooldown,
  githubCredentialRepositoryAccess,
  recordGithubCredentialFailure,
} from "../../desktop/src/main/services/github/githubCredentialHealth";

const HEADLESS_GITHUB_ENV_KEYS = [
  "ADE_HOME",
  "ADE_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_CONFIG_DIR",
] as const;

function isolateHeadlessGithubAuth(prefix: string, options: { emptyGhConfig?: boolean } = {}) {
  const previousEnvironment = new Map(
    HEADLESS_GITHUB_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const previousFetch = globalThis.fetch;
  const temporaryDirectories = [fs.mkdtempSync(path.join(os.tmpdir(), prefix))];
  process.env.ADE_HOME = temporaryDirectories[0];
  delete process.env.ADE_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  if (options.emptyGhConfig) {
    const ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}gh-`));
    temporaryDirectories.push(ghConfigDir);
    process.env.GH_CONFIG_DIR = ghConfigDir;
  }
  return {
    restore(): void {
      globalThis.fetch = previousFetch;
      for (const [key, value] of previousEnvironment) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      for (const temporaryDirectory of temporaryDirectories) {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
  };
}

function storeHeadlessAppUserToken(token = "ghu_app_user_token"): void {
  new EncryptedFileCredentialStore().setSync("github.appUserToken.v1", JSON.stringify({
    accessToken: token,
    tokenType: "bearer",
    scope: null,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    refreshToken: null,
    refreshTokenExpiresAt: null,
    userLogin: "octocat",
    updatedAt: new Date().toISOString(),
  }));
}

function createDeps(overrides: Record<string, any> = {}) {
  const projectRoot = overrides.projectRoot ?? "/tmp/ade-project";
  const adeDir = overrides.adeDir ?? path.join(projectRoot, ".ade");
  return {
    projectRoot,
    adeDir,
    paths: {
      adeDir,
      logsDir: path.join(adeDir, "logs"),
      testLogsDir: path.join(adeDir, "logs", "tests"),
      transcriptsDir: path.join(adeDir, "transcripts"),
      worktreesDir: path.join(adeDir, "worktrees"),
      packsDir: path.join(adeDir, "packs"),
      dbPath: path.join(adeDir, "ade.db"),
      socketPath: path.join(adeDir, "ade.sock"),
      cacheDir: path.join(adeDir, "cache"),
      artifactsDir: path.join(adeDir, "artifacts"),
      chatSessionsDir: path.join(adeDir, "chats", "sessions"),
      chatTranscriptsDir: path.join(adeDir, "chats", "transcripts"),
      orchestratorCacheDir: path.join(adeDir, "cache", "orchestrator"),
    },
    projectId: "project-1",
    db: {} as any,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
    projectConfigService: {} as any,
    laneService: {} as any,
    operationService: {} as any,
    conflictService: {} as any,
    openExternal: async () => {},
    ...overrides,
  };
}

describe("headlessLinearServices", () => {
  beforeEach(() => {
    clearGithubCredentialHealth();
    process.env.ADE_DISABLE_GH_AUTH_FALLBACK = "1";
    vi.clearAllMocks();
  });

  it("resolves smart-link previews through the headless chat action surface", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const preview = await services.agentChatService.resolveSmartLinkPreview({
      url: "https://github.com/acme/ade",
    });

    expect(preview).toMatchObject({
      url: "https://github.com/acme/ade",
      provider: "github",
      kind: "github_repo",
      label: "acme/ade",
    });
    expect(preview?.title).toBeUndefined();
    expect(preview?.iconDataUrl).toBeUndefined();
  });

  it("emits GitHub status changes from the headless shared credential service", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-github-status-"));
    const onStatusChanged = vi.fn();
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      { onStatusChanged },
    );
    try {
      githubService.setToken("");
      await vi.waitFor(() => {
        expect(onStatusChanged).toHaveBeenCalledWith(expect.objectContaining({
          tokenStored: false,
          connected: false,
        }));
      });
      onStatusChanged.mockClear();

      githubService.clearToken();
      await vi.waitFor(() => {
        expect(onStatusChanged).toHaveBeenCalledWith(expect.objectContaining({
          tokenStored: false,
          connected: false,
        }));
      });
    } finally {
      if (previousAdeHome == null) {
        delete process.env.ADE_HOME;
      } else {
        process.env.ADE_HOME = previousAdeHome;
      }
    }
  });

  it("does not let an invalidated GitHub status lookup overwrite the newer cache", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousFetch = globalThis.fetch;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-github-status-race-"));
    let resolveOldResponse: ((response: Response) => void) | undefined;
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOldResponse = resolve;
    });
    const responseFor = (login: string) => new Response(JSON.stringify({ login }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-oauth-scopes": "repo, workflow",
      },
    });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer ghp_old_token") return await oldResponse;
      return responseFor("new-user");
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
    );
    try {
      githubService.setToken("ghp_old_token");
      const staleLookup = githubService.getStatus({ forceRefresh: true });
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

      githubService.setToken("ghp_new_token");
      const freshLookup = githubService.getStatus({ forceRefresh: true });
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      resolveOldResponse?.(responseFor("old-user"));

      await expect(staleLookup).resolves.toMatchObject({ userLogin: "old-user" });
      await expect(freshLookup).resolves.toMatchObject({ userLogin: "new-user" });
      await expect(githubService.getStatus()).resolves.toMatchObject({ userLogin: "new-user" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAdeHome == null) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousAdeHome;
    }
  });

  it("clears only changed PAT health when headless credentials change", () => {
    const environment = isolateHeadlessGithubAuth("ade-headless-github-pat-health-", {
      emptyGhConfig: true,
    });
    const credentialStore = new EncryptedFileCredentialStore();
    credentialStore.setSync("github.token.v1", "ghp_old_token");
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
    );
    const environmentCandidate = {
      source: "environment" as const,
      token: "ghp_environment_token",
      capabilities: ["read", "write"] as const,
    };
    const oldPatCandidate = {
      source: "pat" as const,
      token: "ghp_old_token",
      capabilities: ["read", "write"] as const,
    };
    const newPatCandidate = {
      source: "pat" as const,
      token: "ghp_new_token",
      capabilities: ["read", "write"] as const,
    };
    const invalid = { kind: "invalid_token" as const, message: "Bad credentials", retryAt: null };

    try {
      recordGithubCredentialFailure(environmentCandidate, invalid, null);
      recordGithubCredentialFailure(oldPatCandidate, invalid, null);
      recordGithubCredentialFailure(newPatCandidate, invalid, null);

      githubService.setToken("ghp_new_token");
      expect(githubCredentialCooldown(oldPatCandidate)).toBeNull();
      expect(githubCredentialCooldown(newPatCandidate)).toBeNull();
      expect(githubCredentialCooldown(environmentCandidate)).not.toBeNull();

      recordGithubCredentialFailure(newPatCandidate, invalid, null);
      githubService.clearToken();
      expect(githubCredentialCooldown(newPatCandidate)).toBeNull();
      expect(githubCredentialCooldown(environmentCandidate)).not.toBeNull();
    } finally {
      environment.restore();
    }
  });

  it("clears only App health when headless App authorization is removed", () => {
    const environment = isolateHeadlessGithubAuth("ade-headless-github-app-health-", {
      emptyGhConfig: true,
    });
    storeHeadlessAppUserToken();
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
    );
    const appCandidate = {
      source: "app" as const,
      token: "ghu_app_user_token",
      capabilities: ["read"] as const,
    };
    const environmentCandidate = {
      source: "environment" as const,
      token: "ghp_environment_token",
      capabilities: ["read", "write"] as const,
    };
    const invalid = { kind: "invalid_token" as const, message: "Bad credentials", retryAt: null };

    try {
      recordGithubCredentialFailure(appCandidate, invalid, null);
      recordGithubCredentialFailure(environmentCandidate, invalid, null);

      githubService.clearAppUserAuth();
      expect(githubCredentialCooldown(appCandidate)).toBeNull();
      expect(githubCredentialCooldown(environmentCandidate)).not.toBeNull();
    } finally {
      environment.restore();
    }
  });

  it("coalesces concurrent forced GitHub status lookups", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousFetch = globalThis.fetch;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-github-status-coalesce-"));
    let resolveResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchImpl = vi.fn(async () => await response) as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
    );
    try {
      githubService.setToken("ghp_test_token");
      const lookups = Array.from(
        { length: 16 },
        () => githubService.getStatus({ forceRefresh: true }),
      );
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      resolveResponse?.(new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-oauth-scopes": "repo, workflow",
        },
      }));

      const statuses = await Promise.all(lookups);
      expect(statuses).toHaveLength(16);
      expect(statuses.every((status) => status.userLogin === "octocat")).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAdeHome == null) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousAdeHome;
    }
  });

  it("creates secret gists through the headless GitHub service", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousFetch = globalThis.fetch;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-github-gist-"));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 201,
      headers: new Headers(),
      text: async () => JSON.stringify({
        id: "gist-1",
        html_url: "https://gist.github.com/octocat/gist-1",
      }),
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
    );
    try {
      githubService.setToken("ghp_test_token");
      const result = await githubService.createSecretGist({
        description: "ADE transcript",
        files: {
          "README.md": { content: "# Transcript\n" },
        },
      });

      expect(result).toEqual({
        id: "gist-1",
        htmlUrl: "https://gist.github.com/octocat/gist-1",
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.objectContaining({ pathname: "/gists" }),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            description: "ADE transcript",
            public: false,
            files: {
              "README.md": { content: "# Transcript\n" },
            },
          }),
        }),
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAdeHome == null) {
        delete process.env.ADE_HOME;
      } else {
        process.env.ADE_HOME = previousAdeHome;
      }
    }
  });

  it("reuses identity sessions and exposes desktop-compatible session summaries", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const first = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:worker-1",
      laneId: "lane-1",
      reuseExisting: true,
      permissionMode: "plan",
      reasoningEffort: "medium",
    });
    const second = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:worker-1",
      laneId: "lane-2",
      reuseExisting: true,
    });

    expect(second.id).toBe(first.id);

    await services.agentChatService.sendMessage({
      sessionId: first.id,
      text: "Check the failing issue flow.",
    });

    const sessions = await services.agentChatService.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(expect.objectContaining({
      id: first.id,
      sessionId: first.id,
      laneId: "lane-1",
      identityKey: "agent:worker-1",
      status: "idle",
      startedAt: expect.any(String),
      endedAt: null,
      lastOutputPreview: null,
      summary: expect.stringContaining("Automatic agent execution is not available"),
      permissionMode: "plan",
      reasoningEffort: "medium",
    }));

    const transcript = await services.agentChatService.getChatTranscript({ sessionId: first.id });
    expect(transcript.entries).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Check the failing issue flow.",
      }),
    ]);

    services.dispose();
  });

  it("creates a fresh session with createSession and assigns unique ids", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1", title: "My session" });
    expect(session.id).toBeTruthy();
    expect(session.laneId).toBe("lane-1");
    expect(session.title).toBe("My session");
    expect(session.status).toBe("idle");
    expect(session.provider).toBe("codex");

    const session2 = await services.agentChatService.createSession({ laneId: "lane-2" });
    expect(session2.id).not.toBe(session.id);

    services.dispose();
  });

  it("updates session title via updateSession", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    const updated = await services.agentChatService.updateSession({ sessionId: session.id, title: "Updated Title" });
    expect(updated.title).toBe("Updated Title");
    expect(updated.id).toBe(session.id);

    services.dispose();
  });

  it("getSessionSummary returns null for unknown sessions and the session for known ones", async () => {
    const services = createHeadlessLinearServices(createDeps());

    expect(await services.agentChatService.getSessionSummary("nonexistent")).toBeNull();

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    const summary = await services.agentChatService.getSessionSummary(session.id);
    expect(summary).not.toBeNull();
    expect((summary as Record<string, unknown>).id).toBe(session.id);

    services.dispose();
  });

  it("getChatTranscript respects limit and maxChars parameters", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    for (let i = 0; i < 5; i++) {
      await services.agentChatService.sendMessage({ sessionId: session.id, text: `Message ${i}` });
    }

    const transcript = await services.agentChatService.getChatTranscript({ sessionId: session.id, limit: 2 });
    expect(transcript.entries).toHaveLength(2);
    expect(transcript.totalEntries).toBe(5);
    expect(transcript.truncated).toBe(true);

    // maxChars clips text
    const longText = "x".repeat(200);
    await services.agentChatService.sendMessage({ sessionId: session.id, text: longText });
    const clipped = await services.agentChatService.getChatTranscript({ sessionId: session.id, limit: 1, maxChars: 50 });
    expect(clipped.entries[0]!.text.length).toBeLessThanOrEqual(50);

    services.dispose();
  });

  it("provides index pagination for the non-agent headless chat fallback", async () => {
    const services = createHeadlessLinearServices(createDeps());
    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    for (let index = 0; index < 5; index += 1) {
      await services.agentChatService.sendMessage({
        sessionId: session.id,
        text: `Message ${index}`,
      });
    }

    const newest = await services.agentChatService.getChatTranscriptPage({
      sessionId: session.id,
      limit: 2,
    });
    expect(newest).toMatchObject({
      cursorKind: "index",
      totalEntries: 5,
      nextCursor: 3,
    });
    expect(newest.entries.map((entry) => entry.text)).toEqual([
      "Message 3",
      "Message 4",
    ]);

    const older = await services.agentChatService.getChatTranscriptPage({
      sessionId: session.id,
      beforeOffset: newest.nextCursor!,
      limit: 2,
    });
    expect(older.entries.map((entry) => entry.text)).toEqual([
      "Message 1",
      "Message 2",
    ]);
    expect(older.nextCursor).toBe(1);
    services.dispose();
  });

  it("supports normalized chat message routing in the headless fallback", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    const sent = await services.agentChatService.messageSession({
      sessionId: session.id,
      kind: "auto",
      text: "normal follow-up",
    });
    const steer = await services.agentChatService.steer({
      sessionId: session.id,
      text: "active-turn context",
    });
    const queued = await services.agentChatService.messageSession({
      sessionId: session.id,
      kind: "queue",
      text: "queue this context",
    });

    expect(sent).toEqual(expect.objectContaining({
      sessionId: session.id,
      kind: "auto",
      routedAction: "sendMessage",
      statusBefore: "idle",
      awaitingInputBefore: false,
      delivery: "sent",
    }));
    expect(steer).toEqual({
      steerId: expect.stringMatching(/^steer-/),
      queued: false,
    });
    expect(queued).toEqual(expect.objectContaining({
      sessionId: session.id,
      kind: "queue",
      routedAction: "steer",
      delivery: "queued",
      queued: true,
      steerId: expect.stringMatching(/^steer-/),
    }));

    const transcript = await services.agentChatService.getChatTranscript({ sessionId: session.id });
    expect(transcript.entries.map((entry) => entry.text)).toEqual([
      "normal follow-up",
      "active-turn context",
      "queue this context",
    ]);

    services.dispose();
  });

  it("answers the CTO operator tool chat surface instead of throwing TypeError", async () => {
    // The CTO operator tools and the chat.* sync commands call these on
    // `runtime.agentChatService` unconditionally — the call sites only guard a
    // null service, not a missing method. A stub missing any of them turns
    // `ade actions run` / a phone tap into "x is not a function".
    const services = createHeadlessLinearServices(createDeps());
    const session = await services.agentChatService.createSession({ laneId: "lane-1" });

    expect(await services.agentChatService.getCtoAttention()).toEqual({
      awaitingInput: false,
      since: null,
    });
    expect(await services.agentChatService.listSubagents({ sessionId: session.id })).toEqual([]);

    // Headless steers are delivered immediately (queued: false), so there is
    // never a queued steer to pull back: a plain cancel is a no-op, and a
    // requireQueued cancel must fail the way the desktop service does.
    await expect(
      services.agentChatService.cancelSteer({ sessionId: session.id, steerId: "steer-missing" }),
    ).resolves.toBeUndefined();
    await expect(
      services.agentChatService.cancelSteer({
        sessionId: session.id,
        steerId: "steer-missing",
        requireQueued: true,
      }),
    ).rejects.toThrow(/no longer queued/);

    // Headless raises no approvals, so approving one must be an honest error
    // rather than a silent success the caller would misread as "approved".
    await expect(
      services.agentChatService.approveToolUse({
        sessionId: session.id,
        itemId: "tool-1",
        decision: "accept",
      }),
    ).rejects.toThrow(/No pending approval/);

    services.dispose();
  });

  it("dispose removes session and transcript data", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:worker-dispose",
      laneId: "lane-1",
    });
    await services.agentChatService.sendMessage({ sessionId: session.id, text: "hello" });

    await services.agentChatService.dispose({ sessionId: session.id });

    const summary = await services.agentChatService.getSessionSummary(session.id);
    expect(summary).toBeNull();

    const sessions = await services.agentChatService.listSessions();
    expect(sessions.find((s) => (s as Record<string, unknown>).id === session.id)).toBeUndefined();

    services.dispose();
  });

  it("resumeSession resets status to idle and clears endedAt", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    const resumed = await services.agentChatService.resumeSession({ sessionId: session.id });

    expect(resumed.status).toBe("idle");
    expect(resumed.endedAt).toBeNull();

    services.dispose();
  });

  it("interrupt updates lastActivityAt on existing session", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    const initialActivity = session.lastActivityAt;

    // Small delay to ensure timestamp changes
    await new Promise((resolve) => setTimeout(resolve, 5));
    await services.agentChatService.interrupt({ sessionId: session.id });

    const summary = await services.agentChatService.getSessionSummary(session.id) as Record<string, unknown>;
    expect(summary).not.toBeNull();
    // lastActivityAt should be updated (or at least not before initial)
    expect(new Date(summary.lastActivityAt as string).getTime()).toBeGreaterThanOrEqual(new Date(initialActivity).getTime());

    services.dispose();
  });

  it("ensureIdentitySession creates a new session when reuseExisting is false", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const first = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:no-reuse",
      laneId: "lane-1",
      reuseExisting: true,
    });

    const second = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:no-reuse",
      laneId: "lane-2",
      reuseExisting: false,
    });

    expect(second.id).not.toBe(first.id);

    services.dispose();
  });

  it("exposes all expected service properties", () => {
    const services = createHeadlessLinearServices(createDeps());

    expect(services.linearCredentialService).toBeTruthy();
    expect(services.linearClient).toBeTruthy();
    expect(services.linearIssueTracker).toBeTruthy();
    expect(services.fileService).toBeTruthy();
    expect(services.prService).toBeTruthy();
    expect(services.agentChatService).toBeTruthy();
    expect(typeof services.dispose).toBe("function");

    services.dispose();
  });

  it("exposes bundled Linear OAuth credentials in headless runtime", () => {
    const previousAdeHome = process.env.ADE_HOME;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-linear-oauth-"));
    const services = createHeadlessLinearServices(createDeps());
    try {
      expect(services.linearCredentialService.getStatus().oauthConfigured).toBe(true);
      expect(services.linearCredentialService.getOAuthClientCredentials()).toEqual({
        clientId: expect.any(String),
        clientSecret: null,
      });
    } finally {
      services.dispose();
      if (previousAdeHome == null) {
        delete process.env.ADE_HOME;
      } else {
        process.env.ADE_HOME = previousAdeHome;
      }
    }
  });

  it("reads Linear credentials from the project store and GitHub credentials from the shared machine store", () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousAdeLinearApi = process.env.ADE_LINEAR_API;
    const previousLinearApiKey = process.env.LINEAR_API_KEY;
    const previousAdeLinearToken = process.env.ADE_LINEAR_TOKEN;
    const previousLinearToken = process.env.LINEAR_TOKEN;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-shared-credentials-"));
    delete process.env.ADE_LINEAR_API;
    delete process.env.LINEAR_API_KEY;
    delete process.env.ADE_LINEAR_TOKEN;
    delete process.env.LINEAR_TOKEN;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-linear-project-"));
    const adeDir = path.join(projectRoot, ".ade");
    const projectCredentialStore = new EncryptedFileCredentialStore({
      secretsDir: path.join(adeDir, "secrets"),
    });
    projectCredentialStore.setSync("linear.token.v1", "lin_project_token");
    const machineCredentialStore = new EncryptedFileCredentialStore();
    machineCredentialStore.setSync("github.token.v1", "ghp_shared_token");

    const services = createHeadlessLinearServices(createDeps({ projectRoot, adeDir }));
    try {
      expect(services.linearCredentialService.getTokenOrThrow()).toBe("lin_project_token");
      const githubService = createHeadlessGitHubService(
        projectRoot,
        { debug() {}, info() {}, warn() {}, error() {} } as any,
      );
      expect(githubService.getTokenOrThrow()).toBe("ghp_shared_token");
    } finally {
      services.dispose();
      if (previousAdeHome == null) {
        delete process.env.ADE_HOME;
      } else {
        process.env.ADE_HOME = previousAdeHome;
      }
      if (previousAdeLinearApi == null) delete process.env.ADE_LINEAR_API;
      else process.env.ADE_LINEAR_API = previousAdeLinearApi;
      if (previousLinearApiKey == null) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinearApiKey;
      if (previousAdeLinearToken == null) delete process.env.ADE_LINEAR_TOKEN;
      else process.env.ADE_LINEAR_TOKEN = previousAdeLinearToken;
      if (previousLinearToken == null) delete process.env.LINEAR_TOKEN;
      else process.env.LINEAR_TOKEN = previousLinearToken;
    }
  });

  it("prefers an explicit GitHub environment token over a stored machine PAT", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousAdeGitHubToken = process.env.ADE_GITHUB_TOKEN;
    const previousGitHubToken = process.env.GITHUB_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-github-env-"));
    process.env.ADE_GITHUB_TOKEN = "ghp_environment_token";
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const machineCredentialStore = new EncryptedFileCredentialStore();
    machineCredentialStore.setSync("github.token.v1", "ghp_stale_stored_token");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ login: "octocat" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-oauth-scopes": "repo",
      },
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;

    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
    );
    try {
      expect(githubService.getTokenOrThrow()).toBe("ghp_environment_token");
      await expect(githubService.getStatus({ forceRefresh: true })).resolves.toMatchObject({
        authSource: "environment",
        connected: true,
        writeAuthSource: "none",
        patTokenStored: true,
        userLogin: "octocat",
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer ghp_environment_token",
          }),
        }),
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAdeHome == null) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousAdeHome;
      if (previousAdeGitHubToken == null) delete process.env.ADE_GITHUB_TOKEN;
      else process.env.ADE_GITHUB_TOKEN = previousAdeGitHubToken;
      if (previousGitHubToken == null) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHubToken;
      if (previousGhToken == null) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
    }
  });

  it("falls back from a rejected GitHub App token to a stored PAT", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousAdeGitHubToken = process.env.ADE_GITHUB_TOKEN;
    const previousGitHubToken = process.env.GITHUB_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    const previousGhConfigDir = process.env.GH_CONFIG_DIR;
    const previousFetch = globalThis.fetch;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-github-app-"));
    process.env.GH_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-gh-config-"));
    delete process.env.ADE_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const machineCredentialStore = new EncryptedFileCredentialStore();
    machineCredentialStore.setSync("github.token.v1", "ghp_stored_token");
    machineCredentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "octocat",
      updatedAt: new Date().toISOString(),
    }));
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization !== "Bearer ghp_stored_token") {
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      }
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-oauth-scopes": "repo, workflow",
        },
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;

    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
    );
    try {
      await expect(githubService.getStatus({ forceRefresh: true })).resolves.toMatchObject({
        authSource: "pat",
        writeAuthSource: "pat",
        connected: true,
        patTokenStored: true,
        userLogin: "octocat",
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer ghp_stored_token",
          }),
        }),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer ghu_app_user_token" }),
        }),
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAdeHome == null) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousAdeHome;
      if (previousAdeGitHubToken == null) delete process.env.ADE_GITHUB_TOKEN;
      else process.env.ADE_GITHUB_TOKEN = previousAdeGitHubToken;
      if (previousGitHubToken == null) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHubToken;
      if (previousGhToken == null) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
      if (previousGhConfigDir == null) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousGhConfigDir;
    }
  });

  it("falls back when headless GraphQL returns rate-limit errors with HTTP 200", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousAdeGitHubToken = process.env.ADE_GITHUB_TOKEN;
    const previousGitHubToken = process.env.GITHUB_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-github-graphql-"));
    delete process.env.ADE_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const machineCredentialStore = new EncryptedFileCredentialStore();
    machineCredentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "octocat",
      updatedAt: new Date().toISOString(),
    }));
    const authorizations: string[] = [];
    const resetAt = Math.floor(Date.now() / 1_000) + 3600;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      authorizations.push(authorization);
      if (authorization === "Bearer ghu_app_user_token") {
        return new Response(JSON.stringify({
          data: null,
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetAt),
            "x-ratelimit-resource": "graphql",
          },
        });
      }
      return new Response(JSON.stringify({ data: { viewer: { login: "octocat" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: "gho_cli_token",
          ghCliPath: "/opt/homebrew/bin/gh",
          ghAuthError: null,
        }),
      },
    );
    try {
      await expect(githubService.apiRequest({
        method: "POST",
        path: "/graphql",
        capability: "read",
        body: { query: "query { viewer { login } }" },
      })).resolves.toMatchObject({ data: { data: { viewer: { login: "octocat" } } } });
      expect(authorizations).toEqual([
        "Bearer ghu_app_user_token",
        "Bearer gho_cli_token",
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAdeHome == null) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousAdeHome;
      if (previousAdeGitHubToken == null) delete process.env.ADE_GITHUB_TOKEN;
      else process.env.ADE_GITHUB_TOKEN = previousAdeGitHubToken;
      if (previousGitHubToken == null) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHubToken;
      if (previousGhToken == null) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
    }
  });

  it("preserves an earlier headless REST rate limit after fallback permission failure", async () => {
    const environment = isolateHeadlessGithubAuth("ade-headless-github-rest-rate-precedence-", {
      emptyGhConfig: true,
    });
    storeHeadlessAppUserToken();
    const resetAt = Math.floor(Date.now() / 1_000) + 3_600;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      new Headers(init?.headers).get("authorization") === "Bearer ghu_app_user_token"
        ? new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
            status: 403,
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetAt),
              "x-ratelimit-resource": "core",
            },
          })
        : new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 })
    )) as unknown as typeof fetch;
    const service = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: "gho_cli_token",
          ghCliPath: "/opt/homebrew/bin/gh",
          ghAuthError: null,
        }),
      },
    );

    try {
      await expect(service.apiRequest({ method: "GET", path: "/repos/acme/ade" }))
        .rejects.toMatchObject({
          name: "GitHubRateLimitError",
          rateLimitResetAtMs: resetAt * 1_000,
        });
    } finally {
      environment.restore();
    }
  });

  it("preserves an earlier headless GraphQL rate limit after fallback permission failure", async () => {
    const environment = isolateHeadlessGithubAuth("ade-headless-github-graphql-rate-precedence-", {
      emptyGhConfig: true,
    });
    storeHeadlessAppUserToken();
    const resetAt = Math.floor(Date.now() / 1_000) + 3_600;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      new Headers(init?.headers).get("authorization") === "Bearer ghu_app_user_token"
        ? new Response(JSON.stringify({
            data: null,
            errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
          }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetAt),
              "x-ratelimit-resource": "graphql",
            },
          })
        : new Response(JSON.stringify({
            data: null,
            errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }],
          }), { status: 200, headers: { "content-type": "application/json" } })
    )) as unknown as typeof fetch;
    const service = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: "gho_cli_token",
          ghCliPath: "/opt/homebrew/bin/gh",
          ghAuthError: null,
        }),
      },
    );

    try {
      await expect(service.apiRequest({
        method: "POST",
        path: "/graphql",
        capability: "read",
        body: { query: "query { viewer { login } }" },
      })).rejects.toMatchObject({
        name: "GitHubRateLimitError",
        rateLimitResetAtMs: resetAt * 1_000,
      });
    } finally {
      environment.restore();
    }
  });

  it("retries raw repository redirects after an ambiguous App 404", async () => {
    const environment = isolateHeadlessGithubAuth("ade-headless-github-raw-404-", {
      emptyGhConfig: true,
    });
    storeHeadlessAppUserToken();
    const authorizations: string[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      authorizations.push(authorization);
      if (authorization === "Bearer ghu_app_user_token") {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://productionresultssa.blob.core.windows.net/actions-results/job.zip",
        },
      });
    }) as unknown as typeof fetch;
    const service = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: "gho_cli_token",
          ghCliPath: "/opt/homebrew/bin/gh",
          ghAuthError: null,
        }),
      },
    );

    try {
      const response = await service.requestRawWithCredentialFallback({
        url: "https://api.github.com/repos/acme/ade/actions/jobs/123/logs",
        redirect: "manual",
        repo: { owner: "acme", name: "ade" },
      });

      expect(response.status).toBe(302);
      expect(authorizations).toEqual([
        "Bearer ghu_app_user_token",
        "Bearer gho_cli_token",
      ]);
      expect(githubCredentialRepositoryAccess({
        source: "app",
        token: "ghu_app_user_token",
        capabilities: ["read"],
      }, { owner: "acme", name: "ade" })).toBeNull();
    } finally {
      environment.restore();
    }
  });

  it("does not cache a generic headless repo-probe 403 as repository denial", async () => {
    const environment = isolateHeadlessGithubAuth("ade-headless-github-generic-403-", {
      emptyGhConfig: true,
    });
    storeHeadlessAppUserToken();
    const projectRoot = path.join(process.env.ADE_HOME!, "project");
    fs.mkdirSync(projectRoot, { recursive: true });
    execFileSync("git", ["init", projectRoot]);
    execFileSync("git", ["-C", projectRoot, "remote", "add", "origin", "https://github.com/acme/ade.git"]);
    const authorizations: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      authorizations.push(authorization);
      const url = String(input);
      if (authorization === "Bearer ghu_app_user_token" && url.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
      }
      if (authorization === "Bearer ghu_app_user_token" && url.endsWith("/repos/acme/ade")) {
        return new Response(JSON.stringify({
          message: "Resource protected by organization SAML enforcement.",
        }), { status: 403 });
      }
      if (authorization === "Bearer gho_cli_token" && url.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "fallback-user" }), {
          status: 200,
          headers: { "x-oauth-scopes": "repo, workflow" },
        });
      }
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
    }) as unknown as typeof fetch;
    const service = createHeadlessGitHubService(
      projectRoot,
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: "gho_cli_token",
          ghCliPath: "/opt/homebrew/bin/gh",
          ghAuthError: null,
        }),
      },
    );

    try {
      await expect(service.getStatus()).resolves.toMatchObject({
        authSource: "gh",
        userLogin: "fallback-user",
      });
      await expect(service.apiRequest({
        method: "GET",
        path: "/repos/acme/ade/issues",
      })).resolves.toMatchObject({ data: [{ id: 1 }] });
      expect(authorizations.at(-1)).toBe("Bearer ghu_app_user_token");
    } finally {
      environment.restore();
    }
  });

  it("falls back for headless repository NOT_FOUND and skips the known-negative credential", async () => {
    const environment = isolateHeadlessGithubAuth("ade-headless-github-graphql-not-found-");
    storeHeadlessAppUserToken();
    const fallbackData = { data: { repository: { name: "ade" } } };
    const authorizations: string[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      authorizations.push(authorization);
      if (authorizations.length === 1) {
        return new Response(JSON.stringify({
          data: { repository: null },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository with the name 'ade'." }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (authorizations.length === 2) {
        return new Response(JSON.stringify({ data: { repository: { name: "ade" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(fallbackData), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: "gho_cli_token",
          ghCliPath: "/opt/homebrew/bin/gh",
          ghAuthError: null,
        }),
      },
    );

    try {
      await expect(githubService.apiRequest({
        method: "POST",
        path: "/graphql",
        capability: "read",
        repo: { owner: "acme", name: "ade" },
        body: { query: "query { repository(owner: \"acme\", name: \"ade\") { name } }" },
      })).resolves.toMatchObject({ data: { data: { repository: { name: "ade" } } } });
      await expect(githubService.apiRequest({
        method: "POST",
        path: "/graphql",
        capability: "read",
        repo: { owner: "acme", name: "ade" },
        body: { query: "query { repository(owner: \"acme\", name: \"ade\") { name } }" },
      })).resolves.toMatchObject({ data: fallbackData });
      expect(authorizations).toEqual([
        "Bearer ghu_app_user_token",
        "Bearer gho_cli_token",
        "Bearer gho_cli_token",
      ]);
    } finally {
      environment.restore();
    }
  });

  it("limits headless 404 fallback to repository-scoped requests", async () => {
    const environment = isolateHeadlessGithubAuth("ade-headless-github-404-", {
      emptyGhConfig: true,
    });
    storeHeadlessAppUserToken();
    const authorizations: string[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (authorizations.length === 2) {
        return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
      }
      if (authorizations.length === 3) {
        return new Response(JSON.stringify([{ number: 2 }]), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as unknown as typeof fetch;
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: "gho_cli_token",
          ghCliPath: "/opt/homebrew/bin/gh",
          ghAuthError: null,
        }),
      },
    );
    try {
      await expect(githubService.apiRequest({ method: "GET", path: "/repos/acme/ade/issues" }))
        .resolves.toMatchObject({ data: [{ id: 1 }] });
      await expect(githubService.apiRequest({ method: "GET", path: "/repos/acme/ade/pulls" }))
        .resolves.toMatchObject({ data: [{ number: 2 }] });
      await expect(githubService.apiRequest({ method: "GET", path: "/user/emails" }))
        .rejects.toThrow("Not Found");
      expect(authorizations).toEqual([
        "Bearer ghu_app_user_token",
        "Bearer gho_cli_token",
        "Bearer ghu_app_user_token",
        "Bearer ghu_app_user_token",
      ]);
    } finally {
      environment.restore();
    }
  });

  it("keeps App reads connected without advertising an invalid GitHub CLI writer", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousAdeGitHubToken = process.env.ADE_GITHUB_TOKEN;
    const previousGitHubToken = process.env.GITHUB_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    const previousGhConfigDir = process.env.GH_CONFIG_DIR;
    const previousFetch = globalThis.fetch;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-github-app-only-"));
    process.env.GH_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-gh-empty-"));
    delete process.env.ADE_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const machineCredentialStore = new EncryptedFileCredentialStore();
    machineCredentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "octocat",
      updatedAt: new Date().toISOString(),
    }));
    const authorizations: string[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      authorizations.push(authorization);
      return authorization === "Bearer ghu_app_user_token"
        ? new Response(JSON.stringify({ login: "octocat" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }) as unknown as typeof fetch;
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: "gho_invalid_cli_token",
          ghCliPath: "/opt/homebrew/bin/gh",
          ghAuthError: null,
        }),
      },
    );

    try {
      await expect(githubService.getStatus({ forceRefresh: true })).resolves.toMatchObject({
        authSource: "app",
        writeAuthSource: "none",
        connected: true,
        userLogin: "octocat",
      });
      expect(authorizations).toEqual([
        "Bearer ghu_app_user_token",
        "Bearer gho_invalid_cli_token",
      ]);
      await expect(githubService.getTokenOrThrowAsync()).rejects.toThrow("GitHub write access is unavailable");
      await expect(githubService.getReadTokenOrThrowAsync()).resolves.toBe("ghu_app_user_token");
      await expect(githubService.getGitTransportTokenOrThrowAsync()).rejects.toThrow("GitHub auth missing");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAdeHome == null) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousAdeHome;
      if (previousAdeGitHubToken == null) delete process.env.ADE_GITHUB_TOKEN;
      else process.env.ADE_GITHUB_TOKEN = previousAdeGitHubToken;
      if (previousGitHubToken == null) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHubToken;
      if (previousGhToken == null) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
      if (previousGhConfigDir == null) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousGhConfigDir;
    }
  });

  it("uses a stored PAT instead of the App token for headless Git transport", async () => {
    const environment = isolateHeadlessGithubAuth("ade-headless-github-transport-", {
      emptyGhConfig: true,
    });
    storeHeadlessAppUserToken();
    new EncryptedFileCredentialStore().setSync("github.token.v1", "github_pat_read_only_contents");
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: null,
          ghCliPath: "/opt/homebrew/bin/gh",
          ghAuthError: null,
        }),
      },
    );

    try {
      await expect(githubService.getReadTokenOrThrowAsync()).resolves.toBe("ghu_app_user_token");
      await expect(githubService.getGitTransportTokenOrThrowAsync())
        .resolves.toBe("github_pat_read_only_contents");
    } finally {
      environment.restore();
    }
  });

  it("drops a cached headless writer when that credential disappears", async () => {
    const environment = isolateHeadlessGithubAuth("ade-headless-github-cache-");
    const machineCredentialStore = new EncryptedFileCredentialStore();
    machineCredentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "octocat",
      updatedAt: new Date().toISOString(),
    }));
    let ghToken: string | null = "gho_cli_token";
    const authorizations: string[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-oauth-scopes": authorizations.at(-1) === "Bearer gho_cli_token"
            ? "repo, workflow"
            : "",
        },
      });
    }) as unknown as typeof fetch;
    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: ghToken,
          ghCliPath: "/opt/homebrew/bin/gh",
          ghAuthError: null,
        }),
      },
    );

    try {
      await expect(githubService.getStatus()).resolves.toMatchObject({
        authSource: "app",
        writeAuthSource: "gh",
        connected: true,
      });
      ghToken = null;
      await expect(githubService.getStatus()).resolves.toMatchObject({
        authSource: "app",
        writeAuthSource: "none",
        connected: true,
      });
      expect(authorizations).toEqual([
        "Bearer ghu_app_user_token",
        "Bearer gho_cli_token",
        "Bearer ghu_app_user_token",
      ]);
    } finally {
      environment.restore();
    }
  });

  it("falls back from a rejected GitHub App token to GitHub CLI", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousAdeGitHubToken = process.env.ADE_GITHUB_TOKEN;
    const previousGitHubToken = process.env.GITHUB_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    const previousGhConfigDir = process.env.GH_CONFIG_DIR;
    const previousDisableGhAuthFallback = process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    const previousFetch = globalThis.fetch;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-github-app-"));
    process.env.GH_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-gh-config-"));
    delete process.env.ADE_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
    fs.writeFileSync(
      path.join(process.env.GH_CONFIG_DIR, "hosts.yml"),
      "github.com:\n  oauth_token: gho_cli_token\n",
    );
    const machineCredentialStore = new EncryptedFileCredentialStore();
    machineCredentialStore.setSync("github.token.v1", "ghp_stored_token");
    machineCredentialStore.setSync("github.appUserToken.v1", JSON.stringify({
      accessToken: "ghu_app_user_token",
      tokenType: "bearer",
      scope: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      userLogin: "octocat",
      updatedAt: new Date().toISOString(),
    }));
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization !== "Bearer gho_cli_token") {
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      }
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-oauth-scopes": "repo, workflow",
        },
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;

    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
    );
    try {
      await expect(githubService.getStatus({ forceRefresh: true })).resolves.toMatchObject({
        authSource: "gh",
        writeAuthSource: "gh",
        connected: true,
        patTokenStored: true,
        userLogin: "octocat",
      });
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer gho_cli_token",
          }),
        }),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer ghu_app_user_token" }),
        }),
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAdeHome == null) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousAdeHome;
      if (previousAdeGitHubToken == null) delete process.env.ADE_GITHUB_TOKEN;
      else process.env.ADE_GITHUB_TOKEN = previousAdeGitHubToken;
      if (previousGitHubToken == null) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHubToken;
      if (previousGhToken == null) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
      if (previousGhConfigDir == null) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousGhConfigDir;
      if (previousDisableGhAuthFallback == null) delete process.env.ADE_DISABLE_GH_AUTH_FALLBACK;
      else process.env.ADE_DISABLE_GH_AUTH_FALLBACK = previousDisableGhAuthFallback;
    }
  });

  it("preserves failed GitHub CLI diagnostics when a stored PAT is the fallback", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousAdeGitHubToken = process.env.ADE_GITHUB_TOKEN;
    const previousGitHubToken = process.env.GITHUB_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-github-pat-fallback-"));
    delete process.env.ADE_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const machineCredentialStore = new EncryptedFileCredentialStore();
    machineCredentialStore.setSync("github.token.v1", "ghp_stored_token");
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ login: "octocat" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-oauth-scopes": "repo, workflow",
      },
    })) as unknown as typeof fetch;

    const githubService = createHeadlessGitHubService(
      "/tmp/ade-project",
      { debug() {}, info() {}, warn() {}, error() {} } as any,
      {
        ghAuthTokenProvider: () => ({
          token: null,
          ghCliPath: "/usr/local/bin/gh",
          ghAuthError: "not logged in to github.com",
        }),
      },
    );
    try {
      expect(githubService.getTokenOrThrow()).toBe("ghp_stored_token");
      await expect(githubService.getStatus({ forceRefresh: true })).resolves.toMatchObject({
        authSource: "pat",
        connected: true,
        patTokenStored: true,
        ghCliPath: "/usr/local/bin/gh",
        ghAuthError: "not logged in to github.com",
        userLogin: "octocat",
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAdeHome == null) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousAdeHome;
      if (previousAdeGitHubToken == null) delete process.env.ADE_GITHUB_TOKEN;
      else process.env.ADE_GITHUB_TOKEN = previousAdeGitHubToken;
      if (previousGitHubToken == null) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHubToken;
      if (previousGhToken == null) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
    }
  });

  it("does not share Linear credentials between headless projects", () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousAdeLinearApi = process.env.ADE_LINEAR_API;
    const previousLinearApiKey = process.env.LINEAR_API_KEY;
    const previousAdeLinearToken = process.env.ADE_LINEAR_TOKEN;
    const previousLinearToken = process.env.LINEAR_TOKEN;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-linear-isolation-"));
    delete process.env.ADE_LINEAR_API;
    delete process.env.LINEAR_API_KEY;
    delete process.env.ADE_LINEAR_TOKEN;
    delete process.env.LINEAR_TOKEN;
    const projectOneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-project-one-"));
    const projectTwoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-project-two-"));
    const projectOneAdeDir = path.join(projectOneRoot, ".ade");
    const projectTwoAdeDir = path.join(projectTwoRoot, ".ade");

    const projectOneCredentials = new EncryptedFileCredentialStore({
      secretsDir: path.join(projectOneAdeDir, "secrets"),
    });
    projectOneCredentials.setSync("linear.token.v1", "lin_project_one");
    const machineCredentials = new EncryptedFileCredentialStore();
    machineCredentials.setSync("linear.token.v1", "lin_machine_should_not_bleed");

    const projectOne = createHeadlessLinearServices(createDeps({
      projectRoot: projectOneRoot,
      adeDir: projectOneAdeDir,
    }));
    const projectTwo = createHeadlessLinearServices(createDeps({
      projectRoot: projectTwoRoot,
      adeDir: projectTwoAdeDir,
    }));
    try {
      expect(projectOne.linearCredentialService.getTokenOrThrow()).toBe("lin_project_one");
      expect(projectTwo.linearCredentialService.getStatus().tokenStored).toBe(false);
      expect(() => projectTwo.linearCredentialService.getTokenOrThrow()).toThrow("Linear token missing");
    } finally {
      projectOne.dispose();
      projectTwo.dispose();
      if (previousAdeHome == null) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousAdeHome;
      if (previousAdeLinearApi == null) delete process.env.ADE_LINEAR_API;
      else process.env.ADE_LINEAR_API = previousAdeLinearApi;
      if (previousLinearApiKey == null) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinearApiKey;
      if (previousAdeLinearToken == null) delete process.env.ADE_LINEAR_TOKEN;
      else process.env.ADE_LINEAR_TOKEN = previousAdeLinearToken;
      if (previousLinearToken == null) delete process.env.LINEAR_TOKEN;
      else process.env.LINEAR_TOKEN = previousLinearToken;
    }
  });

  it("clears headless OAuth credentials when forced refresh gets invalid_grant without rotation", async () => {
    const previousAdeHome = process.env.ADE_HOME;
    const previousFetch = globalThis.fetch;
    process.env.ADE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-linear-forced-refresh-"));
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant" }),
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-linear-forced-project-"));
    const adeDir = path.join(projectRoot, ".ade");
    const services = createHeadlessLinearServices(createDeps({ projectRoot, adeDir }));
    try {
      services.linearCredentialService.setOAuthToken({
        accessToken: "at_rejected",
        refreshToken: "rt_dead",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      await services.linearCredentialService.ensureFreshToken({ force: true });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(services.linearCredentialService.getStatus().tokenStored).toBe(false);
    } finally {
      services.dispose();
      globalThis.fetch = previousFetch;
      if (previousAdeHome == null) delete process.env.ADE_HOME;
      else process.env.ADE_HOME = previousAdeHome;
    }
  });

  it("assigns CTO default title for cto identityKey", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.ensureIdentitySession({
      identityKey: "cto" as any,
      laneId: "lane-1",
    });
    expect(session.title).toBe("CTO Headless Session");
    expect(session.model).toBe("gpt-5.6-sol");
    expect(session.modelId).toBe("openai/gpt-5.6-sol");

    services.dispose();
  });

  it("resolves explicit model IDs to their native runtime model refs in headless sessions", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const codex = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:codex-model",
      laneId: "lane-1",
      modelId: "openai/gpt-5.5-codex",
    });
    const claude = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:claude-model",
      laneId: "lane-1",
      modelId: "anthropic/claude-opus-4-8",
    });

    expect(codex.model).toBe("gpt-5.5");
    expect(codex.modelId).toBe("openai/gpt-5.5");
    expect(claude.model).toBe("claude-opus-4-8");
    expect(claude.modelId).toBe("anthropic/claude-opus-4-8");

    services.dispose();
  });
});
