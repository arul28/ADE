import { describe, expect, it } from "vitest";
import { createDefaultComputerUsePolicy } from "../../../shared/types";
import { buildComputerUseDirective } from "./agentChatService";

describe("buildComputerUseDirective", () => {
  it("teaches the model to prefer Ghost OS and ingest proof artifacts", () => {
    const directive = buildComputerUseDirective(createDefaultComputerUsePolicy());

    expect(directive).toContain("Ghost OS (`ghost mcp`)");
    expect(directive).toContain("get_computer_use_backend_status");
    expect(directive).toContain("ingest_computer_use_artifacts");
    expect(directive).toContain("proof drawer");
  });

  it("keeps the off state explicit", () => {
    const directive = buildComputerUseDirective({ ...createDefaultComputerUsePolicy(), mode: "off" });

    expect(directive).toContain("Computer use is OFF for this chat session.");
    expect(directive).not.toContain("Ghost OS");
  });
});
