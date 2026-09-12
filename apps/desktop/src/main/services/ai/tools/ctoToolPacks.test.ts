import { describe, expect, it, vi } from "vitest";
import {
  applyCtoToolPackVisibility,
  createCtoOperatorTools,
  type CtoOperatorToolDeps,
  type CtoOperatorToolMap,
} from "./ctoOperatorTools";
import { CTO_TOOL_PACK_NAMES, CTO_TOOL_PACK_SCOPES, type CtoToolPack } from "./ctoToolPacks";

/**
 * The MINIMUM dep set — what `previewSessionToolNames` builds when it only
 * wants tool NAMES for the prompt manifest. Nothing optional is wired.
 */
function previewShapedDeps(overrides: Partial<CtoOperatorToolDeps> = {}): CtoOperatorToolDeps {
  return {
    currentSessionId: "preview",
    defaultLaneId: "lane-1",
    resolveExecutionLane: vi.fn().mockResolvedValue("lane-1"),
    laneService: { list: vi.fn().mockResolvedValue([]), create: vi.fn() } as any,
    sessionService: { updateMeta: vi.fn() } as any,
    listChats: vi.fn().mockResolvedValue([]),
    getChatStatus: vi.fn().mockResolvedValue(null),
    getChatTranscript: vi.fn(),
    steerChat: vi.fn(),
    cancelSteer: vi.fn(),
    listSubagents: vi.fn(),
    approveToolUse: vi.fn(),
    createChat: vi.fn(),
    updateChatSession: vi.fn(),
    sendChatMessage: vi.fn(),
    interruptChat: vi.fn(),
    ensureCtoSession: vi.fn(),
    ...overrides,
  };
}

/** A live session's dep set: every optional service wired. */
function runtimeShapedDeps(overrides: Partial<CtoOperatorToolDeps> = {}): CtoOperatorToolDeps {
  const loaded = new Set<CtoToolPack>();
  return previewShapedDeps({
    prService: {} as any,
    fileService: {} as any,
    testService: {} as any,
    ptyService: {} as any,
    automationService: {} as any,
    gitService: {} as any,
    conflictService: {} as any,
    computerUseArtifactBrokerService: {} as any,
    issueTracker: {} as any,
    ctoStateService: {} as any,
    ctoMemoryService: {} as any,
    onToolPackLoaded: (pack) => loaded.add(pack),
    loadedToolPacks: () => loaded,
    requestApproval: vi.fn().mockResolvedValue({ approved: true }),
    automationPlannerService: {} as any,
    automationRuleService: {} as any,
    handoffSession: vi.fn(),
    scheduledWorkService: {} as any,
    proofIngestService: {} as any,
    reviewService: {} as any,
    searchService: {} as any,
    usageService: {} as any,
    budgetService: {} as any,
    projectConfigService: {} as any,
    projectSecretService: { list: vi.fn().mockReturnValue([]) },
    iosSimulatorService: {} as any,
    appControlService: {} as any,
    builtInBrowserService: {} as any,
    orchestrationService: {} as any,
    ...overrides,
  });
}

