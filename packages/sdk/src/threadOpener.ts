import type { CreateAdeChatOptions, ThreadResumeOptions } from "./clientOptions.js";
import { AdeError } from "./errors.js";
import type { ChatEventSource } from "./eventStream.js";
import {
  canonicalThreadCwd,
  normalizeInstructions,
  normalizeInstructionsCapability,
  normalizePermissionCapability,
  normalizeSettingSources,
  normalizeSettingSourcesCapability,
  validateAttachmentRoots,
  validateThreadCwd,
  type InstructionsCapability,
  type PermissionCapability,
  type SettingSourcesCapability,
  type ThreadInstructions,
} from "./hostConfig.js";
import { normalizeMcpCapability } from "./mcpCapability.js";
import {
  hasMcpToolFilters,
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
  readApprovalTimeoutMs,
  resolvePermissionArgs,
  type PermissionPreset,
  type ThreadPermissionPolicy,
} from "./permissions.js";
import type { PersonalChatsApi } from "./personalChats.js";
import { Thread, type ThreadRecordPatch } from "./thread.js";
import type { ThreadRecord, ThreadStore } from "./threadStore.js";
import { validateThreadBudget, type ThreadBudget } from "./usage.js";
import { sameJson, threadOpenWarnings, threadResumeMismatchWarnings } from "./threadWarnings.js";
import type {
  AdeProvider,
  ProviderCapabilities,
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

/** `opts` with `attachmentRoots` and `refresh.attachmentRoots` validated and canonicalized. */
function withValidatedAttachmentRoots(opts: ThreadResumeOptions, home: string): ThreadResumeOptions {
  if (opts.attachmentRoots === undefined && opts.refresh?.attachmentRoots === undefined) return opts;
  return {
    ...opts,
    ...(opts.attachmentRoots !== undefined
      ? { attachmentRoots: validateAttachmentRoots(opts.attachmentRoots, home) }
      : {}),
    ...(opts.refresh?.attachmentRoots !== undefined
      ? { refresh: { ...opts.refresh, attachmentRoots: validateAttachmentRoots(opts.refresh.attachmentRoots, home) } }
      : {}),
  };
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
    if (candidate?.trim()) return candidate as AdeProvider;
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
  resolveSecret: CreateAdeChatOptions["resolveSecret"] | undefined;
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
    /** Whether the runtime enforces or refuses per-server tool filters (rather than dropping them). */
    mcpToolFilters(): boolean;
    pendingInputs(): boolean;
    historyPage(): boolean;
    rerunLastTurn(): boolean;
    actionListed(action: string): boolean;
    providerListed(provider: string): Promise<boolean>;
    providerCapabilities(provider: string): Promise<ProviderCapabilities | undefined>;
  };
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
  budget?: ThreadBudget;
};

export type ThreadOpener = ReturnType<typeof createThreadOpener>;

