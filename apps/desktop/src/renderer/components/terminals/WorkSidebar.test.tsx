/* @vitest-environment jsdom */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MacosVmEventPayload,
  MacosVmLifecycleState,
  MacosVmStatus,
} from "../../../shared/types";
import {
  MacosVmTabDot,
  macosVmStateToDot,
  useMacosVmTabDotKind,
} from "./macosVm/macosVmTabDot";

function statusWithLaneState(state: MacosVmLifecycleState | null): MacosVmStatus {
  return {
    platform: "darwin",
    arch: "arm64",
    supported: true,
    checkedAt: "2026-05-07T00:00:00.000Z",
    activeProvider: {
      kind: "apple-virtualization-helper",
      available: true,
      version: null,
      detail: "ok",
      docsUrl: "",
    },
    tools: [],
    laneVm: state
      ? {
          id: "macos-vm:lane-1",
          provider: "apple-virtualization-helper",
          name: "lane-1-vm",
          laneId: "lane-1",
          laneName: "lane-1",
          laneRoot: "/lane/1",
          state,
          cpuCores: 2,
          memory: "4GB",
          diskSize: "64GB",
          display: "1440x900",
          guestSharedPath: "/Volumes/My Shared Files",
          sharedDirectory: "/share/lane-1",
          createdAt: "2026-05-07T00:00:00.000Z",
          updatedAt: "2026-05-07T00:00:00.000Z",
          lastStartedAt: null,
          lastStoppedAt: null,
          ipAddress: null,
          sshCommand: null,
          vncUrl: null,
          lastError: null,
          metadata: {},
        }
      : null,
    vms: [],
    defaultBase: null,
    bases: [],
    docs: { appleVirtualization: "", appleSharedDirectories: "" },
  };
}

describe("macosVmStateToDot", () => {
  it("maps running to running", () => {
    expect(macosVmStateToDot("running")).toBe("running");
  });
  it("maps creating/installing/starting/stopping to transitioning", () => {
    expect(macosVmStateToDot("creating")).toBe("transitioning");
    expect(macosVmStateToDot("installing")).toBe("transitioning");
    expect(macosVmStateToDot("starting")).toBe("transitioning");
    expect(macosVmStateToDot("stopping")).toBe("transitioning");
  });
  it("maps stopped/paused/failed/setup_required to stopped (neutral)", () => {
    expect(macosVmStateToDot("stopped")).toBe("stopped");
    expect(macosVmStateToDot("paused")).toBe("stopped");
    expect(macosVmStateToDot("failed")).toBe("stopped");
    expect(macosVmStateToDot("setup_required")).toBe("stopped");
  });
  it("maps not_created/null/undefined to none", () => {
    expect(macosVmStateToDot("not_created")).toBe("none");
    expect(macosVmStateToDot(null)).toBe("none");
    expect(macosVmStateToDot(undefined)).toBe("none");
  });
});

