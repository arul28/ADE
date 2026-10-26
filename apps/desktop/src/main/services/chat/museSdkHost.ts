/**
 * One `muse serve` host, driven over the Muse Session Protocol (MSP).
 *
 * ADE uses `@muse-code/sdk` for the parts that are easy to get wrong — NDJSON
 * framing, command-id minting, retry and the schema fingerprint check — and
 * nothing above the raw `Connection`. ADE spawns the host process itself and
 * hands the SDK a `DuplexTransport` over its stdio (the SDK's documented way to
 * run MSP over any channel): the SDK's own spawn keeps the child private, and
 * on Windows it can only end the `muse` process itself, leaving the shells and
 * MCP servers it started running. Owning the process lets ADE end the whole
 * tree on every platform. The SDK's `MuseClient` facade
 * claims the connection's single notification handler and only surfaces turns,
 * items and approvals; ADE also needs token usage, context pressure, goals,
 * todos, subagents and the rest of the view stream, so it routes notifications
 * itself, by `sessionId`, the same way the Codex app-server runtime does.
 *
 * Contributor mode is never offered: every host is started with
 * `--contributor-mode off`, because `muse serve` does not honour the saved
 * setting (muse-code-sdk issue, 1.4.6+).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  checkServedFingerprint,
  Connection,
  MspError,
  ProtocolError,
  type DuplexTransport,
} from "@muse-code/sdk";
import type {
  ApprovalRequestParams,
  ApprovalResolvedParams,
  ApprovalUpdatedParams,
  CapabilityName,
  InitializeResult,
  ItemCompletedParams,
  ItemDeltaParams,
  ItemStartedParams,
  ItemUpdatedParams,
  PluginChangedParams,
  RecapCompletedParams,
  SessionApprovalModeChangedParams,
  SessionClosedParams,
  SessionContextUsageParams,
  SessionGoalChangedParams,
  SessionModelChangedParams,
  SessionModelRouteUnservedParams,
  SessionNameChangedParams,
  SessionReasoningEffortChangedParams,
  SessionStatusChangedParams,
  SessionTodoListChangedParams,
  SessionTokenUsageParams,
  SessionViewHealthChangedParams,
  SkillChangedParams,
  SubscriptionUsage,
  TurnCompletedParams,
  TurnForegroundCompletedParams,
  TurnRetractedParams,
  TurnRetryScheduledParams,
  TurnStartedParams,
  TurnUnqueuedParams,
  UserInputRequestParams,
  UserInputSettledParams,
  ViewGapParams,
} from "@muse-code/sdk/dist/src/msp.js";
import type { Logger } from "../logging/logger";
import { museCredentialEnv } from "../ai/museAuth";
import { ensureMuseBinary, museProviderOverride, resolveMuseExecutable } from "../ai/museExecutable";
import { checkMuseVendorFloor } from "../ai/museFallForward";
import { isRecord } from "../shared/utils";
import { terminateProcessTree } from "../shared/processExecution";
import { redactProcessOutput } from "../../utils/redaction";

/**
 * The params of each view notification ADE models, keyed by method. These are
 * the SDK's own types (msp.d.ts); the wire is trusted to match them, the way
 * the SDK's facade trusts it.
 */
type MuseNotificationParams = {
  "turn/started": TurnStartedParams;
  "turn/completed": TurnCompletedParams;
  "turn/unqueued": TurnUnqueuedParams;
  "turn/retracted": TurnRetractedParams;
  "turn/retryScheduled": TurnRetryScheduledParams;
  "turn/foregroundCompleted": TurnForegroundCompletedParams;
  "item/started": ItemStartedParams;
  "item/updated": ItemUpdatedParams;
  "item/delta": ItemDeltaParams;
  "item/completed": ItemCompletedParams;
  "approval/requested": ApprovalRequestParams;
  "approval/updated": ApprovalUpdatedParams;
  "approval/resolved": ApprovalResolvedParams;
  "userInput/requested": UserInputRequestParams;
  "userInput/settled": UserInputSettledParams;
  "session/tokenUsage": SessionTokenUsageParams;
  "session/contextUsage": SessionContextUsageParams;
  "session/todoListChanged": SessionTodoListChangedParams;
  "session/nameChanged": SessionNameChangedParams;
  "session/modelChanged": SessionModelChangedParams;
  "session/reasoningEffortChanged": SessionReasoningEffortChangedParams;
  "session/approvalModeChanged": SessionApprovalModeChangedParams;
  "session/goalChanged": SessionGoalChangedParams;
  "session/closed": SessionClosedParams;
  "session/statusChanged": SessionStatusChangedParams;
  "session/modelRouteUnserved": SessionModelRouteUnservedParams;
  "session/viewHealthChanged": SessionViewHealthChangedParams;
  "view/gap": ViewGapParams;
  "skill/changed": SkillChangedParams;
  "plugin/changed": PluginChangedParams;
  "recap/completed": RecapCompletedParams;
  /** Host-level (no `sessionId`): the account's subscription window. */
  "usage/changed": SubscriptionUsage;
};

