import type { GitBranchSummary, GitCommitSummary } from "../../../shared/types";

type CommitRefMap = Map<string, GitBranchSummary[]>;

type SearchToken = {
  key: string | null;
  value: string;
};

const SEARCH_KEYS = new Set([
  "message",
  "msg",
  "=",
  "author",
  "@",
  "commit",
  "sha",
  "#",
  "branch",
  "ref",
  "parent",
  "is",
  "type",
]);

function unquote(value: string): string {
  return value.replace(/^"|"$/g, "");
}

function searchTokenFromRaw(raw: string): SearchToken | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("@") && trimmed.length > 1) {
    return { key: "@", value: unquote(trimmed.slice(1)).toLowerCase() };
  }
  if (trimmed.startsWith("#") && trimmed.length > 1) {
    return { key: "#", value: unquote(trimmed.slice(1)).toLowerCase() };
  }
  if (trimmed.startsWith("=") && trimmed.length > 1) {
    return { key: "=", value: unquote(trimmed.slice(1)).toLowerCase() };
  }

  const separator = trimmed.indexOf(":");
  if (separator > 0) {
    const key = trimmed.slice(0, separator).toLowerCase();
    const value = unquote(trimmed.slice(separator + 1)).toLowerCase();
    if (!value) return null;
    if (/^[a-z@#=][a-z0-9_-]*$/i.test(key) && SEARCH_KEYS.has(key)) {
      return { key, value };
    }
  }

  return { key: null, value: unquote(trimmed).toLowerCase() };
}

function tokenizeSearch(query: string): SearchToken[] {
  const matches = query.match(/[^\s"]+:"[^"]+"|"[^"]+"|\S+/g) ?? [];
  return matches
    .map(searchTokenFromRaw)
    .filter((token): token is SearchToken => token != null);
}

function commitRefs(commit: GitCommitSummary, refsBySha: CommitRefMap): string {
  return (refsBySha.get(commit.sha) ?? []).map((ref) => ref.name).join(" ");
}

function includes(value: string, query: string): boolean {
  return value.toLowerCase().includes(query);
}

function matchesToken(
  commit: GitCommitSummary,
  refsBySha: CommitRefMap,
  token: SearchToken,
): boolean {
  const refText = commitRefs(commit, refsBySha);
  switch (token.key) {
    case "message":
    case "msg":
    case "=":
      return includes(commit.subject, token.value);
    case "author":
    case "@":
      return includes(commit.authorName, token.value);
    case "commit":
    case "sha":
    case "#":
      return includes(commit.sha, token.value) || includes(commit.shortSha, token.value);
    case "branch":
    case "ref":
      return includes(refText, token.value);
    case "parent":
      return commit.parents.some((parent) => includes(parent, token.value));
    case "is":
    case "type":
      if (token.value === "merge") return commit.parents.length > 1;
      if (token.value === "local" || token.value === "unpushed") return !commit.pushed;
      if (token.value === "remote" || token.value === "pushed") return commit.pushed;
      return false;
    default: {
      const haystack = [
        commit.shortSha,
        commit.sha,
        commit.subject,
        commit.authorName,
        refText,
        commit.parents.join(" "),
        commit.pushed ? "remote pushed" : "local unpushed",
        commit.parents.length > 1 ? "merge" : "",
      ].join(" ");
      return includes(haystack, token.value);
    }
  }
}

export function filterCommitsForSearch(
  commits: GitCommitSummary[],
  refsBySha: CommitRefMap,
  query: string,
): GitCommitSummary[] {
  const tokens = tokenizeSearch(query);
  if (tokens.length === 0) return commits;
  return commits.filter((commit) =>
    tokens.every((token) => matchesToken(commit, refsBySha, token)),
  );
}
