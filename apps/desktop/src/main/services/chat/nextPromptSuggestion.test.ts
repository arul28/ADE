import { describe, expect, it, vi } from "vitest";
import {
  createNextPromptSuggestion,
  MAX_PROMPT_SUGGESTION_CHARS,
  parsePromptSuggestion,
  sanitizePromptSuggestion,
  type PromptSuggestionTurnFacts,
} from "./nextPromptSuggestion";
import type { CodexSampleOutcome } from "./codexThreadSample";

const SESSION = "session-1";
const TURN = "turn-1";

type PromptResult = { structuredOutput?: unknown; text?: string | null };

/**
 * The generator with its process-facing dependencies faked. `runPrompt` hands
 * back a promise the test settles; so does the thread-sample fallback. `done`
 * resolves on the generator's own completion receipt (its log line), so a test
 * waits on that and not on time.
 */
function harness() {
  let settle: (value: PromptResult) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const runPrompt = vi.fn(() => new Promise<PromptResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  }));
  let settleSample: (value: CodexSampleOutcome) => void = () => {};
  const sampleThread = vi.fn((_args: {
    sessionId: string;
    turnId: string;
    prompt: string;
    timeoutMs: number;
    helperError: string | null;
  }) => new Promise<CodexSampleOutcome>((resolve) => { settleSample = resolve; }));
  const emitSuggestion = vi.fn();
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn((event: string) => {
      if (event === "agent_chat.prompt_suggestion") resolveDone();
    }),
  } as never;
  const generator = createNextPromptSuggestion({
    logger,
    runPrompt,
    sampleThread,
    emitSuggestion,
    hasPendingInput: () => false,
  });
  const facts = (overrides: Partial<PromptSuggestionTurnFacts> = {}): PromptSuggestionTurnFacts => ({
    sessionId: SESSION,
    turnId: TURN,
    completed: true,
    isSubagentWithParent: false,
    isEnabled: () => true,
    backgroundWorkCount: 0,
    nativeSuggestions: false,
    entries: [
      { role: "user", text: "Name the helper." },
      { role: "assistant", text: "trimLower or normalizeKey. Which one?", turnId: TURN },
    ],
    isStillCurrent: () => true,
    ...overrides,
  });
  return {
    generator,
    runPrompt,
    sampleThread,
    emitSuggestion,
    facts,
    done,
    settle: (value: PromptResult) => settle(value),
    fail: (error: unknown) => fail(error),
    settleSample: (value: CodexSampleOutcome) => settleSample(value),
  };
}

describe("nextPromptSuggestion", () => {
  it("offers the suggestion only while the chat has not moved on, and never for turns that cannot have one", async () => {
    const offered = harness();
    offered.generator.onTurnDone(offered.facts());
    expect(offered.runPrompt).toHaveBeenCalledTimes(1);
    offered.settle({ structuredOutput: { suggestion: "Use trimLower." } });
    await offered.done;
    expect(offered.emitSuggestion).toHaveBeenCalledWith(SESSION, "Use trimLower.", TURN);

    // The user sent a message while the helper was still answering.
    const stale = harness();
    stale.generator.onTurnDone(stale.facts());
    stale.generator.onTurnActivity(SESSION);
    stale.settle({ structuredOutput: { suggestion: "Use trimLower." } });
    await stale.done;
    expect(stale.emitSuggestion).not.toHaveBeenCalled();

    for (const skipped of [
      { nativeSuggestions: true },
      { isEnabled: () => false },
      { completed: false },
      { backgroundWorkCount: 1 },
      { isSubagentWithParent: true },
      { entries: [{ role: "user" as const, text: "Hello" }] },
    ]) {
      const run = harness();
      run.generator.onTurnDone(run.facts(skipped));
      expect(run.runPrompt, JSON.stringify(Object.keys(skipped))).not.toHaveBeenCalled();
    }
  });

  it("asks the chat's own thread only after the helper fails, and drops its answer when the chat moved on", async () => {
    // The helper failed and the chat's own thread answered: that answer is the
    // suggestion, and it is the only call the expensive fallback made.
    const failed = harness();
    failed.generator.onTurnDone(failed.facts());
    failed.fail(new Error("helper unavailable"));
    await vi.waitFor(() => expect(failed.sampleThread).toHaveBeenCalledTimes(1));
    expect(failed.sampleThread.mock.calls[0][0]).toMatchObject({ turnId: TURN, helperError: "helper unavailable" });
    failed.settleSample({ kind: "answered", text: "\"Run the focused test.\"" });
    await failed.done;
    expect(failed.emitSuggestion).toHaveBeenCalledWith(SESSION, "Run the focused test.", TURN);

    // A helper that answers, even with no suggestion, ends the work: the
    // thread is never asked and nothing is shown.
    const answered = harness();
    answered.generator.onTurnDone(answered.facts());
    answered.settle({ structuredOutput: { suggestion: "" } });
    await answered.done;
    expect(answered.sampleThread).not.toHaveBeenCalled();
    expect(answered.emitSuggestion).not.toHaveBeenCalled();

    // The user typed while the thread was answering: that answer is stale.
    const movedOn = harness();
    movedOn.generator.onTurnDone(movedOn.facts());
    movedOn.fail(new Error("helper unavailable"));
    await vi.waitFor(() => expect(movedOn.sampleThread).toHaveBeenCalledTimes(1));
    movedOn.generator.onTurnActivity(SESSION);
    movedOn.settleSample({ kind: "answered", text: "Commit it." });
    await movedOn.done;
    expect(movedOn.emitSuggestion).not.toHaveBeenCalled();
  });

  it.each([
    // Native Claude suggestions go through sanitize with no cap: quotes inside stay.
    ["sanitize", "Run `pnpm test`", "Run `pnpm test`"],
    ["sanitize", "Rename it to 'foo'", "Rename it to 'foo'"],
    ["sanitize", "\"Fix\" the \"bug\"", "\"Fix\" the \"bug\""],
    ["sanitize", "\"Yes, add tests.\"", "Yes, add tests."],
    ["sanitize", "Commit it\nand push", "Commit it and push"],
    // Helper replies: schema JSON, JSON in text, refusals, and prose.
    ["parse", "{\"suggestion\":\"Commit it\"}", "Commit it"],
    ["parse", "```json\n{\"text\":\"x\"}\n```", ""],
    ["parse", "Suggestion:\nRun the tests", "Run the tests"],
    ["parse", "{\"suggestion\":\"\"}", ""],
  ])("%s %j → %j", (kind, input, expected) => {
    const output = kind === "sanitize" ? sanitizePromptSuggestion(input) : parsePromptSuggestion(null, input);
    expect(output).toBe(expected);
    expect(output).not.toMatch(/\n/);
    expect(output.length).toBeLessThanOrEqual(kind === "parse" ? MAX_PROMPT_SUGGESTION_CHARS : input.length);
  });
});
