import { describe, expect, it } from "vitest";
import {
  claudeModelSwitchAdditionalContext,
  claudeModelSwitchDividerMessage,
  parseClaudeModelSwitchArgs,
} from "./claudeModelSwitch";

describe("Claude model-switch copy", () => {
  it("carries from, to, and requested model on the quiet divider", () => {
    expect(claudeModelSwitchDividerMessage({
      fromModel: "claude-opus-4-7",
      toModel: "Sonnet 5",
      requestedModel: "sonnet",
    })).toBe('switched to Sonnet 5 · requested "sonnet"');
  });

  it("tells the incoming model what it inherited without dumping transcript", () => {
    expect(claudeModelSwitchAdditionalContext({
      fromModel: "Opus 4.7",
      toModel: "Sonnet 5",
      requestedModel: "sonnet",
    })).toBe(
      "You inherited this conversation from Opus 4.7. The user requested sonnet. Continue from the existing thread; do not restart completed work.",
    );
  });

  it("reads snake_case and camelCase PostModelSwitch fields", () => {
    expect(parseClaudeModelSwitchArgs({
      from_model: "Opus",
      toModel: "Sonnet",
      requested_model: "sonnet",
    })).toEqual({
      fromModel: "Opus",
      toModel: "Sonnet",
      requestedModel: "sonnet",
    });
  });
});
