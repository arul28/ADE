import { describe, expect, it, vi } from "vitest";
import { createLinearClient } from "./linearClient";

function makeIssueNode(id: string, updatedAt: string) {
  return {
    id,
    identifier: `ABC-${id}`,
    title: `Issue ${id}`,
    description: "Test issue",
    url: null,
    priority: 2,
    createdAt: "2026-03-05T00:00:00.000Z",
    updatedAt,
    project: { id: "proj-1", slug: "acme-platform" },
    team: { id: "team-1", key: "ACME" },
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    assignee: null,
    creator: { id: "user-1" },
    labels: { nodes: [{ id: "label-1", name: "bug" }] },
    children: { nodes: [] },
  };
}

describe("linearClient", () => {
  it("paginates issues using cursors", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: Record<string, unknown> };
      if (!body.query?.includes("IssuesByProject")) {
        return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }

      const after = body.variables?.after ?? null;
      if (!after) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                nodes: [makeIssueNode("1", "2026-03-05T00:00:00.000Z")],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [makeIssueNode("2", "2026-03-05T00:01:00.000Z")],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const client = createLinearClient({
      credentials: { getTokenOrThrow: () => "Bearer test-token" } as any,
      fetchImpl: fetchImpl as any,
      logger: null,
    });

    const issues = await client.fetchCandidateIssues({
      projectSlugs: ["acme-platform"],
      stateTypes: ["unstarted", "started"],
    });

    expect(issues.length).toBe(2);
    expect(issues[0]?.identifier).toBe("ABC-1");
    expect(issues[1]?.identifier).toBe("ABC-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries once on rate-limit response for viewer query", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [{ message: "Rate limit exceeded" }],
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              viewer: { id: "viewer-1", name: "Alex" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const client = createLinearClient({
      credentials: { getTokenOrThrow: () => "Bearer test-token" } as any,
      fetchImpl: fetchImpl as any,
      logger: null,
    });

    const viewer = await client.getViewer();
    expect(viewer.id).toBe("viewer-1");
    expect(viewer.name).toBe("Alex");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("lists projects with their owning team names", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
      expect(init?.headers).toMatchObject({ authorization: "Bearer lin_api_test" });
      if (!body.query?.includes("query Projects")) {
        return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          data: {
            projects: {
              nodes: [
                {
                  id: "project-1",
                  name: "App Platform",
                  slug: "app-platform",
                  teams: {
                    nodes: [{ name: "Platform" }],
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const client = createLinearClient({
      credentials: { getTokenOrThrow: () => "lin_api_test" } as any,
      fetchImpl: fetchImpl as any,
      logger: null,
    });

    await expect(client.listProjects()).resolves.toEqual([
      { id: "project-1", name: "App Platform", slug: "app-platform", teamName: "Platform" },
    ]);
  });
});
