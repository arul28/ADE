import type {
  ChatTerminalPreviewResult,
  ChatTerminalReadResult,
  PtyCreateResult,
  PtyDisposeResult,
  PtySendToSessionResult,
  SessionWakeReason,
  TerminalSessionDetail,
  TerminalSessionSummary,
} from "../../../shared/types";
import type {
  SyncTerminalHistoryResponsePayload,
  SyncTerminalSnapshotPayload,
} from "../../../shared/types/sync";
import { sessionLifecycleApplied } from "../../../shared/sessionLifecycleResult";
import type { AdapterInfra, AdeNamespace } from "./types";
import { chatTerminalFromSummary } from "./infra/registries";
import { stableCacheKey } from "./infra/cacheKey";
import {
  SessionLifecycleOverlay,
  type SessionLifecyclePatch,
} from "./sessionLifecycleOverlay";
import { SessionLifecycleUnavailableError } from "./sessionLifecycleSupport";
import { assertWebRuntimePinUnsupported } from "./runtimePinGuard";

// Full snapshots replace xterm state, so they must be at least as complete as
// TerminalView's initial hydration. The host caps this at the same 2 MB.
const LIVE_TERMINAL_SUBSCRIBE_MAX_BYTES = 2_000_000;

/**
 * How many distinct `work.listSessions` argument shapes keep a mirrored copy of
 * their last authoritative rows. The Work tab reads a handful (all sessions,
 * per-lane, limited); this only has to cover those, and it is bounded so a
 * long-lived tab can't accumulate one entry per lane it ever visited.
 */
const SESSION_MIRROR_MAX_KEYS = 8;

export type SessionsPtyNamespaces = {
  sessions: AdeNamespace<"sessions">;
  pty: AdeNamespace<"pty">;
  terminal: AdeNamespace<"terminal">;
};

