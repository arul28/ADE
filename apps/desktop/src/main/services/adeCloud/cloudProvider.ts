/**
 * What ADE Cloud needs from whoever runs the computers.
 *
 * Everything above this interface (machines, sleep, lanes, hours,
 * sign-ins) is ADE's and knows nothing about who runs the computers. The one
 * implementation talks to ADE's server (`cloudServerProvider.ts`), which holds
 * the provider's key; a lint rule keeps it from being imported anywhere but
 * `cloudAccess.ts`.
 */

import type { CloudAccountState, CloudDiskUsageReport } from "../../../shared/adeCloud";
import type {
  CloudSavedChatDeleteArgs,
  CloudSavedChatList,
  CloudSavedChatPage,
  CloudSavedChatReadArgs,
  CloudSavedChatsListArgs,
} from "../../../shared/cloudSavedChats";
import type {
  CloudCheckoutResult,
  CloudExecResult,
  CloudInstance,
  CloudInviteRedeemResult,
  CloudLaneWithoutComputer,
  CloudPaidPlanId,
  CloudPlanCleanupPick,
  CloudPlanId,
  CloudReferralSummary,
  CloudUpdateChannel,
  CloudUpdateCheck,
} from "../../../../../account-directory/src/cloud/contract";

export type { CloudExecResult, CloudInstance, CloudLaneWithoutComputer, CloudUpdateChannel, CloudUpdateCheck };

/** What the ADE Cloud services log through: a `cloud.*` event and its fields, never a credential. */
export type CloudLogger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
};

export type CloudCreateInstanceInput = {
  name: string;
  type: "default" | "vm";
  /** One of the eight sizes. The server picks the disk and the image. */
  resources: { cpu: number; memory: number };
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  /** Unauthenticated URLs to make with the machine (ADE's wake URL). */
  publicPorts?: Array<{ port: number; label: string }>;
  /** The computer this one replaces in a move: the server gives this one the same disk. */
  moveFromInstanceId?: string;
  /** The update channel it follows. Left out, the provider sends the track of the app that makes it. */
  channel?: CloudUpdateChannel;
};

/** `code` on a `CloudProviderError` when the provider refused this computer's access. */
export const CLOUD_ACCESS_REFUSED = "access_refused";

export class CloudProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** A disk refusal's `error.reason` (`CloudDiskRefusalReason`). */
    readonly detail: { reason: string | null } = { reason: null },
  ) {
    super(message);
    this.name = "CloudProviderError";
  }
}

