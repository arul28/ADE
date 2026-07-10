/**
 * Rule-sentence grammar. Turns a rule (or draft) into a readable sentence:
 * a trigger clause plus a list of step clauses, rendered as
 * "When <trigger> → <step> → <step>". Concrete and stateful, never marketing.
 */

import type {
  AutomationAction,
  AutomationOutputDisposition,
  AutomationRule,
  AutomationTrigger,
} from "../../../shared/types";
import { cronSentence } from "./cronDescribe";
import { eventLabel } from "./triggerCatalog";
import { DELETE_LANE_ACTION_TYPE, LANE_MERGED_TRIGGER_TYPE } from "./localAutomationConfig";

type RuleLike = Pick<AutomationRule, "triggers" | "trigger" | "execution" | "outputs" | "prompt">;

export type RuleSentence = {
  trigger: string;
  steps: string[];
};

function primaryTrigger(rule: RuleLike): AutomationTrigger {
  return rule.triggers?.[0] ?? rule.trigger ?? { type: "manual" };
}

/** The "When …" clause. Sentence case, no trailing punctuation. */
export function triggerClause(trigger: AutomationTrigger): string {
  const type = trigger.type as string;

  if (type === "schedule") return cronSentence(trigger.cron);
  if (type === "manual") return "Run manually";
  if (type === "session-end") return "An agent session ends";
  if (type === "file.change") {
    const paths = (trigger.paths ?? []).filter(Boolean);
    return paths.length ? `A file changes in ${paths.join(", ")}` : "A file changes";
  }
  if (type === "git.push") return trigger.branch ? `A push lands on ${trigger.branch}` : "A push lands";
  if (type === "git.commit") return trigger.branch ? `A commit lands on ${trigger.branch}` : "A commit lands";
  if (type === "lane.created") return "A lane is created";
  if (type === "lane.archived") return "A lane is archived";
  if (type === LANE_MERGED_TRIGGER_TYPE) {
    return trigger.namePattern ? `A lane matching ${trigger.namePattern} is merged` : "A lane is merged";
  }
  if (type === "github-webhook" || type === "webhook") {
    return trigger.event ? `A webhook fires for ${trigger.event}` : "A webhook fires";
  }

  if (type.startsWith("github.")) {
    const base = githubClause(type, trigger);
    return base;
  }
  if (type.startsWith("linear.")) {
    return linearClause(type, trigger);
  }
  // Fallback: humanize the event label.
  return eventLabel(type);
}

function labelSuffix(labels: string[] | undefined): string {
  const clean = (labels ?? []).filter(Boolean);
  if (!clean.length) return "";
  return ` labeled ${clean.join(", ")}`;
}

function githubClause(type: string, trigger: AutomationTrigger): string {
  const isPr = type.includes("pr");
  const subject = isPr ? "A GitHub PR" : "A GitHub issue";
  if (type.endsWith("_opened")) return `${subject} is opened${labelSuffix(trigger.labels)}`;
  if (type.endsWith("_edited")) return `${subject} is edited`;
  if (type.endsWith("_closed")) return `${subject} is closed`;
  if (type.endsWith("_labeled")) return `${subject} is labeled${labelSuffix(trigger.labels)}`;
  if (type.endsWith("_commented")) return `${subject} is commented on`;
  if (type.endsWith("_updated")) return `${subject} is updated`;
  if (type.endsWith("_merged")) {
    return trigger.targetBranch ? `${subject} is merged into ${trigger.targetBranch}` : `${subject} is merged`;
  }
  if (type.endsWith("_review_submitted")) return `${subject} gets a review`;
  return `${subject} changes`;
}

function linearClause(type: string, trigger: AutomationTrigger): string {
  const where = trigger.team ? ` in ${trigger.team}` : trigger.project ? ` in ${trigger.project}` : "";
  if (type.endsWith("_created")) return `A Linear issue is created${where}`;
  if (type.endsWith("_updated")) return `A Linear issue is updated${where}`;
  if (type.endsWith("_assigned")) return `A Linear issue is assigned${where}`;
  if (type.endsWith("_status_changed")) {
    return trigger.stateTransition
      ? `A Linear issue moves ${trigger.stateTransition}`
      : `A Linear issue changes status${where}`;
  }
  if (type.endsWith("_labeled")) return `A Linear issue is labeled${labelSuffix(trigger.labels)}`;
  return `A Linear issue changes${where}`;
}

const ADE_ACTION_PHRASES: Record<string, string> = {
  "pr.addComment": "comment on the PR",
  "pr.createReview": "review the PR",
  "issue.setLabels": "label the issue",
  "issue.addLabels": "label the issue",
  "issue.close": "close the issue",
  "issue.addComment": "comment on the issue",
  "linear_sync.runSyncNow": "sync Linear",
};

function adeActionPhrase(action: AutomationAction): string {
  const domain = action.adeAction?.domain ?? "";
  const name = action.adeAction?.action ?? "";
  if (!domain || !name) return "run an action";
  return ADE_ACTION_PHRASES[`${domain}.${name}`] ?? `run ${domain}.${name}`;
}

function stepClause(action: AutomationAction): string | null {
  switch (action.type) {
    case "agent-session":
      return "run an agent";
    case "run-tests":
      return "run tests";
    case "run-command":
      return "run a command";
    case "predict-conflicts":
      return "predict conflicts";
    case "create-lane":
      return "create a lane";
    case "ade-action":
      return adeActionPhrase(action);
    case "lane-setup":
      return null;
    default:
      if ((action.type as string) === DELETE_LANE_ACTION_TYPE) return "clean up the lane";
      return null;
  }
}

function dispositionClause(disposition: AutomationOutputDisposition | undefined): string | null {
  switch (disposition) {
    case "open-pr-draft":
      return "open a draft PR";
    case "open-lane":
      return "open a lane";
    case "open-task":
      return "open a task";
    case "prepare-patch":
      return "prepare a patch";
    default:
      return null;
  }
}

export function buildRuleSentence(rule: RuleLike): RuleSentence {
  const trigger = triggerClause(primaryTrigger(rule));
  const steps: string[] = [];

  if (rule.execution?.laneMode === "create") steps.push("create a lane");

  if (rule.execution?.kind === "agent-session") {
    steps.push("run an agent");
  } else if (rule.execution?.kind === "built-in") {
    for (const action of rule.execution.builtIn?.actions ?? []) {
      const clause = stepClause(action);
      if (clause) steps.push(clause);
    }
  }

  const disposition = dispositionClause(rule.outputs?.disposition);
  if (disposition) steps.push(disposition);

  if (!steps.length) steps.push("do nothing yet");

  return { trigger, steps };
}
