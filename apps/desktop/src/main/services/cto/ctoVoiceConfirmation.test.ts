import { describe, expect, it, vi } from "vitest";
import {
  buildConfirmation,
  classifySpokenReply,
  resolveSpokenConfirmation,
} from "./ctoVoiceConfirmation";
import type { CtoVoiceApprovalNotice } from "./ctoVoiceCallService";
import { askCto, createService, hearMic, openCall, spoken, tick, utter } from "./ctoVoiceCallHarness";

import {
  describeVoiceApproval,
  isDestructiveVoiceCommand,
} from "../../../shared/types/ctoVoiceDestructive";

const NOW = 1_000_000;

function pending(overrides: Partial<ReturnType<typeof buildConfirmation>> = {}) {
  return {
    ...buildConfirmation({
      id: "c1",
      toolName: "openPr",
      prompt: "Open a pull request?",
      utteranceId: "u1",
      nowMs: NOW,
    }),
    ...overrides,
  };
}

describe("classifySpokenReply", () => {
  it("reads the ordinary affirmatives", () => {
    for (const phrase of ["yes", "Yeah.", "go ahead", "sure!", "do it", "sounds good"]) {
      expect(classifySpokenReply(phrase)).toBe("approve");
    }
  });

  /**
   * The worst possible failure is reading a refusal as consent. "no, don't do
   * it" contains "do it", so negatives must win outright.
   */
  it("never reads a refusal as consent", () => {
    for (const phrase of ["no", "no, don't do it", "wait", "hold on", "stop", "not now"]) {
      expect(classifySpokenReply(phrase)).toBe("deny");
    }
  });

  it("stays out of the way when there is no decision", () => {
    expect(classifySpokenReply("what would that change?")).toBe("none");
    expect(classifySpokenReply("")).toBe("none");
    // "yesterday" must not match "yes".
    expect(classifySpokenReply("what merged yesterday")).toBe("none");
  });
});

describe("resolveSpokenConfirmation", () => {
  it("approves a plain yes to a pending question", () => {
    expect(
      resolveSpokenConfirmation({ confirmation: pending(), utteranceId: "u2", text: "yes", nowMs: NOW + 2_000 }),
    ).toEqual({ kind: "approved" });
  });

  /** A misheard word must not be able to destroy history. */
  it("refuses to approve anything destructive by voice", () => {
    const outcome = resolveSpokenConfirmation({
      confirmation: pending({ toolName: "gitForcePush", destructive: true }),
      utteranceId: "u2",
      text: "yes",
      nowMs: NOW + 2_000,
    });
    expect(outcome).toEqual({ kind: "ignored", reason: "destructive actions need a tap" });
  });

  /**
   * Without this, "force-push it" would raise the question and answer it in the
   * same breath.
   */
  it("does not let the utterance that raised the question answer it", () => {
    const outcome = resolveSpokenConfirmation({
      confirmation: pending({ utteranceId: "u1" }),
      utteranceId: "u1",
      text: "yes do it",
      nowMs: NOW + 500,
    });
    expect(outcome.kind).toBe("ignored");
  });

  it("expires, so a yes much later does not land on a stale question", () => {
    const confirmation = pending();
    const outcome = resolveSpokenConfirmation({
      confirmation,
      utteranceId: "u2",
      text: "yes",
      nowMs: confirmation.expiresAtMs + 1,
    });
    expect(outcome).toEqual({ kind: "ignored", reason: "the question has expired" });
  });

  it("carries a spoken no straight through as a denial", () => {
    expect(
      resolveSpokenConfirmation({ confirmation: pending(), utteranceId: "u2", text: "no, not now", nowMs: NOW + 100 }),
    ).toEqual({ kind: "denied" });
  });

  it("ignores everything when nothing is pending", () => {
    expect(
      resolveSpokenConfirmation({ confirmation: null, utteranceId: "u2", text: "yes", nowMs: NOW }),
    ).toEqual({ kind: "ignored", reason: "nothing pending" });
  });
});

