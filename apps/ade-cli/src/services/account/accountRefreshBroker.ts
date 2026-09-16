import {
  AccountRefreshUnavailableError,
  type AccountRefreshBroker,
} from "./accountAuthService";

export type AccountRefreshBrokerTransport = {
  /** Probe the transport immediately before a request; false hands auth back to its local path. */
  isReachable?: () => Promise<boolean>;
  /** Return the raw account-token response, including any transport envelope. */
  requestToken: () => Promise<unknown>;
};

export type AccountRefreshBrokerOptions = AccountRefreshBrokerTransport & {
  unavailableMessage?: string;
  emptyTokenMessage?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Accept both the current `{ domain, action, result }` envelope and bare transports. */
export function unwrapAccountActionResult(raw: unknown): unknown {
  return isRecord(raw)
    && "result" in raw
    // Older desktop account actions omitted the domain/action labels, but
    // still wrapped object payloads in `{ result }`. Keep accepting that
    // shape while the labelled envelope also covers token strings.
    && (
      typeof raw.domain === "string"
      || typeof raw.action === "string"
      || isRecord(raw.result)
    )
    ? raw.result
    : raw;
}

/** Shared policy for every non-brain account refresh broker. */
export function createAccountRefreshBroker(
  options: AccountRefreshBrokerOptions,
): AccountRefreshBroker {
  const unavailableMessage = options.unavailableMessage
    ?? "ADE couldn't ask the brain for an account token. Try again in a moment.";
  const emptyTokenMessage = options.emptyTokenMessage
    ?? "The ADE brain did not return an account token.";

  return {
    async getAccessToken(_requestOptions) {
      if (options.isReachable) {
        let reachable = false;
        try {
          reachable = await options.isReachable();
        } catch {
          reachable = false;
        }
        if (!reachable) return null;
      }

      try {
        const token = unwrapAccountActionResult(await options.requestToken());
        if (typeof token !== "string" || !token.trim()) {
          throw new AccountRefreshUnavailableError(emptyTokenMessage);
        }
        return token.trim();
      } catch (error) {
        if (error instanceof AccountRefreshUnavailableError) throw error;
        throw new AccountRefreshUnavailableError(unavailableMessage, { cause: error });
      }
    },
  };
}
