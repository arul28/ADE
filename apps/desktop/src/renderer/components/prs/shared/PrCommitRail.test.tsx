// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PrCommitRail, type PrCommitRailCommit } from "./PrCommitRail";

afterEach(cleanup);

function makeCommit(overrides: Partial<PrCommitRailCommit> = {}): PrCommitRailCommit {
  return {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    subject: "Initial commit",
    author: "alice",
    authoredAt: new Date().toISOString(),
    threadCount: 0,
    resolvedCount: 0,
    ...overrides,
  };
}

describe("PrCommitRail", () => {
  it("renders each commit and fires onSelectCommit on click", () => {
    const commits = [
      makeCommit({ sha: "1".repeat(40), shortSha: "1111111", subject: "one" }),
      makeCommit({ sha: "2".repeat(40), shortSha: "2222222", subject: "two" }),
    ];
    const onSelect = vi.fn();
    render(
      <PrCommitRail
        commits={commits}
        activeSha={null}
        onSelectCommit={onSelect}
      />,
    );
    fireEvent.click(screen.getByText("two"));
    expect(onSelect).toHaveBeenCalledWith("2".repeat(40));
  });

  it("highlights the active commit with aria-current", () => {
    const commits = [
      makeCommit({ sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "alpha" }),
      makeCommit({ sha: "b".repeat(40), shortSha: "bbbbbbb", subject: "beta" }),
    ];
    render(
      <PrCommitRail
        commits={commits}
        activeSha={"b".repeat(40)}
        onSelectCommit={() => {}}
      />,
    );
    const rows = screen.getAllByTestId("pr-commit-rail-row");
    expect(rows[0]!.getAttribute("aria-current")).toBeNull();
    expect(rows[1]!.getAttribute("aria-current")).toBe("true");
  });

  it("filters to bot-touched commits when Bots pill is selected", () => {
    const commits = [
      makeCommit({ sha: "1".repeat(40), subject: "human", author: "alice" }),
      makeCommit({ sha: "2".repeat(40), subject: "byebot", author: "renovate[bot]" }),
    ];
    render(
      <PrCommitRail
        commits={commits}
        activeSha={null}
        onSelectCommit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Bots" }));
    expect(screen.queryByText("human")).toBeNull();
    expect(screen.getByText("byebot")).toBeTruthy();
  });
});