describe("buildConfirmation", () => {
  it("marks the history/remote/delete class destructive and everything else not", () => {
    expect(buildConfirmation({ id: "a", toolName: "gitPush", prompt: "", utteranceId: null, nowMs: NOW }).destructive).toBe(true);
    expect(buildConfirmation({ id: "b", toolName: "mergePr", prompt: "", utteranceId: null, nowMs: NOW }).destructive).toBe(true);
    expect(buildConfirmation({ id: "c", toolName: "spawnChat", prompt: "", utteranceId: null, nowMs: NOW }).destructive).toBe(false);
    expect(buildConfirmation({ id: "d", toolName: "gitCommit", prompt: "", utteranceId: null, nowMs: NOW }).destructive).toBe(false);
  });
});

/**
 * The gate that decides whether a spoken "yes" is enough.
 *
 * Every case below is a REAL provider event shape, because that is the whole
 * difficulty: `detail` is an object and differs per provider, and the command —
 * the only thing that says "force-push" — is somewhere different in each.
 */

/** What `canUseTool` emits for a Claude bash approval (agentChatService). */
function claudeCommandApproval(command: string) {
  return {
    kind: "command",
    description: `Run command: ${command}`,
    detail: { tool: "Bash" },
  };
}

describe("describeVoiceApproval", () => {
  it("names the tool from structured detail, not from the sentence", () => {
    expect(describeVoiceApproval(claudeCommandApproval("git status")).toolName).toBe("Bash");
    expect(describeVoiceApproval({
      kind: "file_change",
      description: "Write file: /repo/src/index.ts",
      detail: { tool: "Write" },
    }).toolName).toBe("Write");
  });

  it("treats a force-push as destructive even though nothing names an ADE operation", () => {
    const described = describeVoiceApproval(claudeCommandApproval("git push --force origin main"));
    expect(described.toolName).toBe("Bash");
    expect(described.destructive).toBe(true);
  });

  it("lets a plain read through, so a call is not one long tapping exercise", () => {
    expect(describeVoiceApproval(claudeCommandApproval("git status")).destructive).toBe(false);
    expect(describeVoiceApproval(claudeCommandApproval("npm test")).destructive).toBe(false);
    expect(describeVoiceApproval({
      kind: "file_change",
      description: "Edit file: /repo/README.md",
      detail: { tool: "Edit" },
    }).destructive).toBe(false);
  });

  it("reads Codex's shape, where the command is one level shallower", () => {
    // Codex puts the command on `detail.command` and in provider metadata, and
    // its description is the model's own `reason` whenever it gave one — so the
    // description alone says nothing about what is about to run.
    const destructive = describeVoiceApproval({
      kind: "command",
      description: "Push",
      detail: {
        additionalPermissions: null,
        command: "git push --force origin main",
        cwd: "/repo",
        reason: "Push",
      },
    });
    expect(destructive.destructive).toBe(true);

    const harmless = describeVoiceApproval({
      kind: "command",
      description: "Run tests",
      detail: { additionalPermissions: null, command: "npm test", cwd: "/repo", reason: "Run tests" },
    });
    expect(harmless.destructive).toBe(false);
  });

  it("finds a Codex command that only reached provider metadata", () => {
    expect(describeVoiceApproval({
      kind: "command",
      description: "Clean up",
      detail: { request: { providerMetadata: { command: "rm -rf build", cwd: "/repo" } } },
    }).destructive).toBe(true);
  });

  it("makes an ACP approval need a tap, because nothing in it can be read", () => {
    // ACP (Qwen, Kimi, Copilot) carries `{ acp, provider }` and a description
    // that is the tool's TITLE, never the command — and an ACP host only asks
    // when it needs permission to change something. An unreadable mutation is
    // exactly what this gate exists for.
    expect(describeVoiceApproval({
      kind: "tool_call",
      description: "Run shell command",
      detail: { acp: true, provider: "qwen" },
    }).destructive).toBe(true);
  });

  it("reads Droid's shape, where the tool hides under `hook`", () => {
    const described = describeVoiceApproval({
      kind: "tool_call",
      description: "Droid wants to run a command",
      detail: {
        droidSdk: true,
        request: { requestId: "r1" },
        hook: { toolName: "run_terminal_cmd", toolInput: { command: "rm -rf build" } },
      },
    });
    expect(described.toolName).toBe("run_terminal_cmd");
    expect(described.destructive).toBe(true);
  });

  it("reads Cursor's shape, and keeps a harmless one harmless", () => {
    const described = describeVoiceApproval({
      kind: "tool_call",
      description: "Cursor SDK permission required",
      detail: {
        cursorSdk: true,
        request: { requestId: "r2", tool: "readFile" },
        hook: { toolInput: { path: "/repo/src/index.ts" } },
        policy: "ask",
      },
    });
    expect(described.toolName).toBe("readFile");
    expect(described.destructive).toBe(false);
  });

  it("falls back to `kind` when a provider says nothing better", () => {
    expect(describeVoiceApproval({ kind: "tool_call", description: "Go ahead?" }).toolName)
      .toBe("tool_call");
  });

  it("still honours the ADE operation list when a tool IS named", () => {
    expect(describeVoiceApproval({
      kind: "tool_call",
      description: "Merge the pull request",
      detail: { tool: "mergePr" },
    }).destructive).toBe(true);
  });
});

