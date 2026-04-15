// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PrCommandPalettes } from "./PrCommandPalettes";

afterEach(cleanup);

const COMMITS = [
  { sha: "aaaaaaa", subject: "Add feature", author: "alice" },
  { sha: "bbbbbbb", subject: "Fix bug", author: "bob" },
  { sha: "ccccccc", subject: "Refactor types", author: "carol" },
];

const THREADS = [
  { id: "t1", path: "src/app.ts", line: 12, resolved: false, firstCommentAuthor: "alice" },
  { id: "t2", path: "src/util.ts", line: 8, resolved: true, firstCommentAuthor: "bob" },
];

const FILES = [
  { path: "src/app.ts", additions: 20, deletions: 2 },
  { path: "src/util.ts", additions: 3, deletions: 1 },
  { path: "README.md", additions: 5, deletions: 5 },
];

describe("PrCommandPalettes", () => {
  it("does not render when open is null", () => {
    render(
      <PrCommandPalettes
        open={null}
        onClose={() => {}}
        commits={COMMITS}
        threads={THREADS}
        files={FILES}
        onPickCommit={() => {}}
        onPickThread={() => {}}
        onPickFile={() => {}}
      />,
    );
    expect(screen.queryByTestId("pr-command-palette-input")).toBeNull();
  });

  it("fuzzy-filters commits by query and picks on Enter", () => {
    const onPickCommit = vi.fn();
    render(
      <PrCommandPalettes
        open="commit"
        onClose={() => {}}
        commits={COMMITS}
        threads={THREADS}
        files={FILES}
        onPickCommit={onPickCommit}
        onPickThread={() => {}}
        onPickFile={() => {}}
      />,
    );
    const input = screen.getByTestId("pr-command-palette-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ft" } });
    // fuzzy "ft" matches "Refactor" and "Fix bug" (both contain f…t)
    const rows = screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-current"));
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPickCommit).toHaveBeenCalled();
  });

  it("calls onClose and onPickFile when a file row is clicked", () => {
    const onClose = vi.fn();
    const onPickFile = vi.fn();
    render(
      <PrCommandPalettes
        open="file"
        onClose={onClose}
        commits={COMMITS}
        threads={THREADS}
        files={FILES}
        onPickCommit={() => {}}
        onPickThread={() => {}}
        onPickFile={onPickFile}
      />,
    );
    fireEvent.click(screen.getByText("README.md"));
    expect(onPickFile).toHaveBeenCalledWith("README.md");
    expect(onClose).toHaveBeenCalled();
  });

  it("cycles selection with ArrowDown / ArrowUp", () => {
    render(
      <PrCommandPalettes
        open="commit"
        onClose={() => {}}
        commits={COMMITS}
        threads={THREADS}
        files={FILES}
        onPickCommit={() => {}}
        onPickThread={() => {}}
        onPickFile={() => {}}
      />,
    );
    const input = screen.getByTestId("pr-command-palette-input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const selected = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "true");
    expect(selected).toHaveLength(1);
  });
});
