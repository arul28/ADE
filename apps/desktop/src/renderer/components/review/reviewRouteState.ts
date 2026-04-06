export function readReviewRunId(search: string): string | null {
  const params = new URLSearchParams(search);
  const runId = params.get("runId")?.trim();
  return runId && runId.length > 0 ? runId : null;
}

export function buildReviewSearch(runId: string | null): string {
  const params = new URLSearchParams();
  const trimmedRunId = runId?.trim();
  if (trimmedRunId) params.set("runId", trimmedRunId);
  const next = params.toString();
  return next.length ? `?${next}` : "";
}
