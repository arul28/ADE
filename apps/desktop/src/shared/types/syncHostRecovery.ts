/**
 * Typed project-host readiness and conflict recovery. The brain-level ingress
 * can answer these while no project sync host owns the peer.
 *
 * Owner PIDs and socket paths belong in `technicalDetail` only. Cards use
 * `headline`, `body`, `ownerLabel`, and `projectLabel`.
 */
export type SyncHostOwnerKind = "installed" | "development" | "unknown";

export type SyncHostReadinessState = "ready" | "starting" | "conflict" | "unavailable";

export type SyncHostConflictPublic = {
  reason: "lock" | "listener";
  ownerKind: SyncHostOwnerKind;
  ownerLabel: string;
  projectLabel: string | null;
  impact: string | null;
  recoveryEligible: boolean;
  technicalDetail: string;
};

export type SyncHostReadinessSnapshot = {
  state: SyncHostReadinessState;
  headline: string;
  body: string;
  conflict: SyncHostConflictPublic | null;
  recoveryEligible: boolean;
};

export type SyncHostRecoveryStepId = "diagnose" | "stop" | "wait" | "start" | "restart" | "prove";

export type SyncHostRecoveryStepStatus = "pending" | "active" | "done" | "skipped" | "failed";

export type SyncHostRecoveryStep = {
  id: SyncHostRecoveryStepId;
  status: SyncHostRecoveryStepStatus;
  detail?: string;
};

export type SyncHostRecoveryResult = {
  operationId: string;
  ok: boolean;
  status: "idle" | "running" | "succeeded" | "failed" | "restarting";
  snapshot: SyncHostReadinessSnapshot;
  steps: SyncHostRecoveryStep[];
  message: string;
};

export const SYNC_HOST_DIAGNOSE_ACTION = "sync.diagnoseHost";
export const SYNC_HOST_RECOVER_ACTION = "sync.recoverHost";

/**
 * What an unauthorized peer receives instead of the owner's identity. It is the
 * one signal that separates "this device may not stop it" from "ADE cannot
 * identify it safely", which the recovery surfaces answer differently.
 * `apps/ade-cli/src/services/sync/syncHostRecovery.ts` produces this exact text.
 */
export const SYNC_HOST_REDACTED_CONFLICT_DETAIL =
  "Runtime ownership details are available only to an authorized device.";

/**
 * The conflict copy every surface shows. The CLI brain authors it, and the
 * clients rebuild it when a `host_unavailable` error names a conflict without
 * carrying a full snapshot — so both read it from here.
 * `apps/ios/ADE/Views/Hub/ProjectHostRecoveryScreen.swift` mirrors these.
 */
export const SYNC_HOST_CONFLICT_HEADLINE = "Another ADE is blocking this machine";
export const SYNC_HOST_CONFLICT_BODY =
  "Another ADE runtime is using the connection your phone needs.";
export const SYNC_HOST_CONFLICT_BODY_DEV =
  "A development runtime is using the connection your phone needs.";
