/**
 * Adapter from an `@ade-dev/sdk` client to the `AdeChatClient` this package renders.
 *
 * WHY THIS EXISTS. The two packages were designed against each other but do not
 * meet structurally, and every difference is deliberate on both sides:
 *
 *   | concern            | `@ade-dev/sdk`                        | `@ade-dev/chat-ui`               |
 *   |--------------------|-----------------------------------|------------------------------|
 *   | provider statuses  | `Record<string, …>` keyed by id    | an array of `{ id, … }`      |
 *   | provider fields    | `available` / `requiresConfiguration` | `installed` / `loginCommand` |
 *   | model rows         | `{ provider, isAvailable }`        | `{ providerId, available }`  |
 *   | open options       | `{ provider, model }`              | `{ providerId, modelId }`    |
 *   | `send`             | `(text, { attachments })`          | `(SendInput \| string)`      |
 *   | `on("status")`     | a raw event envelope               | `{ state, turnId, message }` |
 *   | `on("usage")`      | a raw event envelope               | `{ inputTokens, … }`         |
 *
 * The SDK is envelope-faithful on purpose (it must not lose fields it does not
 * understand) and this package is view-shaped on purpose (it renders a state,
 * not a stream). Without this function every embedder writes the same ~150
 * lines of glue, and each one gets the tool-status and token mapping subtly
 * different. It lives here rather than in `@ade-dev/sdk` because it produces THIS
 * package's contract and must stay browser-safe. The SDK is imported for its
 * TYPES only, so it contributes nothing to the bundle and stays an optional
 * peer: an app that proxies its SDK client over IPC or a socket can adapt the
 * proxy just as well as the real object.
 *
 *   import { adaptSdkClient } from "@ade-dev/chat-ui";
 *
 *   const client = adaptSdkClient(sdkClient, {
 *     defaults: { provider: "claude", model: "anthropic/claude-haiku-4-5" },
 *   });
 */

import type {
  AdeThread as SdkThread,
  AgentChatFileRef,
  ModelCatalogEntry,
  ProviderStatus as SdkProviderStatus,
} from "@ade-dev/sdk";
import type {
  AdeChatClient,
  AdeThread,
  AgentChatEventEnvelope,
  ApprovalDecision,
  ApprovalRequest,
  ChatAttachment,
  HistoryPage,
  HistoryPageRequest,
  ModelDescriptor,
  ProviderStatus,
  SendInput,
  ThreadModelInfo,
  ThreadOpenOptions,
  ThreadStatus,
  ThreadUsage,
  Unsubscribe,
} from "../sdkTypes";

/* -------------------------------------------------------------------------- */
/* The shape this adapter consumes                                             */
/* -------------------------------------------------------------------------- */

/**
 * The `@ade-dev/sdk` surface this adapter drives.
 *
 * Every type below is derived from the SDK's own declarations rather than
 * restated, so a rename or a signature change over there is a compile error
 * here instead of a silent mismatch at runtime. `@ade-dev/sdk` is an OPTIONAL peer
 * and this is a type-only import, so nothing is added to the runtime bundle and
 * a host that never installs the SDK is unaffected.
 *
 * The relaxations are deliberate and are documented where they appear: a remote
 * proxy (WebSocket, Electron IPC, a test double) has to satisfy these without
 * implementing the parts of the SDK this package never touches.
 */
export type { SdkProviderStatus };

/**
 * A provider status record as this adapter reads one.
 *
 * The catalog half is picked from the SDK's own type, so a rename over there is
 * a compile error here. The probe half is restated as OPTIONAL, and that is the
 * whole point: `@ade-dev/sdk` 0.2 always fills those fields (deriving them when
 * the runtime cannot probe), but a 0.1 client, a WebSocket proxy, or a test
 * double sends a record without them. Requiring them would reject clients that
 * work perfectly well, and this adapter already has an honest answer for their
 * absence — `source: "derived"`.
 */
export type SdkProviderStatusRecord = Pick<
  SdkProviderStatus,
  "provider" | "displayName" | "authenticated" | "available" | "requiresConfiguration" | "modelCount" | "stale"
> &
  Partial<{
    installed: boolean;
    binaryPath: string | null;
    version: string | null;
    authMethod: string | null;
    installCommand: string | null;
    loginCommand: string | null;
    docsUrl: string | null;
    source: "probed" | "derived";
    checkedAt: string;
    detail: string | null;
  }>;

