/* @vitest-environment jsdom */

// Mirror of lane mac-desktop (b18dd67ec) minus the mac-desktop tool; on merge, take theirs.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isWorkLivePreviewEnabled,
  readChatCompanionUiState,
  resetChatCompanionUiStateCacheForTests,
} from "../chat/chatCompanionUiState";
import type { WorkLiveScreenTool } from "../../state/workLiveCardState";
import {
  WORK_TOOL_MAXIMIZE_PANE_LABEL,
  WORK_TOOL_PREVIEW_TOGGLE_LABEL,
  WorkToolPreviewControls,
} from "./workToolPreviewControls";
import { WorkToolsMaximizeContext } from "./workToolsMaximize";

function renderControls(tool: WorkLiveScreenTool, showMaximize = true) {
  return render(
    <WorkToolsMaximizeContext.Provider value={{ maximized: false, setMaximized: vi.fn() }}>
      <WorkToolPreviewControls tool={tool} chatSessionId="chat-1" showMaximize={showMaximize} />
    </WorkToolsMaximizeContext.Provider>,
  );
}

describe("WorkToolPreviewControls per tool header", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetChatCompanionUiStateCacheForTests();
  });

  it("the browser header renders the toggle and a maximize button", () => {
    renderControls("browser");
    expect(screen.getByRole("button", { name: WORK_TOOL_PREVIEW_TOGGLE_LABEL })).toBeTruthy();
    expect(screen.getByRole("button", { name: WORK_TOOL_MAXIMIZE_PANE_LABEL })).toBeTruthy();
  });

  it("the app-control header renders the toggle and a maximize button", () => {
    renderControls("app-control");
    expect(screen.getByRole("button", { name: WORK_TOOL_PREVIEW_TOGGLE_LABEL })).toBeTruthy();
    expect(screen.getByRole("button", { name: WORK_TOOL_MAXIMIZE_PANE_LABEL })).toBeTruthy();
  });

  it("the ios header renders the toggle and a maximize button", () => {
    renderControls("ios");
    expect(screen.getByRole("button", { name: WORK_TOOL_PREVIEW_TOGGLE_LABEL })).toBeTruthy();
    expect(screen.getByRole("button", { name: WORK_TOOL_MAXIMIZE_PANE_LABEL })).toBeTruthy();
  });

  it("suppresses maximize where the surface already owns one", () => {
    renderControls("ios", false);
    const toggle = screen.getByRole("button", { name: WORK_TOOL_PREVIEW_TOGGLE_LABEL });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: WORK_TOOL_MAXIMIZE_PANE_LABEL })).toBeNull();
  });

  it("toggles the per-chat preview off and back on", () => {
    renderControls("browser");
    const toggle = screen.getByRole("button", { name: WORK_TOOL_PREVIEW_TOGGLE_LABEL });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(isWorkLivePreviewEnabled(readChatCompanionUiState("chat-1"), "browser")).toBe(true);

    fireEvent.click(toggle);
    expect(isWorkLivePreviewEnabled(readChatCompanionUiState("chat-1"), "browser")).toBe(false);

    fireEvent.click(toggle);
    expect(isWorkLivePreviewEnabled(readChatCompanionUiState("chat-1"), "browser")).toBe(true);
  });
});
