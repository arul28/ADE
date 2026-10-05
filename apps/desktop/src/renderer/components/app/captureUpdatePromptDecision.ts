import type { AutoUpdateSnapshot } from "../../../shared/types";

export type UpdatePromptUserAction = "accepted" | "deferred" | "dismissed";

export function captureUpdatePromptDecision(
  snapshot: Pick<AutoUpdateSnapshot, "currentVersion" | "version">,
  userAction: UpdatePromptUserAction,
  options?: { resumeChats?: boolean },
): void {
  if (!snapshot.version) return;
  const resumeChats = userAction === "accepted" ? options?.resumeChats : undefined;
  void window.ade.analytics?.capture({
    event: "ade_update_prompted",
    properties: {
      from_version: snapshot.currentVersion,
      to_version: snapshot.version,
      user_action: userAction,
      // Only meaningful on accept: whether the user kept the checkbox that
      // resumes the chats this restart interrupts.
      ...(resumeChats === undefined ? {} : { resume_chats: resumeChats }),
    },
    dedupeKey: `update_prompt:${snapshot.currentVersion}:${snapshot.version}:${userAction}`,
    minimumIntervalMs: 24 * 60 * 60_000,
  }).catch(() => undefined);
}
