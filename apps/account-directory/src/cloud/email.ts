/**
 * Plain email from ADE Cloud through Resend. With no `RESEND_API_KEY`, logs the
 * subject and carries on. A failed send never fails the work that asked for it.
 */

const RESEND_URL = "https://api.resend.com/emails";
const CLERK_USERS_URL = "https://api.clerk.com/v1/users";
const FROM_ADDRESS = "ADE <notifications@ade-app.dev>";
const REQUEST_TIMEOUT_MS = 10_000;

export type CloudEmailEnv = {
  RESEND_API_KEY?: string;
  CLERK_SECRET_KEY?: string;
  CLOUD_ALERT_EMAIL?: string;
};

export type CloudEmail =
  | { userId: string; subject: string; text: string }
  | { owner: true; subject: string; text: string };

function logEmail(event: string, meta: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ade-account-directory", kind: event, ...meta }));
}

/** The account's primary address from Clerk's Backend API, or null. */
async function accountEmail(env: CloudEmailEnv, userId: string): Promise<string | null> {
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) return null;
  const response = await fetch(`${CLERK_USERS_URL}/${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bearer ${secretKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const user = await response.json() as { primary_email_address_id?: unknown; email_addresses?: unknown };
  if (!Array.isArray(user.email_addresses)) return null;
  const primary = (user.email_addresses as Array<Record<string, unknown>>)
    .find((address) => address.id === user.primary_email_address_id)
    ?? (user.email_addresses as Array<Record<string, unknown>>)[0];
  return typeof primary?.email_address === "string" ? primary.email_address : null;
}

export async function sendCloudEmail(env: CloudEmailEnv, email: CloudEmail): Promise<void> {
  const target = "owner" in email ? "owner" : "account";
  const resendKey = env.RESEND_API_KEY?.trim();
  if (!resendKey) {
    logEmail("cloud.email_skipped", { target, subject: email.subject });
    return;
  }
  try {
    const to = "owner" in email ? env.CLOUD_ALERT_EMAIL?.trim() || null : await accountEmail(env, email.userId);
    if (!to) {
      logEmail("cloud.email_no_recipient", { target, subject: email.subject });
      return;
    }
    const response = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject: email.subject, text: email.text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    logEmail(response.ok ? "cloud.email_sent" : "cloud.email_refused", { target, subject: email.subject, status: response.status });
  } catch {
    logEmail("cloud.email_failed", { target, subject: email.subject });
  }
}
