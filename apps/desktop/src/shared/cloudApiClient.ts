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
  type CloudAccountState,
  type CloudInstance,
  type CloudLaunchJoinRequest,
  type CloudLaunchJoinResult,
  type CloudLaunchRecord,
  type CloudLaunchStagesUpdate,
  type CloudProjectComputersDeleteStarted,
  type CloudProjectComputersJob,
  type CloudProjectComputersPreview,
  type CloudRemoteSignInStart,
  type CloudRemoteSignInStatus,
  type CloudServerLaunchRequest,
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

  return {
    /* ---- List ---- */
    account: () => request<CloudAccountState>("GET", CLOUD_PATHS.account),
    listComputers: async () => (await request<{ data: CloudInstance[] }>("GET", CLOUD_PATHS.instances)).data,

    /* ---- A lane on a new computer (the server launcher) ---- */
    /** Files first (at most 10, 25 MB each), then `startLaunch` names them by `fileId`. */
    uploadLaunchFile: (launchId: string, fileId: string, bytes: Blob | ArrayBuffer | Uint8Array, contentType: string) =>
      request<{ fileId: string; sizeBytes: number }>("PUT", `${launchPath(launchId)}/files/${encodeURIComponent(fileId)}`, {
        raw: { bytes: bytes as BodyInit, contentType: contentType || "application/octet-stream" },
        timeoutMs: timeoutMs * 4,
      }),
    /** 201 for a new launch; the same `launchId` again answers the same launch. */
    startLaunch: (launch: CloudServerLaunchRequest) => request<CloudLaunchRecord>("POST", CLOUD_PATHS.launches, { body: launch, timeoutMs: timeoutMs * 4 }),
    launchStatus: (launchId: string) => request<CloudLaunchRecord>("GET", launchPath(launchId)),
    /** Before the agent starts it deletes the computer; after, the server refuses with `launch_started`. */
    cancelLaunch: (launchId: string) => request<CloudLaunchRecord>("DELETE", launchPath(launchId)),

    /* ---- One computer ---- */
    wake: (instanceId: string, args: { reason?: "push_work" } = {}) =>
      request<{ status: string }>("POST", `${instancePath(instanceId)}/start`, { body: args }),
    /** The server wakes a sleeping computer first. `computerIdle` is needed to grow the disk of a running one. */
    resize: (instanceId: string, args: { cpu: number; memory: number; disk?: number; computerIdle?: boolean }) =>
      request<{ status: string }>("POST", `${instancePath(instanceId)}/resize`, { body: args }),
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

    /* ---- A project's computers ---- */
    previewProjectComputers: (origin: string) =>
      request<CloudProjectComputersPreview>("POST", CLOUD_PATHS.projectComputersDelete, { body: { origin, dryRun: true } }),
    /** Only the computers the preview listed (`instanceIds`) that still belong to the origin. */
    deleteProjectComputers: (origin: string, instanceIds: readonly string[]) =>
      request<CloudProjectComputersDeleteStarted>("POST", CLOUD_PATHS.projectComputersDelete, { body: { origin, instanceIds } }),
    projectComputersJob: (jobId: string) =>
      request<CloudProjectComputersJob>("GET", `${CLOUD_PATHS.projectComputersDelete}/${encodeURIComponent(jobId)}`),

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
    readLaunchFile: async (launchId: string, fileId: string): Promise<ArrayBuffer> => {
      const response = await request<Response>("GET", `${launchPath(launchId)}/files/${encodeURIComponent(fileId)}`, { rawResponse: true, timeoutMs: timeoutMs * 4 });
      return await response.arrayBuffer();
    },
  };
}

export type CloudApiClient = ReturnType<typeof createCloudApiClient>;
