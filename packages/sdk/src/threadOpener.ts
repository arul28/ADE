import type { ThreadResumeOptions } from "./clientOptions.js";
import { AdeError } from "./errors.js";
import type { ChatEventSource } from "./eventStream.js";
import {
  canonicalThreadCwd,
  normalizeInstructions,
  normalizeInstructionsCapability,
  normalizePermissionCapability,
  normalizeSettingSources,
  normalizeSettingSourcesCapability,
  validateThreadCwd,
  type InstructionsCapability,
  type PermissionCapability,
  type SettingSourcesCapability,
  type ThreadInstructions,
} from "./hostConfig.js";
import { normalizeMcpCapability } from "./mcpCapability.js";
import {
  mcpServersFingerprint,
  missingHeadersWarning,
  toStoredMcpServers,
  withResolvedHeaders,
  type McpHeadersResolver,
  type StoredMcpServerConfig,
} from "./mcpHeaders.js";
import { modelSelectionOf } from "./modelSelection.js";
import {
  isPermissionPolicy,
  isSupportedProvider,
  readApprovalTimeoutMs,
  resolvePermissionArgs,
  type PermissionPreset,
  type ThreadPermissionPolicy,
} from "./permissions.js";
import type { PersonalChatsApi } from "./personalChats.js";
import { Thread, type ThreadRecordPatch } from "./thread.js";
import type { ThreadRecord, ThreadStore } from "./threadStore.js";
import { threadOpenWarnings, threadResumeMismatchWarnings } from "./threadWarnings.js";
import type {
  AdeProvider,
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
  McpCapabilityReport,
  McpServerConfig,
  ThreadModelSelection,
} from "./types.js";

/**
 * Opening a thread key: resume, recreate or create, and re-binding live
 * threads after an `autoRestart`.
 *
 * Everything here reads the runtime through the context at call time, so the
 * same opener serves every runtime a client reconnects to.
 */

/** Whether an error means "the runtime does not have this session". */
export function isAbsentSessionError(error: unknown): boolean {
  if (!(error instanceof AdeError)) return false;
  if (error.code === "thread_not_found") return true;
  // Timeouts and a closed socket are not "the session is gone": recreating
  // would drop injected MCP under the same key. Only a not-found RPC is a
  // genuine wipe.
  if (error.code !== "rpc_error") return false;
  return /not found/i.test(error.message);
}

/**
 * The provider a resumed thread runs, for attributing an approval request.
 *
 * The runtime's own summary wins over the stored record: a `setModel` in an
 * earlier session may have moved the thread, and the record is only as fresh as
 * the last write. Falls back to Claude when neither is a provider this SDK
 * knows, which is the same closed-union default the rest of the SDK uses.
 */
function resolveThreadProvider(...candidates: Array<string | undefined>): AdeProvider {
  for (const candidate of candidates) {
    if (candidate && isSupportedProvider(candidate)) return candidate;
  }
  return "claude";
}

function isRemoteWithHeaders(server: McpServerConfig | StoredMcpServerConfig): boolean {
  return (
    (server.type === "http" || server.type === "sse") &&
    "headerNames" in server &&
    (server.headerNames?.length ?? 0) > 0
  );
}

/** Whether a stored MCP map has a remote server that needs header values. */
function needsHeaderValues(servers: Record<string, StoredMcpServerConfig> | undefined): boolean {
  return servers ? Object.values(servers).some(isRemoteWithHeaders) : false;
}