describe("isDestructiveVoiceCommand", () => {
  it("catches the shapes whose blast radius is other people's work", () => {
    for (const command of [
      "git push --force origin main",
      "git push -f",
      "git push --force-with-lease origin main",
      "git reset --hard HEAD~3",
      "git branch -D feature/x",
      "git clean -fd",
      "git checkout -- src/index.ts",
      "git restore src/index.ts",
      "git stash drop",
      "rm -rf node_modules",
      "gh pr merge 42",
      "gh release create v1.0.0",
      "npm publish",
    ]) {
      expect(isDestructiveVoiceCommand(command), command).toBe(true);
    }
  });

  it("does not fire on the day-to-day", () => {
    for (const command of [
      "git status",
      "git push origin main",
      "git log --oneline -20",
      "npm test",
      "ls -la",
      "cat README.md",
      "",
    ]) {
      expect(isDestructiveVoiceCommand(command), command).toBe(false);
    }
  });

  it("catches an ADE action reached through the agent tool", () => {
    expect(isDestructiveVoiceCommand(
      'mcp__ade__run_ade_action {"domain":"lane","action":"delete","args":{"laneId":"l1"}}',
    )).toBe(true);
    expect(isDestructiveVoiceCommand(
      'mcp__ade__run_ade_action {"domain":"lane","action":"list"}',
    )).toBe(false);
  });
});

/**
 * The whole point of the call being able to act.
 *
 * The CTO's turn parks inside `canUseTool` when it reaches a tool that
 * writes. Nothing comes back through `runBackendTurn` to say so, so the call
 * learns about it from the chat's own approval event — and a spoken yes has
 * to reach that waiter, or the user hears "doing that now" and nothing runs.
 */
