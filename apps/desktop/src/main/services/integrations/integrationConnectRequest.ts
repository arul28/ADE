import {
  CONNECT_METHOD_QUESTION_ID,
  CONNECT_NEXT_STEP,
  CONNECT_PROVIDER_IDS,
  INTEGRATION_CONNECT_METADATA_KEY,
  INTEGRATION_CONNECT_REASON_MAX_CHARS,
  connectMethod,
  connectProviderSpec,
  isConnectProviderId,
  isSelfRunConnectMethod,
  type ConnectMethodId,
  type ConnectProviderId,
  type IntegrationConnectRequestCard,
  type IntegrationConnectRequestResult,
  type IntegrationConnectionSummary,
} from "../../../shared/integrationConnect";
import { captureError } from "../../../shared/sentry/capture";
import {
  cardTimeoutMs,
  firstAnswer,
  joinInFlight,
  readCardArgs,
  type CardRequestChatInput,
} from "../chat/chatCardRequest";

export type IntegrationConnectionState = {
  connected: boolean;
  account: string | null;
  detail: string | null;
  /** Why a new credential would stay on this machine; null when it reaches every machine. */
  storedOnThisMachine?: string | null;
  /** The methods worth offering from this state, in order. Absent: all of them. */
  offer?: ConnectMethodId[];
  /** What already works, in a few words, for the card. */
  current?: string | null;
};

/**
 * One integration on this runtime: how to read whether it is connected, and
 * how to save what the person typed into it. `save` validates with the
 * provider first and throws a sentence the card can show; it never stores a
 * credential the provider refused.
 */
export type IntegrationConnectAdapter = {
  status(): Promise<IntegrationConnectionState>;
  save(method: ConnectMethodId, values: Record<string, string>): Promise<{ account: string | null }>;
  /**
   * After a sign-in the card ran itself: whether that method's sign-in works.
   * Absent: `status().connected`. GitHub's app only reads, so its check is
   * narrower than the full connection.
   */
  checkSignIn?(method: ConnectMethodId): Promise<IntegrationConnectionState>;
};

export type IntegrationConnectDeps = {
  requestChatInput: CardRequestChatInput;
  adapters: Partial<Record<ConnectProviderId, IntegrationConnectAdapter>>;
};

/**
 * Asks still waiting on the person, by chat and provider: an agent that runs
 * the command again while the card is open joins the same card.
 */
const inFlight = new Map<string, Promise<IntegrationConnectRequestResult>>();

/** `integration_connect.status`: every integration this runtime knows, never a credential. */
export async function listIntegrationConnections(deps: Pick<IntegrationConnectDeps, "adapters">): Promise<IntegrationConnectionSummary[]> {
  return await Promise.all(CONNECT_PROVIDER_IDS.map(async (provider): Promise<IntegrationConnectionSummary> => {
    const label = connectProviderSpec(provider).label;
    const adapter = deps.adapters[provider];
    if (!adapter) return { provider, label, connected: false, account: null, detail: "Not available on this machine." };
    try {
      const { connected, account, detail } = await adapter.status();
      return { provider, label, connected, account, detail };
    } catch (error) {
      return { provider, label, connected: false, account: null, detail: error instanceof Error ? error.message : "Could not check." };
    }
  }));
}

/**
 * `integration_connect.request` — ask the person in this chat to connect an
 * integration, and save what they give straight into it.
 *
 * Returns at once when the integration is already connected. Otherwise blocks
 * until the person connects, declines, or the wait runs out. A key reaches
 * this function only as the answer to an `isSecret` question, goes straight to
 * the integration's own save, and is dropped: never logged, never returned.
 */
export async function requestIntegrationConnect(
  deps: IntegrationConnectDeps,
  rawArgs: unknown,
): Promise<IntegrationConnectRequestResult> {
  const args = readCardArgs(rawArgs);
  const chatSessionId = typeof args.chatSessionId === "string" ? args.chatSessionId.trim() : "";
  if (!chatSessionId) {
    throw new Error("Connecting an integration needs a chat to ask in. Run `ade integrations connect` from inside an ADE chat.");
  }
  const provider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
  if (!isConnectProviderId(provider)) {
    throw new Error(`Unknown integration "${provider}". Use one of: ${CONNECT_PROVIDER_IDS.join(", ")}.`);
  }
  return await joinInFlight(inFlight, `${chatSessionId}\u0000${provider}`, () => askToConnect(deps, args, chatSessionId, provider));
}

