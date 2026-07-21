import type {
  ChatTerminalPreviewResult,
  ChatTerminalReadResult,
  PtyCreateResult,
  PtyDisposeResult,
  PtySendToSessionResult,
  TerminalSessionSummary,
} from "../../../shared/types";
import type {
  SyncTerminalHistoryResponsePayload,
  SyncTerminalSnapshotPayload,
} from "../../../shared/types/sync";
import type { AdapterInfra, AdeNamespace } from "./types";
import { chatTerminalFromSummary } from "./infra/registries";

const LIVE_TERMINAL_SUBSCRIBE_MAX_BYTES = 1_024;

export type SessionsPtyNamespaces = {
  sessions: AdeNamespace<"sessions">;
  pty: AdeNamespace<"pty">;
  terminal: AdeNamespace<"terminal">;
};

export function createSessionsPtyNamespaces(infra: AdapterInfra): SessionsPtyNamespaces {
  const { client, commands, events, terminalRegistry } = infra;
  const terminalSubscriptions = new Map<string, () => void>();

  function subscribeSession(sessionId: string, ptyId?: string | null): void {
    if (!sessionId || terminalSubscriptions.has(sessionId)) return;
    terminalRegistry.register(sessionId, ptyId ?? terminalRegistry.ptyForSession(sessionId));
    const unsubscribe = client.subscribeTerminal(
      sessionId,
      { maxBytes: LIVE_TERMINAL_SUBSCRIBE_MAX_BYTES },
      {
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

  infra.addDispose(
    events.on("sessionsInvalidated", () => {
      events.emit("sessionsChanged", {
        sessionId: "__ade_web_invalidation__",
        reason: "meta-updated",
      });
    })
  );

  async function listSessions(args?: unknown): Promise<TerminalSessionSummary[]> {
    const sessions = await commands.call<TerminalSessionSummary[]>("work.listSessions", asRecord(args), {
      fallback: [],
      idempotent: true,
    });
    terminalRegistry.registerSummaries(sessions);
    return sessions;
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

  const sessions: Record<string, unknown> = {
    list: listSessions,
    get: (sessionId: string) =>
      commands.call("work.getSession", { sessionId }, {
        fallback: null,
        idempotent: true,
      }),
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
    readTranscriptTail: async (args: unknown) => {
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

  const pty: Record<string, unknown> = {
    create: async (args: unknown): Promise<PtyCreateResult> => {
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
    resumeSession: async (args: unknown): Promise<PtySendToSessionResult> => {
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
    sendToSession: async (args: unknown): Promise<PtySendToSessionResult> => {
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
    write: async (args: unknown) => {
      const record = asRecord(args);
      const sessionId = terminalRegistry.sessionForPty(stringField(record, "ptyId"));
      if (!sessionId) return;
      await client.sendTerminalInput(sessionId, stringField(record, "data"));
    },
    resize: async (args: unknown) => {
      const record = asRecord(args);
      const sessionId = terminalRegistry.sessionForPty(stringField(record, "ptyId"));
      if (!sessionId) return;
      await client.sendTerminalResize(sessionId, numberField(record, "cols") ?? 80, numberField(record, "rows") ?? 24);
    },
    dispose: async (args: unknown): Promise<PtyDisposeResult> => {
      const record = asRecord(args);
      const sessionId = stringField(record, "sessionId") || terminalRegistry.sessionForPty(stringField(record, "ptyId"));
      if (sessionId) unsubscribeSession(sessionId);
      return await commands.call<PtyDisposeResult>("work.stopRuntime", { sessionId }, {
        fallback: { disposed: false, reason: "missing" },
        idempotent: false,
      });
    },
    setDataSubscriptions: async (args: unknown) => {
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
    onData: (listener: (event: unknown) => void) => events.on("ptyData", listener as never),
    onExit: (listener: (event: unknown) => void) => events.on("ptyExit", listener as never),
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
    preview: async (args?: unknown): Promise<ChatTerminalPreviewResult> => {
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
