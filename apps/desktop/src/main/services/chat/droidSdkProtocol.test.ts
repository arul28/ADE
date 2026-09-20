import { describe, expect, it } from "vitest";
import {
  droidInteractionModeValue,
  droidMcpToolsToDisable,
} from "./droidSdkProtocol";

describe("droidMcpToolsToDisable", () => {
  it("disables enabled user MCP tools while retaining ADE's leased server", () => {
    expect(droidMcpToolsToDisable([
      { serverName: "ade-cto", name: "list_lanes", isEnabled: true },
      { serverName: "filesystem", name: "write_file", isEnabled: true },
      { serverName: "filesystem", name: "read_file", isEnabled: false },
      { serverName: "linear", name: "search", isEnabled: true },
    ], ["ade-cto"])).toEqual([
      { serverName: "filesystem", toolName: "write_file" },
      { serverName: "linear", toolName: "search" },
    ]);
  });

  it("ignores malformed entries and fails closed for unknown MCP state", () => {
    expect(droidMcpToolsToDisable([
      { serverName: "", name: "write_file", isEnabled: true },
      { serverName: "filesystem", name: "", isEnabled: true },
      { serverName: "filesystem", name: "write_file", isEnabled: false },
      { serverName: "filesystem", name: "unknown_state" },
    ], [])).toEqual([
      { serverName: "filesystem", toolName: "unknown_state" },
    ]);
  });
});

describe("droidInteractionModeValue", () => {
  const table = { Auto: "AUTO", Spec: "SPEC", AGI: "AGI" } as const;

  it("returns undefined for an omitted mode so the user's settings decide", () => {
    // The regression: the worker mapped undefined onto Auto, which restated the
    // mode at the highest precedence and undid the omission the service had
    // deliberately made. A live probe showed omission resolves each key from the
    // user's own ~/.factory/settings.json.
    expect(droidInteractionModeValue(table, undefined)).toBeUndefined();
  });

  it("maps every stated mode onto its SDK enum value", () => {
    expect(droidInteractionModeValue(table, "auto")).toBe("AUTO");
    expect(droidInteractionModeValue(table, "spec")).toBe("SPEC");
    expect(droidInteractionModeValue(table, "agi")).toBe("AGI");
  });
});
