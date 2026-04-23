import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Logger } from "../../desktop/src/main/services/logging/logger";
import type { AdeDb } from "../../desktop/src/main/services/state/kvDb";
import type { createLaneService } from "../../desktop/src/main/services/lanes/laneService";
import type { createOperationService } from "../../desktop/src/main/services/history/operationService";
import type { createProjectConfigService } from "../../desktop/src/main/services/config/projectConfigService";
import type { createConflictService } from "../../desktop/src/main/services/conflicts/conflictService";
import type { createMissionService } from "../../desktop/src/main/services/missions/missionService";
import type { createAiOrchestratorService } from "../../desktop/src/main/services/orchestrator/aiOrchestratorService";
import type { createOrchestratorService } from "../../desktop/src/main/services/orchestrator/orchestratorService";
import type { createWorkerAgentService } from "../../desktop/src/main/services/cto/workerAgentService";
import type { createWorkerBudgetService } from "../../desktop/src/main/services/cto/workerBudgetService";
import type { createFileService } from "../../desktop/src/main/services/files/fileService";
import type { createProcessService } from "../../desktop/src/main/services/processes/processService";
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import type { createLinearClient } from "../../desktop/src/main/services/cto/linearClient";
import type { createLinearIssueTracker } from "../../desktop/src/main/services/cto/linearIssueTracker";
import type { createLinearTemplateService } from "../../desktop/src/main/services/cto/linearTemplateService";
import type { createLinearWorkflowFileService } from "../../desktop/src/main/services/cto/linearWorkflowFileService";
import type { createFlowPolicyService } from "../../desktop/src/main/services/cto/flowPolicyService";
import type { createLinearRoutingService } from "../../desktop/src/main/services/cto/linearRoutingService";
import type { createLinearIntakeService } from "../../desktop/src/main/services/cto/linearIntakeService";
import type { createLinearOutboundService } from "../../desktop/src/main/services/cto/linearOutboundService";
import type { createLinearCloseoutService } from "../../desktop/src/main/services/cto/linearCloseoutService";
import type { createLinearDispatcherService } from "../../desktop/src/main/services/cto/linearDispatcherService";
import type { createLinearSyncService } from "../../desktop/src/main/services/cto/linearSyncService";
import type { createLinearIngressService } from "../../desktop/src/main/services/cto/linearIngressService";
import type { createWorkerTaskSessionService } from "../../desktop/src/main/services/cto/workerTaskSessionService";
import type { createWorkerHeartbeatService } from "../../desktop/src/main/services/cto/workerHeartbeatService";
import type { createAutomationSecretService } from "../../desktop/src/main/services/automations/automationSecretService";
import type { ComputerUseArtifactBrokerService } from "../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import { getModelById, resolveModelAlias } from "../../desktop/src/shared/modelRegistry";
import type { AdeRuntimePaths } from "./bootstrap";
import { createLinearClient as createLinearClientImpl } from "../../desktop/src/main/services/cto/linearClient";
import { createLinearIssueTracker as createLinearIssueTrackerImpl } from "../../desktop/src/main/services/cto/linearIssueTracker";
import { createLinearTemplateService as createLinearTemplateServiceImpl } from "../../desktop/src/main/services/cto/linearTemplateService";
import { createLinearWorkflowFileService as createLinearWorkflowFileServiceImpl } from "../../desktop/src/main/services/cto/linearWorkflowFileService";
import { createFlowPolicyService as createFlowPolicyServiceImpl } from "../../desktop/src/main/services/cto/flowPolicyService";
import { createLinearRoutingService as createLinearRoutingServiceImpl } from "../../desktop/src/main/services/cto/linearRoutingService";
import { createLinearIntakeService as createLinearIntakeServiceImpl } from "../../desktop/src/main/services/cto/linearIntakeService";
import { createLinearOutboundService as createLinearOutboundServiceImpl } from "../../desktop/src/main/services/cto/linearOutboundService";
import { createLinearCloseoutService as createLinearCloseoutServiceImpl } from "../../desktop/src/main/services/cto/linearCloseoutService";
import { createLinearDispatcherService as createLinearDispatcherServiceImpl } from "../../desktop/src/main/services/cto/linearDispatcherService";
import { createLinearSyncService as createLinearSyncServiceImpl } from "../../desktop/src/main/services/cto/linearSyncService";
import { createLinearIngressService as createLinearIngressServiceImpl } from "../../desktop/src/main/services/cto/linearIngressService";
import { createWorkerTaskSessionService as createWorkerTaskSessionServiceImpl } from "../../desktop/src/main/services/cto/workerTaskSessionService";
import { createFileService as createFileServiceImpl } from "../../desktop/src/main/services/files/fileService";
import { createProcessService as createProcessServiceImpl } from "../../desktop/src/main/services/processes/processService";
import { createPrService as createPrServiceImpl } from "../../desktop/src/main/services/prs/prService";
import { createAutomationSecretService as createAutomationSecretServiceImpl } from "../../desktop/src/main/services/automations/automationSecretService";

