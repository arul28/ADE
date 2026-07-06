import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LaneListSnapshot, LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import {
  ADE_ACTION_ALLOWLIST,
  getAdeActionInputContract,
  getAdeActionDomainServices,
  isCtoOnlyAdeAction,
  isAllowedAdeAction,
  listAllowedAdeActionNames,
  type AdeActionDomain,
} from "./registry";

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    const value = updates[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("isAllowedAdeAction", () => {
  it("accepts a canonical action from the allowlist", () => {
    expect(isAllowedAdeAction("git", "commit")).toBe(true);
    expect(isAllowedAdeAction("lane", "create")).toBe(true);
    expect(isAllowedAdeAction("automations", "triggerManually")).toBe(true);
    expect(isAllowedAdeAction("issue", "addComment")).toBe(true);
  });

  it("exposes the session-scoped Linear link lane actions for CLI/automation reach", () => {
    expect(isAllowedAdeAction("lane", "attachLinearIssueToSession")).toBe(true);
    expect(isAllowedAdeAction("lane", "detachLinearIssueFromSession")).toBe(true);
    expect(isAllowedAdeAction("lane", "listLinearIssuesForSession")).toBe(true);
    expect(isAllowedAdeAction("lane", "listLinearIssuesForLaneSessions")).toBe(true);
    expect(isAllowedAdeAction("lane", "unlinkLinearIssues")).toBe(true);
  });

  it("exposes the Linear issue tracker write actions for the CLI daemon bridge", () => {
    // CLI agents have no Linear creds; they write back through the daemon
    // bridge, so these must be agent-reachable (not CTO-gated).
    expect(isAllowedAdeAction("linear_issue_tracker", "updateIssueState")).toBe(true);
    expect(isAllowedAdeAction("linear_issue_tracker", "createComment")).toBe(true);
    expect(isAllowedAdeAction("linear_issue_tracker", "updateIssueAssignee")).toBe(true);
    expect(isAllowedAdeAction("linear_issue_tracker", "addLabel")).toBe(true);
    expect(isCtoOnlyAdeAction("linear_issue_tracker", "updateIssueState")).toBe(false);
    expect(isCtoOnlyAdeAction("linear_issue_tracker", "addLabel")).toBe(false);
  });

  it("exposes CLI agent launch through the chat runtime action surface", () => {
    expect(isAllowedAdeAction("chat", "launchCli")).toBe(true);
    expect(isCtoOnlyAdeAction("chat", "launchCli")).toBe(false);
  });

  it("exposes iOS Preview Lab matching and workspace readiness to generic actions", () => {
    expect(isAllowedAdeAction("ios_simulator", "resolvePreviewMatch")).toBe(true);
    expect(isAllowedAdeAction("ios_simulator", "ensurePreviewWorkspace")).toBe(true);
    expect(isAllowedAdeAction("ios_simulator", "renderCurrentPreview")).toBe(true);
    expect(isCtoOnlyAdeAction("ios_simulator", "resolvePreviewMatch")).toBe(false);
    expect(isCtoOnlyAdeAction("ios_simulator", "ensurePreviewWorkspace")).toBe(false);
    expect(isCtoOnlyAdeAction("ios_simulator", "renderCurrentPreview")).toBe(false);
  });

  it("exposes subagent transcript reads through the chat runtime action surface", () => {
    expect(isAllowedAdeAction("chat", "getSubagentTranscript")).toBe(true);
    expect(isAllowedAdeAction("chat", "readTranscript")).toBe(true);
    expect(isAllowedAdeAction("chat", "sendMessage")).toBe(true);
    expect(isCtoOnlyAdeAction("chat", "getSubagentTranscript")).toBe(false);
    expect(isCtoOnlyAdeAction("chat", "readTranscript")).toBe(false);
    expect(isCtoOnlyAdeAction("chat", "sendMessage")).toBe(false);
  });

  it("exposes Codex goal actions and getCommit through the runtime action surface", () => {
    expect(isAllowedAdeAction("chat", "setCodexGoal")).toBe(true);
    expect(isAllowedAdeAction("chat", "setCodexGoalStatus")).toBe(true);
    expect(isAllowedAdeAction("chat", "clearCodexGoal")).toBe(true);
    expect(isAllowedAdeAction("chat", "getCodexGoal")).toBe(true);
    expect(isAllowedAdeAction("git", "getCommit")).toBe(true);
  });

  it("rejects an unknown action on a known domain", () => {
    expect(isAllowedAdeAction("git", "rmRf")).toBe(false);
    expect(isAllowedAdeAction("issue", "deleteAllIssues")).toBe(false);
    expect(isAllowedAdeAction("automations", "__proto__")).toBe(false);
  });

  it("rejects an unknown domain outright", () => {
    expect(isAllowedAdeAction("not-a-domain" as AdeActionDomain, "anything")).toBe(false);
  });

  it("is case-sensitive on the action name", () => {
    // The allowlist is authored in the exact camelCase the service exposes.
    // Case-insensitive matching would mask typos/mistakes in rules.
    expect(isAllowedAdeAction("git", "Commit")).toBe(false);
    expect(isAllowedAdeAction("git", "COMMIT")).toBe(false);
  });

  it("each allowlist entry is marked allowed by the predicate", () => {
    // Round-trip: whatever is in the data drives the predicate, so this
    // guards against accidental mutations (e.g. a trailing space in a name).
    for (const [domain, actions] of Object.entries(ADE_ACTION_ALLOWLIST) as Array<
      [AdeActionDomain, readonly string[] | undefined]
    >) {
      for (const action of actions ?? []) {
        expect(isAllowedAdeAction(domain, action)).toBe(true);
      }
    }
  });
});

describe("getAdeActionDomainServices feature gates", () => {
  it("hides Automations and Linear ingress domains in packaged builds", () => {
    withEnv(
      {
        ADE_ENABLE_AUTOMATIONS: undefined,
        ADE_DISABLE_AUTOMATIONS: undefined,
      },
      () => {
        const services = getAdeActionDomainServices({
          isPackaged: true,
          automationService: {},
          automationPlannerService: {},
          automationIngressService: {},
          linearIngressService: {},
        } as never);

        expect(services.automation_planner).toBeNull();
        expect(services.automations).toBeNull();
        expect(services.linear_ingress).toBeNull();
      },
    );
  });

  it("keeps internal domains available in dev builds", () => {
    withEnv(
      {
        ADE_ENABLE_AUTOMATIONS: undefined,
        ADE_DISABLE_AUTOMATIONS: undefined,
      },
      () => {
        const services = getAdeActionDomainServices({
          isPackaged: false,
          automationPlannerService: { parseNaturalLanguage: () => undefined },
          linearIngressService: { getStatus: () => undefined },
        } as never);

        expect(services.automation_planner).not.toBeNull();
        expect(services.linear_ingress).not.toBeNull();
      },
    );
  });
});

describe("listAllowedAdeActionNames", () => {
  it("returns only allowlisted names that the service actually implements as functions", () => {
    const service = {
      commit: () => undefined,
      pull: () => undefined,
      push: () => undefined,
      stash: () => undefined,
      // Extras that are NOT in the allowlist — must not leak through.
      rmRf: () => undefined,
      internalHelper: () => undefined,
      // Key present but not callable — must be filtered out.
      fetch: "not-a-function",
    } as Record<string, unknown>;

    const names = listAllowedAdeActionNames("git", service);

    expect(names).toContain("commit");
    expect(names).toContain("pull");
    expect(names).toContain("push");
    expect(names).toContain("stash");
    expect(names).not.toContain("rmRf");
    expect(names).not.toContain("internalHelper");
    // Present in allowlist but not a function on the service → drop.
    expect(names).not.toContain("fetch");
  });

  it("returns names sorted alphabetically for a stable UI ordering", () => {
    const service: Record<string, unknown> = {};
    for (const name of ADE_ACTION_ALLOWLIST.git ?? []) {
      service[name] = () => undefined;
    }

    const names = listAllowedAdeActionNames("git", service);
    const sortedCopy = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sortedCopy);
  });

  it("returns an empty array when the domain has no allowlist entry", () => {
    // A fabricated domain name hits the `?? []` fallback; the service is
    // irrelevant because nothing is allowed.
    const names = listAllowedAdeActionNames(
      "made-up-domain" as AdeActionDomain,
      { foo: () => undefined } as Record<string, unknown>,
    );
    expect(names).toEqual([]);
  });

  it("returns an empty array when the service implements none of the allowlisted names", () => {
    const service = { someUnrelated: () => undefined } as Record<string, unknown>;
    const names = listAllowedAdeActionNames("git", service);
    expect(names).toEqual([]);
  });
});

