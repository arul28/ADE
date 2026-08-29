/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalSessionSource, ExternalSessionSummary } from "./contract";
import { resolveModelDescriptor } from "../../../../shared/modelRegistry";
import { DEFAULT_FORK_MODEL, ImportSessionBrowser } from "./ImportSessionBrowser";

const list = vi.fn();
const importSession = vi.fn();
const getDetail = vi.fn();
const watchDetail = vi.fn();
const unwatchDetail = vi.fn();

vi.mock("../../lanes/LaneDialogShell", () => ({
  LaneDialogShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ToolLogos", () => ({
  ToolLogo: () => <span data-testid="tool-logo" />,
}));
vi.mock("../../ui/SmartTooltip", () => ({
  SmartTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../shared/ModelPicker/ModelPicker", () => ({
  ModelPicker: ({ value }: { value: string }) => <div data-testid="model-picker">{value}</div>,
}));
vi.mock("../LaneCombobox", () => ({
  LaneCombobox: () => <div data-testid="lane-combobox" />,
  computeLanePopoverPlacement: () => ({ width: 220, left: 0, top: 0, maxHeight: 320, openAbove: false }),
}));

function summary(overrides: Partial<ExternalSessionSummary> = {}): ExternalSessionSummary {
  return {
    provider: "claude",
    id: "s1",
    cwd: "/Users/dev/project",
    title: "Fix login",
    preview: "please fix login",
    createdAt: Date.parse("2026-08-14T12:00:00.000Z"),
    updatedAt: Date.parse("2026-08-14T12:00:00.000Z"),
    messageCount: 4,
    alreadyImported: false,
    possiblyActive: true,
    cwdMatchesRequestedLane: true,
    capabilities: {
      resumeInPlace: true,
      resumeInDifferentCwd: false,
      fork: true,
      forkIntoDifferentCwd: false,
      importToChat: true,
    },
    ...overrides,
  };
}

