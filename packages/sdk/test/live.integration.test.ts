import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdeChat, type InternalAdeChatOptions } from "../src/client.js";
import type { AdeChatClient } from "../src/client.js";
import { JsonRpcConnection } from "../src/jsonRpc.js";
import { startSidecar, type Sidecar } from "../src/sidecar.js";
import { resolveRuntimeSocketPath } from "../src/socketPath.js";
import type { AdeThread } from "../src/thread.js";
import type {
  AdeInitializeResult,
  ModelCatalogEntry,
  PersonalChatCallResponse,
} from "../src/types.js";

/**
 * Live wire-contract test. Opt-in: set `ADE_SDK_LIVE_BINARY` to an `ade`
 * binary (or a shim that execs one) and this boots a real runtime against a
 * throwaway ADE_HOME.
 *
 *   ADE_SDK_LIVE_BINARY=/path/to/ade npx vitest run test/live.integration.test.ts
 *
 * WHY THIS EXISTS. The mock server in `mockRuntime.ts` answers whatever shape
 * the SDK expects, so it can only ever prove the SDK is self-consistent. It
 * cannot catch a field that the runtime persists but never puts on the wire —
 * and that is exactly the bug this file was written for: `mcpCapability` was
 * added to the chat service's persisted-state builder but not to
 * `summarizeSessionRow`, so `create`/`getSummary`/`list` all returned a summary
 * with no MCP report at all. Every engine-side test was green because they
 * asserted on `createSession`'s live return value rather than on the summary
 * that external callers actually receive.
 *
 * The load-bearing assertion is therefore the RAW KEY DUMP below, taken from a
 * second connection that bypasses the SDK entirely. It pins the summary field
 * set as a contract. The next field that gets added to persistence and
 * forgotten in the summary builder fails here.
 *
 * Deliberately not part of `npm test`: it needs a built runtime and boots a
 * real brain, so the default suite stays hermetic and sub-two-second.
 */

const LIVE_BINARY = process.env.ADE_SDK_LIVE_BINARY?.trim();
const BOOT_TIMEOUT_MS = 120_000;

/** Fields the SDK reads off a session summary. Absence of any is a regression. */
const REQUIRED_SUMMARY_FIELDS = [
  "sessionId",
  "provider",
  "model",
  "status",
  "startedAt",
  "lastActivityAt",
] as const;

describe.skipIf(!LIVE_BINARY)("live runtime wire contract", () => {
  let home: string;
  let client: AdeChatClient;
  let raw: JsonRpcConnection;
  let model: string;
  let initialize: AdeInitializeResult;

  /** Raw `personalChats.call`, bypassing the SDK's own unwrapping and typing. */
  const rawCall = async <T>(action: string, args: unknown): Promise<T> => {
    const response = await raw.request<PersonalChatCallResponse<T>>(
      "personalChats.call",
      { action, args },
      { timeoutMs: 120_000 },
    );
    return response.result;
  };

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-live-"));
    client = await createAdeChat({
      home,
      binaryPath: LIVE_BINARY,
      logger: () => {},
      startupTimeoutMs: BOOT_TIMEOUT_MS,
    } as InternalAdeChatOptions);

    const report = await client.doctor();
    raw = await JsonRpcConnection.connect(report.socket.path);
    initialize = await raw.request<AdeInitializeResult>("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientName: "ade-sdk-wire-probe",
      identity: { role: "cto", callerId: "ade-sdk-wire-probe" },
    });
    await raw.request("ade/initialized");

    const available = (await client.models.list()).filter((entry) => entry.isAvailable);
    const claude = available.find((entry) => entry.provider === "claude");
    model = (claude ?? available[0])!.id;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    raw?.close();
    await client?.dispose().catch(() => {});
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it("boots the embedded profile and advertises the personal chat capabilities", () => {
    const capabilities = initialize.capabilities?.personalChats;
    expect(capabilities).toBeDefined();
    expect(capabilities!.actions.length).toBeGreaterThan(0);
    // These two drive transport and MCP selection in `createAdeChat`. A runtime
    // that stops advertising them silently downgrades every SDK consumer.
    expect(capabilities!.pushEvents).toBe(true);
    expect(capabilities!.mcpServers).toBe(true);
  });

  it("selects the push transport against a real runtime", async () => {
    const report = await client.doctor();
    expect(report.events.mode).toBe("push");
    expect(report.socket.connected).toBe(true);
  });

  it("puts every field the SDK reads on the raw create summary", async () => {
    const summary = await rawCall<Record<string, unknown>>("create", {
      provider: "claude",
      model,
      title: "wire contract",
    });
    for (const field of REQUIRED_SUMMARY_FIELDS) {
      expect(summary, `summary is missing "${field}"`).toHaveProperty(field);
    }
  });

  it("carries the MCP report on create, getSummary AND list — not just in persisted state", async () => {
    // The exact regression this file exists for. `create` returning the report
    // is not enough: `getSummary` and `list` are separate read paths and a
    // resumed thread goes through them, so all three are asserted.
    const created = await rawCall<Record<string, unknown>>("create", {
      provider: "claude",
      model,
      title: "wire contract mcp",
      mcpServers: { probe: { type: "stdio", command: "echo", args: ["hi"] } },
      strictMcpConfig: true,
    });
    const sessionId = String(created.sessionId);

    expect(created.mcpCapability, "create summary dropped mcpCapability").toBeDefined();
    expect(created.mcpServers, "create summary dropped mcpServers").toBeDefined();
    expect(created.strictMcpConfig).toBe(true);
    expect(created.mcpCapability).toMatchObject({ level: "enforced", delivered: true });

    const fetched = await rawCall<Record<string, unknown>>("getSummary", { sessionId });
    expect(fetched.mcpCapability, "getSummary dropped mcpCapability").toBeDefined();

    const listed = await rawCall<Array<Record<string, unknown>>>("list", {});
    const row = listed.find((entry) => entry.sessionId === sessionId);
    expect(row, "list did not return the created session").toBeDefined();
    expect(row!.mcpCapability, "list dropped mcpCapability").toBeDefined();
  });

  it("reports a strict-only request as enforced and delivered", async () => {
    // Strict mode with NO servers of the caller's own — "isolate this chat from
    // the user's MCP". It is a success, and an earlier engine build reported it
    // with `delivered: false`, which made `!delivered` read a working isolation
    // request as a dropped one. Pinned here so it cannot silently come back.
    const summary = await rawCall<Record<string, unknown>>("create", {
      provider: "claude",
      model,
      title: "wire contract strict-only",
      strictMcpConfig: true,
    });
    expect(summary.strictMcpConfig).toBe(true);
    expect(summary.mcpCapability).toMatchObject({ level: "enforced", delivered: true });
  });

  it("omits the MCP fields entirely when the caller asked for nothing", async () => {
    // An absent report is a signal the SDK relies on. If these keys start
    // showing up unconditionally, "null means nothing was requested" breaks.
    const summary = await rawCall<Record<string, unknown>>("create", {
      provider: "claude",
      model,
      title: "wire contract plain",
    });
    expect(summary).not.toHaveProperty("mcpCapability");
    expect(summary).not.toHaveProperty("mcpServers");
    expect(summary).not.toHaveProperty("strictMcpConfig");
  });

  it("refuses injected MCP servers on a provider with no MCP surface", async () => {
    // Must be an error, not a silently tool-less chat.
    await expect(
      rawCall("create", {
        provider: "pi",
        model,
        mcpServers: { probe: { type: "stdio", command: "echo" } },
      }),
    ).rejects.toThrow(/pi/i);
  });

  it("surfaces the capability through the public thread API on create and on resume", async () => {
    const thread = await client.threads.open("live-mcp", {
      provider: "claude",
      model,
      mcpServers: { probe: { type: "stdio", command: "echo", args: ["hi"] } },
    });
    expect(thread.mcpCapability).toMatchObject({ level: "enforced", delivered: true });

    // A second client over the same home must resume the session AND rebuild
    // the same guarantee — a resumed thread reporting null would silently
    // downgrade what the embedder tells its users.
    //
    // It ATTACHES to the running runtime rather than spawning a second one:
    // two brains over one ADE_HOME would contend for the same SQLite state
    // root. Attaching still exercises the whole resume path — a cold
    // ThreadStore read, then `getSummary` — which is where the capability
    // report has to survive.
    const report = await client.doctor();
    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: report.socket.path,
      logger: () => {},
    } as InternalAdeChatOptions);
    try {
      const resumed = await second.threads.open("live-mcp", { provider: "claude", model });
      expect(resumed.id).toBe(thread.id);
      expect(resumed.mcpCapability).toMatchObject({ level: "enforced", delivered: true });
    } finally {
      await second.dispose();
    }
  }, BOOT_TIMEOUT_MS);
});