export type CloudProvider = {
  /** Whether this account has ADE Cloud at all. */
  accessEnabled(): Promise<boolean>;
  /** Plan, hours, disk and billing state (`/cloud/account`). */
  getAccount(): Promise<CloudAccountState>;
  listInstances(): Promise<CloudInstance[]>;
  getInstance(id: string): Promise<CloudInstance>;
  /** Resolves once the machine is running. `signal` stops waiting; the caller finds the machine by its `ade_request_id` tag and deletes it. */
  createInstance(input: CloudCreateInstanceInput, signal?: AbortSignal): Promise<CloudInstance>;
  /**
   * `reason` and `who` go in the server's delete log. `keepLane` keeps the
   * lane the computer was made for as a lane without a computer.
   */
  deleteInstance(id: string, context?: { who?: string | null; reason?: string; keepLane?: { branchRef: string | null } | null }): Promise<void>;
  /** The account's lanes whose computer is gone while the lane stays. Needs no wake. */
  listLanesWithoutComputer(): Promise<CloudLaneWithoutComputer[]>;
  /** Ends a lane without a computer (the person deleted the lane). True when there was one. */
  forgetLaneWithoutComputer(laneId: string): Promise<boolean>;
  /** Checkpoints a running machine: memory and processes kept. Answers with the new status. */
  sleepInstance(id: string): Promise<string>;
  /** The machine asks to be slept (idle three minutes); the server stops instead at 0 hours. Answers with the new status. */
  requestIdleSleep(id: string): Promise<string>;
  /** Wakes a sleeping machine or starts a stopped one. `push_work` is the one wake allowed at 0 hours. Answers with the new status. */
  startInstance(id: string, options?: { reason?: "push_work" }): Promise<string>;
  /** Stops the machine (no memory kept). Only an explicit start brings it back. */
  stopInstance(id: string): Promise<string>;
  /**
   * Moves the machine to its channel's ADE image: it restarts, and only its
   * home folder and caches outlive the system layer. `reason: "idle"` is the
   * computer updating itself from its idle step; the server runs it only when
   * the computer is behind, and answers the status it has then.
   */
  updateInstance(id: string, options?: { reason: "idle"; computerIdle: true }): Promise<string>;
  /** The computer asks whether it should update itself now. */
  checkForUpdate(id: string): Promise<CloudUpdateCheck>;
  /** The computer's brain started: settles a waiting update. `sleepWhenIdle`: it woke only for that update. */
  reportBooted(id: string, adeVersion: string | null): Promise<{ sleepWhenIdle: boolean }>;
  /** The computer's own report at its idle step: its last work and, now and then, what uses its disk. */
  reportDiskUsage?(id: string, report: CloudDiskUsageReport): Promise<void>;
  /** Changes the size in place: the machine restarts, files stay, the disk only grows. */
  /** `origin: "auto"` marks the computer's own disk grower, for the server's analytics. */
  resizeInstance(id: string, resources: { cpu: number; memory: number; disk?: number }, options?: { computerIdle?: boolean; origin?: "auto" }): Promise<string>;
  createBackup(id: string): Promise<{ id: string | null; created: number | null; sizeBytes: number | null }>;
  setAutoSleep(id: string, policy: { autoSleep: boolean; idleTimeoutSeconds?: number }): Promise<void>;
  addPublicPort(id: string, input: { port: number; label: string }): Promise<{ port: number; url: string }>;
  /** Copies the machine's disk into a new machine, which boots fresh. May answer while it is still provisioning. */
  forkInstance(
    id: string,
    input: { name?: string; resources?: { cpu: number; memory: number; disk?: number }; metadata?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<CloudInstance>;
  /** A time-boxed link to one port that needs no credential. A secret: never logged, and kept short. */
  signedUrl(id: string, input: { port: number; ttlSeconds: number }): Promise<{ url: string; expiresAt: number | null }>;
  setInstanceName(id: string, name: string): Promise<void>;
  /** Replaces the metadata (it is not merged). */
  setInstanceMetadata(id: string, metadata: Record<string, string>): Promise<void>;
  /** Whether the server can make a computer right now (its pinned image exists). */
  hasTemplate(): Promise<boolean>;
  /** Runs `sh -c command` on the machine. A non-zero exit is a result, not an error. Wakes a sleeping machine. */
  exec(id: string, command: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CloudExecResult>;
  /**
   * A Stripe checkout page for a plan (Plus when left out). On a paid account
   * asking for its other plan the server changes the plan itself and answers
   * `{ url: null, change }`.
   */
  billingCheckout(plan?: CloudPaidPlanId, cleanup?: CloudPlanCleanupPick): Promise<CloudCheckoutResult>;
  /**
   * The person's pick for an account already over a cheaper plan
   * (`POST /cloud/billing/plan-cleanup`): ADE frees exactly those computers,
   * their work pushed first when `push`. Answers the account after it.
   */
  pickPlanCleanup(input: { planId: CloudPlanId } & CloudPlanCleanupPick): Promise<CloudAccountState>;
  /** Stripe's billing portal for changing the card or cancelling. */
  billingPortal(): Promise<{ url: string }>;
  /** Paid accounts only; extra hours are off by default. */
  setExtraHours(enabled: boolean): Promise<CloudAccountState>;
  /** Paid accounts only: extra disk on with a monthly limit in whole dollars, or off. */
  setExtraDisk(choice: { enabled: true; monthlyLimitUsd: number } | { enabled: false }): Promise<CloudAccountState>;
  /** The account's invite link and what it earned (`/cloud/referrals`). Account-level. */
  readReferral(): Promise<CloudReferralSummary>;
  /**
   * Enters someone's invite: a pasted link or a bare code. A refusal throws a
   * `CloudProviderError` whose message is the sentence to show and whose
   * `detail.reason` is the `CloudInviteRefusalReason`.
   */
  redeemInvite(code: string): Promise<CloudInviteRedeemResult>;
  /** The account's saved chats. An account off the access list has none. */
  listSavedChats(args: CloudSavedChatsListArgs): Promise<CloudSavedChatList>;
  /** One page of a saved chat, or null when it can't be read. */
  readSavedChat(args: CloudSavedChatReadArgs): Promise<CloudSavedChatPage | null>;
  deleteSavedChat(args: CloudSavedChatDeleteArgs): Promise<void>;
};
