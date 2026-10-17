import { beforeEach, describe, expect, it } from "vitest";
import type { PrSummary } from "../../../shared/types";
import {
  __resetLanePrReadsCacheForTests,
  clearLanePrReadsCache,
  readLanePrReadsCache,
  writeLanePrReadsCache,
} from "./laneSidebarPrCache";

const pr = { id: "pr-1", title: "Lane PR", githubPrNumber: 1767 } as unknown as PrSummary;

describe("laneSidebarPrCache", () => {
  beforeEach(() => {
    __resetLanePrReadsCacheForTests();
  });

  it("has nothing for a project that was never read", () => {
    expect(readLanePrReadsCache("local:/repo")).toBeNull();
    expect(readLanePrReadsCache(null)).toBeNull();
  });

  it("keeps the last PR list and GitHub snapshot per project", () => {
    writeLanePrReadsCache("local:/repo", { prs: [pr] });
    writeLanePrReadsCache("local:/repo", { githubPrs: [] });
    expect(readLanePrReadsCache("local:/repo")).toEqual({ prs: [pr], githubPrs: [] });
  });

  it("never answers one project's PRs for another project", () => {
    writeLanePrReadsCache("local:/repo-a", { prs: [pr] });
    expect(readLanePrReadsCache("local:/repo-b")).toBeNull();
    expect(readLanePrReadsCache("remote:studio:/repo-a")).toBeNull();
  });

  it("replaces the rows with a later result and clears a failed read's scope", () => {
    writeLanePrReadsCache("local:/repo", { prs: [pr] });
    writeLanePrReadsCache("local:/repo", { prs: [] });
    expect(readLanePrReadsCache("local:/repo")?.prs).toEqual([]);
    clearLanePrReadsCache("local:/repo");
    expect(readLanePrReadsCache("local:/repo")).toBeNull();
  });

  it("bounds the number of projects it keeps", () => {
    for (let i = 0; i < 12; i += 1) writeLanePrReadsCache(`local:/repo-${i}`, { prs: [pr] });
    expect(readLanePrReadsCache("local:/repo-0")).toBeNull();
    expect(readLanePrReadsCache("local:/repo-11")).not.toBeNull();
  });
});
