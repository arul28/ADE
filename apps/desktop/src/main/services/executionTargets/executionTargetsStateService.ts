import type { AdeDb } from "../state/kvDb";
import type { AdeExecutionTargetsState } from "../../../shared/types";
import { defaultExecutionTargetsState, normalizeExecutionTargetsState } from "../../../shared/types";

function keyForProject(projectId: string): string {
  return `ade_execution_targets:${projectId}`;
}

export function getExecutionTargetsState(db: AdeDb | null, projectId: string): AdeExecutionTargetsState {
  const pid = projectId.trim();
  if (!db || !pid.length) return defaultExecutionTargetsState();
  const raw = db.getJson<unknown>(keyForProject(pid));
  return normalizeExecutionTargetsState(raw);
}

export function setExecutionTargetsState(
  db: AdeDb | null,
  projectId: string,
  next: AdeExecutionTargetsState,
): AdeExecutionTargetsState {
  const pid = projectId.trim();
  if (!db || !pid.length) return defaultExecutionTargetsState();
  const normalized = normalizeExecutionTargetsState(next);
  db.setJson(keyForProject(pid), normalized);
  return normalized;
}
