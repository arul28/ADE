import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockState = vi.hoisted(() => {
  let nextSessionId = 1;
  const makeStream = (sessionId: string) => (async function* () {
    yield {
      type: "message.part.updated",
      properties: {
        part: {
          id: `part-${sessionId}`,
          sessionID: sessionId,
          type: "text",
          text: "pong",
        },
        delta: "pong",
      },
    };
    yield {
      type: "message.part.updated",
      properties: {
        part: {
          id: `step-${sessionId}`,
          sessionID: sessionId,
          type: "step-finish",
          tokens: {
            input: 1,
            output: 1,
            cache: { read: 0, write: 0 },
          },
        },
      },
    };
    yield {
      type: "session.idle",
      properties: {
        sessionID: sessionId,
      },
    };
  })();
  const makeLease = (url: string) => ({
    url,
    release: vi.fn(),
    close: vi.fn(),
    touch: vi.fn(),
    setBusy: vi.fn(),
    setEvictionHandler: vi.fn(),
  });

  return {
    resetSessionIds: () => {
      nextSessionId = 1;
    },
    sharedLease: makeLease("http://127.0.0.1:4101"),
    dedicatedLease: makeLease("http://127.0.0.1:4102"),
    createSession: vi.fn(async () => ({
      data: { id: `opencode-session-${nextSessionId++}` },
    })),
    promptAsync: vi.fn(async () => ({})),
    eventSubscribe: vi.fn(async () => {
      const sessionId = `opencode-session-${Math.max(1, nextSessionId - 1)}`;
      return { stream: makeStream(sessionId) };
    }),
    getSession: vi.fn(async () => {
      throw new Error("session not found");
    }),
  };
});

// One client, not two. ADE talks to OpenCode exclusively through the v2 client;
// the legacy `@opencode-ai/sdk` entry point is no longer imported for anything
// but the `Config` type, so a mock of it would never be consulted.
vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: vi.fn(() => ({
    event: {
      subscribe: mockState.eventSubscribe,
    },
    session: {
      create: mockState.createSession,
      get: mockState.getSession,
      promptAsync: mockState.promptAsync,
    },
    question: {
      reply: vi.fn(),
      reject: vi.fn(),
    },
    permission: {
      reply: vi.fn(),
      respond: vi.fn(),
    },
  })),
}));

const apiKeyState = vi.hoisted(() => ({ keys: {} as Record<string, string> }));

vi.mock("../ai/apiKeyStore", () => ({
  getAllApiKeys: () => ({ ...apiKeyState.keys }),
  getApiKey: (id: string) => apiKeyState.keys[id.trim().toLowerCase()] ?? null,
}));

vi.mock("./openCodeBinaryManager", () => ({
  resolveOpenCodeBinaryPath: vi.fn(() => "/Users/admin/.opencode/bin/opencode"),
}));

vi.mock("./openCodeServerManager", () => ({
  acquireSharedOpenCodeServer: vi.fn(async () => mockState.sharedLease),
  acquireDedicatedOpenCodeServer: vi.fn(async () => mockState.dedicatedLease),
  getOpenCodeRuntimeDiagnostics: vi.fn(() => ({
    sharedCount: 1,
    dedicatedCount: 0,
    entries: [],
  })),
}));

import {
  __resetOpenCodeRuntimeDiagnosticsForTests,
  buildOpenCodeConfig,
  buildOpenCodePromptParts,
  getOpenCodeRuntimeSnapshot,
  isOpenCodeNotFoundError,
  refreshOpenCodeSessionToolSelection,
  runOpenCodeTextPrompt,
  startOpenCodeSession,
} from "./openCodeRuntime";
import {
  acquireDedicatedOpenCodeServer,
  acquireSharedOpenCodeServer,
} from "./openCodeServerManager";
import { buildCodingAgentSystemPrompt } from "../ai/tools/systemPrompt";
import {
  buildOpenCodeAdeInstructions,
  ensureOpenCodeAdeInstructionsFile,
  openCodeAdeInstructionsPath,
} from "./openCodeAdeInstructions";

