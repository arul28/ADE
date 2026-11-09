/**
 * What ADE Cloud needs from whoever runs the computers.
 *
 * Everything above this interface (machines, sleep, ready machines, hours,
 * sign-ins) is ADE's and knows nothing about who runs the computers. The one
 * implementation talks to ADE's server (`cloudServerProvider.ts`), which holds
 * the provider's key; a lint rule keeps it from being imported anywhere but
 * `cloudAccess.ts`.
 */

import type { CloudAccountState } from "../../../shared/adeCloud";
import type {
  CloudSavedChatDeleteArgs,
  CloudSavedChatList,
  CloudSavedChatPage,
  CloudSavedChatReadArgs,
  CloudSavedChatsListArgs,
} from "../../../shared/cloudSavedChats";
import type { CloudExecResult, CloudInstance } from "../../../../../account-directory/src/cloud/contract";

export type { CloudExecResult, CloudInstance };

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
};

/** `code` on a `CloudProviderError` when the provider refused this computer's access. */
export const CLOUD_ACCESS_REFUSED = "access_refused";

export class CloudProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
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
  /** `reason` and `who` go in the server's delete log. */
  deleteInstance(id: string, context?: { who?: string | null; reason?: string }): Promise<void>;
  /** Checkpoints a running machine: memory and processes kept. Answers with the new status. */
  sleepInstance(id: string): Promise<string>;
  /** The machine asks to be slept (idle three minutes); the server stops instead at 0 hours. Answers with the new status. */
  requestIdleSleep(id: string): Promise<string>;
  /** Wakes a sleeping machine or starts a stopped one. `push_work` is the one wake allowed at 0 hours. Answers with the new status. */
  startInstance(id: string, options?: { reason?: "push_work" }): Promise<string>;
  /** Stops the machine (no memory kept). Only an explicit start brings it back. */
  stopInstance(id: string): Promise<string>;
  /** Moves the machine to the current ADE image: it restarts, and only its home folder and caches outlive the system layer. */
  updateInstance(id: string): Promise<string>;
  /** Changes the size in place: the machine restarts, files stay, the disk only grows. */
  resizeInstance(id: string, resources: { cpu: number; memory: number; disk?: number }, options?: { computerIdle?: boolean }): Promise<string>;
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
  /** A Stripe checkout page for the paid plan. */
  billingCheckout(): Promise<{ url: string }>;
  /** Stripe's billing portal for changing the card or cancelling. */
  billingPortal(): Promise<{ url: string }>;
  /** Paid accounts only; extra hours are off by default. */
  setExtraHours(enabled: boolean): Promise<CloudAccountState>;
  /** The account's saved chats. An account off the access list has none. */
  listSavedChats(args: CloudSavedChatsListArgs): Promise<CloudSavedChatList>;
  /** One page of a saved chat, or null when it can't be read. */
  readSavedChat(args: CloudSavedChatReadArgs): Promise<CloudSavedChatPage | null>;
  deleteSavedChat(args: CloudSavedChatDeleteArgs): Promise<void>;
};
