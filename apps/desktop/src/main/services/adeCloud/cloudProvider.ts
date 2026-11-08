/**
 * What ADE Cloud needs from whoever runs the computers.
 *
 * Everything above this interface (machines, sleep, ready machines, spending,
 * sign-ins) is ADE's and knows nothing about the provider. The one provider
 * today is in `provider/agent37/`; a lint rule keeps its client from being
 * imported anywhere but `cloudAccess.ts`.
 */

/** What the ADE Cloud services log through: a `cloud.*` event and its fields, never a credential. */
export type CloudLogger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
};

export type CloudInstance = {
  id: string;
  name: string | null;
  status: string;
  template: string | null;
  type: string | null;
  region: string | null;
  resources: { cpu: number; memory: number; disk: number } | null;
  url: string | null;
  pastDue: boolean;
  created: number | null;
  /** Why the last lifecycle action failed; null when nothing failed. */
  statusReason: { code: string | null; message: string | null } | null;
  /**
   * What ADE set at create: tagged with `ade_request_id`, and with
   * `ade_machine_key` once the machine joins.
   */
  metadata: Record<string, string>;
  /** The provider's own idle sleep: on, and after how many seconds with no traffic through the machine's URLs. */
  autoSleep: boolean;
  idleTimeoutSeconds: number | null;
  /** The machine's public ports (unauthenticated URLs); ADE's wake URL is one of them. */
  publicPorts: Array<{ port: number; url: string; label: string | null }>;
};

/** What the account spent per instance over a window. */
export type CloudUsage = {
  /** First and last UTC day covered, `YYYY-MM-DD`. */
  from: string | null;
  to: string | null;
  /** US dollars per instance id. Instances that spent nothing are absent. */
  byInstance: Record<string, number>;
  /** US dollars per UTC day (`YYYY-MM-DD`), the whole account. */
  byDay: Record<string, number>;
};

export type CloudExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CloudCreateInstanceInput = {
  template: string;
  name: string;
  type: "default" | "vm";
  resources: { cpu: number; memory: number; disk: number };
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  /** Unauthenticated URLs to make with the machine (ADE's wake URL). */
  publicPorts?: Array<{ port: number; label: string }>;
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
  listInstances(): Promise<CloudInstance[]>;
  getInstance(id: string): Promise<CloudInstance>;
  /** Resolves once the machine is running. `signal` stops waiting; the caller finds the machine by its `ade_request_id` tag and deletes it. */
  createInstance(input: CloudCreateInstanceInput, signal?: AbortSignal): Promise<CloudInstance>;
  deleteInstance(id: string): Promise<void>;
  /** Checkpoints a running machine: memory and processes kept. Answers with the new status. */
  sleepInstance(id: string): Promise<string>;
  /** Wakes a sleeping machine or starts a stopped one. Answers with the new status. */
  startInstance(id: string): Promise<string>;
  /** Changes the size in place: the machine restarts, files stay, the disk only grows. */
  resizeInstance(id: string, resources: { cpu: number; memory: number; disk?: number }): Promise<string>;
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
  /** What each instance spent in the window (at most 90 days). */
  usage(window: { from: string; to?: string }): Promise<CloudUsage>;
  hasTemplate(name: string): Promise<boolean>;
  /** Runs `sh -c command` on the machine. A non-zero exit is a result, not an error. Wakes a sleeping machine. */
  exec(id: string, command: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CloudExecResult>;
};

/** The longest provider call (a backup) plus a minute for the reads around it. */
export const CLOUD_MACHINE_ACTION_IPC_TIMEOUT_MS = 16 * 60_000;
/** The machine list reads the machines, then the usage: two request budgets. */
export const CLOUD_LIST_MACHINES_IPC_TIMEOUT_MS = 50_000;

/** `YYYY-MM-DD` in UTC, the form the usage window takes. */
export function cloudUsageDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
