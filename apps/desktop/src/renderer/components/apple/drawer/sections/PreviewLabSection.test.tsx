/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IosSimulatorPreviewTarget } from "../../../../../shared/types";
import { changeMatchesTarget, groupPreviewTargets, PreviewLabSection } from "./PreviewLabSection";
import { installAdeMock, makeCtx } from "../drawerTestHarness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function target(overrides: Partial<IosSimulatorPreviewTarget> = {}): IosSimulatorPreviewTarget {
  return {
    id: "t-1",
    title: "SignInView",
    sourceFile: "Views/SignIn.swift",
    sourceFilePath: "apps/ios/Views/SignIn.swift",
    absoluteSourceFile: "/r/apps/ios/Views/SignIn.swift",
    sourceLine: 40,
    previewDefinitionIndexInFile: 0,
    kind: "preview-macro",
    proximity: "project",
    ...overrides,
  };
}

describe("PreviewLabSection", () => {
  it("renders the target picker, Render, Back to device, Watch file and the workspace verbs", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.listPreviewTargets.mockResolvedValue([target(), target({ id: "t-2", title: "Dark", sourceFile: "Views/Home.swift" })]);
    render(<PreviewLabSection ctx={makeCtx()} onPreviewRendered={vi.fn()} />);
    // No heading of its own: the GROUP card is the heading now (§B1).
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Target")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview target" }).textContent).toContain("SignInView"));
    expect(screen.getByRole("button", { name: "Render" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Back to device" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("switch", { name: "Watch file" })).toBeTruthy();
    // The `⋯` is gone: three workspace verbs on the card beat a menu that hid
    // them behind a glyph with no label (§B2).
    expect(screen.queryByRole("button", { name: "Preview Lab actions" })).toBeNull();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in Xcode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reveal workspace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh previews" })).toBeTruthy();
    expect(iosSimulator.listPreviewTargets).toHaveBeenCalledWith({ laneId: "lane-1" }, null);
  });

  it("opens and reveals the lane's Xcode workspace, and re-reads the previews on demand", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.listPreviewTargets.mockResolvedValue([target()]);
    render(<PreviewLabSection ctx={makeCtx()} onPreviewRendered={vi.fn()} />);
    await waitFor(() => expect(iosSimulator.listPreviewTargets).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Open in Xcode" }));
    await waitFor(() => expect(iosSimulator.ensurePreviewWorkspace).toHaveBeenCalledWith({ laneId: "lane-1", openIfNeeded: true }, null));
    fireEvent.click(screen.getByRole("button", { name: "Reveal workspace" }));
    await waitFor(() => expect(iosSimulator.openPreviewWorkspace).toHaveBeenCalledWith({ laneId: "lane-1" }, null));
    fireEvent.click(screen.getByRole("button", { name: "Refresh previews" }));
    await waitFor(() => expect(iosSimulator.listPreviewTargets).toHaveBeenCalledTimes(2));
  });

  it("groups targets by file for the picker", () => {
    const grouped = groupPreviewTargets([target(), target({ id: "t-2", title: "Home", sourceFile: "Views/Home.swift" })]);
    expect(grouped).toEqual([
      { value: "t-1", label: "SignInView", group: "Views/SignIn.swift" },
      { value: "t-2", label: "Home", group: "Views/Home.swift" },
    ]);
  });

  it("disables the picker, Render and Watch file with no previews, never hiding them", async () => {
    installAdeMock();
    render(<PreviewLabSection ctx={makeCtx()} onPreviewRendered={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview target" }).textContent).toContain("No previews found"));
    expect((screen.getByRole("button", { name: "Preview target" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Render" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "Watch file" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Render hands the picture to the pane and Back to device hands null", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.listPreviewTargets.mockResolvedValue([target()]);
    const onPreviewRendered = vi.fn();
    render(<PreviewLabSection ctx={makeCtx()} onPreviewRendered={onPreviewRendered} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Render" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(iosSimulator.renderPreview).toHaveBeenCalledWith(
      { laneId: "lane-1", sourceFilePath: "apps/ios/Views/SignIn.swift", previewDefinitionIndexInFile: 0, timeoutSec: 120 },
      null,
    ));
    await waitFor(() => expect(onPreviewRendered).toHaveBeenCalledWith({ dataUrl: "data:image/png;base64,AAA", targetLabel: "SignInView" }));
    const back = screen.getByRole("button", { name: "Back to device" }) as HTMLButtonElement;
    await waitFor(() => expect(back.disabled).toBe(false));
    fireEvent.click(back);
    expect(onPreviewRendered).toHaveBeenLastCalledWith(null);
  });

  it("reports a failed render as an error rather than a picture", async () => {
    const { iosSimulator } = installAdeMock();
    iosSimulator.listPreviewTargets.mockResolvedValue([target()]);
    iosSimulator.renderPreview.mockResolvedValue({ ok: false, dataUrl: null, error: "Xcode refused" });
    const ctx = makeCtx();
    const onPreviewRendered = vi.fn();
    render(<PreviewLabSection ctx={ctx} onPreviewRendered={onPreviewRendered} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Render" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(ctx.actions.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "Xcode refused" })));
    expect(onPreviewRendered).not.toHaveBeenCalled();
  });

  it("Watch file subscribes to the lane's workspace and re-renders the current preview on a matching change", async () => {
    const { iosSimulator, files } = installAdeMock();
    iosSimulator.listPreviewTargets.mockResolvedValue([target()]);
    let listener: ((event: { workspaceId: string; path: string }) => void) | null = null;
    (files.onChange as unknown as { mockImplementation: (impl: (cb: (event: { workspaceId: string; path: string }) => void) => () => void) => void })
      .mockImplementation((cb) => {
        listener = cb;
        return () => { listener = null; };
      });
    const onPreviewRendered = vi.fn();
    const { unmount } = render(<PreviewLabSection ctx={makeCtx()} onPreviewRendered={onPreviewRendered} />);
    await waitFor(() => expect((screen.getByRole("switch", { name: "Watch file" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch", { name: "Watch file" }));
    await waitFor(() => expect(files.watchChanges).toHaveBeenCalledWith({ workspaceId: "ws-1" }, null));
    expect(listener).not.toBeNull();
    act(() => { listener!({ workspaceId: "ws-1", path: "/r/apps/ios/Views/Other.swift" }); });
    act(() => { listener!({ workspaceId: "ws-1", path: "/r/apps/ios/Views/SignIn.swift" }); });
    await waitFor(() => expect(iosSimulator.renderCurrentPreview).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(iosSimulator.renderCurrentPreview).toHaveBeenCalledWith(
      { laneId: "lane-1", sourceFile: "Views/SignIn.swift", sourceLine: 40, timeoutSec: 120 },
      null,
    );
    await waitFor(() => expect(onPreviewRendered).toHaveBeenCalledWith({ dataUrl: "data:image/png;base64,BBB", targetLabel: "SignInView" }));
    unmount();
    expect(files.stopWatching).toHaveBeenCalledWith({ workspaceId: "ws-1" }, null);
  });

  it("matches a change against the target's absolute, project-relative and short paths", () => {
    const t = target();
    expect(changeMatchesTarget("/r/apps/ios/Views/SignIn.swift", t)).toBe(true);
    expect(changeMatchesTarget("apps/ios/Views/SignIn.swift", t)).toBe(true);
    expect(changeMatchesTarget("Views/SignIn.swift", t)).toBe(true);
    expect(changeMatchesTarget("/r/apps/ios/Views/SignInModel.swift", t)).toBe(false);
  });
});
