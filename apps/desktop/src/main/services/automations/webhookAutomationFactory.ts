// One-step webhook automations: the arguments a person or an agent actually
// has ("a GitHub webhook that triages opened issues into this chat") turned
// into a complete rule draft, so nobody hand-writes trigger JSON. Shared by the
// `automations.webhookCreateAutomation` action and `ade automations webhook create`.

import type {
  AutomationRule,
  AutomationRuleDraft,
  AutomationWebhookDelivery,
  AutomationWebhookDeliverySummary,
  AutomationWebhookEndpoint,
  AutomationWebhookFilter,
  AutomationWebhookFilterOp,
  AutomationWebhookListEntry,
  AutomationWebhookPreset,
  AutomationWebhookTriggerConfig,
} from "../../../shared/types";
import { WEBHOOK_FILTER_OPS, WEBHOOK_PRESETS, describeWebhookFilter, webhookPresetDef } from "../../../shared/automationWebhooks";

export type WebhookAutomationCreateArgs = {
  name?: string | null;
  preset?: AutomationWebhookPreset | null;
  /** The agent's prompt. Omitted: the preset's suggested prompt. */
  prompt?: string | null;
  /**
   * "Only run when" conditions. Strings like `body.action=opened`,
   * `headers.x-github-event=issues`, `body.ref~main` (contains),
   * `body.deleted!=true`, `body.issue` (present), or full filter objects.
   * Omitted: the preset's suggested filters. `[]`: run on every request.
   */
  filters?: Array<string | AutomationWebhookFilter> | null;
  /** Require a signature (default: on for every preset except `generic`). */
  requireSignature?: boolean | null;
  /** Project secret holding the signing secret. Default: the preset's name. */
  secretName?: string | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
  /** Run every delivery as a new turn in this chat instead of a new chat each time. */
  chatSessionId?: string | null;
  /** The chat creating the rule; recorded as its origin. */
  originChatSessionId?: string | null;
  originChatTitle?: string | null;
  enabled?: boolean | null;
  /** Confirmation keys the planner asks for (see the error when one is missing). */
  confirmations?: string[] | null;
};

const FILTER_STRING = /^\s*([A-Za-z0-9_.\-]+)\s*(!=|=|~|\^=)?\s*(.*)$/;

/** `body.action=opened` → `{path, op: "equals", value}`. Throws on nonsense, with the accepted forms. */
export function parseWebhookFilter(raw: string | AutomationWebhookFilter): AutomationWebhookFilter {
  if (typeof raw !== "string") {
    if (!raw?.path?.trim() || !WEBHOOK_FILTER_OPS.includes(raw.op as AutomationWebhookFilterOp)) {
      throw new Error(`Filter ${JSON.stringify(raw)} needs a path and an op (${WEBHOOK_FILTER_OPS.join(", ")}).`);
    }
    return raw.op === "exists" ? { path: raw.path.trim(), op: "exists" } : { path: raw.path.trim(), op: raw.op, value: raw.value ?? "" };
  }
  const match = FILTER_STRING.exec(raw);
  const path = match?.[1]?.trim() ?? "";
  if (!match || !/^(body|headers|query)(\.|$)/.test(path)) {
    throw new Error(
      `Filter "${raw}" is not understood. Use body.<path>=value, headers.<name>=value, query.<name>=value, `
      + "!= for not equal, ~ for contains, ^= for a regex, or just the path to require it.",
    );
  }
  const operator = match[2];
  const value = (match[3] ?? "").trim();
  if (!operator) return { path, op: "exists" };
  const op: AutomationWebhookFilterOp = operator === "!=" ? "not_equals" : operator === "~" ? "contains" : operator === "^=" ? "matches" : "equals";
  return { path, op, value };
}

export function buildWebhookAutomationDraft(args: WebhookAutomationCreateArgs & { hookId: string; defaultModelId: string }): AutomationRuleDraft {
  const preset = webhookPresetDef(args.preset ?? "generic");
  const filters = args.filters == null ? preset.suggestedFilters.map((filter) => ({ ...filter })) : args.filters.map(parseWebhookFilter);
  const requireSignature = args.requireSignature ?? preset.value !== "generic";
  const webhook: AutomationWebhookTriggerConfig = {
    hookId: args.hookId,
    preset: preset.value,
    ...(requireSignature ? { signature: { ...preset.signature, secretName: args.secretName?.trim() || preset.secretName } } : {}),
    ...(filters.length ? { filters } : {}),
  };
  const trigger = { type: "webhook" as const, webhook };
  const chatSessionId = args.chatSessionId?.trim() || null;
  const originChat = args.originChatSessionId?.trim() || null;
  return {
    name: args.name?.trim() || `${preset.value === "generic" ? "Webhook" : preset.label} automation`,
    enabled: args.enabled ?? true,
    mode: "review",
    ...(originChat
      ? { origin: "chat-menu" as const, scope: { sessionId: originChat, sessionTitle: args.originChatTitle?.trim() || "Chat" } }
      : {}),
    triggers: [trigger],
    trigger,
    execution: { kind: "agent-session", session: chatSessionId ? { chatSessionId } : {} },
    executor: { mode: "automation-bot" },
    modelConfig: {
      modelId: args.modelId?.trim() || args.defaultModelId,
      thinkingLevel: (args.reasoningEffort?.trim() || "medium") as NonNullable<AutomationRuleDraft["modelConfig"]>["thinkingLevel"],
    },
    prompt: args.prompt?.trim() || preset.suggestedPrompt,
    reviewProfile: "quick",
    toolPalette: ["repo", "git"],
    contextSources: [],
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:webhook",
    actions: [],
    legacyActions: [],
  };
}