/**
 * The SDK's attachment reference, under this adapter's name.
 *
 * `type` and `hydrate` are restated rather than read off the SDK type because
 * an SDK before 0.3 has neither: the adapter always sets `type`, and an older
 * SDK forwards the extra field to a runtime that already reads it.
 */
export type SdkFileRef = AgentChatFileRef & {
  type?: "file" | "image";
  hydrate?: boolean;
};

/**
 * A catalog row as this adapter reads one.
 *
 * Everything past the three fields it actually maps is optional: an older
 * runtime, or a proxy that forwards only what the picker needs, omits fields
 * this package never looks at, and requiring them would reject a client that
 * works perfectly well.
 */
export type SdkModelCatalogEntry = Pick<ModelCatalogEntry, "id" | "displayName" | "provider"> &
  Partial<ModelCatalogEntry>;

/**
 * A thread this adapter can wrap.
 *
 * `setModel` is optional because an older `@ade-dev/sdk` has none — see
 * `AdeThread.setModel` for why that is reported rather than assumed. `id` and
 * `mcpCapability` are optional because nothing here reads them, and demanding
 * them would reject a proxy that forwards only the chat surface.
 */
export type SdkLikeThread = Pick<SdkThread, "key" | "send" | "interrupt" | "history" | "on"> &
  Partial<Pick<SdkThread, "id" | "mcpCapability">> & {
    /**
     * Restated rather than picked: `@ade-dev/sdk` 0.3 resolves it to the
     * selection plus the new capability reports, 0.2 and the Electron bridge to
     * the selection alone. The adapter reads the result only as an optional
     * `ThreadModelInfo`, so every generation fits.
     */
    setModel?(modelId: string): Promise<unknown>;
    /**
     * Restated so both SDK generations fit: 0.3 takes `(text, { attachments })`
     * and accepts an empty text with attachments; 0.2 and a chat-only proxy take
     * `(text)` only. The adapter always passes the options, which an older
     * thread ignores.
     */
    steer(text: string, opts?: { attachments?: SdkFileRef[] }): Promise<void>;
    /**
     * Paged history (`@ade-dev/sdk` >= 0.3). OPTIONAL; forwarded only when
     * present, so `useAdeThread` can tell a paging client from one that loads
     * the whole window in one `history()` read.
     */
    historyPage?(request?: HistoryPageRequest): Promise<{
      events: AgentChatEventEnvelope[];
      hasMore: boolean;
      nextBeforeSequence?: number | null;
    }>;
    /**
     * The resolved model (`@ade-dev/sdk` >= 0.3 `ThreadModelSelection`). Read as a
     * live property, never cached: the SDK updates it after `setModel`.
     */
    readonly model?: {
      modelId: string;
      displayName?: string | null;
      provider?: string;
    } | null;
    /**
     * Declared structurally rather than picked from the SDK thread, for the
     * same reason as the probe fields above: an older `@ade-dev/sdk`, a fake,
     * or a proxy that forwards only the chat surface has no answer path, and
     * this adapter reports its absence instead of assuming it.
     */
    approve?(itemId: string, decision: ApprovalDecision, responseText?: string): Promise<void>;
    pendingApprovals?(): Promise<readonly ApprovalRequest[]>;
  };

/**
 * A client this adapter can wrap.
 *
 * `threads.open` takes a loose record because `openOptionsFor` merges arbitrary
 * host defaults into it, and it resolves to `SdkLikeThread` so a proxy's thread
 * qualifies too. `list`, `doctor`, `dispose` and `exportThread` are the host's
 * business and are deliberately not required.
 */
export interface SdkLikeChatClient {
  /**
   * Restated rather than picked from `SdkChatClient["providers"]`, for the
   * relaxations only: the records are `SdkProviderStatusRecord` (see above) and
   * `refresh` is OPTIONAL, because a 0.1 client and a chat-only proxy have
   * nothing to re-probe. A real client satisfies both, and the assignability
   * test in `test/sdkClient.test.ts` is what keeps that true.
   */
  providers: {
    status(): Promise<Record<string, SdkProviderStatusRecord>>;
    onChange(cb: (statuses: Record<string, SdkProviderStatusRecord>) => void): Unsubscribe;
    refresh?(): Promise<Record<string, SdkProviderStatusRecord>>;
  };
  models: { list(): Promise<SdkModelCatalogEntry[]> };
  threads: {
    open(key: string, opts?: Record<string, unknown>): Promise<SdkLikeThread>;
  };
}

