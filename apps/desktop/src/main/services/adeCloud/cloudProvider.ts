/**
 * What ADE Cloud needs from whoever runs the computers.
 *
 * Everything above this interface (machines, sleep, lanes, hours,
 * sign-ins) is ADE's and knows nothing about who runs the computers. The one
 * implementation talks to ADE's server (`cloudServerProvider.ts`), which holds
 * the provider's key; a lint rule keeps it from being imported anywhere but
 * `cloudAccess.ts`.
 */

import type { CloudAccountState, CloudDiskLaneUse, CloudDiskUsageReport, CloudFreeUnlockResult, CloudSustainedCpuReport } from "../../../shared/adeCloud";
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
  CloudFreeRecord,
  CloudMoveRecord,
  CloudMoveRequest,
  CloudPaidPlanId,
  CloudPhoneDevice,
  CloudPhoneStart,
  CloudPhoneState,
  CloudPhoneView,
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
    /**
     * A disk refusal's `error.reason` (`CloudDiskRefusalReason`) and, at the
     * account's limit, the computers that hold its disk (servers before it send none).
     */
    readonly detail: { reason: string | null; lanes?: CloudDiskLaneUse[] } = { reason: null },
  ) {
    super(message);
    this.name = "CloudProviderError";
  }
}

/** `GET /cloud/access`: `enabled: false` with `readOnly` and the server's sentence for a blocked account. */
export type CloudAccessAnswer = { enabled: boolean; readOnly: boolean; reason: string | null };

export type CloudProvider = {
  /** Whether this account has ADE Cloud at all. */
  accessEnabled(): Promise<boolean>;
  /**
   * The same answer with the server's reason when the account can only read
   * (blocked). Servers before the reason send only `enabled`.
   */
  accessAnswer?(): Promise<CloudAccessAnswer>;
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
  /**
   * The machine asks to be slept (idle three minutes); the server stops instead at 0 hours. `backupReportId`
   * names the lane backup report it made just before: it rests with those backups. Answers with the new status.
   */
  requestIdleSleep(id: string, options?: { backupReportId?: string | null }): Promise<string>;
  /**
   * "Keep it" on an idle cleanup warning (`POST .../keep`): the idle clock
   * restarts with no wake and no hours. Optional: only ADE's server has it.
   */
  keepIdleComputer?(id: string): Promise<void>;
  /** Wakes a sleeping machine or starts a stopped one. Every wake is use; none is allowed at 0 hours. Answers with the new status. */
  startInstance(id: string): Promise<string>;
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
  /** The computer's own report of hours near full CPU with no chat turn or agent working (the owner's daily report). */
  reportSustainedCpu?(id: string, report: CloudSustainedCpuReport): Promise<void>;
  /** Changes the size in place: the machine restarts, files stay, the disk only grows. */
  /** `origin: "auto"` marks the computer's own disk grower, for the server's analytics. */
  /**
   * `origin: "auto"`: the computer's own grow or move, not a person's. With
   * `launchId` it is that server launch's setup moving its own computer up a
   * size (`CLOUD_AUTO_SIZE`); the server refuses it with 409 `size_kept` when
   * the launch's size was picked, the agent limits keep it, or it moved once.
   */
  resizeInstance(id: string, resources: { cpu?: number; memory?: number; disk?: number }, options?: { computerIdle?: boolean; origin?: "auto"; launchId?: string }): Promise<string>;
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
  /**
   * A move to the other kind, run by ADE's server (`POST /cloud/instances/:id/move`):
   * it answers at once and goes on with no app open; `readMove` follows it,
   * `cancelMove` stops it before the copy. Only ADE's server has them; an
   * older one answers 404, and the server answers 409
   * `server_move_unavailable` until its computers can run one.
   */
  startMove?(id: string, input: CloudMoveRequest): Promise<CloudMoveRecord>;
  readMove?(moveId: string): Promise<CloudMoveRecord>;
  cancelMove?(moveId: string): Promise<CloudMoveRecord>;
  /**
   * Frees a computer (its lane kept), run by ADE's server (`POST /cloud/instances/:id/free`):
   * it pushes every lane's work, checks it again and deletes the computer with no app open;
   * `readFree` follows it. An older server answers 404.
   */
  startFree?(id: string, freeId: string): Promise<CloudFreeRecord>;
  readFree?(freeId: string): Promise<CloudFreeRecord>;
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
  /**
   * Save a card with no charge so a GitHub account younger than 30 days gets
   * the free hours now: Stripe's page to open, or `unlocked` when a card on
   * file already did it. Older servers answer 404.
   */
  billingFreeUnlock?(): Promise<CloudFreeUnlockResult>;
  /** Paid accounts only; extra hours are off by default. */
  setExtraHours(enabled: boolean): Promise<CloudAccountState>;
  /** Paid accounts only: extra disk on with a monthly limit in whole dollars, or off. */
  setExtraDisk(choice: { enabled: true; monthlyLimitUsd: number } | { enabled: false }): Promise<CloudAccountState>;
  /** Paid accounts only: extra ADE Cloud iPhone minutes on, with an optional monthly limit in whole dollars, or off. */
  setExtraPhoneMinutes?(choice: { enabled: true; monthlyLimitUsd: number | null } | { enabled: false }): Promise<CloudAccountState>;
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
  /** The ADE Cloud iPhone (`/cloud/phone`): who may use it, the plan's minutes, the live phone. */
  phoneState?(): Promise<CloudPhoneState>;
  /** Starts the account's phone, or answers its live one, with a token for that phone only. */
  phoneStart?(input: { device?: CloudPhoneDevice }): Promise<CloudPhoneStart>;
  /** A link that shows the live phone to this account alone. */
  phoneView?(input: { control: boolean }): Promise<CloudPhoneView>;
  phoneStop?(): Promise<{ stopped: boolean }>;
  /**
   * The account this client acts for (`cloudAccessKey`), when it knows it. A
   * client is made per call, so this, not the object, says two are the same
   * account (a held cloud iPhone belongs to one).
   */
  readonly account?: string;
};
