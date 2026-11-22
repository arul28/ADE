/**
 * A typed client for ADE Cloud's server routes (`/cloud/*` on the account
 * directory), for callers with no computer of their own: the web client, the
 * iPhone's shapes (the route list is in `contract.ts`), the CLI, and a new
 * cloud computer reporting its own launch. Fetch only: no Electron, no Node,
 * so the browser bundle and the CLI import the same file.
 *
 * Every call takes the account token as a bearer, except the computer's join
 * (`joinLaunch`), which proves itself with its one-time join code. Errors are
 * `CloudApiError` with the server's one plain sentence.
 *
 * The desktop and the brain keep their own provider (`cloudServerProvider.ts`);
 * this client is for the routes they don't call.
 */

import {
  CLOUD_CAPSULE_UPLOAD_HEADER,
  CLOUD_INSTANCE_HEADER,
  CLOUD_PATHS,
  cloudBackupPath,
  cloudCapsulePath,
  cloudChatMessagesPath,
  cloudChatMovePath,
  cloudGitPath,
  cloudInstanceMessagesPath,
  cloudInstanceUsePath,
  cloudSessionPath,
  type AccountLaneIndexPut,
  type AccountLaneIndexPutResult,
  type AccountLaneIndexRow,
  type CloudAccess,
  type CloudComputerActivityReport,
  type CloudComputerStatus,
  type CloudBackupKind,
  type CloudBackupReport,
  type CloudBackupReportState,
  type CloudBackupUploadCommit,
  type CloudBackupUploadStart,
  type CloudBackupUploadStarted,
  type CloudLaneBackup,
  type CloudCapsuleCommit,
  type CloudCapsuleManifest,
  type CloudCapsulePartResult,
  type CloudChatMessageAddResult,
  type CloudChatMessageReport,
  type CloudChatMessageRequest,
  type CloudChatMoveRequest,
  type CloudChatMoveResult,
  type CloudChatQueuedMessage,
  type CloudComputerQueuedMessage,
  type CloudGitSummary,
  type CloudGitSummaryUpload,
  type CloudProjectOverview,
  type CloudSessionCopy,
  type CloudSessionRow,
  type CloudSessionMoveResult,
  type CloudSessionUpload,
  type CloudAccountSignIns,
  type CloudAccountState,
  type CloudAutomationRegistered,
  type CloudAutomationRegistration,
  type CloudAutomationRun,
  type CloudAutomationSummary,
  type CloudChatRow,
  type CloudChatTranscriptPage,
  type CloudFreeRecord,
  type CloudInstance,
  type CloudLaunchJoinRequest,
  type CloudLaunchJoinResult,
  type CloudLaunchList,
  type CloudLaunchMessage,
  type CloudLaunchMessageReport,
  type CloudLaunchMessageRequest,
  type CloudLaunchRecord,
  type CloudLaunchStagesUpdate,
  type CloudLaunchStartRequest,
  type CloudModelCatalog,
  type CloudCopyList,
  type CloudCopyRecord,
  type CloudCopyRequest,
  type CloudMoveList,
  type CloudMoveRecord,
  type CloudMoveRequest,
  type CloudProjectComputersDeleteStarted,
  type CloudProjectComputersJob,
  type CloudProjectComputersPreview,
  type CloudRemoteSignInStart,
  type CloudRemoteSignInStatus,
  type CloudServerLaunchRequest,
} from "../../../account-directory/src/cloud/contract";
import type { CloudLaneMovedRequest, CloudLaneWithoutComputer } from "../../../account-directory/src/cloud/contract";
import {
  CLOUD_EDGE_PATHS,
  cloudInstanceEventWakesPath,
  type CloudAccountSecretKind,
  type CloudAccountSecrets,
  type CloudAccountSignInsWithCarried,
  type CloudAgentLimitsState,
  type CloudAgentLimitsUpdate,
  type CloudCtoCopySummary,
  type CloudEventWakesRequest,
  type CloudEventWakesResult,
  type CloudJiraIssueRequest,
  type CloudJiraIssueResult,
  type CloudJiraSearchRequest,
  type CloudJiraSearchResult,
  type CloudLinearQueryRequest,
  type CloudLinearQueryResult,
  type CloudSponsoredAdAnswer,
  type CloudSponsoredAdRequest,
  type CloudSponsoredConsent,
  type CloudSponsoredIndexAnswer,
  type CloudSponsoredIndexRequest,
  type CloudSponsoredSeenRequest,
  type CloudSponsoredState,
} from "../../../account-directory/src/cloud/contract";

export type CloudApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type CloudApiClientOptions = {
  /** The account directory's origin (`https://…`), no trailing path. */
  baseUrl: string;
  /** The account token, read fresh for each call; null when signed out. */
  accessToken: () => Promise<string | null> | string | null;
  fetch?: CloudApiFetch;
  /** Per call; a file upload gets four times this. */
  timeoutMs?: number;
};

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** A refusal's own reason when the server gives one (a disk refusal's `CloudDiskRefusalReason`). */
    readonly reason: string | null = null,
    /** The server's whole `error` object, for a refusal that carries more (`computer_limit`'s `CloudComputerLimitDetail`). */
    readonly detail: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Sleep, wake, resize and update: the server waits on its provider, and a move between hosts takes minutes. */
