import type {
  AgentChatEventEnvelope,
  AgentChatMissionFeature,
  AgentChatMissionProgressEntry,
  AgentChatMissionState,
} from "../../../shared/types";

/**
 * Consolidated Droid AGI mission state for the Missions tab, reconstructed from
 * the chat event stream. `mission_state` / `mission_features` / `mission_progress`
 * events each carry the *full current* value (not deltas), so we simply take the
 * latest of each. Returns null when the chat has no mission activity (i.e. not a
 * Droid AGI session, or AGI session before a mission is proposed).
 */
export type MissionSnapshot = {
  state: AgentChatMissionState | null;
  features: AgentChatMissionFeature[];
  progress: AgentChatMissionProgressEntry[];
};

export function deriveMissionSnapshot(events: AgentChatEventEnvelope[]): MissionSnapshot | null {
  let state: AgentChatMissionState | null = null;
  let features: AgentChatMissionFeature[] = [];
  let progress: AgentChatMissionProgressEntry[] = [];
  let seen = false;

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "mission_state") {
      state = event.state;
      seen = true;
    } else if (event.type === "mission_features") {
      features = event.features;
      seen = true;
    } else if (event.type === "mission_progress") {
      progress = event.entries;
      seen = true;
    }
  }

  if (!seen) return null;
  return { state, features, progress };
}

const FEATURE_STATUS_WEIGHT: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
};

/** Stable display order: active features first, then queued, done, cancelled. */
export function orderMissionFeatures(features: AgentChatMissionFeature[]): AgentChatMissionFeature[] {
  return [...features].sort(
    (left, right) => (FEATURE_STATUS_WEIGHT[left.status] ?? 1) - (FEATURE_STATUS_WEIGHT[right.status] ?? 1),
  );
}

export function missionFeatureCounts(features: AgentChatMissionFeature[]): {
  total: number;
  completed: number;
  inProgress: number;
} {
  let completed = 0;
  let inProgress = 0;
  for (const feature of features) {
    if (feature.status === "completed") completed += 1;
    else if (feature.status === "in_progress") inProgress += 1;
  }
  return { total: features.length, completed, inProgress };
}