describe("acting on a call", () => {
  function createCallWithApprovals(
    overrides: Parameters<typeof createService>[0] = {},
  ) {
    // The service's own notice type, so a field added to an approval breaks
    // these tests rather than being quietly dropped by a narrower shape.
    let raise: ((notice: CtoVoiceApprovalNotice) => void) | null = null;
    const resolved: Array<{ itemId: string; approved: boolean }> = [];
    let watcherReleased = false;
    const harness = createService({
      watchApprovals: (onApproval) => {
        raise = onApproval;
        return () => { watcherReleased = true; };
      },
      resolveApproval: async (args) => { resolved.push(args); },
      ...overrides,
    });
    return {
      ...harness,
      resolved,
      raise: (notice: CtoVoiceApprovalNotice) => raise?.(notice),
      wasWatcherReleased: () => watcherReleased,
    };
  }

  it("asks out loud, then lets the blocked turn through on a spoken yes", async () => {
    // The real sequence: the turn is still running — parked inside
    // `canUseTool` — when the approval is raised, so it has not returned an
    // answer and the question is the only thing ADE has said.
    let releaseBackend: () => void = () => {};
    const harness = createCallWithApprovals({
      runBackendTurn: async () => {
        await new Promise<void>((resolve) => { releaseBackend = resolve; });
        return { spoken: "Opened it." };
      },
    });
    await openCall(harness);
    askCto(harness, "open a pr for the sync lane");
    await tick();

    harness.raise({ itemId: "item-1", toolName: "openPr", prompt: "Open a pull request for ade/sync-fix?" });
    expect(harness.latest().phase).toBe("confirming");
    expect(harness.latest().pendingConfirmation?.prompt).toContain("pull request");
    // The user has to HEAR the question, not find it in the chat.
    expect(spoken(harness.fake).join("\n")).toContain("pull request");

    utter(harness, "yes");
    await tick();

    expect(harness.latest().pendingConfirmation).toBeNull();
    expect(harness.resolved).toEqual([{ itemId: "item-1", approved: true }]);
    releaseBackend();
  });

  /**
   * Answering out loud while the CTO is still reading the question is the
   * ordinary case, not an edge one. The audio has to stop — but the turn
   * behind it is the one parked on this very approval, and aborting it would
   * kill the work the "yes" exists to release.
   */
  it("does not abandon the parked turn when the user answers over the question", async () => {
    const seenSignal: { current: AbortSignal | null } = { current: null };
    let releaseBackend: () => void = () => {};
    const harness = createCallWithApprovals({
      runBackendTurn: async ({ signal }: { signal: AbortSignal }) => {
        seenSignal.current = signal;
        await new Promise<void>((resolve) => { releaseBackend = resolve; });
        return { spoken: "Opened it." };
      },
    });
    await openCall(harness);
    askCto(harness, "open a pr for the sync lane");
    await tick();

    harness.raise({ itemId: "item-9", toolName: "openPr", prompt: "Open a pull request?" });
    harness.fake.receive({ type: "response.created", response: { id: "resp_q" } });

    // Talking over the question: the audio stops, the card stays, the turn lives.
    harness.fake.receive({ type: "input_audio_buffer.speech_started" });
    expect(harness.fake.typesSent()).toContain("response.cancel");
    expect(seenSignal.current?.aborted).toBe(false);
    expect(harness.latest().phase).toBe("confirming");
    expect(harness.latest().pendingConfirmation?.id).toBeTruthy();

    // Spoken over ADE's own voice and still accepted: a segment that carries
    // real energy is a barge-in, not the microphone hearing the CTO.
    hearMic(harness);
    harness.fake.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "yes",
    });
    await tick();
    expect(harness.resolved).toEqual([{ itemId: "item-9", approved: true }]);
    releaseBackend();
  });

  it("turns the tool away on a spoken no", async () => {
    const harness = createCallWithApprovals();
    await openCall(harness);
    utter(harness, "clean up the branch");
    await tick();

    harness.raise({ itemId: "item-2", toolName: "openPr", prompt: "Open a pull request?" });
    utter(harness, "no, don't");
    await tick();

    expect(harness.latest().pendingConfirmation).toBeNull();
    expect(harness.resolved).toEqual([{ itemId: "item-2", approved: false }]);
  });

  it("will not let a voice approve a force-push, however clearly it is said", async () => {
    const harness = createCallWithApprovals();
    await openCall(harness);
    utter(harness, "force push it");
    await tick();

    harness.raise({ itemId: "item-3", toolName: "gitForcePush", prompt: "Force-push ade/sync-fix?" });
    expect(harness.latest().pendingConfirmation?.destructive).toBe(true);

    utter(harness, "yes do it");
    await tick();

    // Still waiting on a tap, and nothing was released.
    expect(harness.latest().pendingConfirmation?.id).toBeTruthy();
    expect(harness.resolved).toEqual([]);

    // The card is the only way through.
    harness.service.approve(harness.latest().pendingConfirmation!.id);
    await tick();
    expect(harness.resolved).toEqual([{ itemId: "item-3", approved: true }]);
  });

  it("stops watching the chat when the call ends", async () => {
    const harness = createCallWithApprovals();
    await openCall(harness);
    expect(harness.wasWatcherReleased()).toBe(false);
    await harness.service.end();
    expect(harness.wasWatcherReleased()).toBe(true);
  });
});

it("marks a history-rewriting tool destructive, so voice cannot approve it", async () => {
  const harness = createService();
  await openCall(harness);
  harness.fake.receive({ type: "input_audio_buffer.speech_started" });
  harness.service.raiseApproval({ itemId: "item-1", toolName: "gitForcePush", prompt: "Force-push ade/sync-fix?" });
  expect(harness.latest().pendingConfirmation?.destructive).toBe(true);
});


it("restores the CTO's mode when the call is ended before its socket opens", async () => {
  // The renderer opens the microphone as soon as the phase is `connecting`,
  // and a denied microphone hangs up immediately. Tearing down on the socket
  // alone missed that window and left the CTO unable to write for the life of
  // the process.
  const readOnly: boolean[] = [];
  const { service, fake } = createService({
    setCallConfirmMode: async (value: boolean) => { readOnly.push(value); },
  });
  await service.start();
  // No `fake.open()`: the socket exists but has never opened.
  await service.end();
  expect(readOnly).toEqual([true, false]);
  fake.open();
});

