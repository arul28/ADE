import type { OpenCodeClient } from "@opencode/client";
import { describe, expect, it, vi } from "vitest";
import { applyOpenCodeSessionMode } from "./openCodeSession";

describe("OpenCode session mode", () => {
  it("moves an ADE agent back to the configured default for config-toml", async () => {
    const switchAgent = vi.fn();
    const client = {
      config: {
        get: vi.fn().mockResolvedValue([
          { type: "document", info: { default_agent: "project-default" } },
        ]),
      },
      session: {
        switchAgent,
        switchModel: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as OpenCodeClient;

    await applyOpenCodeSessionMode(
      client,
      {
        id: "session-1",
        agent: "ade-full-auto",
        permissions: [{ action: "edit", resource: "*", effect: "deny" }],
        location: { directory: "/workspace" },
      },
      { agent: null, rules: [] },
    );

    expect(switchAgent).toHaveBeenCalledWith({ sessionID: "session-1", agent: "project-default" });
    expect(client.session.update).toHaveBeenCalledWith({ sessionID: "session-1", permissions: [] });
  });
});