type HeadlessLinearCredentialService = {
  getStatus: () => {
    tokenStored: boolean;
    tokenDecryptionFailed: boolean;
    storageScope: "app";
    repo: { owner: string; name: string } | null;
    userLogin: string | null;
    scopes: string[];
    checkedAt: string | null;
    authMode?: "manual" | "oauth" | null;
  };
  getTokenOrThrow: () => string;
  setToken: (token: string) => void;
  clearToken: () => void;
};

type HeadlessGitHubStatus = {
  tokenStored: boolean;
  tokenDecryptionFailed: boolean;
  storageScope: "app";
  tokenType?: "classic" | "fine-grained" | "unknown";
  repo: { owner: string; name: string } | null;
  userLogin: string | null;
  scopes: string[];
  checkedAt: string | null;
};

type HeadlessGitHubService = {
  getStatus: () => Promise<HeadlessGitHubStatus>;
  getRepoOrThrow: () => Promise<{ owner: string; name: string }>;
  getTokenOrThrow: () => string;
  apiRequest: <T>(args: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    token?: string;
  }) => Promise<{ data: T; response: Response | null }>;
};

type HeadlessAgentChatSession = {
  id: string;
  sessionId: string;
  laneId: string;
  provider: "codex";
  model: string;
  modelId: string;
  title: string | null;
  status: "idle" | "ended";
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  lastActivityAt: string;
  lastOutputPreview: string | null;
  summary: string | null;
  identityKey?: string;
  reasoningEffort?: string | null;
  permissionMode?: string;
};

type HeadlessTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

type HeadlessLinearDeps = {
  projectRoot: string;
  adeDir: string;
  paths: AdeRuntimePaths;
  projectId: string;
  db: AdeDb;
  logger: Logger;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  laneService: ReturnType<typeof createLaneService>;
  operationService: ReturnType<typeof createOperationService>;
  conflictService: ReturnType<typeof createConflictService>;
  missionService: ReturnType<typeof createMissionService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  aiOrchestratorService: ReturnType<typeof createAiOrchestratorService>;
  workerAgentService: ReturnType<typeof createWorkerAgentService>;
  workerBudgetService: ReturnType<typeof createWorkerBudgetService>;
  computerUseArtifactBrokerService: ComputerUseArtifactBrokerService;
  openExternal?: (url: string) => Promise<void>;
};

