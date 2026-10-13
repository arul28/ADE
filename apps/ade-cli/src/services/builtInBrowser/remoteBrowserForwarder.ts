import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import {
  BUILT_IN_BROWSER_LOCAL_FILE_METHODS,
  BUILT_IN_BROWSER_REMOTE_CALL_EVENT,
  BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILE_BYTES,
  BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT,
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
  BUILT_IN_BROWSER_REPLY_REMOTE_CALL_METHOD,
  type BuiltInBrowserDesktopBridgeClient,
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
 * tabs. Before this, only "show the user" opens crossed over; everything else
 * ran in a browser on the agent's machine that the user could not see.
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
const CALL_DONE_TIMEOUT_MS = 60_000;
/** A `wait` or a sign-in handoff runs as long as the agent asked, plus the trip. */
const CALL_DONE_MARGIN_MS = 15_000;
const CALL_DONE_MAX_TIMEOUT_MS = 30 * 60_000;
/** Chats whose last command is remembered, and files kept for the agent to read. */
const LAST_HOST_CAP = 200;
/**
 * After a desktop did not take a command, how long its chat's commands run
 * here without asking it again. Without this, every command of an agent whose
 * user closed the laptop would wait out the "nobody answered" clock.
 */
const USER_DESKTOP_RETRY_AFTER_MS = 60_000;
const RECEIVED_FILE_DIR_CAP = 40;

/** The CLI words for the commands that stay on this machine, for a message an agent can act on. */
const LOCAL_FILE_COMMAND_WORDS: Record<string, string> = {
  uploadFile: "`ade browser upload`",
  exportHar: "`ade browser har`",
  startRecording: "`ade browser record start`",
  stopRecording: "`ade browser record stop`",
};

/** Opens: "put this URL on a screen". They travel on the request path. */
const OPEN_METHODS: ReadonlySet<string> = new Set(["navigate", "createTab", "showPanel"]);

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
  doneTimeoutMs: number;
  resolve: (outcome: RemoteCallOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  desktopLabel: string | null;
};

export type RemoteBrowserForwarder = {
  /**
   * Run a "put this URL on a screen" call. The desktop on this machine takes it
   * when there is one; a request to show the user also reaches the desktop
   * the user is talking from; with no desktop here, it goes to one elsewhere.
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

  function settleCall(requestId: string, outcome: RemoteCallOutcome): boolean {
    const entry = pendingCalls.get(requestId);
    if (!entry) return false;
    pendingCalls.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
    return true;
  }

  /** Write the files a reply carries where the agent can read them, and point the result at them. */
  function receiveFiles(requestId: string, result: unknown, files: BuiltInBrowserRemoteCallFile[]): unknown {
    if (!isRecord(result)) return result;
    const next = structuredClone(result) as Record<string, unknown>;
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
          fs.mkdirSync(dir, { recursive: true });
          written = path.join(dir, fileName);
          fs.writeFileSync(written, bytes);
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
      if ("relativePath" in holder) holder.relativePath = null;
    }
    pruneReceivedFiles();
    return next;
  }

  function pruneReceivedFiles(): void {
    const root = args.receivedFilesDir;
    if (!root) return;
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, at: fs.statSync(path.join(root, entry.name)).mtimeMs }))
        .sort((left, right) => right.at - left.at);
      for (const stale of dirs.slice(RECEIVED_FILE_DIR_CAP)) {
        fs.rmSync(path.join(root, stale.name), { recursive: true, force: true });
      }
    } catch {
      // best effort: an unpruned directory is a few screenshots
    }
  }

  function callDoneTimeoutMs(input: Record<string, unknown>, method: string): number {
    const asked = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : null;
    if (asked == null) return method === "waitForHandoff" ? CALL_DONE_MAX_TIMEOUT_MS : CALL_DONE_TIMEOUT_MS;
    return Math.min(CALL_DONE_MAX_TIMEOUT_MS, Math.max(CALL_DONE_TIMEOUT_MS, asked + CALL_DONE_MARGIN_MS));
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
        doneTimeoutMs: callDoneTimeoutMs(record, method),
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

  function settle(requestId: string, ack: BuiltInBrowserRemoteRequestAck | null): boolean {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(ack);
    return true;
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

  return {
    route: async (input, call, method) => {
      const record = isRecord(input) ? input : {};
      const chatSessionId = stringOrNull(record.chatSessionId);
      const origin = chatSessionId ? args.resolveOrigin?.(chatSessionId) ?? null : null;
      // The desktop the user talks from, when that is not this machine's.
      const remoteTargetId = origin && !origin.local ? origin.clientId : null;
      // `--here`: the agent asked for this machine's browser (to test a page on
      // this OS, to record, to upload a file that lives here).
      const here = record.here === true;
      const { here: _here, ...withoutHere } = record;
      const localBase: unknown = here ? withoutHere : input;
      // An isolated sign-in exists only in this machine's desktop. A copy
      // opened anywhere else would land in the user's own sign-in, which is
      // exactly what an isolated tab is for avoiding.
      const isolated = record.isolated === true || Boolean(stringOrNull(record.profile));
      const quiet = chatSessionId ? unanswered.get(chatSessionId) ?? null : null;
      const desktopSilent = Boolean(
        quiet && remoteTargetId && quiet.clientId === remoteTargetId && quiet.untilMs > Date.now(),
      );
      const toUserDesktop = Boolean(remoteTargetId) && !here && !isolated && !desktopSilent;
      const isOpen = OPEN_METHODS.has(method);
      const isCall = isBuiltInBrowserRemoteCallMethod(method);
      /** A command that ran here although the user is at another desktop. */
      const hereNote = (result: unknown): unknown => {
        // Only a command that acts on a tab says where the chat's browser is;
        // a dev-server list or a step caption does not move it.
        if (!isOpen && !isCall) return result;
        rememberHost(chatSessionId, "here");
        return remoteTargetId && !here
          ? withHostNote(result, { machine: "this machine", userComputer: false, userElsewhere: true })
          : result;
      };

      if (!isOpen) {
        if (toUserDesktop && isCall && remoteTargetId) {
          const outcome = await callUserDesktop(method, record, remoteTargetId);
          if (outcome.taken) {
            rememberHost(chatSessionId, "user-desktop");
            if (!outcome.ok) throw new Error(outcome.error);
            return withHostNote(outcome.result, { machine: outcome.desktopLabel, userComputer: true });
          }
        }
        if (
          toUserDesktop
          && BUILT_IN_BROWSER_LOCAL_FILE_METHODS.has(method)
          && chatSessionId
          && lastHost.get(chatSessionId) === "user-desktop"
        ) {
          throw new Error(
            `${LOCAL_FILE_COMMAND_WORDS[method] ?? method} reads or writes a file on this machine, but this chat's browser is on the user's computer. To use the browser on this machine, open the page with --here, then run this command with --here.`,
          );
        }
        return hereNote(await call(localBase));
      }

      // "Show the user": `showPanel` always, a navigation with `--panel` (or a
      // person's own call).
      const showToUser = method === "showPanel" || record.openPanel === true;
      // The user's desktop first. An agent's own open loads quietly in a
      // background tab there, and only an open the desktop cannot do quietly
      // (or one from a desktop too old to take commands) uses the request
      // path, which brings the Browser pane up. A request to show something
      // may land on any connected desktop when that one does not answer.
      let forwarded: BuiltInBrowserForwardedToDesktop | null = null;
      if (toUserDesktop && remoteTargetId) {
        if (!showToUser && isCall) {
          const outcome = await callUserDesktop(method, record, remoteTargetId);
          if (outcome.taken && outcome.ok) {
            rememberHost(chatSessionId, "user-desktop");
            return withHostNote(outcome.result, { machine: outcome.desktopLabel, userComputer: true });
          }
          if (outcome.taken && !outcome.needsPane) throw new Error(outcome.error);
        }
        forwarded = showToUser
          ? await forwardToUser(input, remoteTargetId)
          : await forward(input, remoteTargetId);
        if (forwarded.acknowledged) {
          rememberHost(chatSessionId, "user-desktop");
          return forwarded;
        }
      }
      // Nobody there took it: this machine's desktop does. It reveals its panel
      // only when the user is at this machine, or nobody can tell where they are.
      const localInput = showToUser && remoteTargetId && !here ? { ...withoutHere, openPanel: false } : localBase;
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
        return forwarded ?? await forwardToUser(input, remoteTargetId);
      }
      if (showToUser && !forwarded && !isolated && !here && (remoteTargetId || !origin)) {
        // Also put it on the other screen: the one the user is talking from,
        // or every connected one when nobody can tell.
        void forwardToUser(input, remoteTargetId).catch(() => {});
      }
      return hereNote(result);
    },
    acknowledgeRemoteRequest: (input) => {
      const record = isRecord(input) ? input : {};
      const requestId = stringOrNull(record.requestId);
      if (!requestId) return { ok: false };
      return {
        ok: settle(requestId, {
          requestId,
          desktopLabel: stringOrNull(record.desktopLabel) ?? "ADE Desktop",
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
      if (!requestId || !entry) return { ok: false };
      const desktopLabel = stringOrNull(record.desktopLabel) ?? entry.desktopLabel ?? "ADE Desktop";
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
      const files = Array.isArray(record.files)
        ? record.files.filter((file): file is BuiltInBrowserRemoteCallFile => (
          isRecord(file)
          && Array.isArray(file.pointer)
          && file.pointer.length > 0
          && file.pointer.length <= 6
          && file.pointer.every((key) => typeof key === "string")
          && typeof file.fileName === "string"
          && typeof file.base64 === "string"
        ))
        : [];
      return {
        ok: settleCall(requestId, {
          taken: true,
          desktopLabel,
          ok: true,
          result: receiveFiles(requestId, record.result, files),
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
