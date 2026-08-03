import { useCallback, useEffect, useState } from "react";
import type {
  AdeAccountMachine,
  AdeAccountMachinesResult,
  AdeAccountProvider,
  AdeAccountStatus,
} from "../../shared/types";

// ---------------------------------------------------------------------------
// Machine-owned ADE account (Clerk identity) — renderer helpers.
//
// One cached status shared across the always-mounted sidebar avatar and the
// Account page, plus a tiny event bus so a sign-in / sign-out in one surface
// refreshes the other without a round-trip storm. All calls degrade quietly
// when the bridge is missing (web-client mock, older preload).
// ---------------------------------------------------------------------------

export const SIGNED_OUT_ACCOUNT: AdeAccountStatus = {
  signedIn: false,
  userId: null,
  email: null,
  name: null,
  expiresAt: null,
  provider: null,
  imageUrl: null,
  configured: undefined,
};

const STATUS_TTL_MS = 15_000;

let cachedStatus: { value: AdeAccountStatus; fetchedAtMs: number } | null = null;
let inFlight: Promise<AdeAccountStatus> | null = null;
let fetchSerial = 0;
const listeners = new Set<(status: AdeAccountStatus) => void>();

function accountApi() {
  return (window.ade as typeof window.ade & {
    account?: {
      status: () => Promise<AdeAccountStatus>;
      startLogin: () => Promise<{ sessionId: string; authorizeUrl: string; expiresAt: string }>;
      pollLogin: (args: { sessionId: string }) => Promise<{
        status: "pending" | "signed_in" | "expired" | "error";
        message: string | null;
        authStatus: AdeAccountStatus;
      }>;
      cancelLogin: (args: { sessionId: string }) => Promise<AdeAccountStatus>;
      signOut: () => Promise<AdeAccountStatus>;
      listMachines: () => Promise<AdeAccountMachinesResult>;
    };
  })?.account;
}

function emit(status: AdeAccountStatus): void {
  cachedStatus = { value: status, fetchedAtMs: Date.now() };
  for (const listener of listeners) {
    try {
      listener(status);
    } catch {
      // A broken subscriber must not stop the rest from updating.
    }
  }
}

/**
 * A status that only says "signed out" because the stored session could not be
 * READ. Signing out is an explicit user action and a durable state; a failed
 * decrypt is neither. On Windows the OS-bound credential key is unwrapped by a
 * PowerShell/DPAPI helper that can transiently time out under load, which is
 * how a machine that never signed out ends up rendering as signed out.
 */
function isUnreadableSession(status: AdeAccountStatus): boolean {
  return !status.signedIn && status.sessionReadState === "unreadable";
}

export async function fetchAccountStatus(options?: { force?: boolean }): Promise<AdeAccountStatus> {
  const api = accountApi();
  if (!api?.status) return SIGNED_OUT_ACCOUNT;
  if (
    !options?.force &&
    cachedStatus &&
    Date.now() - cachedStatus.fetchedAtMs < STATUS_TTL_MS
  ) {
    return cachedStatus.value;
  }
  if (!options?.force && inFlight) return inFlight;
  const serial = ++fetchSerial;
  inFlight = api
    .status()
    .then((status) => {
      const normalized = status ?? SIGNED_OUT_ACCOUNT;
      // Hold the last known identity across an unreadable read instead of
      // flashing the whole app to signed-out. The next successful read wins,
      // and a real sign-out reports "missing", which is never retained.
      const previous = cachedStatus?.value;
      if (isUnreadableSession(normalized) && previous?.signedIn) return previous;
      if (serial === fetchSerial) emit(normalized);
      return normalized;
    })
    // A failed status call is an unknown state, not a signed-out one. Only
    // fabricate SIGNED_OUT_ACCOUNT when nothing was ever known.
    .catch(() => cachedStatus?.value ?? SIGNED_OUT_ACCOUNT)
    .finally(() => {
      if (serial === fetchSerial) inFlight = null;
    });
  return inFlight;
}

