import type { AutomationActionResult, AutomationRun, AutomationTestRunInfo } from "../../../../shared/types";

/** The `test` record a test run carries on its trigger metadata, or null for a real run. */
export function readTestRunInfo(run: Pick<AutomationRun, "triggerMetadata">): AutomationTestRunInfo | null {
  const raw = run.triggerMetadata?.test;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Partial<AutomationTestRunInfo>;
  if (record.mode !== "safe" && record.mode !== "live") return null;
  return {
    mode: record.mode,
    event: typeof record.event === "string" ? record.event : null,
    lanes: Array.isArray(record.lanes)
      ? record.lanes.filter((lane): lane is { id: string; name: string } => typeof lane?.id === "string")
      : [],
    cleanedUpAt: typeof record.cleanedUpAt === "string" ? record.cleanedUpAt : null,
  };
}

export function testRunLabel(info: AutomationTestRunInfo): string {
  return info.mode === "safe" ? "Safe test" : "Live test";
}

/** One or two sentences on what a test did, read from its step results. */
export function summarizeTestRun(info: AutomationTestRunInfo, actions: AutomationActionResult[]): string {
  const steps = actions.filter((action) => action.actionType !== "lane-setup");
  const reported = steps.filter((action) => action.status === "skipped" && (action.output ?? "").startsWith("Test: ")).length;
  const ran = steps.filter((action) => action.status === "succeeded" || action.status === "failed").length;
  const event = info.event ? ` with ${info.event}` : "";
  const parts = [
    info.mode === "safe"
      ? `Safe test${event}. It ran ${ran} step${ran === 1 ? "" : "s"} in a throwaway lane`
        + (reported ? ` and only reported ${reported} that would post, push, or change things outside the test.` : ".")
      : `Live test${event}. It ran like a real run, and its notifications said [Test].`,
  ];
  if (info.lanes.length) {
    const names = info.lanes.map((lane) => `"${lane.name}"`).join(", ");
    const one = info.lanes.length === 1;
    parts.push(info.cleanedUpAt ? `It made ${names}, which ${one ? "is" : "are"} cleaned up.` : `It made ${names}.`);
  }
  return parts.join(" ");
}
