/**
 * This Worker's email through Resend, as a branded page with a plain-text copy:
 * ADE Cloud notices and lane share invites. With no `RESEND_API_KEY`, logs a
 * line and carries on. A failed send never fails the work that asked for it.
 */

const RESEND_URL = "https://api.resend.com/emails";
const CLERK_USERS_URL = "https://api.clerk.com/v1/users";
const FROM_ADDRESS = "ADE <notifications@ade-app.dev>";
const REQUEST_TIMEOUT_MS = 10_000;
const LOGO_URL = "https://ade-app.dev/logo.png";
const SITE_URL = "https://ade-app.dev";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type CloudEmailEnv = {
  RESEND_API_KEY?: string;
  CLERK_SECRET_KEY?: string;
  CLOUD_ALERT_EMAIL?: string;
};

export type CloudEmail =
  /** `percentUsed` draws the hours meter. */
  | { userId: string; subject: string; text: string; percentUsed?: number }
  | { owner: true; subject: string; text: string };

const escapeHtml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function hoursMeter(percentUsed: number): string {
  const percent = Math.min(100, Math.max(0, Math.round(percentUsed)));
  const color = percent >= 100 ? "#ef4444" : percent >= 95 ? "#f59e0b" : "#7c3aed";
  // A zero-width cell makes some clients drop the row, so an empty side is left out.
  const left = percent > 0 ? `<td width="${percent}%" height="8" bgcolor="${color}" style="background:${color};font-size:0;line-height:0;">&nbsp;</td>` : "";
  const right = percent < 100 ? `<td height="8" bgcolor="#27273a" style="background:#27273a;font-size:0;line-height:0;">&nbsp;</td>` : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;border-radius:4px;overflow:hidden;"><tr>${left}${right}</tr></table>
<p style="margin:0 0 24px;font:13px/18px ${FONT};color:#8b8b9a;">${percent}% of this period's hours used</p>`;
}

const CLOUD_FOOTER = "ADE Cloud account notice, sent automatically. Replies to this address aren't read.";

type RenderedEmail = {
  subject: string;
  text: string;
  percentUsed?: number;
  /** One button under the text. The URL must be one this Worker built. */
  action?: { label: string; url: string };
  footer?: string;
};

function actionButton(action: { label: string; url: string }): string {
  const href = escapeHtml(action.url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;"><tr><td bgcolor="#7c3aed" style="background:#7c3aed;border-radius:8px;"><a href="${href}" style="display:inline-block;padding:12px 20px;font:600 15px/20px ${FONT};color:#ffffff;text-decoration:none;">${escapeHtml(action.label)}</a></td></tr></table>`;
}

function renderCloudEmail(email: RenderedEmail): string {
  const lines = email.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const paragraphs = lines
    .map((line) => `<p style="margin:0 0 16px;font:16px/25px ${FONT};color:#c9c9d4;">${escapeHtml(line)}</p>`)
    .join("\n");
  const meter = email.percentUsed != null ? hoursMeter(email.percentUsed) : "";
  const button = email.action ? actionButton(email.action) : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${escapeHtml(email.subject)}</title></head>
<body style="margin:0;padding:0;background:#0a0a0f;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(lines[0] ?? email.subject)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0a0f" style="background:#0a0a0f;"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
<tr><td style="padding:0 4px 20px;"><a href="${SITE_URL}" style="text-decoration:none;"><img src="${LOGO_URL}" width="72" height="35" alt="ADE" style="display:block;border:0;font:700 24px ${FONT};color:#f5f5f7;"></a></td></tr>
<tr><td bgcolor="#16161e" style="background:#16161e;border:1px solid #27273a;border-radius:12px;padding:32px;">
<h1 style="margin:0 0 16px;font:600 22px/30px ${FONT};color:#f5f5f7;">${escapeHtml(email.subject)}</h1>
${meter}${paragraphs}
${button}
</td></tr>
<tr><td style="padding:20px 4px 0;font:12px/18px ${FONT};color:#6b6b7a;">${escapeHtml(email.footer ?? CLOUD_FOOTER)}<br><a href="${SITE_URL}" style="color:#8b8b9a;text-decoration:underline;">ade-app.dev</a></td></tr>
</table></td></tr></table>
</body></html>`;
}

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
      body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject: email.subject, text: email.text, html: renderCloudEmail(email) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    logEmail(response.ok ? "cloud.email_sent" : "cloud.email_refused", { target, subject: email.subject, status: response.status });
  } catch {
    logEmail("cloud.email_failed", { target, subject: email.subject });
  }
}

export type LaneShareInviteEmail = {
  /** The invited address, already normalized. */
  to: string;
  /** Who shares: a name, or null for "An ADE user". Client text; escaped here. */
  giverLabel: string | null;
  projectLabel: string | null;
  laneLabel: string | null;
  link: string;
};

export type DirectEmailOutcome = "sent" | "not_configured" | "failed";

/**
 * A lane share invite to the address the giver typed. Returns what happened,
 * so the invite can say whether the email went out; it never throws. The log
 * line carries the kind and status only: no address, no names, no subject.
 */
export async function sendLaneShareInviteEmail(env: CloudEmailEnv, invite: LaneShareInviteEmail): Promise<DirectEmailOutcome> {
  const resendKey = env.RESEND_API_KEY?.trim();
  if (!resendKey) {
    logEmail("lane_share.email_skipped", { reason: "not_configured" });
    return "not_configured";
  }
  const who = invite.giverLabel ?? "An ADE user";
  const lane = invite.laneLabel ? `the lane "${invite.laneLabel}"` : "a lane";
  const project = invite.projectLabel ? ` in ${invite.projectLabel}` : "";
  const subject = `${who} shared a lane with you in ADE`;
  const text = [
    `${who} invited you to ${lane}${project}.`,
    "Open the invite to see what you can do in it. The invite works for 24 hours, and only when you sign in to ADE with this email address.",
    "If you did not expect this, you can ignore this email.",
    `Open the invite: ${invite.link}`,
  ].join("\n");
  try {
    const response = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [invite.to],
        subject,
        text,
        html: renderCloudEmail({
          subject,
          text: text.split("\n").slice(0, -1).join("\n"),
          action: { label: "Open the invite", url: invite.link },
          footer: "ADE lane share invite, sent because an ADE user entered this address. Replies to this address aren't read.",
        }),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    logEmail(response.ok ? "lane_share.email_sent" : "lane_share.email_refused", { status: response.status });
    return response.ok ? "sent" : "failed";
  } catch {
    logEmail("lane_share.email_failed", {});
    return "failed";
  }
}