type HeadlessLinearServices = {
  linearCredentialService: HeadlessLinearCredentialService;
  linearClient: ReturnType<typeof createLinearClient>;
  linearIssueTracker: ReturnType<typeof createLinearIssueTracker>;
  linearTemplateService: ReturnType<typeof createLinearTemplateService>;
  linearWorkflowFileService: ReturnType<typeof createLinearWorkflowFileService>;
  flowPolicyService: ReturnType<typeof createFlowPolicyService>;
  linearRoutingService: ReturnType<typeof createLinearRoutingService>;
  linearIntakeService: ReturnType<typeof createLinearIntakeService>;
  linearOutboundService: ReturnType<typeof createLinearOutboundService>;
  linearCloseoutService: ReturnType<typeof createLinearCloseoutService>;
  linearDispatcherService: ReturnType<typeof createLinearDispatcherService>;
  linearSyncService: ReturnType<typeof createLinearSyncService>;
  linearIngressService: ReturnType<typeof createLinearIngressService>;
  fileService: ReturnType<typeof createFileService>;
  processService: ReturnType<typeof createProcessService>;
  prService: ReturnType<typeof createPrService>;
  agentChatService: {
    listSessions: () => Promise<Array<Record<string, unknown>>>;
    getSessionSummary: (sessionId: string) => Promise<Record<string, unknown> | null>;
    getChatTranscript: (args: { sessionId: string; limit?: number; maxChars?: number }) => Promise<{
      sessionId: string;
      entries: Array<{ role: "user" | "assistant"; text: string; timestamp: string }>;
      truncated: boolean;
      totalEntries: number;
    }>;
    createSession: (args: { laneId: string; title?: string }) => Promise<HeadlessAgentChatSession>;
    updateSession: (args: { sessionId: string; title?: string | null }) => Promise<HeadlessAgentChatSession>;
    sendMessage: (args: { sessionId: string; text: string }) => Promise<void>;
    interrupt: (args: { sessionId: string }) => Promise<void>;
    resumeSession: (args: { sessionId: string }) => Promise<HeadlessAgentChatSession>;
    dispose: (args: { sessionId: string }) => Promise<void>;
    ensureIdentitySession: (args: {
      identityKey: string;
      laneId: string;
      modelId?: string | null;
      reasoningEffort?: string | null;
      reuseExisting?: boolean;
      permissionMode?: string;
    }) => Promise<HeadlessAgentChatSession>;
    setComputerUseArtifactBrokerService: (svc: ComputerUseArtifactBrokerService) => void;
  };
  workerTaskSessionService: ReturnType<typeof createWorkerTaskSessionService>;
  workerHeartbeatService: ReturnType<typeof createWorkerHeartbeatService>;
  dispose: () => void;
};

function envToken(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim() ?? "";
    if (value.length) return value;
  }
  return null;
}

function ghAuthToken(): string | null {
  try {
    const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5_000 });
    if (result.status !== 0) return null;
    const token = result.stdout?.trim() ?? "";
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function detectGitHubRepo(projectRoot: string): { owner: string; name: string } | null {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  const remote = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!remote) return null;
  const ssh = remote.match(/^git@github\.com:(.+)$/i);
  if (ssh) {
    const [owner, name] = ssh[1]!.replace(/\.git$/i, "").split("/");
    if (owner && name) return { owner, name };
  }
  try {
    const url = new URL(remote);
    if (!/github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").split("/");
    const owner = parts[0]?.trim() ?? "";
    const name = parts[1]?.trim() ?? "";
    return owner && name ? { owner, name } : null;
  } catch {
    return null;
  }
}

function createHeadlessGitHubService(projectRoot: string, logger: Logger): HeadlessGitHubService {
  let cachedStatus: Awaited<ReturnType<HeadlessGitHubService["getStatus"]>> | null = null;
  let cachedAt = 0;

  const getToken = (): string => envToken("ADE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN") ?? ghAuthToken() ?? "";
  const getTokenType = (token: string): HeadlessGitHubStatus["tokenType"] => {
    if (token.startsWith("github_pat_")) return "fine-grained";
    if (token.startsWith("ghp_")) return "classic";
    return "unknown";
  };

  const apiRequest: HeadlessGitHubService["apiRequest"] = async (args) => {
    const token = (args.token ?? getToken()).trim();
    if (!token) {
      throw new Error("GitHub token missing. Set ADE_GITHUB_TOKEN or GITHUB_TOKEN, or run `gh auth login` so `gh auth token` returns a token.");
    }
    const url = new URL(`https://api.github.com${args.path}`);
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method: args.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "ade-cli",
        ...(args.body == null ? {} : { "content-type": "application/json" }),
      },
      body: args.body == null ? undefined : JSON.stringify(args.body),
    });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text.trim().length ? JSON.parse(text) : {};
    } catch {
      // keep text payload
    }
    if (!response.ok) {
      const message =
        typeof data === "object" && data && "message" in data && typeof (data as { message?: unknown }).message === "string"
          ? String((data as { message?: unknown }).message)
          : `GitHub API request failed (HTTP ${response.status})`;
      throw new Error(message);
    }
    return { data: data as never, response };
  };

  return {
    async getStatus() {
      const now = Date.now();
      if (cachedStatus && now - cachedAt < 30_000) return { ...cachedStatus, repo: detectGitHubRepo(projectRoot) };
      const repo = detectGitHubRepo(projectRoot);
      const tokenStored = Boolean(getToken());
      const status: HeadlessGitHubStatus = {
        tokenStored,
        tokenDecryptionFailed: false,
        storageScope: "app",
        tokenType: tokenStored ? getTokenType(getToken()) : "unknown",
        repo,
        userLogin: null,
        scopes: [],
        checkedAt: tokenStored ? new Date(now).toISOString() : null,
      };
      cachedStatus = status;
      cachedAt = now;
      return status;
    },
    async getRepoOrThrow() {
      const repo = detectGitHubRepo(projectRoot);
      if (!repo) throw new Error("Unable to detect GitHub repo from git remote 'origin'.");
      return repo;
    },
    getTokenOrThrow() {
      const token = getToken();
      if (!token) throw new Error("GitHub token missing. Set ADE_GITHUB_TOKEN or GITHUB_TOKEN, or run `gh auth login`.");
      return token;
    },
    apiRequest,
  };
}

