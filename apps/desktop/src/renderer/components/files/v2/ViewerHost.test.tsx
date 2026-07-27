// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "../../../../shared/types";
import type { MonacoModelRegistry } from "../monacoModelRegistry";
import type { EditorTab, ViewerKind } from "./editorGroupsStore";
import { ViewerHost } from "./ViewerHost";

const contentState = vi.hoisted(() => ({
  current: null as null | { status: "ready"; content: FileContent },
}));

vi.mock("./useFileContent", () => ({
  useFileContent: () => contentState.current ?? { status: "loading" },
}));

const viewerStub = vi.hoisted(
  () => (name: string) => ({ readOnly }: { readOnly: boolean }) =>
    React.createElement("div", { "data-testid": `viewer-${name}`, "data-readonly": String(readOnly) }),
);

vi.mock("./viewers/CodeViewer", () => ({ CodeViewer: viewerStub("code") }));
vi.mock("./viewers/MarkdownViewer", () => ({ MarkdownViewer: viewerStub("markdown") }));
vi.mock("./viewers/HtmlViewer", () => ({ HtmlViewer: viewerStub("html") }));
vi.mock("./viewers/CsvViewer", () => ({ CsvViewer: viewerStub("csv") }));
vi.mock("./viewers/ImageViewer", () => ({ ImageViewer: viewerStub("image") }));
vi.mock("./viewers/PdfViewer", () => ({ PdfViewer: viewerStub("pdf") }));
vi.mock("./viewers/MediaViewer", () => ({ MediaViewer: viewerStub("media") }));
vi.mock("./viewers/DocumentViewer", () => ({ DocumentViewer: viewerStub("document") }));
vi.mock("./viewers/LargeTextViewer", () => ({ LargeTextViewer: viewerStub("largeText") }));
vi.mock("./viewers/BinaryViewer", () => ({ BinaryViewer: viewerStub("binary") }));

function makeTab(viewerKind: ViewerKind, path: string): EditorTab {
  return {
    id: `ws-1::${path}`,
    workspaceId: "ws-1",
    laneId: null,
    path,
    title: path.split("/").pop() ?? path,
    viewerKind,
    languageId: "plaintext",
    preview: false,
    pinned: false,
  };
}

function textContent(overrides: Partial<FileContent> = {}): FileContent {
  return {
    content: "hello",
    encoding: "utf-8",
    size: 5,
    languageId: "plaintext",
    isBinary: false,
    ...overrides,
  };
}

function renderHost(tab: EditorTab, content: FileContent) {
  contentState.current = { status: "ready", content };
  return render(
    <ViewerHost
      workspaceId="ws-1"
      rootPath="/repo"
      tab={tab}
      theme="dark"
      registry={{} as MonacoModelRegistry}
    />,
  );
}

afterEach(() => {
  cleanup();
  contentState.current = null;
});

describe("ViewerHost editability wiring", () => {
  it("mounts code, markdown, HTML, and csv viewers editable for full text payloads — every workspace, no gates", () => {
    for (const [kind, path, testId] of [
      ["code", "src/a.ts", "viewer-code"],
      ["markdown", "README.md", "viewer-markdown"],
      ["html", "public/index.html", "viewer-html"],
      ["csv", "data.csv", "viewer-csv"],
    ] as const) {
      const view = renderHost(makeTab(kind, path), textContent());
      expect(screen.getByTestId(testId).getAttribute("data-readonly")).toBe("false");
      view.unmount();
    }
  });

  it("keeps non-text viewers read-only", () => {
    for (const [kind, path, testId, content] of [
      ["image", "logo.png", "viewer-image", textContent({ isBinary: true, encoding: "base64" })],
      ["binary", "blob.bin", "viewer-binary", textContent({ isBinary: true })],
      ["largeText", "huge.log", "viewer-largeText", textContent({ isPartial: true, nextOffset: 5 })],
    ] as const) {
      const view = renderHost(makeTab(kind, path), content);
      expect(screen.getByTestId(testId).getAttribute("data-readonly")).toBe("true");
      view.unmount();
    }
  });

  it("keeps a partial (streamed) csv read-only so a truncated buffer can never be saved back", () => {
    renderHost(makeTab("csv", "huge.csv"), textContent({ isPartial: true, nextOffset: 5 }));
    expect(screen.getByTestId("viewer-csv").getAttribute("data-readonly")).toBe("true");
  });
});
