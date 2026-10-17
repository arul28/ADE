import type {
  AutomationWebhookDelivery,
  AutomationWebhookDeliverySummary,
  AutomationWebhookListEntry,
} from "../../../../desktop/src/shared/types/automations";
import type { SyncRemoteCommandAction, SyncRemoteCommandPolicy } from "../../../../desktop/src/shared/types/sync";

/**
 * `automations.webhook*` remote commands: what a phone or the web client can
 * read about webhook automations. Read-only on purpose. Making, rotating or
 * retiring a URL, and replaying a delivery, start runs or change what a
 * service is pointed at; those stay on the desktop, the CLI and agents.
 * The owner's own devices already see the URL (it is theirs to paste), so a
 * viewer may read it.
 */
export type WebhookRemoteSource = {
  list(): Promise<AutomationWebhookListEntry[]>;
  listDeliveries(args: { hookId: string; limit?: number }): AutomationWebhookDeliverySummary[];
  getDelivery(args: { id: string }): AutomationWebhookDelivery | null;
};

export const WEBHOOK_REMOTE_COMMAND_ACTIONS = [
  "automations.webhookList",
  "automations.webhookListDeliveries",
  "automations.webhookGetDelivery",
] as const satisfies readonly SyncRemoteCommandAction[];

const READ_POLICY: SyncRemoteCommandPolicy = { viewerAllowed: true };

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

export function createWebhookRemoteCommandHandlers(source: WebhookRemoteSource): Array<{
  action: (typeof WEBHOOK_REMOTE_COMMAND_ACTIONS)[number];
  policy: SyncRemoteCommandPolicy;
  handler: (payload: Record<string, unknown>) => Promise<unknown>;
}> {
  return [
    { action: "automations.webhookList", policy: READ_POLICY, handler: async () => await source.list() },
    {
      action: "automations.webhookListDeliveries",
      policy: READ_POLICY,
      handler: async (payload) => {
        const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit) ? payload.limit : undefined;
        return source.listDeliveries({ hookId: requiredString(payload, "hookId"), ...(limit ? { limit } : {}) });
      },
    },
    {
      action: "automations.webhookGetDelivery",
      policy: READ_POLICY,
      handler: async (payload) => source.getDelivery({ id: requiredString(payload, "id") }),
    },
  ];
}
