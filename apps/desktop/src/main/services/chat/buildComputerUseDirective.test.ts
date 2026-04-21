import { describe, expect, it } from "vitest";
import { createDefaultComputerUsePolicy } from "../../../shared/types";
import type { ComputerUseBackendStatus } from "../../../shared/types";
import { buildComputerUseDirective } from "./agentChatService";

function makeBackendStatus(
  overrides: Partial<{
    ghostOs: boolean;
    agentBrowser: boolean;
    localFallback: boolean;
  }> = {},
): ComputerUseBackendStatus {
  const backends: ComputerUseBackendStatus["backends"] = [];
  if (overrides.ghostOs) {
    backends.push({
      name: "Ghost OS",
      style: "external_cli",
      available: true,
      state: "installed",
      detail: "Ghost OS connected.",
      supportedKinds: ["screenshot", "video_recording", "browser_trace", "browser_verification", "console_logs"],
    });
  }
  if (overrides.agentBrowser) {
    backends.push({
      name: "agent-browser",
      style: "external_cli",
      available: true,
      state: "installed",
      detail: "agent-browser CLI is installed.",
      supportedKinds: ["screenshot", "video_recording", "browser_trace", "browser_verification", "console_logs"],
    });
  }
  return {
    backends,
    localFallback: {
      available: overrides.localFallback ?? false,
      detail: overrides.localFallback
        ? "ADE local computer-use tools are available as a fallback."
        : "ADE local computer-use tools are fallback-only and currently missing.",
      supportedKinds: overrides.localFallback ? ["screenshot"] : [],
    },
  };
}

describe("buildComputerUseDirective", () => {
  it("includes Ghost OS tips when Ghost OS backend is available", () => {
    const status = makeBackendStatus({ ghostOs: true });
    const directive = buildComputerUseDirective(createDefaultComputerUsePolicy(), status);

    expect(directive).not.toBeNull();
    expect(directive).toContain("Ghost OS (Desktop Automation)");
    expect(directive).toContain("ghost_context");
    expect(directive).toContain("ghost_annotate");
    expect(directive).toContain("get_computer_use_backend_status");
    expect(directive).toContain("ingest_computer_use_artifacts");
    expect(directive).toContain("proof drawer");
  });

  it("includes agent-browser section when agent-browser is available", () => {
    const status = makeBackendStatus({ agentBrowser: true });
    const directive = buildComputerUseDirective(createDefaultComputerUsePolicy(), status);

    expect(directive).not.toBeNull();
    expect(directive).toContain("agent-browser (Browser Automation)");
    expect(directive).not.toContain("Ghost OS (Desktop Automation)");
  });

  it("includes both backends when both are available", () => {
    const status = makeBackendStatus({ ghostOs: true, agentBrowser: true });
    const directive = buildComputerUseDirective(createDefaultComputerUsePolicy(), status);

    expect(directive).not.toBeNull();
    expect(directive).toContain("Ghost OS (Desktop Automation)");
    expect(directive).toContain("agent-browser (Browser Automation)");
  });

  it("returns null when no backends and no local fallback", () => {
    const status = makeBackendStatus({});
    const policy = createDefaultComputerUsePolicy({ allowLocalFallback: false });
    const directive = buildComputerUseDirective(policy, status);

    expect(directive).toBeNull();
  });

  it("returns minimal directive with only local fallback", () => {
    const status = makeBackendStatus({ localFallback: true });
    const policy = createDefaultComputerUsePolicy({ allowLocalFallback: true });
    const directive = buildComputerUseDirective(policy, status);

    expect(directive).not.toBeNull();
    expect(directive).toContain("ADE Local (Fallback)");
    expect(directive).toContain("Proof Capture");
    expect(directive).not.toContain("Ghost OS (Desktop Automation)");
    expect(directive).not.toContain("agent-browser (Browser Automation)");
  });

  it("falls back to generic directive when backendStatus is null", () => {
    const directive = buildComputerUseDirective(createDefaultComputerUsePolicy(), null);

    expect(directive).not.toBeNull();
    expect(directive).toContain("Computer Use");
    expect(directive).toContain("get_computer_use_backend_status");
    expect(directive).toContain("Proof Capture");
    // No Ghost OS or agent-browser sections since status is unknown
    expect(directive).not.toContain("Ghost OS (Desktop Automation)");
    expect(directive).not.toContain("agent-browser (Browser Automation)");
  });
});
