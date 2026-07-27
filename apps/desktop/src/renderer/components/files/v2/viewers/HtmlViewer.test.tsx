// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MonacoModelRegistry } from "../../monacoModelRegistry";
import type { EditorTab } from "../editorGroupsStore";
import { buildHtmlPreviewDocument, HtmlViewer } from "./HtmlViewer";
import type { ViewerProps } from "./types";

vi.mock("./CodeViewer", () => ({
  CodeViewer: () => <div data-testid="html-source-editor" />,
}));

const tab: EditorTab = {
  id: "workspace-a::index.html",
  workspaceId: "workspace-a",
  laneId: "lane-a",
  path: "index.html",
  title: "index.html",
  viewerKind: "html",
  languageId: "html",
  preview: false,
  pinned: false,
};

function props(source: string): ViewerProps {
  return {
    workspaceId: "workspace-a",
    rootPath: "/repo",
    tab,
    content: {
      content: source,
      encoding: "utf-8",
      size: source.length,
      languageId: "html",
      isBinary: false,
    },
    readOnly: false,
    theme: "dark",
    registry: {
      isDirty: vi.fn(() => false),
      getValue: vi.fn(() => null),
    } as unknown as MonacoModelRegistry,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("HtmlViewer", () => {
  it("renders HTML in a lazy, fully sandboxed, no-referrer iframe", () => {
    render(<HtmlViewer {...props("<h1>Hello</h1>")} />);

    const frame = screen.getByTestId("files-html-preview");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Hello</h1>");
  });

  it("blocks network-capable document controls and injects the restrictive preview policy", () => {
    const parseFromString = vi.spyOn(DOMParser.prototype, "parseFromString");
    const previewDocument = buildHtmlPreviewDocument(
      '<!-- <head> must not capture policy injection --><html><head><base href="https://example.com"><meta content="0;url=https://example.com" http-equiv="refresh"></head><body class="app">Safe</body></html>',
    );

    expect(parseFromString).not.toHaveBeenCalled();
    expect(previewDocument).not.toMatch(/<base\b/i);
    expect(previewDocument).not.toMatch(/http-equiv="refresh"/i);
    expect(previewDocument).toContain("Content-Security-Policy");
    expect(previewDocument).toContain("default-src 'none'");
    expect(previewDocument).toContain("form-action 'none'");
    expect(previewDocument).toContain('<body class="app">');
  });

  it("switches to the editable source surface without keeping the iframe mounted", () => {
    const firstRender = render(<HtmlViewer {...props("<p>Hello</p>")} />);

    fireEvent.click(screen.getByRole("button", { name: "Source" }));

    expect(screen.getByTestId("html-source-editor")).toBeTruthy();
    expect(screen.queryByTestId("files-html-preview")).toBeNull();
    firstRender.unmount();
    render(<HtmlViewer {...props("<p>Hello again</p>")} />);
    expect(screen.getByTestId("html-source-editor")).toBeTruthy();
  });
});
