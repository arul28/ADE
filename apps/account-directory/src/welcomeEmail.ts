/**
 * The day-2 getting-started email: one email per new account, a day after
 * sign-up, through Resend.
 *
 * Most new accounts sign in and never start a chat, and those who do start
 * one mostly come back. So the email has one job: get the person to a first
 * agent chat. It comes in two forms, picked when it is sent:
 *
 * - `start`: the account has no computer yet, of its own or in ADE Cloud.
 *   It offers both ways in, the browser first because it needs no install:
 *   ADE on the web with an ADE Cloud computer (free: the free plan has
 *   unlimited Small computers, `CLOUD_SMALL_UNLIMITED_SENTENCE`), or the
 *   desktop app on the person's own computer.
 * - `first_chat`: a computer is signed in (its own, or an ADE Cloud one).
 *   The first two steps show as done and the email is about the chat.
 *
 * The flow:
 *
 * 1. Clerk's `user.created` webhook (`signupAnalytics.ts`) calls
 *    `scheduleWelcomeEmail`: one `welcome_emails` row, due a day after the
 *    account's Clerk `created_at`. An internal account gets none, and a
 *    retried delivery keeps the first row.
 * 2. The minute cron calls `runWelcomeEmails`. Every tenth minute it reads up
 *    to 20 due rows (one indexed read when none is due), claims each one, and
 *    sends it, or ends it as skipped: an account that unsubscribed, was
 *    deleted or flagged internal since, has no address, or whose row came due
 *    more than two days ago (a late webhook, or a Worker that had no Resend key).
 * 3. A sent email is also one `ade_welcome_email_sent` PostHog event on the
 *    account's distinct id, so a dashboard can compare who came back. Links in
 *    the email carry `utm_campaign=welcome_day2`.
 *
 * Every email has an unsubscribe link and the one-click `List-Unsubscribe`
 * headers (RFC 8058). The link is signed with a key derived from
 * `CLOUD_CHAT_MASTER_KEY`; `GET` shows a confirm button and only `POST`
 * records the opt-out, so a mail scanner that follows links unsubscribes no
 * one. Resend's `Idempotency-Key` is the row's, so a send retried after a lost
 * answer is still one email.
 *
 * Log lines name the outcome and the form, never the address, the name or
 * the account id. `WELCOME_EMAILS=0` (a Worker var) stops every send.
 */

import { constantTimeEqual } from "./githubApp/seal";
import { workerKeyedHash } from "./cloud/freePlan";
import {
  escapeHtml,
  FONT,
  FROM_ADDRESS,
  LOGO_URL,
  readClerkUser,
  REQUEST_TIMEOUT_MS,
  RESEND_URL,
  SITE_URL,
  type ClerkUserFacts,
} from "./cloud/email";
import { accountDistinctId, uuidFromSeed } from "./sinkUtils";
import { trustedHttpsOrigin } from "./trustedOrigin";

export type WelcomeEmailEnv = {
  DB?: D1Database;
  RESEND_API_KEY?: string;
  CLERK_SECRET_KEY?: string;
  /** Keys the unsubscribe link (HKDF label below). */
  CLOUD_CHAT_MASTER_KEY?: string;
  /** This Worker's public https origin: the unsubscribe link's host. Unset, no email is sent. */
  BILLING_RETURN_ORIGIN?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
  /** `0` stops every send; rows wait, then end as stale. */
  WELCOME_EMAILS?: string;
};

const DAY_MS = 24 * 60 * 60_000;
/** Sign-up to send. */
export const WELCOME_EMAIL_DELAY_MS = DAY_MS;
/** A row this far past due is not sent: the email says "yesterday". */
const STALE_AFTER_MS = 2 * DAY_MS;
/** A claim older than this is a tick that died; the row can be claimed again. */
const CLAIM_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const BATCH_LIMIT = 20;
/** The minute of every ten the cron works on. */
const RUN_MINUTE = 4;
const UNSUBSCRIBE_KEY_LABEL = "ade-email-unsubscribe-v1";
export const UNSUBSCRIBE_PATH = "/email/unsubscribe";
const UTM = "utm_source=email&utm_medium=lifecycle&utm_campaign=welcome_day2";
const DOWNLOAD_URL = `${SITE_URL}/?${UTM}`;
const WEB_APP_URL = `https://app.ade-app.dev/?${UTM}`;

export type WelcomeVariant = "start" | "first_chat";
type Outcome =
  | "sent"
  | "failed"
  | "skipped_stale"
  | "skipped_opted_out"
  | "skipped_no_account"
  | "skipped_internal"
  | "skipped_no_address";

