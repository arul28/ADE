import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { THIS_MACHINE_NAME } from "../../../../desktop/src/shared/machineIdentity";
import {
  BUILT_IN_BROWSER_REMOTE_CALL_EVENT,
  BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILE_BYTES,
  BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILES,
  BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT,
  builtInBrowserRemoteCallDoneTimeoutMs,
  isBuiltInBrowserRemoteCallMethod,
  type BuiltInBrowserForwardedToDesktop,
  type BuiltInBrowserHostNote,
  type BuiltInBrowserRemoteCall,
  type BuiltInBrowserRemoteCallFile,
  type BuiltInBrowserRemoteCallMethod,
  type BuiltInBrowserRemoteRequest,
  type BuiltInBrowserRemoteRequestAck,
} from "../../../../desktop/src/shared/types/builtInBrowserRemote";
import { DesktopBridgeUnavailableError } from "./desktopBridgeClient";
import type { SessionInputOrigin } from "../../../../desktop/src/shared/sessionInputOrigin";
import {
  BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD,
  BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
  BUILT_IN_BROWSER_METHOD_ROUTES,
  BUILT_IN_BROWSER_REPLY_REMOTE_CALL_METHOD,
  isBuiltInBrowserDesktopBridgeMethod,
  type BuiltInBrowserDesktopBridgeClient,
  type BuiltInBrowserLocalFileMethod,
} from "./desktopBridgeMethods";

/**
 * The browser an agent's `ade browser` command runs in.
 *
 * The rule is "the browser where the user sits". A chat's last message names
 * the desktop it came from (`SessionInputOrigin`). When that desktop is not on
 * this machine (a Mac Studio driving a chat that runs on a Windows PC), the
 * agent's commands go to it: opens through the request path, which owns the
 * port-forward approval, and every command that acts on a tab through the
 * call path, which carries the result back. The user then watches the agent
 * work in their own pane, with their own sign-ins, and can hand it their own
 * tabs. `BUILT_IN_BROWSER_METHOD_ROUTES` says which machine runs each method.
 *
 * The agent's own machine stays the fallback: when no desktop takes a command
 * within a few seconds (the user is on the phone, the laptop is closed), and
 * when the agent asks for it (`--here`, an isolated sign-in). A command that
 * ran here although the user is elsewhere says so in its result.
 *
 * Without a desktop on this machine: the built-in browser is a
 * `WebContentsView` owned by an Electron main process, so a box running only
 * `ade serve` has no browser to open — the bridge socket simply isn't
 * listening. The request path covers that case too: a desktop that holds a
 * remote pin on this machine's lane opens the URL in its browser.
 */

const ACK_TIMEOUT_MS = 5_000;
/** How long a desktop has to say it took a command before this machine runs it. */
const CALL_TAKEN_TIMEOUT_MS = 4_000;
/** Chats whose last browser (and silent desktop) this daemon remembers. */
const LAST_HOST_CAP = 200;
/**
 * After a desktop did not take a command, how long its chat's commands run
 * here without asking it again. Without this, every command of an agent whose
 * user closed the laptop would wait out the "nobody answered" clock.
 */
const USER_DESKTOP_RETRY_AFTER_MS = 60_000;
/** Replies whose files are kept for the agent to read; older ones are pruned. */
const RECEIVED_FILE_DIR_CAP = 40;

/** The CLI words for the commands that stay on this machine, for a message an agent can act on. */
const LOCAL_FILE_COMMAND_WORDS: Record<BuiltInBrowserLocalFileMethod, string> = {
  uploadFile: "`ade browser upload`",
  dropFiles: "`ade browser drop`",
  exportHar: "`ade browser har`",
  startRecording: "`ade browser record start`",
  stopRecording: "`ade browser record stop`",
};

/** What a desktop that names no machine is called in a message to the agent. */
const UNNAMED_USER_DESKTOP = "the user's computer";

