import { describe, expect, it } from "vitest";
import {
  GITHUB_REST_LIST_MAX_PAGES,
  clampGithubRestListMaxPages,
  collectGithubRestPages,
  githubRestListPageReachedUpdatedBefore,
} from "./githubRestPagination";

describe("clampGithubRestListMaxPages", () => {
  it("defaults to the hard cap and never exceeds it", () => {
    expect(clampGithubRestListMaxPages()).toBe(GITHUB_REST_LIST_MAX_PAGES);
    expect(clampGithubRestListMaxPages(999)).toBe(GITHUB_REST_LIST_MAX_PAGES);
    expect(clampGithubRestListMaxPages(0)).toBe(1);
    expect(clampGithubRestListMaxPages(3)).toBe(3);
  });
});

describe("githubRestListPageReachedUpdatedBefore", () => {
  it("is true once a page contains an item at or before the boundary", () => {
    expect(githubRestListPageReachedUpdatedBefore(
      [{ updated_at: "2026-09-21T06:00:00Z" }],
      "2026-09-21T07:00:00Z",
    )).toBe(true);
    expect(githubRestListPageReachedUpdatedBefore(
      [{ updated_at: "2026-09-21T08:00:00Z" }],
      "2026-09-21T07:00:00Z",
    )).toBe(false);
  });
});

describe("collectGithubRestPages", () => {
  it("stops at maxPages even when Link rel=next keeps going", async () => {
    let page = 0;
    const rows = await collectGithubRestPages<{ n: number }>({
      maxPages: 2,
      fetchFirst: async () => {
        page += 1;
        return { data: [{ n: 1 }], nextUrl: "https://api.github.com/x?page=2" };
      },
      fetchNext: async () => {
        page += 1;
        return { data: [{ n: page }], nextUrl: `https://api.github.com/x?page=${page + 1}` };
      },
    });
    expect(rows.map((row) => row.n)).toEqual([1, 2]);
    expect(page).toBe(2);
  });

  it("stops a sort=updated desc walk at the first page that crosses updatedSince", async () => {
    let page = 0;
    const rows = await collectGithubRestPages<{ n: number; updated_at: string }>({
      maxPages: 10,
      sort: "updated",
      direction: "desc",
      stopWhenUpdatedBefore: "2026-09-21T07:00:00Z",
      fetchFirst: async () => {
        page += 1;
        return {
          data: [{ n: 1, updated_at: "2026-09-21T08:00:00Z" }],
          nextUrl: "https://api.github.com/x?page=2",
        };
      },
      fetchNext: async () => {
        page += 1;
        return {
          data: [{ n: 2, updated_at: "2026-09-21T06:00:00Z" }],
          nextUrl: "https://api.github.com/x?page=3",
        };
      },
    });
    expect(rows.map((row) => row.n)).toEqual([1, 2]);
    expect(page).toBe(2);
  });
});
