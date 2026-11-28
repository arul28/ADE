/**
 * Clerk's "Sign in from new device" email (`new_device_sign_in`), sent by ADE.
 *
 * An ADE Cloud computer signs in to its account when it joins: the join hands
 * it a one-time Clerk sign-in ticket (`cloud/launches.ts`), and to Clerk that
 * is a new device. Clerk then emails the person a "new device" notice naming a
 * datacenter and "node", which reads like an attack right after they started
 * the computer themselves. Each cloud lane is a new computer, so it came again.
 *
 * With the template's "Delivered by Clerk" switched off, Clerk sends nothing
 * and hands the email to the `email.created` webhook (`signupAnalytics.ts`
 * routes it here):
 *
 * - A sign-in from a cloud computer that just joined sends nothing: the same
 *   account, the address the join came from (an IPv6 address by its /64),
 *   inside `QUIET_WINDOW_MS`, and one email per join (`quietCloudSignIn`).
 * - Every other new-device sign-in sends ADE's own copy of the notice: the
 *   device, location, address and time (in UTC, the zone named), and the
 *   steps to take in ADE. A failed send answers 5xx, so Clerk delivers it again;
 *   Resend's idempotency key is Clerk's email id, so a repeat is one email.
 *
 * While Clerk still delivers it (the switch on), nothing is sent here: the
 * event is only logged with whether it would have stayed quiet, so the match
 * can be checked on real joins before the switch.
 *
 * Log lines never carry the address, the recipient or the device.
 */

import { escapeHtml, FONT, FROM_ADDRESS, REQUEST_TIMEOUT_MS, RESEND_URL } from "./cloud/email";
import { logCloud, reportCloudFailure } from "./cloud/store";

const NEW_DEVICE_TEMPLATE = "new_device_sign_in";
/** How long after its join a computer's own sign-in stays quiet. The sign-in follows the join within seconds. */
const QUIET_WINDOW_MS = 15 * 60_000;
/** A join noted a moment after Clerk's event (clock skew between the two) still counts. */
const CLOCK_SKEW_MS = 60_000;
/** Spent rows are kept this long, so a repeated delivery of a quiet email stays quiet. */
const SPENT_KEPT_MS = 4 * 24 * 60 * 60_000;

export type NewDeviceEmailEnv = {
  DB?: D1Database;
  RESEND_API_KEY?: string;
};

/**
 * The part of an address a sign-in is matched on: an IPv4 address whole, an
 * IPv6 address by its /64 (one computer's network), an IPv4-mapped IPv6
 * address as IPv4. Null when it isn't an address.
 */
function signInAddressKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  const v4 = mapped ? mapped[1]! : address;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4)) {
    return v4.split(".").every((part) => Number(part) <= 255) ? `v4:${v4.split(".").map(Number).join(".")}` : null;
  }
  if (!/^[0-9a-f:]+$/.test(address) || !address.includes(":") || address.split("::").length > 2) return null;
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return `v6:${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}`;
}

/**
 * At a cloud computer's join, before it gets its sign-in link: its own Clerk
 * sign-in, from the address the join came from, stays quiet once in the next
 * `QUIET_WINDOW_MS`. Never throws: the join goes on, and the notice is sent.
 */
