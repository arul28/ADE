import { describe, expect, it } from "vitest";
import {
  CLAUDE_RESUME_RETURN_OPTIONS,
  claudeResumeReturnChoiceFromAnswer,
  formatClaudeResumeCompactionQuestion,
  formatClaudeSessionAge,
  formatClaudeTokenCount,
} from "./claudeCompaction";

describe("formatClaudeSessionAge", () => {
  it("renders hours and minutes", () => {
    expect(formatClaudeSessionAge(145)).toBe("2h 25m");
  });

  it("drops a zero minutes tail", () => {
    expect(formatClaudeSessionAge(120)).toBe("2h");
  });

  it("renders minutes alone under an hour", () => {
    expect(formatClaudeSessionAge(48)).toBe("48m");
  });

  it("never renders an empty string for a sub-minute or absent age", () => {
    expect(formatClaudeSessionAge(0)).toBe("less than a minute");
    expect(formatClaudeSessionAge(Number.NaN)).toBe("less than a minute");
  });
});

describe("formatClaudeResumeCompactionQuestion", () => {
  it("states both numbers", () => {
    expect(formatClaudeResumeCompactionQuestion({ ageMinutes: 145, estimatedTokens: 275_123 }))
      .toBe("This session is 2h 25m old and uses 275,123 tokens. Compact it before continuing?");
  });

  it("groups the token count", () => {
    expect(formatClaudeTokenCount(1_000_000)).toBe("1,000,000");
  });
});

describe("claudeResumeReturnChoiceFromAnswer", () => {
  it("maps every offered label back to its SDK result", () => {
    for (const option of CLAUDE_RESUME_RETURN_OPTIONS) {
      expect(claudeResumeReturnChoiceFromAnswer(option.label)).toBe(option.value);
      expect(claudeResumeReturnChoiceFromAnswer(option.value)).toBe(option.value);
    }
  });

  it("returns null for an answer it cannot read", () => {
    expect(claudeResumeReturnChoiceFromAnswer("maybe later")).toBeNull();
    expect(claudeResumeReturnChoiceFromAnswer("")).toBeNull();
    expect(claudeResumeReturnChoiceFromAnswer(undefined)).toBeNull();
  });
});
