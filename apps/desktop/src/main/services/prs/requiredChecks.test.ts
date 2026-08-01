import { describe, expect, it, vi } from "vitest";
import { createRequiredChecksResolver } from "./requiredChecks";

const repo = { owner: "arul28", name: "ADE" };

/**
 * The real shape of `GET /repos/arul28/ADE/rules/branches/main`, captured live.
 * Only the `required_status_checks` rule carries contexts; the rest are noise
 * the resolver must skip.
 */
const ADE_MAIN_RULES = [
  { type: "deletion", ruleset_id: 13910754 },
  { type: "non_fast_forward", ruleset_id: 13910754 },
  { type: "pull_request", parameters: { required_approving_review_count: 1 }, ruleset_id: 13910754 },
  {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: "ci-pass" }],
    },
    ruleset_id: 13910754,
  },
];

function resolver(handler: (path: string) => Promise<{ data: unknown }>) {
  const apiRequest = vi.fn(async (options: { method: "GET"; path: string }) => handler(options.path));
  return {
    apiRequest,
    instance: createRequiredChecksResolver({ apiRequest: apiRequest as never }),
  };
}

describe("createRequiredChecksResolver", () => {
  it("reads required contexts from the rulesets tier", async () => {
    const { instance } = resolver(async (path) => {
      if (path.includes("/rules/branches/")) return { data: ADE_MAIN_RULES };
      throw new Error("unexpected");
    });

    expect(await instance.resolve(repo, "main", false)).toEqual({
      contexts: ["ci-pass"],
      source: "rulesets",
    });
  });

  it("falls back to classic branch protection when rulesets are empty", async () => {
    // Repos that never migrated to rulesets only answer on the admin endpoint.
    const { instance } = resolver(async (path) => {
      if (path.includes("/rules/branches/")) return { data: [] };
      return { data: { required_status_checks: { contexts: ["build", "test"] } } };
    });

    expect(await instance.resolve(repo, "main", false)).toEqual({
      contexts: ["build", "test"],
      source: "branch_protection",
    });
  });

  it("reads the modern `checks` shape of branch protection too", async () => {
    const { instance } = resolver(async (path) => {
      if (path.includes("/rules/branches/")) return { data: [] };
      return { data: { required_status_checks: { checks: [{ context: "ci-pass", app_id: 15368 }] } } };
    });

    const result = await instance.resolve(repo, "main", false);
    expect(result.contexts).toEqual(["ci-pass"]);
  });

  it("returns unknown — not 'none required' — when no credential can read either tier", async () => {
    // A PAT without admin 403s on protection. Claiming "nothing is required"
    // there would hand back exactly the false green this ticket is about.
    const { instance } = resolver(async () => {
      throw new Error("403 Forbidden");
    });

    expect(await instance.resolve(repo, "main", false)).toEqual({
      contexts: null,
      source: "unavailable",
    });
  });

  it("distinguishes a readable branch that requires nothing from an unreadable one", async () => {
    const { instance } = resolver(async (path) => {
      if (path.includes("/rules/branches/")) return { data: [] };
      return { data: {} };
    });

    const result = await instance.resolve(repo, "main", false);
    expect(result.contexts).toEqual([]);
    expect(result.source).not.toBe("unavailable");
  });

  it("labels the unknown case with merge_state when GitHub reports the merge blocked", async () => {
    const { instance } = resolver(async () => {
      throw new Error("404");
    });

    expect(await instance.resolve(repo, "main", true)).toEqual({
      contexts: null,
      source: "merge_state",
    });
  });

  it("applies the merge_state overlay to cached results too", async () => {
    // Two PRs on the same blocked branch must not disagree on cache timing.
    const { instance } = resolver(async () => {
      throw new Error("403 Forbidden");
    });

    expect((await instance.resolve(repo, "main", true)).source).toBe("merge_state");
    expect((await instance.resolve(repo, "main", true)).source).toBe("merge_state");
    expect((await instance.resolve(repo, "main", false)).source).toBe("unavailable");
  });

  it("caches per branch so a webhook storm does not re-ask GitHub", async () => {
    const { apiRequest, instance } = resolver(async (path) =>
      path.includes("/rules/branches/") ? { data: ADE_MAIN_RULES } : { data: {} },
    );

    await instance.resolve(repo, "main", false);
    await instance.resolve(repo, "main", false);
    await instance.resolve(repo, "main", false);

    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("does not serve one branch's requirements to another", async () => {
    const { instance } = resolver(async (path) => {
      if (!path.includes("/rules/branches/")) return { data: {} };
      return { data: path.endsWith("main") ? ADE_MAIN_RULES : [] };
    });

    expect((await instance.resolve(repo, "main", false)).contexts).toEqual(["ci-pass"]);
    expect((await instance.resolve(repo, "release", false)).contexts).toEqual([]);
  });

  it("re-reads after invalidate", async () => {
    const { apiRequest, instance } = resolver(async (path) =>
      path.includes("/rules/branches/") ? { data: ADE_MAIN_RULES } : { data: {} },
    );

    await instance.resolve(repo, "main", false);
    instance.invalidate(repo, "main");
    await instance.resolve(repo, "main", false);

    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it("encodes branch names containing slashes", async () => {
    const { apiRequest, instance } = resolver(async () => ({ data: [] }));
    await instance.resolve(repo, "release/2026-08", false);

    expect(apiRequest.mock.calls[0]![0].path).toContain("release%2F2026-08");
  });

  it("unions contexts across multiple applicable rulesets, first-seen order kept", async () => {
    const { instance } = resolver(async (path) => {
      if (!path.includes("/rules/branches/")) return { data: {} };
      return {
        data: [
          { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci-pass" }] } },
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "ci-pass" }, { context: "security" }] },
          },
        ],
      };
    });

    expect((await instance.resolve(repo, "main", false)).contexts).toEqual(["ci-pass", "security"]);
  });
});