/** The flat parameters object from the most recent v2 `session.promptAsync`. */
function openCodePromptParams(): Record<string, unknown> {
  const call = mockState.promptAsync.mock.calls.at(-1) as unknown as
    [Record<string, unknown> | undefined] | undefined;
  return call?.[0] ?? {};
}

describe("openCodeRuntime", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockState.resetSessionIds();
    __resetOpenCodeRuntimeDiagnosticsForTests();
  });

  it("starts a shared OpenCode session without per-session ADE tool registration", async () => {
    const handle = await startOpenCodeSession({
      directory: "/repo",
      title: "Shared chat",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "chat-1",
      ownerKey: "chat:chat-1",
    });

    expect(acquireSharedOpenCodeServer).toHaveBeenCalledTimes(1);
    expect(acquireDedicatedOpenCodeServer).not.toHaveBeenCalled();
    expect(acquireSharedOpenCodeServer).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        agent: expect.objectContaining({
          "ade-plan": expect.objectContaining({
            // The deprecated `tools` map is gone; OpenCode desugars it into
            // these same permission keys and an explicit permission block wins.
            permission: expect.objectContaining({
              question: "allow",
              websearch: "deny",
              skill: "deny",
              // Plan denies edit, so it must deny task: a spawned subagent runs
              // under its own ruleset with edit allowed, which let plan mode
              // write files through a child session.
              task: "deny",
            }),
          }),
          "ade-helper": expect.objectContaining({
            permission: expect.objectContaining({ question: "deny" }),
          }),
        }),
      }),
    }));
    expect(handle.toolSelection).toBeNull();

    await handle.close("handle_close");
    expect(mockState.sharedLease.close).toHaveBeenCalledWith("handle_close");
  });

  it("passes lead isolation through to a dedicated OpenCode server", async () => {
    await startOpenCodeSession({
      directory: "/repo",
      title: "Lead chat",
      leaseKind: "dedicated",
      isolatedConfig: true,
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "lead-1",
      ownerKey: "chat:lead-1",
    });

    expect(acquireDedicatedOpenCodeServer).toHaveBeenCalledWith(expect.objectContaining({
      isolatedConfig: true,
      ownerKey: "chat:lead-1",
    }));
  });

  it("omits the session title when ADE wants OpenCode to auto-name", async () => {
    await startOpenCodeSession({
      directory: "/repo",
      title: null,
      leaseKind: "shared",
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "chat-1",
      ownerKey: "chat:chat-1",
    });

    // v2 takes flat parameters: no title key at all rather than an empty body.
    expect(mockState.createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ title: expect.anything() }),
      expect.objectContaining({ throwOnError: true }),
    );
  });

  it("applies no scoped tool selection to one-shot prompts", async () => {
    const result = await runOpenCodeTextPrompt({
      directory: "/repo",
      title: "One-shot prompt",
      modelDescriptor: {
        id: "opencode/openai/gpt-5-mini",
        family: "openai",
        providerRoute: "opencode",
        providerModelId: "openai/gpt-5-mini",
        openCodeProviderId: "openai",
        openCodeModelId: "gpt-5-mini",
      } as any,
      prompt: "ping",
      projectConfig: { ai: {} },
    });

    expect(result.text).toBe("pong");
    expect(mockState.promptAsync).toHaveBeenCalledWith(
      expect.not.objectContaining({ tools: expect.anything() }),
      expect.objectContaining({ throwOnError: true }),
    );
  });

  it("reports OpenCode runtime diagnostics for shared and dedicated sessions", () => {
    const snapshot = getOpenCodeRuntimeSnapshot();

    expect(snapshot.sharedCount).toBe(1);
    expect(snapshot.dedicatedCount).toBe(0);
    expect(Object.keys(snapshot).sort()).toEqual(["dedicatedCount", "entries", "sharedCount"]);
  });

  it("sends a provided system prompt through the first-class system field, not a text part", async () => {
    await runOpenCodeTextPrompt({
      directory: "/repo",
      title: "System prompt transport",
      modelDescriptor: {
        id: "opencode/openai/gpt-5-mini",
        family: "openai",
        providerRoute: "opencode",
        providerModelId: "openai/gpt-5-mini",
        openCodeProviderId: "openai",
        openCodeModelId: "gpt-5-mini",
      } as any,
      prompt: "ping",
      system: "You are ADE's naming agent.",
      projectConfig: { ai: {} },
    });

    const params = openCodePromptParams();
    expect(params.system).toBe("You are ADE's naming agent.");
    // The synthetic/ignored part injection is gone for good: OpenCode drops
    // `ignored` parts from model context, so that transport never worked.
    const parts = params.parts as Array<Record<string, unknown>>;
    expect(parts.every((part) => !part.synthetic && !part.ignored)).toBe(true);
    // And it must not have leaked into the user-visible message text either.
    expect(parts.some((part) => String(part.text ?? "").includes("naming agent"))).toBe(false);
  });

  it("omits the system field when no system prompt is provided", async () => {
    await runOpenCodeTextPrompt({
      directory: "/repo",
      title: "No system prompt",
      modelDescriptor: {
        id: "opencode/openai/gpt-5-mini",
        family: "openai",
        providerRoute: "opencode",
        providerModelId: "openai/gpt-5-mini",
        openCodeProviderId: "openai",
        openCodeModelId: "gpt-5-mini",
      } as any,
      prompt: "ping",
      projectConfig: { ai: {} },
    });

    expect(openCodePromptParams()).not.toHaveProperty("system");
  });

  it("builds prompt parts from the user text plus file attachments only", () => {
    const parts = buildOpenCodePromptParts({
      prompt: "hello",
      files: [{ path: "/tmp/pic.png", mime: "image/png", filename: "pic.png" }],
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "text", text: "hello" });
    expect(parts[1]).toMatchObject({ type: "file", mime: "image/png" });
  });

  it("recreates a persisted session only on a confirmed miss, and rethrows anything else", async () => {
    // Confirmed 404 → fall through to session.create.
    mockState.getSession.mockImplementationOnce(async () => {
      throw new Error("not found", { cause: { body: { name: "NotFoundError" }, status: 404 } });
    });
    const recreated = await startOpenCodeSession({
      directory: "/repo",
      sessionId: "ses_gone",
      leaseKind: "dedicated",
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "chat-404",
      ownerKey: "chat:chat-404",
    });
    expect(recreated.sessionId).toContain("opencode-session-");
    expect(mockState.createSession).toHaveBeenCalled();

    // Transient failure (no response / non-404 status) must surface, not reset
    // the thread onto a brand-new empty session.
    mockState.getSession.mockImplementationOnce(async () => {
      throw new Error("opencode server GET → 503", { cause: { body: {}, status: 503 } });
    });
    await expect(startOpenCodeSession({
      directory: "/repo",
      sessionId: "ses_blip",
      leaseKind: "dedicated",
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "chat-blip",
      ownerKey: "chat:chat-blip",
    })).rejects.toThrow(/503/);
    expect(mockState.dedicatedLease.close).toHaveBeenCalledWith("error");

    mockState.getSession.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(startOpenCodeSession({
      directory: "/repo",
      sessionId: "ses_network",
      leaseKind: "dedicated",
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "chat-net",
      ownerKey: "chat:chat-network",
    })).rejects.toThrow(/fetch failed/);

    // A live session is adopted as-is, with its title.
    mockState.getSession.mockImplementationOnce((async () => ({
      data: { id: "ses_live", title: "Real thread" },
    })) as unknown as typeof mockState.getSession);
    const adopted = await startOpenCodeSession({
      directory: "/repo",
      sessionId: "ses_live",
      leaseKind: "dedicated",
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "chat-live",
      ownerKey: "chat:chat-live",
    });
    expect(adopted.initialTitle).toBe("Real thread");
    expect(mockState.createSession).toHaveBeenCalledTimes(1);
  });

  it("classifies OpenCode missing-session errors precisely", () => {
    expect(isOpenCodeNotFoundError(new Error("x", { cause: { body: { name: "NotFoundError" }, status: 404 } }))).toBe(true);
    expect(isOpenCodeNotFoundError(new Error("x", { cause: { body: { name: "NotFoundError" } } }))).toBe(true);
    expect(isOpenCodeNotFoundError({ status: 404 })).toBe(true);
    expect(isOpenCodeNotFoundError({ name: "NotFoundError" })).toBe(true);
    // Deeply nested but bounded walk still finds it.
    expect(isOpenCodeNotFoundError(new Error("x", { cause: { error: { data: { statusCode: 404 } } } }))).toBe(true);
    // Anything else is NOT a confirmed miss — transient blips included.
    expect(isOpenCodeNotFoundError(new Error("session not found"))).toBe(false);
    expect(isOpenCodeNotFoundError(new Error("x", { cause: { status: 500 } }))).toBe(false);
    expect(isOpenCodeNotFoundError({ status: 400 })).toBe(false);
    expect(isOpenCodeNotFoundError(undefined)).toBe(false);
    expect(isOpenCodeNotFoundError("404")).toBe(false);
  });

  it("rejects a NotFoundError whose chain carries a non-404 status", () => {
    // A shallow NotFoundError name must not outvote a deeper concrete status:
    // re-creating the session after a transient 503 strands the live thread.
    expect(isOpenCodeNotFoundError(new Error("x", {
      cause: { body: { name: "NotFoundError" }, status: 503 },
    }))).toBe(false);
    expect(isOpenCodeNotFoundError({
      name: "NotFoundError",
      cause: { status: 500 },
    })).toBe(false);
    // And a deep non-404 vetoes even when the name sits at the root.
    expect(isOpenCodeNotFoundError(new Error("x", {
      cause: { error: { data: { statusCode: 500, name: "NotFoundError" } } },
    }))).toBe(false);
  });
});

