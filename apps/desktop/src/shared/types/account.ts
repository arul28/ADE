// Renderer/preload contract for the machine-owned ADE account (Clerk identity).
// Mirrors the daemon `account` action domain (#815) but only exposes the
// token-free surface — the raw bearer never crosses into the renderer.

/** Which identity provider signed this account in, when known. */
export type AdeAccountProvider = "github" | "google" | "apple" | "email";

/**
 * Token-free account status surfaced to the renderer. Mirrors the daemon
 * `account.status` shape; `provider`/`imageUrl` are optional because an issuer
 * may omit those claims — the UI degrades to a GitHub-creds image and a
 * monogram when they are absent.
 */
export type AdeAccountStatus = {
  signedIn: boolean;
  userId: string | null;
  email: string | null;
  name: string | null;
  expiresAt: string | null;
  /** Identity provider, when the daemon can determine it. */
  provider?: AdeAccountProvider | null;
  /** Profile image URL, when the daemon can determine it. */
  imageUrl?: string | null;
  /**
   * True when the daemon has no OAuth config (CLERK_* secrets/env), so login is
   * unavailable. Lets the UI explain "not configured" instead of failing hard.
   */
  configured?: boolean;
};

export type AdeAccountLoginStart = {
  sessionId: string;
  authorizeUrl: string;
  expiresAt: string;
};

export type AdeAccountLoginPoll = {
  status: "pending" | "signed_in" | "expired" | "error";
  message: string | null;
  authStatus: AdeAccountStatus;
};

/** A reachable route advertised by an account machine in the directory Worker. */
export type AdeAccountMachineEndpoint = {
  kind: "lan" | "tailnet" | "relay";
  url?: string;
  host?: string;
  port?: number;
};

/** One machine in the account directory (#814 Worker `GET /account/machines`). */
export type AdeAccountMachine = {
  machineKey: string;
  deviceId: string | null;
  name: string | null;
  platform: string | null;
  deviceType: string | null;
  reachableEndpoints: AdeAccountMachineEndpoint[];
  lastSeenAt: number | null;
  online: boolean;
};

/**
 * Result of listing account machines. The Worker may not be deployed or the
 * account may be signed out — the renderer degrades gracefully on each state
 * rather than blocking the Machines panel.
 */
export type AdeAccountMachinesResult = {
  state: "ok" | "signed_out" | "auth_expired" | "not_configured" | "unavailable" | "cancelled";
  machines: AdeAccountMachine[];
  /** Human-readable detail for non-success states that need explanation. */
  message: string | null;
};

/** Stable identities used to recognize this Mac in the account directory. */
export type AdeAccountLocalMachineIdentity = {
  machineKey: string;
  deviceId: string;
};

/** Successful removal of a machine from the signed-in account directory. */
export type AdeAccountMachineRemovalResult = {
  ok: true;
  machineKey: string;
};

/** Token-free result of adopting an account-directory machine for paired use. */
export type AdeAccountMachinePairResult = {
  targetId: string;
  machineKey: string;
  deviceId: string;
  name: string;
};