/**
 * Per-provider shell commands, as an OVERRIDE of what the runtime reports.
 *
 * A runtime that probes providers already knows how to install and sign in to
 * each one, and those strings arrive on the status record. Use this to change
 * ADE's wording — not to supply it. A hint always wins over the record, so a
 * host that set these in 0.1.x keeps the exact copy it had.
 */
export type ProviderCommandHints = Record<
  string,
  { installCommand?: string; loginCommand?: string; docsUrl?: string }
>;

export type AdaptSdkClientOptions = {
  /**
   * Create-time arguments merged into every `threads.open` this package makes.
   *
   * `<AdeChat>` only ever supplies a `modelId`, so the provider, MCP servers,
   * permission preset and title all have to come from the host. When the picked
   * model is in the catalog its provider wins over `defaults.provider`.
   *
   * Over the `@ade-dev/sdk` >= 0.3 Electron bridge, the main process drops every
   * renderer open option except `provider`, `model`, `title` and
   * `reasoningEffort` unless the host registered an `openOptions` hook, so MCP
   * servers, permissions, cwd and instructions set here have no effect there.
   * Set them in the main process instead.
   */
  defaults?: Record<string, unknown> & { provider?: string; model?: string };
  /** Install/login commands rendered on `<ProviderCard>`. */
  commandHints?: ProviderCommandHints;
  /** Restrict the picker and the cards to these providers, in this order. */
  providerFilter?: readonly string[];
};

/* -------------------------------------------------------------------------- */
/* Event mapping                                                               */
/* -------------------------------------------------------------------------- */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Envelope -> `ThreadStatus`, or null when the envelope says nothing about the
 * running state.
 *
 * Returning null matters: mapping an unrecognised status event to `idle` would
 * drop the composer out of its running state mid-turn and re-enable Send.
 */
export function threadStatusFromEnvelope(envelope: AgentChatEventEnvelope): ThreadStatus | null {
  const event = record(envelope?.event);
  const type = event.type;
  const turnId = optionalString(event.turnId) ?? null;

  if (type === "error") {
    return {
      state: "error",
      turnId,
      message:
        optionalString(event.message) ?? optionalString(event.detail) ?? "The turn failed.",
    };
  }
  if (type === "done") return { state: "idle", turnId };
  if (type === "status") {
    switch (event.turnStatus) {
      case "started":
        return { state: "running", turnId };
      case "completed":
      case "interrupted":
        return { state: "idle", turnId };
      case "failed":
      // The SDK's synthetic status for a runtime that exited mid-turn. Without
      // this arm it mapped to null and the composer stayed "running" forever.
      case "error":
        return {
          state: "error",
          turnId,
          message: optionalString(event.message) ?? "The turn failed.",
        };
      default:
        return null;
    }
  }
  return null;
}

/**
 * Envelope -> `ThreadUsage`, or null when there are no numbers in it.
 *
 * Three event types carry tokens (`tokens`, `context_usage`,
 * `codex_token_usage`) with different field names, and `context_usage` nests
 * everything under `usage`. All three are read here so the caller never has to.
 */
export function threadUsageFromEnvelope(envelope: AgentChatEventEnvelope): ThreadUsage | null {
  const event = record(envelope?.event);
  const source = event.type === "context_usage" ? record(event.usage) : event;

  const usage: ThreadUsage = {};
  const input = optionalNumber(source.inputTokens) ?? optionalNumber(source.input_tokens);
  const output = optionalNumber(source.outputTokens) ?? optionalNumber(source.output_tokens);
  const total =
    optionalNumber(source.totalTokens) ??
    optionalNumber(source.total_tokens) ??
    (input !== undefined && output !== undefined ? input + output : undefined);
  const contextWindow =
    optionalNumber(source.maxTokens) ??
    optionalNumber(source.contextWindow) ??
    optionalNumber(source.context_window);

  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  if (contextWindow !== undefined) usage.contextWindow = contextWindow;
  return Object.keys(usage).length > 0 ? usage : null;
}

