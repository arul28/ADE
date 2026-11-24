import { getErrorMessage } from "../../../../desktop/src/main/services/shared/utils";
import { redactOutgoingChatText } from "../../../../desktop/src/main/utils/redaction";
import type { RemoteMcpActivityEntry, RemoteMcpConnectionSummary } from "../../../../desktop/src/shared/types/remoteMcp";
import {
  MCP_EVENT_NAMES,
  mcpChatSource,
  mcpDeletedChat,
  mcpHubCovers,
  mcpHubPositionAt,
  readMcpHub,
  type McpChatIdentity,
  type McpEventName,
  type McpHubEntry,
} from "./remoteMcpEventHub";
import {
  CHAT_EVENT_NAMES,
  DEFAULT_MAX_EVENTS,
  EVENTS_ERROR,
  MAX_EVENTS,
  MAX_REPLY_CHARS,
  McpEventsError,
  boundedInteger,
  decodeCursor,
  decodePosition,
  encodeCursor,
  encodePosition,
  eventName,
  invalid,
  isRecord,
  listMcpEventTypes,
  parseFilter,
  EVENTS_HERE_TOOL_NAME,
  EVENTS_POLL_TOOL_NAME,
  eventsPollText,
  type EventFilter,
  type MachineRead,
  type McpOccurrence,
  type ReadHereArgs,
} from "./remoteMcpEventCatalog";
import { createMcpWebhooks } from "./remoteMcpEventWebhooks";
import { toolError, type RemoteMcpCallContext, type RemoteMcpMachineRouter, type RemoteMcpRosterMachine, type RemoteMcpToolResult } from "./remoteMcpForward";
import type { RemoteMcpVault } from "./remoteMcpStore";
import type { RemoteMcpProject } from "./remoteMcpProtocol";

/**
 * ADE MCP Events: SEP-3415 (`io.modelcontextprotocol/events`) over the
 * account address, from the machine hubs (remoteMcpEventHub.ts).
 *
 * - `events/poll` reads every machine of the account: this one directly, the
 *   others by one forwarded call each. The cursor holds one position per
 *   machine, so a machine that was offline catches up when it is back.
 * - `events/subscribe` (webhooks) is in remoteMcpEventWebhooks.ts: each machine
 *   POSTs its own events. Nothing goes through ADE's servers.
 * - `events/stream` is not offered: the relay holds no open stream.
 *
 * The event types, argument checks and cursors are in remoteMcpEventCatalog.ts.
 */

const NEXT_POLL_MS = 15_000;
const FORWARD_TIMEOUT_MS = 12_000;
/** A reply read finds nothing this soon after the turn: read again next time instead of keeping "no reply". */
const REPLY_RETRY_WINDOW_MS = 5_000;

export type McpEventsDeps = {
  machines: RemoteMcpMachineRouter;
  listProjects: () => RemoteMcpProject[];
  vault: RemoteMcpVault;
  /** The connection behind a principal, or null when it was removed. */
  connection: (id: string) => RemoteMcpConnectionSummary | null;
  /** This machine answers ADE MCP now; one that doesn't sends no webhooks. */
  servingHere: () => boolean;
  /** Pushes the vault soon, so the other machines see a new subscription. */
  syncSoon: () => void;
  /** Settings → ADE MCP activity. */
  record: (entry: Omit<RemoteMcpActivityEntry, "at">) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
};

