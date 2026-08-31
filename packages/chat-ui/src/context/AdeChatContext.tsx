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
  ModelDescriptor,
  ProviderStatus,
  SendInput,
  ThreadOpenOptions,
  ThreadStatus,
  ThreadUsage,
} from "../sdkTypes";
import type { ActivityLabelConfig } from "../activity/labels";
import { buildTranscriptRows, type TranscriptRow } from "../transcript/transcriptRows";

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
  /**
   * Whether the open thread can switch models at all. False for a client whose
   * thread predates `setModel`, so a host can disable its picker with a reason
   * instead of accepting a click that would do nothing.
   */
  canSetModel: boolean;
};

const IDLE_STATUS: ThreadStatus = { state: "idle" };

/**
 * Open a thread and keep its transcript current.
 *
 * History is loaded once on open; live events append. Rows are recomputed from
 * the raw envelope list so the collapse rules (streaming text merge, tool
 * call→result upgrade) stay identical for replayed and live events.
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
  },
): ThreadState {
  const client = useAdeChatClient(options?.client);
  const [thread, setThread] = useState<AdeThread | null>(null);
  const [envelopes, setEnvelopes] = useState<AgentChatEventEnvelope[]>([]);
  const [status, setStatus] = useState<ThreadStatus>(IDLE_STATUS);
  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const modelId = options?.modelId;
  const providerId = options?.providerId;
  const resume = options?.resume;
  const enabled = options?.enabled ?? true;

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

  useEffect(() => {
    let cancelled = false;
    const disposers: Array<() => void> = [];

    setThread(null);
    setEnvelopes([]);
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
        disposers.push(
          opened.on("event", (envelope) => {
            if (historyApplied) setEnvelopes((current) => [...current, envelope]);
            else live.push(envelope);
          }),
        );
        disposers.push(opened.on("status", (next) => setStatus(next)));
        disposers.push(opened.on("usage", (next) => setUsage(next)));

        const history = await opened.history().catch(() => [] as AgentChatEventEnvelope[]);
        if (cancelled) return;
        const seen = new Set(history.map(envelopeIdentity));
        historyApplied = true;
        setEnvelopes([...history, ...live.filter((item) => !seen.has(envelopeIdentity(item)))]);
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
  }, [client, key, providerId, resume, enabled]);

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
    await target.setModel(nextModelId);
    boundModelIdRef.current = nextModelId;
  }, []);

  const rows = useMemo(() => buildTranscriptRows(envelopes), [envelopes]);

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
    canSetModel: typeof thread?.setModel === "function",
  };
}

function envelopeIdentity(envelope: AgentChatEventEnvelope): string {
  return `${envelope.sessionId}:${envelope.sequence ?? "?"}:${envelope.timestamp}:${envelope.event?.type ?? "?"}`;
}
