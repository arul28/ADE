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
  it("returns only the granted OAuth scopes from the response headers", () => {
    const scopes = parseGitHubScopeHeaders(createHeaders({
      "x-oauth-scopes": "repo, workflow",
      "x-accepted-oauth-scopes": "Read:Org, workflow",
      "x-accepted-scopes": "checks=read",
    }));

    expect(scopes).toEqual(["repo", "workflow"]);
  });

  it("does not treat classic sub-scopes as satisfying the top-level requirement", () => {
    const access = getGitHubTokenAccessState([
      "repo:status",
      "workflow",
      "read:org",
    ]);

    expect(access.hasRequiredAccess).toBe(false);
    expect(access.requirements.repo.present).toBe(false);
    expect(access.missingClassicScopes).toEqual(["repo"]);
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