export function createRemoteMcpEvents(deps: McpEventsDeps) {
  const now = deps.now ?? Date.now;
  const warn = (event: string, data: Record<string, unknown> = {}) => deps.warn?.(event, data);
  const selfKey = (): string => deps.machines.thisMachine().key || "here";

  // ── Reading this machine's events ──────────────────────────────────────────

  /** Sessions whose chat read already failed and was logged: one line per chat, not one per event. */
  const readFailuresLogged = new Set<string>();
  const readFailed = (what: "identity" | "reply", sessionId: string) => (error: unknown): null => {
    const key = `${what}:${sessionId}`;
    if (!readFailuresLogged.has(key) && readFailuresLogged.size < 500) {
      readFailuresLogged.add(key);
      warn("remote_mcp.events_chat_read_failed", { what, sessionId, error: getErrorMessage(error) });
    }
    return null;
  };

  const identities = new WeakMap<McpHubEntry, Promise<McpChatIdentity | null>>();
  const replies = new WeakMap<McpHubEntry, Promise<Record<string, unknown> | null>>();

  const identityOf = (entry: McpHubEntry): Promise<McpChatIdentity | null> => {
    let pending = identities.get(entry);
    if (!pending) {
      const source = entry.sessionId ? mcpChatSource(entry.projectId) : null;
      pending = source && entry.sessionId ? source.identity(entry.sessionId).catch(readFailed("identity", entry.sessionId)) : Promise.resolve(null);
      identities.set(entry, pending);
    }
    return pending;
  };

  const replyOf = (entry: McpHubEntry): Promise<Record<string, unknown> | null> => {
    let pending = replies.get(entry);
    if (!pending) {
      const source = mcpChatSource(entry.projectId);
      pending = source && entry.sessionId
        ? source.finalReply(entry.sessionId, entry.turnId, entry.turnStartedAt, entry.at).then((reply) => {
          if (!reply?.text.trim()) return null;
          const text = redactOutgoingChatText(reply.text.trim());
          return {
            text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS - 1)}…` : text,
            messageId: reply.messageId,
            ...(text.length > MAX_REPLY_CHARS ? { truncated: true } : {}),
          };
        }).catch(readFailed("reply", entry.sessionId))
        : Promise.resolve(null);
      replies.set(entry, pending);
      // Just after the turn, the reply may still be on its way to the file.
      void pending.then((reply) => {
        if (!reply && now() - entry.at < REPLY_RETRY_WINDOW_MS && replies.get(entry) === pending) replies.delete(entry);
      });
    }
    return pending;
  };

  /** The projects a `project` argument names: by id, account id, name or folder name. */
  const projectIdsNamed = (projects: readonly RemoteMcpProject[], requested: string): Set<string> => {
    const lower = requested.toLowerCase();
    return new Set(projects.filter((project) =>
      project.projectId === requested
      || project.accountProjectId === requested
      || project.displayName.toLowerCase() === lower
      || project.rootPath === requested
      || project.rootPath.split(/[\\/]/).pop()?.toLowerCase() === lower).map((project) => project.projectId));
  };

  const occurrenceOf = async (entry: McpHubEntry, filter: EventFilter, projectNames: ReadonlyMap<string, string>): Promise<McpOccurrence | null> => {
    const chat = CHAT_EVENT_NAMES.has(entry.name);
    // A deleted chat has no summary left: the hub kept what it was.
    const identity = chat && entry.sessionId ? (await identityOf(entry)) ?? mcpDeletedChat(entry.sessionId) : null;
    const parentSessionId = identity?.parentSessionId ?? null;
    if (parentSessionId && !filter.includeSubagents) return null;
    const self = deps.machines.thisMachine();
    const data: Record<string, unknown> = chat
      ? {
        title: identity?.title ?? null,
        laneId: identity?.laneId ?? null,
        ...entry.data,
        sessionId: entry.sessionId,
        parentSessionId,
        ...(entry.name === "chat.deleted" ? {} : { turnId: entry.turnId }),
      }
      : { ...entry.data };
    if (entry.name === "chat.turn_ended" && filter.includeReply) {
      const reply = await replyOf(entry);
      if (reply) data.reply = reply;
    }
    data.projectId = entry.projectId;
    data.project = projectNames.get(entry.projectId) ?? null;
    data.machine = { key: self.key, name: self.name };
    return { eventId: entry.eventId, name: entry.name, timestamp: new Date(entry.at).toISOString(), data };
  };

  const readHere = async (args: ReadHereArgs): Promise<MachineRead> => {
    const given = decodePosition(args.part);
    const after = given ?? (args.sinceMs !== null ? mcpHubPositionAt(args.sinceMs) : null);
    // No position here yet: a start before this brain run (or before the oldest event kept) is a gap.
    const sinceGap = !given && args.sinceMs !== null && !mcpHubCovers(args.sinceMs);
    // One project list per read: it reads the registry and git config.
    const projectList = deps.listProjects();
    const projectNames = new Map(projectList.map((project) => [project.projectId, project.displayName]));
    const projects = args.filter.project ? projectIdsNamed(projectList, args.filter.project) : null;
    const page = readMcpHub({
      after,
      match: (entry) => args.filter.names.has(entry.name)
        && (!projects || projects.has(entry.projectId))
        && (!args.filter.session || entry.sessionId === args.filter.session),
      max: 1_000,
      notBefore: args.maxAgeMs !== null ? now() - args.maxAgeMs : null,
    });
    const events: MachineRead["events"] = [];
    let next = page.next;
    let hasMore = page.hasMore;
    for (const entry of page.entries) {
      if (events.length >= args.max) {
        hasMore = true;
        next = { boot: next.boot, seq: events[events.length - 1]!.seq };
        break;
      }
      const occurrence = await occurrenceOf(entry, args.filter, projectNames);
      if (occurrence) events.push({ occurrence, seq: entry.seq });
    }
    return { events, part: encodePosition(next), truncated: page.truncated || sinceGap, hasMore };
  };

  // ── Machines ───────────────────────────────────────────────────────────────

  type Target = { key: string; name: string; here: boolean; machine: RemoteMcpRosterMachine | null; reason: string | null };

  /** The key of the machine `machine` names. Refused when the connection can't reach it or it is left out of ADE MCP. */
  const machineKeyNamed = async (connection: RemoteMcpConnectionSummary, machine: string): Promise<string> => {
    const router = deps.machines;
    const resolved = await router.resolve(machine);
    if (resolved.kind === "error") throw invalid(resolved.message);
    const key = resolved.kind === "here" ? selfKey() : resolved.machine.machineKey;
    const onlyKey = connection.onlyMachine?.machineKey ?? null;
    if (onlyKey && key !== onlyKey) throw new McpEventsError(EVENTS_ERROR.forbidden, "This connection reaches one machine only, and that isn't it.");
    if (resolved.kind === "remote" && !resolved.machine.included) {
      throw invalid(router.unavailableReason(resolved.machine) ?? `${resolved.machine.name} is left out of ADE MCP.`);
    }
    return key;
  };

  /** The machines a read covers: all the connection reaches, or the one `machine` names. */
  const targetsFor = async (connection: RemoteMcpConnectionSummary, machine: string | null): Promise<Target[]> => {
    const router = deps.machines;
    const self = router.thisMachine();
    const onlyKey = machine ? await machineKeyNamed(connection, machine) : connection.onlyMachine?.machineKey ?? null;
    const roster = await router.roster();
    const targets: Target[] = [];
    if (!onlyKey || onlyKey === selfKey()) targets.push({ key: selfKey(), name: self.name, here: true, machine: null, reason: null });
    for (const entry of roster) {
      if (entry.isThisMachine || !entry.included || (onlyKey && entry.machineKey !== onlyKey)) continue;
      targets.push({ key: entry.machineKey, name: entry.name, here: false, machine: entry, reason: router.unavailableReason(entry) });
    }
    return targets;
  };

  const readThere = async (
    target: Target,
    context: RemoteMcpCallContext,
    request: { names: McpEventName[]; arguments: Record<string, unknown>; part: string | null; since: number; max: number; maxAgeMs: number | null },
  ): Promise<MachineRead | null> => {
    if (!target.machine || target.reason) return null;
    const result = await deps.machines.forward(target.machine, { name: EVENTS_HERE_TOOL_NAME, arguments: request }, context, FORWARD_TIMEOUT_MS)
      .catch(() => null);
    const read = result && !result.isError ? result.structuredContent : null;
    if (!isRecord(read) || !Array.isArray(read.events) || typeof read.part !== "string") return null;
    return read as unknown as MachineRead;
  };

  /** One forwarded `ade_events_here` call: this machine's part of an account-wide read. */
  const answerHere = async (input: Record<string, unknown>): Promise<MachineRead> => {
    const names = Array.isArray(input.names) ? input.names.map(eventName) : [eventName(input.name)];
    return await readHere({
      filter: parseFilter(names, input.arguments),
      part: typeof input.part === "string" ? input.part : null,
      sinceMs: typeof input.since === "number" ? input.since : null,
      max: boundedInteger(input.max, "max", DEFAULT_MAX_EVENTS, 1, MAX_EVENTS),
      maxAgeMs: boundedInteger(input.maxAgeMs, "maxAgeMs", null, 0, Number.MAX_SAFE_INTEGER),
    });
  };

  /** Every machine's matching events after the cursor, oldest first. */
  const pollAccount = async (
    connection: RemoteMcpConnectionSummary,
    context: RemoteMcpCallContext,
    request: { names: McpEventName[]; arguments: unknown; cursor: unknown; maxEvents: unknown; maxAgeMs: unknown },
  ) => {
    const filter = parseFilter(request.names, request.arguments);
    const max = boundedInteger(request.maxEvents, "maxEvents", DEFAULT_MAX_EVENTS, 1, MAX_EVENTS);
    const maxAgeMs = boundedInteger(request.maxAgeMs, "maxAgeMs", null, 0, Number.MAX_SAFE_INTEGER);
    const cursor = decodeCursor(request.cursor);
    const targets = await targetsFor(connection, filter.machine);
    // Null starts now: no machine needs asking, each starts at this moment.
    if (!cursor) return { events: [] as McpOccurrence[], cursor: encodeCursor({ t: now(), m: {} }), truncated: false, hasMore: false, unread: [] as Array<{ key: string; name: string; reason: string }> };
    const argumentsForward = isRecord(request.arguments) ? { ...request.arguments } : {};
    delete argumentsForward.machine;
    const reads = await Promise.all(targets.map(async (target) => {
      const part = cursor.m[target.key] ?? null;
      const read = target.here
        ? await readHere({ filter, part, sinceMs: cursor.t, max, maxAgeMs })
        : await readThere(target, context, { names: request.names, arguments: argumentsForward, part, since: cursor.t, max, maxAgeMs });
      return { target, read };
    }));
    const merged = reads.flatMap(({ target, read }) => (read?.events ?? []).map((event) => ({ ...event, key: target.key })))
      .sort((left, right) => left.occurrence.timestamp.localeCompare(right.occurrence.timestamp));
    const kept = merged.slice(0, max);
    const parts: Record<string, string> = { ...cursor.m };
    let hasMore = merged.length > kept.length;
    for (const { target, read } of reads) {
      // Unreachable now: its position stays, and it catches up when it is back.
      if (!read) continue;
      const mine = kept.filter((event) => event.key === target.key);
      if (mine.length < read.events.length) {
        // Cut short by the page: resume after the last event kept, in the same brain run.
        const position = decodePosition(read.part);
        if (position) parts[target.key] = encodePosition({ boot: position.boot, seq: mine.length ? mine[mine.length - 1]!.seq : Math.max(0, read.events[0]!.seq - 1) });
      } else {
        parts[target.key] = read.part;
      }
      if (read.hasMore) hasMore = true;
    }
    return {
      events: kept.map((event) => event.occurrence),
      cursor: encodeCursor({ t: cursor.t, m: parts }),
      truncated: reads.some(({ read }) => read?.truncated === true),
      hasMore,
      // Offline, asleep, or on an ADE without Events: their events come on a later poll.
      unread: reads.filter(({ read }) => !read).map(({ target }) => ({ key: target.key, name: target.name, reason: target.reason ?? "no_answer" })),
    };
  };

  const webhooks = createMcpWebhooks({
    vault: deps.vault,
    connection: deps.connection,
    servingHere: deps.servingHere,
    syncSoon: deps.syncSoon,
    warn,
    now,
    selfKey,
    readHere,
    machineKeyNamed,
  });

  const record = (
    connection: RemoteMcpConnectionSummary,
    tool: string,
    entry: { command: string; outcome: "ok" | "refused"; startedAt: number; detail?: string },
  ): void => deps.record({
    connectionId: connection.id,
    label: connection.label,
    scope: connection.scope,
    tool,
    command: entry.command,
    outcome: entry.outcome,
    exitCode: null,
    durationMs: now() - entry.startedAt,
    ...(entry.detail ? { detail: entry.detail } : {}),
  });

  /** `events_poll` (an app's poll) or `ade_events_here` (one machine's part of a poll on another). */
  const toolCall = async (
    connection: RemoteMcpConnectionSummary,
    name: string,
    input: Record<string, unknown>,
    context: RemoteMcpCallContext,
  ): Promise<RemoteMcpToolResult> => {
    const startedAt = now();
    try {
      if (name === EVENTS_HERE_TOOL_NAME) {
        const read = await answerHere(input);
        return { content: [{ type: "text", text: `${read.events.length} events` }], structuredContent: read, isError: false };
      }
      // Every event name unless `names` picks some.
      const names = input.names === undefined || input.names === null
        ? [...MCP_EVENT_NAMES]
        : Array.isArray(input.names) ? input.names.map(eventName) : [eventName(input.names)];
      const { cursor, names: _names, max, ...rest } = input;
      const page = await pollAccount(connection, context, { names, arguments: rest, cursor, maxEvents: max, maxAgeMs: undefined });
      record(connection, name, { command: "", outcome: "ok", startedAt });
      return { content: [{ type: "text", text: eventsPollText(page) }], structuredContent: { view: EVENTS_POLL_TOOL_NAME, ...page }, isError: false };
    } catch (error) {
      const reason = getErrorMessage(error);
      record(connection, name, { command: "", outcome: "refused", startedAt, detail: reason });
      return toolError(reason);
    }
  };

  /** The `events/*` methods: a result, or the JSON-RPC error to answer with. */
  const rpc = async (
    connection: RemoteMcpConnectionSummary,
    context: RemoteMcpCallContext,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ result: Record<string, unknown> } | { error: { code: number; message: string; data?: Record<string, unknown> } }> => {
    const startedAt = now();
    const webhook = method === "events/subscribe" || method === "events/unsubscribe";
    // A webhook sends chat replies to a URL the app chose: the activity list shows each one set up or removed.
    const recordWebhook = (outcome: "ok" | "refused", detail?: string): void => {
      if (!webhook) return;
      let host = "";
      try {
        host = isRecord(params.delivery) && typeof params.delivery.url === "string" ? new URL(params.delivery.url).host : "";
      } catch {
        host = "";
      }
      const command = `${method} ${typeof params.name === "string" ? params.name : ""}${host ? ` → ${host}` : ""}`.trim();
      record(connection, method, { command, outcome, startedAt, ...(detail ? { detail } : {}) });
    };
    try {
      let result: Record<string, unknown>;
      if (method === "events/list") {
        result = { events: listMcpEventTypes() };
      } else if (method === "events/poll") {
        const { unread, ...page } = await pollAccount(connection, context, {
          names: [eventName(params.name)],
          arguments: params.arguments,
          cursor: params.cursor,
          maxEvents: params.maxEvents,
          maxAgeMs: params.maxAgeMs,
        });
        result = { ...page, nextPollMs: NEXT_POLL_MS, ...(unread.length ? { _meta: { "dev.ade/unreadMachines": unread } } : {}) };
      } else if (method === "events/subscribe") {
        result = await webhooks.subscribe(connection, params);
      } else if (method === "events/unsubscribe") {
        webhooks.unsubscribe(connection, params);
        result = {};
      } else {
        throw new McpEventsError(
          EVENTS_ERROR.unsupported,
          "ADE delivers events by events/poll or a webhook (events/subscribe); the relay holds no open stream.",
          { feature: "deliveryMode", value: "push" },
        );
      }
      recordWebhook("ok");
      return { result: { resultType: "complete", ...result } };
    } catch (error) {
      const message = getErrorMessage(error);
      recordWebhook("refused", message);
      if (error instanceof McpEventsError) return { error: { code: error.code, message, ...(error.data ? { data: error.data } : {}) } };
      warn("remote_mcp.events_failed", { method, error: message });
      return { error: { code: -32603, message } };
    }
  };

  return {
    toolCall,
    rpc,
    /** The service's periodic refresh: subscriptions from other machines, expiry and revocation. */
    refresh: webhooks.refresh,
  };
}

export type RemoteMcpEvents = ReturnType<typeof createRemoteMcpEvents>;