describe("buildOpenCodeConfig provider injection", () => {
  beforeEach(() => {
    apiKeyState.keys = {};
  });

  const providerOf = (ai: Record<string, unknown>): Record<string, any> =>
    (buildOpenCodeConfig({ projectConfig: { ai } as any }).provider ?? {}) as Record<string, any>;

  it("emits a full provider block for each custom provider", () => {
    const provider = providerOf({
      customProviders: [
        {
          id: "acme",
          name: "Acme AI",
          baseURL: "https://acme.example/v1",
          models: ["acme-large", "acme-small"],
        },
      ],
    });

    expect(provider.acme).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Acme AI",
      options: { baseURL: "https://acme.example/v1" },
      models: { "acme-large": {}, "acme-small": {} },
    });
  });

  it("honors an explicit npm package and injects the configured api key", () => {
    // Key injection is asserted through the project-config path: the encrypted
    // key store resolves via a CJS require that vitest's ESM mocks can't
    // intercept (it degrades to a no-op here by design), and both paths merge
    // through the same provider options object.
    const provider = providerOf({
      apiKeys: { acme: "sk-acme" },
      customProviders: [
        {
          id: "acme",
          name: "Acme",
          baseURL: "https://acme.example/v1",
          npm: "@ai-sdk/anthropic",
          models: ["m1"],
        },
      ],
    });

    expect(provider.acme.npm).toBe("@ai-sdk/anthropic");
    expect(provider.acme.options).toEqual({
      baseURL: "https://acme.example/v1",
      apiKey: "sk-acme",
    });
  });

  it("skips custom providers missing an id, baseURL, or models", () => {
    const provider = providerOf({
      customProviders: [
        { id: "", name: "no id", baseURL: "https://x/v1", models: ["m"] },
        { id: "nourl", name: "no url", baseURL: "  ", models: ["m"] },
        { id: "nomodels", name: "no models", baseURL: "https://x/v1", models: [] },
      ],
    });

    expect(provider[""]).toBeUndefined();
    expect(provider.nourl).toBeUndefined();
    expect(provider.nomodels).toBeUndefined();
  });

  it("merges a custom model slug into an existing custom provider", () => {
    const provider = providerOf({
      customProviders: [
        { id: "acme", name: "Acme", baseURL: "https://acme.example/v1", models: ["m1"] },
      ],
      customModelSlugs: ["acme/m2"],
    });

    expect(Object.keys(provider.acme.models).sort()).toEqual(["m1", "m2"]);
  });

  it("materializes a bare block for a known-catalog provider slug", () => {
    const provider = providerOf({ customModelSlugs: ["openai/o5-preview"] });
    expect(provider.openai).toEqual({ models: { "o5-preview": {} } });
  });

  it("keeps model ids that contain slashes intact", () => {
    const provider = providerOf({ customModelSlugs: ["openrouter/anthropic/claude-x"] });
    expect(provider.openrouter).toEqual({ models: { "anthropic/claude-x": {} } });
  });

  it("drops malformed and unknown-provider slugs", () => {
    const provider = providerOf({ customModelSlugs: ["noslash", "mysteryco/model"] });
    expect(provider.noslash).toBeUndefined();
    expect(provider.mysteryco).toBeUndefined();
  });
});