/* -------------------------------------------------------------------------- */
/* Provider + model mapping                                                    */
/* -------------------------------------------------------------------------- */

export function providerStatusesFromSdk(
  statuses: Record<string, SdkProviderStatusRecord>,
  options: AdaptSdkClientOptions = {},
): ProviderStatus[] {
  const hints = options.commandHints ?? {};
  const entries = Object.values(statuses ?? {});
  const ordered = options.providerFilter
    ? options.providerFilter
        .map((id) => entries.find((entry) => entry.provider === id))
        .filter((entry): entry is SdkProviderStatusRecord => Boolean(entry))
    : entries;

  return ordered.map((entry) => {
    const hint = hints[entry.provider] ?? {};
    const status: ProviderStatus = {
      id: entry.provider,
      displayName: entry.displayName || entry.provider,
      // A runtime that probes the filesystem answers this directly. Only when
      // it does not does "ADE knows models for it" stand in — the closest
      // honest reading available from a catalog alone. It is never inferred
      // from `authenticated`: that would render an unauthenticated provider as
      // "not installed" and send the user to the wrong copyable command.
      //
      // The same derivation exists in `@ade-dev/sdk` (`src/providers.ts`,
      // `deriveProviderStatus`). This copy is load-bearing rather than
      // redundant: it serves 0.1 clients, WebSocket proxies and test doubles
      // that send a record with neither `installed` nor `source`, which the SDK
      // never has to consider. Keep the two rules identical.
      installed: entry.installed ?? entry.modelCount > 0,
      authenticated: entry.authenticated,
    };
    // `source` says which of the two readings above produced `installed`, so
    // the card can soften "Not installed" to "Not detected" when nobody looked.
    status.source = entry.source ?? (entry.installed === undefined ? "derived" : "probed");
    if (entry.binaryPath) status.binaryPath = entry.binaryPath;
    if (entry.version) status.version = entry.version;
    if (entry.checkedAt) status.checkedAt = entry.checkedAt;

    // Record first, hint last: the hint is an override of ADE's wording.
    const installCommand = hint.installCommand ?? entry.installCommand;
    const loginCommand = hint.loginCommand ?? entry.loginCommand;
    const docsUrl = hint.docsUrl ?? entry.docsUrl;
    if (installCommand) status.installCommand = installCommand;
    if (loginCommand) status.loginCommand = loginCommand;
    if (docsUrl) status.docsUrl = docsUrl;

    const detail = describeProvider(entry);
    if (detail) status.detail = detail;
    return status;
  });
}

function describeProvider(entry: SdkProviderStatusRecord): string | undefined {
  // A probing runtime can say something no rung below could know — "cursor is a
  // Node package, not a CLI", for instance. Dropping that in favour of a
  // generic rung would be a step backwards, so it wins.
  if (entry.detail) return entry.detail;
  if (entry.modelCount === 0) return "ADE has no models for this provider.";
  if (!entry.authenticated) return "Not signed in.";
  if (entry.requiresConfiguration) return "Needs configuration before it can run.";
  if (!entry.available) return "Signed in, but no model is usable right now.";
  if (entry.stale) return "Status was read from a stale catalog.";
  return undefined;
}

export function modelDescriptorsFromSdk(
  models: SdkModelCatalogEntry[],
  options: AdaptSdkClientOptions = {},
): ModelDescriptor[] {
  const allowed = options.providerFilter ? new Set(options.providerFilter) : null;
  return (models ?? [])
    .filter((model) => !allowed || allowed.has(model.provider))
    .map((model) => {
      const descriptor: ModelDescriptor = {
        id: model.id,
        providerId: model.provider,
        displayName: model.displayName || model.id,
      };
      if (model.description) descriptor.description = model.description;
      if (model.reasoningEfforts?.length) descriptor.reasoningEfforts = [...model.reasoningEfforts];
      if (model.defaultReasoningEffort) descriptor.defaultReasoningEffort = model.defaultReasoningEffort;
      // Only an explicit false is forwarded: `undefined` means "usable if the
      // provider is", which is not the same as "unavailable".
      if (model.isAvailable === false) descriptor.available = false;
      return descriptor;
    });
}

/* -------------------------------------------------------------------------- */
/* Thread + client                                                             */
/* -------------------------------------------------------------------------- */