/** A notification ADE models: narrow on `method` to get its SDK params. */
type MuseKnownNotification = {
  [M in keyof MuseNotificationParams]: { method: M; params: MuseNotificationParams[M] };
}[keyof MuseNotificationParams];

/**
 * Any other notification. Its params are only a record: ADE passes it along
 * and maps nothing from it.
 */
type MuseUnknownNotification = {
  method: string;
  params: Record<string, unknown>;
};

export type MuseNotification = MuseKnownNotification | MuseUnknownNotification;

const MUSE_KNOWN_METHODS: { readonly [M in keyof MuseNotificationParams]: true } = {
  "turn/started": true,
  "turn/completed": true,
  "turn/unqueued": true,
  "turn/retracted": true,
  "turn/retryScheduled": true,
  "turn/foregroundCompleted": true,
  "item/started": true,
  "item/updated": true,
  "item/delta": true,
  "item/completed": true,
  "approval/requested": true,
  "approval/updated": true,
  "approval/resolved": true,
  "userInput/requested": true,
  "userInput/settled": true,
  "session/tokenUsage": true,
  "session/contextUsage": true,
  "session/todoListChanged": true,
  "session/nameChanged": true,
  "session/modelChanged": true,
  "session/reasoningEffortChanged": true,
  "session/approvalModeChanged": true,
  "session/goalChanged": true,
  "session/closed": true,
  "session/statusChanged": true,
  "session/modelRouteUnserved": true,
  "session/viewHealthChanged": true,
  "view/gap": true,
  "skill/changed": true,
  "plugin/changed": true,
  "recap/completed": true,
  "usage/changed": true,
};

/**
 * Whether a notification is one ADE models. The predicate narrows the union to
 * the SDK-typed members, so a `switch` on `method` sees exact params.
 */
export function isMuseKnownNotification(notification: MuseNotification): notification is MuseKnownNotification {
  return Object.prototype.hasOwnProperty.call(MUSE_KNOWN_METHODS, notification.method);
}