describe("CTO tool packs", () => {
  // ── Pack membership is total and derived ──────────────────────────────────

  it("gives every tool a known pack, and derives alwaysLoad from it", () => {
    const tools = createCtoOperatorTools(runtimeShapedDeps());
    const entries = Object.entries(tools);
    expect(entries.length).toBeGreaterThan(50);

    for (const [name, definition] of entries) {
      expect(CTO_TOOL_PACK_NAMES, `${name} has an unknown pack '${definition.pack}'`)
        .toContain(definition.pack);
      // The core pack is loaded BY CONSTRUCTION: `alwaysLoad` is never hand-set,
      // so it can only ever equal "this tool is in core".
      expect(definition.alwaysLoad, `${name} alwaysLoad must follow its pack`)
        .toBe(definition.pack === "core");
    }
  });

  it("keeps the core pack non-empty and covering the CTO's standing surface", () => {
    const tools = createCtoOperatorTools(runtimeShapedDeps());
    const core = Object.entries(tools)
      .filter(([, definition]) => definition.pack === "core")
      .map(([name]) => name);

    // Lanes, chats, steering, git, PRs, automations, handoff, memory, events.
    for (const expected of [
      "listLanes", "createLane",
      "listChats", "spawnChat", "sendChatMessage",
      "steerChat", "cancelSteer",
      "gitStatus", "gitCommit", "gitPush",
      "listPullRequests", "createPrFromLane", "landPullRequest",
      "listAutomations", "saveAutomation", "deleteAutomation",
      "handoffChatToModel",
      "saveMemory", "readMemory",
      "getRecentEvents",
      "loadCtoTools",
    ]) {
      expect(core, `${expected} must be in the always-loaded core pack`).toContain(expected);
    }
  });

  it("declares a scope line for every pack", () => {
    for (const pack of CTO_TOOL_PACK_NAMES) {
      expect(CTO_TOOL_PACK_SCOPES[pack]?.length ?? 0).toBeGreaterThan(10);
    }
  });

  // ── Parity: the advertised surface never differs from the callable one ────

  it("registers the same tools whether or not optional services are wired", () => {
    // This is the parity guarantee behind flipping ENABLE_TOOL_SEARCH on for the
    // CTO: `previewSessionToolNames` builds the map from a bare dep set and the
    // runtime builds it from a full one. If registration were ever made
    // conditional on a dep, the prompt manifest would advertise a tool the
    // session cannot call — or hide one it can.
    const preview = Object.keys(createCtoOperatorTools(previewShapedDeps())).sort();
    const runtime = Object.keys(createCtoOperatorTools(runtimeShapedDeps())).sort();
    expect(preview).toEqual(runtime);
  });

  it("does not add or drop a tool when packs are hidden", () => {
    const tools = createCtoOperatorTools(runtimeShapedDeps());
    const advertised = applyCtoToolPackVisibility(tools, []);
    expect(Object.keys(advertised).sort()).toEqual(Object.keys(tools).sort());
  });

  it("never advertises MORE text than the full catalog", () => {
    // The first cut of this mechanism did: a stub plus its pointer is longer
    // than a one-line description, so "deferring" grew the catalog by 4KB.
    const tools = createCtoOperatorTools(runtimeShapedDeps());
    const advertised = applyCtoToolPackVisibility(tools, []);
    const bytes = (map: Record<string, { description: string }>) =>
      Object.values(map).reduce((total, entry) => total + entry.description.length, 0);
    expect(bytes(advertised as never)).toBeLessThan(bytes(tools as never));
  });

  // ── Deferral behaviour ────────────────────────────────────────────────────

  it("leaves core descriptions untouched and stubs unloaded extension packs", () => {
    const tools = createCtoOperatorTools(runtimeShapedDeps());
    const advertised = applyCtoToolPackVisibility(tools, []);

    expect(advertised.listLanes!.description).toBe(tools.listLanes!.description);
    expect(advertised.loadCtoTools!.description).toBe(tools.loadCtoTools!.description);

    const deferred = advertised.startReviewRun!;
    expect(deferred.description).not.toBe(tools.startReviewRun!.description);
    expect(deferred.description).toContain('[pack "review"; loadCtoTools for the rest]');
    // Deferral must never cost bytes — that guard is the reason short tools
    // keep their real text instead of growing a longer stub.
    expect(deferred.description.length).toBeLessThan(tools.startReviewRun!.description.length);
    // Still callable, and still carrying its real schema — deferral is quiet,
    // never unreachable.
    expect(deferred.inputSchema).toBe(tools.startReviewRun!.inputSchema);
    expect(deferred.execute).toBe(tools.startReviewRun!.execute);
  });

  it("restores the full description once its pack is loaded", () => {
    const tools = createCtoOperatorTools(runtimeShapedDeps());
    const advertised = applyCtoToolPackVisibility(tools, ["review"]);
    expect(advertised.startReviewRun!.description).toBe(tools.startReviewRun!.description);
    // Another pack stays deferred — loading one pack does not load them all.
    expect(advertised.getUsageStats!.description).toContain('[pack "insights"; loadCtoTools for the rest]');
  });

  it("records the pack and reports its tools when loadCtoTools runs", async () => {
    const loaded = new Set<CtoToolPack>();
    const tools = createCtoOperatorTools(runtimeShapedDeps({
      onToolPackLoaded: (pack) => loaded.add(pack),
      loadedToolPacks: () => loaded,
    }));

    const listing = await tools.loadCtoTools!.execute({}) as {
      packs: Array<{ pack: string; loaded: boolean; alwaysLoaded: boolean }>;
    };
    expect(listing.packs).toHaveLength(CTO_TOOL_PACK_NAMES.length);
    expect(listing.packs.find((entry) => entry.pack === "core")).toMatchObject({
      loaded: true,
      alwaysLoaded: true,
    });
    expect(listing.packs.find((entry) => entry.pack === "devices")?.loaded).toBe(false);
    // Listing alone must not load anything.
    expect(loaded.size).toBe(0);

    const result = await tools.loadCtoTools!.execute({ pack: "devices" }) as {
      pack: string;
      count: number;
      tools: Array<{ name: string; description: string }>;
    };
    expect(loaded.has("devices")).toBe(true);
    expect(result.pack).toBe("devices");
    expect(result.count).toBeGreaterThan(0);
    expect(result.tools.map((entry) => entry.name)).toContain("getIosSimulatorStatus");
  });
});