describe("refreshOpenCodeSessionToolSelection", () => {
  const handleOf = () => ({ toolSelection: null } as { toolSelection: Record<string, boolean> | null });

  it("withholds OpenCode's native write and shell tools from an orchestrator lead", async () => {
    const handle = handleOf();
    const selection = await refreshOpenCodeSessionToolSelection(
      handle as never,
      { orchestrationLead: true },
    );
    // These are OpenCode's own built-ins, not ADE's toolset — they are what a
    // lead could otherwise use to edit code or run shell directly.
    expect(selection).toMatchObject({
      bash: false,
      edit: false,
      write: false,
      patch: false,
      task: false,
    });
    // Reads stay available so the lead can still plan.
    expect(selection).not.toHaveProperty("read");
    expect(selection).not.toHaveProperty("grep");
    expect(selection).not.toHaveProperty("glob");
    // The handle carries the same map, so a resumed prompt cannot drop it.
    expect(handle.toolSelection).toEqual(selection);
  });

  it("leaves workers and validators on OpenCode's default toolset", async () => {
    for (const options of [undefined, { orchestrationLead: false }]) {
      const handle = handleOf();
      await expect(refreshOpenCodeSessionToolSelection(handle as never, options)).resolves.toBeNull();
      expect(handle.toolSelection).toBeNull();
    }
  });
});

