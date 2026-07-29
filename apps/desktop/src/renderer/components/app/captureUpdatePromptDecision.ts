import type { AutoUpdateSnapshot } from "../../../shared/types";

export type UpdatePromptUserAction = "accepted" | "deferred" | "dismissed";

export function captureUpdatePromptDecision(
  snapshot: Pick<AutoUpdateSnapshot, "currentVersion" | "version">,
  userAction: UpdatePromptUserAction,
): void {
  if (!snapshot.version) return;
  void window.ade.analytics?.capture({
    event: "ade_update_prompted",
    properties: {
      from_version: snapshot.currentVersion,
      to_version: snapshot.version,
      user_action: userAction,
    },
    dedupeKey: `update_prompt:${snapshot.currentVersion}:${snapshot.version}:${userAction}`,
    minimumIntervalMs: 24 * 60 * 60_000,
  }).catch(() => undefined);
}