describe("destructive CTO tools", () => {
  const DESTRUCTIVE = [
    {
      tool: "deleteAutomation",
      input: { id: "rule-1" },
      reason: "removes a rule and its schedule permanently",
    },
    {
      tool: "cancelScheduledWork",
      input: { sessionId: "chat-1", scheduleId: "sched-1" },
      reason: "a cancelled durable job cannot be restored",
    },
    {
      tool: "saveAutomation",
      input: { draft: { id: "rule-1", name: "x" } },
      reason: "a draft carrying an id overwrites the live rule in place",
    },
  ] as const;

  function destructiveDeps(requestApproval: CtoOperatorToolDeps["requestApproval"]): CtoOperatorToolMap {
    return createCtoOperatorTools(runtimeShapedDeps({
      requestApproval,
      automationRuleService: {
        get: vi.fn(),
        deleteRule: vi.fn().mockReturnValue([]),
        toggleRule: vi.fn().mockReturnValue([]),
      },
      automationPlannerService: {
        parseNaturalLanguage: vi.fn(),
        validateDraft: vi.fn(),
        saveDraft: vi.fn().mockReturnValue({ rule: { id: "rule-1" }, rules: [] }),
        simulate: vi.fn(),
      },
      scheduledWorkService: {
        create: vi.fn(),
        list: vi.fn(),
        getState: vi.fn(),
        cancel: vi.fn().mockResolvedValue({ schedule: { id: "sched-1" } }),
        setPaused: vi.fn(),
      },
    }));
  }

  it.each(DESTRUCTIVE)("routes $tool through the approval card ($reason)", async ({ tool, input }) => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: true });
    const tools = destructiveDeps(requestApproval);
    await tools[tool]!.execute(input as never);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({
      title: expect.any(String),
      description: expect.any(String),
    });
  });

  it.each(DESTRUCTIVE)("does not run $tool when the user declines", async ({ tool, input }) => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: false, reason: "not now" });
    const tools = destructiveDeps(requestApproval);
    const result = await tools[tool]!.execute(input as never) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("Declined by the user");
  });

  it("does not gate the reversible neighbours of the destructive tools", async () => {
    const requestApproval = vi.fn().mockResolvedValue({ approved: true });
    const tools = destructiveDeps(requestApproval);
    // Disabling a rule and pausing scheduled work lose nothing and are undone
    // by the same tool, so they must not cost the user a card.
    await tools.setAutomationEnabled!.execute({ id: "rule-1", enabled: false } as never);
    await tools.setScheduledWorkPaused!.execute({ sessionId: "chat-1", paused: true } as never);
    // A brand-new rule (no id) creates rather than replaces.
    await tools.saveAutomation!.execute({ draft: { name: "fresh" } } as never);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("proceeds with no approval channel wired, rather than blocking forever", async () => {
    const deleteRule = vi.fn().mockReturnValue([]);
    const tools = createCtoOperatorTools(runtimeShapedDeps({
      requestApproval: undefined,
      automationRuleService: { get: vi.fn(), deleteRule, toggleRule: vi.fn() },
    }));
    const result = await tools.deleteAutomation!.execute({ id: "rule-1" } as never) as { success: boolean };
    expect(result.success).toBe(true);
    expect(deleteRule).toHaveBeenCalledWith({ id: "rule-1" });
  });
});

