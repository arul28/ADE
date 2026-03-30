import { describe, expect, it } from "vitest";
import {
  getGitHubTokenAccessState,
  parseGitHubScopeHeaders,
} from "./githubScopes";

function createHeaders(values: Record<string, string>): Pick<Headers, "get"> {
  const lowered = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get(name: string) {
      return lowered.get(name.toLowerCase()) ?? null;
    },
  };
}

describe("githubScopes", () => {
  it("merges OAuth and accepted scope headers case-insensitively", () => {
    const scopes = parseGitHubScopeHeaders(createHeaders({
      "x-oauth-scopes": "repo, workflow",
      "x-accepted-oauth-scopes": "Read:Org, workflow",
    }));

    expect(scopes).toEqual(expect.arrayContaining(["repo", "workflow", "read:org"]));
  });

  it("treats valid fine-grained permissions as full access", () => {
    const access = getGitHubTokenAccessState([
      "Contents=write",
      "PULL_REQUESTS=write",
      "Actions=write",
      "Members=read",
    ]);

    expect(access.hasRequiredAccess).toBe(true);
    expect(access.usesFineGrainedPermissions).toBe(true);
    expect(access.missingDescriptions).toEqual([]);
    expect(access.requirements.repo.present).toBe(true);
    expect(access.requirements.workflow.present).toBe(true);
    expect(access.requirements["read:org"].present).toBe(true);
  });

  it("reports the missing fine-grained permissions when access is incomplete", () => {
    const access = getGitHubTokenAccessState([
      "contents=write",
      "pull_requests=write",
      "checks=read",
    ]);

    expect(access.hasRequiredAccess).toBe(false);
    expect(access.missingDescriptions).toEqual(["Members"]);
    expect(access.missingClassicScopes).toEqual(["read:org"]);
  });
});