function createHeadlessLinearCredentialService(): HeadlessLinearCredentialService {
  let token = envToken("ADE_LINEAR_API", "LINEAR_API_KEY", "ADE_LINEAR_TOKEN", "LINEAR_TOKEN") ?? "";
  return {
    getStatus() {
      return {
        tokenStored: token.trim().length > 0,
        tokenDecryptionFailed: false,
        storageScope: "app",
        repo: null,
        userLogin: null,
        scopes: [],
        checkedAt: token.trim().length > 0 ? new Date().toISOString() : null,
        authMode: token.trim().length > 0 ? "manual" : null,
      };
    },
    getTokenOrThrow() {
      if (!token.trim()) {
        throw new Error("Linear token missing. Set ADE_LINEAR_API, LINEAR_API_KEY, ADE_LINEAR_TOKEN, or LINEAR_TOKEN for headless mode.");
      }
      return token.trim();
    },
    setToken(nextToken: string) {
      token = nextToken.trim();
    },
    clearToken() {
      token = "";
    },
  };
}

function createHeadlessAgentChatService(projectRoot: string): HeadlessLinearServices["agentChatService"] {
  const sessions = new Map<string, HeadlessAgentChatSession>();
  const identitySessionIds = new Map<string, string>();
  const transcripts = new Map<string, HeadlessTranscriptEntry[]>();

  const HEADLESS_MODEL_ID = "openai/gpt-5.4-codex";

  const clipText = (value: string, maxChars: number): string => {
    const trimmed = value.trim();
    if (trimmed.length <= maxChars) return trimmed;
    return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  };

  const defaultTitle = (identityKey?: string): string => {
    if (identityKey === "cto") return "CTO Headless Session";
    if (identityKey) return "Headless Employee Session";
    return "Headless Work Chat";
  };

  const defaultSummary = (identityKey?: string): string =>
    identityKey
      ? `Headless ADE session for ${identityKey}. Automatic agent execution is not available in this runtime.`
      : "Headless ADE chat session. Automatic agent execution is not available in this runtime.";

  const resolveHeadlessModel = (modelId?: string | null): { modelId: string; model: string } => {
    const requested = modelId?.trim() || HEADLESS_MODEL_ID;
    const descriptor = getModelById(requested) ?? resolveModelAlias(requested);
    if (descriptor) {
      return {
        modelId: descriptor.id,
        model: descriptor.shortId,
      };
    }
    return {
      modelId: requested,
      model: requested,
    };
  };

  const ensureTranscript = (sessionId: string): HeadlessTranscriptEntry[] => {
    const existing = transcripts.get(sessionId);
    if (existing) return existing;
    const created: HeadlessTranscriptEntry[] = [];
    transcripts.set(sessionId, created);
    return created;
  };

  const ensureSession = (args: {
    sessionId?: string;
    laneId: string;
    title?: string | null;
    identityKey?: string;
    modelId?: string | null;
    reasoningEffort?: string | null;
    permissionMode?: string;
    status?: "idle" | "ended";
    endedAt?: string | null;
  }): HeadlessAgentChatSession => {
    const sessionId = args.sessionId?.trim() || `chat-${randomUUID()}`;
    const now = new Date().toISOString();
    const resolvedModel = resolveHeadlessModel(args.modelId);
    const existing = sessions.get(sessionId);
    if (existing) {
      const updated = {
        ...existing,
        laneId: existing.laneId || args.laneId,
        title: args.title?.trim() || existing.title,
        model: resolvedModel.model,
        modelId: resolvedModel.modelId,
        status: args.status ?? existing.status,
        endedAt: args.endedAt === undefined ? existing.endedAt : args.endedAt,
        identityKey: args.identityKey ?? existing.identityKey,
        reasoningEffort: args.reasoningEffort ?? existing.reasoningEffort ?? null,
        permissionMode: args.permissionMode ?? existing.permissionMode,
        summary: existing.summary ?? defaultSummary(args.identityKey ?? existing.identityKey),
        lastActivityAt: now,
      };
      sessions.set(sessionId, updated);
      ensureTranscript(sessionId);
      if (updated.identityKey) {
        identitySessionIds.set(updated.identityKey, sessionId);
      }
      return updated;
    }
    const created: HeadlessAgentChatSession = {
      id: sessionId,
      sessionId,
      laneId: args.laneId,
      provider: "codex",
      model: resolvedModel.model,
      modelId: resolvedModel.modelId,
      title: args.title?.trim() || defaultTitle(args.identityKey),
      status: args.status ?? "idle",
      startedAt: now,
      endedAt: args.endedAt ?? null,
      createdAt: now,
      lastActivityAt: now,
      lastOutputPreview: null,
      summary: defaultSummary(args.identityKey),
      ...(args.identityKey ? { identityKey: args.identityKey } : {}),
      ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    };
    sessions.set(sessionId, created);
    ensureTranscript(sessionId);
    if (created.identityKey) {
      identitySessionIds.set(created.identityKey, sessionId);
    }
    return created;
  };

  return {
    async listSessions() {
      return Array.from(sessions.values()).sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));
    },
    async getSessionSummary(sessionId: string) {
      return sessions.get(sessionId.trim()) ?? null;
    },
    async getChatTranscript({ sessionId, limit, maxChars }: { sessionId: string; limit?: number; maxChars?: number }) {
      const safeLimit = Math.max(1, Math.min(500, Math.floor(limit ?? 100)));
      const safeMaxChars = Math.max(32, Math.min(20_000, Math.floor(maxChars ?? 4_000)));
      const source = ensureTranscript(sessionId.trim());
      const entries = source.slice(-safeLimit).map((entry) => ({
        ...entry,
        text: clipText(entry.text, safeMaxChars),
      }));
      return {
        sessionId,
        entries,
        truncated: source.length > entries.length || entries.some((entry) => entry.text.length >= safeMaxChars),
        totalEntries: source.length,
      };
    },
    async createSession(args: { laneId: string; title?: string }) {
      return ensureSession({ laneId: args.laneId, title: args.title });
    },
    async updateSession(args: { sessionId: string; title?: string | null }) {
      const existing = sessions.get(args.sessionId) ?? ensureSession({ sessionId: args.sessionId, laneId: "lane-headless" });
      return ensureSession({ sessionId: existing.id, laneId: existing.laneId, title: args.title ?? existing.title });
    },
    async sendMessage(args: { sessionId: string; text: string }) {
      const sessionId = args.sessionId.trim();
      const existing = sessions.get(sessionId);
      if (existing) {
        ensureTranscript(sessionId).push({
          role: "user",
          text: args.text,
          timestamp: new Date().toISOString(),
        });
        sessions.set(sessionId, { ...existing, lastActivityAt: new Date().toISOString() });
      }
    },
    async interrupt(args: { sessionId: string }) {
      const existing = sessions.get(args.sessionId);
      if (existing) sessions.set(args.sessionId, { ...existing, lastActivityAt: new Date().toISOString() });
    },
    async resumeSession(args: { sessionId: string }) {
      return ensureSession({
        sessionId: args.sessionId,
        laneId: sessions.get(args.sessionId)?.laneId ?? "lane-headless",
        status: "idle",
        endedAt: null,
      });
    },
    async dispose(args: { sessionId: string }) {
      const existing = sessions.get(args.sessionId);
      sessions.delete(args.sessionId);
      transcripts.delete(args.sessionId);
      if (existing?.identityKey && identitySessionIds.get(existing.identityKey) === args.sessionId) {
        identitySessionIds.delete(existing.identityKey);
      }
    },
    async ensureIdentitySession(args: {
      identityKey: string;
      laneId: string;
      modelId?: string | null;
      reasoningEffort?: string | null;
      reuseExisting?: boolean;
      permissionMode?: string;
    }) {
      const identityKey = args.identityKey.trim();
      const existingSessionId = identitySessionIds.get(identityKey);
      if (args.reuseExisting !== false && existingSessionId) {
        const existing = sessions.get(existingSessionId);
        if (existing) {
          return ensureSession({
            sessionId: existingSessionId,
            laneId: existing.laneId,
            title: existing.title,
            identityKey,
            modelId: args.modelId,
            reasoningEffort: args.reasoningEffort,
            permissionMode: args.permissionMode,
          });
        }
      }
      return ensureSession({
        laneId: args.laneId,
        title: defaultTitle(identityKey),
        identityKey,
        modelId: args.modelId,
        reasoningEffort: args.reasoningEffort,
        permissionMode: args.permissionMode,
      });
    },
    setComputerUseArtifactBrokerService() {
      // no-op in headless mode
      void projectRoot;
    },
  };
}