describe("CTO secret exposure", () => {
  it("lists secret names and metadata and never a value", async () => {
    const list = vi.fn().mockReturnValue([
      { name: "STRIPE_API_KEY", value: "sk_live_should_never_escape", updatedAt: "2026-01-01T00:00:00.000Z", scope: "project" },
      { name: "OPENAI_API_KEY", secret: "also-not-yours" },
    ]);
    const tools = createCtoOperatorTools(runtimeShapedDeps({ projectSecretService: { list } }));

    const result = await tools.listProjectSecretNames!.execute({} as never) as {
      success: boolean;
      secrets: Array<Record<string, unknown>>;
    };
    expect(result.success).toBe(true);
    expect(result.secrets.map((row) => row.name)).toEqual(["STRIPE_API_KEY", "OPENAI_API_KEY"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk_live_should_never_escape");
    expect(serialized).not.toContain("also-not-yours");
  });

  it("redacts env values and credential-shaped fields out of the project config", async () => {
    // `local.yaml` carries per-user env vars and is chmod 600 for that reason,
    // so handing the raw config back would be a secret leak through the side
    // door even though no "secret" tool was involved.
    const get = vi.fn().mockReturnValue({
      effective: {
        env: { OPENAI_API_KEY: "sk-live-leak", PORT: "3000" },
        automations: {
          triggers: [{ type: "webhook", secretRef: "WEBHOOK_SECRET", token: "ghp_leak" }],
        },
        ui: { theme: "dark" },
      },
      local: { envVars: { DATABASE_URL: "postgres://user:pw@host/db" } },
    });
    const tools = createCtoOperatorTools(runtimeShapedDeps({ projectConfigService: { get } }));

    const result = await tools.getProjectConfig!.execute({} as never) as { success: boolean; result: any };
    expect(result.success).toBe(true);
    const serialized = JSON.stringify(result);
    for (const leak of ["sk-live-leak", "ghp_leak", "postgres://user:pw@host/db"]) {
      expect(serialized, `${leak} must not survive redaction`).not.toContain(leak);
    }
    // Shape survives, so the CTO still knows what the project defines.
    expect(result.result.effective.env.names).toEqual(["OPENAI_API_KEY", "PORT"]);
    expect(result.result.local.envVars.names).toEqual(["DATABASE_URL"]);
    expect(result.result.effective.ui.theme).toBe("dark");
    expect(result.result.effective.automations.triggers[0].token).toBe("[redacted]");
    // `secretRef` names a secret rather than carrying one, so it stays readable
    // — redacting it would hide which secret a trigger depends on for nothing.
    expect(result.result.effective.automations.triggers[0].secretRef).toBe("WEBHOOK_SECRET");
  });

  it("redacts credential maps, camelCase credential keys, and credentials inside arrays", async () => {
    // Every case here leaked verbatim before: `ai.apiKeys` is a provider -> key
    // MAP whose own key matches no credential pattern, `githubToken` carries no
    // separator so an anchored pattern missed it, and the array branch dropped
    // the parent key on the way down.
    const get = vi.fn().mockReturnValue({
      effective: {
        ai: { apiKeys: { openai: "sk-live-map-leak", anthropic: "sk-ant-map-leak" } },
        githubToken: "ghp_camel_leak",
        accessToken: "at_camel_leak",
        apiToken: ["arr_element_leak"],
        // Innocent keys that merely contain a credential word must survive, or
        // the CTO loses real config it needs.
        tokenizer: "gpt-4o",
        sortKey: "updatedAt",
      },
    });
    const tools = createCtoOperatorTools(runtimeShapedDeps({ projectConfigService: { get } }));

    const result = await tools.getProjectConfig!.execute({} as never) as { success: boolean; result: any };
    const serialized = JSON.stringify(result);
    for (const leak of [
      "sk-live-map-leak",
      "sk-ant-map-leak",
      "ghp_camel_leak",
      "at_camel_leak",
      "arr_element_leak",
    ]) {
      expect(serialized, `${leak} must not survive redaction`).not.toContain(leak);
    }
    // The names stay, so the CTO can still say which providers are configured.
    expect(result.result.effective.ai.apiKeys.names).toEqual(["anthropic", "openai"]);
    expect(result.result.effective.githubToken).toBe("[redacted]");
    expect(result.result.effective.apiToken).toEqual(["[redacted]"]);
    expect(result.result.effective.tokenizer).toBe("gpt-4o");
    expect(result.result.effective.sortKey).toBe("updatedAt");
  });

  it("redacts a credential container written as a YAML list, not just a map", async () => {
    // `providers` is free-form `Record<string, unknown>`, so a user can write
    // `tokens: [...]` as easily as `tokens: {...}`. Both container guards
    // required a non-array object, so the list fell through to the element walk
    // where the PLURAL key matches no credential pattern and every element
    // leaked verbatim.
    const get = vi.fn().mockReturnValue({
      effective: {
        providers: {
          myprov: {
            tokens: ["ghp_list_leak"],
            secrets: ["sk-list-leak"],
            keys: ["key-list-leak"],
            passwords: ["pw-list-leak"],
          },
        },
        env: ["FOO=env_list_leak"],
      },
    });
    const tools = createCtoOperatorTools(runtimeShapedDeps({ projectConfigService: { get } }));

    const result = await tools.getProjectConfig!.execute({} as never) as { success: boolean; result: any };
    const serialized = JSON.stringify(result);
    for (const leak of [
      "ghp_list_leak",
      "sk-list-leak",
      "key-list-leak",
      "pw-list-leak",
      "env_list_leak",
    ]) {
      expect(serialized, `${leak} must not survive redaction`).not.toContain(leak);
    }
    // The count survives, so the CTO still knows the list is non-empty.
    expect(result.result.effective.providers.myprov.tokens.count).toBe(1);
    expect(result.result.effective.env.count).toBe(1);
  });

  it("hands the CTO the budgeted discovery text, never the raw line array", async () => {
    // The drain deliberately hands out one line even when that line alone
    // exceeds the budget, so a single oversized entry cannot wedge the queue.
    // Returning `lines` here would let that entry carry the whole read window
    // into a tool result the budget exists to bound.
    const readNewDiscoveries = vi.fn().mockReturnValue({
      text: "- clipped to the budget",
      lines: ["- clipped to the budget", `- ${"x".repeat(50_000)}`],
    });
    const tools = createCtoOperatorTools(
      runtimeShapedDeps({ ctoMemoryService: { readNewDiscoveries } as never }),
    );

    const result = await tools.readDiscoveries!.execute({} as never) as {
      success: boolean;
      discoveries: unknown;
      count: number;
    };
    expect(result.success).toBe(true);
    expect(result.discoveries).toBe("- clipped to the budget");
    expect(JSON.stringify(result)).not.toContain("x".repeat(1_000));
    // The count still reports what was drained, so the CTO knows the budget bit.
    expect(result.count).toBe(2);
  });

  it("exposes no tool that can read a secret value", () => {
    const tools = createCtoOperatorTools(runtimeShapedDeps());
    const secretish = Object.keys(tools).filter((name) => /secret/i.test(name));
    // Exactly one secret-facing tool, and it is the names-only listing.
    expect(secretish).toEqual(["listProjectSecretNames"]);
    // And the dep surface itself carries no value accessor to call.
    const deps = runtimeShapedDeps();
    expect(Object.keys(deps.projectSecretService ?? {})).not.toContain("get");
    expect(Object.keys(deps.projectSecretService ?? {})).not.toContain("exportEnv");
  });
});
