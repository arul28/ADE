/**
 * ADE Cloud as a `CloudProvider`, through ADE's own server (the account
 * directory's `/cloud/*` routes, `apps/account-directory/src/cloud/contract.ts`).
 * The signed-in account token is the only credential: the provider's key lives
 * on the server and nothing on this computer ever sees it.
 *
 * The server answers errors as `{ error: { code, message } }` with `message`
 * already one plain sentence; that sentence is the error the person sees.
 */

import { readCloudPlanCleanup, readCloudReferralSummary, type CloudAccountState, type CloudFreeUnlockResult } from "../../../shared/adeCloud";
import {
  CLOUD_COMPUTER_HEADER,
  CLOUD_COMPUTER_PLATFORM_HEADER,
  CLOUD_PATHS,
  type CloudCheckoutResult,
  type CloudInviteRedeemResult,
  type CloudLaneWithoutComputer,
  type CloudReferralSummary,
} from "../../../../../account-directory/src/cloud/contract";
import {
  CLOUD_ACCESS_REFUSED,
  CloudProviderError,
  type CloudCreateInstanceInput,
  type CloudExecResult,
  type CloudInstance,
  type CloudProvider,
  type CloudUpdateChannel,
  type CloudUpdateCheck,
} from "./cloudProvider";
import { cloudSavedChatUrl, cloudSavedChatsUrl, type CloudSavedChatList, type CloudSavedChatPage } from "../../../shared/cloudSavedChats";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Under the 30 s an IPC call may wait, so a slow answer reads as ADE Cloud's, not the app's. */
const REQUEST_TIMEOUT_MS = 20_000;
/** A create returns once the computer is running, which takes tens of seconds. */
const CREATE_TIMEOUT_MS = 5 * 60_000;
/** Lifecycle calls answer once the computer reached its new state. */
const LIFECYCLE_TIMEOUT_MS = 3 * 60_000;
const BACKUP_TIMEOUT_MS = 15 * 60_000;
/** The server applies an exec's own timeout; this leaves room for its answer. */
const EXEC_RESPONSE_GRACE_MS = 10_000;

const INSTANCES = "/cloud/instances";

/** This computer's free-plan id (`CLOUD_COMPUTER_HEADER`) and its OS (`CLOUD_COMPUTER_PLATFORM_HEADER`). */
export type CloudComputerSignal = { id: string; platform: NodeJS.Platform };

export type CloudServerProviderDeps = {
  /** The signed-in account's token, or null when there is none now. */
  accessToken: () => Promise<string | null>;
  /** The account directory (`ADE_ACCOUNT_DIRECTORY_URL` points it at a local server in development). */
  baseUrl: () => string | null;
  /** Names this computer in the server's delete log. */
  deviceName?: () => string | null;
  /** The update track of the app that makes a computer (`stable` or `beta`), sent with each create. */
  updateChannel?: () => CloudUpdateChannel | null;
  /**
   * This computer's id for the free plan (one per physical computer), sent
   * with every call but the access check as `x-ade-computer`; `unreadable`
   * when the OS has none. Left out on an ADE Cloud computer, which never
   * claims a free plan.
   */
  computer?: () => Promise<CloudComputerSignal | null>;
  fetch?: FetchLike;
  logger?: { warn(event: string, meta?: Record<string, unknown>): void };
};

export type CloudDeleteContext = {
  who?: string | null;
  reason?: string;
  /** The lane the computer was made for stays, as a lane without a computer (`CloudLaneWithoutComputer`). */
  keepLane?: { branchRef: string | null } | null;
};

const BAD_RESPONSE = "ADE Cloud answered with something ADE could not read.";

