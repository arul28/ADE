/**
 * Context + hooks binding components to an `AdeChatClient`.
 *
 * Every component also accepts its data as plain props, so none of this is
 * mandatory — a host can render `<Transcript rows={…}>` with no provider at
 * all. The context exists so `<AdeChat>` can wire the default assembly without
 * prop-drilling.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  AdeChatClient,
  AdeThread,
  AgentChatEventEnvelope,
  ApprovalDecision,
  ApprovalRequest,
  ModelDescriptor,
  ProviderStatus,
  SendInput,
  ThreadModelInfo,
  ThreadOpenOptions,
  ThreadStatus,
  ThreadUsage,
} from "../sdkTypes";
import type { ActivityLabelConfig } from "../activity/labels";
import { TranscriptRowBuilder, type TranscriptRow } from "../transcript/transcriptRows";

export type AdeChatContextValue = {
  client: AdeChatClient | null;
  labels?: ActivityLabelConfig;
};

const AdeChatContext = createContext<AdeChatContextValue>({ client: null });

export type AdeChatProviderProps = {
  client: AdeChatClient;
  /** Activity label configuration shared by transcript, chips and indicator. */
  labels?: ActivityLabelConfig;
  children: ReactNode;
};

export function AdeChatProvider({ client, labels, children }: AdeChatProviderProps) {
  const value = useMemo<AdeChatContextValue>(
    () => (labels ? { client, labels } : { client }),
    [client, labels],
  );
  return <AdeChatContext.Provider value={value}>{children}</AdeChatContext.Provider>;
}

export function useAdeChatContext(): AdeChatContextValue {
  return useContext(AdeChatContext);
}

/** The client from context, or the one passed explicitly. Throws if neither. */
export function useAdeChatClient(explicit?: AdeChatClient): AdeChatClient {
  const { client } = useAdeChatContext();
  const resolved = explicit ?? client;
  if (!resolved) {
    throw new Error(
      "@ade-dev/chat-ui: no AdeChatClient. Pass `client` or wrap the tree in <AdeChatProvider>.",
    );
  }
  return resolved;
}

/* -------------------------------------------------------------------------- */
/* Providers + models                                                          */
/* -------------------------------------------------------------------------- */

