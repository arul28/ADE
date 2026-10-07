/**
 * The cross-machine move, from the source brain, through its public seams:
 * `createCrossMachineHandoffOrchestrator` with fakes only at its boundaries
 * (the machine transport is the network; the kv row and outbox are the real
 * `createCrossMachineHandoffSource` storage over an in-memory kv and a temp
 * dir), and `packHandoffGitBundle` / `applyHandoffGitBundle` on real git repos.
 *
 * Not in agentChatServiceHandoff.test.ts: that file's harness mocks the git
 * module for every test, so it cannot run the bundle against real repos, and
 * the orchestrator's state machine is reachable there only through a full
 * chat service with no transport seam.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CROSS_MACHINE_PERMISSION_FIELDS } from "../../../shared/crossMachineHandoff";
import type {
  AgentChatCrossMachineHandoffCapsule,
  AgentChatCrossMachineHandoffRecord,
  AgentChatPrepareCrossMachineHandoffArgs,
  AgentChatPrepareCrossMachineHandoffResult,
  AgentChatStartCrossMachineHandoffArgs,
} from "../../../shared/types";
import {
  createCrossMachineHandoffOrchestrator,
  CrossMachineSourceStaleError,
  type CrossMachineHandoffPersisted,
  type CrossMachineMoveOutcome,
} from "./crossMachineHandoffOrchestrator";
import { createCrossMachineHandoffSource, isPersonAuthoredUserMessage } from "./crossMachineHandoffSource";
import { applyHandoffGitBundle, landHandoffGitBundle, packHandoffGitBundle } from "./handoffGitBundle";

const SESSION = "chat-1";
const ORIGIN = "https://github.com/example/ade.git";
const TERMINAL = new Set(["continued", "failed", "cancelled", "unknown"]);
/** A destination that is ready for the move. */
const READY_PREFLIGHT = {
  providerAuthorized: true,
  modelAvailable: true,
  remoteBranchHeadSha: "a".repeat(40),
  existingLaneId: null,
  blockingErrors: [],
  warnings: [],
};

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type AcceptBehavior = (capsule: AgentChatCrossMachineHandoffCapsule) => unknown;

