import { describe, expect, it } from "vitest";
import type { AutomationRule, AutomationTrigger } from "../../../shared/types/config";
import type { TriggerContext } from "./automationService";
import {
  normalizeRuntimeRule,
  normalizeTriggerType,
  readTriggerPath,
  resolvePlaceholders,
  triggerMatches,
} from "./automationService";

const baseRule: AutomationRule = {
  id: "rule-1",
  name: "Rule 1",
  mode: "review",
  triggers: [{ type: "manual" }],
  trigger: { type: "manual" },
  executor: { mode: "automation-bot" },
  reviewProfile: "quick",
  toolPalette: ["repo", "memory", "mission"],
  contextSources: [],
  memory: { mode: "none" },
  guardrails: {},
  outputs: { disposition: "comment-only", createArtifact: true },
  verification: { verifyBeforePublish: false, mode: "intervention" },
  billingCode: "auto:rule-1",
  actions: [],
  enabled: true,
};

describe("normalizeTriggerType", () => {
  it("aliases legacy git.pr_* to canonical github.pr_*", () => {
    expect(normalizeTriggerType("git.pr_opened")).toBe("github.pr_opened");
    expect(normalizeTriggerType("git.pr_updated")).toBe("github.pr_updated");
    expect(normalizeTriggerType("git.pr_merged")).toBe("github.pr_merged");
    expect(normalizeTriggerType("git.pr_closed")).toBe("github.pr_closed");
  });

  it("maps bare `commit` to git.commit", () => {
    expect(normalizeTriggerType("commit" as never)).toBe("git.commit");
  });

  it("leaves already-canonical triggers untouched", () => {
    expect(normalizeTriggerType("github.issue_opened")).toBe("github.issue_opened");
    expect(normalizeTriggerType("github.pr_opened")).toBe("github.pr_opened");
    expect(normalizeTriggerType("schedule")).toBe("schedule");
    expect(normalizeTriggerType("linear.issue_created")).toBe("linear.issue_created");
  });
});

describe("normalizeRuntimeRule", () => {
  it("strips per-rule budget fields from guardrails", () => {
    const rule = {
      ...baseRule,
      guardrails: {
        ...baseRule.guardrails,
        budgetCapUsd: 25,
        maxSpendUsd: 40,
        budgetUsd: 50,
      } as AutomationRule["guardrails"] & {
        budgetCapUsd?: number;
        maxSpendUsd?: number;
        budgetUsd?: number;
      },
    };

    const normalized = normalizeRuntimeRule(rule);

    expect(normalized.guardrails).not.toHaveProperty("budgetCapUsd");
    expect(normalized.guardrails).not.toHaveProperty("maxSpendUsd");
    expect(normalized.guardrails).not.toHaveProperty("budgetUsd");
  });

  it("canonicalizes legacy git.pr_* triggers to github.pr_*", () => {
    const rule = {
      ...baseRule,
      triggers: [{ type: "git.pr_opened" as const, branch: "main" }],
      trigger: { type: "git.pr_opened" as const, branch: "main" },
    };

    const normalized = normalizeRuntimeRule(rule);

    expect(normalized.triggers[0]?.type).toBe("github.pr_opened");
    expect(normalized.trigger.type).toBe("github.pr_opened");
  });

  it("preserves persisted verification gates for runtime enforcement", () => {
    const rule = {
      ...baseRule,
      verification: { verifyBeforePublish: true, mode: "dry-run" as const },
    };

    const normalized = normalizeRuntimeRule(rule);

    expect(normalized.verification).toEqual({
      verifyBeforePublish: true,
      mode: "dry-run",
    });
  });

  it("derives includeProjectContext from legacy memory/contextSources", () => {
    const none = normalizeRuntimeRule({
      ...baseRule,
      memory: { mode: "none" },
      contextSources: [],
    });
    expect(none.includeProjectContext).toBe(false);

    const hasMemory = normalizeRuntimeRule({
      ...baseRule,
      memory: { mode: "automation-plus-project", ruleScopeKey: "rule-1" },
      contextSources: [],
    });
    expect(hasMemory.includeProjectContext).toBe(true);

    const hasContext = normalizeRuntimeRule({
      ...baseRule,
      memory: { mode: "none" },
      contextSources: [{ type: "project-memory" }],
    });
    expect(hasContext.includeProjectContext).toBe(true);

    const explicitFalse = normalizeRuntimeRule({
      ...baseRule,
      includeProjectContext: false,
      memory: { mode: "automation-plus-project", ruleScopeKey: "rule-1" },
      contextSources: [{ type: "project-memory" }],
    });
    expect(explicitFalse.includeProjectContext).toBe(false);
  });
});