function createHeadlessWorkerHeartbeatService(): ReturnType<typeof createWorkerHeartbeatService> {
  const runs: Array<{
    id: string;
    agentId: string;
    status: "failed";
    wakeupReason: string;
    taskKey: string | null;
    issueKey: string | null;
    context: Record<string, unknown>;
    errorMessage: string;
    startedAt: string;
    finishedAt: string;
    createdAt: string;
    updatedAt: string;
  }> = [];

  return {
    listRuns({ limit }: { limit?: number } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Math.floor(limit ?? 50)));
      return runs.slice(0, safeLimit).map((run) => ({
        ...run,
        executionRunId: null,
        executionLockedAt: null,
        result: null,
      }));
    },
    async triggerWakeup(args: { agentId: string; reason?: string; taskKey?: string | null; issueKey?: string | null; context?: Record<string, unknown> }) {
      const runId = `wake-${randomUUID()}`;
      const now = new Date().toISOString();
      runs.unshift({
        id: runId,
        agentId: args.agentId,
        status: "failed",
        wakeupReason: args.reason ?? "api",
        taskKey: args.taskKey ?? null,
        issueKey: args.issueKey ?? null,
        context: args.context ?? {},
        errorMessage: "Headless ADE mode does not support worker-backed Linear targets yet.",
        startedAt: now,
        finishedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { runId, status: "failed" };
    },
    dispose() {
      runs.length = 0;
    },
    start() {
      return;
    },
    stop() {
      return;
    },
  } as unknown as ReturnType<typeof createWorkerHeartbeatService>;
}