export type ProvidersState = {
  statuses: ProviderStatus[];
  models: ModelDescriptor[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
};

/**
 * Provider statuses and the model catalog, kept live via
 * `client.providers.onChange`.
 */
export function useAdeProviders(explicitClient?: AdeChatClient): ProvidersState {
  const client = useAdeChatClient(explicitClient);
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([client.providers.status(), client.models.list()])
      .then(([nextStatuses, nextModels]) => {
        if (cancelled) return;
        setStatuses(nextStatuses);
        setModels(nextModels);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, nonce]);

  useEffect(() => {
    // A provider going from unauthed to authed can also change which models are
    // offered, so a status change re-reads the catalog too.
    return client.providers.onChange((next) => {
      setStatuses(next);
      client.models.list().then(setModels).catch(() => {
        /* keep the last good catalog; the status list is still fresh */
      });
    });
  }, [client]);

  return { statuses, models, loading, error, refresh };
}

/* -------------------------------------------------------------------------- */
/* Thread                                                                      */
/* -------------------------------------------------------------------------- */

export type ThreadState = {
  thread: AdeThread | null;
  ready: boolean;
  rows: TranscriptRow[];
  status: ThreadStatus;
  usage: ThreadUsage | null;
  error: Error | null;
  send: (input: SendInput | string) => Promise<void>;
  steer: (input: SendInput | string) => Promise<void>;
  interrupt: () => Promise<void>;
  /** Switch the open thread's model in place. No-op when already bound to it. */
  setModel: (modelId: string) => Promise<void>;
  /** Answer an approval. No-op on a thread that cannot answer them. */
  approve: (itemId: string, decision: ApprovalDecision, responseText?: string) => Promise<void>;
  /** Outstanding approvals, or `[]` on a thread that cannot report them. */
  pendingApprovals: () => Promise<readonly ApprovalRequest[]>;
  /**
   * Whether the open thread can switch models at all. False for a client whose
   * thread predates `setModel`, so a host can disable its picker with a reason
   * instead of accepting a click that would do nothing.
   */
  canSetModel: boolean;
  /**
   * Whether the open thread can answer approvals at all. False for a client
   * whose thread predates `approve`, so the card renders read-only with a
   * reason instead of offering a button whose click would throw.
   */
  canApprove: boolean;
  /**
   * The model the runtime has the thread on, as it resolved it — which can be
   * a successor of the id the host asked for. Read on open and after every
   * successful `setModel`. Null when the client does not report one (an SDK
   * before 0.3, a proxy), and a UI then names the model from its catalog.
   */
  model: ThreadModelInfo | null;
  /**
   * Older history exists that is not loaded yet. Only ever true on a client
   * with `historyPage`; a client that reads history in one `history()` call has
   * nothing further to page.
   */
  hasOlder: boolean;
  /** A `loadOlder()` read is in flight. */
  loadingOlder: boolean;
  /**
   * Load the next older history page and fold it in above the current rows.
   * A no-op when `hasOlder` is false or a load is already running. A failed
   * read leaves `hasOlder` true so the caller can retry; it never throws.
   */
  loadOlder: () => Promise<void>;
};

const IDLE_STATUS: ThreadStatus = { state: "idle" };

/** Envelopes read per `historyPage` call when the host does not say. */
export const DEFAULT_HISTORY_PAGE_SIZE = 200;

/** Where the next older page starts, or null when there is none to read. */
type OlderCursor = { beforeSequence: number } | null;

function readModelInfo(value: unknown): ThreadModelInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.modelId !== "string" || !record.modelId) return null;
  const info: ThreadModelInfo = { modelId: record.modelId };
  if (typeof record.displayName === "string" || record.displayName === null) {
    info.displayName = record.displayName as string | null;
  }
  if (typeof record.provider === "string" && record.provider) info.provider = record.provider;
  return info;
}

/** The oldest sequence in a list, for paging a runtime that sent no cursor. */
function oldestSequence(envelopes: readonly AgentChatEventEnvelope[]): number | null {
  let oldest: number | null = null;
  for (const envelope of envelopes) {
    if (typeof envelope.sequence === "number" && (oldest === null || envelope.sequence < oldest)) {
      oldest = envelope.sequence;
    }
  }
  return oldest;
}

function cursorFrom(
  page: { events: readonly AgentChatEventEnvelope[]; hasMore: boolean; nextBeforeSequence?: number | null },
): OlderCursor {
  if (!page.hasMore) return null;
  const before =
    typeof page.nextBeforeSequence === "number" ? page.nextBeforeSequence : oldestSequence(page.events);
  return before === null ? null : { beforeSequence: before };
}

/**
 * Open a thread and keep its transcript current.
 *
 * History is loaded on open — the newest page when the thread has
 * `historyPage`, else the whole `history()` window — and older pages load on
 * `loadOlder()`. Live events append through a `TranscriptRowBuilder`, so each
 * one patches the tail rather than rebuilding every row; the collapse rules
 * (streaming text merge, tool call→result upgrade) are the same code for
 * replayed and live events. Loading an older page rebuilds once.
 */