/** What to do next, in words a person (or an agent relaying to one) can follow. */
export type WebhookSetupGuide = {
  url: string | null;
  route: AutomationWebhookEndpoint["route"];
  /** Present when the URL is not public yet. */
  urlWarning: string | null;
  service: string;
  pasteSteps: string[];
  signature: {
    required: boolean;
    secretName: string | null;
    /** `you`: generate one (ADE can) and paste it into the service. `sender`: paste the service's into ADE. */
    secretSource: "you" | "sender";
    secretSaved: boolean;
  };
  filters: string[];
};

export function webhookSetupGuide(args: {
  endpoint: AutomationWebhookEndpoint;
  trigger: AutomationWebhookTriggerConfig;
  secretSaved: boolean;
}): WebhookSetupGuide {
  const preset = webhookPresetDef(args.trigger.preset);
  return {
    url: args.endpoint.url,
    route: args.endpoint.route,
    urlWarning: args.endpoint.route === "relay" || args.endpoint.route === "gateway" ? null : args.endpoint.setupError,
    service: preset.value === "generic" ? "the service" : preset.label,
    pasteSteps: preset.steps,
    signature: {
      required: Boolean(args.trigger.signature),
      secretName: args.trigger.signature?.secretName ?? null,
      secretSource: preset.secretSource,
      secretSaved: args.secretSaved,
    },
    filters: (args.trigger.filters ?? []).map(describeWebhookFilter),
  };
}

export function webhookTriggersOf(rule: AutomationRule): AutomationWebhookTriggerConfig[] {
  return (rule.triggers ?? []).flatMap((trigger) => (trigger.type === "webhook" && trigger.webhook ? [trigger.webhook] : []));
}

/** The webhook service's read side, as every surface that lists webhooks needs it. */
export type WebhookReads = {
  getEndpoint(args: { hookId: string }): Promise<AutomationWebhookEndpoint>;
  listDeliveries(args: { hookId: string; limit?: number }): AutomationWebhookDeliverySummary[];
  getDelivery(args: { id: string }): AutomationWebhookDelivery | null;
};

type ProjectSecretLister = { list(): { secrets: Array<{ name: string }> } };

/**
 * Names of the project's saved secrets, or none when they cannot be read (a
 * locked or unavailable store reads as "not saved", never as an error).
 */
export function listProjectSecretNames(projectSecrets: ProjectSecretLister | null | undefined): Set<string> {
  try {
    return new Set((projectSecrets?.list().secrets ?? []).map((secret) => secret.name));
  } catch {
    return new Set();
  }
}

/**
 * The read-only source behind the phone/web `automations.webhook*` remote
 * commands. Built the same way by the desktop main process and the CLI brain.
 * Null until the automation and webhook services exist.
 */
export function createWebhookRemoteSource(deps: {
  automationService: { list(): AutomationRule[] } | null | undefined;
  webhooks: WebhookReads | null | undefined;
  projectSecrets: ProjectSecretLister | null | undefined;
}) {
  const { automationService, webhooks } = deps;
  if (!webhooks || !automationService) return null;
  return {
    list: () => listWebhookAutomations({ rules: automationService.list(), webhooks, projectSecrets: deps.projectSecrets }),
    listDeliveries: (input: { hookId: string; limit?: number }) => webhooks.listDeliveries(input),
    getDelivery: (input: { id: string }) => webhooks.getDelivery(input),
  };
}

export const WEBHOOK_PRESET_NAMES = WEBHOOK_PRESETS.map((preset) => preset.value);

/**
 * Every webhook automation with its URL, secret state and last delivery. One
 * implementation for the `automations.webhookList` action (CLI, agents) and the
 * `automations.webhookList` remote command (phone, web client).
 */
export async function listWebhookAutomations(deps: {
  rules: AutomationRule[];
  webhooks: WebhookReads;
  projectSecrets: ProjectSecretLister | null | undefined;
}): Promise<AutomationWebhookListEntry[]> {
  const secretNames = listProjectSecretNames(deps.projectSecrets);
  const entries: AutomationWebhookListEntry[] = [];
  for (const rule of deps.rules) {
    for (const trigger of webhookTriggersOf(rule)) {
      const endpoint = await deps.webhooks.getEndpoint({ hookId: trigger.hookId });
      const last = deps.webhooks.listDeliveries({ hookId: trigger.hookId, limit: 1 })[0] ?? null;
      const secretName = trigger.signature?.secretName ?? null;
      entries.push({
        ruleId: rule.id,
        ruleName: rule.name,
        enabled: rule.enabled,
        hookId: trigger.hookId,
        preset: trigger.preset ?? "generic",
        url: endpoint.url,
        route: endpoint.route,
        ownedHere: endpoint.ownedHere,
        signatureRequired: Boolean(trigger.signature),
        secretName,
        secretSaved: Boolean(secretName && secretNames.has(secretName)),
        filters: (trigger.filters ?? []).map(describeWebhookFilter),
        chatSessionId: rule.execution?.session?.chatSessionId ?? null,
        lastDelivery: last
          ? { id: last.id, outcome: last.outcome, receivedAt: last.receivedAt, eventLabel: last.eventLabel, detail: last.detail }
          : null,
      });
    }
  }
  return entries;
}
