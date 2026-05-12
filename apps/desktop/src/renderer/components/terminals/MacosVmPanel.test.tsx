/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MacosVmPanel } from "./MacosVmPanel";
import type {
  MacosVmContextItem,
  MacosVmRecord,
  MacosVmStatus,
} from "../../../shared/types";

const vmRecord: MacosVmRecord = {
  id: "vm-1",
  provider: "lume",
  name: "ade-lane-one",
  laneId: "lane-1",
  laneName: "Lane one",
  laneRoot: "/tmp/lane-one",
  state: "running",
  cpuCores: 4,
  memory: "8GB",
  diskSize: "80GB",
  display: "1920x1200",
  guestSharedPath: "/Volumes/My Shared Files",
  sharedDirectory: "/tmp/lane-one",
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
  lastStartedAt: "2026-05-12T00:00:00.000Z",
  lastStoppedAt: null,
  ipAddress: null,
  sshCommand: null,
  vncUrl: null,
  lastError: null,
  metadata: {},
};

const status: MacosVmStatus = {
  platform: "darwin",
  arch: "arm64",
  supported: true,
  checkedAt: "2026-05-12T00:00:00.000Z",
  activeProvider: {
    kind: "lume",
    available: true,
    version: "1.0.0",
    detail: "ready",
    docsUrl: "https://example.com/lume",
  },
  tools: [
    {
      name: "lume",
      available: true,
      detail: "ready",
      installHint: "",
      docsUrl: "https://example.com/lume",
    },
  ],
  laneVm: vmRecord,
  vms: [vmRecord],
  docs: {
    appleVirtualization: "https://example.com/apple-virtualization",
    appleSharedDirectories: "https://example.com/shared-directories",
    lume: "https://example.com/lume",
  },
};

const contextItem: MacosVmContextItem = {
  kind: "macos_vm_target",
  id: "macos-vm:lane-1:50:25",
  laneId: "lane-1",
  laneName: "Lane one",
  vmName: "ade-lane-one",
  provider: "lume",
  state: "running",
  hostLanePath: "/tmp/lane-one",
  guestLanePath: "/Volumes/My Shared Files",
  runCommand: "lume run ade-lane-one",
  sshCommand: null,
  vncUrl: null,
  windowTitleQuery: "ade-lane-one",
  screenshotDataUrl: "data:image/png;base64,selected",
  selectedAt: "2026-05-12T00:00:00.000Z",
  metadata: {},
};

function installMacosVmApi() {
  const api = {
    getStatus: vi.fn().mockResolvedValue(status),
    onEvent: vi.fn(() => () => {}),
    provision: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
    focusWindow: vi.fn(),
    captureScreenshot: vi.fn().mockResolvedValue({
      path: ".ade/artifacts/vm-shot.png",
      dataUrl: "data:image/png;base64,shot",
      width: 200,
      height: 100,
      capturedAt: "2026-05-12T00:00:00.000Z",
    }),
    selectPoint: vi.fn().mockResolvedValue({
      item: contextItem,
      source: "coordinate-fallback",
      screenshot: {
        path: ".ade/artifacts/vm-selected.png",
        dataUrl: "data:image/png;base64,selected",
        width: 200,
        height: 100,
        capturedAt: "2026-05-12T00:00:00.000Z",
      },
    }),
    click: vi.fn(),
    typeText: vi.fn(),
  };
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      macosVm: api,
      app: {
        openExternal: vi.fn(),
      },
    },
  });
  return api;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("MacosVmPanel", () => {
  it("selects a screenshot point and edits the local type input without sending", async () => {
    const api = installMacosVmApi();
    const onAddContext = vi.fn();

    render(
      <MacosVmPanel
        laneId="lane-1"
        laneRoot="/tmp/lane-one"
        onAddContext={onAddContext}
      />,
    );

    await waitFor(() => expect(api.getStatus).toHaveBeenCalledWith({ laneId: "lane-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));

    const image = await screen.findByAltText("macOS VM screenshot") as HTMLImageElement;
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 200 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 100 });
    image.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(image, { clientX: 50, clientY: 25 });

    await waitFor(() => {
      expect(api.selectPoint).toHaveBeenCalledWith({
        laneId: "lane-1",
        x: 50,
        y: 25,
        coordinateSpace: "window",
        includeScreenshot: true,
      });
    });
    expect(onAddContext).toHaveBeenCalledWith(contextItem);
    expect(await screen.findByText("50, 25")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Text"), {
      target: { value: "hello vm" },
    });

    expect((screen.getByPlaceholderText("Text") as HTMLInputElement).value).toBe("hello vm");
    expect(api.typeText).not.toHaveBeenCalled();
  });
});
