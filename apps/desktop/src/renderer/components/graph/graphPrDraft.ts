export function mergeGeneratedPrDraft<T extends { laneId: string; title: string; body: string }>(
  prev: T | null,
  laneId: string,
  draft: { title: string; body: string },
  baseline: { title: string; body: string },
): T | null {
  if (!prev || prev.laneId !== laneId) return prev;
  return {
    ...prev,
    title: prev.title === baseline.title ? draft.title : prev.title,
    body: prev.body === baseline.body ? draft.body : prev.body,
  };
}