function log(kind: string, meta: Record<string, unknown> = {}, level: "info" | "warn" = "info"): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), svc: "ade-account-directory", kind, ...(level === "warn" ? { level } : {}), ...meta });
  if (level === "warn") console.warn(line);
  else console.log(line);
}

/** From Clerk's `user.created`: the account's one row, due a day later. Internal accounts get none. */
export async function scheduleWelcomeEmail(
  db: D1Database,
  account: { userId: string; signedUpAtMs: number; internal: boolean },
): Promise<void> {
  if (account.internal) return;
  await db.prepare(
    "insert into welcome_emails (user_id, signed_up_at, due_at) values (?, ?, ?) on conflict(user_id) do nothing",
  ).bind(account.userId, account.signedUpAtMs, account.signedUpAtMs + WELCOME_EMAIL_DELAY_MS).run();
}

/** `user.deleted`: the account's row and opt-out go with it. */
export async function deleteWelcomeEmailRows(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("delete from welcome_emails where user_id = ?").bind(userId),
    db.prepare("delete from email_opt_outs where user_id = ?").bind(userId),
  ]);
}

function publicOrigin(env: WelcomeEmailEnv): string | null {
  return trustedHttpsOrigin(env.BILLING_RETURN_ORIGIN, { requireExactOrigin: true });
}

function unsubscribeToken(env: WelcomeEmailEnv, userId: string): Promise<string> {
  return workerKeyedHash(env, UNSUBSCRIBE_KEY_LABEL, userId);
}

async function unsubscribeUrl(env: WelcomeEmailEnv, origin: string, userId: string): Promise<string> {
  const query = new URLSearchParams({ u: userId, t: await unsubscribeToken(env, userId) });
  return `${origin}${UNSUBSCRIBE_PATH}?${query.toString()}`;
}

type DueRow = { user_id: string; signed_up_at: number; due_at: number; attempts: number };

/** The cron's step: every tenth minute, the due rows, a few a tick. */
export async function runWelcomeEmails(env: WelcomeEmailEnv, nowMs: number): Promise<void> {
  if (!env.DB) return;
  if (new Date(nowMs).getUTCMinutes() % 10 !== RUN_MINUTE) return;
  const { results } = await env.DB.prepare(`
    select user_id, signed_up_at, due_at, attempts from welcome_emails
    where finished_at is null and due_at <= ? and (claimed_at is null or claimed_at < ?)
    order by due_at limit ${BATCH_LIMIT}
  `).bind(nowMs, nowMs - CLAIM_TIMEOUT_MS).all<DueRow>();
  if (!results.length) return;
  const resendKey = env.RESEND_API_KEY?.trim();
  const origin = publicOrigin(env);
  const blocked = env.WELCOME_EMAILS?.trim() === "0"
    ? "turned_off"
    : !resendKey ? "no_resend_key" : !env.CLERK_SECRET_KEY?.trim() ? "no_clerk_key" : !origin ? "no_public_origin" : null;
  for (const row of results) {
    // Waiting rows still end as stale once they are too old to say "yesterday".
    if (nowMs - row.due_at > STALE_AFTER_MS) {
      await finish(env.DB, row.user_id, "skipped_stale", nowMs);
      continue;
    }
    if (blocked) continue;
    await sendOne(env, env.DB, row, { resendKey: resendKey!, origin: origin!, nowMs });
  }
  if (blocked) log("welcome_email.waiting", { reason: blocked, due: results.length }, "warn");
}

async function finish(db: D1Database, userId: string, outcome: Outcome, nowMs: number, variant?: WelcomeVariant): Promise<void> {
  await db.prepare("update welcome_emails set finished_at = ?, outcome = ? where user_id = ? and finished_at is null")
    .bind(nowMs, outcome, userId).run();
  log(`welcome_email.${outcome}`, variant ? { variant } : {});
}