export function createHeadlessLinearServices(args: HeadlessLinearDeps): HeadlessLinearServices {
  const automationSecretService = createAutomationSecretServiceImpl({
    adeDir: args.adeDir,
    logger: args.logger,
  });
  const linearCredentialService = createHeadlessLinearCredentialService() as any;
  const githubService = createHeadlessGitHubService(args.projectRoot, args.logger);
  const linearClient = createLinearClientImpl({
    credentials: linearCredentialService as any,
    logger: args.logger,
  });
  const issueTracker = createLinearIssueTrackerImpl({ client: linearClient });
  const templateService = createLinearTemplateServiceImpl({ adeDir: args.adeDir });
  const workflowFileService = createLinearWorkflowFileServiceImpl({ projectRoot: args.projectRoot });
  const flowPolicyService = createFlowPolicyServiceImpl({
    db: args.db,
    projectId: args.projectId,
    projectConfigService: args.projectConfigService,
    workflowFileService,
  });
  const routingService = createLinearRoutingServiceImpl({
    flowPolicyService,
    workerAgentService: args.workerAgentService,
  });
  const intakeService = createLinearIntakeServiceImpl({
    db: args.db,
    projectId: args.projectId,
    issueTracker,
  });
  const outboundService = createLinearOutboundServiceImpl({
    db: args.db,
    projectId: args.projectId,
    projectRoot: args.projectRoot,
    issueTracker,
    logger: args.logger,
  });
  const fileService = createFileServiceImpl({
    laneService: args.laneService,
    onLaneWorktreeMutation: () => {},
  });
  const sessionService = {
    get: () => null,
  } as any;
  const ptyService = {
    create: async () => {
      throw new Error("PTY-backed run commands are unavailable in headless Linear services.");
    },
    dispose: () => {},
    onData: () => () => {},
    onExit: () => () => {},
  } as any;
  const processService = createProcessServiceImpl({
    db: args.db,
    projectId: args.projectId,
    logger: args.logger,
    laneService: args.laneService,
    projectConfigService: args.projectConfigService,
    sessionService,
    ptyService,
    broadcastEvent: () => {},
  });
  const prService = createPrServiceImpl({
    db: args.db,
    logger: args.logger,
    projectId: args.projectId,
    projectRoot: args.projectRoot,
    laneService: args.laneService,
    operationService: args.operationService,
    githubService: githubService as any,
    projectConfigService: args.projectConfigService,
    conflictService: args.conflictService,
    openExternal: args.openExternal ?? (async () => {}),
  } as any);
  const workerTaskSessionService = createWorkerTaskSessionServiceImpl({
    db: args.db,
    projectId: args.projectId,
  });
  const workerHeartbeatService = createHeadlessWorkerHeartbeatService();
  const agentChatService = createHeadlessAgentChatService(args.projectRoot);
  if (typeof (prService as { setAgentChatService?: (svc: unknown) => void }).setAgentChatService === "function") {
    (prService as { setAgentChatService: (svc: unknown) => void }).setAgentChatService(agentChatService as never);
  }
  const closeoutService = createLinearCloseoutServiceImpl({
    issueTracker,
    outboundService,
    missionService: args.missionService,
    orchestratorService: args.orchestratorService,
    prService,
    computerUseArtifactBrokerService: args.computerUseArtifactBrokerService,
  });
  const dispatcherService = createLinearDispatcherServiceImpl({
    db: args.db,
    projectId: args.projectId,
    issueTracker,
    workerAgentService: args.workerAgentService,
    workerHeartbeatService,
    missionService: args.missionService,
    aiOrchestratorService: args.aiOrchestratorService,
    agentChatService: agentChatService as never,
    laneService: args.laneService,
    templateService,
    closeoutService,
    outboundService,
    workerTaskSessionService,
    prService,
    onEvent: () => {},
  });
  const syncService = createLinearSyncServiceImpl({
    db: args.db,
    logger: args.logger,
    projectId: args.projectId,
    flowPolicyService,
    routingService,
    intakeService,
    issueTracker,
    dispatcherService,
    autoStart: false,
    hasCredentials: () => linearCredentialService.getStatus().tokenStored,
  });
  const handleIngressEvent = async (event: { issueId?: string | null }) => {
    const issueId = typeof event.issueId === "string" ? event.issueId.trim() : "";
    if (!issueId) return;
    await syncService.processIssueUpdate(issueId);
  };
  const ingressService = createLinearIngressServiceImpl({
    db: args.db,
    logger: args.logger,
    projectId: args.projectId,
    linearClient,
    secretService: automationSecretService as ReturnType<typeof createAutomationSecretService>,
    onEvent: handleIngressEvent,
  });

  return {
    linearCredentialService,
    linearClient,
    linearIssueTracker: issueTracker,
    linearTemplateService: templateService,
    linearWorkflowFileService: workflowFileService,
    flowPolicyService,
    linearRoutingService: routingService,
    linearIntakeService: intakeService,
    linearOutboundService: outboundService,
    linearCloseoutService: closeoutService,
    linearDispatcherService: dispatcherService,
    linearSyncService: syncService,
    linearIngressService: ingressService,
    fileService,
    processService,
    prService,
    agentChatService,
    workerTaskSessionService,
    workerHeartbeatService,
    dispose: () => {
      try {
        syncService.dispose();
      } catch {
        // ignore
      }
      try {
        ingressService.dispose();
      } catch {
        // ignore
      }
      try {
        fileService.dispose();
      } catch {
        // ignore
      }
      try {
        processService.disposeAll();
      } catch {
        // ignore
      }
      try {
        workerHeartbeatService.dispose();
      } catch {
        // ignore
      }
    },
  };
}
