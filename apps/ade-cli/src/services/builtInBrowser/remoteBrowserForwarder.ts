import { randomUUID } from "node:crypto";
import os from "node:os";

import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { THIS_MACHINE_NAME } from "../../../../desktop/src/shared/machineIdentity";
import {
  BUILT_IN_BROWSER_REMOTE_CALL_EVENT,
  BUILT_IN_BROWSER_REMOTE_REQUEST_EVENT,
  builtInBrowserErrorOnMachine,
  builtInBrowserRemoteCallDoneTimeoutMs,
  isBuiltInBrowserRemoteCallMethod,
  type BuiltInBrowserForwardedToDesktop,
  type BuiltInBrowserHostNote,
  type BuiltInBrowserRemoteCall,
  type BuiltInBrowserRemoteCallMethod,
  type BuiltInBrowserRemoteRequest,
  type BuiltInBrowserRemoteRequestAck,
} from "../../../../desktop/src/shared/types/builtInBrowserRemote";
import type {
  BuiltInBrowserOtherMachineTabs,
  BuiltInBrowserRouteSummary,
  BuiltInBrowserTabMachine,
} from "../../../../desktop/src/shared/types/builtInBrowser";
import { DesktopBridgeUnavailableError } from "./desktopBridgeClient";
import { createRemoteBrowserBroadcaster } from "./remoteBrowserBroadcast";
import { nameTabOwners, type DescribeOwners } from "./remoteBrowserOwnerNames";
import { receiveRemoteCallFiles } from "./remoteBrowserReceivedFiles";
import { HERE, createTabHostMemory, rememberNewest, type BrowserHost } from "./remoteBrowserTabHosts";
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
 * when the agent asks for it (`--here`). A command that ran here although the
 * user is elsewhere says so in its result.
 *
 * One task stays on one machine. Every tab id a command answers with is
 * remembered with the machine whose browser holds it, and a later command
 * that names the tab (`--tab`, a browser session) goes to that machine, not to
 * wherever the chat's route points now. An id this daemon does not know (it
 * restarted) is looked up on every machine it can reach before the command
 * fails, and the failure names the machines it asked.
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
/** A lane release is not awaited; replies are taken for this long. */
const RELEASE_BROADCAST_WAIT_MS = 10_000;

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
  | {
    taken: true;
    desktopLabel: string;
    ok: false;
    error: string;
    needsPane?: boolean;
    /** With `needsPane`: the desktop's request path keeps an isolated sign-in. */
    requestCarriesSignIn?: boolean;
  };

/** This computer's host name, until the runtime gives the forwarder its display name. */
function hostMachineName(): string {
  return os.hostname().replace(/\.local$/i, "") || "this machine";
}

type PendingCall = {
  method: BuiltInBrowserRemoteCallMethod;
  /** The only desktop whose reply settles this call. */
  targetClientId: string;
  doneTimeoutMs: number;
  resolve: (outcome: RemoteCallOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  desktopLabel: string | null;
};

export type { OwnerNames } from "./remoteBrowserOwnerNames";

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
  /** The bridge to this machine's desktop, for the reads and releases the forwarder makes itself. */
  attachLocalBridge: (bridge: LocalBrowserBridge) => void;
  /**
   * A lane was deleted or archived: free its tabs in this machine's browser
   * and in every desktop's that holds a pin here. Closes nothing.
   */
  releaseLaneTabs: (laneId: string) => Promise<void>;
  /**
   * A chat started a turn, went idle, or ended: tell this machine's browser and
   * every desktop that holds a pin here, so the chat's agent tabs keep running,
   * start their countdown, or close. Fire and forget.
   */
  chatBrowserLifecycle: (chatSessionId: string, state: "running" | "idle" | "ended") => void;
  dispose: () => void;
};

