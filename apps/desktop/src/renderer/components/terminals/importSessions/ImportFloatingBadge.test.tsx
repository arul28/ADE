/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImportFloatingBadge,
  importBadgeStorageKey,
  readImportBadgeDismissed,
} from "./ImportFloatingBadge";

vi.mock("../ToolLogos", () => ({
  ToolLogo: ({ toolType }: { toolType: string }) => <span data-testid={`logo-${toolType}`} />,
}));

describe("ImportFloatingBadge", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("opens the import modal and retires the hint for that project", () => {
    const onOpen = vi.fn();
    render(<ImportFloatingBadge projectRoot="/Users/dev/ade" onOpen={onOpen} />);
    expect(screen.getByText("Import your chats from outside ADE")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Import your chats from outside ADE"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(readImportBadgeDismissed("/Users/dev/ade")).toBe(true);
    expect(localStorage.getItem(importBadgeStorageKey("/Users/dev/ade"))).toBe("1");
    expect(screen.queryByText("Import your chats from outside ADE")).toBeNull();
  });

  it("dismisses machine-locally per project without opening", () => {
    const onOpen = vi.fn();
    const { container } = render(<ImportFloatingBadge projectRoot="/Users/dev/ade" onOpen={onOpen} />);
    fireEvent.click(screen.getByLabelText("Hide import hint"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(readImportBadgeDismissed("/Users/dev/ade")).toBe(true);
    expect(screen.queryByText("Import your chats from outside ADE")).toBeNull();
    // Not merely invisible — zero nodes. The badge is a row in a `gap-3`
    // flex column, so anything it leaves behind once retired (an empty
    // wrapper included) spends gap the retired hint no longer earns.
    expect(container.firstChild).toBeNull();
  });

  it("occupies no layout row for a project that never opts in", () => {
    const { container } = render(<ImportFloatingBadge projectRoot={null} onOpen={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Import your chats from outside ADE")).toBeNull();
    expect(screen.queryByLabelText("Hide import hint")).toBeNull();
  });

  it("stays visible for a different project on this machine", () => {
    localStorage.setItem(importBadgeStorageKey("/Users/dev/ade"), "1");
    render(<ImportFloatingBadge projectRoot="/Users/dev/other" onOpen={vi.fn()} />);
    expect(screen.getByText("Import your chats from outside ADE")).toBeTruthy();
  });
});
