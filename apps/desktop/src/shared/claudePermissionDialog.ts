import type { PendingInputOption } from "./types/chat";

/**
 * Elevated-risk Claude permission asks (`default_to_no` on the SDK canUseTool
 * options) must not pre-select Allow and must not offer a session-wide
 * always-allow. Ordinary asks keep the existing recommended Allow + session
 * override.
 */
export function claudeToolNeedsDefaultToNo(sdkOptions: unknown): boolean {
  if (!sdkOptions || typeof sdkOptions !== "object" || Array.isArray(sdkOptions)) return false;
  const record = sdkOptions as Record<string, unknown>;
  return record.defaultToNo === true || record.default_to_no === true;
}

export function buildClaudeToolApprovalOptions(args: { defaultToNo: boolean }): PendingInputOption[] {
  if (args.defaultToNo) {
    return [
      { label: "Allow", value: "allow" },
      { label: "Deny", value: "deny" },
    ];
  }
  return [
    { label: "Allow", value: "allow", recommended: true },
    { label: "Allow for Session", value: "allow_session" },
    { label: "Deny", value: "deny" },
  ];
}
