import { describe, expect, it, vi } from "vitest";
import {
  createNextPromptSuggestion,
  MAX_PROMPT_SUGGESTION_CHARS,
  parsePromptSuggestion,
  sanitizePromptSuggestion,
  type PromptSuggestionTurnFacts,
} from "./nextPromptSuggestion";

const SESSION = "session-1";
const TURN = "turn-1";

type PromptResult = { structuredOutput?: unknown; text?: string | null };

/**
 * The generator with its process-facing dependencies faked. `runPrompt` hands
 * back a promise the test settles; `done` resolves on the generator's own
 * completion receipt (its log line), so a test waits on that and not on time.
 */
function harness() {
  let settle: (value: PromptResult) => void = () => {};
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const runPrompt = vi.fn(() => new Promise<PromptResult>((resolve) => { settle = resolve; }));
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
  return { generator, runPrompt, emitSuggestion, facts, done, settle: (value: PromptResult) => settle(value) };
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