describe("buildOpenCodeConfig user-owned keys", () => {
  const config = (): Record<string, any> =>
    buildOpenCodeConfig({ projectConfig: { ai: {} } as any }) as Record<string, any>;

  it("does not force share or snapshot over the user's opencode.json", () => {
    // OPENCODE_CONFIG_CONTENT merges last, so naming these would beat the user's
    // own file. snapshot's documented default is true, and forcing false
    // silently disables OpenCode's /undo and /revert.
    expect(config()).not.toHaveProperty("share");
    expect(config()).not.toHaveProperty("snapshot");
    expect(config()).not.toHaveProperty("autoupdate");
  });

  it("denies task in plan mode so a subagent cannot write for it", () => {
    // The regression: plan denied `edit` but left `task` open, and a spawned
    // subagent runs under its own ruleset where edit is allowed.
    const plan = config().agent["ade-plan"].permission;
    expect(plan.edit).toBe("deny");
    expect(plan.task).toBe("deny");
  });

  it("lets full access read without prompting", () => {
    // OpenCode's base ruleset asks before reading *.env, so full access
    // prompted until read was stated.
    expect(config().agent["ade-full-auto"].permission.read).toBe("allow");
  });

  it("keeps ADE's own modes out of the user's agent picker", () => {
    for (const name of ["ade-plan", "ade-edit", "ade-full-auto", "ade-helper"]) {
      expect(config().agent[name].hidden).toBe(true);
    }
  });

  it("gives an isolated lead's discovered ollama models an endpoint to run against", () => {
    // A lead inherits no user config, so nothing else can supply the address and
    // there is no user endpoint to clobber.
    const cfg = buildOpenCodeConfig({
      projectConfig: { ai: {} } as any,
      isolatedConfig: true,
      discoveredLocalModels: [{ provider: "ollama", modelId: "llama3", loaded: true }],
    } as any) as Record<string, any>;
    expect(cfg.provider.ollama.models).toHaveProperty("llama3");
    expect(cfg.provider.ollama.options.baseURL).toBe("http://localhost:11434/v1");
  });

  it("does not invent an ollama endpoint for an ordinary session", () => {
    // OPENCODE_CONFIG_CONTENT merges last, so an ADE default would replace a
    // remote host in the user's own opencode.json — which ADE cannot read.
    const cfg = buildOpenCodeConfig({
      projectConfig: { ai: {} } as any,
      discoveredLocalModels: [{ provider: "ollama", modelId: "llama3", loaded: true }],
    } as any) as Record<string, any>;
    expect(cfg.provider.ollama.models).toHaveProperty("llama3");
    expect(cfg.provider.ollama.options?.baseURL).toBeUndefined();
  });

  it("keeps a user-configured ollama endpoint over ADE's default", () => {
    const cfg = buildOpenCodeConfig({
      projectConfig: { ai: { localProviders: { ollama: { endpoint: "http://remote-box:11434" } } } } as any,
      discoveredLocalModels: [{ provider: "ollama", modelId: "llama3", loaded: true }],
    } as any) as Record<string, any>;
    expect(cfg.provider.ollama.options.baseURL).toBe("http://remote-box:11434/v1");
  });

  it("omits local providers the user never configured", () => {
    // An ADE-invented baseURL merges over the endpoint in the user's own
    // opencode.json, repointing a configured remote host back at localhost.
    expect(config().provider ?? {}).not.toHaveProperty("ollama");
    expect(config().provider ?? {}).not.toHaveProperty("lmstudio");
  });
});