export function useAdeThread(
  key: string,
  options?: ThreadOpenOptions & {
    client?: AdeChatClient;
    /**
     * Hold the thread closed while this is false.
     *
     * A host that has not resolved its model yet would otherwise open with no
     * `modelId`, which a real SDK client rejects — and the user reads the
     * resulting developer-facing error before the chat has done anything.
     * Defaults to true.
     */
    enabled?: boolean;
    /**
     * Envelopes per `historyPage` read (the first page and each older one).
     * Ignored by a client without `historyPage`. Default
     * `DEFAULT_HISTORY_PAGE_SIZE`. A streamed reply is many envelopes, so a
     * page holds fewer messages than this number suggests.
     */
    historyPageSize?: number;
  },
): ThreadState {
  const client = useAdeChatClient(options?.client);
  const [thread, setThread] = useState<AdeThread | null>(null);
  const [rows, setRows] = useState<TranscriptRow[]>([]);
  /**
   * Every envelope folded in so far, in render order. Kept only so that an
   * older page can be merged in and the builder rerun once; live appends never
   * read it.
   */
  const envelopesRef = useRef<AgentChatEventEnvelope[]>([]);
  const builderRef = useRef<TranscriptRowBuilder>(new TranscriptRowBuilder());
  const [olderCursor, setOlderCursor] = useState<OlderCursor>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [model, setModelInfo] = useState<ThreadModelInfo | null>(null);
  /** Bumped per open, so a page that lands after a key change is dropped. */
  const openEpochRef = useRef(0);
  /**
   * Requests the runtime is still blocked on that the transcript does not show.
   *
   * Kept beside the envelopes rather than mixed into them: they are requests,
   * not events, and `buildTranscriptRows` takes them as such. A resolution that
   * arrives live settles the card through the normal collapse rules.
   */
  const [restoredApprovals, setRestoredApprovals] = useState<readonly ApprovalRequest[]>([]);
  /**
   * When `restoredApprovals` was read, as an ISO timestamp.
   *
   * Captured once, at the restore, and held so every rebuild places the card at
   * the same instant. `buildTranscriptRows` sorts the restored rows in at this
   * time rather than appending them, so a message that streams in afterwards
   * renders below the card instead of above it.
   */
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const [status, setStatus] = useState<ThreadStatus>(IDLE_STATUS);
  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const modelId = options?.modelId;
  const providerId = options?.providerId;
  const resume = options?.resume;
  const enabled = options?.enabled ?? true;
  const pageSizeRef = useRef(DEFAULT_HISTORY_PAGE_SIZE);
  pageSizeRef.current =
    options?.historyPageSize && options.historyPageSize > 0
      ? Math.floor(options.historyPageSize)
      : DEFAULT_HISTORY_PAGE_SIZE;

  /**
   * The model this thread is currently bound to.
   *
   * `modelId` is deliberately NOT in the open effect's dependencies. It used to
   * be, which meant every model change tore the thread down and re-opened it —
   * dropping the local transcript and re-fetching history for what should be an
   * in-place switch. It is read through a ref so a change before the thread
   * opens still reaches `open()`, while a change after it goes through
   * `setModel` instead.
   */
  const requestedModelIdRef = useRef<string | undefined>(modelId);
  requestedModelIdRef.current = modelId;
  const boundModelIdRef = useRef<string | undefined>(undefined);

  /**
   * Rebuild every row from `envelopesRef` plus the restored approvals. Used on
   * open and after an older page; live envelopes go through `append` instead.
   */
  const rebuildRows = useCallback(
    (restored: readonly ApprovalRequest[], at: string | null) => {
      const builder = new TranscriptRowBuilder();
      builder.append(envelopesRef.current);
      builder.restore(restored, at ?? undefined);
      builderRef.current = builder;
      setRows(builder.rows);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const disposers: Array<() => void> = [];
    const epoch = ++openEpochRef.current;

    setThread(null);
    envelopesRef.current = [];
    builderRef.current = new TranscriptRowBuilder();
    setRows([]);
    setOlderCursor(null);
    setLoadingOlder(false);
    // An older-page read from the previous key may still be in flight; its
    // epoch check drops the result, and this frees the next key to page.
    loadingOlderRef.current = false;
    setModelInfo(null);
    setRestoredApprovals([]);
    setRestoredAt(null);
    setStatus(IDLE_STATUS);
    setUsage(null);
    if (!enabled) return;

    const openOptions: ThreadOpenOptions = {};
    const openModelId = requestedModelIdRef.current;
    boundModelIdRef.current = openModelId;
    if (openModelId !== undefined) openOptions.modelId = openModelId;
    if (providerId !== undefined) openOptions.providerId = providerId;
    if (resume !== undefined) openOptions.resume = resume;

    client.threads
      .open(key, openOptions)
      .then(async (opened) => {
        if (cancelled) return;
        // Subscribe before awaiting history so nothing emitted during the read
        // is dropped; the merge below de-duplicates any overlap.
        const live: AgentChatEventEnvelope[] = [];
        let historyApplied = false;
        // Live envelopes that land in one tick are folded in together, so a
        // burst of streamed deltas costs one row snapshot, not one per delta.
        let pendingLive: AgentChatEventEnvelope[] = [];
        let flushScheduled = false;
        const flushLive = () => {
          flushScheduled = false;
          if (cancelled || pendingLive.length === 0) return;
          const batch = pendingLive;
          pendingLive = [];
          envelopesRef.current.push(...batch);
          setRows(builderRef.current.append(batch));
        };
        disposers.push(
          opened.on("event", (envelope) => {
            if (!historyApplied) {
              live.push(envelope);
              return;
            }
            pendingLive.push(envelope);
            if (!flushScheduled) {
              flushScheduled = true;
              queueMicrotask(flushLive);
            }
          }),
        );
        disposers.push(opened.on("status", (next) => setStatus(next)));
        disposers.push(opened.on("usage", (next) => setUsage(next)));

        // The newest page when the thread pages, the whole window otherwise.
        let history: AgentChatEventEnvelope[];
        let cursor: OlderCursor = null;
        if (typeof opened.historyPage === "function") {
          const page = await opened
            .historyPage({ limit: pageSizeRef.current })
            .catch(() => null);
          if (page) {
            history = page.events ?? [];
            cursor = cursorFrom(page);
          } else {
            // A paging read that fails falls back to the unpaged one rather
            // than opening an empty transcript.
            history = await opened.history().catch(() => [] as AgentChatEventEnvelope[]);
          }
        } else {
          history = await opened.history().catch(() => [] as AgentChatEventEnvelope[]);
        }
        if (cancelled) return;
        const restored = await readPendingApprovals(opened);
        if (cancelled) return;
        const seen = new Set(history.map(envelopeIdentity));
        historyApplied = true;
        const merged = sortEnvelopes([
          ...history,
          ...live.filter((item) => !seen.has(envelopeIdentity(item))),
        ]);
        // Anchor the restored cards to the transcript's own last timestamp, not
        // to this client's clock. The row timestamps they sort against are
        // stamped by the ENGINE, and an embedder over a WebSocket proxy or a
        // remote runtime is a different machine: a client clock behind the host
        // buries the live approval card up in history, and one ahead pins it at
        // the tail forever. Captured once here rather than derived per rebuild,
        // which would walk the card down the transcript as messages arrive. An
        // empty transcript has nothing to anchor to, so the local clock is the
        // only answer left, and with no rows the position cannot be wrong.
        const restoredReadAt = merged[merged.length - 1]?.timestamp ?? new Date().toISOString();
        if (epoch !== openEpochRef.current) return;
        envelopesRef.current = merged;
        rebuildRows(restored, restoredReadAt);
        setOlderCursor(cursor);
        setRestoredApprovals(restored);
        setRestoredAt(restoredReadAt);
        setModelInfo(readModelInfo(opened.model));
        setThread(opened);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      });

    return () => {
      cancelled = true;
      for (const dispose of disposers) dispose();
    };
    // `modelId` is intentionally absent: see requestedModelIdRef above.
  }, [client, key, providerId, resume, enabled, rebuildRows]);

  const threadRef = useRef<AdeThread | null>(null);
  threadRef.current = thread;

  const send = useCallback(async (input: SendInput | string) => {
    await threadRef.current?.send(input);
  }, []);
  const steer = useCallback(async (input: SendInput | string) => {
    await threadRef.current?.steer(input);
  }, []);
  const interrupt = useCallback(async () => {
    await threadRef.current?.interrupt();
  }, []);

  /**
   * Switch the open thread's model in place.
   *
   * No-ops when the thread already has that model, so a host may call this from
   * a render-driven effect without it firing repeatedly. `boundModelIdRef` is
   * updated only after the call succeeds — a failed switch must leave the UI
   * able to retry rather than believing it already happened.
   */
  const setModel = useCallback(async (nextModelId: string) => {
    const target = threadRef.current;
    if (!target || !nextModelId) return;
    if (boundModelIdRef.current === nextModelId) return;
    if (typeof target.setModel !== "function") return;
    const selection = await target.setModel(nextModelId);
    boundModelIdRef.current = nextModelId;
    // The thread's own property first (the SDK updates it), then what
    // `setModel` returned; a client with neither keeps the old value null.
    if (threadRef.current === target) {
      setModelInfo(readModelInfo(target.model) ?? readModelInfo(selection));
    }
  }, []);

  /** See `ThreadState.loadOlder`. */
  const restoredRef = useRef<{ restored: readonly ApprovalRequest[]; at: string | null }>({
    restored: [],
    at: null,
  });
  restoredRef.current = { restored: restoredApprovals, at: restoredAt };
  const loadingOlderRef = useRef(false);
  const loadOlder = useCallback(async () => {
    const target = threadRef.current;
    if (!target || typeof target.historyPage !== "function") return;
    if (!olderCursor || loadingOlderRef.current) return;
    const epoch = openEpochRef.current;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await target.historyPage({
        beforeSequence: olderCursor.beforeSequence,
        limit: pageSizeRef.current,
      });
      if (epoch !== openEpochRef.current || threadRef.current !== target) return;
      const seen = new Set(envelopesRef.current.map(envelopeIdentity));
      const older = (page.events ?? []).filter((item) => !seen.has(envelopeIdentity(item)));
      const next = cursorFrom(page);
      // A page that returned nothing new while claiming more would loop the
      // "load older" trigger forever; treat it as the end.
      setOlderCursor(older.length === 0 ? null : next);
      if (older.length === 0) return;
      envelopesRef.current = sortEnvelopes([...older, ...envelopesRef.current]);
      rebuildRows(restoredRef.current.restored, restoredRef.current.at);
    } catch {
      // Keep the cursor: the next scroll to the top retries.
    } finally {
      if (epoch === openEpochRef.current) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [olderCursor, rebuildRows]);

  /**
   * Answer an approval.
   *
   * The runtime is the only source of truth for the decision, so nothing is
   * written into `envelopes` here: the answer comes back as
   * `pending_input_resolved` and settles the card through the same collapse
   * rules that a replay would use. A thread that cannot approve no-ops rather
   * than throwing — `canApprove` is what a caller checks.
   */
  const approve = useCallback(
    async (itemId: string, decision: ApprovalDecision, responseText?: string) => {
      const target = threadRef.current;
      if (typeof target?.approve !== "function") return;
      if (responseText === undefined) await target.approve(itemId, decision);
      else await target.approve(itemId, decision, responseText);
    },
    [],
  );

  const pendingApprovals = useCallback(async (): Promise<readonly ApprovalRequest[]> => {
    const target = threadRef.current;
    if (typeof target?.pendingApprovals !== "function") return [];
    return await target.pendingApprovals();
  }, []);

  return {
    thread,
    ready: thread !== null,
    rows,
    status,
    usage,
    error,
    send,
    steer,
    interrupt,
    setModel,
    approve,
    pendingApprovals,
    canSetModel: typeof thread?.setModel === "function",
    canApprove: typeof thread?.approve === "function",
    model,
    hasOlder: olderCursor !== null,
    loadingOlder,
    loadOlder,
  };
}

/**
 * The de-duplication key for history/live overlap.
 *
 * CANONICAL DEFINITION: `envelopeDedupeKey` in `@ade-dev/sdk`
 * (`src/electron/protocol.ts`). This is a deliberate byte-identical mirror,
 * because that package is an OPTIONAL peer of this one and chat-ui must work
 * for a WebSocket proxy or a test double that has no SDK at all. The SDK's copy
 * additionally carries a bridge-local occurrence tiebreak for sequence-less
 * envelopes; that part is not mirrored, and the comment there says why.
 */
function envelopeIdentity(envelope: AgentChatEventEnvelope): string {
  return `${envelope.sessionId}:${envelope.sequence ?? "?"}:${envelope.timestamp}:${envelope.event?.type ?? "?"}`;
}

/**
 * Envelope order: numbered envelopes first in `sequence` order, then
 * un-numbered ones in `timestamp` order, arrival order breaking either tie.
 *
 * History and the live buffer are concatenated, not interleaved, so an envelope
 * that arrived live while `history()` was in flight would otherwise render
 * after rows that came before it. Provider clocks are not trusted, which is why
 * `sequence` decides wherever it exists.
 *
 * Sequence is the PRIMARY key unconditionally, and a numbered envelope sorts
 * before an un-numbered one whatever the two timestamps say. That is not a
 * preference, it is what makes the comparator a valid ordering. Comparing
 * sequence only when both sides carry one and otherwise falling through to
 * timestamp is intransitive: with A `{seq 1, t3}`, B `{seq 2, t1}` and C
 * `{no seq, t2}`, A sorts before B by sequence, B before C by timestamp, and C
 * before A by timestamp. `Array.prototype.sort` given an inconsistent
 * comparator returns an implementation-defined permutation, so the whole
 * transcript order becomes arbitrary and adjacent text envelopes stop merging.
 *
 * The two groups therefore never interleave, and timestamp is consulted only
 * within the un-numbered group. In practice every envelope the engine emits
 * carries a sequence; the un-numbered group is the compatibility path.
 *
 * The positional fallback is what makes the sort stable for envelopes that
 * compare equal — `Array.prototype.sort` is specified as stable, but the
 * explicit index removes any doubt.
 */
function sortEnvelopes(envelopes: AgentChatEventEnvelope[]): AgentChatEventEnvelope[] {
  return envelopes
    .map((envelope, index) => ({ envelope, index }))
    .sort((a, b) => {
      const aSeq = typeof a.envelope.sequence === "number" ? a.envelope.sequence : null;
      const bSeq = typeof b.envelope.sequence === "number" ? b.envelope.sequence : null;
      if (aSeq !== null && bSeq === null) return -1;
      if (aSeq === null && bSeq !== null) return 1;
      if (aSeq !== null && bSeq !== null) {
        if (aSeq !== bSeq) return aSeq - bSeq;
        return a.index - b.index;
      }
      if (a.envelope.timestamp !== b.envelope.timestamp) {
        return a.envelope.timestamp < b.envelope.timestamp ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.envelope);
}

/**
 * The requests the runtime is still waiting on, for a thread that just opened.
 *
 * Returns the requests themselves. Nothing is synthesized into an envelope:
 * a thread KEY is a caller-chosen durable name and a `sessionId` is a runtime
 * identifier, and the old code used the first where the second belonged, with
 * invented sequence numbers that collided with the first real envelopes to
 * arrive. `collapseTranscriptEvents` already owns the approval row shape, so it
 * takes these directly.
 *
 * Never fatal: a client with no `pendingApprovals` (an older SDK, a proxy, a
 * fake) and a call that fails both return nothing, and the thread opens.
 */
async function readPendingApprovals(thread: AdeThread): Promise<readonly ApprovalRequest[]> {
  if (typeof thread.pendingApprovals !== "function") return [];
  const pending = await thread.pendingApprovals().catch(() => [] as ApprovalRequest[]);
  return pending.filter((request) => Boolean(request.itemId));
}
