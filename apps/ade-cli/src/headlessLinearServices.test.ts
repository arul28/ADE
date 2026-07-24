import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

vi.mock("../../desktop/src/main/services/processes/processService", () => ({
  createProcessService: vi.fn(() => ({ disposeAll: vi.fn() })),
}));

vi.mock("../../desktop/src/main/services/prs/prService", () => ({
  createPrService: vi.fn(() => ({ setAgentChatService: vi.fn() })),
}));

vi.mock("../../desktop/src/main/services/automations/automationSecretService", () => ({
  createAutomationSecretService: vi.fn(() => ({})),
}));

import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";
import { createHeadlessGitHubService, createHeadlessLinearServices } from "./headlessLinearServices";

function createDeps(overrides: Record<string, any> = {}) {
  const projectRoot = overrides.projectRoot ?? "/tmp/ade-project";
  const adeDir = overrides.adeDir ?? path.join(projectRoot, ".ade");
  return {
    projectRoot,
    adeDir,
    paths: {
      adeDir,
      logsDir: path.join(adeDir, "logs"),
      processLogsDir: path.join(adeDir, "logs", "processes"),
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
    expect(services.processService).toBeTruthy();
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
