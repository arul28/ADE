import type { AutomationTriggerType } from "../../../shared/types/config";
import type { CursorCloudIngressEventRecord } from "./cursorCloudIngressService";

export type CursorCloudAutomationDispatch = {
  source: "cursor-relay";
  eventKey: string;
  triggerType: AutomationTriggerType;
  eventName?: string | null;
  summary?: string | null;
  branch?: string | null;
  rawPayload?: Record<string, unknown> | null;
};

function normalizeStatus(status: string): "FINISHED" | "ERROR" | null {
  const upper = status.trim().toUpperCase();
  if (upper === "FINISHED") return "FINISHED";
  if (upper === "ERROR") return "ERROR";
  return null;
}

/**
 * Map a Cursor Cloud relay statusChange into automations trigger dispatches.
 * Only ERROR and FINISHED fire rules. The trigger type is never "auto".
 */
export function buildCursorCloudAutomationDispatches(
  event: CursorCloudIngressEventRecord,
): CursorCloudAutomationDispatch[] {
  const status = normalizeStatus(event.status);
  if (!status) return [];
  const triggerType: AutomationTriggerType = status === "ERROR"
    ? "cursor.cloud_error"
    : "cursor.cloud_finished";
  return [{
    source: "cursor-relay",
    eventKey: event.eventId,
    triggerType,
    eventName: "statusChange",
    summary: event.summary,
    branch: event.branchName,
    rawPayload: event.payload,
  }];
}