function instancePath(id: string, action?: string): string {
  const base = `${INSTANCES}/${encodeURIComponent(id)}`;
  return action ? `${base}/${action}` : base;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readError(body: unknown): { code: string | null; message: string | null; reason: string | null } {
  const error = record(record(body)?.error);
  return {
    code: typeof error?.code === "string" ? error.code : null,
    message: typeof error?.message === "string" ? error.message : null,
    // A disk refusal's reason; a reason this build doesn't know still comes with `message`.
    reason: typeof error?.reason === "string" ? error.reason : null,
  };
}

function readInstance(body: unknown): CloudInstance {
  const instance = record(body);
  if (typeof instance?.id !== "string" || !instance.id) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
  return {
    ...instance,
    metadata: record(instance.metadata) as Record<string, string> ?? {},
    publicPorts: Array.isArray(instance.publicPorts) ? instance.publicPorts : [],
  } as CloudInstance;
}

function statusOf(body: unknown, fallback: string): string {
  const status = record(body)?.status;
  return typeof status === "string" ? status : fallback;
}

export function createCloudServerProvider(deps: CloudServerProviderDeps): CloudProvider {
  const fetcher: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));

  async function request(
    method: string,
    path: string,
    init: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const base = deps.baseUrl()?.replace(/\/+$/, "");
    if (!base) throw new CloudProviderError("ADE's account service isn't set up on this computer.", "network", 0);
    const token = await deps.accessToken();
    if (!token) throw new CloudProviderError("Sign in to ADE to use ADE Cloud.", CLOUD_ACCESS_REFUSED, 401);
    // Cached after the first read: one OS probe per process. Not on the access
    // check, which every signed-in account polls: the id goes only to an
    // account ADE Cloud lets in.
    const computer = path === CLOUD_PATHS.access ? null : await deps.computer?.().catch(() => null) ?? null;
    const controller = new AbortController();
    const timedOut = () => init.signal?.aborted
      ? new CloudProviderError("Cancelled.", "cancelled", 0)
      : new CloudProviderError("ADE Cloud did not answer in time. Try again.", "timeout", 0);
    // The caller's signal (a cancelled create) stops the request too.
    const onCallerAbort = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    else init.signal?.addEventListener("abort", onCallerAbort, { once: true });
    // The timer covers the body too: a server that sends headers and then
    // stalls would otherwise hang the read with no timeout at all.
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let response: Response;
    let body: unknown;
    try {
      try {
        response = await fetcher(`${base}${path}`, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(computer ? { [CLOUD_COMPUTER_HEADER]: computer.id, [CLOUD_COMPUTER_PLATFORM_HEADER]: computer.platform } : {}),
            ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        if (controller.signal.aborted) throw timedOut();
        throw new CloudProviderError(`Could not reach ADE Cloud: ${error instanceof Error ? error.message : String(error)}`, "network", 0);
      }
      body = response.status === 204
        ? null
        : await response.json().catch(() => {
          if (controller.signal.aborted) throw timedOut();
          return null;
        });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onCallerAbort);
    }
    if (!response.ok) {
      const { code, message, reason } = readError(body);
      // Off the access list, the server answers every route 404. On the list route
      // that means this account, not one computer.
      const refused = response.status === 401 || code === "unauthorized"
        || (response.status === 404 && method === "GET" && path === INSTANCES);
      throw new CloudProviderError(
        message ?? (response.status >= 500 ? "ADE Cloud is having trouble right now. Try again in a moment." : `ADE Cloud answered with an error (${response.status}).`),
        refused ? CLOUD_ACCESS_REFUSED : code ?? `http_${response.status}`,
        response.status,
        { reason },
      );
    }
    return body;
  }

  return {
    async accessEnabled(): Promise<boolean> {
      return record(await request("GET", "/cloud/access"))?.enabled === true;
    },

    async getAccount(): Promise<CloudAccountState> {
      return await request("GET", "/cloud/account") as CloudAccountState;
    },

    async listInstances(): Promise<CloudInstance[]> {
      const data = record(await request("GET", INSTANCES))?.data;
      return Array.isArray(data) ? data.map(readInstance) : [];
    },

    async getInstance(id: string): Promise<CloudInstance> {
      return readInstance(await request("GET", instancePath(id)));
    },

    async createInstance(input: CloudCreateInstanceInput, signal?: AbortSignal): Promise<CloudInstance> {
      // Every create names a channel, so a Beta app never makes a Stable computer by leaving it out.
      const channel = input.channel ?? deps.updateChannel?.() ?? null;
      const body = channel ? { ...input, channel } : input;
      return readInstance(await request("POST", INSTANCES, { body, timeoutMs: CREATE_TIMEOUT_MS, signal }));
    },

    async deleteInstance(id: string, context?: CloudDeleteContext): Promise<void> {
      await request("DELETE", instancePath(id), {
        body: {
          who: context?.who ?? deps.deviceName?.() ?? null,
          reason: context?.reason ?? "user",
          ...(context?.keepLane ? { keepLane: { branchRef: context.keepLane.branchRef } } : {}),
        },
      });
    },

    async listLanesWithoutComputer(): Promise<CloudLaneWithoutComputer[]> {
      let body: Record<string, unknown> | null;
      try {
        body = record(await request("GET", CLOUD_PATHS.lanesWithoutComputer));
      } catch (error) {
        // A server from before lanes without a computer has none to list.
        if (error instanceof CloudProviderError && error.status === 404) return [];
        throw error;
      }
      return Array.isArray(body?.lanes) ? body.lanes as CloudLaneWithoutComputer[] : [];
    },

    async forgetLaneWithoutComputer(laneId: string): Promise<boolean> {
      const body = record(await request("DELETE", `${CLOUD_PATHS.lanesWithoutComputer}/${encodeURIComponent(laneId)}`));
      return body?.forgotten === true;
    },

    async sleepInstance(id: string): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "sleep"), { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }), "sleeping");
    },

    async keepIdleComputer(id: string): Promise<void> {
      await request("POST", instancePath(id, "keep"), { body: {} });
    },

    async requestIdleSleep(id: string): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "idle"), { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }), "sleeping");
    },

    async startInstance(id: string, options?: { reason?: "push_work" }): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "start"), {
        body: options?.reason ? { reason: options.reason } : {},
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
      }), "running");
    },

    async stopInstance(id: string): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "stop"), { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }), "stopped");
    },

    async updateInstance(id, options): Promise<string> {
      const body = options?.reason === "idle" ? { reason: "idle", computerIdle: true } : {};
      return statusOf(await request("POST", instancePath(id, "update"), { body, timeoutMs: LIFECYCLE_TIMEOUT_MS }), "updating");
    },

    async checkForUpdate(id: string): Promise<CloudUpdateCheck> {
      const body = record(await request("GET", instancePath(id, "update-check")));
      const text = (value: unknown) => (typeof value === "string" && value ? value : null);
      return {
        behind: body?.behind === true,
        channel: body?.channel === "beta" ? "beta" : "stable",
        templateVersion: text(body?.templateVersion),
        targetTemplate: text(body?.targetTemplate),
        updateState: body?.updateState === "updating" || body?.updateState === "failed" ? body.updateState : null,
      };
    },

    async reportBooted(id: string, adeVersion: string | null): Promise<{ sleepWhenIdle: boolean }> {
      const body = record(await request("POST", instancePath(id, "booted"), { body: { adeVersion } }));
      return { sleepWhenIdle: body?.sleepWhenIdle === true };
    },

    async reportDiskUsage(id, report): Promise<void> {
      await request("POST", instancePath(id, "disk-usage"), { body: report });
    },

    async reportSustainedCpu(id, report): Promise<void> {
      await request("POST", instancePath(id, "cpu-report"), { body: report });
    },

    async resizeInstance(id, resources, options): Promise<string> {
      return statusOf(await request("POST", instancePath(id, "resize"), {
        body: {
          ...resources,
          ...(options?.computerIdle ? { computerIdle: true } : {}),
          ...(options?.origin === "auto" ? { origin: "auto" } : {}),
        },
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
      }), "updating");
    },

    async createBackup(id: string): Promise<{ id: string | null; created: number | null; sizeBytes: number | null }> {
      const body = record(await request("POST", instancePath(id, "backups"), { body: {}, timeoutMs: BACKUP_TIMEOUT_MS }));
      return {
        id: typeof body?.id === "string" ? body.id : null,
        created: typeof body?.created === "number" ? body.created : null,
        sizeBytes: typeof body?.sizeBytes === "number" ? body.sizeBytes : null,
      };
    },

    async setAutoSleep(id, policy): Promise<void> {
      await request("PUT", instancePath(id, "auto-sleep"), { body: policy });
    },

    async addPublicPort(id, input): Promise<{ port: number; url: string }> {
      const body = record(await request("POST", instancePath(id, "public-ports"), { body: input }));
      if (typeof body?.url !== "string" || !body.url) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return { port: typeof body.port === "number" ? body.port : input.port, url: body.url };
    },

    async forkInstance(id, input, signal): Promise<CloudInstance> {
      return readInstance(await request("POST", instancePath(id, "fork"), { body: input, timeoutMs: CREATE_TIMEOUT_MS, signal }));
    },

    async signedUrl(id, input): Promise<{ url: string; expiresAt: number | null }> {
      const body = record(await request("POST", instancePath(id, "signed-url"), { body: input }));
      if (typeof body?.url !== "string" || !body.url) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return { url: body.url, expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null };
    },

    async setInstanceName(id, name): Promise<void> {
      await request("PUT", instancePath(id, "name"), { body: { name: name.slice(0, 60) } });
    },

    async setInstanceMetadata(id, metadata): Promise<void> {
      await request("PUT", instancePath(id, "metadata"), { body: { metadata } });
    },

    async hasTemplate(): Promise<boolean> {
      return record(await request("GET", "/cloud/templates/current"))?.exists === true;
    },

    async exec(id, command, options): Promise<CloudExecResult> {
      const body = record(await request("POST", instancePath(id, "exec"), {
        body: { command, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
        timeoutMs: (options?.timeoutMs ?? REQUEST_TIMEOUT_MS) + EXEC_RESPONSE_GRACE_MS,
        signal: options?.signal,
      }));
      return {
        exitCode: typeof body?.exitCode === "number" ? body.exitCode : -1,
        stdout: typeof body?.stdout === "string" ? body.stdout : "",
        stderr: typeof body?.stderr === "string" ? body.stderr : "",
      };
    },

    async billingCheckout(plan, cleanup): Promise<CloudCheckoutResult> {
      const body = record(await request("POST", "/cloud/billing/checkout", { body: { plan: plan ?? "plus", knowsMax: true, ...(cleanup ? { cleanup } : {}) } }));
      if (body?.url === null && (body.change === "now" || body.change === "next_period")) {
        // A downgrade with a pick: the computers ADE frees now. Without one, over the cheaper plan: what goes over.
        const over = readCloudPlanCleanup(body.cleanup);
        const freeing = Array.isArray(body.freeing) ? body.freeing.filter((id): id is string => typeof id === "string") : null;
        return { url: null, change: body.change, ...(over ? { cleanup: over } : {}), ...(freeing ? { freeing } : {}) };
      }
      if (typeof body?.url !== "string" || !body.url) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return { url: body.url };
    },

    async pickPlanCleanup(input): Promise<CloudAccountState> {
      return await request("POST", CLOUD_PATHS.billingPlanCleanup, { body: input }) as CloudAccountState;
    },

    async billingPortal(): Promise<{ url: string }> {
      const body = record(await request("POST", "/cloud/billing/portal"));
      if (typeof body?.url !== "string" || !body.url) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return { url: body.url };
    },

    async billingFreeUnlock(): Promise<CloudFreeUnlockResult> {
      const body = record(await request("POST", CLOUD_PATHS.billingFreeUnlock, { body: {} }));
      if (body?.unlocked === true) return { url: null, unlocked: true };
      if (typeof body?.url !== "string" || !body.url) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return { url: body.url, unlocked: false };
    },

    async setExtraHours(enabled: boolean): Promise<CloudAccountState> {
      return await request("POST", "/cloud/billing/extra-hours", { body: { enabled } }) as CloudAccountState;
    },

    async setExtraDisk(choice): Promise<CloudAccountState> {
      return await request("POST", "/cloud/billing/extra-disk", { body: choice }) as CloudAccountState;
    },

    async readReferral(): Promise<CloudReferralSummary> {
      const referral = readCloudReferralSummary(await request("GET", CLOUD_PATHS.referrals));
      if (!referral) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return referral;
    },

    async redeemInvite(code: string): Promise<CloudInviteRedeemResult> {
      const body = record(await request("POST", CLOUD_PATHS.referralsRedeem, { body: { code } }));
      const referral = readCloudReferralSummary(body?.referral);
      if (body?.result !== "accepted" || !referral) throw new CloudProviderError(BAD_RESPONSE, "bad_response", 200);
      return { result: "accepted", rewarded: body.rewarded === true, referral };
    },

    async listSavedChats(args): Promise<CloudSavedChatList> {
      const query = new URLSearchParams();
      if (args.machineKey) query.set("machine", args.machineKey);
      if (args.projectKey) query.set("project", args.projectKey);
      if (args.limit) query.set("limit", String(args.limit));
      if (args.cursor) query.set("cursor", args.cursor);
      try {
        return await request("GET", `${cloudSavedChatsUrl("")}?${query.toString()}`) as CloudSavedChatList;
      } catch (error) {
        // 404 is this account being off the access list: no chats, not a failure.
        if (error instanceof CloudProviderError && error.status === 404) return { chats: [], nextCursor: null };
        throw error;
      }
    },

    async readSavedChat(args): Promise<CloudSavedChatPage | null> {
      const query = new URLSearchParams();
      if (args.before != null) query.set("before", String(args.before));
      if (args.limit) query.set("limit", String(args.limit));
      const suffix = query.toString();
      try {
        return await request("GET", `${cloudSavedChatUrl("", args.machineKey, args.chatId)}${suffix ? `?${suffix}` : ""}`) as CloudSavedChatPage;
      } catch (error) {
        if (error instanceof CloudProviderError && error.status > 0) {
          deps.logger?.warn("cloud.saved_chat_read_failed", { status: error.status });
          return null;
        }
        throw error;
      }
    },

    async deleteSavedChat(args): Promise<void> {
      await request("DELETE", cloudSavedChatUrl("", args.machineKey, args.chatId));
    },
  };
}
