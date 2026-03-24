/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// Re-import fresh module per test to reset cached state
let useChatMcpSummary: typeof import("./useChatMcpSummary").useChatMcpSummary;

describe("useChatMcpSummary", () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./useChatMcpSummary");
    useChatMcpSummary = mod.useChatMcpSummary;
  });

  afterEach(() => {
    // Clean up any window.ade mock
    delete (window as any).ade;
  });

  it("returns null when window.ade.externalMcp is not available", () => {
    const { result } = renderHook(() => useChatMcpSummary(true));
    expect(result.current).toBeNull();
  });

  it("returns null when disabled", () => {
    (window as any).ade = {
      externalMcp: {
        listConfigs: vi.fn().mockResolvedValue([{ id: "a" }]),
        listServers: vi.fn().mockResolvedValue([]),
        onEvent: vi.fn().mockReturnValue(() => {}),
      },
    };

    const { result } = renderHook(() => useChatMcpSummary(false));
    expect(result.current).toBeNull();
  });

  it("fetches and returns configuredCount and connectedCount", async () => {
    (window as any).ade = {
      externalMcp: {
        listConfigs: vi.fn().mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]),
        listServers: vi.fn().mockResolvedValue([
          { state: "connected" },
          { state: "disconnected" },
          { state: "connected" },
        ]),
        onEvent: vi.fn().mockReturnValue(() => {}),
      },
    };

    const { result } = renderHook(() => useChatMcpSummary(true));

    // Wait for the async fetch to resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current).toEqual({
      configuredCount: 3,
      connectedCount: 2,
    });
  });

  it("returns zeros when listConfigs and listServers reject", async () => {
    (window as any).ade = {
      externalMcp: {
        listConfigs: vi.fn().mockRejectedValue(new Error("fail")),
        listServers: vi.fn().mockRejectedValue(new Error("fail")),
        onEvent: vi.fn().mockReturnValue(() => {}),
      },
    };

    const { result } = renderHook(() => useChatMcpSummary(true));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current).toEqual({
      configuredCount: 0,
      connectedCount: 0,
    });
  });

  it("refreshes the summary when an external MCP event fires", async () => {
    let eventCallback: (() => void) | undefined;

    (window as any).ade = {
      externalMcp: {
        listConfigs: vi.fn().mockResolvedValue([{ id: "a" }]),
        listServers: vi.fn().mockResolvedValue([{ state: "connected" }]),
        onEvent: vi.fn((cb: () => void) => {
          eventCallback = cb;
          return () => {};
        }),
      },
    };

    const { result } = renderHook(() => useChatMcpSummary(true));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current).toEqual({
      configuredCount: 1,
      connectedCount: 1,
    });

    // Update mocks for the refresh
    (window as any).ade.externalMcp.listConfigs.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    (window as any).ade.externalMcp.listServers.mockResolvedValue([
      { state: "connected" },
      { state: "connected" },
    ]);

    // Trigger the MCP event
    await act(async () => {
      eventCallback!();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current).toEqual({
      configuredCount: 2,
      connectedCount: 2,
    });
  });
});