export async function expectCloudComputerSignIn(env: Pick<NewDeviceEmailEnv, "DB">, userId: string, request: Request, now: number): Promise<void> {
  const address = signInAddressKey(request.headers.get("cf-connecting-ip"));
  if (!env.DB || !address) return;
  try {
    await env.DB.batch([
      env.DB.prepare("delete from cloud_quiet_sign_ins where expires_at < ?").bind(now - SPENT_KEPT_MS),
      env.DB.prepare("insert into cloud_quiet_sign_ins (user_id, address, created_at, expires_at) values (?, ?, ?, ?)")
        .bind(userId, address, now, now + QUIET_WINDOW_MS),
    ]);
  } catch (error) {
    reportCloudFailure("cloud.quiet_sign_in_note_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}

type QuietMatch = "cloud_computer" | "other_address" | "none";

/**
 * Is the sign-in Clerk emailed about (made at `at`) a cloud computer's own,
 * right after its join? `spend`: claim the join's one quiet email, and keep
 * the email id with it, so Clerk delivering the same email again stays quiet.
 * `other_address`: no match, but this account had a join in the window (the
 * computer reached Clerk on another address, IPv4 against IPv6): logged.
 */
async function quietCloudSignIn(
  db: D1Database,
  args: { userId: string; address: string | null; emailId: string; at: number; spend: boolean },
): Promise<QuietMatch> {
  const { userId, address, emailId, at } = args;
  const window = "user_id = ? and created_at <= ? and expires_at > ?";
  const windowBinds = [userId, at + CLOCK_SKEW_MS, at];
  if (address) {
    if (args.spend) {
      // One statement, so two deliveries of one email at once spend one join
      // between them: the one that loses finds the email id the other kept.
      const spent = await db.prepare(`
        update cloud_quiet_sign_ins set used_at = ?, email_id = ?
        where id = (select id from cloud_quiet_sign_ins where ${window} and address = ? and used_at is null order by created_at desc limit 1)
          and not exists (select 1 from cloud_quiet_sign_ins where email_id = ?)
      `).bind(Date.now(), emailId, ...windowBinds, address, emailId).run();
      if ((spent.meta?.changes ?? 0) > 0) return "cloud_computer";
      const repeat = await db.prepare("select 1 as hit from cloud_quiet_sign_ins where email_id = ?").bind(emailId).first<{ hit: number }>();
      if (repeat) return "cloud_computer";
    } else {
      const open = await db.prepare(`select 1 as hit from cloud_quiet_sign_ins where ${window} and address = ? and used_at is null`)
        .bind(...windowBinds, address).first<{ hit: number }>();
      if (open) return "cloud_computer";
    }
  }
  const joined = await db.prepare(`select 1 as hit from cloud_quiet_sign_ins where ${window} and used_at is null`).bind(...windowBinds).first<{ hit: number }>();
  return joined ? "other_address" : "none";
}

/** `email.created`'s email, as Clerk sends it (`EmailJSON` in `@clerk/backend`). */
type ClerkEmail = {
  id?: unknown;
  slug?: unknown;
  user_id?: unknown;
  to_email_address?: unknown;
  subject?: unknown;
  data?: unknown;
  delivered_by_clerk?: unknown;
};

const text = (value: unknown, max = 300): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/** The sign-in's time, in UTC with the zone named: ADE doesn't know the person's own zone. */
function signInTimeText(at: number): string {
  return `${new Date(at).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

type Notice = { subject: string; text: string; html: string };

/**
 * ADE's copy of the notice: the sign-in's details, and the steps a person
 * takes in ADE when they don't recognize it (secure the sign-in, remove a
 * computer they don't know from their account).
 */
function renderNotice(email: ClerkEmail, vars: Record<string, unknown>, at: number): Notice {
  const app = vars.app && typeof vars.app === "object" ? vars.app as Record<string, unknown> : {};
  const appName = text(app.name, 60) ?? text(vars["app.name"], 60) ?? "ADE";
  const browser = text(vars.browser_name, 80);
  const system = text(vars.operating_system, 80);
  const rows: Array<[string, string]> = [];
  const method = text(vars.sign_in_method, 80);
  if (method) rows.push(["Sign-in type", method]);
  if (browser || system) rows.push(["Device", [browser ?? "Unknown browser", system ?? "an unknown system"].join(" on ")]);
  const location = text(vars.location, 120);
  if (location) rows.push(["Location", location]);
  const address = text(vars.ip_address, 64);
  if (address) rows.push(["IP address", address]);
  rows.push(["Time", signInTimeText(at)]);
  const support = text(vars.support_email, 200);
  const intro = `A new device signed in to your ${appName} account.`;
  const ok = "If this was you, there's nothing to do.";
  const act = `If you don't recognize it, change the password of the account you sign in with, then open ${appName}, go to Account > Your computers, and remove any computer you don't know.`;
  const help = support ? `Questions? Write to ${support}.` : null;
  const subject = (text(email.subject, 200) ?? `New device signed in to your ${appName} account`).replace(/\s+/g, " ");
  const plain = [intro, "", ...rows.map(([label, value]) => `${label}: ${value}`), "", ok, act, ...(help ? ["", help] : [])].join("\n");
  const cell = (value: string, style: string) => `<td style="${style}">${escapeHtml(value)}</td>`;
  const table = rows.map(([label, value]) => `<tr>${cell(label, "padding:4px 16px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top;")}${cell(value, "padding:4px 0;color:#111827;font-weight:600;")}</tr>`).join("");
  const paragraph = (value: string) => `<p style="margin:0 0 16px;font:15px/22px ${FONT};color:#111827;">${escapeHtml(value)}</p>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;">
<div style="max-width:560px;margin:0 auto;font:15px/22px ${FONT};color:#111827;">
${paragraph(intro)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;font:14px/20px ${FONT};">${table}</table>
${paragraph(ok)}
${paragraph(act)}
${help ? paragraph(help) : ""}
</div></body></html>`;
  return { subject, text: plain, html };
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * `email.created` from Clerk's webhook (signature already checked). Only the
 * new-device template is handled; every other email is acknowledged and
 * nothing of it is read or logged (one-time codes come this way too).
 * `eventAt`: when Clerk made the email (the event's `timestamp`, the same on
 * every repeat), which is the sign-in's time.
 */
export async function handleClerkEmailCreated(env: NewDeviceEmailEnv, email: ClerkEmail, eventAt: number): Promise<Response> {
  if (email.slug !== NEW_DEVICE_TEMPLATE) return json(200, { ignored: true });
  const vars = email.data && typeof email.data === "object" ? email.data as Record<string, unknown> : {};
  const userId = text(email.user_id, 200);
  const emailId = text(email.id, 200) ?? `${userId ?? "unknown"}:${eventAt}`;
  const address = signInAddressKey(vars.ip_address);
  const clerkDelivers = email.delivered_by_clerk !== false;
  let match: QuietMatch = "none";
  if (env.DB && userId) {
    try {
      match = await quietCloudSignIn(env.DB, { userId, address, emailId, at: eventAt, spend: !clerkDelivers });
    } catch (error) {
      // Unsure: a person's security notice goes out.
      reportCloudFailure("cloud.new_device_match_failed", { message: error instanceof Error ? error.message : "unknown" });
    }
  }
  const cloudComputer = match === "cloud_computer";
  if (clerkDelivers) {
    logCloud("cloud.new_device_email", { outcome: "clerk_delivers", cloudComputer, otherAddress: match === "other_address" });
    return json(200, { delivered: "clerk" });
  }
  if (cloudComputer) {
    logCloud("cloud.new_device_email", { outcome: "quiet_cloud_computer", cloudComputer: true });
    return json(200, { delivered: "none" });
  }
  const to = text(email.to_email_address, 320);
  if (!to) {
    reportCloudFailure("cloud.new_device_email_no_recipient", {});
    return json(200, { delivered: "none", reason: "no_recipient" });
  }
  const resendKey = env.RESEND_API_KEY?.trim();
  if (!resendKey) {
    // Clerk delivers it again while this lasts (about three days of retries).
    reportCloudFailure("cloud.new_device_email_not_configured", {});
    return json(503, { error: "not_configured" });
  }
  const notice = renderNotice(email, vars, eventAt);
  try {
    const response = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json", "idempotency-key": `clerk-email/${emailId}` },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject: notice.subject, text: notice.text, html: notice.html }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      reportCloudFailure("cloud.new_device_email_refused", { status: response.status });
      return json(502, { error: "send_failed" });
    }
  } catch {
    reportCloudFailure("cloud.new_device_email_unreachable", {});
    return json(502, { error: "send_failed" });
  }
  logCloud("cloud.new_device_email", { outcome: "sent", cloudComputer: false, otherAddress: match === "other_address" });
  return json(200, { delivered: "ade" });
}
