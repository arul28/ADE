import type { ChatLaunchStage, OpenProjectBinding } from "./types";

/**
 * The CTO's home on ADE Cloud: one small computer per repository, made on a
 * paid plan only, that the CTO lives on when the person picks "ADE Cloud" as
 * its home (`main/services/adeCloud/ctoCloudHomeService.ts`).
 *
 * Three steps (make the computer, join the account, clone the repository), the
 * way Settings' "New cloud machine" makes a computer, with no lane on it. The
 * CTO page then records it as the home and the CTO restores from the account
 * copy.
 */

/** Metadata that marks the computer as a CTO's home; its value is "1". */
export const CTO_CLOUD_HOME_METADATA = "ade_cto_home";

export const CTO_CLOUD_HOME_NEEDS_PAID_PLAN = "ADE Cloud as the CTO's home needs a paid plan. Upgrade to use it.";
export const CTO_CLOUD_HOME_NEEDS_GITHUB = "The CTO can live on ADE Cloud only for a GitHub repository.";

export type CtoCloudHomePhase = "running" | "failed" | "ready" | "cancelled";

export type CtoCloudHomeSnapshot = {
  jobId: string;
  /** `github.com/owner/repo`. */
  projectOrigin: string;
  phase: CtoCloudHomePhase;
  /** `computer`, `join` and `clone`, in order. */
  stages: ChatLaunchStage[];
  error: string | null;
  /** What GitHub's check could not settle (a private repo may not clone). */
  warning: string | null;
  computerName: string;
  instanceId: string | null;
  machineKey: string | null;
  /** The project on the computer, once cloned: the pin for every CTO call there. */
  binding: (OpenProjectBinding & { kind: "remote" }) | null;
  /** This app's saved connection to the computer. */
  targetId: string | null;
  /** True when an earlier CTO computer for this repository was found and reused. */
  reused: boolean;
  updatedAt: string;
};

/** What each `IPC.ctoCloudHomeCall` method takes. */
export type CtoCloudHomeCallArgs = {
  start: { originUrl: string | null };
  get: { originUrl: string | null };
  retry: { jobId: string };
  cancel: { jobId: string };
  /** The CTO page recorded the computer as the home: the job is done with. */
  finish: { jobId: string };
};

export type CtoCloudHomeMethod = keyof CtoCloudHomeCallArgs;

/** What each `IPC.ctoCloudHomeCall` method answers (`ctoCloudHomeService.ts`). */
export type CtoCloudHomeCallResult = {
  start: CtoCloudHomeSnapshot;
  get: CtoCloudHomeSnapshot | null;
  retry: CtoCloudHomeSnapshot | null;
  cancel: CtoCloudHomeSnapshot | null;
  finish: boolean;
};

export type CtoCloudHomeCallRequest = {
  [K in CtoCloudHomeMethod]: { method: K; args: CtoCloudHomeCallArgs[K] };
}[CtoCloudHomeMethod];

export type CtoCloudHomeEvent =
  | { type: "updated"; snapshot: CtoCloudHomeSnapshot }
  | { type: "removed"; jobId: string; projectOrigin: string };