/**
 * The embedded profile must not carry machine-lifecycle authority.
 *
 * `runServe` omits `machineUpdateControls` and `reportMachinePowerTransition`
 * when the profile is "embedded", so a guest runtime inside somebody else's
 * process cannot update-and-restart the MACHINE's ADE. That wiring is a spread
 * inside a 900-line function: no unit test reaches it and typecheck cannot see
 * it, which is exactly the gap this boots a real runtime to close.
 *
 * WHY THIS RUNS WITH ADE_DEFAULT_ROLE=cto. Both handlers check the caller's
 * role BEFORE they check whether the controls exist, and an SDK-spawned runtime
 * defaults to the "agent" role. Booted normally, the refusal would come from
 * the role gate and this test would pass without the profile wiring existing at
 * all — the precise "invariant lives in the role default, not the profile"
 * failure the finding described. Raising the role to cto removes that gate so
 * the only thing left to refuse is the missing controls, and the assertions
 * below explicitly reject the role-gate message.
 */
describe.skipIf(!LIVE_BINARY)("embedded profile has no machine authority", () => {
  let home: string;
  let sidecar: Sidecar;
  let raw: JsonRpcConnection;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-live-embed-"));
    const socketPath = resolveRuntimeSocketPath(home);
    // Spawned through `startSidecar` rather than `createAdeChat` so the role
    // can be passed EXPLICITLY. Mutating `process.env` in a hook and relying on
    // it reaching the child does not survive vitest's environment handling —
    // and an explicit env is the better test regardless: no global mutation,
    // nothing for a parallel test to observe or clobber.
    sidecar = await startSidecar({
      binaryPath: LIVE_BINARY!,
      runtimeRoot: null,
      socketPath,
      home,
      logger: () => {},
      // `startSidecar` scrubs ADE_* out of the inherited environment and PINS
      // the role, so setting it via `env` would be silently overridden — that
      // scrubbing is deliberate hardening, not something to work around. This
      // is the supported knob.
      adeDefaultRole: "cto",
      startupTimeoutMs: BOOT_TIMEOUT_MS,
    });
    raw = await JsonRpcConnection.connect(socketPath);
    await raw.request<AdeInitializeResult>("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientName: "ade-sdk-embedded-authority-probe",
      identity: { role: "cto", callerId: "ade-sdk-embedded-authority-probe" },
    });
    await raw.request("ade/initialized");
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    raw?.close();
    await sidecar?.stop().catch(() => {});
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses machine.updateAndRestart because the profile withheld the controls", async () => {
    let message = "";
    try {
      await raw.request("machine.updateAndRestart", {}, { timeoutMs: 30_000 });
      throw new Error("machine.updateAndRestart was accepted by an embedded runtime");
    } catch (error) {
      message = (error as Error).message;
    }
    // The refusal must come from the ABSENT CONTROLS, not the role gate. Both
    // handlers check the role FIRST, so a runtime booted at the default "agent"
    // role refuses either way and this test would pass with no profile wiring
    // at all — the exact "invariant lives in the role default, not the profile"
    // failure the finding described. Hence cto above, and this second
    // assertion, which is what makes the test discriminating.
    expect(message).toMatch(/cannot update itself/i);
    expect(message).not.toMatch(/requires the cto role/i);
  }, BOOT_TIMEOUT_MS);

  it("reports machine power transitions as unsupported", async () => {
    // Same wiring, quieter contract: this one answers rather than throwing.
    // `accepted: false` tells a desktop peer to keep retrying elsewhere instead
    // of believing this runtime recorded the transition.
    //
    // NOT a regression guard, and verified as such: with the profile trim
    // reverted this assertion still passes, because a headless reporter answers
    // `accepted: false` regardless of whether it was wired. The
    // updateAndRestart test above is the one that actually fails when the
    // wiring goes away. This documents the contract; do not read it as cover.
    const outcome = await raw.request<{ accepted: boolean; reason?: string }>(
      "machine.reportPowerTransition",
      { kind: "suspend" },
      { timeoutMs: 30_000 },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe("unsupported");
  }, BOOT_TIMEOUT_MS);

  it("still serves personal chats — the trim is machine authority only", async () => {
    // The profile must remove machine-lifecycle power WITHOUT removing the
    // capability it exists to provide. A trim that broke chats would otherwise
    // look identical to a trim that worked.
    const initialize = await raw.request<AdeInitializeResult>("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientName: "ade-sdk-embedded-authority-probe",
      identity: { role: "cto", callerId: "ade-sdk-embedded-authority-probe" },
    });
    expect(initialize.capabilities?.personalChats?.actions.length).toBeGreaterThan(0);
    const listed = await raw.request<{ result?: unknown }>(
      "personalChats.call",
      { action: "list", args: {} },
      { timeoutMs: 60_000 },
    );
    expect(listed).toBeTruthy();
  }, BOOT_TIMEOUT_MS);
});

/**
 * THE SEAM: the real runtime and the real SDK agreeing on the 0.2 wire.
 *
 * Every unit of the 0.2 work was tested against its own fake — the engine
 * against a stub chat service, the SDK against `mockRuntime.ts`. Both halves
 * can be green while disagreeing on a field name, a null convention, or which
 * side refuses a bad argument, because neither fake was written from the other
 * side's code. This suite is the only place the two actually meet.
 *
 * It is deliberately CHEAP by default. Everything below that does not need a
 * model turn runs on `ADE_SDK_LIVE_BINARY` alone; the cases that spend provider
 * tokens are gated behind `ADE_SDK_LIVE_SPEND=1` as well, so the ordinary live
 * run costs nothing but a runtime boot.
 *
 *   # free: wire contract only
 *   ADE_SDK_LIVE_BINARY=apps/ade-cli/dist/cli.cjs npx vitest run test/live.integration.test.ts
 *
 *   # adds the model-turn cases (needs Claude installed and logged in)
 *   ADE_SDK_LIVE_BINARY=... ADE_SDK_LIVE_SPEND=1 npx vitest run test/live.integration.test.ts
 */

const LIVE_SPEND = process.env.ADE_SDK_LIVE_SPEND?.trim() === "1";

/**
 * Cheapest-first family order, copied in spirit from
 * `packages/demo/lib/pickModel.mjs`: the catalog carries no price, so cost is
 * inferred from the family name. A seam test running against a developer's real
 * subscription has no business picking Opus to say one word back.
 */
const CHEAP_FAMILIES_FIRST = ["haiku", "mini", "flash", "small", "sonnet", "opus"];