describe("ImportSessionBrowser", () => {
  beforeEach(() => {
    list.mockReset();
    importSession.mockReset();
    getDetail.mockReset();
    watchDetail.mockReset();
    unwatchDetail.mockReset();
    list.mockResolvedValue([
      summary(),
      summary({ id: "empty", title: "Empty", messageCount: 0, possiblyActive: false }),
    ]);
    watchDetail.mockResolvedValue({
      provider: "claude",
      id: "s1",
      cwd: "/Users/dev/project",
      title: "Fix login",
      model: "anthropic/claude-sonnet-5",
      createdAt: Date.parse("2026-08-14T12:00:00.000Z"),
      updatedAt: Date.parse("2026-08-14T12:00:00.000Z"),
      messageCount: 4,
      messages: [
        { role: "user", text: "please fix login", at: 1 },
        { role: "assistant", text: "working on it", at: 2 },
      ],
      sourcePath: "/tmp/s1.jsonl",
      watchable: true,
    });
    unwatchDetail.mockResolvedValue({ ok: true });
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        externalSessions: {
          list,
          import: importSession,
          getDetail,
          watchDetail,
          unwatchDetail,
          onDetailUpdated: () => () => undefined,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as { ade?: unknown }).ade;
  });

  it("shows an explicit scan status while provider discovery is pending", async () => {
    list.mockImplementation(() => new Promise<ExternalSessionSummary[]>(() => undefined));
    render(
      <ImportSessionBrowser
        open
        onOpenChange={vi.fn()}
        laneId="lane-1"
        laneName="main"
        onImported={vi.fn()}
      />,
    );

    expect((await screen.findByRole("status")).textContent).toContain("Scanning external chats");
    expect(screen.getByText(/This computer/i)).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(6);
  });

  it("explains a full scan failure and retries the provider scan", async () => {
    list.mockRejectedValue(new Error("Project runtime unavailable."));
    render(
      <ImportSessionBrowser
        open
        onOpenChange={vi.fn()}
        laneId="lane-1"
        laneName="main"
        onImported={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("External chats couldn't be loaded")).toBeTruthy());
    expect(screen.getByText(/This computer/i)).toBeTruthy();
    expect(screen.getByText(/ADE couldn't scan external chats on This computer/i)).toBeTruthy();
    expect(screen.queryByText(/Project runtime unavailable/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry scan" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(12));
  });

  it("hides empty chats, drops the all-folders checkbox, and shows Live", async () => {
    render(
      <ImportSessionBrowser
        open
        onOpenChange={vi.fn()}
        laneId="lane-1"
        laneName="main"
        onImported={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Fix login")).toBeTruthy());
    expect(screen.queryByText("Show sessions from other folders")).toBeNull();
    expect(screen.queryByText("Empty")).toBeNull();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.queryByText(/May be open elsewhere/i)).toBeNull();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ scope: "project" }));
  });

  it("opens details and loads a full transcript tail", async () => {
    render(
      <ImportSessionBrowser
        open
        onOpenChange={vi.fn()}
        laneId="lane-1"
        laneName="main"
        onImported={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Fix login")).toBeTruthy());
    fireEvent.click(screen.getByText("Fix login"));
    await waitFor(() => expect(screen.getByText("working on it")).toBeTruthy());
    expect(watchDetail).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      sessionId: "s1",
    }));
    expect(screen.getByText("Copy as ADE chat")).toBeTruthy();
    expect(screen.getByTestId("model-picker")).toBeTruthy();
  });

  it("keeps the default fork model resolvable through the shared registry", () => {
    // A silently unresolvable default would leave the fork action with no
    // descriptor and no family, so the fork-as-chat card would misreport itself.
    expect(resolveModelDescriptor(DEFAULT_FORK_MODEL)).toBeTruthy();
  });

  it("falls back to the default fork model when the recorded launch model is unknown", async () => {
    list.mockResolvedValue([
      summary({ launch: { model: "totally-not-a-registry-model" } }),
    ]);
    render(
      <ImportSessionBrowser
        open
        onOpenChange={vi.fn()}
        laneId="lane-1"
        laneName="main"
        onImported={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Fix login")).toBeTruthy());
    fireEvent.click(screen.getByText("Fix login"));
    await waitFor(() => expect(screen.getByTestId("model-picker")).toBeTruthy());
    expect(screen.getByTestId("model-picker").textContent).toBe(DEFAULT_FORK_MODEL);
  });

  it("switches the scan and import route to a connected computer", async () => {
    const studioBinding = {
      kind: "remote" as const,
      key: "studio-project",
      targetId: "studio",
      runtimeName: "Mac Studio",
      projectId: "project-1",
      rootPath: "/Users/dev/project",
      displayName: "ADE",
    };
    const local = summary({ id: "local-session", title: "Local chat", possiblyActive: false });
    const studio = summary({ id: "studio-session", title: "Studio chat", possiblyActive: false });
    list.mockImplementation(async (args: { laneId?: string }) => (
      args.laneId === "studio-lane" ? [studio] : [local]
    ));
    getDetail.mockResolvedValue({
      provider: "claude",
      id: "studio-session",
      cwd: "/Users/dev/project",
      title: "Studio chat",
      messageCount: 1,
      messages: [{ role: "user", text: "hello", at: 1 }],
    });
    importSession.mockResolvedValue({
      kind: "chat",
      chatSessionId: "ade-chat-studio",
      laneId: "studio-lane",
      chatSummary: null,
    });
    const onImported = vi.fn();
    const sources: ExternalSessionSource[] = [
      {
        machineId: "this-mac",
        machineName: "This computer",
        lanes: [{ id: "local-lane", name: "Primary" }],
        binding: null,
        runtimePin: null,
        online: true,
      },
      {
        machineId: "studio",
        machineName: "Mac Studio",
        lanes: [{ id: "studio-lane", name: "Primary" }],
        binding: studioBinding,
        runtimePin: studioBinding,
        online: true,
      },
    ];

    render(
      <ImportSessionBrowser
        open
        onOpenChange={vi.fn()}
        laneId="local-lane"
        laneName="Primary"
        sources={sources}
        onImported={onImported}
      />,
    );

    await waitFor(() => expect(screen.getByText("Local chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Choose import source/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Mac Studio" }));

    await waitFor(() => expect(screen.getByText("Studio chat")).toBeTruthy());
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "studio-lane" }),
      studioBinding,
    );
    expect(screen.queryByText("Local chat")).toBeNull();

    fireEvent.click(screen.getByText("Studio chat"));
    await waitFor(() => expect(screen.getByText("Copy as ADE chat")).toBeTruthy());
    expect(getDetail).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "studio-session" }),
      studioBinding,
    );
    fireEvent.click(screen.getByText("Copy as ADE chat"));
    await waitFor(() => expect(importSession).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "studio-lane" }),
      studioBinding,
    ));
    expect(onImported).toHaveBeenCalledWith(studio, expect.anything(), expect.objectContaining({
      machineId: "studio",
    }));
  });
});
