import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_APPROVAL_WITHOUT_TEXT,
  CLASSIFIER_CONTEXT_MAX_UTF16,
  buildClassifierContext,
  classifierContextAuditMessage,
} from "./claudeClassifierContext";

describe("classifierContext user-authorship", () => {
  it("relays the user's exact typed words and nothing else", () => {
    const relay = buildClassifierContext({
      typedText: "  only this bash once  ",
      explicitApproval: true,
    });
    expect(relay).toEqual({
      classifierContext: "only this bash once",
      source: "typed_consent",
      truncated: false,
    });
  });

  it("relays a fixed approval sentence when the user accepted without typing, never the command", () => {
    const relay = buildClassifierContext({
      typedText: "   ",
      explicitApproval: true,
    });
    expect(relay?.classifierContext).toBe(CLASSIFIER_APPROVAL_WITHOUT_TEXT);
    expect(relay?.source).toBe("explicit_approval");
    expect(relay?.classifierContext.includes("rm -rf")).toBe(false);
    expect(relay?.classifierContext.toLowerCase().includes("tool output")).toBe(false);
  });

  it("relays nothing when ADE cannot attribute a statement to the user", () => {
    expect(buildClassifierContext({ explicitApproval: false })).toBeNull();
    expect(buildClassifierContext({ typedText: null, explicitApproval: false })).toBeNull();
    expect(buildClassifierContext({ typedText: "", explicitApproval: false })).toBeNull();
  });

  it("clips to the SDK 2000 UTF-16 cap without summarizing", () => {
    const typed = "yes ".repeat(600);
    const relay = buildClassifierContext({ typedText: typed, explicitApproval: true });
    expect(relay?.truncated).toBe(true);
    expect(relay?.classifierContext.length).toBe(CLASSIFIER_CONTEXT_MAX_UTF16);
    expect(relay?.classifierContext.startsWith("yes yes")).toBe(true);
    expect(classifierContextAuditMessage(relay!).detail).toBe("Truncated to 2000 characters.");
  });

  it("cannot be given tool output or model text as a first-class field — only typedText", () => {
    const keys = Object.keys(buildClassifierContext({
      typedText: "allow",
      explicitApproval: true,
    }) ?? {});
    expect(keys).toEqual(["classifierContext", "source", "truncated"]);
  });
});
