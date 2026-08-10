/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatMarkdown } from "./chatMarkdown";
import {
  ChatWorkspacePathProvider,
  resetFilesWorkspaceCacheForTests,
  type ChatWorkspacePathContextValue,
  resolveFilesNavigationTarget,
  resolveWorkspacePathFromHref,
} from "./chatWorkspacePaths";

const openUrlInAdeBrowser = vi.hoisted(() => vi.fn());
vi.mock("../../lib/openExternal", () => ({
  openUrlInAdeBrowser,
}));

/** Only the opener matters to these tests; the rest is inert. */
function contextValue(
  open: ChatWorkspacePathContextValue["openWorkspacePath"] | null,
): ChatWorkspacePathContextValue | null {
  if (!open) return null;
  return {
    openWorkspacePath: open,
    formatWorkspaceDisplayPath: (path: string) => path,
    ensureWorkspacesLoaded: () => {},
  };
}

afterEach(() => {
  cleanup();
  resetFilesWorkspaceCacheForTests();
  openUrlInAdeBrowser.mockReset();
});

describe("chat markdown file paths", () => {
  it("never hands a file path to the browser opener", () => {
    // `normalizeBrowserUrlInput` turns a bare `laneService.ts` into
    // `https://laneService.ts`, so routing a filename through the browser
    // opener navigated ADE's built-in browser to a garbage host.
    render(
      <ChatWorkspacePathProvider value={contextValue(null)}>
        <ChatMarkdown>{"See [laneService.ts](laneService.ts) for details."}</ChatMarkdown>
      </ChatWorkspacePathProvider>,
    );

    fireEvent.click(screen.getByText("laneService.ts"));
    expect(openUrlInAdeBrowser).not.toHaveBeenCalled();
  });

  it("opens a workspace path through the chat opener", () => {
    const onOpen = vi.fn();
    render(
      <ChatWorkspacePathProvider value={contextValue(onOpen)}>
        <ChatMarkdown>{"Edited [laneService.ts](apps/desktop/src/laneService.ts:1414)."}</ChatMarkdown>
      </ChatWorkspacePathProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "laneService.ts" }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ path: "apps/desktop/src/laneService.ts", startLine: 1414 }),
    );
    expect(openUrlInAdeBrowser).not.toHaveBeenCalled();
  });

  it("keeps a Windows drive path clickable (sanitizer strips unknown schemes)", () => {
    // rehypeSanitize runs before urlTransform and its href allowlist is
    // http/https/irc/ircs/mailto/xmpp, so `C:\\repo\\x.ts` — whose scheme parses
    // as `c:` — lost its href entirely and dead-clicked on Windows while the
    // equivalent macOS/Linux `/repo/x.ts` worked.
    const onOpen = vi.fn();
    render(
      <ChatWorkspacePathProvider value={contextValue(onOpen)}>
        <ChatMarkdown>{"Edited [main.ts](C:\\repo\\apps\\main.ts)."}</ChatMarkdown>
      </ChatWorkspacePathProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "main.ts" }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ path: "C:/repo/apps/main.ts" }),
    );
  });

  it("keeps a file: URL clickable", () => {
    const onOpen = vi.fn();
    render(
      <ChatWorkspacePathProvider value={contextValue(onOpen)}>
        <ChatMarkdown>{"Edited [main.ts](file:///repo/apps/main.ts)."}</ChatMarkdown>
      </ChatWorkspacePathProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "main.ts" }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/repo/apps/main.ts" }),
    );
  });

  it("still strips a javascript: href", () => {
    render(
      <ChatWorkspacePathProvider value={contextValue(vi.fn())}>
        <ChatMarkdown>{"[click](javascript:alert(1))"}</ChatMarkdown>
      </ChatWorkspacePathProvider>,
    );
    const anchor = screen.getByText("click").closest("a");
    expect(anchor?.getAttribute("href")).toBeFalsy();
  });

  it("keeps a file: href that is not a workspace path inert", () => {
    // Widening the sanitizer to allow `file:` means an href that resolves to
    // neither a workspace path nor a real URL would otherwise reach the browser
    // opener, which accepts file: and loads it in-app.
    render(
      <ChatWorkspacePathProvider value={contextValue(vi.fn())}>
        <ChatMarkdown>{"[report](file:///tmp)"}</ChatMarkdown>
      </ChatWorkspacePathProvider>,
    );

    fireEvent.click(screen.getByText("report"));
    expect(openUrlInAdeBrowser).not.toHaveBeenCalled();
    expect(screen.getByText("report").closest("a")).toBeNull();
  });

  it("still routes real URLs to the browser", () => {
    render(
      <ChatWorkspacePathProvider value={contextValue(vi.fn())}>
        <ChatMarkdown>{"See [the docs](https://example.com/guide)."}</ChatMarkdown>
      </ChatWorkspacePathProvider>,
    );

    fireEvent.click(screen.getByText("the docs"));
    expect(openUrlInAdeBrowser).toHaveBeenCalledWith("https://example.com/guide");
  });

  it("does not treat an external URL as a workspace path", () => {
    expect(resolveWorkspacePathFromHref("https://example.com/a.ts")).toBeNull();
    expect(resolveWorkspacePathFromHref("mailto:someone@example.com")).toBeNull();
    expect(resolveWorkspacePathFromHref("#heading")).toBeNull();
  });
});

describe("resolveFilesNavigationTarget", () => {
  const workspaces = [
    { rootPath: "/repo", laneId: null },
    { rootPath: "/repo/.ade/worktrees/lane-a", laneId: "lane-a" },
  ];

  it("maps an absolute worktree path to a lane-relative one", () => {
    expect(
      resolveFilesNavigationTarget({
        path: "/repo/.ade/worktrees/lane-a/apps/desktop/src/main.ts",
        workspaces,
        fallbackLaneId: "lane-a",
      }),
    ).toMatchObject({ openFilePath: "apps/desktop/src/main.ts", laneId: "lane-a" });
  });

  it("prefers the deepest matching root over an ancestor", () => {
    // Both roots contain the file; the lane worktree is the right owner.
    expect(
      resolveFilesNavigationTarget({
        path: "/repo/.ade/worktrees/lane-a/README.md",
        workspaces,
        fallbackLaneId: null,
      }),
    ).toMatchObject({ openFilePath: "README.md", laneId: "lane-a" });
  });

  it("attributes a relative path to the chat's lane", () => {
    expect(
      resolveFilesNavigationTarget({ path: "./apps/a.ts", workspaces, fallbackLaneId: "lane-a" }),
    ).toMatchObject({ openFilePath: "apps/a.ts", laneId: "lane-a" });
  });

  it("resolves Windows worktree paths case-insensitively", () => {
    const windowsWorkspaces = [
      { rootPath: "C:\\repo\\.ade\\worktrees\\lane-a", laneId: "lane-a" },
    ];
    expect(
      resolveFilesNavigationTarget({
        path: "c:\\Repo\\.ade\\worktrees\\lane-a\\apps\\desktop\\src\\main.ts",
        workspaces: windowsWorkspaces,
        fallbackLaneId: "lane-a",
      }),
    ).toMatchObject({ openFilePath: "apps/desktop/src/main.ts", laneId: "lane-a" });
  });

  it("returns null for a path outside every workspace", () => {
    expect(
      resolveFilesNavigationTarget({ path: "/elsewhere/a.ts", workspaces, fallbackLaneId: "lane-a" }),
    ).toBeNull();
  });
});