/** What the opener reads from the client that owns it. */
export type ThreadOpenerContext = {
  home: string;
  /** The client-wide `instructions` default. */
  defaultInstructions: ThreadInstructions | undefined;
  mcpHeaders: McpHeadersResolver | undefined;
  chats: PersonalChatsApi;
  store: ThreadStore;
  hub: ChatEventSource & { emit(envelope: AgentChatEventEnvelope): void };
  logger: (line: string) => void;
  recordError: (scope: string, error: unknown) => void;
  assertUsable: () => void;
  /** Catalog display names by model id. Never throws. */
  displayNames: () => Promise<Map<string, string>>;
  /** The CURRENT runtime's capabilities, each read at call time. */
  runtime: {
    /** Whether the runtime sent a personal-chat capability block at all. */
    reportsCapabilities(): boolean;
    mcpServers(): boolean;
    updateMcpServers(): boolean;
    pendingInputs(): boolean;
    historyPage(): boolean;
  };
  /**
   * The fingerprint of the MCP servers last sent per key (create, resume
   * refresh, `updateMcpServers`). In memory only; header values never leave
   * the hash.
   */
  mcpPushed: Map<string, string>;
};

type BuildThreadInit = {
  sessionId: string;
  key: string;
  mcpCapability: McpCapabilityReport | null;
  provider: AdeProvider;
  instructionsCapability: InstructionsCapability | null;
  settingSourcesCapability: SettingSourcesCapability | null;
  permissionCapability: PermissionCapability | null;
  /** What the CALLER asked for, not what came back. See `ThreadHostConfig.requestedInstructions`. */
  requestedInstructions: boolean;
  requestedSettingSources: boolean;
  requestedPermissionPolicy: boolean;
  title: string | null;
  model: ThreadModelSelection | null;
  policy: ThreadPermissionPolicy | undefined;
};

export type ThreadOpener = ReturnType<typeof createThreadOpener>;