async function askToConnect(
  deps: IntegrationConnectDeps,
  args: Record<string, unknown>,
  chatSessionId: string,
  provider: ConnectProviderId,
): Promise<IntegrationConnectRequestResult> {
  const spec = connectProviderSpec(provider);
  const adapter = deps.adapters[provider];
  if (!adapter) throw new Error(`${spec.label} is not available on this machine.`);
  const reason = (typeof args.reason === "string" ? args.reason.trim() : "").slice(0, INTEGRATION_CONNECT_REASON_MAX_CHARS);
  if (!reason) {
    throw new Error("Say why you need the integration (--reason). The person decides from that one line.");
  }
  const timeoutMs = cardTimeoutMs(args);

  // A status that fails to read is treated as not connected: the card still
  // asks, and the save checks the key with the provider.
  const before = await adapter.status().catch((error: unknown) => {
    captureError(error, { fingerprint: ["integration_connect", "status_read"], tags: { provider } });
    return null;
  });
  if (before?.connected) {
    return { provider, connected: true, method: "already", account: before.account, next: CONNECT_NEXT_STEP[provider] };
  }

  const savedNote = before?.storedOnThisMachine?.trim();
  const current = before?.current?.trim();
  const offered = before?.offer?.length
    ? spec.methods.filter((method) => before.offer!.includes(method.id))
    : spec.methods;
  const card: IntegrationConnectRequestCard = {
    provider,
    reason,
    ...(savedNote ? { savedNote } : {}),
    ...(offered.length < spec.methods.length ? { methods: offered.map((method) => method.id) } : {}),
    ...(current ? { current } : {}),
  };
  const keyMethods = offered.filter((method) => !isSelfRunConnectMethod(method));

  // A client that draws the native card reads the metadata; any other client
  // (an older desktop, the phone) still gets working questions: which way,
  // then each field, with every key or token as a password question.
  const questions = [
    {
      id: CONNECT_METHOD_QUESTION_ID,
      header: spec.label,
      question: `How do you want to connect ${spec.label}?`,
      allowsFreeform: false,
      options: keyMethods.map((method, index) => ({
        label: method.label,
        value: method.id,
        description: method.hint,
        recommended: index === 0,
      })),
    },
    ...keyMethods.flatMap((method) => method.fields.map((field) => ({
      id: field.id,
      header: spec.label,
      question: field.label,
      allowsFreeform: true,
      ...(field.kind === "secret" ? { isSecret: true } : {}),
    }))),
  ];

  let account: string | null = null;
  let usedMethod: ConnectMethodId | null = null;
  // The save runs while the answer is being accepted, before the card
  // resolves: if the provider refuses the key, the card stays open with the
  // reason instead of a "connected" receipt for a connection that failed.
  const beforeAccept = async (answers: Record<string, string[]>): Promise<void> => {
    const chosen = connectMethod(provider, firstAnswer(answers, CONNECT_METHOD_QUESTION_ID))
      ?? (keyMethods.length === 1 ? keyMethods[0]! : null);
    if (!chosen || !offered.includes(chosen)) throw new Error(`Pick how to connect ${spec.label}.`);
    if (isSelfRunConnectMethod(chosen)) {
      // The card ran the sign-in itself; trust only what the integration says.
      const after = adapter.checkSignIn ? await adapter.checkSignIn(chosen.id) : await adapter.status();
      if (!after.connected) {
        const detail = after.detail?.trim().replace(/\.+$/, "");
        throw new Error(`${spec.label} still shows as not connected${detail ? `: ${detail}` : ""}. Finish the sign-in, or use another way.`);
      }
      account = after.account;
      usedMethod = chosen.id;
      return;
    }
    const values: Record<string, string> = {};
    for (const field of chosen.fields) {
      const value = firstAnswer(answers, field.id);
      if (!value.trim()) throw new Error(`Enter your ${spec.label} ${field.label} to connect.`);
      values[field.id] = value.trim();
    }
    const saved = await adapter.save(chosen.id, values);
    account = saved.account;
    usedMethod = chosen.id;
  };

  const response = await deps.requestChatInput({
    beforeAccept,
    chatSessionId,
    title: `Connect ${spec.label}`,
    body: reason,
    timeoutMs,
    allowsFreeform: false,
    eventDescription: `Connect ${spec.label}`,
    providerMetadata: { [INTEGRATION_CONNECT_METADATA_KEY]: card },
    questions,
  });

  // The save may finish while the card is being closed (a timeout, the turn
  // ending): once it ran, the integration is connected whatever the card says.
  if (usedMethod) return connectedResult(provider, usedMethod, account);
  if (response.timedOut) {
    throw new Error(`Nobody connected ${spec.label} in time. Ask again when the person is around.`);
  }
  // Declined, closed, or accepted by a client that never ran the save.
  return { provider, connected: false, declined: true };
}

function connectedResult(
  provider: ConnectProviderId,
  method: ConnectMethodId,
  account: string | null,
): IntegrationConnectRequestResult {
  const next = provider === "github" && method === "app"
    ? "GitHub reads work through the ADE app. It cannot push or open PRs; ask again and pick Token when you need that."
    : CONNECT_NEXT_STEP[provider];
  return { provider, connected: true, method, account, next };
}

