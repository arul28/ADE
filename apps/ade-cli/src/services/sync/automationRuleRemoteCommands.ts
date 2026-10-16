import type {
  AutomationRuleDraft,
  AutomationRuleSummary,
  AutomationSaveDraftRequest,
  AutomationSaveDraftResult,
} from "../../../../desktop/src/shared/types/automations";
import type { SyncRemoteCommandAction, SyncRemoteCommandPolicy } from "../../../../desktop/src/shared/types/sync";

/**
 * `automations.list` / `automations.saveDraft` / `automations.deleteRule` for
 * the phone's session menu ("Hand off ▸ Auto handoff…"). They run the same
 * service methods the desktop menu reaches through the action bus
 * (`automations.list`, `automation_planner.saveDraft`,
 * `automations.deleteRule`), so a rule armed from the phone is the rule the
 * desktop editor reads back.
 *
 * Writes are narrowed to what that menu makes: a chat-menu draft whose every
 * action is a handoff, and deletes of the `auto-handoff-*` ids it derives. A
 * paired phone can already start and steer chats, but it has no automation
 * editor, so a general rule writer here would be power no screen asked for.
 */
export type AutomationRuleRemoteSource = {
  list(): AutomationRuleSummary[];
  saveDraft(req: AutomationSaveDraftRequest): AutomationSaveDraftResult;
  deleteRule(args: { id: string }): AutomationRuleSummary[];
};

export const AUTOMATION_RULE_REMOTE_COMMAND_ACTIONS = [
  "automations.list",
  "automations.saveDraft",
  "automations.deleteRule",
] as const satisfies readonly SyncRemoteCommandAction[];

/** Rule writes must reach the live brain; a replayed save could resurrect a rule the user removed since. */
const POLICY: SyncRemoteCommandPolicy = { viewerAllowed: true, queueable: false };

const AUTO_HANDOFF_RULE_ID_PREFIX = "auto-handoff-";

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function parseAutoHandoffDraft(payload: Record<string, unknown>): AutomationSaveDraftRequest {
  const draft = payload.draft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new Error("automations.saveDraft requires a draft.");
  }
  const candidate = draft as AutomationRuleDraft;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const actions = Array.isArray(candidate.actions) ? candidate.actions : [];
  // `legacyActions` and `execution` decide what a run does too, so they are
  // held to the same bar: handoffs only, run by ADE itself (never an agent).
  const legacyActions = candidate.legacyActions;
  const execution = candidate.execution;
  if (
    !id.startsWith(AUTO_HANDOFF_RULE_ID_PREFIX)
    || candidate.origin !== "chat-menu"
    || actions.length === 0
    || actions.some((action) => action?.type !== "handoff")
    || (legacyActions !== undefined
      && (!Array.isArray(legacyActions) || legacyActions.some((action) => action?.type !== "handoff")))
    || (execution !== undefined && execution !== null && execution?.kind !== "built-in")
  ) {
    throw new Error("Only auto-handoff rules can be saved from this device.");
  }
  return { draft: candidate };
}

export function createAutomationRuleRemoteCommandHandlers(source: AutomationRuleRemoteSource): Array<{
  action: (typeof AUTOMATION_RULE_REMOTE_COMMAND_ACTIONS)[number];
  policy: SyncRemoteCommandPolicy;
  handler: (payload: Record<string, unknown>) => Promise<unknown>;
}> {
  return [
    { action: "automations.list", policy: { viewerAllowed: true }, handler: async () => source.list() },
    {
      action: "automations.saveDraft",
      policy: POLICY,
      handler: async (payload) => source.saveDraft(parseAutoHandoffDraft(payload)),
    },
    {
      action: "automations.deleteRule",
      policy: POLICY,
      handler: async (payload) => {
        const id = requiredString(payload, "id");
        if (!id.startsWith(AUTO_HANDOFF_RULE_ID_PREFIX)) {
          throw new Error("Only auto-handoff rules can be removed from this device.");
        }
        // Idempotent: a rule that is already gone is the outcome the phone
        // asked for, so it gets the current list rather than an error it would
        // have to recognise by its wording.
        if (!source.list().some((rule) => rule.id === id)) return source.list();
        return source.deleteRule({ id });
      },
    },
  ];
}
