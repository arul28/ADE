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
  CLOUD_INSTANCE_HEADER,
  CLOUD_PATHS,
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
  type CloudCapsuleCommit,
  type CloudCapsuleManifest,
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
  type CloudSessionUpload,
  type CloudAccountSignIns,
  type CloudAccountState,
  type CloudAutomationRegistered,
  type CloudAutomationRegistration,
  type CloudAutomationRun,
  type CloudAutomationSummary,
  type CloudChatRow,
  type CloudChatTranscriptPage,
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
  type CloudProjectComputersDeleteStarted,
  type CloudProjectComputersJob,
  type CloudProjectComputersPreview,
  type CloudRemoteSignInStart,
  type CloudRemoteSignInStatus,
  type CloudServerLaunchRequest,
} from "../../../account-directory/src/cloud/contract";
// --- server-edge ---
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
    const headers: Record<string, string> = { accept: "application/json", ...init.headers };
    if (!init.anonymous) {
      const token = await options.accessToken();
      if (!token) throw new CloudApiError("Sign in to ADE to use ADE Cloud.", "unauthorized", 401);
      headers.authorization = `Bearer ${token}`;
    }
    let body: BodyInit | undefined;
    if (init.raw) {
      body = init.raw.bytes;
      headers["content-type"] = init.raw.contentType;
    } else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    }
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new CloudApiError(timedOut ? "ADE Cloud did not answer in time. Try again." : "ADE Cloud can't be reached. Check your connection.", timedOut ? "timeout" : "network", 0);
    }
    if (response.ok && init.rawResponse) return response as unknown as T;
    const text = await response.text().catch(() => "");
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
    sleep: (instanceId: string) => request<{ status: string }>("POST", `${instancePath(instanceId)}/sleep`, { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }),
    /** The server restarts the computer on the newest ADE for its channel. */
    update: (instanceId: string) => request<{ status: string }>("POST", `${instancePath(instanceId)}/update`, { body: {}, timeoutMs: LIFECYCLE_TIMEOUT_MS }),
    /** At most one every 15 minutes (`rate_limited`). */
    backup: (instanceId: string) =>
      request<{ id?: string | null; created?: number | null; sizeBytes?: number | null }>("POST", `${instancePath(instanceId)}/backups`, { body: {}, timeoutMs: BACKUP_TIMEOUT_MS }),
    wake: (instanceId: string, args: { reason?: "push_work" } = {}) =>
      request<{ status: string }>("POST", `${instancePath(instanceId)}/start`, { body: args, timeoutMs: LIFECYCLE_TIMEOUT_MS }),
    /** The server wakes a sleeping computer first. `computerIdle` is needed to grow the disk of a running one. */
    resize: (instanceId: string, args: { cpu?: number; memory?: number; disk?: number; computerIdle?: boolean }) =>
      request<{ status: string }>("POST", `${instancePath(instanceId)}/resize`, { body: args, timeoutMs: LIFECYCLE_TIMEOUT_MS }),
    deleteComputer: (instanceId: string, args: { who?: string | null; reason?: string | null } = {}) =>
      request<{ deleted: true }>("DELETE", instancePath(instanceId), { body: args }),

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
    /**
     * The account's saved chats (the server's copy, readable with no computer
     * running). A 404 is an account without ADE Cloud: no chats, not a failure.
     */
    savedChats: async (args: { machineKey?: string | null; projectKey?: string | null; limit?: number; cursor?: string | null } = {}) => {
      const query = new URLSearchParams();
      if (args.machineKey) query.set("machine", args.machineKey);
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

    /* ---- ADE without a computer: reads (never wake) ---- */
    /** One project's whole ADE Cloud view. Null from an older server: read the separate lists as before. */
    projectOverview: (origin: string) =>
      orNullOn404(() => request<CloudProjectOverview>("GET", `${CLOUD_PATHS.projectsOverview}?origin=${encodeURIComponent(origin)}`)),
    /** CLI-session and shell copies; null from an older server. */
    savedSessions: (args: { machineKey?: string | null; projectKey?: string | null; cursor?: string | null } = {}) => {
      const query = new URLSearchParams();
      if (args.machineKey) query.set("machine", args.machineKey);
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
    /** Part `part` (1-based, at most 6 MiB) of a capsule; a put of part 1 starts a new capsule. */
    putCapsulePart: (machineKey: string, chatId: string, part: number, instanceId: string, bytes: Uint8Array | ArrayBuffer | Blob) =>
      request<{ ok: true; bytes: number }>("PUT", cloudCapsulePath(machineKey, chatId, { part }), {
        raw: { bytes: bytes as BodyInit, contentType: "application/octet-stream" },
        headers: { [CLOUD_INSTANCE_HEADER]: instanceId },
        timeoutMs: timeoutMs * 2,
      }),
    commitCapsule: (machineKey: string, chatId: string, commit: CloudCapsuleCommit) =>
      request<CloudCapsuleManifest>("POST", cloudCapsulePath(machineKey, chatId, "commit"), { body: commit }),
    /** The capsule saved for a chat; null when there is none (replay the saved transcript). */
    capsuleManifest: (machineKey: string, chatId: string) =>
      orNullOn404(() => request<CloudCapsuleManifest>("GET", cloudCapsulePath(machineKey, chatId))),
    readCapsulePart: async (machineKey: string, chatId: string, part: number): Promise<ArrayBuffer> => {
      const response = await request<Response>("GET", cloudCapsulePath(machineKey, chatId, { part }), { rawResponse: true, timeoutMs: timeoutMs * 2 });
      return await response.arrayBuffer();
    },
    /** Moves a restored chat's saved copy to this computer's machine key, with its full history. */
    moveSavedChat: (fromMachineKey: string, chatId: string, move: CloudChatMoveRequest) =>
      request<CloudChatMoveResult>("POST", cloudChatMovePath(fromMachineKey, chatId), { body: move }),
    /** Any brain: its whole lane set; the same hash writes nothing. Null from an older server. */
    putAccountLanes: (index: AccountLaneIndexPut) =>
      orNullOn404(() => request<AccountLaneIndexPutResult>("PUT", CLOUD_PATHS.accountLanes, { body: index })),

    // --- server-edge ---
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
    // --- end server-edge ---
  };
}

export type CloudApiClient = ReturnType<typeof createCloudApiClient>;
