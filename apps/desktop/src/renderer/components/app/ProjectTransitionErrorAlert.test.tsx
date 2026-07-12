/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/appStore";
import { ProjectTransitionErrorAlert } from "./ProjectTransitionErrorAlert";

describe("ProjectTransitionErrorAlert", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    const switchProjectToPath = vi.fn(async () => {});
    useAppStore.setState({
      projectTransition: null,
      projectTransitionError: null,
      switchProjectToPath,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else globalThis.window.ade = originalAde;
  });

  it("repairs a coded storage failure and retries the failed project open", async () => {
    const repair = vi.fn(async () => ({
      ok: true,
      steps: [],
      dbHealthy: true,
      chatsTotal: 0,
      chatsNeedingAttention: 0,
      filesRemoved: 0 as const,
    }));
    globalThis.window.ade = { recovery: { repair } } as any;
    useAppStore.setState({
      projectTransitionError: {
        code: "disk_full",
        message: "Your Mac ran out of storage.",
        rootPath: "/tmp/recover-me",
      },
    });
    const retry = useAppStore.getState().switchProjectToPath as ReturnType<typeof vi.fn>;

    render(<ProjectTransitionErrorAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Repair ADE" }));

    expect((screen.getByRole("button", { name: "Repairing ADE…" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(repair).toHaveBeenCalledWith("/tmp/recover-me"));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("/tmp/recover-me"));
  });
});