type PendingRequest = {
  resolve: (ack: BuiltInBrowserRemoteRequestAck | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RemoteCallOutcome =
  | { taken: false }
  | { taken: true; desktopLabel: string; ok: true; result: unknown }
  | { taken: true; desktopLabel: string; ok: false; error: string; needsPane?: boolean };

type PendingCall = {
  method: BuiltInBrowserRemoteCallMethod;
  /** The only desktop whose reply settles this call. */
  targetClientId: string;
  doneTimeoutMs: number;
  resolve: (outcome: RemoteCallOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  desktopLabel: string | null;
};

export type RemoteBrowserForwarder = {
  /**
   * Run one bridge method in the browser `BUILT_IN_BROWSER_METHOD_ROUTES`
   * picks for it: the desktop the user sits at, or this machine's (`call`).
   */
  route: (
    input: unknown,
    call: (input: unknown) => Promise<unknown>,
    method: string,
  ) => Promise<unknown>;
  /** Runtime action a desktop calls once it has taken (or refused) a request. */
  acknowledgeRemoteRequest: (input: unknown) => { ok: boolean };
  /** Runtime action a desktop calls when it takes a command, and again with its outcome. */
  replyRemoteCall: (input: unknown) => { ok: boolean };
  dispose: () => void;
};

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A desktop's name for itself, for a message to an agent on another machine.
 * "This computer" is the desktop's word for itself; to the agent it would
 * read as its own machine, so it counts as no name.
 */
function desktopLabelFrom(value: unknown): string | null {
  const label = stringOrNull(value);
  return label && label !== THIS_MACHINE_NAME ? label : null;
}

/** Remove a pending entry and hand it its outcome; false when it was already settled. */
function settleEntry<Outcome>(
  entries: Map<string, { resolve: (outcome: Outcome) => void; timer: ReturnType<typeof setTimeout> }>,
  requestId: string,
  outcome: Outcome,
): boolean {
  const entry = entries.get(requestId);
  if (!entry) return false;
  entries.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve(outcome);
  return true;
}

/**
 * Clear every `filePath` in a result that is not a file written here. A file
 * the desktop did not send (over the size cap, unreadable) keeps a path that
 * exists only on the user's computer, which the agent cannot read.
 */
function clearForeignFilePaths(node: unknown, keep: ReadonlySet<string>, depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) clearForeignFilePaths(item, keep, depth + 1);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "filePath" && typeof value === "string" && !keep.has(value)) {
      node.filePath = null;
      if ("relativePath" in node) node.relativePath = null;
      continue;
    }
    clearForeignFilePaths(value, keep, depth + 1);
  }
}

function filesFromReply(value: unknown): BuiltInBrowserRemoteCallFile[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILES).filter((file): file is BuiltInBrowserRemoteCallFile => (
    isRecord(file)
    && Array.isArray(file.pointer)
    && file.pointer.length > 0
    && file.pointer.length <= 6
    && file.pointer.every((key) => typeof key === "string")
    && typeof file.fileName === "string"
    && typeof file.base64 === "string"
  ));
}