describe("isCtoOnlyAdeAction", () => {
  it("keeps AI credential mutations CTO-only", () => {
    expect(isCtoOnlyAdeAction("ai", "storeApiKey")).toBe(true);
    expect(isCtoOnlyAdeAction("ai", "deleteApiKey")).toBe(true);
    expect(isCtoOnlyAdeAction("ai", "listApiKeys")).toBe(false);
  });

});

describe("ADE_ACTION_ALLOWLIST shape", () => {
  it("has no duplicate action names within any domain", () => {
    // A duplicate would be a silent footgun: the sort would keep both,
    // and the predicate would be correct but the UI would render the name twice.
    for (const [domain, actions] of Object.entries(ADE_ACTION_ALLOWLIST)) {
      if (!actions) continue;
      const unique = new Set(actions);
      expect(unique.size, `domain "${domain}" has duplicate action names`).toBe(actions.length);
    }
  });

  it("exposes the automations domain with the full CRUD + trigger surface", () => {
    // Automations self-management via ADE action is load-bearing — the /automations
    // IPC handlers and the CLI both depend on these exact names.
    const actions = ADE_ACTION_ALLOWLIST.automations ?? [];
    for (const name of [
      "list",
      "get",
      "saveRule",
      "deleteRule",
      "toggleRule",
      "triggerManually",
      "listRuns",
      "getRunDetail",
      "getIngressStatus",
      "startIngress",
      "refreshWebhookGatewayStatus",
      "setWebhookGatewayPublicUrl",
    ]) {
      expect(actions).toContain(name);
    }
    expect(isCtoOnlyAdeAction("automations", "setWebhookGatewayPublicUrl")).toBe(true);
    expect(isCtoOnlyAdeAction("automations", "refreshWebhookGatewayStatus")).toBe(false);
  });

  it("exposes the issue domain with GitHub issue mutation helpers", () => {
    const actions = ADE_ACTION_ALLOWLIST.issue ?? [];
    for (const name of ["addComment", "setLabels", "close", "reopen", "assign", "setTitle"]) {
      expect(actions).toContain(name);
    }
  });

  it("exposes lane.listSnapshots for runtime-backed lane snapshot parity", () => {
    const actions = ADE_ACTION_ALLOWLIST.lane ?? [];
    expect(actions).toContain("listSnapshots");
  });

  it("exposes lane.listDeleteProgress for runtime-backed lane delete progress recovery", () => {
    const actions = ADE_ACTION_ALLOWLIST.lane ?? [];
    expect(actions).toContain("listDeleteProgress");
  });

  it("exposes pr.listPrsByLane for runtime-backed drawer PR pills", () => {
    const actions = ADE_ACTION_ALLOWLIST.pr ?? [];
    expect(actions).toContain("listPrsByLane");
  });

  it("exposes ade_project.clearLocalData for runtime-backed cleanup", () => {
    const actions = ADE_ACTION_ALLOWLIST.ade_project ?? [];
    expect(actions).toContain("clearLocalData");
  });

  it("exposes session.getDelta for runtime-backed session delta reads", () => {
    const actions = ADE_ACTION_ALLOWLIST.session ?? [];
    expect(actions).toContain("getDelta");
  });

  it("exposes computer-use backend status and artifact preview reads for runtime-backed proof flows", () => {
    const actions = ADE_ACTION_ALLOWLIST.computer_use_artifacts ?? [];
    expect(actions).toContain("getBackendStatus");
    expect(actions).toContain("readArtifactPreview");
  });

  it("exposes Linear issue tracker composite reads for runtime-backed CTO views", () => {
    const actions = ADE_ACTION_ALLOWLIST.linear_issue_tracker ?? [];
    expect(actions).toContain("getWorkflowCatalog");
    expect(actions).toContain("getIssuePickerData");
    expect(actions).toContain("getConnectionStatus");
    expect(actions).toContain("getQuickView");
    expect(ADE_ACTION_ALLOWLIST.linear_routing ?? []).toContain("simulateRoute");
    expect(ADE_ACTION_ALLOWLIST.linear_oauth ?? []).toEqual(expect.arrayContaining([
      "getSession",
      "startSession",
    ]));
  });

  it("exposes CTO identity session and scan wrappers for runtime-backed CTO views", () => {
    const chatActions = ADE_ACTION_ALLOWLIST.chat ?? [];
    expect(chatActions).toContain("ensureCtoSession");
    expect(chatActions).toContain("ensureAgentIdentitySession");
    expect(chatActions).toContain("getSubagentTranscript");
    expect(chatActions).toContain("modelCatalog");
    expect(ADE_ACTION_ALLOWLIST.cto_state ?? []).toContain("runProjectScan");
  });

  it("exposes chat.modelCatalog as a runtime action alias", async () => {
    const getModelCatalog = vi.fn(async (args?: unknown) => ({ args, groups: [] }));
    const runtime = {
      agentChatService: {
        getModelCatalog,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];

    const chat = getAdeActionDomainServices(runtime).chat as {
      modelCatalog?: (args?: unknown) => Promise<unknown>;
    };

    await expect(chat.modelCatalog?.({ mode: "cached" })).resolves.toEqual({
      args: { mode: "cached" },
      groups: [],
    });
    expect(listAllowedAdeActionNames("chat", chat as Record<string, unknown>)).toContain("modelCatalog");
    expect(getModelCatalog).toHaveBeenCalledWith({ mode: "cached" });
  });

  it("documents chat action input contracts for CLI action discovery", () => {
    expect(getAdeActionInputContract("chat", "createSession")).toMatchObject({
      input: expect.stringContaining("reasoningEffort"),
      example: expect.stringContaining("permissionMode"),
    });
    expect(getAdeActionInputContract("chat", "getSessionSummary")).toMatchObject({
      input: expect.stringContaining("scalar sessionId"),
    });
    expect(getAdeActionInputContract("chat", "readTranscript")).toMatchObject({
      input: expect.stringContaining("limit"),
    });
    expect(getAdeActionInputContract("chat", "sendMessage")).toMatchObject({
      description: expect.stringContaining("asynchronously"),
    });
  });

  it("normalizes chat action argument shapes for model discovery, summaries, transcript reads, and sends", async () => {
    const createSession = vi.fn(async (args?: unknown) => ({ sessionId: "chat-new", args }));
    const getAvailableModels = vi.fn(async (args: { provider?: string }) => [{ id: args.provider ?? "any" }]);
    const getSessionSummary = vi.fn(async (sessionId: string) => ({ sessionId }));
    const readTranscript = vi.fn(async (sessionId: string, limit?: number, since?: string) => ([
      { role: "user", text: sessionId, timestamp: since ?? "now", limit },
    ]));
    const sendMessage = vi.fn(async () => undefined);
    const runtime = {
      agentChatService: {
        createSession,
        getAvailableModels,
        getSessionSummary,
        readTranscript,
        sendMessage,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];

    const chat = getAdeActionDomainServices(runtime).chat as {
      createSession?: (args?: unknown) => Promise<unknown>;
      getAvailableModels?: (args?: unknown) => Promise<unknown>;
      getSessionSummary?: (args?: unknown) => Promise<unknown>;
      readTranscript?: (args?: unknown) => Promise<unknown>;
      sendMessage?: (args?: unknown) => Promise<unknown>;
    };

    await expect(chat.getAvailableModels?.({})).resolves.toEqual([{ id: "any" }]);
    expect(getAvailableModels).toHaveBeenCalledWith({});

    await expect(chat.getSessionSummary?.({ sessionId: " chat-1 " })).resolves.toEqual({ sessionId: "chat-1" });
    await expect(chat.getSessionSummary?.("chat-2")).resolves.toEqual({ sessionId: "chat-2" });
    expect(getSessionSummary).toHaveBeenNthCalledWith(1, "chat-1");
    expect(getSessionSummary).toHaveBeenNthCalledWith(2, "chat-2");

    await expect(chat.createSession?.({
      laneId: "lane-1",
      provider: "codex",
      reasoningEffort: "xhigh",
    })).resolves.toMatchObject({
      sessionId: "chat-new",
      args: {
        laneId: "lane-1",
        provider: "codex",
        reasoningEffort: "xhigh",
      },
    });
    expect(createSession).toHaveBeenCalledWith({
      laneId: "lane-1",
      provider: "codex",
      reasoningEffort: "xhigh",
    });

    await expect(chat.readTranscript?.({
      sessionId: " chat-1 ",
      limit: "25",
      since: "2026-06-29T00:00:00.000Z",
    })).resolves.toEqual([
      {
        role: "user",
        text: "chat-1",
        timestamp: "2026-06-29T00:00:00.000Z",
        limit: 25,
      },
    ]);
    expect(readTranscript).toHaveBeenCalledWith("chat-1", 25, "2026-06-29T00:00:00.000Z");

    await expect(chat.sendMessage?.({
      sessionId: " chat-1 ",
      text: "next",
    })).resolves.toMatchObject({
      ok: true,
      accepted: true,
      sessionId: "chat-1",
    });
    expect(sendMessage).toHaveBeenCalledWith({ sessionId: "chat-1", text: "next" });
    await expect(chat.sendMessage?.({ sessionId: "chat-1", text: "   " })).rejects.toThrow(/text/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("falls back to headless chat transcript reads when readTranscript is unavailable", async () => {
    const getChatTranscript = vi.fn(async () => ({
      sessionId: "chat-1",
      entries: [
        { role: "user", text: "old", timestamp: "2026-06-28T00:00:00.000Z" },
        { role: "assistant", text: "new", timestamp: "2026-06-29T00:00:00.000Z" },
      ],
      totalEntries: 2,
      truncated: false,
    }));
    const runtime = {
      agentChatService: {
        getChatTranscript,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];

    const chat = getAdeActionDomainServices(runtime).chat as {
      readTranscript?: (args?: unknown) => Promise<unknown>;
    };

    await expect(chat.readTranscript?.({
      sessionId: " chat-1 ",
      limit: "25",
      since: "2026-06-29T00:00:00.000Z",
    })).resolves.toMatchObject({
      sessionId: "chat-1",
      entries: [
        { role: "assistant", text: "new", timestamp: "2026-06-29T00:00:00.000Z" },
      ],
    });
    expect(getChatTranscript).toHaveBeenCalledWith({ sessionId: "chat-1", limit: 25 });
  });

  it("unwraps chat.listSessions action args before calling the positional chat service API", async () => {
    const listSessions = vi.fn(async () => []);
    const runtime = {
      agentChatService: {
        listSessions,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];

    const chat = getAdeActionDomainServices(runtime).chat as {
      listSessions?: (args?: unknown) => Promise<unknown>;
    };

    await expect(chat.listSessions?.({
      laneId: " lane-1 ",
      includeAutomation: true,
    })).resolves.toEqual([]);
    expect(listAllowedAdeActionNames("chat", chat as Record<string, unknown>)).toContain("listSessions");
    expect(listSessions).toHaveBeenCalledWith("lane-1", { includeAutomation: true });
  });

  it("exposes bounded project-local image preview reads through chat actions", async () => {
    const projectRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-chat-preview-"));
    let outsidePath: string | null = null;
    try {
      const imagePath = path.join(projectRoot, ".ade", "attachments", "image.png");
      await fs.promises.mkdir(path.dirname(imagePath), { recursive: true });
      await fs.promises.writeFile(
        imagePath,
        Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
      );
      const textPath = path.join(projectRoot, "not-image.txt");
      await fs.promises.writeFile(textPath, "not an image");
      outsidePath = path.join(os.tmpdir(), `outside-${Date.now()}.png`);
      await fs.promises.writeFile(outsidePath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
      const symlinkPath = path.join(projectRoot, ".ade", "attachments", "outside-link.png");
      await fs.promises.symlink(outsidePath, symlinkPath);

      const runtime = {
        projectRoot,
        agentChatService: {},
      } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
      const chat = getAdeActionDomainServices(runtime).chat as {
        getImageDataUrl: (args: { path: string }) => Promise<{ dataUrl: string }>;
      } & Record<string, unknown>;

      expect(listAllowedAdeActionNames("chat", chat)).toContain("getImageDataUrl");
      await expect(chat.getImageDataUrl({ path: imagePath })).resolves.toEqual(
        expect.objectContaining({ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) }),
      );
      await expect(chat.getImageDataUrl({ path: textPath })).rejects.toThrow(/not an image/i);
      await expect(chat.getImageDataUrl({ path: outsidePath })).rejects.toThrow(/inside the project/i);
      await expect(chat.getImageDataUrl({ path: symlinkPath })).rejects.toThrow(/inside the project|escapes root/i);
    } finally {
      await fs.promises.rm(projectRoot, { recursive: true, force: true });
      if (outsidePath) {
        await fs.promises.rm(outsidePath, { force: true });
      }
    }
  });

  it("exposes the browser panel and tab control surface", () => {
    const actions = ADE_ACTION_ALLOWLIST.built_in_browser ?? [];
    for (const name of ["claim", "startSession", "listSessions", "endSession", "showPanel", "navigate", "createTab", "switchTab", "closeTab", "observe", "getTrace", "click", "typeText", "dispatchKey", "scroll", "fill", "clear", "wait"]) {
      expect(actions).toContain(name);
    }
  });

});


describe("runtime Linear issue tracker actions", () => {
  it("builds catalog and picker payloads from tracker reads", async () => {
    const projects = [{ id: "project-1", name: "ADE" }];
    const users = [{ id: "user-1", name: "Arul" }];
    const labels = [{ id: "label-1", name: "Bug" }];
    const states = [{ id: "state-1", name: "Todo" }];
    const issues = [
      { id: "LIN-1", title: "First" },
      { id: "LIN-2", title: "Second" },
      { id: "LIN-3", title: "Third" },
    ];
    const fetchCandidateIssues = vi.fn(async () => issues);
    const tracker = {
      getConnectionStatus: vi.fn(async () => ({
        connected: true,
        viewerId: "user-1",
        viewerName: "Arul",
        message: null,
      })),
      fetchCandidateIssues,
      listProjects: vi.fn(async () => projects),
      listUsers: vi.fn(async () => users),
      listLabels: vi.fn(async () => labels),
      listWorkflowStates: vi.fn(async () => states),
      runGraphQL: vi.fn(async (args: unknown) => ({ data: args })),
    };
    const runtime = {
      linearCredentialService: {
        getStatus: vi.fn(() => ({
          tokenStored: true,
          authMode: "oauth",
          oauthConfigured: true,
          tokenExpiresAt: null,
        })),
      },
      linearIssueTracker: tracker,
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const service = getAdeActionDomainServices(runtime).linear_issue_tracker as {
      getStatus: () => Promise<unknown>;
      getWorkflowCatalog: () => Promise<unknown>;
      getIssuePickerData: () => Promise<unknown>;
      listIssues: (args?: Record<string, unknown>) => Promise<unknown>;
      graphql: (args?: Record<string, unknown>) => Promise<unknown>;
    } & Record<string, unknown>;

    expect(listAllowedAdeActionNames("linear_issue_tracker", service)).toContain("getStatus");
    expect(listAllowedAdeActionNames("linear_issue_tracker", service)).toContain("listIssues");
    expect(listAllowedAdeActionNames("linear_issue_tracker", service)).toContain("graphql");
    expect(listAllowedAdeActionNames("linear_issue_tracker", service)).not.toContain("runGraphQL");
    expect(listAllowedAdeActionNames("linear_issue_tracker", service)).toContain("getWorkflowCatalog");
    expect(listAllowedAdeActionNames("linear_issue_tracker", service)).toContain("getIssuePickerData");
    await expect(service.getStatus()).resolves.toMatchObject({ connected: true, tokenStored: true });
    await expect(service.listIssues({ project: "desktop,cli", state: ["open"], limit: 2 })).resolves.toEqual(issues.slice(0, 2));
    expect(fetchCandidateIssues).toHaveBeenCalledWith({ projectSlugs: ["desktop", "cli"], stateTypes: ["open"] });
    await expect(service.graphql({ query: "query Viewer { viewer { id } }", variables: { first: 1 } })).resolves.toEqual({
      data: { query: "query Viewer { viewer { id } }", variables: { first: 1 } },
    });
    expect(tracker.runGraphQL).toHaveBeenCalledWith({
      query: "query Viewer { viewer { id } }",
      variables: { first: 1 },
    });
    await expect(service.graphql({ query: "query Viewer { viewer { id } }", maxRetries: 99 })).resolves.toEqual({
      data: { query: "query Viewer { viewer { id } }", maxRetries: 10 },
    });
    expect(tracker.runGraphQL).toHaveBeenLastCalledWith({
      query: "query Viewer { viewer { id } }",
      maxRetries: 10,
    });
    expect(tracker.getConnectionStatus).toHaveBeenCalledTimes(2);
    await expect(service.getWorkflowCatalog()).resolves.toEqual({ users, labels, states });
    await expect(service.getIssuePickerData()).resolves.toEqual({ projects, users, states });
  });

  it("prechecks Linear connection before GraphQL actions", async () => {
    const tracker = {
      getConnectionStatus: vi.fn(async () => ({
        connected: false,
        viewerId: null,
        viewerName: null,
        message: "Linear token not configured.",
      })),
      runGraphQL: vi.fn(async () => ({})),
    };
    const runtime = {
      linearCredentialService: {
        getStatus: vi.fn(() => ({
          tokenStored: true,
          authMode: "oauth",
          oauthConfigured: true,
          tokenExpiresAt: null,
        })),
      },
      linearIssueTracker: tracker,
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const service = getAdeActionDomainServices(runtime).linear_issue_tracker as {
      graphql: (args?: Record<string, unknown>) => Promise<unknown>;
    };

    await expect(service.graphql({ query: "query Viewer { viewer { id } }" })).rejects.toThrow(
      "Linear is not connected: Linear token not configured.",
    );
    expect(tracker.runGraphQL).not.toHaveBeenCalled();
  });
});

describe("runtime Linear OAuth actions", () => {
  it("adds connection status to completed OAuth sessions", async () => {
    const start = { sessionId: "linear-oauth-1", authUrl: "https://linear.app/oauth/authorize", redirectUri: "http://127.0.0.1:19836/oauth/callback" };
    const runtime = {
      linearOAuthService: {
        startSession: vi.fn(async () => start),
        getSession: vi.fn(() => ({ status: "completed" })),
      },
      linearCredentialService: {
        getStatus: vi.fn(() => ({
          tokenStored: true,
          authMode: "oauth",
          oauthConfigured: true,
          tokenExpiresAt: "2026-05-10T00:00:00.000Z",
        })),
      },
      linearIssueTracker: {
        getConnectionStatus: vi.fn(async () => ({
          connected: true,
          viewerId: "user-1",
          viewerName: "Arul",
          message: null,
        })),
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const service = getAdeActionDomainServices(runtime).linear_oauth as {
      startSession: () => Promise<unknown>;
      getSession: (sessionId: string) => Promise<unknown>;
    } & Record<string, unknown>;

    expect(listAllowedAdeActionNames("linear_oauth", service)).toEqual(["getSession", "startSession"]);
    await expect(service.startSession()).resolves.toEqual(start);
    await expect(service.getSession("linear-oauth-1")).resolves.toMatchObject({
      status: "completed",
      connection: {
        tokenStored: true,
        connected: true,
        viewerId: "user-1",
        viewerName: "Arul",
        authMode: "oauth",
        oauthAvailable: true,
      },
    });
  });
});

describe("runtime session actions", () => {
  it("launches tracked CLI agents through runtime chat actions", async () => {
    const ptyCreate = vi.fn(async (args: { sessionId: string }) => ({
      sessionId: args.sessionId,
      ptyId: "pty-1",
      pid: 123,
    }));
    const runtime = {
      projectRoot: "/repo",
      agentChatService: {},
      laneService: {
        getLaneWorktreePath: vi.fn(() => "/repo/.ade/worktrees/lane-1"),
        getLaneBaseAndBranch: vi.fn(),
      },
      ptyService: {
        create: ptyCreate,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const chatService = getAdeActionDomainServices(runtime).chat as {
      launchCli: (args: {
        laneId: string;
        provider: "codex";
        model: string;
        kickoffPrompt: string;
        linearIssues: Array<{ id: string }>;
      }) => Promise<{ sessionId: string; ptyId: string; pid: number | null; attachedLinearIssueIds: string[] }>;
    } & Record<string, unknown>;

    expect(listAllowedAdeActionNames("chat", chatService)).toContain("launchCli");
    const result = await chatService.launchCli({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      kickoffPrompt: "Work the issue",
      linearIssues: [{ id: "issue-1" }],
    });

    const createArg = ptyCreate.mock.calls[0]?.[0] as {
      sessionId: string;
      chatSessionId: string;
      laneId: string;
      tracked: boolean;
      toolType: string;
      linearIssues: Array<{ id: string }>;
      startupCommand: string;
    };
    expect(createArg).toMatchObject({
      chatSessionId: createArg.sessionId,
      laneId: "lane-1",
      tracked: true,
      toolType: "codex",
      linearIssues: [{ id: "issue-1" }],
    });
    expect(createArg.startupCommand).toContain("codex");
    expect(result).toMatchObject({
      sessionId: createArg.sessionId,
      ptyId: "pty-1",
      pid: 123,
      attachedLinearIssueIds: ["issue-1"],
    });
  });

  it("forwards remote subagent transcript reads through chat actions", async () => {
    const transcript = [{ role: "assistant", content: "subagent output" }];
    const getSubagentTranscript = vi.fn(async () => transcript);
    const runtime = {
      agentChatService: {
        getSubagentTranscript,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const chatService = getAdeActionDomainServices(runtime).chat as {
      getSubagentTranscript: (args: {
        sessionId: string;
        subagentId: string;
      }) => Promise<Array<{ role: string; content: string }>>;
    } & Record<string, unknown>;

    expect(listAllowedAdeActionNames("chat", chatService)).toContain("getSubagentTranscript");
    await expect(chatService.getSubagentTranscript({
      sessionId: "chat-1",
      subagentId: "subagent-1",
    })).resolves.toEqual(transcript);
    expect(getSubagentTranscript).toHaveBeenCalledWith({
      sessionId: "chat-1",
      subagentId: "subagent-1",
    });
  });

  it("adds getDelta from the runtime session delta service", () => {
    const delta = { sessionId: "session-1", filesChanged: 2 };
    const runtime = {
      sessionService: {
        get: vi.fn(),
        list: vi.fn(),
        readTranscriptTail: vi.fn(),
      },
      sessionDeltaService: {
        getSessionDelta: vi.fn(() => delta),
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const sessionService = getAdeActionDomainServices(runtime).session as {
      getDelta: (args: { sessionId: string }) => unknown;
    } & Record<string, unknown>;

    expect(listAllowedAdeActionNames("session", sessionService)).toContain("getDelta");
    expect(sessionService.getDelta({ sessionId: "session-1" })).toEqual(delta);
    expect(runtime.sessionDeltaService?.getSessionDelta).toHaveBeenCalledWith("session-1");
  });

  it("routes readTranscriptTail through ptyService so live PTY output is included", async () => {
    const runtime = {
      sessionService: {
        get: vi.fn(),
        list: vi.fn(),
        readTranscriptTail: vi.fn(async () => "stale disk tail"),
      },
      ptyService: {
        readTranscriptTail: vi.fn(async () => "live merged tail"),
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const sessionService = getAdeActionDomainServices(runtime).session as {
      readTranscriptTail: (args: { sessionId: string; maxBytes?: number; raw?: boolean }) => Promise<string>;
    } & Record<string, unknown>;

    await expect(sessionService.readTranscriptTail({
      sessionId: "session-1",
      maxBytes: 999,
      raw: true,
    })).resolves.toBe("live merged tail");
    expect(runtime.ptyService?.readTranscriptTail).toHaveBeenCalledWith({
      sessionId: "session-1",
      maxBytes: 1024,
      raw: true,
      alignToLineBoundary: true,
    });
    expect(runtime.sessionService.readTranscriptTail).not.toHaveBeenCalled();
  });

  it("disposes a live terminal before deleting through the runtime action service", async () => {
    const terminalSession = {
      id: "terminal-1",
      toolType: "shell",
      status: "running",
      ptyId: null,
    };
    const disposedSession = {
      ...terminalSession,
      status: "disposed",
      ptyId: null,
    };
    const deleteSession = vi.fn(() => true);
    const dispose = vi.fn();
    const runtime = {
      sessionService: {
        get: vi.fn()
          .mockReturnValueOnce(terminalSession)
          .mockReturnValueOnce(disposedSession),
        list: vi.fn(),
        deleteSession,
      },
      ptyService: {
        enrichSessions: vi.fn((sessions: any[]) => {
          const session = sessions[0];
          if (session.status === "running") {
            return [{
              ...session,
              status: "running",
              ptyId: "pty-1",
            }];
          }
          return sessions;
        }),
        isSessionOwnedByLivePeerRuntime: vi.fn(() => false),
        dispose,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const sessionService = getAdeActionDomainServices(runtime).session as {
      deleteSession: (sessionId: string) => boolean;
    } & Record<string, unknown>;

    expect(sessionService.deleteSession(" terminal-1 ")).toBe(true);
    expect(dispose).toHaveBeenCalledWith({ ptyId: "pty-1", sessionId: "terminal-1" });
    expect(deleteSession).toHaveBeenCalledWith("terminal-1");
  });

  it("refuses to delete a terminal owned by another runtime through the runtime action service", () => {
    const terminalSession = {
      id: "terminal-1",
      toolType: "shell",
      status: "running",
      ptyId: null,
      ownerPid: 12345,
    };
    const deleteSession = vi.fn(() => true);
    const dispose = vi.fn();
    const runtime = {
      sessionService: {
        get: vi.fn(() => terminalSession),
        list: vi.fn(),
        deleteSession,
      },
      ptyService: {
        enrichSessions: vi.fn((sessions: any[]) => [
          {
            ...sessions[0],
            status: "detached",
            ptyId: null,
          },
        ]),
        isSessionOwnedByLivePeerRuntime: vi.fn(() => true),
        dispose,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const sessionService = getAdeActionDomainServices(runtime).session as {
      deleteSession: (sessionId: string) => boolean;
    } & Record<string, unknown>;

    expect(() => sessionService.deleteSession("terminal-1")).toThrow("still owned by another ADE runtime");
    expect(dispose).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  });
});

describe("runtime computer-use artifact actions", () => {
  it("exposes backend status and artifact preview reads from the broker", async () => {
    const backendStatus = {
      backends: [],
      localFallback: { available: true, detail: "available", supportedKinds: ["screenshot"] },
    };
    const broker = {
      getBackendStatus: vi.fn(() => backendStatus),
      ingest: vi.fn(),
      listArtifacts: vi.fn(),
      readArtifactPreview: vi.fn(async () => "data:image/png;base64,AAAA"),
      routeArtifact: vi.fn(),
      updateArtifactReview: vi.fn(),
    };
    const runtime = {
      computerUseArtifactBrokerService: broker,
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const artifactService = getAdeActionDomainServices(runtime).computer_use_artifacts as {
      getBackendStatus: () => unknown;
      readArtifactPreview: (args: { uri: string }) => Promise<string | null>;
    } & Record<string, unknown>;

    expect(listAllowedAdeActionNames("computer_use_artifacts", artifactService)).toContain("getBackendStatus");
    expect(listAllowedAdeActionNames("computer_use_artifacts", artifactService)).toContain("readArtifactPreview");
    expect(artifactService.getBackendStatus()).toBe(backendStatus);
    await expect(artifactService.readArtifactPreview({ uri: ".ade/artifacts/a.png" })).resolves.toBe("data:image/png;base64,AAAA");
    expect(broker.getBackendStatus).toHaveBeenCalledTimes(1);
    expect(broker.readArtifactPreview).toHaveBeenCalledWith({ uri: ".ade/artifacts/a.png" });
  });
});

const TEST_NOW = "2026-05-10T00:00:00.000Z";

function makeLane(overrides: Partial<LaneSummary> & Pick<LaneSummary, "id" | "name">): LaneSummary {
  return {
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: `feature/${overrides.id}`,
    worktreePath: `/tmp/${overrides.id}`,
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: 0,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: TEST_NOW,
    archivedAt: null,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<TerminalSessionSummary> & Pick<TerminalSessionSummary, "id" | "laneId">,
): TerminalSessionSummary {
  return {
    laneName: "Runtime lane",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "codex",
    title: overrides.id,
    status: "running",
    startedAt: TEST_NOW,
    endedAt: null,
    exitCode: null,
    transcriptPath: `/tmp/${overrides.id}.log`,
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  };
}

describe("runtime lane snapshot actions", () => {
  it("runs lane delete with env teardown and port release in the runtime action domain", async () => {
    const lane = makeLane({ id: "lane-delete", name: "Delete me" });
    const envInitConfig = { dependencies: ["npm install"] };
    const cleanupLaneEnvironment = vi.fn(async () => undefined);
    const release = vi.fn();
    const deleteLane = vi.fn(async (_args, opts?: { teardownEnv?: () => Promise<void> }) => {
      await opts?.teardownEnv?.();
    });
    const runtime = {
      laneService: {
        list: vi.fn(async () => [lane]),
        delete: deleteLane,
      },
      projectConfigService: {
        getEffective: vi.fn(() => ({
          laneEnvInit: null,
          laneOverlayPolicies: [],
        })),
      },
      laneEnvironmentService: {
        resolveEnvInitConfig: vi.fn(() => envInitConfig),
        cleanupLaneEnvironment,
      },
      portAllocationService: {
        getLease: vi.fn(() => null),
        release,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const laneService = getAdeActionDomainServices(runtime).lane as {
      delete?: (args: { laneId: string; force?: boolean; deleteBranch?: boolean }) => Promise<void>;
    };

    await laneService.delete?.({ laneId: lane.id, force: true, deleteBranch: false });

    expect(deleteLane).toHaveBeenCalledWith(
      { laneId: lane.id, force: true, deleteBranch: false },
      { teardownEnv: expect.any(Function) },
    );
    expect(cleanupLaneEnvironment).toHaveBeenCalledWith(lane, envInitConfig);
    expect(release).toHaveBeenCalledWith(lane.id);
  });

  it("builds rich lane.listSnapshots results from runtime services", async () => {
    const lane = makeLane({ id: "lane-runtime", name: "Runtime lane" });
    const attachedLane = makeLane({
      id: "lane-attached",
      name: "Attached lane",
      laneType: "attached",
      attachedRootPath: "/external/attached",
    });
    const device = { deviceId: "ios-1", displayName: "iPhone", platform: "ios" };
    const rebaseSuggestion = {
      laneId: lane.id,
      parentLaneId: "parent-1",
      parentHeadSha: "abc1234",
      behindCount: 3,
      baseLabel: "main",
      groupContext: null,
      lastSuggestedAt: TEST_NOW,
      deferredUntil: null,
      dismissedAt: null,
      hasPr: true,
    };
    const autoRebaseStatus = {
      laneId: lane.id,
      parentLaneId: "parent-1",
      parentHeadSha: "def5678",
      state: "rebaseConflict" as const,
      updatedAt: TEST_NOW,
      conflictCount: 2,
      message: "Rebase needs attention.",
    };
    const conflictStatus = {
      laneId: lane.id,
      status: "conflict-predicted" as const,
      overlappingFileCount: 4,
      peerConflictCount: 1,
      lastPredictedAt: TEST_NOW,
    };
    const stateSnapshot = {
      laneId: lane.id,
      agentSummary: { activeAgent: "codex" },
      updatedAt: TEST_NOW,
    };
    const sessions = [
      makeSession({
        id: "running-terminal",
        laneId: lane.id,
        lastOutputPreview: "running tests",
      }),
      makeSession({
        id: "awaiting-chat",
        laneId: lane.id,
        toolType: "codex-chat",
        lastOutputPreview: "thinking",
      }),
      makeSession({
        id: "ended-terminal",
        laneId: lane.id,
        status: "completed",
        runtimeState: "exited",
        endedAt: TEST_NOW,
        exitCode: 0,
        lastOutputPreview: "done",
      }),
      makeSession({
        id: "attached-running-terminal",
        laneId: attachedLane.id,
      }),
    ];
    const list = vi.fn(() => [lane, attachedLane]);
    const listStateSnapshots = vi.fn(() => [stateSnapshot]);
    const runtime = {
      laneService: {
        list,
        listStateSnapshots,
      },
      sessionService: {
        list: vi.fn(() => sessions),
      },
      ptyService: {
        enrichSessions: vi.fn((entries: TerminalSessionSummary[]) => entries),
      },
      agentChatService: {
        listSessions: vi.fn(async () => [
          {
            sessionId: "awaiting-chat",
            status: "active",
            awaitingInput: true,
            pendingInputItemId: "pending-1",
            identityKey: null,
          },
        ]),
      },
      rebaseSuggestionService: {
        listSuggestions: vi.fn(() => [rebaseSuggestion]),
      },
      autoRebaseService: {
        listStatuses: vi.fn(() => [autoRebaseStatus]),
      },
      conflictService: {
        getBatchAssessment: vi.fn(() => ({ lanes: [conflictStatus] })),
      },
      syncService: {
        getHostService: () => ({
          getLanePresenceSnapshot: () => [{ laneId: lane.id, devicesOpen: [device] }],
        }),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const laneService = getAdeActionDomainServices(runtime).lane as {
      listSnapshots?: (args?: unknown) => Promise<LaneListSnapshot[]>;
    };

    expect(laneService.listSnapshots).toEqual(expect.any(Function));
    expect(listAllowedAdeActionNames("lane", laneService as Record<string, unknown>)).toContain("listSnapshots");

    const snapshots = await laneService.listSnapshots?.({
      includeConflictStatus: true,
      includeRebaseSuggestions: true,
      includeAutoRebaseStatus: true,
    });

    expect(list).toHaveBeenCalledWith({
      includeArchived: false,
      includeStatus: true,
    });
    expect(snapshots).toEqual([
      {
        lane: {
          ...lane,
          devicesOpen: [device],
        },
        runtime: {
          bucket: "awaiting-input",
          runningCount: 1,
          awaitingInputCount: 1,
          pendingInputCount: 1,
          endedCount: 1,
          sessionCount: 3,
        },
        rebaseSuggestion,
        autoRebaseStatus,
        conflictStatus,
        stateSnapshot,
        adoptableAttached: false,
      },
      {
        lane: {
          ...attachedLane,
          devicesOpen: undefined,
        },
        runtime: {
          bucket: "running",
          runningCount: 1,
          awaitingInputCount: 0,
          pendingInputCount: 0,
          endedCount: 0,
          sessionCount: 1,
        },
        rebaseSuggestion: null,
        autoRebaseStatus: null,
        conflictStatus: null,
        stateSnapshot: null,
        adoptableAttached: true,
      },
    ]);
  });
});

describe("runtime AI actions", () => {
  it("exposes AI status and key storage actions through the allowlist", () => {
    const runtime = {
      aiIntegrationService: {
        getStatus: vi.fn(),
        getDailyUsageBatch: vi.fn(() => new Map()),
        getFeatureFlag: vi.fn(),
        getDailyBudgetLimit: vi.fn(),
        verifyApiKeyConnection: vi.fn(),
        storeApiKey: vi.fn(),
        deleteApiKey: vi.fn(),
        listApiKeys: vi.fn(),
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const aiService = getAdeActionDomainServices(runtime).ai as Record<string, unknown>;

    for (const action of [
      "getStatus",
      "getOpenCodeRuntimeDiagnostics",
      "isOpenCodeInstalled",
      "cursorCloudStreamRun",
      "storeApiKey",
      "deleteApiKey",
      "listApiKeys",
    ]) {
      expect(aiService[action]).toEqual(expect.any(Function));
      expect(listAllowedAdeActionNames("ai", aiService)).toContain(action);
    }
  });

  it("exposes Cursor Cloud stream subscription tokens through the runtime AI service", () => {
    const runtime = {
      aiIntegrationService: {
        getDailyUsageBatch: vi.fn(() => new Map()),
        getFeatureFlag: vi.fn(),
        getDailyBudgetLimit: vi.fn(),
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const aiService = getAdeActionDomainServices(runtime).ai as {
      cursorCloudStreamRun(args?: { agentId?: string; runId?: string }): {
        subscriptionId: string;
      };
    };

    expect(
      aiService.cursorCloudStreamRun({ agentId: "agent-1", runId: "run-1" }),
    ).toEqual({ subscriptionId: "cursor-cloud-stream-agent-1-run-1" });
  });

  it("returns IPC-shaped AI status rows from the runtime AI service", async () => {
    const featureUsage = new Map([["narratives", 2]]);
    const getStatus = vi.fn(async () => ({
      mode: "subscription",
      availableProviders: {
        claude: {
          binary: { present: true, source: "path", path: "/usr/local/bin/claude" },
          auth: { ready: true, mode: "oauth", detail: null },
        },
        codex: false,
        cursor: false,
        droid: false,
      },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      detectedAuth: [],
      providerConnections: undefined,
      runtimeConnections: {},
      availableModelIds: [],
      opencodeBinaryInstalled: false,
      opencodeBinarySource: "missing",
      opencodeInventoryError: null,
      opencodeProviders: [],
      apiKeyStore: {
        secureStorageAvailable: true,
        legacyPlaintextDetected: false,
        decryptionFailed: false,
      },
    }));
    const runtime = {
      aiIntegrationService: {
        getStatus,
        getDailyUsageBatch: vi.fn(() => featureUsage),
        getFeatureFlag: vi.fn((feature: string) => feature === "narratives"),
        getDailyBudgetLimit: vi.fn((feature: string) => feature === "narratives" ? 5 : null),
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const aiService = getAdeActionDomainServices(runtime).ai as {
      getStatus(args?: { force?: boolean; refreshOpenCodeInventory?: boolean }): Promise<{
        features: Array<{ feature: string; enabled: boolean; dailyUsage: number; dailyLimit: number | null }>;
      }>;
    };

    const status = await aiService.getStatus({ force: true, refreshOpenCodeInventory: true });

    expect(getStatus).toHaveBeenCalledWith({
      force: true,
      refreshOpenCodeInventory: true,
    });
    expect(status.features).toContainEqual({
      feature: "narratives",
      enabled: true,
      dailyUsage: 2,
      dailyLimit: 5,
    });
  });

  it("delegates AI key mutations to the runtime service", () => {
    const storeApiKey = vi.fn();
    const deleteApiKey = vi.fn();
    const listApiKeys = vi.fn(() => ["cursor"]);
    const runtime = {
      aiIntegrationService: {
        verifyApiKeyConnection: vi.fn(),
        storeApiKey,
        deleteApiKey,
        listApiKeys,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const aiService = getAdeActionDomainServices(runtime).ai as {
      storeApiKey(args?: { provider?: string; key?: string }): void;
      deleteApiKey(args?: { provider?: string }): void;
      listApiKeys(): string[];
    };

    aiService.storeApiKey({ provider: " Cursor ", key: " key " });
    aiService.deleteApiKey({ provider: " Cursor " });

    expect(aiService.listApiKeys()).toEqual(["cursor"]);
    expect(storeApiKey).toHaveBeenCalledWith("Cursor", "key");
    expect(deleteApiKey).toHaveBeenCalledWith("Cursor");
  });
});

describe("runtime GitHub actions", () => {
  it("allowlists github.detectRepo when the runtime service exposes it", () => {
    const runtime = {
      githubService: {
        getStatus: vi.fn(),
        getRemoteStatus: vi.fn(),
        setToken: vi.fn(),
        clearToken: vi.fn(),
        getRepoOrThrow: vi.fn(),
        detectRepo: vi.fn(),
        getAppInstallationStatus: vi.fn(),
        listRepoAutolinks: vi.fn(),
        createRepoAutolink: vi.fn(),
        listRepoLabels: vi.fn(),
        listRepoCollaborators: vi.fn(),
        publishCurrentProject: vi.fn(),
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const githubService = getAdeActionDomainServices(runtime).github as Record<string, unknown>;

    expect(githubService.detectRepo).toEqual(expect.any(Function));
    expect(listAllowedAdeActionNames("github", githubService)).toContain("detectRepo");
    expect(listAllowedAdeActionNames("github", githubService)).toEqual(expect.arrayContaining([
      "listRepoCollaborators",
      "getAppInstallationStatus",
      "listRepoAutolinks",
      "createRepoAutolink",
      "listRepoLabels",
      "getRemoteStatus",
      "publishCurrentProject",
    ]));
  });

  it("routes object-shaped GitHub repo picker args to the positional service methods", async () => {
    const listRepoLabels = vi.fn(async () => [{ name: "bug" }]);
    const listRepoCollaborators = vi.fn(async () => [{ login: "octocat" }]);
    const listRepoAutolinks = vi.fn(async () => [{ keyPrefix: "ADE-", urlTemplate: "https://example.test/<num>" }]);
    const createRepoAutolink = vi.fn(async () => ({ keyPrefix: "ADE-", urlTemplate: "https://example.test/<num>" }));
    const runtime = {
      githubService: {
        getStatus: vi.fn(),
        setToken: vi.fn(),
        clearToken: vi.fn(),
        getRepoOrThrow: vi.fn(),
        detectRepo: vi.fn(),
        listRepoLabels,
        listRepoCollaborators,
        listRepoAutolinks,
        createRepoAutolink,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const githubService = getAdeActionDomainServices(runtime).github as {
      listRepoLabels(args?: { owner?: string; name?: string }): Promise<unknown>;
      listRepoCollaborators(args?: { owner?: string; name?: string }): Promise<unknown>;
      listRepoAutolinks(args?: { owner?: string; name?: string }): Promise<unknown>;
      createRepoAutolink(args?: { owner?: string; name?: string; keyPrefix?: string; urlTemplate?: string; isAlphanumeric?: boolean }): Promise<unknown>;
    };

    await expect(githubService.listRepoLabels({ owner: " acme ", name: " ade " })).resolves.toEqual([{ name: "bug" }]);
    await expect(githubService.listRepoCollaborators({ owner: " acme ", name: " ade " })).resolves.toEqual([{ login: "octocat" }]);
    await expect(githubService.listRepoAutolinks({ owner: " acme ", name: " ade " })).resolves.toEqual([{ keyPrefix: "ADE-", urlTemplate: "https://example.test/<num>" }]);
    await expect(githubService.createRepoAutolink({
      owner: " acme ",
      name: " ade ",
      keyPrefix: " ADE- ",
      urlTemplate: " https://example.test/<num> ",
    })).resolves.toEqual({ keyPrefix: "ADE-", urlTemplate: "https://example.test/<num>" });

    expect(listRepoLabels).toHaveBeenCalledWith("acme", "ade");
    expect(listRepoCollaborators).toHaveBeenCalledWith("acme", "ade");
    expect(listRepoAutolinks).toHaveBeenCalledWith("acme", "ade");
    expect(createRepoAutolink).toHaveBeenCalledWith("acme", "ade", {
      keyPrefix: "ADE-",
      urlTemplate: "https://example.test/<num>",
      isAlphanumeric: false,
    });
  });

  it("routes object-shaped publish args to the GitHub service", async () => {
    const publishCurrentProject = vi.fn(async () => ({
      state: "pushed" as const,
      owner: "acme",
      name: "ade",
      fullName: "acme/ade",
      htmlUrl: "https://github.com/acme/ade",
    }));
    const runtime = {
      githubService: {
        getStatus: vi.fn(),
        setToken: vi.fn(),
        clearToken: vi.fn(),
        getRepoOrThrow: vi.fn(),
        detectRepo: vi.fn(),
        publishCurrentProject,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];
    const githubService = getAdeActionDomainServices(runtime).github as {
      publishCurrentProject(args?: { owner?: string; name?: string; description?: string; isPrivate?: boolean }): Promise<unknown>;
    };

    await expect(githubService.publishCurrentProject({
      owner: " acme ",
      name: " ade ",
      description: "Local-first agent desk",
      isPrivate: true,
    })).resolves.toEqual({
      state: "pushed",
      owner: "acme",
      name: "ade",
      fullName: "acme/ade",
      htmlUrl: "https://github.com/acme/ade",
    });
    await expect(githubService.publishCurrentProject({ name: "ade" })).rejects.toThrow("Expected 'isPrivate' to be a boolean.");

    expect(publishCurrentProject).toHaveBeenCalledWith({
      owner: "acme",
      name: "ade",
      description: "Local-first agent desk",
      isPrivate: true,
    });
  });

  it("returns fresh GitHub status after token mutations", async () => {
    let tokenStored = false;
    const setToken = vi.fn((token: string) => {
      tokenStored = token.length > 0;
    });
    const clearToken = vi.fn(() => {
      tokenStored = false;
    });
    const runtime = {
      githubService: {
        getStatus: vi.fn(async () => ({
          tokenStored,
          patTokenStored: tokenStored,
          tokenDecryptionFailed: false,
          storageScope: "app",
          authSource: tokenStored ? "pat" : "none",
          tokenType: tokenStored ? "classic" : "unknown",
          repo: { owner: "ade", name: "runtime" },
          hasOrigin: true,
          userLogin: null,
          scopes: [],
          ghCliPath: null,
          ghAuthError: null,
          checkedAt: tokenStored ? TEST_NOW : null,
          repoAccessOk: tokenStored,
          repoAccessError: tokenStored ? null : "GitHub auth missing.",
          connected: tokenStored,
        })),
        setToken,
        clearToken,
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];

    const githubService = getAdeActionDomainServices(runtime).github as {
      setToken(token: string): Promise<{
        connected: boolean;
        hasOrigin: boolean;
        repoAccessError: string | null;
        repoAccessOk: boolean | null;
        tokenStored: boolean;
      }>;
      clearToken(): Promise<{
        connected: boolean;
        hasOrigin: boolean;
        repoAccessError: string | null;
        repoAccessOk: boolean | null;
        tokenStored: boolean;
      }>;
    };

    await expect(githubService.setToken("ghp_test")).resolves.toMatchObject({
      connected: true,
      hasOrigin: true,
      repoAccessError: null,
      repoAccessOk: true,
      tokenStored: true,
    });
    await expect(githubService.clearToken()).resolves.toMatchObject({
      connected: false,
      hasOrigin: true,
      repoAccessError: "GitHub auth missing.",
      repoAccessOk: false,
      tokenStored: false,
    });
    expect(setToken).toHaveBeenCalledWith("ghp_test");
    expect(clearToken).toHaveBeenCalled();
  });
});

describe("runtime file actions", () => {
  it("uses the runtime client id as the file watcher sender without leaking metadata to file args", async () => {
    const pushedEvents: unknown[] = [];
    const watchWorkspace = vi.fn(async (args, callback, senderId) => {
      callback({
        workspaceId: "ws-1",
        type: "modified",
        path: "src/App.tsx",
        ts: "2026-05-10T00:00:00.000Z",
      });
      return { args, senderId };
    });
    const stopWatching = vi.fn();
    const runtime = {
      fileService: {
        watchWorkspace,
        stopWatching,
      },
      eventBuffer: {
        push(event: unknown) {
          pushedEvents.push(event);
        },
      },
    } as unknown as Parameters<typeof getAdeActionDomainServices>[0];

    const fileService = getAdeActionDomainServices(runtime).file as {
      watchWorkspace(args?: unknown): Promise<{ ok: true }>;
      stopWatching(args?: unknown): { ok: true };
    };

    await fileService.watchWorkspace({
      workspaceId: "ws-1",
      includeIgnored: true,
      __adeRuntimeClientId: 42,
    });
    fileService.stopWatching({
      workspaceId: "ws-1",
      includeIgnored: true,
      __adeRuntimeClientId: 42,
    });

    expect(watchWorkspace).toHaveBeenCalledWith(
      { workspaceId: "ws-1", includeIgnored: true },
      expect.any(Function),
      42,
    );
    expect(stopWatching).toHaveBeenCalledWith(
      { workspaceId: "ws-1", includeIgnored: true },
      42,
    );
    expect(pushedEvents).toEqual([
      expect.objectContaining({
        category: "runtime",
        payload: {
          type: "file_change",
          event: expect.objectContaining({ path: "src/App.tsx" }),
        },
      }),
    ]);
  });
});

describe("search domain", () => {
  it("exposes the universal search actions through the runtime action surface", () => {
    expect(isAllowedAdeAction("search", "query")).toBe(true);
    expect(isAllowedAdeAction("search", "indexStatus")).toBe(true);
    expect(isAllowedAdeAction("search", "rebuildIndex")).toBe(true);
    expect(isAllowedAdeAction("search", "dispose")).toBe(false);
  });

  it("keeps query and indexStatus readable by every role while rebuildIndex stays CTO-only", () => {
    expect(isCtoOnlyAdeAction("search", "query")).toBe(false);
    expect(isCtoOnlyAdeAction("search", "indexStatus")).toBe(false);
    expect(isCtoOnlyAdeAction("search", "rebuildIndex")).toBe(true);
  });

  it("delegates to runtime.searchService and is unavailable without one", () => {
    const query = vi.fn().mockResolvedValue({ results: [], totalByKind: {}, nextCursor: null });
    const indexStatus = vi.fn().mockReturnValue({ ready: true });
    const rebuildIndex = vi.fn().mockReturnValue({ started: true });

    const withService = getAdeActionDomainServices({
      searchService: { query, indexStatus, rebuildIndex },
    } as never);
    const searchDomain = withService.search as Record<string, (args?: unknown) => unknown>;
    expect(searchDomain).not.toBeNull();
    void searchDomain.query!({ query: "hello", kinds: ["chat"] });
    expect(query).toHaveBeenCalledWith({ query: "hello", kinds: ["chat"] });
    searchDomain.indexStatus!();
    expect(indexStatus).toHaveBeenCalled();
    searchDomain.rebuildIndex!();
    expect(rebuildIndex).toHaveBeenCalled();

    const withoutService = getAdeActionDomainServices({} as never);
    expect(withoutService.search).toBeNull();
  });

  it("lists exactly the implemented allowlisted action names", () => {
    const services = getAdeActionDomainServices({
      searchService: {
        query: () => undefined,
        indexStatus: () => undefined,
        rebuildIndex: () => undefined,
      },
    } as never);
    expect(listAllowedAdeActionNames("search", services.search as Record<string, unknown>)).toEqual([
      "indexStatus",
      "query",
      "rebuildIndex",
    ]);
  });
});
