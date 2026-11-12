/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { hasAttachedTerminalShell, useAttachedTerminalShells } from "./useAttachedTerminalShells";
import { publishWorkTerminalShellCount, resetWorkTerminalShellCounts } from "./workTerminalShells";

/** The chat's machine: its shells live there. */
const CHAT_PIN = { kind: "local", key: "local:/repo", rootPath: "/repo", displayName: "repo" } as const;

function installTerminalList(list: ReturnType<typeof vi.fn>) {
  (window as unknown as { ade: unknown }).ade = {
    terminal: { list },
    sessions: { onChanged: vi.fn(() => () => undefined) },
    pty: { onExit: vi.fn(() => () => undefined) },
  };
}

afterEach(() => {
  cleanup();
  resetWorkTerminalShellCounts();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("useAttachedTerminalShells", () => {
  it("lists running or active shells for the owner and says one is attached", async () => {
    const list = vi.fn().mockResolvedValue([
      { title: "zsh", status: "running", active: false },
      { title: "done", status: "exited", active: false },
      { title: "dev", status: "exited", active: true },
    ]);
    installTerminalList(list);

    const { result } = renderHook(() => useAttachedTerminalShells("chat-1", CHAT_PIN));

    await waitFor(() => expect(result.current.titles).toEqual(["zsh", "dev"]));
    expect(list).toHaveBeenCalledWith({ chatSessionId: "chat-1", limit: 20 }, CHAT_PIN);
    expect(result.current.panelCount).toBeNull();
    expect(hasAttachedTerminalShell(result.current)).toBe(true);
  });

  it("lets the mounted panel's count win over the list", async () => {
    installTerminalList(vi.fn().mockResolvedValue([{ title: "zsh", status: "running", active: false }]));
    const { result } = renderHook(() => useAttachedTerminalShells("chat-1", CHAT_PIN));
    await waitFor(() => expect(result.current.titles).toEqual(["zsh"]));

    act(() => publishWorkTerminalShellCount("chat-1", 0));

    expect(result.current.panelCount).toBe(0);
    expect(hasAttachedTerminalShell(result.current)).toBe(false);
  });

  it("reads nothing while disabled (offline machine)", () => {
    const list = vi.fn().mockResolvedValue([]);
    installTerminalList(list);

    const { result } = renderHook(() => useAttachedTerminalShells("chat-1", CHAT_PIN, { enabled: false }));

    expect(list).not.toHaveBeenCalled();
    expect(result.current.titles).toBeNull();
    expect(hasAttachedTerminalShell(result.current)).toBe(false);
  });
});
