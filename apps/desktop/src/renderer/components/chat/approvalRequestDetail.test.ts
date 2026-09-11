import { describe, expect, it } from "vitest";
import type { PendingInputRequest } from "../../../shared/types";
import { approvalDetailIsRedundant, approvalRequestDetail } from "./approvalRequestDetail";

function request(providerMetadata: Record<string, unknown>): Pick<PendingInputRequest, "providerMetadata"> {
  return { providerMetadata };
}

describe("approvalRequestDetail", () => {
  it("finds the command behind a policy reason that never names it", () => {
    // The real card: description "This command requires approval", command
    // nowhere on screen.
    const detail = approvalRequestDetail(request({
      tool: "Bash",
      input: { command: "ade --socket browser status --text", description: "check status" },
      decisionReason: "This command requires approval",
    }));
    expect(detail).toEqual({ text: "ade --socket browser status --text", kind: "command" });
  });

  it("reads the other providers' argument key", () => {
    expect(approvalRequestDetail(request({ toolName: "shell", toolInput: { cmd: "rm -rf build" } })))
      .toEqual({ text: "rm -rf build", kind: "command" });
  });

  it("falls back to the path a file tool would touch", () => {
    expect(approvalRequestDetail(request({ tool: "Write", input: { file_path: "/repo/src/app.ts" } })))
      .toEqual({ text: "/repo/src/app.ts", kind: "path" });
    expect(approvalRequestDetail(request({ tool: "Edit", input: {}, blockedPath: "/repo/.env" })))
      .toEqual({ text: "/repo/.env", kind: "path" });
  });

  it("returns nothing rather than guessing", () => {
    expect(approvalRequestDetail(request({ tool: "WebFetch", input: { url: "https://example.com" } }))).toBeNull();
    expect(approvalRequestDetail(request({ tool: "Bash", input: { command: "   " } }))).toBeNull();
    expect(approvalRequestDetail({ providerMetadata: undefined })).toBeNull();
    expect(approvalRequestDetail(null)).toBeNull();
  });
});

describe("approvalDetailIsRedundant", () => {
  it("stays quiet when the prose already spells the command out", () => {
    const detail = { text: "npm test", kind: "command" as const };
    expect(approvalDetailIsRedundant(detail, "Run command: npm test")).toBe(true);
    expect(approvalDetailIsRedundant(detail, "This command requires approval")).toBe(false);
    expect(approvalDetailIsRedundant(detail, null)).toBe(false);
    expect(approvalDetailIsRedundant(null, "anything")).toBe(true);
  });
});
