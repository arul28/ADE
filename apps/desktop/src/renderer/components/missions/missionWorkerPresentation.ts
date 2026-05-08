import type { MissionRunViewWorkerSummary } from "../../../shared/types";

const WORKER_STATUS_RANK: Record<MissionRunViewWorkerSummary["status"], number> = {
  active: 0,
  blocked: 1,
  idle: 2,
  completed: 3,
  failed: 4,
};

function workerStepIdentity(worker: MissionRunViewWorkerSummary): string | null {
  return worker.stepId ?? worker.stepKey ?? null;
}

function workerRecency(worker: MissionRunViewWorkerSummary): number {
  const stamps = [worker.completedAt, worker.lastHeartbeatAt]
    .map((stamp) => (stamp ? Date.parse(stamp) : Number.NaN))
    .filter((stamp) => Number.isFinite(stamp));
  return stamps.length ? Math.max(...stamps) : 0;
}

function compareCurrentWorkerCandidate(
  left: MissionRunViewWorkerSummary,
  right: MissionRunViewWorkerSummary,
): number {
  const leftRank = WORKER_STATUS_RANK[left.status] ?? 5;
  const rightRank = WORKER_STATUS_RANK[right.status] ?? 5;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return workerRecency(right) - workerRecency(left);
}

export function selectCurrentMissionWorkers(
  workers: MissionRunViewWorkerSummary[],
): MissionRunViewWorkerSummary[] {
  const byStep = new Map<string, MissionRunViewWorkerSummary>();
  const ungrouped: MissionRunViewWorkerSummary[] = [];

  for (const worker of workers) {
    const stepIdentity = workerStepIdentity(worker);
    if (!stepIdentity) {
      ungrouped.push(worker);
      continue;
    }
    const existing = byStep.get(stepIdentity);
    if (!existing || compareCurrentWorkerCandidate(worker, existing) < 0) {
      byStep.set(stepIdentity, worker);
    }
  }

  return [...byStep.values(), ...ungrouped];
}

export function sortMissionWorkers(
  workers: MissionRunViewWorkerSummary[],
): MissionRunViewWorkerSummary[] {
  return [...workers].sort((left, right) => {
    const rankDiff =
      (WORKER_STATUS_RANK[left.status] ?? 5) - (WORKER_STATUS_RANK[right.status] ?? 5);
    if (rankDiff !== 0) return rankDiff;
    const recencyDiff = workerRecency(right) - workerRecency(left);
    if (recencyDiff !== 0) return recencyDiff;
    return (left.stepTitle ?? left.stepKey ?? "").localeCompare(right.stepTitle ?? right.stepKey ?? "");
  });
}