export function createThreadOpener(ctx: ThreadOpenerContext) {
  const { chats, store, logger, recordError } = ctx;

  /**
   * The one writer for a key's durable record: a title, a refreshed MCP map
   * (header NAMES only — values never reach disk), a model a `setModel` moved
   * it to. Never throws; a failed write is recorded and the thread carries on.
   */
  const persistThread = (key: string) => async (patch: ThreadRecordPatch): Promise<void> => {
    try {
      await store.touch(key, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.provider ? { provider: patch.provider } : {}),
        ...(patch.model ? { model: patch.model } : {}),
        ...(patch.modelId ? { modelId: patch.modelId } : {}),
        ...(patch.mcpServers !== undefined
          ? { mcpServers: toStoredMcpServers(patch.mcpServers), requestedMcp: true }
          : {}),
      });
    } catch (error) {
      recordError("threadStore.touch", error);
    }
  };

  /** The one place a `Thread` is constructed, whichever branch opened it. */
  const buildThread = (init: BuildThreadInit): Thread => {
    const approvalTimeoutMs = readApprovalTimeoutMs(init.policy);
    return new Thread(init.sessionId, init.key, init.mcpCapability, chats, ctx.hub, ctx.assertUsable, {
      provider: init.provider,
      instructionsCapability: init.instructionsCapability,
      settingSourcesCapability: init.settingSourcesCapability,
      permissionCapability: init.permissionCapability,
      requestedInstructions: init.requestedInstructions,
      requestedSettingSources: init.requestedSettingSources,
      requestedPermissionPolicy: init.requestedPermissionPolicy,
      logger,
      title: init.title,
      model: init.model,
      displayNames: ctx.displayNames,
      onRecordChanged: persistThread(init.key),
      emitSynthetic: (envelope) => ctx.hub.emit(envelope),
      ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
      pendingInputsSupported: ctx.runtime.pendingInputs,
      updateMcpServersSupported: ctx.runtime.updateMcpServers,
      historyPageSupported: ctx.runtime.historyPage,
      ...(ctx.mcpHeaders ? { resolveMcpHeaders: ctx.mcpHeaders } : {}),
      mcpPushed: {
        get: () => ctx.mcpPushed.get(init.key),
        set: (fingerprint) => ctx.mcpPushed.set(init.key, fingerprint),
      },
    });
  };

  /**
   * Push fresh MCP servers onto a session that is being resumed.
   *
   * Runs when the caller passed `refresh.mcpServers`, or when the stored
   * servers need header values and an `mcpHeaders` callback can supply them —
   * the runtime does not keep header values across its own restarts either, so
   * a resume that skipped this would reconnect MCP unauthenticated. Skipped
   * when:
   *   - the `mcpHeaders` callback is the only source and supplied no value for
   *     any server that needs one: re-sending would REPLACE whatever
   *     credentials the live session holds with none;
   *   - the resolved map (header values included) is the one this client last
   *     sent for the key: an `updateSession` would restart the provider for
   *     nothing.
   * Never throws: a refresh that fails leaves the thread usable on its old
   * servers, and says so. Returns the runtime's summary after a push, else null.
   */
  const refreshMcpOnResume = async (
    key: string,
    sessionId: string,
    record: ThreadRecord,
    refreshServers: Record<string, McpServerConfig> | undefined,
  ): Promise<AgentChatSessionSummary | null> => {
    const source: Record<string, McpServerConfig | StoredMcpServerConfig> | undefined =
      refreshServers ?? (ctx.mcpHeaders && needsHeaderValues(record.mcpServers) ? record.mcpServers : undefined);
    if (!source) return null;
    const resolved = withResolvedHeaders(key, source, ctx.mcpHeaders);
    if (!refreshServers) {
      const needing = Object.values(source).filter(isRemoteWithHeaders).length;
      if (resolved.missing.length >= needing) {
        logger(
          `ade sdk: thread "${key}" did not re-send its MCP servers: the mcpHeaders callback supplied no header ` +
            `values for ${resolved.missing.map((entry) => entry.server).join(", ")}, and re-sending would replace ` +
            `the session's current credentials with none`,
        );
        return null;
      }
    }
    const warning = missingHeadersWarning(key, resolved.missing);
    if (warning) logger(warning);
    if (!ctx.runtime.updateMcpServers()) {
      logger(
        `ade sdk: thread "${key}" could not refresh its MCP servers: this runtime does not advertise ` +
          `capabilities.personalChats.updateMcpServers, so it keeps the servers it already has`,
      );
      return null;
    }
    const fingerprint = mcpServersFingerprint(resolved.servers);
    if (ctx.mcpPushed.get(key) === fingerprint) return null;
    try {
      const updated = await chats.updateSession({ sessionId, mcpServers: resolved.servers });
      ctx.mcpPushed.set(key, fingerprint);
      await persistThread(key)({ mcpServers: resolved.servers });
      return updated;
    } catch (error) {
      recordError(`refresh mcpServers for "${key}"`, error);
      return null;
    }
  };

  /** Resume a record whose session the runtime still has. */
  const resumeThread = async (
    key: string,
    record: ThreadRecord,
    summary: AgentChatSessionSummary,
    opts: ThreadResumeOptions,
    comparison: { supplied: Record<string, unknown>; stored: Record<string, unknown> },
  ): Promise<Thread> => {
    await persistThread(key)({ title: summary.title ?? record.title ?? null });
    // A capability report is only meaningful for a thread that asked for one.
    // If this thread is on record as having requested nothing, ignore whatever
    // the runtime volunteered: a runtime that ever defaults a stub onto every
    // summary would otherwise invert the documented meaning of
    // `mcpCapability === null` for every chat at once. Records with no stored
    // answer (legacy, or created outside the SDK) trust the runtime.
    //
    // A refresh that pushed servers is itself an MCP request, so its report is
    // always read.
    const refreshed = await refreshMcpOnResume(key, summary.sessionId, record, opts.refresh?.mcpServers);
    const resumedCapability = refreshed
      ? normalizeMcpCapability(refreshed.mcpCapability)
      : record.requestedMcp === false
        ? null
        : normalizeMcpCapability(summary.mcpCapability);
    // The host-config reports come off the RECORD, not off `opts`. A resume
    // re-applies what the thread was created with and ignores new options, so
    // reading "was instructions requested?" from this call's arguments would
    // report a capability for a request this session never made.
    //
    // That rule is quiet, and quiet is the problem: a caller who passes a new
    // `cwd` and a new policy believes the agent is confined to both. Say so
    // once, per resume, for every option that actually differs.
    for (const line of threadResumeMismatchWarnings({ key, ...comparison })) logger(line);
    const names = await ctx.displayNames();
    return buildThread({
      sessionId: summary.sessionId,
      key,
      mcpCapability: resumedCapability,
      provider: resolveThreadProvider(summary.provider, record.provider),
      instructionsCapability: normalizeInstructionsCapability(
        summary.instructionsCapability,
        record.instructions !== undefined,
      ),
      settingSourcesCapability: normalizeSettingSourcesCapability(
        summary.settingSourcesCapability,
        record.settingSources !== undefined,
      ),
      permissionCapability: normalizePermissionCapability(
        summary.permissionCapability,
        record.permissionPolicy !== undefined,
      ),
      requestedInstructions: record.instructions !== undefined,
      requestedSettingSources: record.settingSources !== undefined,
      requestedPermissionPolicy: record.permissionPolicy !== undefined,
      title: summary.title ?? record.title ?? null,
      model: modelSelectionOf(summary, names, {
        provider: record.provider,
        model: record.model,
        ...(record.modelId ? { modelId: record.modelId } : {}),
      }),
      policy: record.permissionPolicy,
    });
  };

  /**
   * Open a key without touching the client's live-thread map: resume the
   * session its record points at, recreate it from the record when the runtime
   * lost it, or create it from `opts` when the key is new.
   */
  const open = async (key: string, opts: ThreadResumeOptions): Promise<Thread> => {
    // Provider/model are validated at the CREATE branch below, not here: a
    // durable key already recorded both, so reopening `"support"` after a
    // restart must not force the caller to remember how it was created.
    const record = await store.get(key);
    const supplied = {
      // Canonicalized, not merely resolved: the stored value is the engine's
      // canonical spelling, so a plain `path.resolve` compares two names for
      // one directory and reports a caller's own unchanged `cwd` as ignored.
      ...(opts.cwd !== undefined ? { cwd: canonicalThreadCwd(opts.cwd) } : {}),
      ...(opts.instructions !== undefined ? { instructions: normalizeInstructions(opts.instructions) } : {}),
      ...(opts.settingSources !== undefined ? { settingSources: opts.settingSources } : {}),
      ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
      // Compared in the stored form. The record keeps header NAMES, so a map
      // passed with its bearer token would otherwise never equal the record
      // and every resume would report the servers as ignored. A caller who is
      // replacing them passes `refresh`, which is not compared at all.
      ...(opts.mcpServers !== undefined && opts.refresh?.mcpServers === undefined
        ? { mcpServers: toStoredMcpServers(opts.mcpServers) }
        : {}),
      ...(opts.loadUserMcpServers !== undefined ? { loadUserMcpServers: opts.loadUserMcpServers } : {}),
    };

    if (record) {
      const stored = {
        ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
        ...(record.instructions !== undefined ? { instructions: record.instructions } : {}),
        ...(record.settingSources !== undefined ? { settingSources: record.settingSources } : {}),
        ...(record.permissionPolicy !== undefined ? { permissionPolicy: record.permissionPolicy } : {}),
        ...(record.permissionPreset !== undefined ? { permissionPreset: record.permissionPreset } : {}),
        ...(record.mcpServers !== undefined ? { mcpServers: record.mcpServers } : {}),
        ...(record.loadUserMcpServers !== undefined ? { loadUserMcpServers: record.loadUserMcpServers } : {}),
      };
      // Resume: the mapping is only trustworthy if the runtime still has the
      // session. A home copied between machines, a deleted chat, or a wiped
      // state root all leave a dangling key — recreate rather than fail.
      let summary: AgentChatSessionSummary | null = null;
      try {
        summary = await chats.getSummary(record.sessionId);
      } catch (error) {
        if (!isAbsentSessionError(error)) throw error;
        recordError("getSummary", error);
      }
      if (summary?.sessionId) return resumeThread(key, record, summary, opts, { supplied, stored });
      logger(`ade sdk: thread "${key}" pointed at a session the runtime no longer has; creating a new one`);
      // The record stays until the create below succeeds and `store.put`
      // replaces it: a create that fails must not lose the key's
      // configuration, or the next open would rebuild it from whatever the
      // caller happens to pass.
      //
      // The same stored-wins rule as a resume, so the same honesty about the
      // options it overrode.
      for (const line of threadResumeMismatchWarnings({ key, verb: "recreated", supplied, stored })) logger(line);
    }
    return createThread(key, opts, record);
  };

  const createThread = async (key: string, opts: ThreadResumeOptions, record: ThreadRecord | null): Promise<Thread> => {
    // A RECREATE (the key has a record, the runtime lost its session) rebuilds
    // the thread the record describes. The stored value wins for every field
    // that shapes what the agent can do; the call's options only fill a field
    // the record lacks. The call's options winning was the 0.2 rule, and it let
    // any caller able to name a key — a renderer over the Electron bridge —
    // rebuild a lost thread on another provider, under a looser policy, or with
    // no MCP servers at all. For a brand-new key there is no record and the
    // call's options are all there is.
    const provider = (record?.provider || opts.provider) as AdeProvider | undefined;
    const model = record?.modelId || record?.model || opts.model;
    if (!provider || !isSupportedProvider(provider)) {
      throw new AdeError(
        "invalid_option",
        record
          ? `The stored thread "${key}" names an unsupported provider (${String(provider)}).`
          : `Opening the new thread "${key}" needs a provider. Pass { provider, model }.`,
      );
    }
    if (!model?.trim()) {
      throw new AdeError("invalid_option", `Opening the new thread "${key}" needs a model id. Pass { provider, model }.`);
    }

    // Host configuration: the record, then this call's options, then the
    // client-wide default.
    const instructions =
      record?.instructions ?? normalizeInstructions(opts.instructions) ?? normalizeInstructions(ctx.defaultInstructions);
    const cwd = record?.cwd ?? (opts.cwd !== undefined ? validateThreadCwd(opts.cwd, ctx.home) : undefined);
    const settingSources = record?.settingSources ?? normalizeSettingSources(opts.settingSources);
    // The stored policy, then the stored preset (0.3+ records), then the call.
    // A pre-0.3 record has neither and keeps the older rule.
    const permissions: PermissionPreset | ThreadPermissionPolicy =
      record?.permissionPolicy ?? record?.permissionPreset ?? opts.permissions ?? "default";
    const permissionPolicy = isPermissionPolicy(permissions) ? permissions : undefined;
    const permissionPreset = isPermissionPolicy(permissions) ? undefined : permissions;
    // Validated here so a bad value fails the open, not a timer later.
    readApprovalTimeoutMs(permissionPolicy);

    // `refresh.mcpServers` is the one field that replaces the record; the
    // record's servers carry header NAMES only, so their values come from the
    // `mcpHeaders` callback.
    const suppliedMcp =
      opts.mcpServers !== undefined && Object.keys(opts.mcpServers).length > 0 ? opts.mcpServers : undefined;
    const mcpSource: Record<string, McpServerConfig | StoredMcpServerConfig> | undefined =
      opts.refresh?.mcpServers ??
      (record?.mcpServers && Object.keys(record.mcpServers).length > 0 ? record.mcpServers : undefined) ??
      suppliedMcp;
    const resolvedMcp = mcpSource ? withResolvedHeaders(key, mcpSource, ctx.mcpHeaders) : undefined;
    const headersWarning = resolvedMcp ? missingHeadersWarning(key, resolvedMcp.missing) : null;
    if (headersWarning) logger(headersWarning);
    const mcpServers = resolvedMcp?.servers;
    const loadUserMcpServers =
      record?.loadUserMcpServers !== undefined ? record.loadUserMcpServers : opts.loadUserMcpServers;

    // Two distinct questions, and conflating them is a bug: "did the caller
    // supply servers" gates the drop warning, while "did the caller make any
    // MCP request at all" (servers OR strict mode) gates the capability
    // bookkeeping. A strict-only request supplies no servers but is still a
    // request, and it succeeds.
    const suppliedServers = mcpServers !== undefined && Object.keys(mcpServers).length > 0;
    const askedForMcp = suppliedServers || loadUserMcpServers !== undefined;

    if (suppliedServers && !ctx.runtime.mcpServers() && ctx.runtime.reportsCapabilities()) {
      // Never silently drop MCP config: an app that asked for a tool server and
      // did not get one behaves wrongly rather than visibly failing.
      throw new AdeError(
        "invalid_option",
        "This ADE runtime does not support per-thread MCP servers (capabilities.personalChats.mcpServers is not set). Upgrade the runtime or drop `mcpServers`.",
      );
    }

    const title = opts.title ?? record?.title ?? undefined;
    // An engine refusal of an argument (`invalid_argument:`) arrives as
    // `invalid_option`; `PersonalChatsApi.call` translates it.
    const created = await chats.create({
      provider,
      model,
      ...(title ? { title } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      // A policy sends `permissionMode: "default"` plus the policy itself, so a
      // runtime that does not understand `permissionPolicy` behaves like
      // today's `"default"` rather than like `always-allow`. Degrading toward
      // more prompting is the only safe direction for a permission surface.
      // `approvalTimeoutMs` never reaches the wire: the normalizer drops every
      // field the engine does not define, and the SDK enforces that one itself.
      ...resolvePermissionArgs(provider, permissions),
      ...(instructions ? { instructions } : {}),
      // `requestedCwd` is the field name the engine has always used for this.
      ...(cwd ? { requestedCwd: cwd } : {}),
      ...(settingSources ? { settingSources } : {}),
      // `suppliedServers`, NOT truthiness. `mcpServers: {}` is an empty object,
      // which is truthy — so a bare `opts.mcpServers` check made an empty map
      // send servers on the wire AND turn strict mode on, while every local
      // decision (the drop warning, `requestedMcp` on the durable record) read
      // it as "nothing supplied".
      ...(suppliedServers ? { mcpServers } : {}),
      // `strictMcpConfig` is the wire spelling of "do not load the user's own
      // MCP config", and it is a TRISTATE: absent lets the session profile
      // decide (strict, for the profile SDK threads run), true withholds, and
      // an explicit false overrides the profile to load it. So a caller that
      // asked for the user's servers must send `false` rather than omit the
      // key — omitting it would silently give them the opposite.
      //
      // Gated on the same `askedForMcp` the bookkeeping below uses: one
      // question, one answer, so the wire and the record can never disagree.
      ...(askedForMcp ? { strictMcpConfig: loadUserMcpServers !== true } : {}),
    });
    if (!created?.sessionId) {
      throw new AdeError("protocol_error", "The ADE runtime created a chat with no session id.");
    }
    if (suppliedServers && mcpServers) ctx.mcpPushed.set(key, mcpServersFingerprint(mcpServers));
    else ctx.mcpPushed.delete(key);

    // The CANONICAL path, as the runtime echoes it on the create summary, not
    // the caller's spelling. The engine resolves the path before it binds the
    // session, so one directory reached through a symlink or in another case
    // comes back as one string. Recording the caller's spelling made a later
    // `open()` with the runtime's own spelling of the SAME directory log a
    // resume mismatch on a `cwd` nothing had changed. Falls back to the
    // resolved path on a runtime that echoes nothing.
    const recordedCwd = cwd
      ? typeof created.requestedCwd === "string" && created.requestedCwd
        ? created.requestedCwd
        : cwd
      : undefined;

    const now = new Date().toISOString();
    await store.put({
      key,
      sessionId: created.sessionId,
      provider,
      model,
      ...(typeof created.modelId === "string" && created.modelId ? { modelId: created.modelId } : {}),
      createdAt: record?.createdAt ?? now,
      lastOpenedAt: now,
      title: created.title ?? title ?? null,
      requestedMcp: askedForMcp,
      // Header NAMES only. The values went on the wire above and nowhere else.
      ...(suppliedServers && mcpServers ? { mcpServers: toStoredMcpServers(mcpServers) } : {}),
      ...(loadUserMcpServers !== undefined ? { loadUserMcpServers } : {}),
      ...(instructions ? { instructions } : {}),
      ...(recordedCwd ? { cwd: recordedCwd } : {}),
      ...(settingSources ? { settingSources } : {}),
      ...(permissionPolicy ? { permissionPolicy } : {}),
      ...(permissionPreset ? { permissionPreset } : {}),
    });
    const capability = normalizeMcpCapability(created.mcpCapability);
    const instructionsCapability = normalizeInstructionsCapability(
      created.instructionsCapability,
      instructions !== undefined,
    );
    const settingSourcesCapability = normalizeSettingSourcesCapability(
      created.settingSourcesCapability,
      settingSources !== undefined,
    );
    const permissionCapability = normalizePermissionCapability(
      created.permissionCapability,
      permissionPolicy !== undefined,
    );
    // Every honesty rule for a freshly opened thread lives in one pure
    // function, unit-tested directly. See `threadWarnings.ts`.
    for (const line of threadOpenWarnings({
      key,
      suppliedServers,
      mcpServers,
      loadUserMcpServers,
      instructions,
      settingSources,
      permissionPolicy,
      mcpCapability: capability,
      instructionsCapability,
      settingSourcesCapability,
      permissionCapability,
    })) {
      logger(line);
    }

    const names = await ctx.displayNames();
    return buildThread({
      sessionId: created.sessionId,
      key,
      mcpCapability: capability,
      provider,
      instructionsCapability,
      settingSourcesCapability,
      permissionCapability,
      requestedInstructions: instructions !== undefined,
      requestedSettingSources: settingSources !== undefined,
      requestedPermissionPolicy: permissionPolicy !== undefined,
      title: created.title ?? title ?? null,
      model: modelSelectionOf(created, names, { provider, model }),
      policy: permissionPolicy,
    });
  };

  /**
   * Re-bind every live thread to a runtime an `autoRestart` reconnected.
   *
   * A session the new runtime still has keeps its thread object untouched,
   * with fresh MCP header values pushed when the record needs them. A session
   * it lost is recreated from the record — stored provider, model, policy or
   * preset, host config and servers — and the old object ADOPTS the new
   * session, because a host and a bridge both hold that object.
   */
  const rebindLiveThreads = async (liveSessions: ReadonlyMap<string, Thread>): Promise<void> => {
    // The new runtime holds no header values, so nothing it has was "already
    // sent" by this client.
    ctx.mcpPushed.clear();
    for (const [key, thread] of [...liveSessions]) {
      try {
        const record = await store.get(key);
        let summary: AgentChatSessionSummary | null = null;
        try {
          summary = await chats.getSummary(thread.id);
        } catch (error) {
          if (!isAbsentSessionError(error)) throw error;
        }
        if (summary?.sessionId) {
          if (record) {
            const refreshed = await refreshMcpOnResume(key, thread.id, record, undefined);
            if (refreshed) thread.setMcpCapability(normalizeMcpCapability(refreshed.mcpCapability));
          }
          continue;
        }
        if (!record) continue;
        thread.adoptSession(await open(key, {}));
      } catch (error) {
        recordError(`restart reopen "${key}"`, error);
      }
    }
  };

  return { open, rebindLiveThreads };
}