it("refuses to open a socket for a call that was ended while connecting", async () => {
  let ended = false;
  const { service } = createService({
    setCallConfirmMode: async (value: boolean) => {
      // Hang up from inside the await `start` is blocked on.
      if (value && !ended) { ended = true; await service.end(); }
    },
  });
  const result = await service.start();
  expect(result.ok).toBe(false);
});

it("writes the call down even when nothing else went right", async () => {
  const persistCall = vi.fn<[{ captions: unknown[] }], Promise<void>>(async () => {});
  const harness = createService({ persistCall });
  await openCall(harness);
  utter(harness, "hello");
  await harness.service.end();
  expect(persistCall).toHaveBeenCalledTimes(1);
  expect(persistCall.mock.calls[0]?.[0]?.captions.length).toBe(1);
});

it("captions what the CTO said from the response transcript", async () => {
  const harness = createService();
  await openCall(harness);
  harness.fake.receive({ type: "response.output_audio_transcript.delta", delta: "Three" });
  expect(harness.latest().phase).toBe("speaking");
  harness.fake.receive({
    type: "response.output_audio_transcript.done",
    transcript: "Three merged yesterday.",
  });
  harness.fake.receive({ type: "response.done", response: { status: "completed" } });
  expect(harness.latest().captions.at(-1))
    .toMatchObject({ role: "assistant", text: "Three merged yesterday." });
  expect(harness.latest().phase).toBe("listening");
});

/**
 * The realtime model cannot read an image. The only place a captured window
 * can actually be looked at is the CTO thread behind `ask_cto`.
 */
it("sends a captured image to the backend, not to the voice model", async () => {
  const seen: Array<string | null | undefined> = [];
  const harness = createService({
    runBackendTurn: async ({ imageBase64 }) => { seen.push(imageBase64); return { spoken: "ok" }; },
  });
  await openCall(harness);

  harness.service.attachImage({ pngBase64: "PNGDATA", note: "the CI run" });
  // The model is told it happened, and told in the silent channel: a
  // conversation item, with no response asked for, so nothing is read out.
  const item = harness.fake.lastOfType("conversation.item.create") as Record<string, any>;
  expect(item.item.role).toBe("system");
  expect(JSON.stringify(item.item.content)).toContain("the CI run");
  expect(JSON.stringify(harness.fake.sent)).not.toContain("PNGDATA");

  askCto(harness, "what is this showing", { callId: "call_1" });
  await tick();
  expect(seen).toEqual(["PNGDATA"]);

  // One capture, one turn: it must not ride along on the next one too.
  askCto(harness, "and the one before it", { callId: "call_2" });
  await tick();
  expect(seen).toEqual(["PNGDATA", null]);
});

it("hands output audio straight to the renderer", async () => {
  const chunks: string[] = [];
  const harness = createService({ onOutputAudio: (b64) => chunks.push(b64) });
  await openCall(harness);
  harness.fake.receive({ type: "response.output_audio.delta", delta: "AAAB" });
  // The same event under the name the older surface still uses for it.
  harness.fake.receive({ type: "response.audio.delta", delta: "AAAC" });
  expect(chunks).toEqual(["AAAB", "AAAC"]);
});

/**
 * The safety property of the whole feature. A call shares the CTO's one
 * session and there is no per-turn permission argument, so the only place the
 * guarantee can live is a window held open for the call. If this test ever
 * goes red, a spoken sentence can reach a tool that writes.
 */
it("puts the CTO in confirm-first mode for the life of the call, and restores it after", async () => {
  const calls: boolean[] = [];
  const harness = createService({ setCallConfirmMode: async (v: boolean) => { calls.push(v); } });

  await harness.service.start();
  // Read-only is on BEFORE the socket exists — no audio may be in flight
  // while the CTO can still write.
  expect(calls).toEqual([true]);

  harness.fake.open();
  harness.fake.receive({ type: "session.created", session: { id: "sess_1" } });
  await harness.service.end();
  expect(calls).toEqual([true, false]);
});
