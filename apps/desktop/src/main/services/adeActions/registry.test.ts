import { describe, expect, it } from "vitest";
import {
  ADE_ACTION_ALLOWLIST,
  isAllowedAdeAction,
  listAllowedAdeActionNames,
  type AdeActionDomain,
} from "./registry";

describe("isAllowedAdeAction", () => {
  it("accepts a canonical action from the allowlist", () => {
    expect(isAllowedAdeAction("git", "commit")).toBe(true);
    expect(isAllowedAdeAction("lane", "create")).toBe(true);
    expect(isAllowedAdeAction("automations", "triggerManually")).toBe(true);
    expect(isAllowedAdeAction("issue", "addComment")).toBe(true);
  });

  it("rejects an unknown action on a known domain", () => {
    expect(isAllowedAdeAction("git", "rmRf")).toBe(false);
    expect(isAllowedAdeAction("issue", "deleteAllIssues")).toBe(false);
    expect(isAllowedAdeAction("automations", "__proto__")).toBe(false);
  });

  it("rejects an unknown domain outright", () => {
    expect(isAllowedAdeAction("not-a-domain" as AdeActionDomain, "anything")).toBe(false);
  });

  it("is case-sensitive on the action name", () => {
    // The allowlist is authored in the exact camelCase the service exposes.
    // Case-insensitive matching would mask typos/mistakes in rules.
    expect(isAllowedAdeAction("git", "Commit")).toBe(false);
    expect(isAllowedAdeAction("git", "COMMIT")).toBe(false);
  });

  it("each allowlist entry is marked allowed by the predicate", () => {
    // Round-trip: whatever is in the data drives the predicate, so this
    // guards against accidental mutations (e.g. a trailing space in a name).
    for (const [domain, actions] of Object.entries(ADE_ACTION_ALLOWLIST) as Array<
      [AdeActionDomain, readonly string[] | undefined]
    >) {
      for (const action of actions ?? []) {
        expect(isAllowedAdeAction(domain, action)).toBe(true);
      }
    }
  });
});

describe("listAllowedAdeActionNames", () => {
  it("returns only allowlisted names that the service actually implements as functions", () => {
    const service = {
      commit: () => undefined,
      pull: () => undefined,
      push: () => undefined,
      stash: () => undefined,
      // Extras that are NOT in the allowlist — must not leak through.
      rmRf: () => undefined,
      internalHelper: () => undefined,
      // Key present but not callable — must be filtered out.
      fetch: "not-a-function",
    } as Record<string, unknown>;

    const names = listAllowedAdeActionNames("git", service);

    expect(names).toContain("commit");
    expect(names).toContain("pull");
    expect(names).toContain("push");
    expect(names).toContain("stash");
    expect(names).not.toContain("rmRf");
    expect(names).not.toContain("internalHelper");
    // Present in allowlist but not a function on the service → drop.
    expect(names).not.toContain("fetch");
  });

  it("returns names sorted alphabetically for a stable UI ordering", () => {
    const service: Record<string, unknown> = {};
    for (const name of ADE_ACTION_ALLOWLIST.git ?? []) {
      service[name] = () => undefined;
    }

    const names = listAllowedAdeActionNames("git", service);
    const sortedCopy = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sortedCopy);
  });

  it("returns an empty array when the domain has no allowlist entry", () => {
    // A fabricated domain name hits the `?? []` fallback; the service is
    // irrelevant because nothing is allowed.
    const names = listAllowedAdeActionNames(
      "made-up-domain" as AdeActionDomain,
      { foo: () => undefined } as Record<string, unknown>,
    );
    expect(names).toEqual([]);
  });

  it("returns an empty array when the service implements none of the allowlisted names", () => {
    const service = { someUnrelated: () => undefined } as Record<string, unknown>;
    const names = listAllowedAdeActionNames("git", service);
    expect(names).toEqual([]);
  });
});

describe("ADE_ACTION_ALLOWLIST shape", () => {
  it("has no duplicate action names within any domain", () => {
    // A duplicate would be a silent footgun: the sort would keep both,
    // and the predicate would be correct but the UI would render the name twice.
    for (const [domain, actions] of Object.entries(ADE_ACTION_ALLOWLIST)) {
      if (!actions) continue;
      const unique = new Set(actions);
      expect(unique.size, `domain "${domain}" has duplicate action names`).toBe(actions.length);
    }
  });

  it("exposes the automations domain with the full CRUD + trigger surface", () => {
    // Automations self-management via ADE action is load-bearing — the /automations
    // IPC handlers and the CLI both depend on these exact names.
    const actions = ADE_ACTION_ALLOWLIST.automations ?? [];
    for (const name of [
      "list",
      "get",
      "saveRule",
      "deleteRule",
      "toggleRule",
      "triggerManually",
      "listRuns",
      "getRunDetail",
    ]) {
      expect(actions).toContain(name);
    }
  });

  it("exposes the issue domain with GitHub issue mutation helpers", () => {
    const actions = ADE_ACTION_ALLOWLIST.issue ?? [];
    for (const name of ["addComment", "setLabels", "close", "reopen", "assign", "setTitle"]) {
      expect(actions).toContain(name);
    }
  });
});