async function sendOne(
  env: WelcomeEmailEnv,
  db: D1Database,
  row: DueRow,
  ctx: { resendKey: string; origin: string; nowMs: number },
): Promise<void> {
  // The claim: one tick sends a row, even when two ticks overlap.
  const claim = await db.prepare(`
    update welcome_emails set claimed_at = ?, attempts = attempts + 1
    where user_id = ? and finished_at is null and (claimed_at is null or claimed_at < ?)
  `).bind(ctx.nowMs, row.user_id, ctx.nowMs - CLAIM_TIMEOUT_MS).run();
  if ((claim.meta?.changes ?? 0) !== 1) return;
  const attempt = row.attempts + 1;
  const retryLater = async () => {
    if (attempt >= MAX_ATTEMPTS) return finish(db, row.user_id, "failed", ctx.nowMs);
    // Free the claim so the next run tries again.
    await db.prepare("update welcome_emails set claimed_at = null where user_id = ? and finished_at is null").bind(row.user_id).run();
  };

  const optedOut = await db.prepare("select 1 as found from email_opt_outs where user_id = ?").bind(row.user_id).first<{ found: number }>();
  if (optedOut) return finish(db, row.user_id, "skipped_opted_out", ctx.nowMs);

  let user: ClerkUserFacts | null;
  try {
    user = await readClerkUser(env, row.user_id);
  } catch {
    log("welcome_email.clerk_unreachable", { attempt }, "warn");
    return retryLater();
  }
  if (!user) return finish(db, row.user_id, "skipped_no_account", ctx.nowMs);
  if (user.internal) return finish(db, row.user_id, "skipped_internal", ctx.nowMs);
  if (!user.email) return finish(db, row.user_id, "skipped_no_address", ctx.nowMs);

  // Any computer counts: one of the person's own, or an ADE Cloud one.
  const machine = await db.prepare(`
    select 1 as found from machines where user_id = ?
    union all select 1 from cloud_computers where user_id = ? and deleted_at is null
    limit 1
  `).bind(row.user_id, row.user_id).first<{ found: number }>();
  const variant: WelcomeVariant = machine ? "first_chat" : "start";
  const unsubscribe = await unsubscribeUrl(env, ctx.origin, row.user_id);
  const email = renderWelcomeEmail({ variant, firstName: user.firstName, signedUpAtMs: row.signed_up_at, unsubscribeUrl: unsubscribe });

  let response: Response;
  try {
    response = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.resendKey}`,
        "content-type": "application/json",
        "idempotency-key": `welcome-day2/${await uuidFromSeed(`ade-welcome-email-v1:${row.user_id}`)}`,
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [user.email],
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: {
          "List-Unsubscribe": `<${unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        tags: [{ name: "kind", value: "welcome_day2" }, { name: "variant", value: variant }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    log("welcome_email.unreachable", { variant, attempt }, "warn");
    return retryLater();
  }
  if (!response.ok) {
    log("welcome_email.refused", { variant, status: response.status, attempt }, "warn");
    // 4xx other than a rate limit will not get better on a retry.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) return finish(db, row.user_id, "failed", ctx.nowMs, variant);
    return retryLater();
  }
  await finish(db, row.user_id, "sent", ctx.nowMs, variant);
  await captureSent(env, row.user_id, variant, ctx.nowMs);
}

/** `ade_welcome_email_sent` on the account's distinct id. Best effort: the email already went. */
async function captureSent(env: WelcomeEmailEnv, userId: string, variant: WelcomeVariant, nowMs: number): Promise<void> {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token || !/^phc_[A-Za-z0-9_-]{8,}$/.test(token)) return;
  const host = (env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com").replace(/\/+$/, "");
  try {
    await fetch(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: token,
        distinct_id: await accountDistinctId(userId),
        event: "ade_welcome_email_sent",
        uuid: await uuidFromSeed(`ade-welcome-email-sent-v1:${userId}`),
        timestamp: new Date(nowMs).toISOString(),
        properties: { variant, client: "account", interactive: false, $process_person_profile: false, $geoip_disable: true },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    log("welcome_email.capture_failed", { variant }, "warn");
  }
}

// ---------------------------------------------------------------------------
// The email

type Step = { title: string; body: string; done: boolean };

export type RenderedWelcomeEmail = { subject: string; preheader: string; text: string; html: string };

const COLORS = {
  page: "#0a0a0f",
  card: "#16161e",
  border: "#27273a",
  heading: "#f5f5f7",
  body: "#c9c9d4",
  muted: "#8b8b9a",
  faint: "#6b6b7a",
  accent: "#7c3aed",
  accentBright: "#a78bfa",
  done: "#22c55e",
};

function signupDay(signedUpAtMs: number): string {
  return new Date(signedUpAtMs).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** One way to start, in the `start` email: where ADE runs, and its button. */
type Choice = { title: string; body: string; label: string; url: string; primary: boolean };

/** The email for one account. Pure: everything it shows comes in. Kept short on purpose. */
export function renderWelcomeEmail(input: {
  variant: WelcomeVariant;
  /** Clerk's first name, already cut to one word. */
  firstName: string | null;
  signedUpAtMs: number;
  unsubscribeUrl: string;
}): RenderedWelcomeEmail {
  const name = input.firstName?.trim() || null;
  const start = input.variant === "start";
  const subject = start ? "Run your first agent in ADE" : "One step left in ADE";
  const heading = start
    ? `${name ? `Hi ${name}, let’s` : "Let’s"} run your first agent`
    : `${name ? `Hi ${name}, one` : "One"} step left`;
  const intro = start ? "Pick where ADE runs. You don’t need your own computer." : "ADE is set up. Now start a chat.";
  const choices: Choice[] = start
    ? [
      {
        title: "In your browser",
        // The free plan's offer (Pricing v2): Small computers never use hours.
        body: "Nothing to install. Runs free on ADE Cloud, with unlimited Small computers. Works from your phone too.",
        label: "Start in the browser",
        url: WEB_APP_URL,
        primary: true,
      },
      { title: "On your computer", body: "Mac, Windows or Linux.", label: "Download ADE", url: DOWNLOAD_URL, primary: false },
    ]
    : [];
  const steps: Step[] = start
    ? []
    : [
      { title: "Set up ADE", body: "On a computer or ADE Cloud.", done: true },
      { title: "Sign in", body: "Use this account.", done: true },
      { title: "Start a chat", body: "Open a repo, pick an agent you use, and ask it something.", done: false },
    ];
  const after = start ? "Then open a repo, pick an agent you use, and ask it something." : null;
  const action = start ? null : { label: "Open ADE", url: WEB_APP_URL };
  const footer = `You signed up for ADE on ${signupDay(input.signedUpAtMs)}. This is our only getting-started email.`;

  const text = [
    heading,
    intro,
    "",
    ...choices.flatMap((choice) => [`${choice.title}: ${choice.body}`, `${choice.label}: ${choice.url}`, ""]),
    ...steps.map((step, index) => `${index + 1}. ${step.title}${step.done ? " (done)" : ""}: ${step.body}`),
    ...(after ? [after] : []),
    ...(action ? ["", `${action.label}: ${action.url}`] : []),
    "",
    "--",
    footer,
    `Unsubscribe: ${input.unsubscribeUrl}`,
  ].join("\n");

  return {
    subject,
    preheader: intro,
    text,
    html: renderHtml({ subject, preheader: intro, heading, intro, choices, steps, after, action, footer, unsubscribeUrl: input.unsubscribeUrl }),
  };
}

function stepRow(step: Step, index: number, last: boolean): string {
  const marker = step.done
    ? `<td width="24" height="24" align="center" valign="middle" bgcolor="${COLORS.done}" style="width:24px;height:24px;background:${COLORS.done};border-radius:12px;font:700 13px/24px ${FONT};color:#0a0a0f;">&#10003;</td>`
    : `<td width="22" height="22" align="center" valign="middle" style="width:22px;height:22px;border:1px solid ${COLORS.accentBright};border-radius:12px;font:600 12px/22px ${FONT};color:${COLORS.accentBright};">${index + 1}</td>`;
  return `<tr><td style="padding:0 0 ${last ? 0 : 16}px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="36" valign="top" style="width:36px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${marker}</tr></table></td>
<td valign="top" style="font:16px/24px ${FONT};color:${step.done ? COLORS.faint : COLORS.body};">
<span style="font-weight:600;color:${step.done ? COLORS.muted : COLORS.heading};">${escapeHtml(step.title)}</span>&nbsp;&nbsp;${escapeHtml(step.body)}
</td></tr></table>
</td></tr>`;
}

/** A filled (primary) or outlined button. */
function button(label: string, url: string, primary: boolean): string {
  const cell = primary
    ? `bgcolor="${COLORS.accent}" style="background:${COLORS.accent};border-radius:10px;"`
    : `style="border:1px solid ${COLORS.accentBright};border-radius:10px;"`;
  const pad = primary ? "12px 20px" : "11px 19px";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td ${cell}><a href="${escapeHtml(url)}" style="display:inline-block;padding:${pad};font:600 15px/20px ${FONT};color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a></td></tr></table>`;
}

/** A way to start, as a card; the primary one has the accent edge. */
function choiceCard(choice: Choice, last: boolean): string {
  const edge = choice.primary ? COLORS.accent : COLORS.border;
  return `<tr><td style="padding:0 0 ${last ? 0 : 12}px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border:1px solid ${edge};border-radius:12px;padding:18px 20px;">
<p style="margin:0 0 4px;font:600 16px/22px ${FONT};color:${COLORS.heading};">${escapeHtml(choice.title)}</p>
<p style="margin:0 0 14px;font:15px/22px ${FONT};color:${COLORS.muted};">${escapeHtml(choice.body)}</p>
${button(choice.label, choice.url, choice.primary)}
</td></tr></table>
</td></tr>`;
}

function renderHtml(email: {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  choices: Choice[];
  steps: Step[];
  after: string | null;
  action: { label: string; url: string } | null;
  footer: string;
  unsubscribeUrl: string;
}): string {
  const rows = email.choices.length
    ? email.choices.map((choice, index) => choiceCard(choice, index === email.choices.length - 1)).join("\n")
    : email.steps.map((step, index) => stepRow(step, index, index === email.steps.length - 1)).join("\n");
  const after = email.after
    ? `<p style="margin:20px 0 0;font:15px/22px ${FONT};color:${COLORS.muted};">${escapeHtml(email.after)}</p>`
    : "";
  const action = email.action ? `<div style="margin:28px 0 0;">${button(email.action.label, email.action.url, true)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${escapeHtml(email.subject)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(email.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="background:${COLORS.page};"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
<tr><td style="padding:0 4px 20px;"><a href="${SITE_URL}/?${UTM}" style="text-decoration:none;"><img src="${LOGO_URL}" width="72" height="35" alt="ADE" style="display:block;border:0;font:700 24px ${FONT};color:${COLORS.heading};"></a></td></tr>
<tr><td bgcolor="${COLORS.card}" style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:14px;padding:32px;">
<h1 style="margin:0 0 8px;font:700 24px/31px ${FONT};color:${COLORS.heading};">${escapeHtml(email.heading)}</h1>
<p style="margin:0 0 24px;font:16px/24px ${FONT};color:${COLORS.muted};">${escapeHtml(email.intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows}
</table>
${after}${action}
</td></tr>
<tr><td style="padding:20px 4px 0;font:12px/18px ${FONT};color:${COLORS.faint};">${escapeHtml(email.footer)}
<a href="${escapeHtml(email.unsubscribeUrl)}" style="color:${COLORS.muted};text-decoration:underline;">Unsubscribe</a></td></tr>
</table></td></tr></table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Unsubscribe

export function isUnsubscribeRequest(url: URL): boolean {
  return url.pathname === UNSUBSCRIBE_PATH;
}

function page(status: number, title: string, body: string, form?: { action: string }): Response {
  const button = form
    ? `<form method="post" action="${escapeHtml(form.action)}" style="margin:24px 0 0;"><button type="submit" style="cursor:pointer;border:0;background:${COLORS.accent};color:#fff;border-radius:10px;padding:12px 20px;font:600 15px/20px ${FONT};">Unsubscribe</button></form>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:${COLORS.page};"><div style="max-width:480px;margin:80px auto;padding:0 16px;">
<img src="${LOGO_URL}" width="72" height="35" alt="ADE" style="display:block;margin:0 0 20px;">
<div style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:14px;padding:32px;">
<h1 style="margin:0 0 12px;font:700 22px/30px ${FONT};color:${COLORS.heading};">${escapeHtml(title)}</h1>
<p style="margin:0;font:15px/23px ${FONT};color:${COLORS.body};">${escapeHtml(body)}</p>${button}
</div></div></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" },
  });
}

/**
 * `GET /email/unsubscribe?u=&t=` shows a confirm button; `POST` (the button,
 * or a mail client's one-click unsubscribe) records the opt-out and ends a
 * waiting email. A bad or missing signature is refused the same way for an
 * unknown account and a known one.
 */
export async function handleUnsubscribeRequest(request: Request, env: WelcomeEmailEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  if (!env.DB) return page(503, "Not available right now", "Try the link again in a little while.");
  const url = new URL(request.url);
  const userId = url.searchParams.get("u")?.trim() ?? "";
  const token = url.searchParams.get("t")?.trim() ?? "";
  const valid = userId.length > 0 && userId.length <= 512 && token.length > 0
    && constantTimeEqual(token, await unsubscribeToken(env, userId));
  if (!valid) return page(400, "This link doesn’t work", "It’s incomplete or was changed. Open the unsubscribe link from the email again.");
  if (request.method === "GET") {
    return page(200, "Unsubscribe from ADE tips?", "Billing and account notices still come.", { action: `${UNSUBSCRIBE_PATH}${url.search}` });
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("insert into email_opt_outs (user_id, opted_out_at) values (?, ?) on conflict(user_id) do nothing").bind(userId, now),
    env.DB.prepare("update welcome_emails set finished_at = ?, outcome = 'skipped_opted_out' where user_id = ? and finished_at is null").bind(now, userId),
  ]);
  log("welcome_email.unsubscribed");
  return page(200, "You’re unsubscribed", "Billing and account notices still come.");
}