/** The params of one wire message: a record, or nothing. */
function wireParams(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** One notification as it came off the wire (a `view/page` event included). */
export function museNotificationFromWire(message: { method: string; params?: unknown }): MuseNotification {
  return { method: message.method, params: wireParams(message.params) };
}

/** The `viewCursor` a notification carries, when it has one. */
export function museViewCursorOf(notification: MuseNotification): string | null {
  const params: unknown = notification.params;
  return isRecord(params) && typeof params.viewCursor === "string" ? params.viewCursor : null;
}

export type MuseHostExit = {
  /** Why the host ended, in ADE words. */
  kind: "clean" | "crash" | "config" | "auth" | "unknown";
  code: number | null;
  signal: string | null;
  stderrTail: string[];
};

type MuseHostStartOptions = {
  /** Absolute path of the pinned `muse` binary. */
  musePath: string;
  cwd: string;
  /** Full child environment (it REPLACES the parent's). */
  env: NodeJS.ProcessEnv;
  /** Extra `muse serve` flags after the fixed ones (provider, model, sandbox posture, `-c` settings). */
  serveArgs?: string[];
  clientVersion: string;
  logger?: Pick<Logger, "info" | "warn" | "debug"> | null;
  /**
   * Capabilities to ask for beyond the chat set. Settings asks for Muse's own
   * computer-use setup (`computerUseSetup`, `computerUseHostSetup`); a chat
   * host does not.
   */
  extraCapabilities?: CapabilityName[];
  /**
   * Whether this client can show `request_user_input` dialogs (MSP
   * `ClientCapabilities.userInputDialogs`; absent means capable). A one-shot
   * task host that nobody watches says no, so Muse never waits on a question.
   */
  userInputDialogs?: boolean;
};

export type MuseHost = {
  readonly initializeResult: InitializeResult;
  readonly grantedCapabilities: ReadonlySet<CapabilityName>;
  readonly alive: boolean;
  /** A read-only request (no `commandId`). */
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** A state-changing command; the SDK mints the `commandId` and retries retryable refusals. */
  command<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    options?: { commandId?: string },
  ): Promise<T>;
  /** Mint a command id without sending (for `turn/start`, whose turn id derives from it). */
  mintCommandId(): string;
  /** Notifications for one MSP session. Returns an unsubscribe. */
  subscribe(sessionId: string, handler: (notification: MuseNotification) => void): () => void;
  /** Notifications that carry no `sessionId` (usage, plugin and skill catalog changes). */
  onHostNotification(handler: (notification: MuseNotification) => void): () => void;
  onExit(handler: (exit: MuseHostExit) => void): () => void;
  stderrTail(): string[];
  close(): Promise<void>;
  /** End the process tree now, synchronously (process-exit hooks cannot await). */
  killNow(): void;
};

/** `clientInfo.name` must match `^[a-z0-9_]+$` (MSP SS1.4.1). */
const MUSE_CLIENT_NAME = "ade";

/**
 * What ADE asks the host for. `sessionMcp` lets ADE attach its own MCP servers
 * to each session; `userShell` backs the composer's `!cmd`. Unknown names are
 * simply not granted, so asking for all of them is safe on older hosts.
 */
const REQUESTED_CAPABILITIES: CapabilityName[] = [
  "sessionMcp",
  "userShell",
  "feedback",
  "sessionListStream",
];

const STDERR_TAIL_LIMIT = 40;
/** The longest unfinished stderr line kept for whole-line redaction. */
const STDERR_LINE_LIMIT = 16_000;
/** MSP SS2.1.2: the host drains after stdin EOF; past this, the rest is a crash. */
const CLOSE_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;

function museServeBaseArgs(): string[] {
  return ["serve", "--contributor-mode", "off"];
}

function classifyExitKind(stderrTail: readonly string[], code: number | null): MuseHostExit["kind"] {
  if (code === 0) return "clean";
  const text = stderrTail.join("\n").toLowerCase();
  if (/(not logged in|no credential|unauthori[sz]ed|401|login required|api key)/.test(text)) return "auth";
  if (/(invalid configuration|config error|unknown setting|refuse)/.test(text)) return "config";
  return code === null ? "unknown" : "crash";
}