describe("readTriggerPath + resolvePlaceholders", () => {
  const ctx: TriggerContext = {
    triggerType: "github.issue_opened",
    issue: {
      number: 42,
      title: "Payment flow broken",
      body: "Repro steps inside.",
      author: "arul28",
      labels: ["bug", "triage"],
      repo: "arul28/ADE",
    },
  } as TriggerContext;

  it("reads nested paths with or without the `trigger.` prefix", () => {
    expect(readTriggerPath(ctx, "trigger.issue.number")).toBe(42);
    expect(readTriggerPath(ctx, "issue.number")).toBe(42);
    expect(readTriggerPath(ctx, "trigger.issue.author")).toBe("arul28");
  });

  it("returns undefined when a segment is missing", () => {
    expect(readTriggerPath(ctx, "trigger.pr.number")).toBeUndefined();
    expect(readTriggerPath(ctx, "trigger.issue.does_not_exist")).toBeUndefined();
    expect(readTriggerPath(ctx, "")).toBeUndefined();
  });

  it("preserves raw type when a string is wholly a single placeholder", () => {
    expect(resolvePlaceholders("{{trigger.issue.number}}", ctx)).toBe(42);
    expect(resolvePlaceholders("{{trigger.issue.labels}}", ctx)).toEqual(["bug", "triage"]);
  });

  it("templates embedded placeholders and stringifies non-string values", () => {
    expect(resolvePlaceholders("Issue #{{trigger.issue.number}}", ctx)).toBe("Issue #42");
    expect(resolvePlaceholders("{{trigger.issue.author}} opened this", ctx)).toBe(
      "arul28 opened this",
    );
  });

  it("replaces missing embedded placeholders with the empty string", () => {
    expect(resolvePlaceholders("fallback:{{trigger.pr.number}}", ctx)).toBe("fallback:");
  });

  it("leaves a whole-string placeholder untouched when the path is missing", () => {
    expect(resolvePlaceholders("{{trigger.pr.number}}", ctx)).toBe("{{trigger.pr.number}}");
  });

  it("walks nested objects and arrays", () => {
    const tree = {
      labels: ["{{trigger.issue.labels}}"],
      meta: {
        body: "{{trigger.issue.title}}",
        author: "{{trigger.issue.author}}",
      },
      issueNumber: "{{trigger.issue.number}}",
    };

    const resolved = resolvePlaceholders(tree, ctx);

    expect(resolved).toEqual({
      labels: [["bug", "triage"]],
      meta: {
        body: "Payment flow broken",
        author: "arul28",
      },
      issueNumber: 42,
    });
  });

  it("passes non-string primitives through untouched", () => {
    expect(resolvePlaceholders(42, ctx)).toBe(42);
    expect(resolvePlaceholders(true, ctx)).toBe(true);
    expect(resolvePlaceholders(null, ctx)).toBeNull();
  });
});

describe("triggerMatches", () => {
  const issueCtx: TriggerContext = {
    triggerType: "github.issue_opened",
    issue: {
      number: 7,
      title: "Payment webhook sometimes 500s",
      body: "Happens on retry only. Stack trace attached.",
      author: "arul28",
      labels: ["bug", "payments", "triage"],
      repo: "arul28/ADE",
    },
  } as TriggerContext;

  const rule = (partial: Partial<AutomationTrigger>): AutomationTrigger => ({
    type: "github.issue_opened",
    ...partial,
  });

  it("treats labels as a subset check (rule ⊆ event)", () => {
    expect(triggerMatches(rule({ labels: ["bug"] }), issueCtx, undefined, undefined)).toBe(true);
    expect(triggerMatches(rule({ labels: ["bug", "payments"] }), issueCtx, undefined, undefined)).toBe(true);
    expect(triggerMatches(rule({ labels: ["wontfix"] }), issueCtx, undefined, undefined)).toBe(false);
    expect(triggerMatches(rule({ labels: ["bug", "wontfix"] }), issueCtx, undefined, undefined)).toBe(false);
  });

  it("ignores label case when matching", () => {
    expect(triggerMatches(rule({ labels: ["BUG"] }), issueCtx, undefined, undefined)).toBe(true);
    expect(triggerMatches(rule({ labels: ["Payments"] }), issueCtx, undefined, undefined)).toBe(true);
  });

  it("an empty labels filter matches everything", () => {
    expect(triggerMatches(rule({ labels: [] }), issueCtx, undefined, undefined)).toBe(true);
    expect(triggerMatches(rule({}), issueCtx, undefined, undefined)).toBe(true);
  });

  it("titleRegex matches case-insensitively against issue.title", () => {
    expect(triggerMatches(rule({ titleRegex: "webhook" }), issueCtx, undefined, undefined)).toBe(true);
    expect(triggerMatches(rule({ titleRegex: "^Payment" }), issueCtx, undefined, undefined)).toBe(true);
    expect(triggerMatches(rule({ titleRegex: "deploy failure" }), issueCtx, undefined, undefined)).toBe(false);
  });

  it("bodyRegex matches case-insensitively against issue.body", () => {
    expect(triggerMatches(rule({ bodyRegex: "stack trace" }), issueCtx, undefined, undefined)).toBe(true);
    expect(triggerMatches(rule({ bodyRegex: "not-in-body" }), issueCtx, undefined, undefined)).toBe(false);
  });

  it("drops the match silently on invalid regex rather than throwing", () => {
    expect(triggerMatches(rule({ titleRegex: "[" }), issueCtx, undefined, undefined)).toBe(false);
  });

  it("prefers issue.author over the generic trigger.author for authors[] matching", () => {
    expect(triggerMatches(rule({ authors: ["arul28"] }), issueCtx, undefined, undefined)).toBe(true);
    expect(triggerMatches(rule({ authors: ["ARUL28"] }), issueCtx, undefined, undefined)).toBe(true);
    expect(triggerMatches(rule({ authors: ["other-user"] }), issueCtx, undefined, undefined)).toBe(false);
  });

  it("combines filters — all must pass", () => {
    expect(
      triggerMatches(
        rule({ labels: ["bug"], titleRegex: "payment", authors: ["arul28"] }),
        issueCtx,
        undefined,
        undefined,
      ),
    ).toBe(true);
    expect(
      triggerMatches(
        rule({ labels: ["bug"], titleRegex: "deploy" }),
        issueCtx,
        undefined,
        undefined,
      ),
    ).toBe(false);
  });

  it("rejects a mismatched trigger type outright", () => {
    expect(triggerMatches(rule({ type: "github.pr_opened" }), issueCtx, undefined, undefined)).toBe(false);
  });
});
