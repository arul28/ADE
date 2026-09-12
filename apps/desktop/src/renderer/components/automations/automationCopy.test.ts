import { describe, expect, it } from "vitest";
import type { AutomationRule } from "../../../shared/types";
import { buildRuleSentence, triggerClause } from "./automationCopy";

function rule(partial: Partial<AutomationRule>): AutomationRule {
  return {
    id: "r",
    name: "r",
    mode: "review",
    triggers: [{ type: "manual" }],
    trigger: { type: "manual" },
    executor: { mode: "automation-bot" },
    reviewProfile: "quick",
    toolPalette: [],
    contextSources: [],
    guardrails: {},
    outputs: { disposition: "comment-only" },
    verification: { verifyBeforePublish: false },
    billingCode: "auto:r",
    actions: [],
    enabled: true,
    ...partial,
  } as AutomationRule;
}

describe("triggerClause", () => {
  it("glosses schedule crons", () => {
    expect(triggerClause({ type: "schedule", cron: "0 9 * * 1-5" })).toBe("Every weekday at 9:00am");
  });

  it("describes github issue opened with a label", () => {
    expect(triggerClause({ type: "github.issue_opened", labels: ["bug"] })).toBe(
      "A GitHub issue is opened labeled bug",
    );
  });

  it("describes a github PR merged into a branch", () => {
    expect(triggerClause({ type: "github.pr_merged", targetBranch: "main" })).toBe(
      "A GitHub PR is merged into main",
    );
  });

  it("describes a linear issue created in a team", () => {
    expect(triggerClause({ type: "linear.issue_created", team: "ENG" })).toBe(
      "A Linear issue is created in ENG",
    );
  });

  it("describes chat-session triggers in plain words", () => {
    expect(triggerClause({ type: "session.limit_reached", sessionId: "chat-1" })).toBe(
      "This chat hits its usage limit",
    );
    expect(triggerClause({ type: "session.limit_reached" })).toBe("An agent session hits its usage limit");
    expect(triggerClause({ type: "session.failed", providers: ["claude"] })).toBe("A claude session fails");
    expect(triggerClause({ type: "session.ended_without_pr" })).toBe("An agent session ends with no PR");
  });

  it("describes a lane merged with a name pattern", () => {
    expect(triggerClause({ type: "lane.merged", namePattern: "feature/*" })).toBe(
      "A lane matching feature/* is merged",
    );
  });
});

describe("buildRuleSentence", () => {
  it("builds a trigger + agent step + disposition sentence", () => {
    const sentence = buildRuleSentence(
      rule({
        triggers: [{ type: "github.issue_opened" }],
        trigger: { type: "github.issue_opened" },
        execution: { kind: "agent-session", laneMode: "create", session: {} },
        outputs: { disposition: "open-pr-draft" },
      }),
    );
    expect(sentence.trigger).toBe("A GitHub issue is opened");
    expect(sentence.steps).toEqual(["create a lane", "run an agent", "open a draft PR"]);
  });

  it("names the handoff target model", () => {
    const sentence = buildRuleSentence(
      rule({
        triggers: [{ type: "session.limit_reached", sessionId: "chat-1" }],
        trigger: { type: "session.limit_reached", sessionId: "chat-1" },
        execution: {
          kind: "built-in",
          builtIn: {
            actions: [{ type: "handoff", targetModelId: "anthropic/claude-sonnet-5" }],
          },
        },
      }),
    );
    expect(sentence.trigger).toBe("This chat hits its usage limit");
    // The display name, not the registry id.
    expect(sentence.steps).toEqual(["hand off to Claude Sonnet 5"]);
  });

  it("maps built-in ade-actions to friendly phrases", () => {
    const sentence = buildRuleSentence(
      rule({
        execution: {
          kind: "built-in",
          builtIn: {
            actions: [
              { type: "ade-action", adeAction: { domain: "issue", action: "setLabels" } },
            ],
          },
        },
      }),
    );
    expect(sentence.steps).toEqual(["label the issue"]);
  });
});