describe("MacosVmTabDot", () => {
  it("renders nothing for kind=none", () => {
    const { container } = render(<MacosVmTabDot kind="none" />);
    expect(container.querySelector('[data-testid="macos-vm-tab-dot"]')).toBeNull();
  });

  it("renders an emerald dot for running with aria-label and title", () => {
    const { container } = render(<MacosVmTabDot kind="running" />);
    const dot = container.querySelector('[data-testid="macos-vm-tab-dot"]') as HTMLElement;
    expect(dot).toBeTruthy();
    expect(dot.dataset.kind).toBe("running");
    expect(dot.className).toContain("bg-emerald-400");
    expect(dot.getAttribute("aria-label")).toBe("macOS VM running");
    expect(dot.getAttribute("title")).toBe("macOS VM running");
    expect(dot.getAttribute("role")).toBe("img");
    expect(dot.hasAttribute("aria-hidden")).toBe(false);
  });

  it("renders an amber pulsing dot for transitioning with aria-label and title", () => {
    const { container } = render(<MacosVmTabDot kind="transitioning" />);
    const dot = container.querySelector('[data-testid="macos-vm-tab-dot"]') as HTMLElement;
    expect(dot.dataset.kind).toBe("transitioning");
    expect(dot.className).toContain("bg-amber-300");
    expect(dot.className).toContain("animate-pulse");
    expect(dot.getAttribute("aria-label")).toBe("macOS VM transitioning");
    expect(dot.getAttribute("title")).toBe("macOS VM transitioning");
    expect(dot.hasAttribute("aria-hidden")).toBe(false);
  });

  it("renders a neutral dot for stopped with aria-label and title", () => {
    const { container } = render(<MacosVmTabDot kind="stopped" />);
    const dot = container.querySelector('[data-testid="macos-vm-tab-dot"]') as HTMLElement;
    expect(dot.dataset.kind).toBe("stopped");
    expect(dot.className).toContain("bg-white/30");
    expect(dot.getAttribute("aria-label")).toBe("macOS VM stopped");
    expect(dot.getAttribute("title")).toBe("macOS VM stopped");
    expect(dot.hasAttribute("aria-hidden")).toBe(false);
  });
});

function HookProbe({ laneId }: { laneId: string | null }) {
  const kind = useMacosVmTabDotKind(laneId);
  return <span data-testid="probe" data-kind={kind} />;
}

const onEventListeners: Array<(ev: MacosVmEventPayload) => void> = [];
const getStatus = vi.fn();
const onEvent = vi.fn().mockImplementation((cb: (ev: MacosVmEventPayload) => void) => {
  onEventListeners.push(cb);
  return () => {
    const idx = onEventListeners.indexOf(cb);
    if (idx >= 0) onEventListeners.splice(idx, 1);
  };
});

beforeEach(() => {
  onEventListeners.length = 0;
  getStatus.mockReset();
  onEvent.mockClear();
  (window as any).ade = {
    macosVm: { getStatus, onEvent },
  };
});

afterEach(() => {
  cleanup();
  delete (window as any).ade;
});

describe("useMacosVmTabDotKind", () => {
  it("returns running when getStatus returns laneVm.state=running", async () => {
    getStatus.mockResolvedValueOnce(statusWithLaneState("running"));
    const { container } = render(<HookProbe laneId="lane-1" />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="probe"]')?.getAttribute("data-kind")).toBe("running");
    });
  });

  it("updates kind when a vm-updated event arrives", async () => {
    getStatus.mockResolvedValueOnce(statusWithLaneState("stopped"));
    const { container } = render(<HookProbe laneId="lane-1" />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="probe"]')?.getAttribute("data-kind")).toBe("stopped");
    });
    await act(async () => {
      onEventListeners.forEach((cb) =>
        cb({
          type: "vm-updated",
          vm: {
            id: "macos-vm:lane-1",
            provider: "apple-virtualization-helper",
            name: "x",
            laneId: "lane-1",
            laneName: "lane-1",
            laneRoot: "/x",
            state: "starting",
            cpuCores: 2,
            memory: "4GB",
            diskSize: "64GB",
            display: "1440x900",
            guestSharedPath: "/Volumes/My Shared Files",
            sharedDirectory: "/x",
            createdAt: "2026-05-07T00:00:00.000Z",
            updatedAt: "2026-05-07T00:00:00.000Z",
            lastStartedAt: null,
            lastStoppedAt: null,
            ipAddress: null,
            sshCommand: null,
            vncUrl: null,
            lastError: null,
            metadata: {},
          },
        }),
      );
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="probe"]')?.getAttribute("data-kind")).toBe("transitioning");
    });
  });

  it("returns none when laneId is null", async () => {
    const { container } = render(<HookProbe laneId={null} />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="probe"]')?.getAttribute("data-kind")).toBe("none");
      expect(getStatus).not.toHaveBeenCalled();
    });
  });
});