/** Push a freshly-known status to every subscriber (after sign-in / sign-out). */
export function publishAccountStatus(status: AdeAccountStatus): void {
  fetchSerial += 1; // Supersede any in-flight status fetch so it cannot overwrite this.
  inFlight = null;
  emit(status);
}

export function subscribeAccountStatus(cb: (status: AdeAccountStatus) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Shared account-status hook. Reads the cache immediately, refreshes on mount +
 * window focus, and stays in sync with sign-in / sign-out from other surfaces.
 */
export function useAccountStatus(): {
  status: AdeAccountStatus;
  loading: boolean;
  refresh: () => Promise<AdeAccountStatus>;
} {
  const [status, setStatus] = useState<AdeAccountStatus>(
    () => cachedStatus?.value ?? SIGNED_OUT_ACCOUNT,
  );
  const [loading, setLoading] = useState(cachedStatus == null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      return await fetchAccountStatus({ force: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeAccountStatus(setStatus);
    void fetchAccountStatus().then(setStatus).finally(() => setLoading(false));
    const onFocus = () => void fetchAccountStatus({ force: true });
    window.addEventListener("focus", onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return { status, loading, refresh };
}

// ---------------------------------------------------------------------------
// Presentation helpers — provider accent, monogram, avatar image resolution.
// ---------------------------------------------------------------------------

/**
 * A subtle, provider-tinted accent for the avatar ring. Provider-aware when the
 * daemon reports a provider; otherwise a low-confidence hint from the email
 * domain or a connected GitHub identity, falling back to the ADE accent. Used
 * only for an unlabeled tint — provider *labels* use `knownProvider` so we
 * never assert a provider we cannot verify.
 */
const PROVIDER_TINTS: Record<AdeAccountProvider, string> = {
  github: "#8b949e", // graphite
  google: "#4285f4",
  apple: "#a1a1a8", // silver
  email: "var(--color-accent)",
};

export function providerLabel(provider: AdeAccountProvider): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "google":
      return "Google";
    case "apple":
      return "Apple";
    case "email":
      return "Email";
  }
}

/** The provider we can *state* — only when the daemon reports it. */
export function knownProvider(status: AdeAccountStatus): AdeAccountProvider | null {
  return status.provider ?? null;
}

function inferProviderHint(
  status: AdeAccountStatus,
  githubConnected: boolean,
): AdeAccountProvider | null {
  if (status.provider) return status.provider;
  const domain = status.email?.split("@")[1]?.toLowerCase() ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return "google";
  if (domain === "icloud.com" || domain === "me.com" || domain === "mac.com") {
    return "apple";
  }
  if (githubConnected) return "github";
  return null;
}

export function providerTint(
  status: AdeAccountStatus,
  githubConnected: boolean,
): string {
  const provider = inferProviderHint(status, githubConnected);
  return provider ? PROVIDER_TINTS[provider] : "var(--color-accent)";
}

/** Two-letter (or one-letter) monogram from the account name, else email. */
export function accountInitials(status: AdeAccountStatus): string {
  const name = status.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    if (parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
    return parts[0][0].toUpperCase();
  }
  const email = status.email?.trim();
  if (email) return email[0].toUpperCase();
  return "?";
}

/**
 * The avatar image URL, following the spec fallback chain: account image →
 * current GitHub-creds image → none (caller renders the monogram).
 */
export function accountAvatarImage(
  status: AdeAccountStatus,
  githubLogin: string | null | undefined,
): string | null {
  // Repository credentials and ADE account identity are separate trust
  // boundaries. A connected GitHub CLI session must never make a signed-out
  // ADE surface look authenticated.
  if (!status.signedIn) return null;
  if (status.imageUrl) return status.imageUrl;
  if (githubLogin) {
    return `https://github.com/${encodeURIComponent(githubLogin)}.png?size=64`;
  }
  return null;
}

/** A short "signed in with X" descriptor for the account header, honest by default. */
export function accountProviderCaption(status: AdeAccountStatus): string | null {
  const provider = knownProvider(status);
  return provider ? `Signed in with ${providerLabel(provider)}` : null;
}

export type { AdeAccountMachine, AdeAccountMachinesResult, AdeAccountStatus };
