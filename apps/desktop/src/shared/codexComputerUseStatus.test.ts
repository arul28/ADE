import { describe, expect, it } from "vitest";
import {
  codexComputerUseStatusLabel,
  codexComputerUseToolCall,
  isCodexComputerUseServer,
  shouldEmitCodexComputerUseStatus,
} from "./codexComputerUseStatus";

describe("isCodexComputerUseServer", () => {
  it("matches ADE's injected computer_use MCP name", () => {
    expect(isCodexComputerUseServer("computer_use")).toBe(true);
    expect(isCodexComputerUseServer("computer-use")).toBe(true);
    expect(isCodexComputerUseServer("local-tools")).toBe(false);
    expect(isCodexComputerUseServer("")).toBe(false);
  });
});

describe("shouldEmitCodexComputerUseStatus", () => {
  it("is macOS-only", () => {
    expect(shouldEmitCodexComputerUseStatus("darwin")).toBe(true);
    expect(shouldEmitCodexComputerUseStatus("win32")).toBe(false);
    expect(shouldEmitCodexComputerUseStatus("linux")).toBe(false);
  });
});

describe("codexComputerUseStatusLabel", () => {
  it("maps startup failure to not set up", () => {
    expect(codexComputerUseStatusLabel(false)).toBe("ready");
    expect(codexComputerUseStatusLabel(true)).toBe("not set up");
  });
});

describe("codexComputerUseToolCall", () => {
  it("emits only on macOS and only for the computer_use server", () => {
    expect(codexComputerUseToolCall({ platform: "darwin", serverName: "computer_use", failed: false }))
      .toEqual({
        tool: "computer_use",
        args: { status: "ready" },
        itemId: "computer-use:computer_use",
      });
    expect(codexComputerUseToolCall({ platform: "darwin", serverName: "computer_use", failed: true }))
      .toMatchObject({ args: { status: "not set up" } });
    expect(codexComputerUseToolCall({ platform: "linux", serverName: "computer_use", failed: false })).toBeNull();
    expect(codexComputerUseToolCall({ platform: "win32", serverName: "computer_use", failed: false })).toBeNull();
    expect(codexComputerUseToolCall({ platform: "darwin", serverName: "local-tools", failed: false })).toBeNull();
  });
});