function pickCheapest(models: ModelCatalogEntry[], provider: string): ModelCatalogEntry | null {
  const usable = models.filter((entry) => entry.provider === provider && entry.isAvailable !== false);
  if (usable.length === 0) return null;
  const rank = (entry: ModelCatalogEntry) => {
    const haystack = `${entry.id} ${entry.runtimeModelId ?? ""} ${entry.displayName ?? ""}`.toLowerCase();
    const index = CHEAP_FAMILIES_FIRST.findIndex((needle) => haystack.includes(needle));
    return index === -1 ? CHEAP_FAMILIES_FIRST.length : index;
  };
  return [...usable].sort((a, b) => {
    const delta = rank(a) - rank(b);
    if (delta !== 0) return delta;
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.id.localeCompare(b.id);
  })[0]!;
}

/**
 * Claude permission defaults that accept every tool without asking.
 *
 * `"auto"` and `"dontAsk"` are Claude's own auto-accept modes; `"acceptEdits"`
 * and `"bypassPermissions"` are the older two. A machine whose Claude settings
 * name one of these cannot raise a tool approval at all, whatever an SDK caller
 * passes for `permissionMode` — confirmed by driving the Claude Agent SDK
 * directly with a `canUseTool` callback that was never invoked.
 */
const CLAUDE_AUTO_ACCEPT_MODES = ["auto", "dontAsk", "acceptEdits", "bypassPermissions"];

/**
 * Whether this machine's Claude configuration accepts tools without asking.
 *
 * Read from the user's own settings file rather than assumed, because it
 * decides whether the approval round trip below is testable here. Any read
 * failure answers `false`: an unreadable file is not evidence of auto-accept,
 * and treating it as such would turn a real gating failure into a green run.
 */
function claudeAutoAcceptsTools(): boolean {
  try {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    if (!fs.existsSync(settingsPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      permissions?: { defaultMode?: unknown };
    };
    const mode = parsed?.permissions?.defaultMode;
    return typeof mode === "string" && CLAUDE_AUTO_ACCEPT_MODES.includes(mode);
  } catch {
    return false;
  }
}

/**
 * A writable directory OUTSIDE the provider's own sandbox, or null.
 *
 * Codex under `sandbox: workspace-write` writes freely inside three roots: the
 * thread's cwd, `$TMPDIR`, and `/tmp`. A command that stays in them never
 * escalates, so it never reaches a `fallback` at all — measured, and it is why
 * the obvious "write a file in the working directory" prompt proves nothing
 * about a permission policy.
 *
 * `/var/tmp` is a fourth world-writable directory that is in none of those
 * roots, which makes it the one place a test can make a command escape the
 * sandbox without touching the user's home or the repository. Returns null when
 * it is missing or not writable, and the Codex cases skip rather than write
 * somewhere they should not.
 */
function resolveOutsideSandboxDir(): string | null {
  const candidate = process.platform === "darwin" ? "/private/var/tmp" : "/var/tmp";
  try {
    if (!fs.statSync(candidate).isDirectory()) return null;
    fs.accessSync(candidate, fs.constants.W_OK);
    return candidate;
  } catch {
    return null;
  }
}

type LiveEvent = { type: string; [key: string]: unknown };

type TurnOutcome = {
  /** Every `text` delta concatenated, which is what a host renders. */
  text: string;
  events: LiveEvent[];
  approvals: LiveEvent[];
  resolutions: LiveEvent[];
  /** How the turn ended. `"timeout"` means it never did — a parked approval. */
  terminal: "done" | "error" | "timeout";
};

/**
 * Sends one message and waits for the turn to end.
 *
 * `onApproval` fires for every `approval_request`, which is the only way a
 * policy with `fallback: "ask"` ever finishes: the runtime has no approval
 * timeout, so an unanswered request parks the turn until this file answers it.
 */
async function runTurn(
  thread: AdeThread,
  prompt: string,
  options: { timeoutMs?: number; onApproval?: (request: LiveEvent) => Promise<void> } = {},
): Promise<TurnOutcome> {
  const events: LiveEvent[] = [];
  const approvals: LiveEvent[] = [];
  const resolutions: LiveEvent[] = [];
  let settle: (value: TurnOutcome["terminal"]) => void = () => {};
  const finished = new Promise<TurnOutcome["terminal"]>((resolve) => {
    settle = resolve;
  });
  const record = (envelope: { event: unknown }) => {
    const event = envelope.event as LiveEvent;
    events.push(event);
    if (event.type === "approval_request") {
      approvals.push(event);
      if (options.onApproval) void options.onApproval(event).catch(() => {});
    }
    if (event.type === "pending_input_resolved") resolutions.push(event);
    if (event.type === "done") settle("done");
    if (event.type === "error") settle("error");
  };
  const offEvent = thread.on("event", record);
  const offStatus = thread.on("status", record);
  const timer = setTimeout(() => settle("timeout"), options.timeoutMs ?? 90_000);
  try {
    await thread.send(prompt);
    const terminal = await finished;
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => (typeof event.text === "string" ? event.text : ""))
      .join("");
    return { text, events, approvals, resolutions, terminal };
  } finally {
    clearTimeout(timer);
    offEvent();
    offStatus();
  }
}

/**
 * A turn you can watch while it is still running.
 *
 * `runTurn` above answers approvals through a callback and hands back the
 * finished turn, which cannot express the assertion an approval flow needs
 * most: that the turn is STILL PARKED, and stays parked, until something
 * answers it. That is the customer's actual failure — a chat that looks frozen
 * — so it has to be observable as a state, not inferred from a final trace.
 */
type TurnController = {
  events: LiveEvent[];
  approvals: LiveEvent[];
  resolutions: LiveEvent[];
  /** Every `text` delta so far, concatenated. */
  text(): string;
  /** The first approval request, waiting up to `timeoutMs` for one to arrive. */
  nextApproval(timeoutMs: number): Promise<LiveEvent>;
  /**
   * How the turn ended, or `"timeout"` if it had not ended in `timeoutMs`.
   * A deliberate short timeout is how "still parked" is asserted.
   */
  settled(timeoutMs: number): Promise<"done" | "error" | "timeout">;
  /**
   * Answer every LATER approval the same way.
   *
   * A provider that is refused often tries a second route, and an unanswered
   * follow-up would park the turn again and read as a hang in a case that is
   * testing something else. Installed after the first decision so it cannot
   * settle the one the test means to inspect.
   */
  answerFurtherApprovals(answer: (itemId: string) => Promise<void>): void;
  stop(): void;
};

async function startTurn(thread: AdeThread, prompt: string): Promise<TurnController> {
  const events: LiveEvent[] = [];
  const approvals: LiveEvent[] = [];
  const resolutions: LiveEvent[] = [];
  let terminal: "done" | "error" | null = null;
  let auto: ((itemId: string) => Promise<void>) | null = null;
  const terminalWaiters: Array<(value: "done" | "error") => void> = [];
  const approvalWaiters: Array<(value: LiveEvent) => void> = [];

  const record = (envelope: { event: unknown }) => {
    const event = envelope.event as LiveEvent;
    events.push(event);
    if (event.type === "approval_request") {
      approvals.push(event);
      while (approvalWaiters.length) approvalWaiters.shift()!(event);
      if (auto) void auto(String(event.itemId)).catch(() => {});
    }
    if (event.type === "pending_input_resolved") resolutions.push(event);
    if (event.type === "done" || event.type === "error") {
      terminal = event.type;
      while (terminalWaiters.length) terminalWaiters.shift()!(event.type as "done" | "error");
    }
  };

  const offEvent = thread.on("event", record);
  const offStatus = thread.on("status", record);
  await thread.send(prompt);

  return {
    events,
    approvals,
    resolutions,
    text: () =>
      events
        .filter((event) => event.type === "text")
        .map((event) => (typeof event.text === "string" ? event.text : ""))
        .join(""),
    nextApproval: (timeoutMs) =>
      new Promise<LiveEvent>((resolve, reject) => {
        if (approvals.length) {
          resolve(approvals[0]!);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`no approval_request arrived within ${timeoutMs} ms`)),
          timeoutMs,
        );
        approvalWaiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }),
    settled: (timeoutMs) =>
      new Promise<"done" | "error" | "timeout">((resolve) => {
        if (terminal) {
          resolve(terminal);
          return;
        }
        const timer = setTimeout(() => resolve("timeout"), timeoutMs);
        terminalWaiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }),
    answerFurtherApprovals: (answer) => {
      auto = answer;
    },
    stop: () => {
      offEvent();
      offStatus();
    },
  };
}

