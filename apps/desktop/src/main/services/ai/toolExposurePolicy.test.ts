import { describe, expect, it } from "vitest";
import {
  FRONTEND_REPO_DISCOVERY_TOOL_NAMES,
  decideFrontendRepoToolExposure,
  filterFrontendRepoDiscoveryTools,
} from "./toolExposurePolicy";

describe("toolExposurePolicy", () => {
  it("enables frontend repo tools for clear website UI requests", () => {
    const decision = decideFrontendRepoToolExposure("can you add a new tab to the website called test, leave it blank just a stub");
    expect(decision.enabled).toBe(true);
    expect(decision.score).toBeGreaterThanOrEqual(2);
    expect(decision.signals).toEqual(expect.arrayContaining(["website", "tab"]));
  });

  it("keeps frontend repo tools disabled for non-frontend engineering requests", () => {
    const decision = decideFrontendRepoToolExposure("fix the sqlite transaction retry bug in the background sync worker");
    expect(decision.enabled).toBe(false);
    expect(decision.score).toBe(0);
  });

  it("removes frontend repo discovery tools when the decision is disabled", () => {
    const tools = {
      readFile: { name: "readFile" },
      grep: { name: "grep" },
      summarizeFrontendStructure: { name: "summarizeFrontendStructure" },
      findRoutingFiles: { name: "findRoutingFiles" },
    };

    const filtered = filterFrontendRepoDiscoveryTools(tools, false);

    expect(Object.keys(filtered)).toEqual(["readFile", "grep"]);
    for (const toolName of FRONTEND_REPO_DISCOVERY_TOOL_NAMES) {
      expect(filtered).not.toHaveProperty(toolName);
    }
  });
});
