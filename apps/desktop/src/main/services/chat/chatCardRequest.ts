/**
 * What the cards an agent raises in a chat share: the private secret card
 * (`projectSecretRequest.ts`), the connect card (`integrationConnectRequest.ts`)
 * and the MCP server card (`mcpServerRequest.ts`). Each one asks through
 * `requestChatInput`, waits as long as the person needs to go make a key, and
 * joins a second ask for the same card instead of raising another.
 */

/** The `requestChatInput` call a card makes. `agentChatService` provides it. */
export type CardRequestChatInput = (args: {
  chatSessionId: string;
  title: string;
  body: string;
  timeoutMs?: number;
  allowsFreeform?: boolean;
  providerMetadata?: Record<string, unknown>;
  eventDescription?: string;
  questions?: Array<{
    id?: string;
    header?: string;
    question: string;
    options?: Array<{ label: string; value?: string; description?: string; recommended?: boolean }>;
    allowsFreeform?: boolean;
    isSecret?: boolean;
  }>;
  beforeAccept?: (answers: Record<string, string[]>) => void | Promise<void>;
}) => Promise<{ decision: string; answers: Record<string, string[]>; responseText: string | null; timedOut?: boolean }>;

/** The default wait: long enough to go make a key in another tab, not forever. */
export const CARD_REQUEST_DEFAULT_TIMEOUT_MS = 30 * 60_000;
const CARD_REQUEST_MAX_TIMEOUT_MS = 2 * 60 * 60_000;
const CARD_REQUEST_MIN_TIMEOUT_MS = 10_000;

export function readCardArgs(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

export function firstAnswer(answers: Record<string, string[]>, id: string): string {
  return answers[id]?.[0] ?? "";
}

/** The asked wait (`timeoutMs`), held between ten seconds and two hours. */
export function cardTimeoutMs(args: Record<string, unknown>): number {
  const requested = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
    ? Math.floor(args.timeoutMs)
    : CARD_REQUEST_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(requested, CARD_REQUEST_MIN_TIMEOUT_MS), CARD_REQUEST_MAX_TIMEOUT_MS);
}

/** The person said no, closed the card, or it ended with no answer. */
export function cardWasDeclined(response: { decision: string }): boolean {
  return response.decision === "decline" || response.decision === "cancel" || response.decision === "none";
}

/**
 * Runs `ask` once per key: an agent that runs the command again while the
 * card is open gets the same answer instead of a second card.
 */
export async function joinInFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  ask: () => Promise<T>,
): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return await pending;
  const started = ask();
  inFlight.set(key, started);
  try {
    return await started;
  } finally {
    if (inFlight.get(key) === started) inFlight.delete(key);
  }
}