export function createSessionsPtyNamespaces(infra: AdapterInfra): SessionsPtyNamespaces {
  const { client, commands, events, terminalRegistry } = infra;
  const terminalSubscriptions = new Map<string, () => void>();
  const lifecycle = new SessionLifecycleOverlay();
  /**
   * Last authoritative rows per `work.listSessions` argument shape. ADE Web has
   * no local database, so this is the only thing an optimistic lifecycle patch
   * can be painted onto without first paying a full sync round-trip.
   */
  const sessionMirror = new Map<string, TerminalSessionSummary[]>();
  const sessionRefreshInFlight = new Map<string, Promise<TerminalSessionSummary[]>>();

  function subscribeSession(sessionId: string, ptyId?: string | null): void {
    if (!sessionId || terminalSubscriptions.has(sessionId)) return;
    terminalRegistry.register(sessionId, ptyId ?? terminalRegistry.ptyForSession(sessionId));
    const unsubscribe = client.subscribeTerminal(
      sessionId,
      { maxBytes: LIVE_TERMINAL_SUBSCRIBE_MAX_BYTES },
      {
        snapshot: (payload) => {
          const resolvedPtyId = terminalRegistry.ptyForSession(payload.sessionId) ?? ptyId;
          if (!resolvedPtyId) return;
          terminalRegistry.register(payload.sessionId, resolvedPtyId);
          events.emit("ptyData", {
            ptyId: resolvedPtyId,
            sessionId: payload.sessionId,
            data: payload.transcript,
            offset: payload.endOffset,
            ...(payload.delta === true ? {} : { replace: true }),
          });
        },
        data: (payload) => {
          terminalRegistry.register(payload.sessionId, payload.ptyId);
          events.emit("ptyData", {
            ptyId: payload.ptyId,
            sessionId: payload.sessionId,
            data: payload.data,
            offset: payload.offset,
          });
        },
        exit: (payload) => {
          const exitPayload = payload as { sessionId?: string; ptyId?: string; exitCode?: number | null };
          if (!exitPayload.sessionId || !exitPayload.ptyId) return;
          terminalRegistry.register(exitPayload.sessionId, exitPayload.ptyId);
          events.emit("ptyExit", {
            ptyId: exitPayload.ptyId,
            sessionId: exitPayload.sessionId,
            exitCode: exitPayload.exitCode ?? null,
          });
        },
      }
    );
    terminalSubscriptions.set(sessionId, unsubscribe);
  }

  function unsubscribeSession(sessionId: string): void {
    terminalSubscriptions.get(sessionId)?.();
    terminalSubscriptions.delete(sessionId);
  }

  infra.addDispose(() => {
    for (const unsubscribe of terminalSubscriptions.values()) unsubscribe();
    terminalSubscriptions.clear();
  });

  infra.addDispose(events.on("projectBoundary", () => {
    for (const unsubscribe of terminalSubscriptions.values()) unsubscribe();
    terminalSubscriptions.clear();
    // Rows and pending patches belong to the project that was left behind.
    sessionMirror.clear();
    sessionRefreshInFlight.clear();
    lifecycle.clear();
  }));

  infra.addDispose(
    events.on("sessionsInvalidated", () => {
      events.emit("sessionsChanged", {
        sessionId: "__ade_web_invalidation__",
        reason: "meta-updated",
      });
    })
  );

  function rememberSessionRows(key: string, rows: TerminalSessionSummary[]): void {
    sessionMirror.delete(key);
    sessionMirror.set(key, rows);
    while (sessionMirror.size > SESSION_MIRROR_MAX_KEYS) {
      const oldest = sessionMirror.keys().next().value as string | undefined;
      if (!oldest) break;
      sessionMirror.delete(oldest);
    }
  }

  async function fetchSessions(key: string, args: Record<string, unknown>): Promise<TerminalSessionSummary[]> {
    const existing = sessionRefreshInFlight.get(key);
    if (existing) return await existing;
    const request = (async () => {
      const sessions = await commands.call<TerminalSessionSummary[]>("work.listSessions", args, {
        fallback: [],
        idempotent: true,
      });
      terminalRegistry.registerSummaries(sessions);
      rememberSessionRows(key, sessions);
      return sessions;
    })();
    sessionRefreshInFlight.set(key, request);
    try {
      return await request;
    } finally {
      if (sessionRefreshInFlight.get(key) === request) sessionRefreshInFlight.delete(key);
    }
  }

  async function listSessions(args?: unknown, pin?: unknown): Promise<TerminalSessionSummary[]> {
    assertWebRuntimePinUnsupported("sessions.list", pin);
    const record = asRecord(args);
    const key = stableCacheKey(record);
    const mirrored = sessionMirror.get(key);
    if (lifecycle.size > 0 && mirrored) {
      // A lifecycle write is in flight. Answer from the mirror so the change is
      // on screen at once, and reconcile against the authoritative read in the
      // background — the row only moves again if the machine disagrees.
      void fetchSessions(key, record)
        .then((fresh) => {
          const report = lifecycle.reconcile(fresh);
          // Agreement needs no repaint — the row already shows what the machine
          // says. A patch dropped WITHOUT agreement is a rollback the user has
          // to see, so nudge the UI to re-read the authoritative row.
          if (report.rolledBack.length > 0) {
            for (const sessionId of report.rolledBack) {
              events.emit("sessionsChanged", { sessionId, reason: "meta-updated" });
            }
          }
        })
        .catch(() => {
          // A failed refresh leaves the patch pending until its TTL lapses;
          // the transport error is already surfaced by the connection status.
        });
      return lifecycle.decorateAll(mirrored);
    }
    const sessions = await fetchSessions(key, record);
    lifecycle.reconcile(sessions);
    return lifecycle.decorateAll(sessions);
  }

  async function captureSnapshot(sessionId: string, maxBytes?: number | null): Promise<SyncTerminalSnapshotPayload | null> {
    if (!sessionId) return null;
    const history = await client.requestTerminalHistory({
      sessionId,
      beforeOffset: Number.MAX_SAFE_INTEGER,
      maxBytes: maxBytes ?? 128 * 1024,
    });
    terminalRegistry.register(history.sessionId, terminalRegistry.ptyForSession(history.sessionId));
    return historyToSnapshot(history);
  }

  function notifySessionsChanged(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      events.emit("sessionsChanged", { sessionId, reason: "meta-updated" });
    }
  }

  /**
   * Refuse honestly instead of no-op'ing.
   *
   * `commands.call` resolves an unadvertised action to its fallback, and a
   * command sent while the socket is down never reaches the machine — either
   * way the row would silently stay put. Throwing means the shared Work-tab
   * helpers show a real failure and any optimistic patch rolls back.
   */
  function assertLifecycleAvailable(command: string): void {
    if (client.getStatus().state !== "connected") throw SessionLifecycleUnavailableError.disconnected();
    if (!commands.hasAction(command)) throw SessionLifecycleUnavailableError.unsupported();
  }

  /**
   * Session-lifecycle mutations all follow one shape: paint the change locally,
   * send the non-idempotent sync command, then reconcile.
   *
   * Desktop and iOS write to a local database and repaint from it. ADE Web has
   * no database, so the patch is held in `lifecycle` and the row is re-read
   * from the mirror while the round-trip is in flight. A rejection drops the
   * patch and re-notifies, so the row visibly returns to what the machine says.
   */
  async function lifecycleCall<T>(
    command: string,
    payload: Record<string, unknown>,
    changed: string | string[],
    patch: SessionLifecyclePatch,
    /**
     * Did the host actually change THIS row? Several lifecycle commands are
     * no-ops for rows that were not in the expected state (waking a row that
     * was never snoozed), and reporting a no-op as applied would leave the
     * patch painting a state the machine never entered.
     */
    applied?: (result: T | null, sessionId: string) => boolean,
  ): Promise<T | null> {
    const sessionIds = (Array.isArray(changed) ? changed : [changed]).filter(
      (sessionId): sessionId is string => Boolean(sessionId),
    );
    assertLifecycleAvailable(command);
    const tokens = sessionIds.map((sessionId) => ({ sessionId, token: lifecycle.begin(sessionId, patch) }));
    notifySessionsChanged(sessionIds);
    try {
      const result = await commands.call<T | null>(command, payload, {
        fallback: null,
        idempotent: false,
      });
      for (const entry of tokens) {
        if (applied && !applied(result, entry.sessionId)) lifecycle.reject(entry.sessionId, entry.token);
        else lifecycle.confirm(entry.sessionId, entry.token);
      }
      // Re-read against the machine now that it has acked; the patch keeps the
      // row steady until the authoritative row catches up.
      notifySessionsChanged(sessionIds);
      return result;
    } catch (error) {
      for (const entry of tokens) lifecycle.reject(entry.sessionId, entry.token);
      notifySessionsChanged(sessionIds);
      throw error;
    }
  }

  // The machine answers these with an `{ ok, sessionId, … }` envelope while the
  // desktop's local IPC path answers with a bare boolean; normalize so callers
  // (and the optimistic patch) see one shape regardless of transport.
  const appliedToAll = (result: unknown): boolean => sessionLifecycleApplied(result);
  const appliedToId = (result: unknown, sessionId: string): boolean =>
    Array.isArray(result) ? result.includes(sessionId) : true;

  const sessions: Record<string, unknown> = {
    list: listSessions,
    get: async (sessionId: string, pin?: unknown) => {
      assertWebRuntimePinUnsupported("sessions.get", pin);
      const detail = await commands.call<TerminalSessionDetail | null>("work.getSession", { sessionId }, {
        fallback: null,
        idempotent: true,
      });
      // Same overlay as the list read, so opening a row you just snoozed does
      // not show it un-snoozed while the machine catches up.
      return detail ? lifecycle.decorate(detail) : null;
    },
    delete: async (args: unknown) => {
      await commands.call("work.deleteSession", asRecord(args), {
        fallback: undefined,
        idempotent: false,
      });
      events.emit("sessionsChanged", {
        sessionId: stringField(asRecord(args), "sessionId"),
        reason: "deleted",
      });
    },
    updateMeta: async (args: unknown) => {
      const result = await commands.call<TerminalSessionSummary | null>("work.updateSessionMeta", asRecord(args), {
        fallback: null,
        idempotent: false,
      });
      if (result) terminalRegistry.registerSummary(result);
      events.emit("sessionsChanged", {
        sessionId: stringField(asRecord(args), "sessionId") || result?.id || "",
        reason: "meta-updated",
      });
      return result;
    },
    settle: async (sessionId: string, opts?: { outcome?: string; dismissPendingInput?: boolean }) => {
      await lifecycleCall("session.settleSession", {
        sessionId,
        ...(opts?.outcome ? { outcome: opts.outcome } : {}),
        ...(opts?.dismissPendingInput ? { dismissPendingInput: true } : {}),
      }, sessionId, settlePatch());
    },
    unsettle: async (sessionId: string) => {
      await lifecycleCall("session.unsettleSession", { sessionId }, sessionId, UNSETTLE_PATCH);
    },
    settleMany: async (sessionIds: string[]) =>
      (await lifecycleCall<string[]>(
        "session.settleSessions",
        { sessionIds },
        sessionIds,
        settlePatch(),
        appliedToId,
      )) ?? [],
    unsettleMany: async (sessionIds: string[]) => {
      await lifecycleCall("session.unsettleSessions", { sessionIds }, sessionIds, UNSETTLE_PATCH);
    },
    snoozeSession: async (sessionId: string, untilIso: string) =>
      sessionLifecycleApplied(await lifecycleCall<unknown>(
        "session.snoozeSession",
        { sessionId, untilIso },
        sessionId,
        snoozePatch(untilIso),
        appliedToAll,
      )),
    wakeSession: async (sessionId: string, reason?: string) =>
      sessionLifecycleApplied(await lifecycleCall<unknown>(
        "session.wakeSession",
        { sessionId, ...(reason ? { reason } : {}) },
        sessionId,
        wakePatch(reason),
        appliedToAll,
      )),
    snoozeSessions: async (sessionIds: string[], untilIso: string) =>
      (await lifecycleCall<string[]>(
        "session.snoozeSessions",
        { sessionIds, untilIso },
        sessionIds,
        snoozePatch(untilIso),
        appliedToId,
      )) ?? [],
    wakeSessions: async (sessionIds: string[], reason?: string) =>
      (await lifecycleCall<string[]>(
        "session.wakeSessions",
        { sessionIds, ...(reason ? { reason } : {}) },
        sessionIds,
        wakePatch(reason),
        appliedToId,
      )) ?? [],
    setSettleOverride: async (sessionId: string, override: "settled" | "active" | null) =>
      sessionLifecycleApplied(await lifecycleCall<unknown>(
        "session.setSettleOverride",
        { sessionId, override },
        sessionId,
        { settleOverride: override },
        appliedToAll,
      )),
    clearWokeMarker: async (sessionId: string) =>
      sessionLifecycleApplied(await lifecycleCall<unknown>(
        "session.clearWokeMarker",
        { sessionId },
        sessionId,
        CLEAR_WOKE_PATCH,
        appliedToAll,
      )),
    readTranscriptTail: async (args: unknown, pin?: unknown) => {
      assertWebRuntimePinUnsupported("sessions.readTranscriptTail", pin);
      const record = asRecord(args);
      const sessionId = stringField(record, "sessionId");
      const maxBytes = numberField(record, "maxBytes");
      if (!sessionId) return "";
      const snapshot = await captureSnapshot(sessionId, maxBytes);
      return snapshot?.transcript ?? "";
    },
    getDelta: (sessionId: string) =>
      commands.call("work.getSessionDelta", { sessionId }, {
        fallback: null,
        idempotent: true,
      }),
    onChanged: (listener: (event: unknown) => void) => events.on("sessionsChanged", listener as never),
  };

  // Contract gap: these Electron-shaped namespaces target one web host and do
  // not accept runtime pins. The shared guard (./runtimePinGuard) covers every pty/terminal
  // shim, sessions.list/get/readTranscriptTail, lanes.list, and the draft
  // attachment shim in agentChat.ts — the surfaces cross-machine reads actually
  // reach today. The wider lanes/sessions pin params in the Electron contract
  // predate per-session routing and stay unguarded; a cross-machine web union
  // must extend the adapter (and these guards) before relying on any pin.
  const pty: Record<string, unknown> = {
    create: async (args: unknown, pin?: unknown): Promise<PtyCreateResult> => {
      assertWebRuntimePinUnsupported("pty.create", pin);
      const record = asRecord(args);
      const result = await commands.call<Record<string, unknown> | null>(
        "work.startCliSession",
        {
          laneId: record.laneId,
          provider: providerFromToolType(record.toolType),
          title: record.title,
          initialInput: record.initialInput ?? record.startupCommand ?? record.command ?? null,
          cols: record.cols,
          rows: record.rows,
          model: record.model,
          modelId: record.modelId,
          reasoningEffort: record.reasoningEffort,
          permissionMode: record.permissionMode,
        },
        {
          fallback: null,
          idempotent: false,
        }
      );
      const sessionId = stringField(result ?? {}, "sessionId") || stringField(record, "sessionId");
      const ptyId = stringField(result ?? {}, "ptyId") || sessionId;
      terminalRegistry.register(sessionId, ptyId);
      terminalRegistry.registerSummary((result?.session as TerminalSessionSummary | undefined) ?? null);
      events.emit("sessionsChanged", {
        sessionId,
        reason: "created",
      });
      return { ptyId, sessionId, pid: null };
    },
    resumeSession: async (args: unknown, pin?: unknown): Promise<PtySendToSessionResult> => {
      assertWebRuntimePinUnsupported("pty.resumeSession", pin);
      const result = await commands.call<PtySendToSessionResult | null>("work.resumeCliSession", asRecord(args), {
        fallback: null,
        idempotent: false,
      });
      if (result) {
        terminalRegistry.register(result.sessionId, result.ptyId);
        terminalRegistry.registerSummary(result.session);
      }
      return result ?? fallbackSendResult(asRecord(args));
    },
    sendToSession: async (args: unknown, pin?: unknown): Promise<PtySendToSessionResult> => {
      assertWebRuntimePinUnsupported("pty.sendToSession", pin);
      const result = await commands.call<PtySendToSessionResult | null>("work.sendToSession", asRecord(args), {
        fallback: null,
        idempotent: false,
      });
      if (result) {
        terminalRegistry.register(result.sessionId, result.ptyId);
        terminalRegistry.registerSummary(result.session);
      }
      return result ?? fallbackSendResult(asRecord(args));
    },
    write: async (args: unknown, pin?: unknown) => {
      assertWebRuntimePinUnsupported("pty.write", pin);
      const record = asRecord(args);
      const sessionId = terminalRegistry.sessionForPty(stringField(record, "ptyId"));
      if (!sessionId) return;
      await client.sendTerminalInput(sessionId, stringField(record, "data"));
    },
    resize: async (args: unknown, pin?: unknown) => {
      assertWebRuntimePinUnsupported("pty.resize", pin);
      const record = asRecord(args);
      const sessionId = terminalRegistry.sessionForPty(stringField(record, "ptyId"));
      if (!sessionId) return;
      await client.sendTerminalResize(sessionId, numberField(record, "cols") ?? 80, numberField(record, "rows") ?? 24);
    },
    dispose: async (args: unknown, pin?: unknown): Promise<PtyDisposeResult> => {
      assertWebRuntimePinUnsupported("pty.dispose", pin);
      const record = asRecord(args);
      const sessionId = stringField(record, "sessionId") || terminalRegistry.sessionForPty(stringField(record, "ptyId"));
      if (sessionId) unsubscribeSession(sessionId);
      return await commands.call<PtyDisposeResult>("work.stopRuntime", { sessionId }, {
        fallback: { disposed: false, reason: "missing" },
        idempotent: false,
      });
    },
    setDataSubscriptions: async (args: unknown, pin?: unknown) => {
      assertWebRuntimePinUnsupported("pty.setDataSubscriptions", pin);
      const ptyIds = Array.isArray(asRecord(args).ptyIds) ? (asRecord(args).ptyIds as unknown[]) : [];
      const wanted = new Set<string>();
      for (const ptyId of ptyIds) {
        const sessionId = terminalRegistry.sessionForPty(String(ptyId));
        if (!sessionId) continue;
        wanted.add(sessionId);
        subscribeSession(sessionId, String(ptyId));
      }
      for (const sessionId of Array.from(terminalSubscriptions.keys())) {
        if (!wanted.has(sessionId)) unsubscribeSession(sessionId);
      }
    },
    onData: (listener: (event: unknown) => void, pin?: unknown) => {
      assertWebRuntimePinUnsupported("pty.onData", pin);
      return events.on("ptyData", listener as never);
    },
    onExit: (listener: (event: unknown) => void, pin?: unknown) => {
      assertWebRuntimePinUnsupported("pty.onExit", pin);
      return events.on("ptyExit", listener as never);
    },
  };

  const terminal: Record<string, unknown> = {
    list: async (args?: unknown) => {
      const sessions = await commands.call<unknown[]>("terminal.list", asRecord(args), {
        fallback: [],
        idempotent: true,
      });
      terminalRegistry.registerSummaries(sessions);
      return sessions;
    },
    read: async (args?: unknown): Promise<ChatTerminalReadResult> => {
      const record = asRecord(args);
      const sessionId = terminalRegistry.resolveSessionId(record);
      if (!sessionId) return { terminalId: "", data: "", nextSince: 0 };
      const maxBytes = numberField(record, "maxBytes") ?? 128 * 1024;
      const beforeOffset = numberField(record, "since") ?? Number.MAX_SAFE_INTEGER;
      const history = await client.requestTerminalHistory({ sessionId, beforeOffset, maxBytes });
      return { terminalId: sessionId, data: history.data, nextSince: history.endOffset };
    },
    preview: async (args?: unknown, pin?: unknown): Promise<ChatTerminalPreviewResult> => {
      assertWebRuntimePinUnsupported("terminal.preview", pin);
      const record = asRecord(args);
      let sessionId = terminalRegistry.resolveSessionId(record);
      if (!sessionId && record.chatSessionId) {
        const active = await commands.call<Record<string, unknown> | null>(
          "terminal.activeForChat",
          { chatSessionId: record.chatSessionId },
          { fallback: null, idempotent: true }
        );
        sessionId = stringField(active ?? {}, "terminalId") || stringField(active ?? {}, "id");
        terminalRegistry.register(sessionId, stringField(active ?? {}, "ptyId"));
        terminalRegistry.registerSummary(active);
      }
      if (!sessionId) return emptyPreview("");
      const snapshot = await captureSnapshot(sessionId, numberField(record, "maxBytes"));
      const ptyId = terminalRegistry.ptyForSession(sessionId);
      const session = chatTerminalFromSummary(sessionId, terminalRegistry.summaryForSession(sessionId), ptyId);
      return {
        terminalId: sessionId,
        session,
        source: snapshot?.transcript ? "transcript" : "empty",
        snapshot: null,
        transcript: snapshot?.transcript ?? null,
        capturedAt: snapshot?.capturedAt ?? new Date().toISOString(),
      };
    },
    write: async (args: unknown) => {
      const record = asRecord(args);
      const sessionId = terminalRegistry.resolveSessionId(record);
      if (sessionId) await client.sendTerminalInput(sessionId, stringField(record, "data"));
      return { ok: true };
    },
    signal: async (args: unknown) => {
      const record = asRecord(args);
      const sessionId = terminalRegistry.resolveSessionId(record);
      if (sessionId && record.signal === "SIGINT") await client.sendTerminalInput(sessionId, "\u0003");
      return { ok: true };
    },
    activeForChat: async (args: unknown) => {
      const result = await commands.call<Record<string, unknown> | null>("terminal.activeForChat", asRecord(args), {
        fallback: null,
        idempotent: true,
      });
      terminalRegistry.registerSummary(result);
      terminalRegistry.register(stringField(result ?? {}, "terminalId") || stringField(result ?? {}, "id"), stringField(result ?? {}, "ptyId"));
      return result;
    },
    reattachChatCli: (args: unknown) =>
      commands.call("terminal.reattachChatCli", asRecord(args), {
        fallback: { terminalId: "", ptyId: "", pid: null, relaunched: false },
        idempotent: false,
      }),
  };

  return {
    sessions: sessions as AdeNamespace<"sessions">,
    pty: pty as AdeNamespace<"pty">,
    terminal: terminal as AdeNamespace<"terminal">,
  };
}

