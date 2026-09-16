/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cursorCloudModelLabel, listAllCursorCloudAgents } from "./ChatCursorCloudPanel";

describe("Cursor Cloud Work-rail panel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pages every Cursor fleet page with the service's 100-item cap", async () => {
    const listAgents = vi.fn(async (args: { cursor?: string | null }) => {
      if (args.cursor === "page-2") {
        return { items: [{ agentId: "agent-2", name: "Second", summary: "" }] };
      }
      return {
        items: [{ agentId: "agent-1", name: "First", summary: "" }],
        nextCursor: "page-2",
      };
    });
    (window as any).ade = { ai: { cursorCloudListAgents: listAgents } };

    await expect(listAllCursorCloudAgents(false)).resolves.toHaveLength(2);
    expect(listAgents).toHaveBeenNthCalledWith(1, { includeArchived: false, limit: 100 });
    expect(listAgents).toHaveBeenNthCalledWith(2, {
      includeArchived: false,
      limit: 100,
      cursor: "page-2",
    });
  });

  it("never renders a raw Cursor model id in the Work-rail picker", () => {
    expect(cursorCloudModelLabel("cursor/claude-4-sonnet-thinking")).toBe("Claude 4 Sonnet Thinking");
  });
});