export function describeMuseError(error: unknown): string {
  if (error instanceof MspError) {
    const reason = typeof error.data?.reason === "string" ? ` (${error.data.reason})` : "";
    return `${error.message}${reason}`;
  }
  if (error instanceof ProtocolError) return `Muse sent a reply ADE could not read: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function isMuseErrorKind(error: unknown, ...kinds: string[]): boolean {
  return error instanceof MspError && kinds.includes(String(error.kind));
}

export async function startMuseHost(options: MuseHostStartOptions): Promise<MuseHost> {
  const stderr: string[] = [];
  /** The line still being written: a secret split across two chunks is redacted whole. */
  let stderrPartial = "";
  let droppingStderrLine = false;
  const pushStderr = (chunk: string) => {
    let text = chunk;
    if (droppingStderrLine) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      text = text.slice(newline + 1);
      droppingStderrLine = false;
    }
    const lines = `${stderrPartial}${text}`.split(/\r?\n/);
    stderrPartial = lines.pop() ?? "";
    // A line this long (a progress bar redrawn with `\r`) is dropped through
    // its next newline rather than kept or cut: a fragment could hold half a secret.
    if (stderrPartial.length > STDERR_LINE_LIMIT) {
      stderrPartial = "";
      droppingStderrLine = true;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      // The tail reaches the chat's error notice, so its secrets go first.
      stderr.push(redactProcessOutput(line));
      if (stderr.length > STDERR_TAIL_LIMIT) stderr.shift();
    }
  };
  const stderrTail = (): string[] =>
    stderrPartial.trim() ? [...stderr, redactProcessOutput(stderrPartial)].slice(-STDERR_TAIL_LIMIT) : stderr.slice();
  // POSIX: the host leads its own process group so one signal reaches every
  // shell and MCP server it started. Windows has no groups; `taskkill /T`
  // (terminateProcessTree) walks the tree instead.
  const ownsProcessGroup = process.platform !== "win32";
  const child: ChildProcessWithoutNullStreams = spawn(
    options.musePath,
    [...museServeBaseArgs(), ...(options.serveArgs ?? [])],
    { cwd: options.cwd, env: options.env, detached: ownsProcessGroup, windowsHide: true, stdio: "pipe" },
  );
  // Mirrors the SDK's spawn (FM-001): a write or end after Muse exits must not
  // crash Electron's main process. The write and end callbacks still reject.
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => pushStderr(chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => {
      pushStderr(`${error.message}\n`);
      resolve({ code: null, signal: null });
    });
  });
  let processGone = false;
  void exited.then(() => { processGone = true; });
  const signalTree = (signal: NodeJS.Signals): void => {
    if (processGone) return;
    if (ownsProcessGroup && typeof child.pid === "number") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The group already exited, or was never formed; fall through.
      }
    }
    terminateProcessTree(child, signal);
  };
  const within = (ms: number) => Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref?.()),
  ]);
  const transport: DuplexTransport = {
    incoming: child.stdout,
    write: (chunk) => new Promise<void>((resolve, reject) => {
      child.stdin.write(chunk, (error) => (error ? reject(error) : resolve()));
    }),
    close: async (flushed) => {
      // Frames already handed to the connection go out before EOF, but a
      // wedged host can never hold the close open past the grace window.
      if (flushed) await Promise.race([flushed, within(CLOSE_GRACE_MS)]).catch(() => undefined);
      child.stdin.end();
    },
  };
  const connection = new Connection(transport);

  const sessionHandlers = new Map<string, Set<(n: MuseNotification) => void>>();
  const hostHandlers = new Set<(n: MuseNotification) => void>();
  const exitHandlers = new Set<(exit: MuseHostExit) => void>();
  let alive = true;
  let closing = false;

  const route = (raw: { method: string; params?: unknown }) => {
    const params = wireParams(raw.params);
    const notification: MuseNotification = { method: raw.method, params };
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    // The SDK calls this inside its read loop, and a throw there ends the
    // connection (every later request then fails "connection is closed").
    // One bad handler must cost one event, not the chat.
    const deliver = (handler: (n: MuseNotification) => void) => {
      try {
        handler(notification);
      } catch (error) {
        options.logger?.warn("agent_chat.muse_notification_handler_failed", {
          method: notification.method,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    if (!sessionId) {
      for (const handler of hostHandlers) deliver(handler);
      return;
    }
    const handlers = sessionHandlers.get(sessionId);
    if (!handlers?.size) return;
    for (const handler of handlers) deliver(handler);
  };
  connection.onNotification((n) => route(n));
  // Approvals and questions arrive as view notifications, and Muse re-issues
  // the still-open ones as server-to-client requests right after a
  // `session/resume` (tdd SS5.6). Those are folded into the same session
  // stream as the notification they mirror; the reply is only a presentation
  // receipt, the decision still travels as `approval/decide` /
  // `userInput/answer`. With nobody subscribed yet the request is refused,
  // which keeps it pending for the next subscribe (ADE also pulls
  // `approval/listPending` once it subscribes). Anything else is refused so
  // the host never waits.
  connection.onServerRequest(async (request) => {
    const raw = request;
    const method = raw.method ?? "unknown";
    const mirrored = method === "approval/request"
      ? "approval/requested"
      : method === "userInput/request"
        ? "userInput/requested"
        : null;
    const params = wireParams(raw.params);
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    if (mirrored && sessionId && sessionHandlers.get(sessionId)?.size) {
      route({ method: mirrored, params });
      return {};
    }
    options.logger?.warn("agent_chat.muse_unexpected_server_request", { method });
    throw new Error(mirrored
      ? "No ADE chat is attached to this Muse session yet."
      : "ADE does not serve MSP server-to-client requests.");
  });
  connection.onProtocolError((error) => {
    options.logger?.warn("agent_chat.muse_protocol_error", { message: error.message });
  });

  // The MSP SS1.4 handshake, as the SDK's own `MspHandshake.initialize` does
  // it: `initialize`, a result that must carry a schema fingerprint, then the
  // `initialized` notification.
  let initializeResult: InitializeResult;
  try {
    const result = await Promise.race([
      connection.request("initialize", {
        clientInfo: { name: MUSE_CLIENT_NAME, version: options.clientVersion },
        capabilities: {
          requestedCapabilities: [...new Set([...REQUESTED_CAPABILITIES, ...(options.extraCapabilities ?? [])])],
          userInputDialogs: options.userInputDialogs ?? true,
        },
      }),
      exited.then(() => {
        throw new Error("Muse stopped before it finished starting.");
      }),
    ]) as unknown as InitializeResult; // The SDK types request results as plain records; this one is InitializeResult.
    if (typeof result?.schema?.fingerprint !== "string") {
      throw new ProtocolError("initialize result has no schema fingerprint");
    }
    const fingerprintWarning = checkServedFingerprint(result.schema.fingerprint);
    if (fingerprintWarning) {
      options.logger?.warn("agent_chat.muse_schema_fingerprint_mismatch", {
        pinned: fingerprintWarning.pinned,
        served: fingerprintWarning.served,
      });
    }
    connection.notify("initialized");
    await connection.flush();
    initializeResult = result;
  } catch (error) {
    await connection.close().catch(() => undefined);
    if (!(await within(KILL_GRACE_MS))) signalTree("SIGKILL");
    const detail = stderrTail().slice(-8).join("\n");
    const base = describeMuseError(error);
    throw new Error(detail ? `${base}\n${detail}` : base);
  }

  // A death is reported once, from whichever comes first: the process exits,
  // or the connection closes under a process that is still running (a wedged
  // host, then ended here).
  let deathReported = false;
  const reportDeath = (exit: { code: number | null; signal: NodeJS.Signals | null }) => {
    if (deathReported) return;
    deathReported = true;
    alive = false;
    const tail = stderrTail();
    const kind = closing ? "clean" : classifyExitKind(tail, exit.code);
    const payload: MuseHostExit = {
      kind,
      code: exit.code,
      signal: exit.signal ?? null,
      stderrTail: tail,
    };
    options.logger?.info("agent_chat.muse_host_exit", {
      kind,
      code: exit.code,
      signal: exit.signal ?? null,
    });
    for (const handler of exitHandlers) handler(payload);
  };
  void exited.then(reportDeath);
  void connection.closed.then(() => {
    if (closing || processGone) return;
    reportDeath({ code: null, signal: null });
    signalTree("SIGKILL");
  });

  const granted = new Set<CapabilityName>(initializeResult.grantedCapabilities ?? []);

  return {
    initializeResult,
    grantedCapabilities: granted,
    get alive() {
      return alive;
    },
    async request<T>(method: string, params: Record<string, unknown> = {}) {
      return await connection.request(method, params) as T;
    },
    async command<T>(method: string, params: Record<string, unknown>, options?: { commandId?: string }) {
      // The connection stamps `commandId` itself; a caller that needs a known
      // id (turn/start, whose turn id derives from it) passes it here.
      return await connection.command(method, params, options?.commandId ? { commandId: options.commandId } : undefined) as T;
    },
    mintCommandId: () => connection.mintCommandId(),
    subscribe(sessionId, handler) {
      let set = sessionHandlers.get(sessionId);
      if (!set) {
        set = new Set();
        sessionHandlers.set(sessionId, set);
      }
      set.add(handler);
      return () => {
        const current = sessionHandlers.get(sessionId);
        current?.delete(handler);
        if (current && current.size === 0) sessionHandlers.delete(sessionId);
      };
    },
    onHostNotification(handler) {
      hostHandlers.add(handler);
      return () => hostHandlers.delete(handler);
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    stderrTail,
    async close() {
      if (closing) return;
      closing = true;
      // EOF first and let Muse wind down (it ends its own children), then the
      // tree: SIGTERM, and SIGKILL for anything still standing.
      await connection.close().catch(() => undefined);
      if (!(await within(CLOSE_GRACE_MS))) {
        signalTree("SIGTERM");
        if (!(await within(KILL_GRACE_MS))) signalTree("SIGKILL");
      }
      alive = false;
    },
    killNow() {
      closing = true;
      signalTree("SIGKILL");
      alive = false;
    },
  };
}

type PinnedMuseLaunchOptions = {
  /** The environment the host inherits; Muse's credential variables are added to it. */
  baseEnv: NodeJS.ProcessEnv;
  /** Which saved Muse key to sign in with; absent means the default slot. */
  credentialId?: string | null;
  /**
   * `install` (default) fetches the pinned build when it is missing. `installed`
   * only uses a build already on disk and throws when there is none: a
   * read-only host must never start a download.
   */
  binary?: "install" | "installed";
  /** Short-lived hosts (catalog, reads, one-shot tasks) write no session log. */
  noSessionLog?: boolean;
  /** Extra `muse serve` flags after the shared ones (e.g. `--trust-workspace`). */
  extraServeArgs?: string[];
};

type PinnedMuseLaunch = {
  musePath: string;
  env: NodeJS.ProcessEnv;
  serveArgs: string[];
};

/**
 * The one recipe for starting a Muse host: the child env with the saved
 * credential, the pinned binary, and ADE's provider override (`ADE_MUSE_PROVIDER`,
 * a developer or test switch to Muse's offline `echo` provider). Callers that
 * must compare a running host with the one they would start (the chat runtime's
 * reuse check) resolve the launch first and then start it.
 */
export async function resolvePinnedMuseLaunch(options: PinnedMuseLaunchOptions): Promise<PinnedMuseLaunch> {
  const env: NodeJS.ProcessEnv = {
    ...options.baseEnv,
    ...museCredentialEnv(options.baseEnv, options.credentialId ?? undefined),
  };
  // Meta's published floor, read at most every few hours; a switch it makes
  // applies to the next launch (this one already resolved its build).
  void checkMuseVendorFloor();
  let musePath: string;
  if (options.binary === "installed") {
    const resolved = resolveMuseExecutable();
    if (!resolved.path) throw new Error("Muse is not installed on this machine yet.");
    musePath = resolved.path;
  } else {
    musePath = await ensureMuseBinary({ env });
  }
  const providerOverride = museProviderOverride(options.baseEnv);
  const serveArgs = [
    ...(providerOverride ? ["--provider", providerOverride] : []),
    ...(options.noSessionLog ? ["--no-session-log"] : []),
    ...(options.extraServeArgs ?? []),
  ];
  return { musePath, env, serveArgs };
}

type StartPinnedMuseHostOptions = PinnedMuseLaunchOptions & {
  cwd: string;
  clientVersion: string;
  logger?: Pick<Logger, "info" | "warn" | "debug"> | null;
  /** See {@link MuseHostStartOptions.userInputDialogs}. */
  userInputDialogs?: boolean;
  /** See {@link MuseHostStartOptions.extraCapabilities}. */
  extraCapabilities?: CapabilityName[];
};

/** {@link resolvePinnedMuseLaunch}, then {@link startMuseHost} with the same launch. */
export async function startPinnedMuseHost(options: StartPinnedMuseHostOptions): Promise<MuseHost> {
  const launch = await resolvePinnedMuseLaunch(options);
  return startMuseHost({
    musePath: launch.musePath,
    cwd: options.cwd,
    env: launch.env,
    serveArgs: launch.serveArgs,
    clientVersion: options.clientVersion,
    logger: options.logger,
    userInputDialogs: options.userInputDialogs,
    extraCapabilities: options.extraCapabilities,
  });
}
