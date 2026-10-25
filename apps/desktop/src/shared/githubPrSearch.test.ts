import { describe, expect, it } from "vitest";
import {
  buildGitHubPrSearchQuery,
  emptyGitHubPrListFilters,
  parseGitHubPrSearchText,
} from "./githubPrSearch";
import type { GitHubPrListFilters, GitHubPrSearchState } from "./types/prs";

const repo = { repoOwner: "acme", repoName: "web-app" };

describe("buildGitHubPrSearchQuery", () => {
  it.each<[string, GitHubPrSearchState, Partial<GitHubPrListFilters>, string | null, string, string[]]>([
    ["state only", "open", {}, null, "repo:acme/web-app is:pr is:open sort:updated-desc", []],
    ["closed excludes merged", "closed", {}, null, "repo:acme/web-app is:pr is:closed is:unmerged sort:updated-desc", []],
    ["all has no state", "all", {}, null, "repo:acme/web-app is:pr sort:updated-desc", []],
    [
      "labels with spaces, colons and emoji are quoted",
      "merged",
      { labels: ["needs more info", "size:XS", "🚧 In Progress"] },
      null,
      "repo:acme/web-app is:pr is:merged label:\"needs more info\" label:\"size:XS\" label:\"🚧 In Progress\" sort:updated-desc",
      [],
    ],
    [
      "a label with a quote cannot be searched and is reported",
      "open",
      { labels: ["say \"hi\"", "bug"] },
      null,
      "repo:acme/web-app is:pr is:open label:\"bug\" sort:updated-desc",
      ["say \"hi\""],
    ],
    [
      "people: hyphenated login, me, nobody",
      "open",
      { author: "@octo-cat", assignee: "@none" },
      null,
      "repo:acme/web-app is:pr is:open author:octo-cat no:assignee sort:updated-desc",
      [],
    ],
    ["assigned to me", "open", { assignee: "@me" }, null, "repo:acme/web-app is:pr is:open assignee:@me sort:updated-desc", []],
    ["a bot author searches as its app", "open", { author: "dependabot[bot]" }, null, "repo:acme/web-app is:pr is:open author:app/dependabot sort:updated-desc", []],
    ["an invalid login is dropped, not injected", "open", { author: "x repo:evil/repo" }, null, "repo:acme/web-app is:pr is:open sort:updated-desc", []],
    [
      "free text cannot widen the scope or fight the tab",
      "open",
      {},
      "flaky repo:evil/secret is:closed -org:evil sort:created-asc base:main",
      "repo:acme/web-app is:pr is:open flaky base:main sort:updated-desc",
      [],
    ],
    ["an unbalanced quote is dropped", "open", {}, "\"half open", "repo:acme/web-app is:pr is:open half open sort:updated-desc", []],
  ])("%s", (_name, state, filters, text, expected, unquotable) => {
    const result = buildGitHubPrSearchQuery({
      ...repo,
      state,
      filters: { ...emptyGitHubPrListFilters(), ...filters },
      text,
    });
    expect(result.q).toBe(expected);
    expect(result.unquotableLabels).toEqual(unquotable);
  });
});

describe("parseGitHubPrSearchText", () => {
  it.each<[string, string, boolean, ReturnType<typeof parseGitHubPrSearchText>["filters"], string, boolean]>([
    ["plain text is left alone", "fix sidebar", false, { labels: [] }, "fix sidebar", false],
    [
      "quoted label, author and text",
      "label:\"needs review\" author:octo-cat sidebar",
      false,
      { labels: ["needs review"], author: "octo-cat" },
      "sidebar",
      true,
    ],
    ["label with a colon", "label:size:XS", false, { labels: ["size:XS"] }, "", true],
    ["assignee me", "assignee:@me", false, { labels: [], assignee: "@me" }, "", true],
    ["no:assignee", "No:Assignee crash", false, { labels: [], assignee: "@none" }, "crash", true],
    ["an invalid login stays as text", "author:-bad", false, { labels: [] }, "author:-bad", false],
    ["a token still being typed stays as text", "label:bu", true, { labels: [] }, "label:bu", false],
    ["a finished token is read while typing", "label:bug ", true, { labels: ["bug"] }, "", true],
    [
      "only the trailing token waits",
      "fix label:bug label:\"a b",
      true,
      { labels: ["bug"] },
      "fix label:\"a b",
      true,
    ],
  ])("%s", (_name, input, keepTrailingToken, filters, text, matched) => {
    const result = parseGitHubPrSearchText(input, { keepTrailingToken });
    expect(result.filters).toEqual(filters);
    expect(result.text).toBe(text);
    expect(result.matched).toBe(matched);
  });
});