/**
 * The optimistic column writes, mirroring exactly what the host's
 * `sessionService` does for each command. Instants the HOST stamps are filled in
 * with the browser clock and reconciled by PRESENCE, never by value — the
 * machine's instant is the real one. The snooze deadline is the exception: the
 * client computes it and the host echoes it back, so it reconciles by value.
 */

/** Host: `settled_at = coalesce(settled_at, now)`, `settle_override = null`. */
function settlePatch(): SessionLifecyclePatch {
  return { settledAt: new Date().toISOString(), settleOverride: null };
}

/**
 * Host: `settled_at = null`, and it clears a `"settled"` override only. An
 * `"active"` pin survives, so this patch deliberately leaves the column alone
 * rather than claiming a clear the machine may not make.
 */
const UNSETTLE_PATCH: SessionLifecyclePatch = { settledAt: null };

/** Host: sets both snooze columns and drops any previous woke marker. */
function snoozePatch(untilIso: string): SessionLifecyclePatch {
  return {
    snoozedUntil: untilIso,
    snoozedAt: new Date().toISOString(),
    wokeAt: null,
    wokeReason: null,
  };
}

/** Host: clears both snooze columns and records why the row came back. */
function wakePatch(reason?: string): SessionLifecyclePatch {
  return {
    snoozedUntil: null,
    snoozedAt: null,
    wokeAt: new Date().toISOString(),
    wokeReason: normalizeWakeReason(reason),
  };
}