export function createThreadOpener(ctx: ThreadOpenerContext) {
  const { chats, store, logger, recordError } = ctx;

  /**
   * The fingerprint of the MCP servers last sent per key (create, resume
   * refresh, `updateMcpServers`). In memory only; header values never leave
   * the hash.
   */
  const mcpPushed = new Map<string, string>();

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
        ...(patch.attachmentRoots !== undefined ? { attachmentRoots: patch.attachmentRoots } : {}),
      });
    } catch (error) {
      recordError("threadStore.touch", error);
    }
  };

  const pushResolvedSecret = async (sessionId: string, provider: string, credentialId: string | undefined): Promise<void> => {
    if (!credentialId || !ctx.resolveSecret) return;
    const secret = await ctx.resolveSecret(provider as AdeProvider, credentialId);
    if (!secret) {
      throw new AdeError("invalid_option", `No host-vault secret was returned for credential "${credentialId}".`);
    }
    // The secret travels to the runtime only for this session. ThreadStore
    // persists the credential id, never the value.
    await chats.updateSession({ sessionId, credentialId, credentialSecret: secret });
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
      ...(init.budget ? { budget: init.budget } : {}),
      logger,
      title: init.title,
      model: init.model,
      displayNames: ctx.displayNames,
      onRecordChanged: persistThread(init.key),
      emitSynthetic: (envelope) => ctx.hub.emit(envelope),
      ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
      pendingInputsSupported: ctx.runtime.pendingInputs,
      actionListed: ctx.runtime.actionListed,
      updateMcpServersSupported: ctx.runtime.updateMcpServers,
      mcpToolFiltersSupported: ctx.runtime.mcpToolFilters,
      storedMcpServers: async () => (await store.get(init.key))?.mcpServers,
      historyPageSupported: ctx.runtime.historyPage,
      rerunLastTurnSupported: ctx.runtime.rerunLastTurn,
      ...(ctx.mcpHeaders ? { resolveMcpHeaders: ctx.mcpHeaders } : {}),
      mcpPushed: {
        get: () => mcpPushed.get(init.key),
        set: (fingerprint) => mcpPushed.set(init.key, fingerprint),
      },
    });
  };

  /**
   * Replace a session's attachment roots with `refresh.attachmentRoots`
   * (already validated). Skipped when they equal the record's. A runtime
   * refusal is thrown, not logged: the caller asked for new read roots (or for
   * none), and an open that returned while the old roots stayed would let it
   * believe a folder was added or removed when it was not.
   */
  const applyAttachmentRoots = async (
    key: string,
    sessionId: string,
    recorded: string[] | undefined,
    roots: string[] | undefined,
  ): Promise<void> => {
    if (roots === undefined || sameJson(roots, recorded ?? [])) return;
    await chats.updateSession({ sessionId, attachmentRoots: roots });
    await persistThread(key)({ attachmentRoots: roots });
  };

  /**
   * `refresh.attachmentRoots` for a thread the client already holds live: the
   * one `open` option that still applies to it. Validates first, so a bad root
   * changes nothing.
   */
  const refreshLiveAttachmentRoots = async (key: string, sessionId: string, rawRoots: string[]): Promise<void> => {
    const roots = validateAttachmentRoots(rawRoots, ctx.home);
    const record = await store.get(key);
    await applyAttachmentRoots(key, sessionId, record?.attachmentRoots, roots);
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
    let resolved: Awaited<ReturnType<typeof withResolvedHeaders>>;
    try {
      resolved = await withResolvedHeaders(key, source, ctx.mcpHeaders);
    } catch (error) {
      // The callback threw (a token refresh that failed). Same rule as a
      // refused push: the thread opens on the servers it already has.
      recordError(`resolve mcpHeaders for "${key}"`, error);
      return null;
    }
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
    if (hasMcpToolFilters(resolved.servers) && !ctx.runtime.mcpToolFilters()) {
      logger(
        `ade sdk: thread "${key}" could not refresh its MCP servers: they carry allowedTools / disallowedTools ` +
          `and this runtime does not advertise capabilities.personalChats.mcpToolFilters, so it would drop them`,
      );
      return null;
    }
    const fingerprint = mcpServersFingerprint(resolved.servers);
    if (mcpPushed.get(key) === fingerprint) return null;
    try {
      const updated = await chats.updateSession({ sessionId, mcpServers: resolved.servers });
      mcpPushed.set(key, fingerprint);
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
    const budget = validateThreadBudget(record.budget ?? opts.budget);
    if (!record.budget && budget) await persistThread(key)({ budget });
    else if (record.budget && opts.budget && !sameJson(record.budget, opts.budget)) {
      logger(`ade sdk: thread "${key}" ignored a different budget on resume; the stored budget remains in force`);
    }
    await pushResolvedSecret(summary.sessionId, record.provider || summary.provider, record.credentialId);
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
    // Roots first, as on a live thread: a refused root fails the open before
    // the MCP servers change.
    await applyAttachmentRoots(key, summary.sessionId, record.attachmentRoots, opts.refresh?.attachmentRoots);
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
      ...(budget ? { budget } : {}),
    });
  };

  /**
   * Open a key without touching the client's live-thread map: resume the
   * session its record points at, recreate it from the record when the runtime
   * lost it, or create it from `opts` when the key is new.
   */
  const open = async (key: string, rawOpts: ThreadResumeOptions): Promise<Thread> => {
    // Validated once, before anything reaches the runtime: a bad root must
    // refuse the open before a resume pushes MCP servers or a create starts.
    const opts = {
      ...withValidatedAttachmentRoots(rawOpts, ctx.home),
      budget: validateThreadBudget(rawOpts.budget),
    };
    // Provider/model are validated at the CREATE branch below, not here: a
    // durable key already recorded both, so reopening `"support"` after a
    // restart must not force the caller to remember how it was created.
    const record = await store.get(key);
    const supplied = {
      // Canonicalized, not merely resolved: the stored value is the engine's
      // canonical spelling, so a plain `path.resolve` compares two names for
      // one directory and reports a caller's own unchanged `cwd` as ignored.
      ...(opts.cwd !== undefined ? { cwd: canonicalThreadCwd(opts.cwd) } : {}),
      ...(opts.attachmentRoots !== undefined && opts.refresh?.attachmentRoots === undefined
        ? { attachmentRoots: opts.attachmentRoots }
        : {}),
      ...(opts.instructions !== undefined ? { instructions: normalizeInstructions(opts.instructions) } : {}),
      ...(opts.settingSources !== undefined ? { settingSources: opts.settingSources } : {}),
      ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
      ...(opts.account !== undefined ? { account: opts.account } : {}),
      ...(opts.credential !== undefined ? { credential: opts.credential } : {}),
      ...(opts.preset !== undefined ? { preset: opts.preset } : {}),
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
        ...(record.attachmentRoots !== undefined ? { attachmentRoots: record.attachmentRoots } : {}),
        ...(record.instructions !== undefined ? { instructions: record.instructions } : {}),
        ...(record.settingSources !== undefined ? { settingSources: record.settingSources } : {}),
        ...(record.permissionPolicy !== undefined ? { permissionPolicy: record.permissionPolicy } : {}),
        ...(record.permissionPreset !== undefined ? { permissionPreset: record.permissionPreset } : {}),
        ...(record.permissionMode !== undefined ? { permissionMode: record.permissionMode } : {}),
        ...(record.reasoningEffort !== undefined ? { reasoningEffort: record.reasoningEffort } : {}),
        ...(record.fastMode !== undefined ? { fastMode: record.fastMode } : {}),
        ...(record.instanceId !== undefined ? { instanceId: record.instanceId } : {}),
        ...(record.credentialId !== undefined ? { credentialId: record.credentialId } : {}),
        ...(record.presetId !== undefined ? { presetId: record.presetId } : {}),
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
    if (!provider?.trim()) {
      throw new AdeError(
        "invalid_option",
        `Opening the new thread "${key}" needs a provider. Pass { provider, model }.`,
      );
    }
    if (!model?.trim()) {
      throw new AdeError("invalid_option", `Opening the new thread "${key}" needs a model id. Pass { provider, model }.`);
    }
    if (!(await ctx.runtime.providerListed(provider))) {
      throw new AdeError("invalid_option", `Provider "${provider}" is not listed by this ADE runtime's model catalog.`);
    }

    const permissionMode = record?.permissionMode ?? opts.permissionMode;
    const reasoningEffort = record?.reasoningEffort ?? opts.reasoningEffort;
    const fastMode = record?.fastMode ?? opts.fastMode;
    const instanceId = record?.instanceId ?? opts.account;
    const credentialId = record?.credentialId ?? opts.credential;
    const presetId = record?.presetId ?? opts.preset;
    const providerCapabilities = await ctx.runtime.providerCapabilities(provider);
    if (providerCapabilities) {
      if (permissionMode !== undefined && !providerCapabilities.permissionModes.includes(permissionMode)) {
        throw new AdeError("invalid_option", `Provider "${provider}" does not support permission mode "${permissionMode}".`);
      }
      if (reasoningEffort !== undefined && !providerCapabilities.reasoningEfforts.includes(reasoningEffort)) {
        throw new AdeError("invalid_option", `Provider "${provider}" does not support reasoning effort "${reasoningEffort}".`);
      }
      if (fastMode === true && !providerCapabilities.fastMode) {
        throw new AdeError("invalid_option", `Provider "${provider}" does not support fast mode.`);
      }
      if (instanceId !== undefined && !providerCapabilities.multipleAccounts) {
        throw new AdeError("invalid_option", `Provider "${provider}" does not support multiple accounts.`);
      }
      if (credentialId !== undefined && !providerCapabilities.apiKeys) {
        throw new AdeError("invalid_option", `Provider "${provider}" cannot use stored API credentials.`);
      }
      if (presetId !== undefined && !providerCapabilities.presets) {
        throw new AdeError("invalid_option", `Provider "${provider}" cannot use harness presets.`);
      }
    }
    const credentialSecret = credentialId && ctx.resolveSecret
      ? await ctx.resolveSecret(provider, credentialId)
      : undefined;
    if (credentialId && ctx.resolveSecret && !credentialSecret) {
      throw new AdeError("invalid_option", `No host-vault secret was returned for credential "${credentialId}".`);
    }

    // Host configuration: the record, then this call's options, then the
    // client-wide default.
    const instructions =
      record?.instructions ?? normalizeInstructions(opts.instructions) ?? normalizeInstructions(ctx.defaultInstructions);
    const cwd = record?.cwd ?? (opts.cwd !== undefined ? validateThreadCwd(opts.cwd, ctx.home) : undefined);
    // `refresh` replaces the record's roots, as it does the MCP servers.
    const attachmentRoots = opts.refresh?.attachmentRoots ?? record?.attachmentRoots ?? opts.attachmentRoots;
    const settingSources = record?.settingSources ?? normalizeSettingSources(opts.settingSources);
    // The stored policy, then the stored preset (0.3+ records), then the call.
    // A pre-0.3 record has neither and keeps the older rule.
    const permissions: PermissionPreset | ThreadPermissionPolicy =
      record?.permissionPolicy ?? record?.permissionPreset ?? opts.permissions ?? "default";
    const permissionPolicy = isPermissionPolicy(permissions) ? permissions : undefined;
    const permissionPreset = isPermissionPolicy(permissions) ? undefined : permissions;
    // Validated here so a bad value fails the open, not a timer later.
    readApprovalTimeoutMs(permissionPolicy);
    const budget = validateThreadBudget(record?.budget ?? opts.budget);

    // `refresh.mcpServers` is the one field that replaces the record; the
    // record's servers carry header NAMES only, so their values come from the
    // `mcpHeaders` callback.
    const suppliedMcp =
      opts.mcpServers !== undefined && Object.keys(opts.mcpServers).length > 0 ? opts.mcpServers : undefined;
    const mcpSource: Record<string, McpServerConfig | StoredMcpServerConfig> | undefined =
      opts.refresh?.mcpServers ??
      (record?.mcpServers && Object.keys(record.mcpServers).length > 0 ? record.mcpServers : undefined) ??
      suppliedMcp;
    const resolvedMcp = mcpSource ? await withResolvedHeaders(key, mcpSource, ctx.mcpHeaders) : undefined;
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
    if (suppliedServers && hasMcpToolFilters(mcpServers) && !ctx.runtime.mcpToolFilters()) {
      // The same rule one level down: an older runtime drops the filter
      // fields, which would hand the agent the very tools the host hid.
      throw new AdeError(
        "invalid_option",
        "This ADE runtime does not support MCP tool filters (capabilities.personalChats.mcpToolFilters is not set). Upgrade the runtime or drop `allowedTools` / `disallowedTools`.",
      );
    }

    const title = opts.title ?? record?.title ?? undefined;
    // An engine refusal of an argument (`invalid_argument:`) arrives as
    // `invalid_option`; `PersonalChatsApi.call` translates it.
    const created = await chats.create({
      provider,
      model,
      ...(title ? { title } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      // A policy sends `permissionMode: "default"` plus the policy itself, so a
      // runtime that does not understand `permissionPolicy` behaves like
      // today's `"default"` rather than like `always-allow`. Degrading toward
      // more prompting is the only safe direction for a permission surface.
      // `approvalTimeoutMs` never reaches the wire: the normalizer drops every
      // field the engine does not define, and the SDK enforces that one itself.
      ...resolvePermissionArgs(provider, permissions),
      ...(permissionMode ? { permissionMode } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      ...(instanceId ? { instanceId } : {}),
      ...(credentialId ? { credentialId } : {}),
      ...(presetId ? { presetId } : {}),
      ...(credentialSecret ? { credentialSecret } : {}),
      ...(instructions ? { instructions } : {}),
      // `requestedCwd` is the field name the engine has always used for this.
      ...(cwd ? { requestedCwd: cwd } : {}),
      ...(attachmentRoots?.length ? { attachmentRoots } : {}),
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
    if (suppliedServers && mcpServers) mcpPushed.set(key, mcpServersFingerprint(mcpServers));
    else mcpPushed.delete(key);

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
      ...(attachmentRoots?.length ? { attachmentRoots } : {}),
      ...(settingSources ? { settingSources } : {}),
      ...(permissionPolicy ? { permissionPolicy } : {}),
      ...(permissionPreset ? { permissionPreset } : {}),
      ...(budget ? { budget } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      ...(instanceId ? { instanceId } : {}),
      ...(credentialId ? { credentialId } : {}),
      ...(presetId ? { presetId } : {}),
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
      ...(budget ? { budget } : {}),
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
    mcpPushed.clear();
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
            await pushResolvedSecret(thread.id, record.provider || summary.provider, record.credentialId);
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

  return { open, rebindLiveThreads, refreshLiveAttachmentRoots };
}
