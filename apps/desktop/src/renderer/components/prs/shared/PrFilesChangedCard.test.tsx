// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PrFilesChangedCard, type PrFilesChangedFile } from "./PrFilesChangedCard";

afterEach(cleanup);

function files(count: number): PrFilesChangedFile[] {
  return Array.from({ length: count }, (_, i) => ({
    filename: `src/dir${i}/file${i}.ts`,
    additions: i,
    deletions: i,
  }));
}

describe("PrFilesChangedCard preview", () => {
  it("previews five files and folds the rest behind +N more", () => {
    render(<PrFilesChangedCard files={files(8)} onOpenFilesTab={() => {}} />);

    expect(screen.getByText("file0.ts")).toBeTruthy();
    expect(screen.getByText("file4.ts")).toBeTruthy();
    // The sixth row is the one that would start pushing the merge rail down.
    expect(screen.queryByText("file5.ts")).toBeNull();
    expect(screen.getByTestId("pr-files-changed-card-more").textContent).toBe("+3 more");
  });

  it("routes both View all and +N more to the files tab", () => {
    const onOpenFilesTab = vi.fn();
    render(<PrFilesChangedCard files={files(8)} onOpenFilesTab={onOpenFilesTab} />);

    fireEvent.click(screen.getByRole("button", { name: /view all/i }));
    fireEvent.click(screen.getByTestId("pr-files-changed-card-more"));
    expect(onOpenFilesTab).toHaveBeenCalledTimes(2);
  });

  it("collapses to a single header line when the PR touches no files", () => {
    render(<PrFilesChangedCard files={[]} onOpenFilesTab={() => {}} />);

    const card = screen.getByTestId("pr-files-changed-card");
    expect(card.dataset.empty).toBe("true");
    expect(card.querySelector("header")?.textContent).toContain("No files");
    expect(screen.queryByTestId("pr-files-changed-card-list")).toBeNull();
  });

  it("carries the hairline that separates it from Checks above", () => {
    render(<PrFilesChangedCard files={files(2)} onOpenFilesTab={() => {}} />);
    // `divided` is what buys the rule plus its air on both sides.
    expect(screen.getByTestId("pr-files-changed-card").style.paddingTop).not.toBe("");
  });
});