/** The two bridge-served methods the forwarder calls on this machine's desktop. */
export type LocalBrowserBridge = {
  listTabsForAgent: (input: Record<string, unknown>) => Promise<unknown>;
  releaseLaneTabs: (input: { laneId: string }) => Promise<unknown>;
  chatBrowserLifecycle?: (input: { chatSessionId: string; state: "running" | "idle" | "ended" }) => Promise<unknown>;
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
  /** How long a broadcast waits for desktops; tests shorten it. */
  broadcastWaitMs?: { first: number; known: number } | null;
  /** This machine's name for an agent to read (the device's display name). */
  machineName?: (() => string | null) | null;
  /** Chat titles and lane names for the owners `ade browser status` lists. */
  describeOwners?: DescribeOwners | null;
}): RemoteBrowserForwarder {
  const thisMachineName = (): string => stringOrNull(args.machineName?.()) ?? hostMachineName();
  const pending = new Map<string, PendingRequest>();
  const pendingCalls = new Map<string, PendingCall>();
  /** Which browser a chat's last command ran in, newest last. */
  const lastHost = new Map<string, "user-desktop" | "here">();
  /** Chat → the desktop that did not answer, and until when it is left alone. */
  const unanswered = new Map<string, { clientId: string; untilMs: number }>();
  /** A desktop's name for itself, from its replies. */
  const desktopLabels = new Map<string, string>();
  let localBridge: LocalBrowserBridge | null = null;
  const ackTimeoutMs = args.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  const callTakenTimeoutMs = args.callTakenTimeoutMs ?? CALL_TAKEN_TIMEOUT_MS;
  const broadcaster = createRemoteBrowserBroadcaster({
    emitEvent: args.emitEvent,
    logger: args.logger,
    waitMs: args.broadcastWaitMs ?? null,
  });
  const tabHosts = createTabHostMemory();

  function rememberHost(chatSessionId: string | null, host: "user-desktop" | "here"): void {
    if (!chatSessionId) return;
    rememberNewest(lastHost, chatSessionId, host, LAST_HOST_CAP);
  }

  function hostLabel(host: BrowserHost): string {
    return host.kind === "here" ? thisMachineName() : host.label;
  }

  /** Name the machine whose browser refused, in place: the error keeps its class and code. */
  function onMachine(error: unknown, host: BrowserHost, ctx: { remoteTargetId: string | null }): Error {
    const userComputer = host.kind === "desktop" && host.clientId === ctx.remoteTargetId;
    const named = builtInBrowserErrorOnMachine(
      error instanceof Error ? error.message : String(error),
      host.kind === "here" ? `${thisMachineName()} (this machine)` : host.label,
      userComputer,
    );
    if (error instanceof Error) {
      try {
        error.message = named;
        return error;
      } catch {
        // A frozen error: fall through to a new one.
      }
    }
    return new Error(named);
  }

  function isNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /Browser (tab|session) not found/.test(message);
  }

  const settleCall = (requestId: string, outcome: RemoteCallOutcome): boolean =>
    settleEntry(pendingCalls, requestId, outcome);
  const settle = (requestId: string, ack: BuiltInBrowserRemoteRequestAck | null): boolean =>
    settleEntry(pending, requestId, ack);

  /** Which of a desktop's collections the agent means: its project's, or the personal one. */
  function collectionOf(record: Record<string, unknown>): "project" | "personal" {
    return record.tabCollection === "personal" ? "personal" : "project";
  }

  /** Run one command in the browser of a desktop on another machine. */
  async function callDesktop(
    method: BuiltInBrowserRemoteCallMethod,
    record: Record<string, unknown>,
    targetClientId: string,
  ): Promise<RemoteCallOutcome> {
    // The agent's project path and tab collection name things on THIS machine;
    // the desktop answers "which tabs" from its own window.
    const { projectRoot: _projectRoot, tabCollection: _tabCollection, here: _here, allMachines: _all, ...input } = record;
    const request: BuiltInBrowserRemoteCall = {
      requestId: `bbc-${randomUUID()}`,
      method,
      input,
      chatSessionId: stringOrNull(record.chatSessionId),
      laneId: stringOrNull(record.laneId),
      requestedAt: new Date().toISOString(),
      targetClientId,
      collection: collectionOf(record),
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
    if (outcome.taken) {
      rememberNewest(desktopLabels, targetClientId, outcome.desktopLabel, LAST_HOST_CAP);
      broadcaster.noteDesktopSeen();
    }
    const origin = request.chatSessionId ? args.resolveOrigin?.(request.chatSessionId) ?? null : null;
    // Only the user's own desktop going quiet changes where the chat's next
    // command goes; a desktop that merely holds one tab does not.
    if (request.chatSessionId && origin && !origin.local && origin.clientId === targetClientId) {
      if (outcome.taken) unanswered.delete(request.chatSessionId);
      else {
        rememberNewest(unanswered, request.chatSessionId, {
          clientId: targetClientId,
          untilMs: Date.now() + USER_DESKTOP_RETRY_AFTER_MS,
        }, LAST_HOST_CAP);
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
    withSignIn = false,
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
      // Only for a desktop that said its request path keeps the sign-in.
      ...(withSignIn && stringOrNull(record.profile) ? { profile: stringOrNull(record.profile)! } : {}),
      ...(withSignIn && record.isolated === true ? { isolated: true } : {}),
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
    /** The user's desktop did not answer lately; its commands run here for a while. */
    desktopSilentUntilMs: number | null;
    /**
     * The browser that holds the tab or session the command names, or else
     * the tab this chat last acted on, when known.
     */
    targetHost: BrowserHost | null;
    /** Only the tab or session the command names (`--tab`, `--browser-session`). */
    namedHost: BrowserHost | null;
    /** The chat's last message came from this machine's desktop. */
    userHere: boolean;
  };

  function routeContext(input: unknown): RouteContext & { isolated: boolean; userKnown: boolean } {
    const record = isRecord(input) ? input : {};
    const chatSessionId = stringOrNull(record.chatSessionId);
    const origin = chatSessionId ? args.resolveOrigin?.(chatSessionId) ?? null : null;
    const remoteTargetId = origin && !origin.local ? origin.clientId : null;
    // `--here`: to test a page on this OS, to record, to upload a file that lives here.
    const here = record.here === true;
    const { here: _here, allMachines: _all, ...withoutRouting } = record;
    // An isolated sign-in opens where the user sits, like every other tab: the
    // isolation is a partition on that desktop too, so their own sign-ins stay
    // untouched, and they see the tab (ledger R2).
    const isolated = record.isolated === true || Boolean(stringOrNull(record.profile));
    const quiet = chatSessionId ? unanswered.get(chatSessionId) ?? null : null;
    const desktopSilent = Boolean(
      quiet && remoteTargetId && quiet.clientId === remoteTargetId && quiet.untilMs > Date.now(),
    );
    const tabId = stringOrNull(record.tabId);
    const sessionId = stringOrNull(record.sessionId);
    const namedHost = tabHosts.hostOf({ tabId, sessionId });
    // No tab named: the command acts on this chat's tab, so it goes where that
    // tab is. Sent anywhere else, a desktop with no tab of this chat's would
    // act on whatever tab the person has in front.
    const lastTab = !tabId && !sessionId ? tabHosts.lastTabOf(chatSessionId) : null;
    const targetHost = namedHost ?? (lastTab ? tabHosts.hostOf({ tabId: lastTab, sessionId: null }) : null);
    return {
      record,
      chatSessionId,
      remoteTargetId,
      here,
      localBase: withoutRouting,
      toUserDesktop: Boolean(remoteTargetId) && !here && !desktopSilent,
      desktopSilentUntilMs: desktopSilent ? quiet!.untilMs : null,
      targetHost: here ? HERE : targetHost,
      namedHost: here ? HERE : namedHost,
      userHere: Boolean(origin?.local),
      isolated,
      userKnown: Boolean(origin),
    };
  }

  /** The note on a result that says which machine's browser ran it. */
  function hostNote(ctx: RouteContext, host: BrowserHost): BuiltInBrowserHostNote | null {
    if (host.kind === "desktop") {
      return { machine: host.label, userComputer: host.clientId === ctx.remoteTargetId };
    }
    return ctx.remoteTargetId && !ctx.here
      ? { machine: "this machine", userComputer: false, userElsewhere: true }
      : null;
  }

  function finish(ctx: RouteContext, host: BrowserHost, result: unknown): unknown {
    tabHosts.noteResult(result, host);
    tabHosts.noteChatTab(ctx.chatSessionId, ctx.record.tabId, result);
    rememberHost(ctx.chatSessionId, host.kind === "here" ? "here" : "user-desktop");
    const note = hostNote(ctx, host);
    return note ? withHostNote(result, note) : result;
  }

  /** Run on this machine's desktop. */
  async function runHere(
    ctx: RouteContext,
    call: (input: unknown) => Promise<unknown>,
    input: unknown = ctx.localBase,
  ): Promise<unknown> {
    try {
      return finish(ctx, HERE, await call(input));
    } catch (error) {
      throw onMachine(error, HERE, ctx);
    }
  }

  /** Run on a desktop elsewhere; null when it did not take the command. */
  async function runOnDesktop(
    ctx: RouteContext,
    method: BuiltInBrowserRemoteCallMethod,
    clientId: string,
  ): Promise<{ result: unknown } | null> {
    const outcome = await callDesktop(method, ctx.record, clientId);
    if (!outcome.taken) return null;
    const host: BrowserHost = { kind: "desktop", clientId, label: outcome.desktopLabel };
    if (!outcome.ok) {
      if (clientId === ctx.remoteTargetId) rememberHost(ctx.chatSessionId, "user-desktop");
      throw onMachine(new Error(outcome.error), host, ctx);
    }
    return { result: finish(ctx, host, outcome.result) };
  }

  /**
   * Find the browser that holds a tab this daemon does not know (it restarted,
   * or another chat opened the tab): this machine's, then every desktop's.
   */
  async function locateTab(ctx: RouteContext, tabId: string): Promise<BrowserHost | null> {
    await listEverywhere(ctx, null, { alwaysAsk: true });
    return tabHosts.hostOf({ tabId, sessionId: null });
  }

  /** A command that acts on one tab: the tab's browser, else the chat's. */
  async function routeTabCommand(
    ctx: RouteContext,
    method: BuiltInBrowserRemoteCallMethod,
    call: (input: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const known = ctx.targetHost;
    if (known) return await runOnHost(ctx, known, method, call);
    const tabId = stringOrNull(ctx.record.tabId);
    try {
      if (ctx.toUserDesktop && ctx.remoteTargetId) {
        const ran = await runOnDesktop(ctx, method, ctx.remoteTargetId);
        if (ran) return ran.result;
      }
      return await runHere(ctx, call);
    } catch (error) {
      if (!tabId || !isNotFoundError(error)) throw error;
      // Not in the chat's browser: it may be in another machine's.
      const found = await locateTab(ctx, tabId);
      if (found) return await runOnHost(ctx, found, method, call);
      const asked = [
        ctx.toUserDesktop && ctx.remoteTargetId
          ? `${desktopLabels.get(ctx.remoteTargetId) ?? UNNAMED_USER_DESKTOP} (the user's computer)`
          : null,
        `${thisMachineName()} (this machine)`,
        ...broadcaster.answeringDesktops().filter((id) => id !== ctx.remoteTargetId).map((id) => desktopLabels.get(id) ?? "another desktop"),
      ].filter(Boolean);
      throw new Error(
        `Browser tab not found: ${tabId}. No ADE browser that this machine can reach holds it (asked: ${asked.join(", ")}). It was closed, or it was an agent's tab that ADE did not bring back after a restart. Run \`ade browser status\` for the tabs that exist.`,
      );
    }
  }

  /** Run where the tab is. A desktop that holds the tab and does not answer is an error, never a run here. */
  async function runOnHost(
    ctx: RouteContext,
    host: BrowserHost,
    method: BuiltInBrowserRemoteCallMethod,
    call: (input: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    if (host.kind === "here") return await runHere(ctx, call);
    // The user's computer stopped answering a moment ago: say so at once
    // rather than wait out the clock again.
    if (host.clientId === ctx.remoteTargetId && ctx.desktopSilentUntilMs) throw notAnsweredError(ctx, host);
    const ran = await runOnDesktop(ctx, method, host.clientId);
    if (ran) return ran.result;
    throw notAnsweredError(ctx, host);
  }

  function notAnsweredError(ctx: RouteContext, host: BrowserHost): Error {
    const target = stringOrNull(ctx.record.tabId)
      ?? stringOrNull(ctx.record.sessionId)
      ?? tabHosts.lastTabOf(ctx.chatSessionId)
      ?? "This tab";
    const label = hostLabel(host);
    return new Error(
      `${target} is in the ADE browser on ${label}, which did not answer within ${Math.round(callTakenTimeoutMs / 1000)}s (ADE closed, or the computer is asleep). The command did not run anywhere. Try again when ${label} is back, or work in a tab on another machine.`,
    );
  }

  /** A command that reads or writes a file on this machine. */
  async function routeLocalFileCommand(
    ctx: RouteContext,
    method: BuiltInBrowserLocalFileMethod,
    call: (input: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    // The tab it names is here, or this chat's last command ran here: run it.
    // Otherwise the chat's browser is the user's. A restart of this daemon
    // forgets where the tabs are, but they stay on the user's desktop.
    const tabHere = ctx.targetHost?.kind === "here";
    if (ctx.targetHost?.kind === "desktop" || (ctx.toUserDesktop && !tabHere && lastHost.get(ctx.chatSessionId ?? "") !== "here")) {
      throw new Error(
        `${LOCAL_FILE_COMMAND_WORDS[method]} reads or writes a file on this machine, but this chat's browser is on ${ctx.targetHost?.kind === "desktop" ? ctx.targetHost.label : "the user's computer"}. To use the browser on this machine, open the page with --here, then run this command with --here.`,
      );
    }
    return await runHere(ctx, call);
  }

  /** "Put this URL on a screen": `navigate`, `createTab`, `showPanel`. */
  async function routeOpen(
    ctx: RouteContext & { isolated: boolean; userKnown: boolean },
    method: string,
    input: unknown,
    call: (input: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const { record, here, isolated } = ctx;
    // `open --tab <id>` drives that tab, wherever it is. A plain `open`
    // follows the user instead: it opens where they sit now.
    const named = ctx.namedHost;
    if (named && !here && isBuiltInBrowserRemoteCallMethod(method)) {
      if (named.kind === "here") return await runHere(ctx, call);
      const clientId = named.clientId;
      const outcome = await callDesktop(method, record, clientId);
      if (!outcome.taken) throw notAnsweredError(ctx, named);
      const host: BrowserHost = { kind: "desktop", clientId, label: outcome.desktopLabel };
      if (outcome.ok) return finish(ctx, host, outcome.result);
      if (!outcome.needsPane) throw onMachine(new Error(outcome.error), host, ctx);
      // A loopback URL in a tab on that desktop: its Browser pane opens it.
      // The tab keeps the sign-in it opened with, so naming it is enough.
      const forwarded = await forward(input, clientId, outcome.requestCarriesSignIn === true);
      if (forwarded.acknowledged) {
        rememberHost(ctx.chatSessionId, "user-desktop");
        return forwarded;
      }
      throw onMachine(new Error(forwarded.reason ?? "Its Browser pane did not take the page."), host, ctx);
    }
    const remoteTargetId = named?.kind === "here" ? null : ctx.remoteTargetId;
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
    let isolatedStaysHere = false;
    if (ctx.toUserDesktop && remoteTargetId) {
      // An isolated open always tries the command path first, even to show
      // the pane: only a desktop that said so may take it down the request
      // path, where an older desktop would use the user's own sign-in.
      if ((!showToUser || isolated) && isBuiltInBrowserRemoteCallMethod(method)) {
        const outcome = await callDesktop(method, record, remoteTargetId);
        const host: BrowserHost = { kind: "desktop", clientId: remoteTargetId, label: outcome.taken ? outcome.desktopLabel : UNNAMED_USER_DESKTOP };
        if (outcome.taken && outcome.ok) return finish(ctx, host, outcome.result);
        if (outcome.taken && !outcome.needsPane) throw onMachine(new Error(outcome.error), host, ctx);
        if (isolated && (!outcome.taken || !outcome.requestCarriesSignIn)) isolatedStaysHere = true;
      } else if (isolated) {
        // No command path to confirm the request path keeps the sign-in.
        isolatedStaysHere = true;
      }
      if (!isolatedStaysHere) {
        // An isolated open goes to the user's desktop only: another desktop
        // has not said its request path keeps the sign-in.
        forwarded = showToUser && !isolated
          ? await forwardToUser(requestInput, remoteTargetId)
          : await forward(requestInput, remoteTargetId, isolated);
        if (forwarded.acknowledged) {
          rememberHost(ctx.chatSessionId, "user-desktop");
          return forwarded;
        }
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
      if (!(error instanceof DesktopBridgeUnavailableError)) throw onMachine(error, HERE, ctx);
      if (isolated) {
        throw new Error(
          "An isolated tab (--isolated or --profile) opens in the ADE browser of the computer the user sits at, or on this machine. Neither took it: the user's computer did not answer (or its ADE is too old to keep an isolated sign-in for a localhost page), and ADE Desktop is not open here. It was not sent anywhere else, because another desktop would open it in the user's own sign-in.",
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
      void forwardToUser(requestInput, remoteTargetId).catch((err) => {
        args.logger.warn("built_in_browser.forward_to_user_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return finish(ctx, HERE, result);
  }

  /** This machine and the user's computer by name, for a route line. */
  function machineOf(host: BrowserHost, ctx: RouteContext): BuiltInBrowserTabMachine {
    return host.kind === "here"
      ? { name: thisMachineName(), here: true, userComputer: ctx.userHere }
      : { name: host.label, here: false, userComputer: host.clientId === ctx.remoteTargetId };
  }

  function clock(ms: number): string {
    return new Date(ms).toTimeString().slice(0, 5);
  }

  /** Where this chat's commands go, and why, for `ade browser status`. */
  function routeSummary(ctx: RouteContext & { userKnown: boolean }): BuiltInBrowserRouteSummary {
    const userLabel = ctx.remoteTargetId ? desktopLabels.get(ctx.remoteTargetId) ?? UNNAMED_USER_DESKTOP : null;
    const browser: BrowserHost = ctx.toUserDesktop && ctx.remoteTargetId
      ? { kind: "desktop", clientId: ctx.remoteTargetId, label: userLabel! }
      : HERE;
    const reason = ctx.remoteTargetId
      ? ctx.desktopSilentUntilMs
        ? `the user sends this chat's messages from ${userLabel}, but it did not answer a command, so commands without a tab id run here until ${clock(ctx.desktopSilentUntilMs)}`
        : `the user sends this chat's messages from ${userLabel}, so its browser is the one they can see`
      : ctx.userKnown
        ? "the user sends this chat's messages from this machine"
        : ctx.chatSessionId
          ? "no message from a desktop yet; this machine's browser, and any desktop holding this project shows `--panel` opens"
          : "not run from a chat, so this machine's browser";
    return {
      browser: machineOf(browser, ctx),
      reason,
      isolatedTabs: ctx.remoteTargetId
        ? `${userLabel}, beside the user's tabs (an older ADE there opens an isolated localhost page on this machine instead, and says so)`
        : "this machine's browser",
      tabCommands: "a command with --tab or --browser-session goes to the machine whose browser holds that tab (the machine column); --here forces this machine",
      fallback: ctx.desktopSilentUntilMs
        ? `${userLabel} did not answer within ${Math.round(callTakenTimeoutMs / 1000)}s; asking it again after ${clock(ctx.desktopSilentUntilMs)}`
        : null,
    };
  }

  function annotateTabs(tabs: unknown, machine: BuiltInBrowserTabMachine): unknown[] {
    return Array.isArray(tabs) ? tabs.map((tab) => (isRecord(tab) ? { ...tab, machine } : tab)) : [];
  }

  /**
   * Every machine's tabs for this project except `skip`'s: this machine's
   * (read without restoring anything) and every desktop's that answers a
   * broadcast. Each tab is remembered with its machine.
   */
  async function listEverywhere(
    ctx: RouteContext,
    skip: BrowserHost | null,
    options: { alwaysAsk?: boolean } = {},
  ): Promise<BuiltInBrowserOtherMachineTabs[]> {
    const { tabId: _tabId, sessionId: _sessionId, ...listInput } = isRecord(ctx.localBase) ? ctx.localBase : {};
    const exclude = skip?.kind === "desktop" ? [skip.clientId] : [];
    const [local, remote] = await Promise.all([
      skip?.kind === "here" || !localBridge
        ? Promise.resolve(null)
        : localBridge.listTabsForAgent(listInput).catch((error: unknown) => {
          // No desktop here, or one too old to list without opening the project.
          args.logger.debug("built_in_browser.list_tabs_local_skipped", {
            reason: error instanceof Error ? error.message : String(error),
          });
          return null;
        }),
      broadcaster.listTabs(listInput, {
        chatSessionId: ctx.chatSessionId,
        laneId: stringOrNull(ctx.record.laneId),
        collection: collectionOf(ctx.record),
        exclude,
        alwaysAsk: options.alwaysAsk,
      }),
    ]);
    const others: BuiltInBrowserOtherMachineTabs[] = [];
    const add = (host: BrowserHost, status: unknown) => {
      if (!isRecord(status) || !Array.isArray(status.tabs)) return;
      tabHosts.noteResult(status, host);
      const machine = machineOf(host, ctx);
      others.push({
        machine,
        tabs: annotateTabs(status.tabs, machine) as BuiltInBrowserOtherMachineTabs["tabs"],
        tabCount: typeof status.tabCount === "number" ? status.tabCount : status.tabs.length,
        tabLimit: typeof status.tabLimit === "number" ? status.tabLimit : 0,
      });
    };
    add(HERE, local);
    for (const [clientId, reply] of remote) {
      if (!reply.ok || exclude.includes(clientId)) continue;
      add({ kind: "desktop", clientId, label: reply.label }, reply.result);
    }
    return others;
  }

  /**
   * `ade browser status`: the chat's browser, then every other machine's
   * tabs, and the route. `getStatus` with a tab is a tab command like any.
   */
  async function routeStatus(
    ctx: RouteContext & { isolated: boolean; userKnown: boolean },
    call: (input: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const wantsAll = ctx.record.allMachines === true;
    if (!wantsAll || stringOrNull(ctx.record.tabId) || stringOrNull(ctx.record.sessionId)) {
      return await routeTabCommand(ctx, "getStatus", call);
    }
    let primary: unknown = null;
    let primaryHost: BrowserHost = HERE;
    if (ctx.toUserDesktop && ctx.remoteTargetId) {
      const outcome = await callDesktop("getStatus", ctx.record, ctx.remoteTargetId);
      if (outcome.taken) {
        primaryHost = { kind: "desktop", clientId: ctx.remoteTargetId, label: outcome.desktopLabel };
        if (!outcome.ok) throw onMachine(new Error(outcome.error), primaryHost, ctx);
        primary = outcome.result;
      }
    }
    // This machine's own status is read without building its collection when
    // it is not the chat's browser: listing must not restore saved tabs.
    const primaryKnown = primary !== null;
    const [ownStatus, others] = await Promise.all([
      primaryKnown ? Promise.resolve(primary) : call(ctx.localBase).catch((error) => {
        throw onMachine(error, HERE, ctx);
      }),
      listEverywhere(ctx, primaryHost),
    ]);
    const machine = machineOf(primaryHost, ctx);
    const status = isRecord(ownStatus) ? ownStatus : {};
    const merged = {
      ...status,
      tabs: annotateTabs(status.tabs, machine),
      machine,
      otherBrowsers: others.filter((entry) => entry.tabs.length > 0 || entry.machine.userComputer),
      route: routeSummary(ctx),
    };
    await nameTabOwners([merged.tabs, ...merged.otherBrowsers.map((entry) => entry.tabs as unknown[])], args.describeOwners ?? null, (error) => {
      args.logger.warn("built_in_browser.owner_names_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    return finish(ctx, primaryHost, merged);
  }

  /** Chats that sent a browser command through this brain, newest last, capped. */
  const browsingChats = new Set<string>();
  const rememberBrowsingChat = (chatSessionId: string): void => {
    browsingChats.delete(chatSessionId);
    browsingChats.add(chatSessionId);
    while (browsingChats.size > 500) {
      const oldest = browsingChats.values().next().value;
      if (oldest === undefined) break;
      browsingChats.delete(oldest);
    }
  };

  return {
    route: async (input, call, method) => {
      const ctx = routeContext(input);
      const browsingChat = stringOrNull((input as { chatSessionId?: unknown } | null)?.chatSessionId);
      if (browsingChat) rememberBrowsingChat(browsingChat);
      if (!isBuiltInBrowserDesktopBridgeMethod(method)) return await call(ctx.localBase);
      if (method === "getStatus") return await routeStatus(ctx, call);
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
      if (requestId) {
        const clientId = stringOrNull(record.clientId);
        const label = (clientId ? desktopLabelFrom(record.desktopLabel) ?? desktopLabels.get(clientId) : null) ?? "another desktop";
        const answered = broadcaster.reply(requestId, { ...record, clientId, label });
        if (answered) {
          if (clientId && record.phase === "done") rememberNewest(desktopLabels, clientId, label, LAST_HOST_CAP);
          return answered;
        }
      }
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
            ...(record.requestCarriesSignIn === true ? { requestCarriesSignIn: true } : {}),
          }),
        };
      }
      return {
        ok: settleCall(requestId, {
          taken: true,
          desktopLabel,
          ok: true,
          result: receiveRemoteCallFiles({
            requestId,
            result: record.result,
            files: record.files,
            dir: args.receivedFilesDir ?? null,
            logger: args.logger,
          }),
        }),
      };
    },
    attachLocalBridge: (bridge) => {
      localBridge = bridge;
    },
    releaseLaneTabs: async (laneId) => {
      const id = laneId.trim();
      if (!id) return;
      const local = localBridge
        ? localBridge.releaseLaneTabs({ laneId: id }).catch((error: unknown) => {
          // No desktop here, or one too old to know the method: nothing to free.
          args.logger.debug("built_in_browser.release_lane_local_skipped", {
            laneId: id,
            reason: error instanceof Error ? error.message : String(error),
          });
        })
        : Promise.resolve();
      const remote = broadcaster.send("releaseLaneTabs", { laneId: id }, { laneId: id, waitMs: RELEASE_BROADCAST_WAIT_MS });
      await local;
      void remote.then((replies) => {
        args.logger.info("built_in_browser.release_lane", { laneId: id, desktops: replies.size });
      });
    },
    chatBrowserLifecycle: (chatSessionId, state) => {
      const id = chatSessionId.trim();
      // Only chats that used the browser through this brain have tabs to look
      // after; every other chat's turns cost no message at all.
      if (!id || !browsingChats.has(id)) return;
      if (state === "ended") browsingChats.delete(id);
      void localBridge?.chatBrowserLifecycle?.({ chatSessionId: id, state }).catch((error: unknown) => {
        // No desktop here, or one too old to know the method: nothing to do.
        args.logger.debug("built_in_browser.chat_lifecycle_local_skipped", {
          chatSessionId: id,
          state,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      void broadcaster.send("chatBrowserLifecycle", { chatSessionId: id, state }, {
        chatSessionId: id,
        waitMs: RELEASE_BROADCAST_WAIT_MS,
      }).catch(() => {});
    },
    dispose: () => {
      for (const requestId of [...pending.keys()]) settle(requestId, null);
      for (const requestId of [...pendingCalls.keys()]) settleCall(requestId, { taken: false });
      broadcaster.dispose();
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
  forwarder.attachLocalBridge({
    listTabsForAgent: (input) => bridge.listTabsForAgent(input),
    releaseLaneTabs: (input) => bridge.releaseLaneTabs(input),
    chatBrowserLifecycle: (input) => bridge.chatBrowserLifecycle(input),
  });
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
