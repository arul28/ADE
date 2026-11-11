/**
 * What lane sharing needs to know about a Clerk user, from Clerk's Backend API
 * with `CLERK_SECRET_KEY`: the addresses Clerk has VERIFIED for the account,
 * and a name to show in an invite.
 *
 * An address the client sends is never trusted. Accepting an invite, opening
 * a pending one and refusing a self-invite all read the verified list here,
 * on every call, so an address verified after the invite was sent counts at
 * once and one removed from the account stops counting at once.
 *
 * `null` means Clerk could not be asked (no key, an error, a timeout). Every
 * caller treats that as "cannot decide" and refuses with 503, never as an
 * empty list that would let a check pass.
 */

const CLERK_USERS_URL = "https://api.clerk.com/v1/users";
const REQUEST_TIMEOUT_MS = 10_000;

export type ClerkAccountEnv = { CLERK_SECRET_KEY?: string };

export type ClerkAccount = {
  /** Trimmed and lowercased. */
  verifiedEmails: string[];
  /** First and last name, else the username, else null. Raw text: clean before showing. */
  displayName: string | null;
};

export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

export async function clerkAccount(env: ClerkAccountEnv, userId: string): Promise<ClerkAccount | null> {
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) return null;
  try {
    const response = await fetch(`${CLERK_USERS_URL}/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${secretKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const user = await response.json() as Record<string, unknown>;
    if (user.id !== userId || !Array.isArray(user.email_addresses)) return null;
    const verifiedEmails: string[] = [];
    for (const entry of user.email_addresses as unknown[]) {
      const address = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
      const verification = address?.verification && typeof address.verification === "object"
        ? address.verification as Record<string, unknown>
        : null;
      if (typeof address?.email_address === "string" && verification?.status === "verified") {
        verifiedEmails.push(normalizeEmail(address.email_address));
      }
    }
    const name = [user.first_name, user.last_name].filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" ");
    const displayName = name || (typeof user.username === "string" && user.username.trim() ? user.username : null);
    return { verifiedEmails, displayName };
  } catch {
    return null;
  }
}
