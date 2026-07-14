import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import { createBuiltInBrowserAgentAccessController } from "./builtInBrowserAgentAccess";

vi.mock("electron", () => ({
  dialog: { showMessageBox: vi.fn() },
}));

function fakeSession(cookies: Array<{ domain: string }> = []): Session {
  return {
    cookies: {
      get: vi.fn(async (filter: { url?: string }) => {
        if (!filter.url) return cookies;
        const host = new URL(filter.url).hostname;
        return cookies.filter((cookie) => host === cookie.domain || host.endsWith(`.${cookie.domain}`));
      }),
    },
  } as unknown as Session;
}

describe("builtInBrowserAgentAccess", () => {
  it("allows unbound humans and local development origins without prompting", async () => {
    const prompt = vi.fn(async () => ({ granted: false }));
    const controller = createBuiltInBrowserAgentAccessController({
      getSession: () => fakeSession(),
      resolveParentWindow: () => null,
      prompt,
    });

    await expect(controller.requireUrlAccess("https://github.com", {}, "test")).resolves.toBeUndefined();
    await expect(controller.requireUrlAccess("http://localhost:5173", { chatSessionId: "chat-1" }, "test"))
      .resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("requires one chat-scoped human approval for high-risk origins", async () => {
    const prompt = vi.fn(async () => ({ granted: true }));
    const controller = createBuiltInBrowserAgentAccessController({
      getSession: () => fakeSession(),
      resolveParentWindow: () => null,
      prompt,
    });

    await expect(controller.requireUrlAccess(
      "https://github.com/settings/tokens",
      { laneId: "lane-1", chatSessionId: "chat-1" },
      "navigate",
    )).resolves.toBeUndefined();
    controller.assertUrlAccessSync("https://github.com/settings/tokens", { chatSessionId: "chat-1" });
    expect(() => controller.assertUrlAccessSync(
      "https://github.com/settings/tokens",
      { chatSessionId: "chat-2" },
    )).toThrow(/human-approval check/);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("treats any origin with global-profile cookies as authenticated", async () => {
    const session = fakeSession([{ domain: "example.com" }]);
    const prompt = vi.fn(async () => ({ granted: false }));
    const controller = createBuiltInBrowserAgentAccessController({
      getSession: () => session,
      resolveParentWindow: () => null,
      prompt,
    });

    await expect(controller.requireUrlAccess(
      "https://app.example.com/dashboard",
      { chatSessionId: "chat-1" },
      "observe",
    )).rejects.toThrow(/Human approval was denied/);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("marks inspected cookie-free origins safe for synchronous follow-up reads", async () => {
    const controller = createBuiltInBrowserAgentAccessController({
      getSession: () => fakeSession(),
      resolveParentWindow: () => null,
      prompt: vi.fn(async () => ({ granted: false })),
    });
    const identity = { chatSessionId: "chat-1" };

    expect(() => controller.assertUrlAccessSync("https://example.test", identity)).toThrow();
    await expect(controller.requireUrlAccess("https://example.test", identity, "navigate")).resolves.toBeUndefined();
    expect(() => controller.assertUrlAccessSync("https://example.test", identity)).not.toThrow();
  });
});
