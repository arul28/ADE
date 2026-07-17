import {
  browserEndpointRequiresRelayAccess,
  type BrowserDialCandidate,
} from "./endpoints";
import type { WebClientEnvironmentRecord } from "./envStore";

export type WebRelayAccess =
  | { kind: "signed_out" }
  | {
      kind: "signed_in";
      userId: string;
      hostDeviceIds: readonly string[];
      /** Returns a fresh short-lived proof. It is never written to browser storage. */
      getAccessToken: () => Promise<string>;
    };

export const SIGNED_OUT_RELAY_ACCESS: WebRelayAccess = { kind: "signed_out" };

export class WebRelayAuthRequiredError extends Error {
  readonly code = "web_relay_auth_required";

  constructor(message = "Sign in with the same ADE account as this machine.") {
    super(message);
    this.name = "WebRelayAuthRequiredError";
  }
}

function normalized(value: string | null | undefined): string | null {
  const next = value?.trim();
  return next ? next : null;
}

function relayAccessMatchesHost(
  access: WebRelayAccess,
  hostDeviceId: string,
): access is Extract<WebRelayAccess, { kind: "signed_in" }> {
  if (access.kind !== "signed_in") return false;
  const expected = normalized(hostDeviceId);
  return Boolean(expected && access.hostDeviceIds.some((deviceId) => normalized(deviceId) === expected));
}

export function canUseRelayForEnvironment(
  environment: WebClientEnvironmentRecord,
  access: WebRelayAccess,
): boolean {
  if (access.kind !== "signed_in") return false;
  const owner = normalized(environment.accountOwnerUserId);
  if (owner) return owner === normalized(access.userId);
  return relayAccessMatchesHost(access, environment.hostDeviceId);
}

export function filterEnvironmentEndpoints(
  environment: WebClientEnvironmentRecord,
  endpoints: readonly BrowserDialCandidate[],
  access: WebRelayAccess,
): BrowserDialCandidate[] {
  const relayAllowed = canUseRelayForEnvironment(environment, access);
  return endpoints.filter((candidate) => !browserEndpointRequiresRelayAccess(candidate) || relayAllowed);
}

export function requireDialableAuthorizedEndpoint(
  original: readonly BrowserDialCandidate[],
  authorized: readonly BrowserDialCandidate[],
): void {
  if (authorized.some((candidate) => candidate.dialable)) return;
  if (original.some((candidate) => browserEndpointRequiresRelayAccess(candidate) && candidate.dialable)) {
    throw new WebRelayAuthRequiredError();
  }
  throw new Error("No direct browser connection is available for this machine.");
}
