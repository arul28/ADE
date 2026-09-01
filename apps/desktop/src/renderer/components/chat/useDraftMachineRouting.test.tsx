/* @vitest-environment jsdom */

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import { useDraftMachineRouting } from "./useDraftMachineRouting";

const originalAde = globalThis.window.ade;

afterEach(() => {
  cleanup();
  if (originalAde === undefined) {
    delete (globalThis.window as any).ade;
  } else {
    globalThis.window.ade = originalAde;
  }
});

describe("useDraftMachineRouting", () => {
  it("clears a stale remote catalog when a later snapshot probe fails", async () => {
    const localBinding: OpenProjectBinding = {
      kind: "local",
      key: "local:/tmp/project-under-test",
      rootPath: "/tmp/project-under-test",
      displayName: "project-under-test",
      gitOriginUrl: "https://github.com/acme/project-under-test.git",
    };
    const getConnectionSnapshot = vi.fn()
      .mockResolvedValueOnce({
        connectedCount: 1,
        updatedAt: 1,
        connections: [{
          state: "connected",
          target: { id: "studio", name: "Mac Studio", hostname: "studio.local" },
          projects: [{
            projectId: "project-1",
            rootPath: "/Users/test/project-under-test",
            displayName: "project-under-test",
            gitOriginUrl: localBinding.gitOriginUrl,
          }],
        }],
      })
      .mockRejectedValueOnce(new Error("snapshot unavailable"));
    window.ade = {
      remoteRuntime: {
        getConnectionSnapshot,
        onConnectionSnapshotChanged: vi.fn().mockReturnValue(() => {}),
      },
    } as any;
    const onDraftMachineChange = vi.fn();
    const setError = vi.fn();

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useDraftMachineRouting({
        enabled,
        projectBinding: localBinding,
        openProjectTabRoots: [localBinding.rootPath],
        crossMachineLanesByMachineId: {},
        lanes: [],
        laneId: null,
        initialDraftMachineId: "studio",
        draftLaunchTargetIsAutoCreate: true,
        onDraftMachineChange,
        setDraftLaunchTargetId: vi.fn(),
        setError,
      }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => {
      expect(result.current.machineOptions.map((option) => option.id)).toEqual(["this-mac", "studio"]);
    });

    rerender({ enabled: false });
    rerender({ enabled: true });

    await waitFor(() => {
      expect(getConnectionSnapshot).toHaveBeenCalledTimes(2);
      expect(result.current.machineOptions.map((option) => option.id)).toEqual(["this-mac"]);
      expect(result.current.selectedMachineId).toBe("this-mac");
    });
    expect(onDraftMachineChange).toHaveBeenCalledWith(null);
    expect(setError).not.toHaveBeenCalled();
  });
});
