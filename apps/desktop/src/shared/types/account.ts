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
  /**
   * Why `signedIn` is false. "missing" is a real signed-out machine;
   * "unreadable" means the stored session could not be decrypted on this read
   * (on Windows the OS-bound key comes from a PowerShell/DPAPI helper that can
   * transiently time out) and says NOTHING about whether the user is signed in.
   * The brain's directory publisher has always split these two — the desktop
   * dropped the distinction and rendered every failed read as a sign-out.
   */
  sessionReadState?: AdeAccountSessionReadState;
};

/** Mirrors the daemon's `AccountSessionReadState`. */
export type AdeAccountSessionReadState = "available" | "missing" | "unreadable";

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

/**
 * Start of the OAuth 2.0 device-authorization sign-in, as the renderer sees it.
 *
 * Unlike `startLogin`'s loopback PKCE flow — which goes straight to the issuer
 * and is invisible to ADE's account directory — this flow runs through the
 * directory's `/device/*` endpoints, so the directory can observe that a human
 * completed an interactive sign-in on this machine and mint the single-use
 * pairing grant a removed machine needs to re-join. `verificationUriComplete`
 * pre-fills the code, so the user only has to press Continue.
 */
export type AdeAccountDeviceLoginStart = {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
  intervalSec: number;
};

export type AdeAccountDeviceLoginPoll = {
  status: "pending" | "slow_down" | "signed_in" | "expired" | "error";
  message: string | null;
  /** Directory-requested backoff, when it asked for one. */
  intervalSec: number | null;
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
  /** User-authored account-wide display name. Wins over the reported hostname. */
  customName?: string | null;
  platform: string | null;
  deviceType: string | null;
  /** Long-lived machine identity key used to verify sealed account adoption. */
  pubkey?: string | null;
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

/** Stable identities used to recognize this computer in the account directory. */
export type AdeAccountLocalMachineIdentity = {
  machineKey: string;
  deviceId: string;
};

/** Successful removal of a machine from the signed-in account directory. */
export type AdeAccountMachineRemovalResult = {
  ok: true;
  machineKey: string;
};

/**
 * Outcome of re-pairing THIS machine into the signed-in account after it was
 * removed from the account directory.
 *
 * Mirrors `MachinePairingRepairResult` in
 * `apps/ade-cli/src/services/account/machinePairingRepair.ts`. Removal latches
 * two independent halves — the directory publisher (heartbeats stop) and the
 * push publisher plus its durable `machineRevokedAt` (delivery stops, across
 * restarts) — and only the brain owns them, so the desktop can only report what
 * the brain did. `published && !pushRestored` is a REAL outcome, not a rounding
 * error: the push half is cleared only after the directory confirms the pairing
 * register, because a machine back on the roster but silently undelivering is
 * worse than one that is plainly gone.
 */
/**
 * Machine-readable refusal codes the desktop knows how to act on.
 *
 * Mirrors `AccountMachinePairingRefusalCode` in
 * `apps/ade-cli/src/services/account/accountMachinePublisherService.ts`. Both
 * refusals reach the desktop as `state: "http_error"`; only
 * `pairing_authentication_required` is recoverable in the app, by signing in
 * again so the directory mints a pairing grant.
 */
type AdeAccountMachinePairingRefusalCode =
  | "machine_revoked"
  | "pairing_authentication_required";

export const ADE_ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE:
  AdeAccountMachinePairingRefusalCode = "pairing_authentication_required";

export type AdeAccountMachinePairingRepairResult = {
  /** The directory accepted the re-pair and both halves were lifted. */
  repaired: boolean;
  /** Was anything actually gated before this call? */
  wasRevoked: boolean;
  /** Did the pairing publish reach the directory and get a 2xx? */
  published: boolean;
  /** Did the push half lift, so delivery resumes without a restart? */
  pushRestored: boolean;
  /** Brain-side state token; `reason` carries the explanation for the user. */
  state: string;
  reason: string | null;
  /**
   * Why the brain's directory publish was refused, machine-readable.
   *
   * Typed as a plain string rather than the known-code union because it crosses
   * a version boundary: a newer brain may name a refusal this desktop build has
   * never heard of, and the honest thing is to carry it through rather than
   * discard it. Compare against
   * `ADE_ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE` (or the union above) and
   * treat anything unrecognised — including absence, which is what a brain
   * older than this field sends — as "unknown", never as "not that code".
   */
  reasonCode?: string | null;
};

/** Token-free result of adopting an account-directory machine for paired use. */
export type AdeAccountMachinePairResult = {
  targetId: string;
  machineKey: string;
  deviceId: string;
  name: string;
};

export type AdeAccountPairMachineProgress = {
  machineKey: string;
  stage: "relay" | "tailnet" | "lan" | "verifying" | "opening";
  label: string;
};