function toSendText(input: SendInput | string): string {
  return typeof input === "string" ? input : input.text;
}

/**
 * Image formats a provider accepts as pixels. Kept identical to the inference
 * in `@ade-dev/sdk` (`AgentChatFileRef.type`), so the same file is typed the
 * same way whichever layer fills the field in.
 */
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function extensionOf(value: string | undefined): string | null {
  if (!value) return null;
  // Both separators: a Windows path reaches here verbatim.
  const base = value.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/**
 * `"image"` or `"file"` for one attachment. An explicit `type` wins; then the
 * MIME type; then the extension of the name or the path. Anything unrecognised
 * is a file, which the runtime sends as a path hint — the safe reading, since
 * sending non-image bytes as an image is a provider error.
 */
export function attachmentKind(attachment: ChatAttachment): "file" | "image" {
  if (attachment.type) return attachment.type;
  const mime = attachment.mimeType?.trim().toLowerCase();
  if (mime) return IMAGE_MIME_TYPES.has(mime) ? "image" : "file";
  const extension = extensionOf(attachment.name) ?? extensionOf(attachment.uri);
  return extension && IMAGE_EXTENSIONS.has(extension) ? "image" : "file";
}

function toFileRefs(input: SendInput | string): SdkFileRef[] | undefined {
  if (typeof input === "string") return undefined;
  const attachments = input.attachments ?? [];
  const refs = attachments
    .map((attachment: ChatAttachment): SdkFileRef | null => {
      // The SDK addresses attachments by path. An attachment with no `uri` has
      // nothing to send, and passing `undefined` through would fail deep inside
      // the runtime instead of here.
      if (!attachment.uri) return null;
      // `type` is always set: a runtime reads bytes as an image only when it
      // is told the file IS one, so leaving it out sent every screenshot as a
      // path hint.
      const ref: SdkFileRef = { path: attachment.uri, type: attachmentKind(attachment) };
      if (attachment.name) ref.name = attachment.name;
      if (attachment.mimeType) ref.mimeType = attachment.mimeType;
      if (attachment.sizeBytes !== undefined) ref.bytes = attachment.sizeBytes;
      if (attachment.hydrate !== undefined) ref.hydrate = attachment.hydrate;
      return ref;
    })
    .filter((ref): ref is SdkFileRef => ref !== null);
  return refs.length > 0 ? refs : undefined;
}

/** The `(channel, listener)` pairs `AdaptedThread.on` accepts. */
type ThreadListenerArgs =
  | ["event", (envelope: AgentChatEventEnvelope) => void]
  | ["usage", (usage: ThreadUsage) => void]
  | ["status", (status: ThreadStatus) => void];

class AdaptedThread implements AdeThread {
  /**
   * Present only when the underlying SDK thread supports it, so `canSetModel`
   * reflects the inner thread's real capability rather than the wrapper's.
   * Assigned in the constructor instead of initialized to `undefined` because
   * `exactOptionalPropertyTypes` makes those two different things: an absent
   * property and a property holding `undefined` are distinguishable, and only
   * the former reads as "not supported".
   */
  readonly setModel?: (modelId: string) => Promise<unknown>;

  /**
   * Present only when the inner thread can answer approvals, for the same
   * reason as `setModel`: the card renders read-only rather than offering a
   * button whose click would throw.
   */
  readonly approve?: (
    itemId: string,
    decision: ApprovalDecision,
    responseText?: string,
  ) => Promise<void>;

  readonly pendingApprovals?: () => Promise<readonly ApprovalRequest[]>;

  /** Present only when the inner thread pages, so the hook can feature-detect it. */
  readonly historyPage?: (request?: HistoryPageRequest) => Promise<HistoryPage>;

  constructor(private readonly inner: SdkLikeThread) {
    if (inner.setModel) {
      this.setModel = (modelId: string) => inner.setModel!(modelId);
    }
    if (inner.approve) {
      this.approve = (itemId, decision, responseText) =>
        responseText === undefined
          ? inner.approve!(itemId, decision)
          : inner.approve!(itemId, decision, responseText);
    }
    if (inner.pendingApprovals) {
      this.pendingApprovals = () => inner.pendingApprovals!();
    }
    if (inner.historyPage) {
      this.historyPage = async (request) => {
        const page = await inner.historyPage!(request ?? {});
        return {
          events: page?.events ?? [],
          hasMore: page?.hasMore === true,
          nextBeforeSequence: page?.nextBeforeSequence ?? null,
        };
      };
    }
  }

  /**
   * Read through to the inner thread every time: the SDK replaces its value
   * after `setModel`, so a copy taken at construction would go stale.
   */
  get model(): ThreadModelInfo | null {
    const model = this.inner.model;
    if (!model || typeof model.modelId !== "string" || !model.modelId) return null;
    const info: ThreadModelInfo = { modelId: model.modelId };
    if (model.displayName !== undefined) info.displayName = model.displayName;
    if (model.provider) info.provider = model.provider;
    return info;
  }

  get key(): string {
    return this.inner.key;
  }

  async send(input: SendInput | string): Promise<void> {
    const refs = toFileRefs(input);
    await this.inner.send(toSendText(input), refs ? { attachments: refs } : undefined);
  }

  async steer(input: SendInput | string): Promise<void> {
    const refs = toFileRefs(input);
    if (refs) await this.inner.steer(toSendText(input), { attachments: refs });
    else await this.inner.steer(toSendText(input));
  }

  async interrupt(): Promise<void> {
    await this.inner.interrupt();
  }

  async history(): Promise<AgentChatEventEnvelope[]> {
    return await this.inner.history();
  }

  on(type: "event", cb: (envelope: AgentChatEventEnvelope) => void): Unsubscribe;
  on(type: "usage", cb: (usage: ThreadUsage) => void): Unsubscribe;
  on(type: "status", cb: (status: ThreadStatus) => void): Unsubscribe;
  /**
   * Taken as a discriminated tuple rather than two loose parameters: narrowing
   * on `args[0]` narrows `args[1]` with it, so the channel and its listener stay
   * connected without a cast to reunite them.
   */
  on(...args: ThreadListenerArgs): Unsubscribe {
    if (args[0] === "event") {
      return this.inner.on("event", args[1]);
    }
    if (args[0] === "status") {
      const listener = args[1];
      return this.inner.on("status", (envelope) => {
        const status = threadStatusFromEnvelope(envelope);
        if (status) listener(status);
      });
    }
    const listener = args[1];
    return this.inner.on("usage", (envelope) => {
      const usage = threadUsageFromEnvelope(envelope);
      if (usage) listener(usage);
    });
  }
}

/** Wrap an `@ade-dev/sdk` client (or a proxy of one) as an `AdeChatClient`. */
export function adaptSdkClient(
  sdk: SdkLikeChatClient,
  options: AdaptSdkClientOptions = {},
): AdeChatClient {
  let catalog: SdkModelCatalogEntry[] = [];

  const openOptionsFor = (opts?: ThreadOpenOptions): Record<string, unknown> => {
    const defaults = options.defaults ?? {};
    const modelId = opts?.modelId ?? (defaults.model as string | undefined);
    // The catalog is authoritative about which provider owns a model: a host
    // whose default provider is "claude" must not open a Codex model on Claude
    // just because the user changed the picker.
    const fromCatalog = modelId ? catalog.find((model) => model.id === modelId) : undefined;
    const provider =
      opts?.providerId ?? fromCatalog?.provider ?? (defaults.provider as string | undefined);
    return {
      ...defaults,
      ...(provider ? { provider } : {}),
      ...(modelId ? { model: modelId } : {}),
    };
  };

  const refresh = sdk.providers.refresh;
  return {
    providers: {
      status: async () => providerStatusesFromSdk(await sdk.providers.status(), options),
      onChange: (cb) =>
        sdk.providers.onChange((statuses) => cb(providerStatusesFromSdk(statuses, options))),
      // Forwarded only when the SDK client has it, so a host can tell a
      // re-probing runtime from one that only derives statuses from a catalog.
      ...(refresh
        ? {
            refresh: async () =>
              providerStatusesFromSdk(await refresh.call(sdk.providers), options),
          }
        : {}),
    },
    models: {
      list: async () => {
        catalog = await sdk.models.list();
        return modelDescriptorsFromSdk(catalog, options);
      },
    },
    threads: {
      open: async (key, opts) => new AdaptedThread(await sdk.threads.open(key, openOptionsFor(opts))),
    },
  };
}
