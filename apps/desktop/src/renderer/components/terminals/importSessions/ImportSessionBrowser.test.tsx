/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalSessionSummary } from "./contract";
import { resolveModelDescriptor } from "../../../../shared/modelRegistry";
import { DEFAULT_FORK_MODEL, ImportSessionBrowser } from "./ImportSessionBrowser";

const list = vi.fn();
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
          import: vi.fn(),
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
});
