// Apart from `chatAutoResume` so the session-status presentation that the app
// loads at startup does not pull in the subagent and background-work models.

/**
 * `armed` becomes `resuming` the moment the row is due: the scheduler will not
 * push a prompt into a live turn, so a due row can sit waiting for the turn
 * boundary for as long as that turn runs. Derived at read time rather than
 * stored, so no client has to wait for a state event to stop counting down.
 */
export function resolveUsageLimitResumeState<
  T extends { state: string; fireAt: string | null },
>(resume: T | null | undefined, nowMs: number = Date.now()): T | null {
  if (!resume) return null;
  if (resume.state !== "armed" || !resume.fireAt) return resume;
  const fireAt = Date.parse(resume.fireAt);
  if (!Number.isFinite(fireAt) || fireAt > nowMs) return resume;
  return { ...resume, state: "resuming" };
}