function createHarness(options: { permissionLevel?: string; turnActive?: boolean; userMessageIds?: string[] } = {}) {
  const dir = makeTempDir("ade-cm-orchestrator-");
  const kv = new Map<string, unknown>();
  const store = createCrossMachineHandoffSource({
    runGit: async () => {
      throw new Error("the orchestrator tests inspect no lane");
    },
    laneService: { getSummary: async () => null },
    db: {
      getJson: <T>(key: string) => (kv.has(key) ? structuredClone(kv.get(key)) as T : null),
      setJson: (key: string, value: unknown) => {
        kv.set(key, structuredClone(value));
      },
      all: <T>(_sql: string, params?: unknown[]) => {
        const prefix = String(params?.[0] ?? "").replace(/%$/, "");
        return [...kv.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) as T[];
      },
    } as never,
    outboxDir: path.join(dir, "outbox"),
  });
  const chat = {
    exists: true,
    turnActive: options.turnActive ?? false,
    permissionLevel: options.permissionLevel ?? "full-auto",
    userMessageIds: [...(options.userMessageIds ?? [])],
  };
  const prepared: AgentChatPrepareCrossMachineHandoffArgs[] = [];
  const accepted: Array<{ capsule: AgentChatCrossMachineHandoffCapsule; capsuleFingerprint: string }> = [];
  const notices: AgentChatCrossMachineHandoffRecord[] = [];
  const notified: AgentChatCrossMachineHandoffRecord[] = [];
  const outcomes: Array<{ handoffId: string; outcome: CrossMachineMoveOutcome }> = [];
  const cards: Array<{ handoffId: string; live: boolean; subtitle: string | null }> = [];
  let preflight: () => Record<string, unknown> = () => ({ ...READY_PREFLIGHT });
  let accept: AcceptBehavior = (capsule) => ({
    handoffId: capsule.handoffId,
    laneId: `lane-there-${capsule.handoffId}`,
    session: { id: `chat-there-${capsule.handoffId}`, laneId: "lane-there", provider: "claude", model: "m" },
    reusedLane: false,
    reusedSession: false,
  });
  let validate: () => Promise<void> = async () => {};
  const waiters: Array<() => void> = [];

  const orchestrator = createCrossMachineHandoffOrchestrator({
    transport: () => ({
      listMachines: async () => [
        { machineKey: "mk-mini", name: "Mac mini", online: true, isThisMachine: false },
        { machineKey: "mk-self", name: "MacBook", online: true, isThisMachine: true },
      ],
      callAction: async (input) => {
        const machine = { machineKey: "mk-mini", name: "Mac mini" };
        if (input.action === "preflightCrossMachineDestination") return { machine, result: preflight() };
        if (input.action === "acceptCrossMachineHandoff") {
          const args = input.args as { capsule: AgentChatCrossMachineHandoffCapsule; capsuleFingerprint: string };
          accepted.push(args);
          return { machine, result: accept(args.capsule) };
        }
        throw new Error(`unexpected destination action ${input.action}`);
      },
    }),
    getSource: (sessionId) => (sessionId === SESSION && chat.exists
      ? {
        sessionId,
        isWorkChat: true,
        turnActive: chat.turnActive,
        awaitingInput: false,
        permissionLevel: chat.permissionLevel,
        provider: "claude",
        title: "Fix login",
      }
      : null),
    readPersisted: store.readMove,
    writePersisted: (sessionId, value) => {
      store.writeMove(sessionId, value);
      for (const wake of waiters.splice(0)) wake();
    },
    listPersisted: store.listMoves,
    chatExists: (sessionId) => sessionId === SESSION && chat.exists,
    inspectSource: async () => ({
      originUrl: ORIGIN,
      rawOriginUrl: ORIGIN,
      branchRef: "feature/login",
      headSha: "a".repeat(40),
      blockers: [],
      changes: null,
    }),
    listUserMessageIds: () => [...chat.userMessageIds],
    prepare: async (args) => {
      prepared.push(structuredClone(args));
      const capsule = {
        version: 1,
        handoffId: args.handoffId,
        createdAt: "2026-10-07T10:00:00.000Z",
        source: {
          machineName: "MacBook",
          sessionId: SESSION,
          provider: "claude",
          model: "claude",
          title: "Fix login",
          laneName: "login",
          branchRef: "feature/login",
          headSha: "a".repeat(40),
          originUrl: ORIGIN,
        },
        target: { targetModelId: args.targetModelId },
        brief: "Continue.",
        artifacts: { fileChanges: [], commands: [], errors: [] },
        linearIssues: [],
        continuationPrompt: "Continue.",
      } as unknown as AgentChatCrossMachineHandoffCapsule;
      return {
        capsule,
        capsuleFingerprint: `fp-${args.handoffId}-${prepared.length}`,
        usedFallbackSummary: false,
        sanitizedSensitiveContext: false,
      } satisfies AgentChatPrepareCrossMachineHandoffResult;
    },
    validateSource: () => validate(),
    markSource: async () => {},
    outbox: store.outbox,
    showApprovalCard: (_sessionId, card) => cards.push({ handoffId: card.handoffId, live: card.live, subtitle: card.subtitle }),
    noticeEnded: (_sessionId, notice) => notices.push(notice.record),
    notifyPerson: (_sessionId, record) => notified.push(record),
    onMoveOutcome: (event) => outcomes.push({ handoffId: event.handoffId, outcome: event.outcome }),
    logger: { info: () => {}, warn: () => {} },
  });

  const record = (): AgentChatCrossMachineHandoffRecord | null => store.readMove(SESSION)?.record ?? null;
  /** Resolves on the write that leaves the move terminal (or clears it). */
  const settled = async (): Promise<AgentChatCrossMachineHandoffRecord | null> => {
    for (;;) {
      const current = record();
      if (!current || TERMINAL.has(current.state)) return current;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const start = (args: Partial<AgentChatStartCrossMachineHandoffArgs> = {}, requestedBy: "user" | "agent" = "user") =>
    orchestrator.start({
      sourceSessionId: SESSION,
      machine: "Mac mini",
      targetModelId: "anthropic/claude-fable-5-1",
      ...args,
    }, { requestedBy });

  return {
    orchestrator,
    store,
    chat,
    prepared,
    accepted,
    notices,
    notified,
    outcomes,
    cards,
    record,
    settled,
    start,
    hasOutbox: (handoffId: string) => store.outbox.read(handoffId) !== null,
    /** Answers each destination preflight; may also act (e.g. delete the chat) while it runs. */
    setPreflight: (answer: () => Record<string, unknown>) => {
      preflight = answer;
    },
    setAccept: (behavior: AcceptBehavior) => {
      accept = behavior;
    },
    setValidate: (behavior: () => Promise<void>) => {
      validate = behavior;
    },
  };
}

/** A lost answer, as the runtime transport reports it. */
const lostAnswer = () => {
  throw new Error("Remote ADE service connection closed: socket closed");
};

describe("cross-machine move orchestrator", () => {
  it.each([
    { label: "a new message from the person", ids: { messageId: "m-new" }, metadata: null, cancels: true },
    { label: "a new steer from the person", ids: { steerId: "steer-new" }, metadata: null, cancels: true },
    { label: "a delivery update of a known message", ids: { messageId: "m-old" }, metadata: null, cancels: false },
    { label: "a delivery update of a known steer", ids: { steerId: "steer-old", messageId: "m-fresh" }, metadata: null, cancels: false },
    { label: "a scheduled wake", ids: { messageId: "m-wake" }, metadata: { scheduledWake: { id: "wake-1" } }, cancels: false },
    { label: "another agent's relay", ids: { messageId: "m-relay" }, metadata: { agentRelay: { fromSessionId: "chat-2" } }, cancels: false },
  ])("a queued move: $label (cancels: $cancels)", async ({ ids, metadata, cancels }) => {
    const h = createHarness({ turnActive: true, userMessageIds: ["m-old", "steer-old"] });
    const queued = await h.start({ whenTurnEnds: true });
    expect(queued.state).toBe("pending");

    // The host routes only person-authored messages to the orchestrator.
    if (isPersonAuthoredUserMessage(metadata as never)) h.orchestrator.onUserMessage(SESSION, ids);

    if (cancels) {
      expect(h.record()).toMatchObject({ handoffId: queued.handoffId, state: "cancelled" });
      expect(h.notices.map((notice) => notice.state)).toEqual(["cancelled"]);
      h.chat.turnActive = false;
      h.orchestrator.onTurnSettled(SESSION);
      expect(h.prepared).toHaveLength(0);
      expect(h.accepted).toHaveLength(0);
      return;
    }
    expect(h.record()?.state).toBe("pending");
    expect(h.notices).toEqual([]);
    // The turn ends: the move goes.
    h.chat.turnActive = false;
    h.orchestrator.onTurnSettled(SESSION);
    expect(await h.settled()).toMatchObject({ handoffId: queued.handoffId, state: "continued" });
    expect(h.accepted).toHaveLength(1);
  });

  it.each([
    {
      model: "anthropic/claude-fable-5-1",
      level: "auto-edit",
      fields: { claudePermissionMode: "acceptEdits", permissionMode: "edit" },
      label: "auto-accept edits",
    },
    {
      model: "openai/gpt-6.1-sol",
      level: "ask",
      fields: { codexApprovalPolicy: "on-request", codexSandbox: "workspace-write", codexConfigSource: "flags", permissionMode: "default" },
      label: "ask before changes",
    },
    // OpenCode can't auto-accept edits: it steps down to ask, never up.
    { model: "ollama/llama-3.3", level: "auto-edit", fields: { opencodePermissionMode: "edit", permissionMode: "default" }, label: "ask before changes" },
    // An ACP provider (Kimi) that can't auto-accept edits steps down too.
    { model: "moonshot/k3", level: "auto-edit", fields: { acpPermissionMode: "default", permissionMode: "default" }, label: "ask before changes" },
  ])("an agent's move to $model runs at the chat's own $level level, after approval", async ({ model, level, fields, label }) => {
    const h = createHarness({ permissionLevel: level });
    // Everything an agent could ask for to widen its access is dropped.
    const record = await h.start({
      targetModelId: model,
      permissionMode: "full-auto",
      claudePermissionMode: "bypassPermissions",
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      opencodePermissionMode: "full-auto",
      acpPermissionMode: "yolo",
    } as Partial<AgentChatStartCrossMachineHandoffArgs>, "agent");

    expect(record).toMatchObject({ state: "awaiting_approval", requestedBy: "agent", targetPermissionLabel: label });
    expect(h.cards).toEqual([expect.objectContaining({ handoffId: record.handoffId, live: true })]);
    expect(h.cards[0]!.subtitle).toContain(label);
    expect(h.prepared).toHaveLength(0);

    h.orchestrator.resolveApproval(SESSION, record.handoffId, true);
    expect(await h.settled()).toMatchObject({ state: "continued" });
    const sent = h.prepared[0]! as Record<string, unknown>;
    const permissionFields = Object.fromEntries(
      CROSS_MACHINE_PERMISSION_FIELDS.filter((field) => sent[field] !== undefined).map((field) => [field, sent[field]]),
    );
    expect(permissionFields).toEqual(fields);
  });

  it("an agent's queued move rechecks the chat's access before it is sent", async () => {
    // Full-auto let the agent's move through without asking; then the person
    // lowered the chat to ask while the move waited for the turn to end.
    const h = createHarness({ permissionLevel: "full-auto", turnActive: true });
    const queued = await h.start({ whenTurnEnds: true, targetModelId: "anthropic/claude-fable-5-1" }, "agent");
    expect(queued.state).toBe("pending");
    h.chat.permissionLevel = "ask";
    h.chat.turnActive = false;
    h.orchestrator.onTurnSettled(SESSION);
    await vi.waitFor(() => expect(h.record()?.state).toBe("awaiting_approval"));
    expect(h.prepared).toHaveLength(0);
    expect(h.notified.map((record) => record.state)).toContain("awaiting_approval");

    // Approved: it runs at the lower level the chat has now, never the old one.
    h.orchestrator.resolveApproval(SESSION, queued.handoffId, true);
    expect(await h.settled()).toMatchObject({ state: "continued", targetPermissionLabel: "ask before changes" });
    expect(h.prepared[0]).toMatchObject({ claudePermissionMode: "default", permissionMode: "default" });
  });

  it("retries an unknown move by resending the stored capsule under the same id", async () => {
    const h = createHarness();
    h.setAccept(lostAnswer);
    const started = await h.start();
    const lost = await h.settled();
    // The answer was lost after acceptance started: unknown, capsule kept.
    expect(lost).toMatchObject({ handoffId: started.handoffId, state: "unknown" });
    expect(h.hasOutbox(started.handoffId)).toBe(true);

    h.setAccept((capsule) => ({
      handoffId: capsule.handoffId,
      laneId: "lane-there",
      session: { id: "chat-there", laneId: "lane-there", provider: "claude", model: "m" },
      reusedLane: true,
      reusedSession: true,
    }));
    await h.orchestrator.retry(SESSION);
    expect(await h.settled()).toMatchObject({
      handoffId: started.handoffId,
      state: "continued",
      continuedOn: { handoffId: started.handoffId, targetSessionId: "chat-there" },
    });
    expect(h.prepared).toHaveLength(1);
    expect(h.accepted).toHaveLength(2);
    expect(h.accepted[1]).toEqual(h.accepted[0]);
    expect(h.hasOutbox(started.handoffId)).toBe(false);
    expect(h.outcomes).toEqual([
      { handoffId: started.handoffId, outcome: "unknown" },
      { handoffId: started.handoffId, outcome: "continued" },
    ]);
  });

  // A stored capsule exists only once acceptance had started, so the
  // destination may hold the chat even for a `failed` move. A changed source
  // must never be resent, and must never get a new handoffId either: that
  // would bypass the destination's record and could start a second agent.
  it.each(["unknown", "failed"] as const)("refuses a stale %s move and keeps it as it was", async (state) => {
    const h = createHarness();
    const first = await h.start();
    const landed = await h.settled();
    expect(landed?.continuedOn?.handoffId).toBe(first.handoffId);
    h.setAccept(state === "unknown" ? lostAnswer : () => {
      throw new Error("Mac mini refused the move: that capsule doesn't match.");
    });
    const second = await h.start();
    expect(await h.settled()).toMatchObject({ handoffId: second.handoffId, state });
    expect(h.hasOutbox(second.handoffId)).toBe(true);

    h.setValidate(async () => {
      throw new CrossMachineSourceStaleError("The branch moved.");
    });
    await expect(h.orchestrator.retry(SESSION)).rejects.toThrow(/changed after the move was sent/);
    expect(h.record()).toMatchObject({ handoffId: second.handoffId, state });
    expect(h.record()?.continuedOn?.handoffId).toBe(first.handoffId);
    expect(h.hasOutbox(second.handoffId)).toBe(true);
    expect(h.prepared.map((args) => args.handoffId)).toEqual([first.handoffId, second.handoffId]);
    expect(h.accepted).toHaveLength(2);
  });

  it.each(["unknown", "failed"] as const)(
    "a %s move whose source check itself fails is left exactly as it was",
    async (state) => {
      const h = createHarness();
      h.setAccept(state === "unknown" ? lostAnswer : () => {
        throw new Error("Mac mini refused the move.");
      });
      const started = await h.start();
      const before = await h.settled();
      expect(before?.state).toBe(state);

      h.setValidate(async () => {
        throw new Error("git timed out reading the lane");
      });
      await expect(h.orchestrator.retry(SESSION)).rejects.toThrow(/Couldn't check the chat before retrying/);
      expect(h.record()).toEqual(before);
      expect(h.hasOutbox(started.handoffId)).toBe(true);
      expect(h.prepared).toHaveLength(1);
      expect(h.accepted).toHaveLength(1);
    },
  );

  it.each([
    { label: "a lost answer", setup: (h: ReturnType<typeof createHarness>) => h.setAccept(lostAnswer), state: "unknown", outbox: true, accepts: 1 },
    {
      label: "the destination's refusal",
      setup: (h: ReturnType<typeof createHarness>) => h.setAccept(() => {
        throw new Error("Mac mini refused the move: the model isn't signed in there.");
      }),
      state: "failed",
      outbox: true,
      accepts: 1,
    },
    {
      label: "an answer ADE can't read",
      setup: (h: ReturnType<typeof createHarness>) => h.setAccept(() => ({ ok: true })),
      state: "unknown",
      outbox: true,
      accepts: 1,
    },
    {
      label: "a preflight blocker (before acceptance)",
      setup: (h: ReturnType<typeof createHarness>) => h.setPreflight(() => ({
        providerAuthorized: false,
        modelAvailable: true,
        remoteBranchHeadSha: null,
        existingLaneId: null,
        blockingErrors: ["Sign in to Claude on Mac mini."],
        warnings: [],
      })),
      state: "failed",
      outbox: false,
      accepts: 0,
    },
  ])("$label ends the move $state", async ({ setup, state, outbox, accepts }) => {
    const h = createHarness();
    setup(h);
    const started = await h.start();
    const ended = await h.settled();
    expect(ended).toMatchObject({ handoffId: started.handoffId, state, continuedOn: null });
    expect(h.hasOutbox(started.handoffId)).toBe(outbox);
    expect(h.accepted).toHaveLength(accepts);
    expect(h.notices.map((notice) => notice.state)).toEqual([state]);
    expect(h.outcomes).toEqual([{ handoffId: started.handoffId, outcome: state }]);
  });

  // A move that may have landed: its answer was lost, or it failed after
  // acceptance started (the destination can fail after the chat began).
  it.each([
    ["unknown", lostAnswer],
    ["failed after acceptance", () => {
      throw new Error("Mac mini refused the move: the destination failed after it started.");
    }],
  ] as const)("a %s move blocks a new one until dismissed, and one chat moves once at a time", async (_label, accept) => {
    const h = createHarness();
    h.setAccept(accept);
    const lost = await h.start();
    await h.settled();
    expect(h.hasOutbox(lost.handoffId)).toBe(true);

    await expect(h.start()).rejects.toThrow(/may have landed/);
    const options = await h.orchestrator.getOptions(SESSION);
    expect(options.blockers.map((blocker) => blocker.id)).toContain("move_unknown");

    const dismissed = h.orchestrator.cancel(SESSION);
    expect(dismissed).toMatchObject({ handoffId: lost.handoffId, state: "cancelled" });
    expect(h.hasOutbox(lost.handoffId)).toBe(false);
    // Dismissed, nothing blocks a new move.
    expect((await h.orchestrator.getOptions(SESSION)).blockers.map((blocker) => blocker.id)).not.toContain("move_unknown");

    // Two starts racing on one chat: exactly one wins.
    h.chat.turnActive = true;
    const results = await Promise.allSettled([h.start({ whenTurnEnds: true }), h.start({ whenTurnEnds: true })]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/already moving/);
    const winner = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<AgentChatCrossMachineHandoffRecord>;
    expect(h.record()).toMatchObject({ handoffId: winner.value.handoffId, state: "pending" });
  });

  it("a chat deleted mid-move keeps no move, no capsule, and tells no one", async () => {
    const h = createHarness();
    // The real source check refuses a chat that no longer exists.
    h.setValidate(async () => {
      if (!h.chat.exists) throw new Error("The source chat could not be loaded.");
    });
    // The chat is deleted while the destination is being checked.
    h.setPreflight(() => {
      h.chat.exists = false;
      return { ...READY_PREFLIGHT };
    });
    const started = await h.start({}, "agent");
    expect(started.state).toBe("sending");
    expect(await h.settled()).toBeNull();
    expect(h.hasOutbox(started.handoffId)).toBe(false);
    expect(h.accepted).toHaveLength(0);
    expect(h.notices).toEqual([]);
    expect(h.notified).toEqual([]);
    expect(h.outcomes).toEqual([]);

    // A move saved for a chat that is gone by the next start is dropped, never run.
    const sweep = createHarness();
    const persisted: CrossMachineHandoffPersisted = {
      record: { ...started, state: "sending", handoffId: "handoff-orphan" },
      request: {
        targetModelId: "anthropic/claude-fable-5-1",
        machine: "mk-mini",
        mode: "brief",
        continuationPrompt: null,
        includeChanges: false,
        clone: false,
      },
    };
    sweep.store.writeMove(SESSION, persisted);
    sweep.store.outbox.write("handoff-orphan", { capsule: { handoffId: "handoff-orphan" } as never, capsuleFingerprint: "fp" });
    sweep.chat.exists = false;
    sweep.orchestrator.sweep();
    expect(sweep.store.readMove(SESSION)).toBeNull();
    expect(sweep.hasOutbox("handoff-orphan")).toBe(false);
    expect(sweep.prepared).toHaveLength(0);
  });
});

// ── The git bundle, on real repositories ─────────────────────────────────────

const savedGitEnv: Record<string, string | undefined> = {};
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

beforeAll(() => {
  // Isolate from the developer's git config (signing, hooks, LFS filters).
  const globalConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-cm-gitconfig-")), "gitconfig");
  fs.writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n");
  for (const [key, value] of Object.entries({ ...GIT_ENV, GIT_CONFIG_GLOBAL: globalConfig })) {
    savedGitEnv[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedGitEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

/** A bare origin and a clone on `feature` (published), with a main base commit. */
function makeRepos() {
  const root = makeTempDir("ade-cm-bundle-");
  const origin = path.join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", origin);
  const source = path.join(root, "source");
  git(root, "clone", "--quiet", origin, source);
  fs.writeFileSync(path.join(source, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(source, "edit.txt"), "one\n");
  fs.writeFileSync(path.join(source, "gone.txt"), "bye\n");
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "base");
  git(source, "push", "--quiet", "origin", "HEAD:main");
  git(source, "checkout", "--quiet", "-b", "feature");
  git(source, "push", "--quiet", "-u", "origin", "feature");
  const clone = (name: string) => {
    const dir = path.join(root, name);
    git(root, "clone", "--quiet", origin, dir);
    return dir;
  };
  return { root, origin, source, clone };
}

/** Everything about a repo that packing must not change. */
function repoState(cwd: string) {
  return {
    head: git(cwd, "rev-parse", "HEAD"),
    refs: git(cwd, "for-each-ref", "--format=%(refname) %(objectname)"),
    index: git(cwd, "ls-files", "--stage"),
    status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"),
  };
}

/** Packs with its temp dirs in a private TMPDIR, returning what was left there. */
async function packIsolated(args: Parameters<typeof packHandoffGitBundle>[0]) {
  const tmp = makeTempDir("ade-cm-tmp-");
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    const bundle = await packHandoffGitBundle(args).catch((error: unknown) => error as Error);
    return { bundle, leftovers: fs.readdirSync(tmp) };
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

describe("handoff git bundle", () => {
  it("refuses arriving commits that would overwrite an ignored file in the destination lane", async () => {
    const { source, clone } = makeRepos();
    fs.writeFileSync(path.join(source, ".env"), "SOURCE=1\n");
    git(source, "add", "-f", ".env");
    git(source, "commit", "--quiet", "-m", "track the env file");
    const bundle = await packHandoffGitBundle({ worktreePath: source, branchRef: "feature", handoffId: "handoff:ignored-1" });
    if (!bundle) throw new Error("an unpushed commit must pack");

    const destination = clone("ignored-destination");
    const lanePath = path.join(path.dirname(destination), "ignored-lane");
    git(destination, "worktree", "add", "--quiet", "-b", "feature", lanePath, "origin/feature");
    fs.writeFileSync(path.join(lanePath, ".env"), "LOCAL_SECRET=1\n");
    const before = repoState(lanePath);

    await expect(applyHandoffGitBundle({
      projectRoot: destination,
      handoffId: "handoff:ignored-1",
      branchRef: "feature",
      bundle,
      target: { kind: "existing_worktree", worktreePath: lanePath },
    })).rejects.toThrow(/already has '\.env'/);
    expect(fs.readFileSync(path.join(lanePath, ".env"), "utf8")).toBe("LOCAL_SECRET=1\n");
    expect(repoState(lanePath)).toEqual(before);
  });

  // Git replaces a tracked directory the commits turn into a file; an ignored
  // local file inside it would be deleted, so that case refuses.
  it.each([
    { label: "replaces a tracked directory with a file", localFile: false },
    { label: "refuses when that directory holds an ignored local file", localFile: true },
  ])("arriving commits: $label", async ({ localFile }) => {
    const { source, clone } = makeRepos();
    git(source, "checkout", "--quiet", "-b", "dir-to-file");
    fs.mkdirSync(path.join(source, "config"));
    fs.writeFileSync(path.join(source, "config", "settings.json"), "{}\n");
    fs.writeFileSync(path.join(source, ".gitignore"), ".env\nconfig/local.json\n");
    git(source, "add", "-A");
    git(source, "commit", "--quiet", "-m", "config dir");
    git(source, "push", "--quiet", "-u", "origin", "dir-to-file");
    // Unpushed: the directory becomes a file.
    git(source, "rm", "--quiet", "-r", "config");
    fs.writeFileSync(path.join(source, "config"), "now a file\n");
    git(source, "add", "config");
    git(source, "commit", "--quiet", "-m", "config file");
    const bundle = await packHandoffGitBundle({ worktreePath: source, branchRef: "dir-to-file", handoffId: "handoff:dir-1" });
    if (!bundle) throw new Error("an unpushed commit must pack");

    const destination = clone("dir-destination");
    const lanePath = path.join(path.dirname(destination), "dir-lane");
    git(destination, "worktree", "add", "--quiet", "-b", "dir-to-file", lanePath, "origin/dir-to-file");
    if (localFile) fs.writeFileSync(path.join(lanePath, "config", "local.json"), "LOCAL=1\n");
    const before = repoState(lanePath);
    const landing = applyHandoffGitBundle({
      projectRoot: destination,
      handoffId: "handoff:dir-1",
      branchRef: "dir-to-file",
      bundle,
      target: { kind: "existing_worktree", worktreePath: lanePath },
    });
    if (localFile) {
      await expect(landing).rejects.toThrow(/already has 'config'/);
      expect(fs.readFileSync(path.join(lanePath, "config", "local.json"), "utf8")).toBe("LOCAL=1\n");
      expect(repoState(lanePath)).toEqual(before);
      return;
    }
    await landing;
    expect(fs.readFileSync(path.join(lanePath, "config"), "utf8")).toBe("now a file\n");
    expect(git(lanePath, "rev-parse", "HEAD")).toBe(git(source, "rev-parse", "HEAD"));
    expect(git(lanePath, "status", "--porcelain=v1")).toBe("");
  });

  it("lands one move at a time into a destination lane, so a second can't undo the first", async () => {
    const { source, clone } = makeRepos();
    const other = clone("other-source");
    git(other, "checkout", "--quiet", "-b", "feature", "origin/feature");
    fs.writeFileSync(path.join(source, "edit.txt"), "from the first move\n");
    fs.writeFileSync(path.join(other, "edit.txt"), "from the second move\n");
    const first = await packHandoffGitBundle({ worktreePath: source, branchRef: "feature", handoffId: "handoff:race-1" });
    const second = await packHandoffGitBundle({ worktreePath: other, branchRef: "feature", handoffId: "handoff:race-2" });
    if (!first || !second) throw new Error("both dirty lanes must pack");

    const destination = clone("race-destination");
    const lanePath = path.join(path.dirname(destination), "race-lane");
    git(destination, "worktree", "add", "--quiet", "-b", "feature", lanePath, "origin/feature");
    const lane = { id: "lane-race", worktreePath: lanePath, laneType: "worktree" };
    const capsuleFor = (gitBundle: typeof first) =>
      ({ gitBundle, source: { laneName: "feature", machineName: "MacBook" } }) as unknown as AgentChatCrossMachineHandoffCapsule;
    const land = (handoffId: string, gitBundle: typeof first, onLaneImported: () => void) => landHandoffGitBundle({
      projectRoot: destination,
      capsule: capsuleFor(gitBundle),
      handoffId,
      branchRef: "feature",
      existingLane: lane,
      importLane: async () => {
        throw new Error("the lane exists");
      },
      deleteLane: async () => {},
      onLaneImported,
    });

    const events: string[] = [];
    let secondRun: Promise<unknown> | null = null;
    const firstRun = land("handoff:race-1", first, () => {
      events.push("first bound");
      // The second move arrives while the first is landing.
      secondRun = land("handoff:race-2", second, () => events.push("second bound")).catch((error: Error) => {
        events.push("second refused");
        return error;
      });
    });
    await firstRun;
    events.push("first landed");
    await secondRun;

    // The second never touched the lane before the first finished, and the
    // first move's arriving change survived the second's refusal.
    expect(events.indexOf("first landed")).toBeLessThan(events.indexOf("second bound"));
    expect(events).toContain("second refused");
    expect(fs.readFileSync(path.join(lanePath, "edit.txt"), "utf8")).toBe("from the first move\n");
  });

  it("carries unpushed commits and every working-tree change, unstaged, without touching the source", async () => {
    const { source, clone } = makeRepos();
    fs.writeFileSync(path.join(source, "committed.txt"), "unpushed\n");
    git(source, "add", "committed.txt");
    git(source, "commit", "--quiet", "-m", "unpushed work");
    fs.writeFileSync(path.join(source, "edit.txt"), "one\ntwo\n");
    git(source, "add", "edit.txt"); // staged on the source; must arrive unstaged
    fs.writeFileSync(path.join(source, "edit.txt"), "one\ntwo\nthree\n");
    fs.rmSync(path.join(source, "gone.txt"));
    fs.writeFileSync(path.join(source, "new.txt"), "fresh\n");
    fs.writeFileSync(path.join(source, ".env"), "SECRET=1\n");
    const before = repoState(source);

    const { bundle, leftovers } = await packIsolated({ worktreePath: source, branchRef: "feature", handoffId: "handoff:rt-1" });
    if (!bundle || bundle instanceof Error) throw bundle ?? new Error("no bundle for a dirty, unpushed lane");
    expect(bundle).toMatchObject({ branchHeadSha: before.head, unpushedCommitCount: 1, changedFileCount: 3 });
    expect(repoState(source)).toEqual(before);
    expect(leftovers).toEqual([]);

    // A destination where `feature` has a commit the handoff lacks: refused, untouched.
    const diverged = clone("diverged");
    git(diverged, "checkout", "--quiet", "-b", "feature", "origin/feature");
    fs.writeFileSync(path.join(diverged, "theirs.txt"), "theirs\n");
    git(diverged, "add", "theirs.txt");
    git(diverged, "commit", "--quiet", "-m", "theirs");
    git(diverged, "checkout", "--quiet", "main");
    const divergedBefore = repoState(diverged);
    let attached = false;
    await expect(applyHandoffGitBundle({
      projectRoot: diverged,
      handoffId: "handoff:rt-1",
      branchRef: "feature",
      bundle,
      target: { kind: "attach", attach: async () => { attached = true; throw new Error("must not attach"); } },
    })).rejects.toThrow(/has commits the handed-off work lacks/);
    expect(attached).toBe(false);
    expect(repoState(diverged)).toEqual(divergedBefore);

    // A clean destination: the branch arrives at the tip, the edits uncommitted.
    const destination = clone("destination");
    const lanePath = path.join(path.dirname(destination), "destination-lane");
    await applyHandoffGitBundle({
      projectRoot: destination,
      handoffId: "handoff:rt-1",
      branchRef: "feature",
      bundle,
      target: {
        kind: "attach",
        attach: async (branch) => {
          git(destination, "worktree", "add", "--quiet", lanePath, branch);
          return { worktreePath: lanePath, undo: async () => { git(destination, "worktree", "remove", "--force", lanePath); } };
        },
      },
    });
    expect(git(lanePath, "rev-parse", "HEAD")).toBe(before.head);
    expect(fs.readFileSync(path.join(lanePath, "edit.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(fs.readFileSync(path.join(lanePath, "committed.txt"), "utf8")).toBe("unpushed\n");
    expect(fs.existsSync(path.join(lanePath, "gone.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(lanePath, "new.txt"), "utf8")).toBe("fresh\n");
    expect(fs.existsSync(path.join(lanePath, ".env"))).toBe(false);
    expect(git(lanePath, "diff", "--cached", "--name-only")).toBe("");
    expect(git(lanePath, "status", "--porcelain=v1", "--untracked-files=all").split("\n").sort())
      .toEqual([" D gone.txt", " M edit.txt", "?? new.txt"]);
    expect(git(destination, "for-each-ref", "refs/ade-handoff")).toBe("");
  });

  it.each([
    {
      label: "a branch that diverged from origin",
      message: /has commits this lane doesn't/,
      setup: (source: string, clone: (name: string) => string) => {
        const other = clone("other");
        git(other, "checkout", "--quiet", "feature");
        fs.writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
        git(other, "add", "theirs.txt");
        git(other, "commit", "--quiet", "-m", "theirs");
        git(other, "push", "--quiet", "origin", "feature");
        fs.writeFileSync(path.join(source, "mine.txt"), "mine\n");
        git(source, "add", "mine.txt");
        git(source, "commit", "--quiet", "-m", "mine");
        git(source, "fetch", "--quiet", "origin");
      },
    },
    {
      label: "an LFS file in the uncommitted snapshot",
      message: /Git LFS files can't travel/,
      setup: (source: string) => {
        fs.writeFileSync(path.join(source, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
        git(source, "add", ".gitattributes");
        git(source, "commit", "--quiet", "-m", "lfs");
        git(source, "push", "--quiet");
        fs.writeFileSync(path.join(source, "model.bin"), "weights");
      },
    },
    {
      label: "an LFS file in an unpushed commit",
      message: /Git LFS files can't travel/,
      setup: (source: string) => {
        fs.writeFileSync(path.join(source, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
        fs.writeFileSync(path.join(source, "model.bin"), "weights");
        git(source, "add", "-A");
        git(source, "commit", "--quiet", "-m", "lfs file");
      },
    },
    {
      label: "a submodule bump in the uncommitted snapshot",
      message: /Submodule changes can't travel/,
      setup: (source: string) => {
        git(source, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor`);
        git(source, "commit", "--quiet", "-m", "submodule");
        git(source, "push", "--quiet");
        fs.mkdirSync(path.join(source, "vendor"));
        git(source, "update-index", "--cacheinfo", `160000,${"2".repeat(40)},vendor`);
      },
    },
    {
      label: "a submodule bump in an unpushed commit",
      message: /Submodule changes can't travel/,
      setup: (source: string) => {
        git(source, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor`);
        git(source, "commit", "--quiet", "-m", "submodule");
        fs.mkdirSync(path.join(source, "vendor"));
      },
    },
    {
      label: "changes over the transport cap",
      message: /Push the branch, then hand off again/,
      maxEncodedBytes: 16,
      setup: (source: string) => {
        fs.writeFileSync(path.join(source, "edit.txt"), "one\nchanged\n");
      },
    },
  ])("refuses $label and leaves the source as it was", async ({ setup, message, maxEncodedBytes }) => {
    const { source, clone } = makeRepos();
    setup(source, clone);
    const before = repoState(source);

    const { bundle, leftovers } = await packIsolated({
      worktreePath: source,
      branchRef: "feature",
      handoffId: "handoff:refused",
      ...(maxEncodedBytes ? { maxEncodedBytes } : {}),
    });

    expect(bundle).toBeInstanceOf(Error);
    expect((bundle as Error).message).toMatch(message);
    expect(repoState(source)).toEqual(before);
    expect(git(source, "for-each-ref", "refs/ade-handoff")).toBe("");
    expect(leftovers).toEqual([]);
  });
});