const CLEAR_WOKE_PATCH: SessionLifecyclePatch = { wokeAt: null, wokeReason: null };

const WAKE_REASONS = new Set<SessionWakeReason>(["timer", "needs_you", "error", "turn_complete", "manual"]);

function normalizeWakeReason(reason?: string): SessionWakeReason {
  return WAKE_REASONS.has(reason as SessionWakeReason) ? (reason as SessionWakeReason) : "manual";
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}


function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerFromToolType(toolType: unknown): string {
  if (toolType === "codex" || toolType === "cursor" || toolType === "droid" || toolType === "opencode") return toolType;
  if (toolType === "claude" || toolType === null || toolType === undefined) return "claude";
  return "shell";
}

function fallbackSendResult(args: Record<string, unknown>): PtySendToSessionResult {
  const sessionId = stringField(args, "sessionId");
  return {
    ptyId: stringField(args, "ptyId"),
    sessionId,
    pid: null,
    session: null,
    resumed: false,
    reusedExistingRuntime: false,
  };
}

function emptyPreview(terminalId: string): ChatTerminalPreviewResult {
  return {
    terminalId,
    session: chatTerminalFromSummary(terminalId, null, null),
    source: "empty",
    snapshot: null,
    transcript: null,
    capturedAt: new Date().toISOString(),
  };
}

function historyToSnapshot(history: SyncTerminalHistoryResponsePayload): SyncTerminalSnapshotPayload {
  return {
    sessionId: history.sessionId,
    transcript: history.data,
    status: null,
    runtimeState: null,
    lastOutputPreview: null,
    capturedAt: new Date().toISOString(),
    startOffset: history.startOffset,
    endOffset: history.endOffset,
  };
}
