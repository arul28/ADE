import type { GitBranchSummary, GitCommitSummary } from "../../../shared/types";

type CommitRefMap = Map<string, GitBranchSummary[]>;

type SearchToken = {
  key: string | null;
  value: string;
};

function tokenizeSearch(query: string): SearchToken[] {
  const matches = query.match(/"[^"]+"|\S+/g) ?? [];
  return matches
    .map((raw): SearchToken | null => {
      const trimmed = raw.trim().replace(/^"|"$/g, "");
      if (!trimmed) return null;
      const separator = trimmed.indexOf(":");
      if (separator > 0) {
        const key = trimmed.slice(0, separator).toLowerCase();
        const value = trimmed.slice(separator + 1).toLowerCase();
        return value ? { key, value } : null;
      }
      return { key: null, value: trimmed.toLowerCase() };
    })
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