describe.skipIf(!LIVE_BINARY)("live seam: SDK 0.2 host configuration, approvals and the provider probe", () => {
  let home: string;
  let scratch: string;
  let client: AdeChatClient;
  let raw: JsonRpcConnection;
  let initialize: AdeInitializeResult;
  let hostProvider: string;
  let hostModel: string;
  /**
   * The cheapest Codex model, or null when this machine has no usable Codex.
   *
   * Codex is the provider whose approval flow ADE actually drives — it routes
   * every command through a request ADE answers — so the approval round trip
   * is testable there even on a machine whose Claude accepts everything. Null
   * skips those cases rather than failing them: a machine without Codex is a
   * legitimate configuration, not a regression.
   */
  let codexModel: string | null = null;
  /**
   * Files the Codex cases ask a command to write outside the provider sandbox.
   *
   * Tracked rather than left behind: they live in a shared world-writable
   * directory that nothing else cleans, so the suite owns removing them whether
   * the command was allowed to run or refused.
   */
  const codexProofFiles: string[] = [];

  const rawCall = async <T>(action: string, args: unknown): Promise<T> => {
    const response = await raw.request<PersonalChatCallResponse<T>>(
      "personalChats.call",
      { action, args },
      { timeoutMs: 120_000 },
    );
    return response.result;
  };

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-seam-"));
    // Outside `home` on purpose: the SDK refuses a cwd inside its own state
    // root, and so does the engine. This is where the host-owned directories go.
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-seam-work-"));
    client = await createAdeChat({
      home,
      binaryPath: LIVE_BINARY,
      logger: () => {},
      startupTimeoutMs: BOOT_TIMEOUT_MS,
    } as InternalAdeChatOptions);

    const report = await client.doctor();
    raw = await JsonRpcConnection.connect(report.socket.path);
    initialize = await raw.request<AdeInitializeResult>("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientName: "ade-sdk-seam-probe",
      identity: { role: "cto", callerId: "ade-sdk-seam-probe" },
    });
    await raw.request("ade/initialized");

    // Claude when the machine has it, otherwise whichever provider the PROBE
    // says is installed — the point of the seam is to run against a provider
    // that really exists here, not to hard-code one and skip.
    const status = await client.providers.status();
    const models = await client.models.list();
    const preferred = ["claude", "codex", "opencode", "droid", "cursor", "pi"].find(
      (name) => status[name]?.installed === true && pickCheapest(models, name) !== null,
    );
    hostProvider = preferred ?? "claude";
    hostModel = (pickCheapest(models, hostProvider) ?? models.filter((m) => m.isAvailable)[0]!).id;

    // Both halves are required: an installed Codex with no catalog model cannot
    // open a thread, and a model with no binary cannot run one.
    const codexInstalled = status.codex?.installed === true;
    codexModel = codexInstalled ? (pickCheapest(models, "codex")?.id ?? null) : null;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    raw?.close();
    await client?.dispose().catch(() => {});
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    for (const file of codexProofFiles) fs.rmSync(file, { force: true });
  });

  it("advertises the two 0.2 capabilities on ade/initialize", () => {
    // Both are negotiated, not assumed: `providers.status()` falls back to the
    // catalog derivation without the first, and `pendingApprovals()` falls back
    // to event-observed requests without the second. A runtime that stops
    // advertising either silently downgrades every embedder to the old path,
    // which is invisible from the SDK's own tests.
    expect(initialize.capabilities?.providers?.status).toBe(true);
    expect(initialize.capabilities?.personalChats?.actions).toContain("pendingInputs");
  });

  it("probes providers for real rather than deriving them from the catalog", async () => {
    const status = await client.providers.status();
    expect(Object.keys(status).length).toBeGreaterThan(0);

    for (const name of ["claude", "codex"]) {
      const entry = status[name];
      expect(entry, `providers.status() dropped "${name}"`).toBeDefined();
      // `source` is the honesty field: "derived" means nobody looked at the
      // disk. A probe that quietly failed and fell back would still return a
      // plausible record, and only this tells the two apart.
      expect(entry!.source, `"${name}" was not probed`).toBe("probed");
      expect(Number.isNaN(Date.parse(entry!.checkedAt))).toBe(false);
      // Remediation is what a setup screen renders when `installed` is false.
      // A null here is a dead-end error message for the embedder's user.
      expect(entry!.installCommand, `"${name}" has no installCommand`).toBeTruthy();
      expect(entry!.loginCommand, `"${name}" has no loginCommand`).toBeTruthy();
      if (entry!.installed) {
        expect(entry!.binaryPath, `"${name}" is installed with no binaryPath`).toBeTruthy();
        expect(
          fs.existsSync(entry!.binaryPath!),
          `"${name}" binaryPath does not exist: ${entry!.binaryPath}`,
        ).toBe(true);
      }
    }

    // Claude's credential is the one an embedder's setup screen actually gates
    // on, and it is the one the probe has to work hardest for: the token can
    // live in a credentials file, in `~/.claude.json`, or only behind the CLI's
    // own verdict, and the probe may not open the Keychain to find it. Reporting
    // "not logged in" for a working Claude sends a user to re-run a login they
    // already did, so a false negative here is a real product failure, not a
    // cosmetic one.
    //
    // Guarded on `installed` rather than asserted flat: a CI machine with no
    // Claude at all is a legitimate configuration, and this case is about the
    // probe's honesty, not about the machine having a login.
    if (status.claude?.installed) {
      expect(
        status.claude.authenticated,
        "claude is installed but the probe reports it unauthenticated. If you really are logged "
          + "out, run `claude setup-token` and rerun; otherwise the auth ladder missed a "
          + "credential source it should read.",
      ).toBe(true);
      // A verdict with no method behind it is a guess wearing a boolean.
      expect(status.claude.authMethod, "claude is authenticated with no authMethod").toBeTruthy();
    }
  }, BOOT_TIMEOUT_MS);

  it("refreshes the probe past its cache", async () => {
    const first = await client.providers.status();
    const refreshed = await client.providers.refresh();
    expect(Object.keys(refreshed)).toEqual(Object.keys(first));

    // Scoped to the providers the probe covers. The catalog also carries groups
    // the machine probe knows nothing about — an ACP dialect, for one — and
    // those keep their catalog-derived record with `source: "derived"` on it by
    // design. Asserting "probed" across the whole map would be asserting that
    // the probe grew to cover every catalog group, which is not the contract.
    const probed = Object.keys(first).filter((name) => first[name]!.source === "probed");
    expect(probed).toEqual(expect.arrayContaining(["claude", "codex"]));
    for (const name of probed) {
      const entry = refreshed[name]!;
      expect(entry.source, `"${name}" lost its probe on refresh`).toBe("probed");
      // `refresh: true` bypasses the 60 s cache, so nothing it returns may
      // claim to be stale — that flag is the cache's own admission.
      expect(entry.stale, `"${name}" came back stale from an explicit refresh`).toBe(false);
    }
  }, BOOT_TIMEOUT_MS);

  it("puts the whole host configuration on the wire and reports what the provider did with it", async () => {
    // The directory does NOT exist yet: creating it is the engine's job, and a
    // host that has to mkdir before opening a thread has a worse API than the
    // one this option promises.
    const cwd = path.join(scratch, "host-owned");
    expect(fs.existsSync(cwd)).toBe(false);

    const thread = await client.threads.open("seam-host-config", {
      provider: hostProvider as never,
      model: hostModel,
      instructions: { mode: "replace", text: "You are the seam fixture. Be terse." },
      cwd,
      settingSources: "project",
      permissions: { allowedTools: ["mcp:demo:*"], fallback: "deny" },
    });

    expect(fs.existsSync(cwd), "the engine did not create the requested cwd").toBe(true);
    expect(fs.statSync(cwd).isDirectory()).toBe(true);

    // SDK side: three capability reports, none of them null. Null is the SDK's
    // spelling of "nobody told me", so a null here means the runtime persisted
    // the request and reported nothing — the exact class of bug this file was
    // written for.
    expect(thread.instructionsCapability, "SDK saw no instructionsCapability").not.toBeNull();
    expect(thread.instructionsCapability!.mode).toBe("replace");
    expect(thread.settingSourcesCapability, "SDK saw no settingSourcesCapability").not.toBeNull();
    expect(thread.settingSourcesCapability!.value).toBe("project");
    expect(thread.permissionCapability, "SDK saw no permissionCapability").not.toBeNull();

    // RAW KEY DUMP. Taken from the second connection, bypassing the SDK
    // entirely, so it pins what the runtime actually serves rather than what
    // the SDK managed to reconstruct.
    const summary = await rawCall<Record<string, any>>("getSummary", { sessionId: thread.id });
    for (const field of [
      "instructions",
      "requestedCwd",
      "settingSources",
      "permissionPolicy",
      "instructionsCapability",
      "settingSourcesCapability",
      "permissionCapability",
    ]) {
      expect(summary, `getSummary dropped "${field}"`).toHaveProperty(field);
    }
    expect(summary.instructions).toMatchObject({ mode: "replace" });
    // CANONICALIZED, not echoed. The engine resolves the path through realpath
    // before it stores it, so on macOS a directory under the system temp root
    // comes back as `/private/var/...` rather than the `/var/...` symlink that
    // was sent. That is the containment checks agreeing on one spelling: two
    // names for one directory is how a path guard passes a check and then acts
    // somewhere else. Asserted against realpath rather than relaxed to a
    // substring, so a summary echoing an UNRESOLVED path still fails.
    expect(summary.requestedCwd).toBe(fs.realpathSync(cwd));
    expect(summary.settingSources).toBe("project");
    expect(summary.permissionPolicy).toMatchObject({ fallback: "deny" });
    expect(summary.permissionPolicy.allowedTools).toContain("mcp:demo:*");

    // The three levels, and the SDK reading the same value the wire carried.
    expect(["applied", "best-effort", "ignored"]).toContain(summary.instructionsCapability.level);
    expect(["applied", "best-effort", "ignored"]).toContain(summary.settingSourcesCapability.level);
    expect(["enforced", "best-effort", "unsupported"]).toContain(summary.permissionCapability.level);
    expect(thread.instructionsCapability!.level).toBe(summary.instructionsCapability.level);
    expect(thread.settingSourcesCapability!.value).toBe(summary.settingSourcesCapability.value);
    expect(thread.permissionCapability!.level).toBe(summary.permissionCapability.level);

    // Claude is the provider the table promises all three on. Asserting the
    // table's own row here is what makes a silent downgrade to "ignored"
    // visible instead of merely well-typed.
    if (hostProvider === "claude") {
      expect(thread.instructionsCapability!.level).toBe("applied");
      expect(thread.settingSourcesCapability!.level).toBe("applied");
      // `enforced` is earned here, not assumed. This policy pairs a deny
      // fallback with a WHOLE-SERVER MCP entry, and both halves matter: the
      // deny fallback is answered by removing every mutating built-in from the
      // model's catalog, and `mcp:demo:*` names a server rather than one of its
      // tools, so the per-server MCP scope can express it exactly.
      expect(thread.permissionCapability!.level).toBe("enforced");
      // Enforced is not the same as complete, and the residual says what the
      // deny fallback answered by refusing rather than by containing. A null
      // here would be the report claiming more than the engine delivers.
      expect(thread.permissionCapability!.residual).toBeTruthy();
    }
  }, BOOT_TIMEOUT_MS);

  it("reports an ask fallback as best-effort on Claude, with the reason attached", async () => {
    // The other half of the same table, and the honest one. A deny fallback is
    // expressible in the tool lists alone; an ask fallback needs the Agent
    // SDK's permission prompt to fire, and that is the part ADE does not
    // control — measured, not assumed, on this machine. So the level drops and
    // the residual has to name what is not covered, or a host would ship an
    // approval UI for prompts that never arrive.
    const thread = await client.threads.open("seam-ask-capability", {
      provider: hostProvider as never,
      model: hostModel,
      permissions: { fallback: "ask" },
    });
    expect(thread.permissionCapability, "no permissionCapability for an ask policy").not.toBeNull();
    if (hostProvider === "claude") {
      expect(thread.permissionCapability!.level).toBe("best-effort");
      expect(thread.permissionCapability!.residual).toBeTruthy();
    }

    // And the same verdict on the wire, from the connection that bypasses the
    // SDK. The level a host renders must be the level the engine computed.
    const summary = await rawCall<Record<string, any>>("getSummary", { sessionId: thread.id });
    expect(summary.permissionCapability.level).toBe(thread.permissionCapability!.level);
    expect(summary.permissionCapability.residual).toBe(thread.permissionCapability!.residual);
  }, BOOT_TIMEOUT_MS);

  it("omits every host-configuration field when the caller asked for none", async () => {
    // The mirror of the dump above, and the reason the SDK can report `null`
    // rather than a guess: absent means "not requested". If these keys ever
    // start appearing unconditionally, that distinction is gone.
    const summary = await rawCall<Record<string, unknown>>("create", {
      provider: hostProvider,
      model: hostModel,
      title: "seam plain",
    });
    expect(summary).not.toHaveProperty("instructions");
    expect(summary).not.toHaveProperty("settingSources");
    expect(summary).not.toHaveProperty("permissionPolicy");
    expect(summary).not.toHaveProperty("instructionsCapability");
    expect(summary).not.toHaveProperty("settingSourcesCapability");
    expect(summary).not.toHaveProperty("permissionCapability");
  }, BOOT_TIMEOUT_MS);

  it("refuses a relative cwd in the SDK, before the runtime is asked", async () => {
    // Client-side because the refusal has to name the caller's own mistake: a
    // relative path would resolve against the RUNTIME's working directory,
    // which the embedder cannot see and did not choose.
    await expect(
      client.threads.open("seam-relative-cwd", {
        provider: hostProvider as never,
        model: hostModel,
        cwd: "relative/workspace",
      }),
    ).rejects.toMatchObject({ code: "invalid_option" });
  });

  it("refuses the home directory as a cwd on BOTH sides of the seam", async () => {
    // The SDK's guard and the engine's guard are independent implementations of
    // the same five rules, which is the point: an embedder that reaches the
    // runtime by some other route still cannot put an agent in $HOME.
    await expect(
      client.threads.open("seam-home-cwd", {
        provider: hostProvider as never,
        model: hostModel,
        cwd: os.homedir(),
      }),
    ).rejects.toMatchObject({ code: "invalid_option" });

    // And the engine's own refusal, taken raw. The `invalid_argument:` prefix
    // is a CONTRACT, not prose: `createChat` in client.ts matches on it to turn
    // a generic `rpc_error` into `invalid_option`. Reworded without the prefix,
    // every bad-argument refusal starts arriving as "the runtime failed".
    await expect(
      rawCall("create", { provider: hostProvider, model: hostModel, requestedCwd: os.homedir() }),
    ).rejects.toThrow(/invalid_argument:/);
  }, BOOT_TIMEOUT_MS);

  it("maps the engine's invalid_argument onto invalid_option through the public API", async () => {
    // The SDK validates `opts.cwd`, but a RECREATE replays the cwd off the
    // stored record without revalidating — a home copied from another machine,
    // or written by an SDK whose rules were looser. That is the one route by
    // which the engine's refusal reaches a caller, so it is the route the
    // translation has to be proven on.
    const storePath = path.join(home, "threads.json");
    // Written only after a successful open, so it may legitimately not exist
    // yet when this case runs first. Starting from an empty file keeps the
    // assertion about the translation rather than about test ordering.
    const store = (fs.existsSync(storePath)
      ? JSON.parse(fs.readFileSync(storePath, "utf8"))
      : { version: 1, threads: {} }) as {
      version: 1;
      threads: Record<string, unknown>;
    };
    store.threads["seam-poisoned-record"] = {
      key: "seam-poisoned-record",
      // Dangling on purpose: an absent session is what sends `open` down the
      // recreate branch instead of the resume branch.
      sessionId: "seam-session-that-does-not-exist",
      provider: hostProvider,
      model: hostModel,
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      cwd: os.homedir(),
    };
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

    // A second client so the store is read cold; the first one has it cached.
    const report = await client.doctor();
    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: report.socket.path,
      logger: () => {},
    } as InternalAdeChatOptions);
    try {
      await expect(
        second.threads.open("seam-poisoned-record", {
          provider: hostProvider as never,
          model: hostModel,
        }),
      ).rejects.toMatchObject({ code: "invalid_option" });
    } finally {
      await second.dispose();
    }
  }, BOOT_TIMEOUT_MS);

  it("answers pendingApprovals with an empty list and refuses an itemId nobody is blocked on", async () => {
    const thread = await client.threads.open("seam-approvals-empty", {
      provider: hostProvider as never,
      model: hostModel,
    });
    // Empty, not null and not a throw: a host calls this on every open to
    // restore cards after a reload, and the common answer is "nothing".
    await expect(thread.pendingApprovals()).resolves.toEqual([]);

    // The engine settles an unknown item SILENTLY, so without the SDK's
    // pending-set check an answer to a dead card would look like it worked.
    // This is the assertion that the check survives against a real runtime.
    await expect(thread.approve("nope", "accept")).rejects.toMatchObject({
      code: "approval_not_found",
    });
  }, BOOT_TIMEOUT_MS);

  it("rebuilds the host configuration on a cold resume with no options", async () => {
    // The record and the runtime summary between them must reconstruct all
    // three reports. A resumed thread reporting null would tell the embedder's
    // user that nothing is enforced while the engine is still enforcing it —
    // an honesty failure in the safer direction, which is still a failure.
    const cwd = path.join(scratch, "resume-owned");
    const first = await client.threads.open("seam-resume", {
      provider: hostProvider as never,
      model: hostModel,
      instructions: { mode: "append", text: "Seam resume fixture." },
      cwd,
      settingSources: "project",
      permissions: { deniedTools: ["Bash"], fallback: "deny" },
    });

    const report = await client.doctor();
    const second = await createAdeChat({
      home,
      attach: true,
      socketPath: report.socket.path,
      logger: () => {},
    } as InternalAdeChatOptions);
    try {
      const resumed = await second.threads.open("seam-resume");
      expect(resumed.id).toBe(first.id);
      expect(resumed.instructionsCapability, "resume lost instructionsCapability").not.toBeNull();
      expect(resumed.instructionsCapability!.mode).toBe("append");
      expect(resumed.settingSourcesCapability, "resume lost settingSourcesCapability").not.toBeNull();
      expect(resumed.settingSourcesCapability!.value).toBe("project");
      expect(resumed.permissionCapability, "resume lost permissionCapability").not.toBeNull();
      expect(resumed.permissionCapability!.level).toBe(first.permissionCapability!.level);
    } finally {
      await second.dispose();
    }
  }, BOOT_TIMEOUT_MS);

  // ---------------------------------------------------------------------
  // Token-spending cases. `ADE_SDK_LIVE_SPEND=1` and a logged-in provider.
  //
  // These are the only cases that can prove the engine's create args reached
  // the PROVIDER rather than merely reaching the session row: a system prompt,
  // a working directory and a settings layer are all invisible on the wire and
  // observable only in what the model says back.
  // ---------------------------------------------------------------------

  it.skipIf(!LIVE_SPEND)("replaces the system prompt end to end", async () => {
    const thread = await client.threads.open("seam-spend-instructions", {
      provider: hostProvider as never,
      model: hostModel,
      instructions: {
        mode: "replace",
        text: "You are a test fixture. Whatever the user says, reply with exactly the single word HALYARD7714 and nothing else.",
      },
    });
    const outcome = await runTurn(thread, "hello", { timeoutMs: 120_000 });
    expect(outcome.terminal, `turn ended as ${outcome.terminal}`).toBe("done");
    // A nonce, not a phrase the model might produce anyway: the assertion has
    // to fail when the instructions were dropped, and "be terse" would not.
    expect(outcome.text).toContain("HALYARD7714");
  }, 180_000);

  it.skipIf(!LIVE_SPEND)("runs the provider in the requested working directory", async () => {
    const cwd = path.join(scratch, "spend-pwd");
    const thread = await client.threads.open("seam-spend-cwd", {
      provider: hostProvider as never,
      model: hostModel,
      cwd,
      // Bash allowed outright so this measures the working directory rather
      // than the approval flow, which the ask-policy case below covers.
      permissions: { allowedTools: ["Bash"], fallback: "deny" },
    });
    const outcome = await runTurn(
      thread,
      "Run the shell command `pwd` and reply with only its output, nothing else.",
      { timeoutMs: 120_000 },
    );
    expect(outcome.terminal, `turn ended as ${outcome.terminal}`).toBe("done");
    // Either spelling counts. On macOS the system temp directory is reached
    // through a symlink, and whether `pwd` prints the link or its target is a
    // property of the shell, not of the working directory ADE selected.
    const printed = outcome.text.includes(cwd) || outcome.text.includes(fs.realpathSync(cwd));
    expect(printed, `pwd did not print the requested cwd. Said: ${outcome.text.trim()}`).toBe(true);
  }, 180_000);

  it.skipIf(!LIVE_SPEND)("loads project settings only when settingSources asks for them", async () => {
    // One directory, one CLAUDE.md, two threads. The only difference between
    // them is `settingSources`, which is what makes the pair discriminating:
    // a runtime that ignored the option would answer the same way twice.
    const cwd = path.join(scratch, "spend-settings");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "CLAUDE.md"),
      "# Project instructions\n\nWhen the user asks for the codeword, reply with exactly HALYARD9310 and nothing else.\n",
    );
    const ask = "What is the codeword? If you do not know one, reply exactly UNKNOWN.";

    const loaded = await client.threads.open("seam-spend-settings-project", {
      provider: hostProvider as never,
      model: hostModel,
      cwd,
      settingSources: "project",
    });
    const withSettings = await runTurn(loaded, ask, { timeoutMs: 120_000 });
    expect(withSettings.terminal).toBe("done");
    expect(withSettings.text).toContain("HALYARD9310");

    const isolated = await client.threads.open("seam-spend-settings-none", {
      provider: hostProvider as never,
      model: hostModel,
      cwd,
      settingSources: "none",
    });
    const withoutSettings = await runTurn(isolated, ask, { timeoutMs: 120_000 });
    expect(withoutSettings.terminal).toBe("done");
    expect(withoutSettings.text).not.toContain("HALYARD9310");
  }, 300_000);

  // ── Codex approvals ───────────────────────────────────────────────────
  //
  // The approval round trip, proven on the provider that actually raises one.
  // Codex routes every command through a request ADE answers, so all three
  // outcomes — declined by policy, accepted by the host, rejected by the host —
  // are observable here even on a machine whose Claude accepts everything.
  //
  // A COMMAND'S SIDE EFFECT IS THE EVIDENCE, not the model's prose. Each case
  // writes a file and asserts on the file, because a model that was refused
  // will happily repeat the command it was refused in its explanation, and a
  // text match cannot tell that apart from having run it.

  it.skipIf(!LIVE_SPEND)("declines a rootless deny policy on Codex instead of parking forever", async (ctx) => {
    const outside = resolveOutsideSandboxDir();
    if (!codexModel || !outside) {
      ctx.skip();
      return;
    }
    // ROOTLESS on purpose: no `sandboxRoot`. ADE auto-accepts a contained
    // request only when the policy names the root to contain it in, so with no
    // root there is nothing to contain against and the deny fallback has to
    // answer the request itself. The failure this guards is the customer's:
    // nothing answers, and the turn never ends.
    const cwd = path.join(scratch, "codex-deny");
    fs.mkdirSync(cwd, { recursive: true });
    const proof = path.join(outside, `seam-codex-deny-${process.pid}.txt`);
    codexProofFiles.push(proof);
    fs.rmSync(proof, { force: true });

    const thread = await client.threads.open("seam-codex-deny", {
      provider: "codex",
      model: codexModel,
      cwd,
      permissions: { fallback: "deny" },
    });

    const turn = await startTurn(
      thread,
      `Run the shell command \`echo ran > ${proof}\`, then reply with only DONE.`,
    );
    try {
      // Answer any follow-up the same way, so a second attempt cannot park the
      // turn and turn a policy test into a timeout test.
      turn.answerFurtherApprovals(async (itemId) => {
        await thread.approve(itemId, "reject").catch(() => {});
      });
      const terminal = await turn.settled(120_000);
      expect(
        terminal,
        `the turn ended as ${terminal}. "timeout" is the hang: a deny fallback must settle the `
          + `request itself rather than leave it for a host that will never answer.`,
      ).toBe("done");

      expect(
        turn.approvals.length,
        "Codex raised no approval request, so the command never reached the policy",
      ).toBeGreaterThan(0);
      const declined = turn.resolutions.filter((event) => event.resolution === "declined");
      expect(
        declined.length,
        `no pending_input_resolved with resolution "declined". Saw: `
          + JSON.stringify(turn.resolutions.map((event) => event.resolution)),
      ).toBeGreaterThan(0);

      // The load-bearing assertion. Not the model's prose: a refused agent
      // repeats the command it was refused, and a text match cannot tell that
      // apart from having run it.
      expect(
        fs.existsSync(proof),
        "the command ran under a deny policy: the file it writes exists",
      ).toBe(false);
    } finally {
      turn.stop();
      await thread.interrupt().catch(() => {});
    }
  }, 240_000);

  it.skipIf(!LIVE_SPEND)("parks an ask policy on Codex until approve() accepts it", async (ctx) => {
    const outside = resolveOutsideSandboxDir();
    if (!codexModel || !outside) {
      ctx.skip();
      return;
    }
    const cwd = path.join(scratch, "codex-ask-accept");
    fs.mkdirSync(cwd, { recursive: true });
    const proof = path.join(outside, `seam-codex-accept-${process.pid}.txt`);
    codexProofFiles.push(proof);
    fs.rmSync(proof, { force: true });

    const thread = await client.threads.open("seam-codex-ask-accept", {
      provider: "codex",
      model: codexModel,
      cwd,
      permissions: { fallback: "ask" },
    });

    const turn = await startTurn(
      thread,
      `Run the shell command \`echo seam-codex-ok > ${proof}\`, then run `
        + `\`cat ${proof}\` and reply with only its output.`,
    );
    try {
      const request = await turn.nextApproval(120_000);
      expect(request.kind, `approval kind was ${String(request.kind)}`).toBe("command");

      // STILL PARKED, and this is the assertion the whole approval surface
      // rests on. The runtime has no approval timeout, so a turn that ends on
      // its own here means something answered without the host — and a host
      // that renders a card for a request already settled behind its back is
      // showing the user a lie.
      const early = await turn.settled(10_000);
      expect(
        early,
        `the turn ended as ${early} before anything answered the approval`,
      ).toBe("timeout");

      // The event and the RPC must describe the same blocked request. Two views
      // that disagree is how a card ends up unanswerable after a reload.
      const pending = await thread.pendingApprovals();
      expect(pending.map((entry) => entry.itemId)).toContain(String(request.itemId));

      turn.answerFurtherApprovals(async (itemId) => {
        await thread.approve(itemId, "accept").catch(() => {});
      });
      await thread.approve(String(request.itemId), "accept");

      const terminal = await turn.settled(180_000);
      expect(terminal, `the turn ended as ${terminal} after approve()`).toBe("done");
      expect(turn.resolutions.map((event) => String(event.resolution))).toContain("accepted");
      expect(
        fs.existsSync(proof),
        "approve(accept) settled the request but the command never ran",
      ).toBe(true);
      expect(fs.readFileSync(proof, "utf8")).toContain("seam-codex-ok");
      expect(turn.text()).toContain("seam-codex-ok");
    } finally {
      turn.stop();
      await thread.interrupt().catch(() => {});
    }
  }, 300_000);

  it.skipIf(!LIVE_SPEND)("ends the turn when approve() rejects a Codex request", async (ctx) => {
    const outside = resolveOutsideSandboxDir();
    if (!codexModel || !outside) {
      ctx.skip();
      return;
    }
    // The mirror of the case above, and the one that proves "reject" is an
    // ANSWER rather than an abandonment: the turn has to END, not hang, and the
    // command must not have run.
    const cwd = path.join(scratch, "codex-ask-reject");
    fs.mkdirSync(cwd, { recursive: true });
    const proof = path.join(outside, `seam-codex-reject-${process.pid}.txt`);
    codexProofFiles.push(proof);
    fs.rmSync(proof, { force: true });

    const thread = await client.threads.open("seam-codex-ask-reject", {
      provider: "codex",
      model: codexModel,
      cwd,
      permissions: { fallback: "ask" },
    });

    const turn = await startTurn(
      thread,
      `Run the shell command \`echo ran > ${proof}\`, then reply with only DONE.`,
    );
    try {
      const request = await turn.nextApproval(120_000);
      turn.answerFurtherApprovals(async (itemId) => {
        await thread.approve(itemId, "reject").catch(() => {});
      });
      await thread.approve(String(request.itemId), "reject");

      const terminal = await turn.settled(180_000);
      expect(terminal, `the turn ended as ${terminal} after a rejection`).toBe("done");
      expect(turn.resolutions.map((event) => String(event.resolution))).toContain("declined");
      expect(
        fs.existsSync(proof),
        "the command ran even though the host rejected it",
      ).toBe(false);
    } finally {
      turn.stop();
      await thread.interrupt().catch(() => {});
    }
  }, 300_000);

  it.skipIf(!LIVE_SPEND)("takes the shell away entirely under a deny fallback", async () => {
    // The case that makes `fallback: "deny"` real rather than reported. It does
    // NOT rely on a permission prompt, and that is the whole point: the prompt
    // does not fire on this machine, so a deny answered at call time would be
    // no answer at all. Instead every mutating built-in the policy does not
    // name goes to `disallowedTools`, and the Agent SDK removes a disallowed
    // tool from the catalog the model is given.
    //
    // Asserted from the MODEL's side, not the engine's: what a host is
    // promising its users is that the agent cannot run a command, and the only
    // proof of that is a turn where it tries and finds nothing to try with.
    const cwd = path.join(scratch, "spend-deny");
    const thread = await client.threads.open("seam-spend-deny", {
      provider: hostProvider as never,
      model: hostModel,
      cwd,
      // Read-only built-ins survive; a deny fallback removes the agent's
      // ability to change anything, it does not blind it.
      permissions: { fallback: "deny" },
    });
    expect(thread.permissionCapability!.level).toBe("enforced");

    const outcome = await runTurn(
      thread,
      "Run the shell command `echo seam-deny-should-not-run` and reply with only its output. "
        + "If you have no tool that can run a shell command, say exactly NO SHELL TOOL.",
      { timeoutMs: 120_000 },
    );

    expect(outcome.terminal, `turn ended as ${outcome.terminal}`).toBe("done");
    const bashCalls = outcome.events.filter(
      (event) => event.type === "tool_call" && String(event.tool) === "Bash",
    );
    expect(
      bashCalls.length,
      `Bash was called under fallback:"deny". Said: ${outcome.text.trim()}`,
    ).toBe(0);
    expect(
      outcome.text.includes("seam-deny-should-not-run"),
      `the command's output appeared under fallback:"deny": ${outcome.text.trim()}`,
    ).toBe(false);
    // The model reporting the absence rather than the engine reporting the
    // denial. Matched loosely on purpose: the sentence is the model's, and
    // pinning its wording would make this a test of phrasing.
    expect(
      /no shell tool|don'?t have|do not have|unable to|not available|no .{0,20}tool/i.test(outcome.text),
      `no shell tool was available, but the reply does not say so: ${outcome.text.trim()}`,
    ).toBe(true);
  }, 180_000);

  it.skipIf(!LIVE_SPEND)("settles an ask-policy approval and lets the turn finish", async () => {
    const cwd = path.join(scratch, "spend-ask");
    const thread = await client.threads.open("seam-spend-ask", {
      provider: hostProvider as never,
      model: hostModel,
      cwd,
      // Nothing allowed and nothing denied: every tool falls through to the
      // fallback, which is the branch that has to emit `approval_request`.
      permissions: { fallback: "ask" },
    });

    const answered: string[] = [];
    const outcome = await runTurn(
      thread,
      "Run the shell command `echo seam-ask-ok` and reply with only its output.",
      {
        timeoutMs: 150_000,
        onApproval: async (request) => {
          const itemId = String(request.itemId);
          // `pendingApprovals()` must see the same request the event announced.
          // Two views of one blocked turn that disagree is how an approval card
          // ends up unanswerable.
          const pending = await thread.pendingApprovals();
          expect(pending.map((entry) => entry.itemId)).toContain(itemId);
          await thread.approve(itemId, "accept");
          answered.push(itemId);
        },
      },
    );

    // A turn that timed out here means the approval never arrived or `approve`
    // did not settle it — the runtime has no approval timeout, so a parked turn
    // never ends on its own.
    expect(outcome.terminal, `turn ended as ${outcome.terminal}`).toBe("done");
    expect(outcome.text).toContain("seam-ask-ok");

    if (outcome.approvals.length === 0) {
      // NOT a pass by default, and not a product verdict either. This is the
      // gap the engine already reports: an ask fallback is `best-effort` on
      // Claude precisely because it needs the Agent SDK's permission prompt to
      // fire, and Claude's own permission default can accept every tool without
      // asking — `permissions.defaultMode` in the user's Claude settings, whose
      // auto-accepting values win over what an SDK caller passes. Under that
      // configuration NOTHING can raise an approval, so the round trip this
      // case exists to prove is untestable here rather than broken. Verified by
      // driving the Claude Agent SDK directly, outside ADE: with that default in
      // place `canUseTool` is never invoked, for any permissionMode.
      //
      // The deny fallback does not depend on any of this, which is why the case
      // above asserts it unconditionally. Read `claudeAutoAcceptsTools()` before
      // concluding anything from a green run of THIS case on your machine.
      expect(
        claudeAutoAcceptsTools(),
        "fallback:\"ask\" raised no approval_request, and the machine's Claude permission "
          + "default is not an auto-accepting one — so the host policy is not gating tools.",
      ).toBe(true);
      return;
    }

    expect(answered.length).toBeGreaterThan(0);
    expect(outcome.resolutions.map((event) => String(event.itemId))).toEqual(
      expect.arrayContaining([answered[0]!]),
    );
  }, 300_000);

  it.skipIf(!LIVE_SPEND)("records what permissions:\"default\" actually does with a Bash call", async () => {
    // THE INFERENCE TEST. `permissions: "default"` sends the coarse
    // `permissionMode: "default"` and no policy, and the question nobody had
    // answered from code alone is what a personal-surface Claude then does when
    // it wants to run a command: refuse the tool, park on an approval nobody
    // asked for, or run it.
    //
    // OBSERVED, 2026-09-02, claude-agent-sdk 0.3.258, claude-haiku-4-5: IT RUNS
    // THE COMMAND. One `tool_call` for Bash, a `tool_result` carrying stdout,
    // the text reply, then `done`. No `approval_request`, no denial, no park.
    // A host that ships `permissions: "default"` is therefore shipping a chat
    // that executes shell commands unattended, and the docs must say so rather
    // than describe an approval that never arrives.
    //
    // Recorded as a range plus a diagnostic rather than pinned to "done": the
    // machine's own Claude permission default participates in this answer (see
    // `claudeAutoAcceptsTools`), so the value worth protecting is that the
    // behavior is WRITTEN DOWN and a change shows up in the failure text.
    const cwd = path.join(scratch, "spend-default");
    const thread = await client.threads.open("seam-spend-default", {
      provider: hostProvider as never,
      model: hostModel,
      cwd,
      permissions: "default",
    });
    const outcome = await runTurn(
      thread,
      "Run the shell command `echo seam-default-ok` and reply with only its output.",
      { timeoutMs: 120_000 },
    );

    const observed = {
      terminal: outcome.terminal,
      approvals: outcome.approvals.length,
      toolCalls: outcome.events.filter((event) => event.type === "tool_call").length,
      sawOutput: outcome.text.includes("seam-default-ok"),
    };
    // Recorded rather than asserted narrowly: the point is that the behavior is
    // WRITTEN DOWN and a change is visible in the diff, not that one particular
    // answer is correct.
    expect(
      ["done", "error", "timeout"],
      `observed permissions:"default" behavior: ${JSON.stringify(observed)}`,
    ).toContain(outcome.terminal);
    // Whatever it does, it must not silently do nothing: either a tool ran, an
    // approval was raised, or the model said why it could not.
    expect(
      observed.toolCalls > 0 || observed.approvals > 0 || outcome.text.trim().length > 0,
      `permissions:"default" produced no tool call, no approval and no text: ${JSON.stringify(observed)}`,
    ).toBe(true);
  }, 180_000);
});