// The other half of the OpenCode prompt contract. The chat runtime above sends
// ADE's instructions on the prompt's first-class `system` field; a CLI launch has
// no per-request system channel, so it reads the same text from an instruction
// file referenced by config. Both live here so the two transports cannot drift.
describe("ADE instructions for the tracked OpenCode CLI", () => {
  let projectRoot: string;
  let lane: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-oc-instr-"));
    lane = path.join(projectRoot, ".ade", "worktrees", "lane-1");
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("gives chat and the tracked CLI the same ADE base prompt", () => {
    // The contract is "one slim ADE base prompt", not "byte-identical
    // transport": chat sends it through the SDK's `system` field while the CLI
    // gets it as an instruction file. What must not drift is the instruction
    // text itself, so the CLI file has to contain exactly what the chat runtime
    // builds for the same lane and permission mode.
    const chatPrompt = buildCodingAgentSystemPrompt({
      cwd: lane,
      mode: "coding",
      permissionMode: "edit",
      interactive: true,
      runtime: "opencode",
    });

    expect(buildOpenCodeAdeInstructions({ laneWorktreePath: lane, permissionMode: "edit" }))
      .toContain(chatPrompt);
  });

  it("tracks the permission mode the CLI actually launched with", () => {
    const plan = buildOpenCodeAdeInstructions({ laneWorktreePath: lane, permissionMode: "plan" });
    const fullAuto = buildOpenCodeAdeInstructions({ laneWorktreePath: lane, permissionMode: "full-auto" });

    expect(plan).toContain("Plan mode. Stay read-only");
    expect(fullAuto).toContain("Autonomous mode.");
    expect(plan).not.toContain("Autonomous mode.");
  });

  it("writes into ADE's own cache, never the lane worktree or a shared temp dir", () => {
    const written = ensureOpenCodeAdeInstructionsFile({ projectRoot, laneWorktreePath: lane, permissionMode: "edit" });

    expect(written).not.toBeNull();
    expect(written?.startsWith(lane)).toBe(false);
    expect(written?.startsWith(path.join(projectRoot, ".ade", "cache"))).toBe(true);
    expect(fs.readFileSync(written!, "utf8")).toContain("ADE's software engineering agent");
    // A predictable path in a world-writable directory is a symlink target.
    expect(written?.startsWith(os.tmpdir() + path.sep + "ade-opencode")).toBe(false);
  });

  it("keeps concurrent terminals on the same lane from overwriting each other", () => {
    // Two tracked terminals can run on one lane under different modes at once,
    // and OpenCode re-reads its instruction files every turn — a shared path
    // let the second launch hand its mode to the first mid-conversation.
    const plan = ensureOpenCodeAdeInstructionsFile({ projectRoot, laneWorktreePath: lane, permissionMode: "plan" });
    const fullAuto = ensureOpenCodeAdeInstructionsFile({ projectRoot, laneWorktreePath: lane, permissionMode: "full-auto" });

    expect(fullAuto).not.toBe(plan);
    expect(fs.readFileSync(plan!, "utf8")).toContain("Plan mode. Stay read-only");
    expect(fs.readFileSync(fullAuto!, "utf8")).toContain("Autonomous mode.");

    // Relaunching the same mode reuses its own file rather than accumulating.
    const first = plan;
    const second = ensureOpenCodeAdeInstructionsFile({ projectRoot, laneWorktreePath: lane, permissionMode: "plan" });
    expect(second).toBe(first);

    expect(openCodeAdeInstructionsPath({
      projectRoot,
      laneWorktreePath: `${lane}-2`,
      permissionMode: "full-auto",
    })).not.toBe(first);
  });

  it("produces a filename OpenCode's basename glob cannot misread", () => {
    // OpenCode resolves an absolute `instructions` entry by globbing the
    // basename inside its parent directory, so a glob metacharacter in the name
    // would match the wrong file or none.
    const name = path.basename(openCodeAdeInstructionsPath({
      projectRoot,
      laneWorktreePath: "/repo/lane with spaces/*/weird?",
      permissionMode: "edit",
    }));
    expect(name).toMatch(/^ade-[0-9a-f]{16}\.md$/);
  });

  it("does not claim an ADE permission tier when the user owns the config", () => {
    // config-toml means "use my own OpenCode configuration", and ADE sends no
    // permission block for it, so asserting edit mode would state a policy ADE
    // never set and the user's config may not grant.
    const text = buildOpenCodeAdeInstructions({ laneWorktreePath: lane, permissionMode: "config-toml" });

    expect(text).toContain("## Permission policy");
    expect(text).toContain("ADE sets no permission policy");
    expect(text).toContain("treat it as authoritative wherever it is more restrictive");
    // And it stays isolated from the edit-mode file rather than sharing it.
    expect(openCodeAdeInstructionsPath({ projectRoot, laneWorktreePath: lane, permissionMode: "config-toml" }))
      .not.toBe(openCodeAdeInstructionsPath({ projectRoot, laneWorktreePath: lane, permissionMode: "edit" }));
  });

  it("returns null instead of failing the launch when there is no lane", () => {
    expect(ensureOpenCodeAdeInstructionsFile({
      projectRoot,
      laneWorktreePath: "  ",
      permissionMode: "edit",
    })).toBeNull();
  });

  it("advertises only the skills whose plugin this machine has", () => {
    // A tracked OpenCode session gets the same trimmed roster the other
    // providers get. Naming `ade-linear` on a machine without the Linear
    // plugin costs the agent a turn to discover the skill is not loadable.
    const trimmed = buildOpenCodeAdeInstructions({
      laneWorktreePath: lane,
      permissionMode: "edit",
      installedBuiltinSurfaces: new Set(["ios"] as const),
    });

    expect(trimmed).toContain("`ade-ios-simulator`");
    expect(trimmed).not.toContain("`ade-linear`");
    expect(trimmed).not.toContain("`ade-app-control`");
    // Skills that belong to no plugin are unconditional.
    expect(trimmed).toContain("`ade-cli-control-plane`");
  });

  it("keeps the roster complete when install state is unknown", () => {
    // Omitted means "this caller cannot know", never "none": a roster trimmed
    // on a guess hides a skill the machine really has, and the agent has no
    // way to find out later.
    const unknown = buildOpenCodeAdeInstructions({ laneWorktreePath: lane, permissionMode: "edit" });

    expect(unknown).toContain("`ade-linear`");
    expect(unknown).toContain("`ade-ios-simulator`");
    expect(unknown).toContain("`ade-app-control`");
  });
});
