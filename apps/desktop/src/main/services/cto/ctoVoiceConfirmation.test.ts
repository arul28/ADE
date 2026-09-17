import { describe, expect, it } from "vitest";
import {
  buildConfirmation,
  classifySpokenReply,
  resolveSpokenConfirmation,
} from "./ctoVoiceConfirmation";

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