const LIFECYCLE_TIMEOUT_MS = 3 * 60_000;
const BACKUP_TIMEOUT_MS = 15 * 60_000;

type RequestOptions = {
  body?: unknown;
  raw?: { bytes: BodyInit; contentType: string };
  /** No bearer: the computer's join. */
  anonymous?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Answer the raw response (a file's bytes). */
  rawResponse?: boolean;
};

export function createCloudApiClient(options: CloudApiClientOptions) {
  const fetcher: CloudApiFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(method: string, path: string, init: RequestOptions = {}): Promise<T> {
    // One limit for the whole call: the sign-in token's wait counts against it, and the fetch gets what is left.
    const limitMs = init.timeoutMs ?? timeoutMs;
    const startedAt = Date.now();
    const outOfTime = () => new CloudApiError("ADE Cloud did not answer in time. Try again.", "timeout", 0);
    const headers: Record<string, string> = { accept: "application/json", ...init.headers };
    if (!init.anonymous) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(outOfTime()), limitMs);
      });
      // Started in the chain, so a token callback that throws rejects here and the timer is cleared.
      const tokenWait = Promise.resolve().then(() => options.accessToken());
      // A token that fails after the limit has nobody waiting for it.
      tokenWait.catch(() => undefined);
      const token = await Promise.race([tokenWait, late]).finally(() => clearTimeout(timer));
      if (!token) throw new CloudApiError("Sign in to ADE to use ADE Cloud.", "unauthorized", 401);
      headers.authorization = `Bearer ${token}`;
    }
    const leftMs = limitMs - (Date.now() - startedAt);
    if (leftMs <= 0) throw outOfTime();
    let body: BodyInit | undefined;
    if (init.raw) {
      body = init.raw.bytes;
      headers["content-type"] = init.raw.contentType;
    } else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    }
    const noAnswer = (error: unknown): CloudApiError => {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return new CloudApiError(timedOut ? "ADE Cloud did not answer in time. Try again." : "ADE Cloud can't be reached. Check your connection.", timedOut ? "timeout" : "network", 0);
    };
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(leftMs) });
    } catch (error) {
      throw noAnswer(error);
    }
    if (response.ok && init.rawResponse) return response as unknown as T;
    // A success whose body never arrived is no answer, not an empty one (an
    // empty success reads as "older server" to callers). A failure keeps its
    // status either way.
    const text = await response.text().catch((error: unknown) => {
      if (response.ok) throw noAnswer(error);
      return "";
    });
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = parsed && typeof parsed === "object" ? (parsed as { error?: { code?: unknown; message?: unknown; reason?: unknown } }).error : undefined;
      throw new CloudApiError(
        typeof error?.message === "string" ? error.message : `ADE Cloud answered ${response.status}.`,
        typeof error?.code === "string" ? error.code : "http_error",
        response.status,
        typeof error?.reason === "string" ? error.reason : null,
        error && typeof error === "object" ? error as Record<string, unknown> : null,
      );
    }
    return parsed as T;
  }

  const launchPath = (launchId: string) => `${CLOUD_PATHS.launches}/${encodeURIComponent(launchId)}`;
  const instancePath = (instanceId: string) => `${CLOUD_PATHS.instances}/${encodeURIComponent(instanceId)}`;
  const automationPath = (ruleId: string) => `${CLOUD_PATHS.automations}/${encodeURIComponent(ruleId)}`;

  /** A read on a route an older server lacks (or an account without ADE Cloud): null, so the caller keeps today's behavior. */
  async function orNullOn404<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 404) return null;
      throw error;
    }
  }

  return {
    /* ---- List ---- */
    /** `enabled` false with `readOnly` true: blocked, but reading works (`reason` is the server's sentence). */
    access: () => request<CloudAccess>("GET", CLOUD_PATHS.access),
    account: () => request<CloudAccountState>("GET", CLOUD_PATHS.account),
    /* ---- Sponsored cards and the Index (account level, `gravity.ts`) ---- */
    /** The account's answer to the sponsored question, on every machine. */
    setSponsoredConsent: (consent: CloudSponsoredConsent) => request<CloudSponsoredState>("PUT", CLOUD_PATHS.sponsoredConsent, { body: { consent } }),
    /** A person has a chat or terminal of this ADE Cloud computer open. */
    sponsoredSeen: (input: CloudSponsoredSeenRequest) => request<{ ok: boolean }>("POST", CLOUD_PATHS.sponsoredSeen, { body: input }),
    /** One card under a finished reply, or none (always a 200). */
    sponsoredAd: (input: CloudSponsoredAdRequest) => request<CloudSponsoredAdAnswer>("POST", CLOUD_PATHS.sponsoredAd, { body: input, timeoutMs: 10_000 }),
    /** An agent's Index search on its own ADE Cloud computer. */
    sponsoredIndex: (input: CloudSponsoredIndexRequest) => request<CloudSponsoredIndexAnswer>("POST", CLOUD_PATHS.sponsoredIndex, { body: input, timeoutMs: 15_000 }),
    listComputers: async () => (await request<{ data: CloudInstance[] }>("GET", CLOUD_PATHS.instances)).data,

    /* ---- A lane on a new computer (the server launcher) ---- */
    /** Files first (at most 10, 25 MB each), then `startLaunch` names them by `fileId`. */
    uploadLaunchFile: (launchId: string, fileId: string, bytes: Blob | ArrayBuffer | Uint8Array, contentType: string) =>
      request<{ fileId: string; sizeBytes: number }>("PUT", `${launchPath(launchId)}/files/${encodeURIComponent(fileId)}`, {
        raw: { bytes: bytes as BodyInit, contentType: contentType || "application/octet-stream" },
        timeoutMs: timeoutMs * 4,
      }),
    /**
     * 201 for a new launch; the same `launchId` again answers the same launch.
     * The web's start (`CloudLaunchStartRequest`) may name `{ accountProjectId }`
     * and leave out `lane` and `sizeId` (a new lane named from the first
     * message, Small).
     */
    startLaunch: (launch: CloudServerLaunchRequest | CloudLaunchStartRequest) =>
      request<CloudLaunchRecord>("POST", CLOUD_PATHS.launches, { body: launch, timeoutMs: timeoutMs * 4 }),
    launchStatus: (launchId: string) => request<CloudLaunchRecord>("GET", launchPath(launchId)),
    /** The caller's launches still in progress (and failures of the last day). */
    activeLaunches: () => request<CloudLaunchList>("GET", `${CLOUD_PATHS.launches}?active=1`),
    /** The launch's messages, in order (row 1 is the first message). */
    launchMessages: (launchId: string) => request<{ messages: CloudLaunchMessage[] }>("GET", `${launchPath(launchId)}/messages`),
    /** A message for a chat launch whose chat doesn't exist yet; the same `messageId` is the same message. */
    addLaunchMessage: (launchId: string, message: CloudLaunchMessageRequest) =>
      request<CloudLaunchMessage>("POST", `${launchPath(launchId)}/messages`, { body: message }),
    /** Before the agent starts it deletes the computer; after, the server refuses with `launch_started`. */
    cancelLaunch: (launchId: string) => request<CloudLaunchRecord>("DELETE", launchPath(launchId)),

    /* ---- One computer ---- */
    computer: (instanceId: string) => request<CloudInstance>("GET", instancePath(instanceId)),
    /** A lane computer's live status for its status menu; never wakes it. Null on an older server (or a computer it doesn't know). */
    computerStatus: (instanceId: string) => orNullOn404(() => request<CloudComputerStatus>("GET", `${instancePath(instanceId)}/status`)),
    /** From the computer's brain: its work started or stopped, or its count of agents changed. Null on an older server. */
    reportActivity: (instanceId: string, report: CloudComputerActivityReport) =>
      orNullOn404(() => request<{ ok: true }>("POST", `${instancePath(instanceId)}/activity`, { body: report })),
    sleep: (instanceId: string) => request<{ status: string }>("POST", `${instancePath(instanceId)}/sleep`, { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }),
    /** The server restarts the computer on the newest ADE for its channel. */
    update: (instanceId: string) => request<{ status: string }>("POST", `${instancePath(instanceId)}/update`, { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }),
    /** At most one every 15 minutes (`rate_limited`). */
    backup: (instanceId: string) =>
      request<{ id?: string | null; created?: number | null; sizeBytes?: number | null }>("POST", `${instancePath(instanceId)}/backups`, { body: {}, timeoutMs: BACKUP_TIMEOUT_MS }),
    /** Every wake is use: it bills hours, and none is allowed at 0 hours. `origin: "mcp"`: an outside agent asked (refused on the free plan). */
    wake: (instanceId: string, origin?: "mcp") =>
      request<{ status: string }>("POST", `${instancePath(instanceId)}/start`, { body: origin ? { origin } : {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }),
    /** The server wakes a sleeping computer first. `computerIdle` is needed to grow the disk of a running one. */
    resize: (instanceId: string, args: { cpu?: number; memory?: number; disk?: number; computerIdle?: boolean; origin?: "mcp" }) =>
      request<{ status: string }>("POST", `${instancePath(instanceId)}/resize`, { body: args, timeoutMs: LIFECYCLE_TIMEOUT_MS }),
    /** `keepLane.onlyIfSaved`: only while it rests with every lane's work saved (409 otherwise, nothing deleted). */
    deleteComputer: (
      instanceId: string,
      args: { who?: string | null; reason?: string | null; keepLane?: { branchRef: string | null; onlyIfSaved?: boolean } } = {},
    ) =>
      request<{ deleted: true }>("DELETE", instancePath(instanceId), { body: args }),
    /** Runs a shell command on the computer; the server wakes a sleeping one for it (that uses hours). */
    exec: (instanceId: string, command: string, timeoutMs: number) =>
      request<{ exitCode: number; stdout: string; stderr: string }>("POST", `${instancePath(instanceId)}/exec`, {
        body: { command, timeoutMs },
        timeoutMs: timeoutMs + 15_000,
      }),

    /* ---- "Free the computer, keep the lane", run by the server (`frees.ts`) ---- */
    /** Answers at once; the free goes on with no app open. 201 new, 200 the same `freeId` again; 404 on an older server. */
    startFree: (instanceId: string, freeId: string) =>
      request<CloudFreeRecord>("POST", `${instancePath(instanceId)}/free`, { body: { freeId } }),
    free: (freeId: string) => request<CloudFreeRecord>("GET", `${CLOUD_PATHS.frees}/${encodeURIComponent(freeId)}`),

    /* ---- A computer moved to the other kind, run by the server (`moves.ts`) ---- */

    /** Answers at once; the move goes on with no app open. 404 on an older server, 409 `server_move_unavailable` while moves are off. */
    startMove: (instanceId: string, move: CloudMoveRequest) =>
      request<CloudMoveRecord>("POST", `${instancePath(instanceId)}/move`, { body: move }),
    move: (moveId: string) => request<CloudMoveRecord>("GET", `${CLOUD_PATHS.moves}/${encodeURIComponent(moveId)}`),
    /** Running moves, and those that ended in the last day; null on an older server. */
    moves: async () => (await orNullOn404(() => request<CloudMoveList>("GET", CLOUD_PATHS.moves)))?.moves ?? null,
    /** Only before the copy starts (409 `move_started` after). */
    cancelMove: (moveId: string) => request<CloudMoveRecord>("DELETE", `${CLOUD_PATHS.moves}/${encodeURIComponent(moveId)}`),

    /* ---- A computer copied, run by the server (`copies.ts`) ---- */

    /** Answers at once; the copy goes on with no app open. 404 on an older server, 409 `server_copy_unavailable` while copies are off. */
    startCopy: (instanceId: string, copy: CloudCopyRequest) =>
      request<CloudCopyRecord>("POST", `${instancePath(instanceId)}/copy`, { body: copy }),
    copy: (copyId: string) => request<CloudCopyRecord>("GET", `${CLOUD_PATHS.copies}/${encodeURIComponent(copyId)}`),
    /** Running copies, and those that ended in the last day; null on an older server. */
    copies: async () => (await orNullOn404(() => request<CloudCopyList>("GET", CLOUD_PATHS.copies)))?.copies ?? null,
    /** Only before the copy signs in (409 `copy_signed_in` after). */
    cancelCopy: (copyId: string) => request<CloudCopyRecord>("DELETE", `${CLOUD_PATHS.copies}/${encodeURIComponent(copyId)}`),

    /* ---- Provider sign-ins on a computer ---- */
    startSignIn: (instanceId: string, provider: string) =>
      request<CloudRemoteSignInStart>("POST", `${instancePath(instanceId)}/sign-ins`, { body: { provider }, timeoutMs: timeoutMs * 3 }),
    /** A code pasted from the provider's page. */
    sendSignInCode: (instanceId: string, jobId: string, code: string) =>
      request<CloudRemoteSignInStatus>("POST", `${instancePath(instanceId)}/sign-ins/${encodeURIComponent(jobId)}/code`, { body: { code }, timeoutMs: timeoutMs * 3 }),
    signInStatus: (instanceId: string, jobId: string) =>
      request<CloudRemoteSignInStatus>("GET", `${instancePath(instanceId)}/sign-ins/${encodeURIComponent(jobId)}`, { timeoutMs: timeoutMs * 3 }),

    /* ---- The account's ADE Cloud sign-ins (status only, never a value) ---- */
    accountSignIns: () => request<CloudAccountSignInsWithCarried>("GET", CLOUD_PATHS.signIns),
    /** A key, or for `claude` a Claude pass, saved to the account vault. */
    saveAccountSignIn: (signInId: string, key: string) =>
      request<CloudAccountSignIns>("PUT", `${CLOUD_PATHS.signIns}/${encodeURIComponent(signInId)}`, { body: { key } }),
    removeAccountSignIn: (signInId: string) =>
      request<CloudAccountSignIns>("DELETE", `${CLOUD_PATHS.signIns}/${encodeURIComponent(signInId)}`),
    /** Models per provider, for a picker before any computer exists. */
    modelCatalog: () => request<CloudModelCatalog>("GET", CLOUD_PATHS.models),
    /* ---- Lanes kept without a computer (impl-renderer-core; ADE Web) ---- */
    /** The account's lanes whose computer was freed or removed. A server from before them has none (404). */
    lanesWithoutComputer: async () =>
      (await orNullOn404(() => request<{ lanes?: CloudLaneWithoutComputer[] }>("GET", CLOUD_PATHS.lanesWithoutComputer)))?.lanes ?? [],
    forgetLaneWithoutComputer: (laneId: string) =>
      request<{ forgotten?: boolean }>("DELETE", `${CLOUD_PATHS.lanesWithoutComputer}/${encodeURIComponent(laneId)}`),
    /**
     * The kept lane came back on this machine (`toMachineKey`): its record goes, and its
     * data under every other key; what moved here stays. An older server answers 404 and deletes nothing.
     */
    forgetMovedLaneWithoutComputer: (laneId: string, moved: CloudLaneMovedRequest) =>
      request<{ forgotten?: boolean }>("POST", `${CLOUD_PATHS.lanesWithoutComputer}/${encodeURIComponent(laneId)}/moved`, { body: moved }),
    /**
     * The account's saved chats (the server's copy, readable with no computer
     * running). A 404 is an account without ADE Cloud: no chats, not a failure.
     */
    savedChats: async (args: { machineKey?: string | null; notMachineKey?: string | null; projectKey?: string | null; laneId?: string | null; limit?: number; cursor?: string | null } = {}) => {
      const query = new URLSearchParams();
      if (args.machineKey) query.set("machine", args.machineKey);
      // An older server ignores these two and lists every chat: callers filter what comes back too.
      if (args.notMachineKey) query.set("notMachine", args.notMachineKey);
      if (args.laneId) query.set("lane", args.laneId);
      if (args.projectKey) query.set("project", args.projectKey);
      if (args.limit) query.set("limit", String(args.limit));
      if (args.cursor) query.set("cursor", args.cursor);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      try {
        return await request<{ chats: CloudChatRow[]; nextCursor: string | null }>("GET", `${CLOUD_PATHS.chats}${suffix}`);
      } catch (error) {
        if (error instanceof CloudApiError && error.status === 404) return { chats: [], nextCursor: null };
        throw error;
      }
    },
    /** One saved chat's transcript page; null when the server has no such chat. */
    savedChat: async (args: { machineKey: string; chatId: string; before?: number | null; limit?: number }) => {
      const query = new URLSearchParams();
      if (args.before != null) query.set("before", String(args.before));
      if (args.limit) query.set("limit", String(args.limit));
      const suffix = query.toString() ? `?${query.toString()}` : "";
      try {
        return await request<CloudChatTranscriptPage>(
          "GET",
          `${CLOUD_PATHS.chats}/${encodeURIComponent(args.machineKey)}/${encodeURIComponent(args.chatId)}${suffix}`,
        );
      } catch (error) {
        if (error instanceof CloudApiError && error.status === 404) return null;
        throw error;
      }
    },
    deleteSavedChat: (machineKey: string, chatId: string) =>
      request<{ deleted?: boolean }>("DELETE", `${CLOUD_PATHS.chats}/${encodeURIComponent(machineKey)}/${encodeURIComponent(chatId)}`),

    /* ---- ADE without a computer: reads (never wake) ---- */
    /** One project's whole ADE Cloud view. Null from an older server: read the separate lists as before. */
    projectOverview: (origin: string) =>
      orNullOn404(() => request<CloudProjectOverview>("GET", `${CLOUD_PATHS.projectsOverview}?origin=${encodeURIComponent(origin)}`)),
    /** CLI-session and shell copies; null from an older server. */
    savedSessions: (args: { machineKey?: string | null; notMachineKey?: string | null; projectKey?: string | null; laneId?: string | null; cursor?: string | null } = {}) => {
      const query = new URLSearchParams();
      if (args.machineKey) query.set("machine", args.machineKey);
      // As `savedChats`: an older server ignores these two.
      if (args.notMachineKey) query.set("notMachine", args.notMachineKey);
      if (args.laneId) query.set("lane", args.laneId);
      if (args.projectKey) query.set("project", args.projectKey);
      if (args.cursor) query.set("cursor", args.cursor);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      return orNullOn404(() => request<{ sessions: CloudSessionRow[]; nextCursor: string | null }>("GET", `${CLOUD_PATHS.sessions}${suffix}`));
    },
    /** One copy; null when the server has none (or predates copies). */
    savedSession: (machineKey: string, sessionId: string) =>
      orNullOn404(() => request<CloudSessionCopy>("GET", cloudSessionPath(machineKey, sessionId))),
    deleteSavedSession: (machineKey: string, sessionId: string) =>
      request<{ deleted: boolean }>("DELETE", cloudSessionPath(machineKey, sessionId)),
    /** A continued CLI's copy and queued messages go to the new computer's key. */
    moveSavedSession: (fromMachineKey: string, sessionId: string, move: CloudChatMoveRequest) =>
      request<CloudSessionMoveResult>("POST", `${cloudSessionPath(fromMachineKey, sessionId)}/move`, { body: move }),
    /** The project's Git summaries saved at rest; null from an older server. */
    gitSummaries: (projectKey: string) =>
      orNullOn404(() => request<{ summaries: CloudGitSummary[] }>("GET", `${CLOUD_PATHS.git}?project=${encodeURIComponent(projectKey)}`)),
    gitSummary: (machineKey: string, laneId: string) =>
      orNullOn404(() => request<CloudGitSummary>("GET", cloudGitPath(machineKey, laneId))),
    /** The account lane index (every machine), for lane mentions only; null from an older server. */
    accountLanes: (args: { project?: string | null; pr?: number | null } = {}) => {
      const query = new URLSearchParams();
      if (args.project) query.set("project", args.project);
      if (args.pr != null) query.set("pr", String(args.pr));
      const suffix = query.toString() ? `?${query.toString()}` : "";
      return orNullOn404(() => request<{ lanes: AccountLaneIndexRow[] }>("GET", `${CLOUD_PATHS.accountLanes}${suffix}`));
    },

    /* ---- The message queue for an existing cloud chat ---- */
    /**
     * Queues a message and wakes the chat's computer (or, when it is gone,
     * starts a launch that continues the chat). A refusal stores nothing and
     * throws `CloudApiError` with the server's code and sentence. A 404 with
     * code `not_found` from a server without the queue: fall back to
     * wake-then-send.
     */
    sendChatMessage: (machineKey: string, chatId: string, message: CloudChatMessageRequest) =>
      request<CloudChatMessageAddResult>("POST", cloudChatMessagesPath(machineKey, chatId), { body: message, timeoutMs: LIFECYCLE_TIMEOUT_MS }),
    /** Open and recent messages of one chat; null from an older server. */
    chatMessages: (machineKey: string, chatId: string) =>
      orNullOn404(async () => (await request<{ messages: CloudChatQueuedMessage[] }>("GET", cloudChatMessagesPath(machineKey, chatId))).messages),
    /** Takes a queued message back; 409 `message_taken` once the computer has it. */
    cancelChatMessage: (machineKey: string, chatId: string, messageId: string) =>
      request<CloudChatQueuedMessage>("DELETE", cloudChatMessagesPath(machineKey, chatId, messageId)),

    /* ---- A project's computers ---- */
    previewProjectComputers: (origin: string) =>
      request<CloudProjectComputersPreview>("POST", CLOUD_PATHS.projectComputersDelete, { body: { origin, dryRun: true } }),
    /** Only the computers the preview listed (`instanceIds`) that still belong to the origin. */
    deleteProjectComputers: (origin: string, instanceIds: readonly string[]) =>
      request<CloudProjectComputersDeleteStarted>("POST", CLOUD_PATHS.projectComputersDelete, { body: { origin, instanceIds } }),
    projectComputersJob: (jobId: string) =>
      request<CloudProjectComputersJob>("GET", `${CLOUD_PATHS.projectComputersDelete}/${encodeURIComponent(jobId)}`),

    /* ---- Automations whose home is ADE Cloud (C9) ---- */
    /** This account's cloud-homed rules (of one repository when `origin` is set), each with its last runs. */
    listAutomations: async (origin?: string | null) =>
      (await request<{ automations: CloudAutomationSummary[] }>("GET", `${CLOUD_PATHS.automations}${origin ? `?origin=${encodeURIComponent(origin)}` : ""}`)).automations,
    /** The brain that saved the cloud home (or saw it drift): one write per rule change; the same version writes nothing. */
    registerAutomation: (ruleId: string, registration: CloudAutomationRegistration) =>
      request<CloudAutomationRegistered>("PUT", automationPath(ruleId), { body: registration, timeoutMs: timeoutMs * 2 }),
    /**
     * Takes a rule off ADE Cloud. With `through`, only a copy no newer than that
     * version goes; `kept` says the server holds a newer save and kept it.
     */
    unregisterAutomation: (ruleId: string, options?: { through?: string }) =>
      request<{ deleted: boolean; kept?: boolean }>("DELETE", `${automationPath(ruleId)}${options?.through ? `?through=${encodeURIComponent(options.through)}` : ""}`),
    /** Run now: a run made on ADE Cloud, under the agent limits. */
    runAutomation: (ruleId: string) => request<CloudAutomationRun>("POST", `${automationPath(ruleId)}/run`, { timeoutMs: timeoutMs * 4 }),
    automationRuns: async (ruleId: string) => (await request<{ runs: CloudAutomationRun[] }>("GET", `${automationPath(ruleId)}/runs`)).runs,

    /* ---- From the new computer itself ---- */
    /** No account token: the one-time join code and this computer's own instance id. */
    joinLaunch: (launchId: string, instanceId: string, join: CloudLaunchJoinRequest) =>
      request<CloudLaunchJoinResult>("POST", `${launchPath(launchId)}/join`, {
        body: join,
        anonymous: true,
        headers: { [CLOUD_INSTANCE_HEADER]: instanceId },
      }),
    reportLaunchStages: (launchId: string, update: CloudLaunchStagesUpdate) =>
      request<CloudLaunchRecord>("PUT", `${launchPath(launchId)}/stages`, { body: update }),
    /** From the computer: takes one queued message to send it (409 `message_taken` once another claim has it). */
    claimLaunchMessage: (launchId: string, messageId: string, claimId: string) =>
      request<CloudLaunchMessage>("POST", `${launchPath(launchId)}/messages/${encodeURIComponent(messageId)}/claim`, { body: { claimId } }),
    /** From the computer that claimed it: sent, or not. */
    reportLaunchMessage: (launchId: string, messageId: string, report: CloudLaunchMessageReport) =>
      request<CloudLaunchMessage>("PUT", `${launchPath(launchId)}/messages/${encodeURIComponent(messageId)}`, { body: report }),
    readLaunchFile: async (launchId: string, fileId: string): Promise<ArrayBuffer> => {
      const response = await request<Response>("GET", `${launchPath(launchId)}/files/${encodeURIComponent(fileId)}`, { rawResponse: true, timeoutMs: timeoutMs * 4 });
      return await response.arrayBuffer();
    },

    /* ---- From a cloud computer: the queue, use, copies and capsules ---- */
    /** This computer's queued messages, oldest first. */
    computerMessages: async (instanceId: string) =>
      (await request<{ messages: CloudComputerQueuedMessage[] }>("GET", cloudInstanceMessagesPath(instanceId))).messages,
    /** Takes one message to send it (409 `message_taken` once another claim has it). */
    claimComputerMessage: (instanceId: string, messageId: string, claimId: string) =>
      request<CloudComputerQueuedMessage>("POST", cloudInstanceMessagesPath(instanceId, messageId, true), { body: { claimId } }),
    reportComputerMessage: (instanceId: string, messageId: string, report: CloudChatMessageReport) =>
      request<CloudComputerQueuedMessage>("PUT", cloudInstanceMessagesPath(instanceId, messageId), { body: report }),
    /** A person used the computer while an idle save may hold it; 409 `computer_deleting` when the delete is claimed. */
    recordComputerUse: (instanceId: string) =>
      request<{ ok: true }>("POST", cloudInstanceUsePath(instanceId), { body: {}, headers: { [CLOUD_INSTANCE_HEADER]: instanceId } }),
    putSessionCopy: (machineKey: string, sessionId: string, upload: CloudSessionUpload) =>
      request<{ ok: true; updatedAt: number }>("PUT", cloudSessionPath(machineKey, sessionId), { body: upload, timeoutMs: timeoutMs * 2 }),
    /** `kept`: the server holds a newer read and kept it. */
    putGitSummary: (machineKey: string, laneId: string, upload: CloudGitSummaryUpload) =>
      request<{ ok: true; kept: boolean }>("PUT", cloudGitPath(machineKey, laneId), { body: upload }),
    /**
     * Part `part` (1-based, at most 6 MiB) of a capsule; a put of part 1 starts a new upload and answers its
     * `uploadId`, which later parts send (`upload.uploadId`). `upload.timeoutMs` shortens the request's own limit.
     */
    putCapsulePart: (machineKey: string, chatId: string, part: number, instanceId: string, bytes: Uint8Array | ArrayBuffer | Blob, upload: { uploadId?: string | null; timeoutMs?: number } = {}) =>
      request<CloudCapsulePartResult>("PUT", cloudCapsulePath(machineKey, chatId, { part }), {
        raw: { bytes: bytes as BodyInit, contentType: "application/octet-stream" },
        headers: { [CLOUD_INSTANCE_HEADER]: instanceId, ...(upload.uploadId ? { [CLOUD_CAPSULE_UPLOAD_HEADER]: upload.uploadId } : {}) },
        timeoutMs: Math.max(1, Math.min(timeoutMs * 2, upload.timeoutMs ?? Infinity)),
      }),
    commitCapsule: (machineKey: string, chatId: string, commit: CloudCapsuleCommit, limit: { timeoutMs?: number } = {}) =>
      request<CloudCapsuleManifest>("POST", cloudCapsulePath(machineKey, chatId, "commit"), { body: commit, timeoutMs: Math.max(1, Math.min(timeoutMs, limit.timeoutMs ?? Infinity)) }),
    /** The capsule saved for a chat; null when there is none (replay the saved transcript). */
    capsuleManifest: (machineKey: string, chatId: string) =>
      orNullOn404(() => request<CloudCapsuleManifest>("GET", cloudCapsulePath(machineKey, chatId))),
    readCapsulePart: async (machineKey: string, chatId: string, part: number): Promise<ArrayBuffer> => {
      const response = await request<Response>("GET", cloudCapsulePath(machineKey, chatId, { part }), { rawResponse: true, timeoutMs: timeoutMs * 2 });
      return await response.arrayBuffer();
    },
    /** Deletes a capsule a restore used (a move that kept it). Null on an older server, whose move deleted it already. */
    deleteCapsule: (machineKey: string, chatId: string) =>
      orNullOn404(() => request<{ deleted: boolean }>("DELETE", cloudCapsulePath(machineKey, chatId))),
    /* ---- Lane backups at rest (`laneBackups.ts`) ---- */
    /** The account's lane backups (of one lane with `laneId`, made on one computer with `machineKey`), newest first; empty from an older server. */
    laneBackups: async (laneId?: string | null, machineKey?: string | null): Promise<CloudLaneBackup[]> => {
      const query = new URLSearchParams();
      if (laneId) query.set("laneId", laneId);
      if (machineKey) query.set("machineKey", machineKey);
      const suffix = query.size ? `?${query.toString()}` : "";
      return (await orNullOn404(() => request<{ backups: CloudLaneBackup[] }>("GET", `${CLOUD_PATHS.backups}${suffix}`)))?.backups ?? [];
    },
    laneBackup: (machineKey: string, laneId: string) =>
      orNullOn404(() => request<CloudLaneBackup>("GET", cloudBackupPath(machineKey, laneId))),
    /** One part (1-based) of a backup's bundle or patch. A browser gets the patch only. */
    readLaneBackupPart: async (machineKey: string, laneId: string, kind: CloudBackupKind, part: number): Promise<ArrayBuffer> => {
      const response = await request<Response>("GET", cloudBackupPath(machineKey, laneId, `${kind}/${part}`), { rawResponse: true, timeoutMs: timeoutMs * 4 });
      return await response.arrayBuffer();
    },
    /** From a cloud computer: an upload for one lane; 413 `backup_too_large` or `backup_account_full` past the caps. */
    startLaneBackup: (machineKey: string, laneId: string, start: CloudBackupUploadStart) =>
      request<CloudBackupUploadStarted>("POST", cloudBackupPath(machineKey, laneId, "uploads"), { body: start }),
    putLaneBackupPart: (machineKey: string, laneId: string, uploadId: string, kind: CloudBackupKind, part: number, instanceId: string, bytes: Uint8Array | ArrayBuffer | Blob) =>
      request<{ ok: true; bytes: number }>("PUT", cloudBackupPath(machineKey, laneId, `uploads/${encodeURIComponent(uploadId)}/${kind}/${part}`), {
        raw: { bytes: bytes as BodyInit, contentType: "application/octet-stream" },
        headers: { [CLOUD_INSTANCE_HEADER]: instanceId },
        timeoutMs: timeoutMs * 4,
      }),
    commitLaneBackup: (machineKey: string, laneId: string, uploadId: string, commit: CloudBackupUploadCommit) =>
      request<CloudLaneBackup>("POST", cloudBackupPath(machineKey, laneId, `uploads/${encodeURIComponent(uploadId)}/commit`), { body: commit, timeoutMs: timeoutMs * 2 }),
    /** From a cloud computer: the lane's work is on GitHub, so its backup (and the ones it restored) go. */
    deleteLaneBackup: (machineKey: string, laneId: string, instanceId: string) =>
      request<{ deleted: number }>("DELETE", cloudBackupPath(machineKey, laneId), { body: { instanceId } }),
    /** From a cloud computer: it applied this backup (the one with `fingerprint`) to its own lane. */
    markLaneBackupRestored: (machineKey: string, laneId: string, instanceId: string, fingerprint: string) =>
      request<{ ok: true }>("POST", cloudBackupPath(machineKey, laneId, "restored"), { body: { instanceId, fingerprint } }),
    /** From the person: deletes one lane's saved work for good. */
    forgetLaneBackup: (machineKey: string, laneId: string) =>
      request<{ deleted: number }>("POST", cloudBackupPath(machineKey, laneId, "forget"), { body: {} }),
    /** From a cloud computer: the state of every lane after a save. Null from an older server. */
    reportLaneBackups: (report: CloudBackupReport) =>
      orNullOn404(() => request<{ state: CloudBackupReportState }>("POST", `${CLOUD_PATHS.backups}/report`, { body: report })),
    /** Moves a restored chat's saved copy to this computer's machine key, with its full history. */
    moveSavedChat: (fromMachineKey: string, chatId: string, move: CloudChatMoveRequest) =>
      request<CloudChatMoveResult>("POST", cloudChatMovePath(fromMachineKey, chatId), { body: move }),
    /** Any brain: its whole lane set; the same hash writes nothing. Null from an older server. */
    putAccountLanes: (index: AccountLaneIndexPut) =>
      orNullOn404(() => request<AccountLaneIndexPutResult>("PUT", CLOUD_PATHS.accountLanes, { body: index })),

    /* Account data and integrations with no computer. Null: an older server without the route (keep today's behavior). */
    /** The account's agent limits. 409 `limits_unreadable` when a newer ADE saved them. */
    agentLimits: () => orNullOn404(() => request<CloudAgentLimitsState>("GET", CLOUD_EDGE_PATHS.limits)),
    /** Changes only the fields sent; 409 `limits_changed` when `ifRevision` is no longer the stored one. */
    saveAgentLimits: (update: CloudAgentLimitsUpdate) =>
      orNullOn404(() => request<CloudAgentLimitsState>("PUT", CLOUD_EDGE_PATHS.limits, { body: update })),
    /** Saved secrets' names (never values), account-wide or of one repository (`origin`). */
    accountSecrets: (args: { kind?: CloudAccountSecretKind; origin?: string | null } = {}) => {
      const query = new URLSearchParams();
      if (args.kind) query.set("kind", args.kind);
      if (args.origin) query.set("origin", args.origin);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      return orNullOn404(() => request<CloudAccountSecrets>("GET", `${CLOUD_EDGE_PATHS.accountSecrets}${suffix}`));
    },
    /** The CTO's account copy for a repository. */
    ctoCopy: (origin: string) =>
      orNullOn404(() => request<CloudCtoCopySummary>("GET", `${CLOUD_EDGE_PATHS.cto}?origin=${encodeURIComponent(origin)}`)),
    /** One fixed Linear read with the project's connection; 409 `linear_needs_renewal` / `linear_not_connected` say why not. */
    linearQuery: (query: CloudLinearQueryRequest) =>
      orNullOn404(() => request<CloudLinearQueryResult>("POST", CLOUD_EDGE_PATHS.linearQuery, { body: query })),
    jiraSearch: (search: CloudJiraSearchRequest) =>
      orNullOn404(() => request<CloudJiraSearchResult>("POST", CLOUD_EDGE_PATHS.jiraSearch, { body: search })),
    /** Null also when Jira has no such issue (or this sign-in can't see it). */
    jiraIssue: (issue: CloudJiraIssueRequest) =>
      orNullOn404(() => request<CloudJiraIssueResult>("POST", CLOUD_EDGE_PATHS.jiraIssue, { body: issue })),
    /** From the computer, at rest: the event topics that wake it (the whole list; `[]` removes it). */
    putEventWakes: (instanceId: string, topics: string[]) =>
      orNullOn404(() => request<CloudEventWakesResult>("PUT", cloudInstanceEventWakesPath(instanceId), {
        body: { topics } satisfies CloudEventWakesRequest,
        headers: { [CLOUD_INSTANCE_HEADER]: instanceId },
      })),
  };
}

export type CloudApiClient = ReturnType<typeof createCloudApiClient>;