export function createRemoteBrowserForwarder(args: {
  emitEvent: (payload: Record<string, unknown>) => void;
  logger: Logger;
  /** The desktop that sent a chat its last message, when one is known. */
  resolveOrigin?: (chatSessionId: string) => SessionInputOrigin | null;
  ackTimeoutMs?: number;
  callTakenTimeoutMs?: number;
  /**
   * Where files a desktop sends back (an observation's screenshot) are written
   * so the agent can read them. Without it such a result keeps a path that
   * exists only on the desktop, and the path is cleared instead.
   */
  receivedFilesDir?: string | null;
}): RemoteBrowserForwarder {
  const pending = new Map<string, PendingRequest>();
  const pendingCalls = new Map<string, PendingCall>();
  /** Which browser a chat's last command ran in, newest last. */
  const lastHost = new Map<string, "user-desktop" | "here">();
  /** Chat → the desktop that did not answer, and until when it is left alone. */
  const unanswered = new Map<string, { clientId: string; untilMs: number }>();
  const ackTimeoutMs = args.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  const callTakenTimeoutMs = args.callTakenTimeoutMs ?? CALL_TAKEN_TIMEOUT_MS;

  function rememberHost(chatSessionId: string | null, host: "user-desktop" | "here"): void {
    if (!chatSessionId) return;
    lastHost.delete(chatSessionId);
    lastHost.set(chatSessionId, host);
    while (lastHost.size > LAST_HOST_CAP) {
      const oldest = lastHost.keys().next().value;
      if (oldest === undefined) break;
      lastHost.delete(oldest);
    }
  }

  const settleCall = (requestId: string, outcome: RemoteCallOutcome): boolean =>
    settleEntry(pendingCalls, requestId, outcome);
  const settle = (requestId: string, ack: BuiltInBrowserRemoteRequestAck | null): boolean =>
    settleEntry(pending, requestId, ack);

  /** Write the files a reply carries where the agent can read them, and point the result at them. */
  function receiveFiles(requestId: string, result: unknown, files: BuiltInBrowserRemoteCallFile[]): unknown {
    if (!isRecord(result)) return result;
    const next = structuredClone(result) as Record<string, unknown>;
    let wroteAny = false;
    const writtenPaths = new Set<string>();
    for (const file of files) {
      const holder = file.pointer.slice(0, -1).reduce<unknown>(
        (node, key) => (isRecord(node) ? node[key] : undefined),
        next,
      );
      const field = file.pointer[file.pointer.length - 1];
      if (!isRecord(holder) || !field || typeof holder[field] !== "string") continue;
      let written: string | null = null;
      try {
        const bytes = Buffer.from(file.base64, "base64");
        const fileName = path.basename(file.fileName).replace(/[^A-Za-z0-9._-]/g, "_");
        if (args.receivedFilesDir && fileName && bytes.length > 0 && bytes.length <= BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILE_BYTES) {
          const dir = path.join(args.receivedFilesDir, requestId);
          // A screenshot of the user's page: readable by this user only.
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          written = path.join(dir, fileName);
          fs.writeFileSync(written, bytes, { mode: 0o600 });
          wroteAny = true;
        }
      } catch (error) {
        written = null;
        args.logger.warn("built_in_browser.remote_call_file_write_failed", {
          requestId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      // Never leave a path that names a file on another machine.
      holder[field] = written;
      if (written) writtenPaths.add(written);
      if ("relativePath" in holder) holder.relativePath = null;
    }
    clearForeignFilePaths(next, writtenPaths);
    if (wroteAny) pruneReceivedFiles();
    return next;
  }

  function pruneReceivedFiles(): void {
    const root = args.receivedFilesDir;
    if (!root) return;
    let dirs: Array<{ name: string; at: number }>;
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, at: fs.statSync(path.join(root, entry.name)).mtimeMs }))
        .sort((left, right) => right.at - left.at);
    } catch {
      return;
    }
    for (const stale of dirs.slice(RECEIVED_FILE_DIR_CAP)) {
      try {
        fs.rmSync(path.join(root, stale.name), { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // A directory Windows still holds open is removed by a later prune.
      }
    }
  }

  /** Run one command in the browser of the desktop the user sits at. */
  async function callUserDesktop(
    method: BuiltInBrowserRemoteCallMethod,
    record: Record<string, unknown>,
    targetClientId: string,
  ): Promise<RemoteCallOutcome> {
    // The agent's project path and tab collection name things on THIS machine;
    // the desktop answers "which tabs" from its own window.
    const { projectRoot: _projectRoot, tabCollection: _tabCollection, here: _here, ...input } = record;
    const request: BuiltInBrowserRemoteCall = {
      requestId: `bbc-${randomUUID()}`,
      method,
      input,
      chatSessionId: stringOrNull(record.chatSessionId),
      laneId: stringOrNull(record.laneId),
      requestedAt: new Date().toISOString(),
      targetClientId,
    };
    const startedAt = Date.now();
    const outcome = await new Promise<RemoteCallOutcome>((resolve) => {
      const timer = setTimeout(() => settleCall(request.requestId, { taken: false }), callTakenTimeoutMs);
      timer.unref?.();
      pendingCalls.set(request.requestId, {
        method,
        targetClientId,
        doneTimeoutMs: builtInBrowserRemoteCallDoneTimeoutMs(method, record),
        resolve,
        timer,
        desktopLabel: null,
      });
      try {
        args.emitEvent({ type: BUILT_IN_BROWSER_REMOTE_CALL_EVENT, event: request });
      } catch (error) {
        settleCall(request.requestId, { taken: false });
        args.logger.warn("built_in_browser.remote_call_emit_failed", {
          requestId: request.requestId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });
    if (request.chatSessionId) {
      if (outcome.taken) unanswered.delete(request.chatSessionId);
      else {
        unanswered.set(request.chatSessionId, {
          clientId: targetClientId,
          untilMs: Date.now() + USER_DESKTOP_RETRY_AFTER_MS,
        });
        while (unanswered.size > LAST_HOST_CAP) {
          const oldest = unanswered.keys().next().value;
          if (oldest === undefined) break;
          unanswered.delete(oldest);
        }
      }
    }
    args.logger.info("built_in_browser.remote_call", {
      requestId: request.requestId,
      method,
      taken: outcome.taken,
      ok: outcome.taken ? outcome.ok : null,
      ms: Date.now() - startedAt,
    });
    return outcome;
  }

  function withHostNote(result: unknown, note: BuiltInBrowserHostNote): unknown {
    return isRecord(result) ? { ...result, browserHost: note } : result;
  }

  async function forward(
    input: unknown,
    targetClientId: string | null,
  ): Promise<BuiltInBrowserForwardedToDesktop> {
    const record = isRecord(input) ? input : {};
    const url = stringOrNull(record.url) ?? "";
    const tabId = stringOrNull(record.tabId);
    const request: BuiltInBrowserRemoteRequest = {
      requestId: `bbr-${randomUUID()}`,
      url,
      laneId: stringOrNull(record.laneId),
      chatSessionId: stringOrNull(record.chatSessionId),
      openPanel: record.openPanel !== false,
      requestedAt: new Date().toISOString(),
      targetClientId,
      ...(tabId ? { tabId } : {}),
      ...(record.newTab === true ? { newTab: true } : {}),
      ...(record.reuseOwnedTab === true ? { reuseOwnedTab: true } : {}),
    };
    const ack = await new Promise<BuiltInBrowserRemoteRequestAck | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(request.requestId);
        resolve(null);
      }, ackTimeoutMs);
      timer.unref?.();
      pending.set(request.requestId, { resolve, timer });
      try {
        args.emitEvent({ type: BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT, event: request });
      } catch (error) {
        settle(request.requestId, null);
        args.logger.warn("built_in_browser.remote_request_emit_failed", {
          requestId: request.requestId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });
    args.logger.info("built_in_browser.remote_request_forwarded", {
      requestId: request.requestId,
      url: request.url,
      targeted: Boolean(targetClientId),
      acknowledged: Boolean(ack?.accepted),
    });
    return {
      status: "forwarded_to_desktop",
      requestId: request.requestId,
      url: request.url,
      acknowledged: ack?.accepted === true,
      // The desktop acks the moment it takes the request, even when the port
      // still needs a human "Allow" — a first-use approval cannot be answered
      // inside the 5s ack window, and without this the CLI printed a failure
      // for a request that was about to succeed.
      ...(ack?.awaitingApproval === true ? { awaitingApproval: true } : {}),
      desktopLabel: ack?.desktopLabel ?? null,
      reason: ack?.reason ?? null,
    };
  }

  /** To the desktop the user is at; if it does not answer, to any desktop. */
  async function forwardToUser(
    input: unknown,
    targetClientId: string | null,
  ): Promise<BuiltInBrowserForwardedToDesktop> {
    const forwarded = await forward(input, targetClientId);
    if (!targetClientId || forwarded.acknowledged) return forwarded;
    return await forward(input, null);
  }

  /** Where one routed command came from and where it may go. */
  type RouteContext = {
    record: Record<string, unknown>;
    chatSessionId: string | null;
    /** The desktop the user talks from, when that is not this machine's. */
    remoteTargetId: string | null;
    /** `--here`: the agent asked for this machine's browser. */
    here: boolean;
    /** The input for this machine's desktop, without `here`. */
    localBase: unknown;
    /** Send it to the user's desktop first. */
    toUserDesktop: boolean;
  };

  function routeContext(input: unknown): RouteContext & { isolated: boolean; userKnown: boolean } {
    const record = isRecord(input) ? input : {};
    const chatSessionId = stringOrNull(record.chatSessionId);
    const origin = chatSessionId ? args.resolveOrigin?.(chatSessionId) ?? null : null;
    const remoteTargetId = origin && !origin.local ? origin.clientId : null;
    // `--here`: to test a page on this OS, to record, to upload a file that lives here.
    const here = record.here === true;
    const { here: _here, ...withoutHere } = record;
    // An isolated sign-in exists only in this machine's desktop. A copy
    // opened anywhere else would land in the user's own sign-in, which is
    // exactly what an isolated tab is for avoiding.
    const isolated = record.isolated === true || Boolean(stringOrNull(record.profile));
    const quiet = chatSessionId ? unanswered.get(chatSessionId) ?? null : null;
    const desktopSilent = Boolean(
      quiet && remoteTargetId && quiet.clientId === remoteTargetId && quiet.untilMs > Date.now(),
    );
    return {
      record,
      chatSessionId,
      remoteTargetId,
      here,
      localBase: here ? withoutHere : input,
      toUserDesktop: Boolean(remoteTargetId) && !here && !isolated && !desktopSilent,
      isolated,
      userKnown: Boolean(origin),
    };
  }

  /** A tab command that ran here; it says so when the user is at another desktop. */
  function ranHere(ctx: RouteContext, result: unknown): unknown {
    rememberHost(ctx.chatSessionId, "here");
    return ctx.remoteTargetId && !ctx.here
      ? withHostNote(result, { machine: "this machine", userComputer: false, userElsewhere: true })
      : result;
  }

  function ranOnUserDesktop(ctx: RouteContext, desktopLabel: string, result: unknown): unknown {
    rememberHost(ctx.chatSessionId, "user-desktop");
    return withHostNote(result, { machine: desktopLabel, userComputer: true });
  }

  /** A command that acts on one of the chat's tabs. */
  async function routeTabCommand(
    ctx: RouteContext,
    method: BuiltInBrowserRemoteCallMethod,
    call: (input: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    if (ctx.toUserDesktop && ctx.remoteTargetId) {
      const outcome = await callUserDesktop(method, ctx.record, ctx.remoteTargetId);
      if (outcome.taken) {
        if (!outcome.ok) {
          rememberHost(ctx.chatSessionId, "user-desktop");
          throw new Error(outcome.error);
        }
        return ranOnUserDesktop(ctx, outcome.desktopLabel, outcome.result);
      }
    }
    return ranHere(ctx, await call(ctx.localBase));
  }

  /** A command that reads or writes a file on this machine. */
  async function routeLocalFileCommand(
    ctx: RouteContext,
    method: BuiltInBrowserLocalFileMethod,
    call: (input: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    // Unless this chat's last command ran here, its browser is the user's: a
    // restart of this daemon forgets where the tabs are, but they stay on the
    // user's desktop.
    if (ctx.toUserDesktop && lastHost.get(ctx.chatSessionId ?? "") !== "here") {
      throw new Error(
        `${LOCAL_FILE_COMMAND_WORDS[method]} reads or writes a file on this machine, but this chat's browser is on the user's computer. To use the browser on this machine, open the page with --here, then run this command with --here.`,
      );
    }
    return await call(ctx.localBase);
  }

  /** "Put this URL on a screen": `navigate`, `createTab`, `showPanel`. */
  async function routeOpen(
    ctx: RouteContext & { isolated: boolean; userKnown: boolean },
    method: string,
    input: unknown,
    call: (input: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const { record, remoteTargetId, here, isolated } = ctx;
    // "Show the user": `showPanel` always, a navigation with `--panel` (or a
    // person's own call).
    const showToUser = method === "showPanel" || record.openPanel === true;
    // The user's desktop first. An agent's own open loads quietly in a
    // background tab there, and only an open the desktop cannot do quietly
    // (or one from a desktop too old to take commands) uses the request
    // path, which brings the Browser pane up. A request to show something
    // may land on any connected desktop when that one does not answer.
    // The request path only navigates; a new tab is its `newTab` flag.
    const requestInput = method === "createTab" && isRecord(input) ? { ...input, newTab: true } : input;
    let forwarded: BuiltInBrowserForwardedToDesktop | null = null;
    if (ctx.toUserDesktop && remoteTargetId) {
      if (!showToUser && isBuiltInBrowserRemoteCallMethod(method)) {
        const outcome = await callUserDesktop(method, record, remoteTargetId);
        if (outcome.taken && outcome.ok) return ranOnUserDesktop(ctx, outcome.desktopLabel, outcome.result);
        if (outcome.taken && !outcome.needsPane) throw new Error(outcome.error);
      }
      forwarded = showToUser
        ? await forwardToUser(requestInput, remoteTargetId)
        : await forward(requestInput, remoteTargetId);
      if (forwarded.acknowledged) {
        rememberHost(ctx.chatSessionId, "user-desktop");
        return forwarded;
      }
    }
    // Nobody there took it: this machine's desktop does. It reveals its panel
    // only when the user is at this machine, or nobody can tell where they are.
    const localInput = showToUser && remoteTargetId && !here && isRecord(ctx.localBase)
      ? { ...ctx.localBase, openPanel: false }
      : ctx.localBase;
    let result: unknown;
    try {
      result = await call(localInput);
    } catch (error) {
      if (!(error instanceof DesktopBridgeUnavailableError)) throw error;
      if (isolated) {
        throw new Error(
          "An isolated tab (--isolated or --profile) opens only in ADE Desktop on this machine, and none is attached. It was not forwarded, because another desktop would open it in the user's own sign-in. Open ADE Desktop here with this project.",
        );
      }
      if (here) {
        throw new Error(
          "--here asks for the browser on this machine, but ADE Desktop is not open here. Run the command without --here to use the browser on the user's computer, or open ADE Desktop on this machine.",
        );
      }
      return forwarded ?? await forwardToUser(requestInput, remoteTargetId);
    }
    if (showToUser && !forwarded && !isolated && !here && (remoteTargetId || !ctx.userKnown)) {
      // Also put it on the other screen: the one the user is talking from,
      // or every connected one when nobody can tell.
      void forwardToUser(requestInput, remoteTargetId).catch(() => {});
    }
    return ranHere(ctx, result);
  }

  return {
    route: async (input, call, method) => {
      const ctx = routeContext(input);
      if (!isBuiltInBrowserDesktopBridgeMethod(method)) return await call(ctx.localBase);
      const route = BUILT_IN_BROWSER_METHOD_ROUTES[method];
      switch (route) {
        case "open":
          return await routeOpen(ctx, method, input, call);
        case "user-desktop":
          return await routeTabCommand(ctx, method as BuiltInBrowserRemoteCallMethod, call);
        case "local-file":
          return await routeLocalFileCommand(ctx, method as BuiltInBrowserLocalFileMethod, call);
        case "agent-machine":
          return await call(ctx.localBase);
      }
    },
    acknowledgeRemoteRequest: (input) => {
      const record = isRecord(input) ? input : {};
      const requestId = stringOrNull(record.requestId);
      if (!requestId) return { ok: false };
      return {
        ok: settle(requestId, {
          requestId,
          desktopLabel: desktopLabelFrom(record.desktopLabel) ?? "ADE Desktop",
          accepted: record.accepted !== false,
          ...(record.awaitingApproval === true ? { awaitingApproval: true } : {}),
          reason: stringOrNull(record.reason),
        }),
      };
    },
    replyRemoteCall: (input) => {
      const record = isRecord(input) ? input : {};
      const requestId = stringOrNull(record.requestId);
      const entry = requestId ? pendingCalls.get(requestId) : null;
      // Only the desktop the command was sent to may answer it.
      if (!requestId || !entry || stringOrNull(record.clientId) !== entry.targetClientId) return { ok: false };
      const desktopLabel = desktopLabelFrom(record.desktopLabel) ?? entry.desktopLabel ?? UNNAMED_USER_DESKTOP;
      if (record.phase === "taken") {
        // Taken: stop the "nobody answered" clock and start the command's own.
        entry.desktopLabel = desktopLabel;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          settleCall(requestId, {
            taken: true,
            desktopLabel,
            ok: false,
            error: `The browser on ${desktopLabel} took \`${entry.method}\` but did not answer within ${Math.round(entry.doneTimeoutMs / 1000)}s.`,
          });
        }, entry.doneTimeoutMs);
        entry.timer.unref?.();
        return { ok: true };
      }
      if (record.phase !== "done") return { ok: false };
      if (record.ok !== true) {
        return {
          ok: settleCall(requestId, {
            taken: true,
            desktopLabel,
            ok: false,
            error: stringOrNull(record.error) ?? `The browser on ${desktopLabel} could not run \`${entry.method}\`.`,
            ...(record.code === "needs_pane" ? { needsPane: true } : {}),
          }),
        };
      }
      return {
        ok: settleCall(requestId, {
          taken: true,
          desktopLabel,
          ok: true,
          result: receiveFiles(requestId, record.result, filesFromReply(record.files)),
        }),
      };
    },
    dispose: () => {
      for (const requestId of [...pending.keys()]) settle(requestId, null);
      for (const requestId of [...pendingCalls.keys()]) settleCall(requestId, { taken: false });
    },
  };
}

/** Every bridge method is routed: the forwarder decides which browser runs it. */
const ROUTED_BUILT_IN_BROWSER_METHODS = new Set<string>(BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS);

/**
 * Wrap a desktop bridge client so each command runs in the browser the
 * forwarder picks for it, and the two runtime-served methods a desktop answers
 * with (`acknowledgeRemoteRequest`, `replyRemoteCall`) are served here.
 */
export function withRemoteBrowserForwarding(
  bridge: BuiltInBrowserDesktopBridgeClient,
  forwarder: RemoteBrowserForwarder,
): BuiltInBrowserDesktopBridgeClient {
  return new Proxy(bridge, {
    get(target, property, receiver) {
      if (property === BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD) {
        return (input?: unknown) => forwarder.acknowledgeRemoteRequest(input);
      }
      if (property === BUILT_IN_BROWSER_REPLY_REMOTE_CALL_METHOD) {
        return (input?: unknown) => forwarder.replyRemoteCall(input);
      }
      if (typeof property === "string" && ROUTED_BUILT_IN_BROWSER_METHODS.has(property)) {
        const inner = Reflect.get(target, property, receiver) as
          | ((input?: unknown) => Promise<unknown>)
          | undefined;
        if (typeof inner !== "function") return inner;
        return (input?: unknown) =>
          forwarder.route(input, (next) => inner(next), property);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as BuiltInBrowserDesktopBridgeClient;
}
