import { describe, expect, it } from "vitest";
import {
  normalizeComputerUseArtifactKind,
  resolveCloseoutRequirementKeyFromArtifact,
} from "./proofArtifacts";

describe("proofArtifacts", () => {
  it("normalizes explicit browser proof artifact aliases", () => {
    expect(normalizeComputerUseArtifactKind("browser_verification")).toBe("browser_verification");
    expect(normalizeComputerUseArtifactKind("playwright_trace.zip")).toBe("browser_trace");
    expect(normalizeComputerUseArtifactKind("browser_console_logs")).toBe("console_logs");
  });

  it("does not classify unrelated trace, logs, or verification labels as proof artifacts", () => {
    expect(normalizeComputerUseArtifactKind("migration_trace")).toBeNull();
    expect(normalizeComputerUseArtifactKind("server_logs")).toBeNull();
    expect(normalizeComputerUseArtifactKind("deployment_verification")).toBeNull();
    expect(resolveCloseoutRequirementKeyFromArtifact({ kind: "server_logs" })).toBeNull();
  });
});
