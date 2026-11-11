import { UNREADABLE_REQUEST_MESSAGE, fail, json } from "../cloud/http";
import { sendLaneShareInviteEmail } from "../cloud/email";
import { boundedDisplayText } from "../displayText";
import { logLaneShare } from "../logging";
import { utcDayKey } from "../sinkUtils";
import {
  LANE_SHARE_DAILY_EMAILS_GLOBAL,
  LANE_SHARE_DAILY_EMAILS_PER_RECIPIENT,
  LANE_SHARE_DAILY_INVITES_PER_GIVER,
  LANE_SHARE_INVITE_TTL_MS,
  LANE_SHARE_MAX_EMAILS_PER_INVITE,
  LANE_SHARE_GRANT_ID_PATTERN as GRANT_ID,
  LANE_SHARE_MAX_GUESTS_PER_LANE,
  LANE_SHARE_RESEND_INTERVAL_MS,
  laneShareInviteLink,
  type LaneShareEmailNotSentReason,
  type LaneShareInviteResponse,
  type LaneSharePreset,
  type LaneShareRisk,
} from "./contract";
import {
  badRequest,
  budgetedClerkAccount,
  claimDay,
  clerkBudgetSpent,
  clerkUnavailable,
  COLUMNS,
  effectiveState,
  giverSubject,
  giverView,
  GLOBAL_EMAIL_SUBJECT,
  isUniqueViolation,
  type LaneShareEnv,
  LIVE_STATES,
  loadRow,
  MAX_GIVER_LABEL,
  newGrantId,
  notFound,
  ownsMachine,
  parseEmail,
  parseEndsAt,
  parseLabel,
  parseLaneId,
  parseMachineKey,
  parsePreset,
  parseRepoKey,
  parseRisk,
  readJsonBody,
  recipientSubject,
  refundDay,
  reload,
  settleLane,
  shareClosed,
  type ShareRow,
} from "./shareRows";

/**
 * The invite routes of lane sharing: a new invite, its email, a check of a
 * share back, and a second invite to the same address.
 */

/**
 * Sends the invite email when every limit allows it. `giverClaimed` is true
 * when the caller already took this invite's slot of the giver's daily budget
 * (a new invite); a re-send takes its own.
 */
async function deliverInvite(
  env: LaneShareEnv,
  row: ShareRow,
  now: number,
  giverClaimed: boolean,
): Promise<{ sent: boolean; reason: LaneShareEmailNotSentReason | null }> {
  // No sender: nothing is claimed, and the invite works by its link.
  if (!env.RESEND_API_KEY?.trim()) return { sent: false, reason: "not_configured" };
  const day = utcDayKey(now);
  const toSubject = await recipientSubject(row.receiver_email);
  if (!giverClaimed && !(await claimDay(env, day, giverSubject(row.giver_user_id), LANE_SHARE_DAILY_INVITES_PER_GIVER))) {
    return { sent: false, reason: "rate_limited" };
  }
  const giveBackGiver = async () => {
    if (!giverClaimed) await refundDay(env, day, giverSubject(row.giver_user_id));
  };
  if (!(await claimDay(env, day, toSubject, LANE_SHARE_DAILY_EMAILS_PER_RECIPIENT))) {
    await giveBackGiver();
    return { sent: false, reason: "rate_limited" };
  }
  // The day's emails from every account together: past it the invite still works by its link.
  if (!(await claimDay(env, day, GLOBAL_EMAIL_SUBJECT, LANE_SHARE_DAILY_EMAILS_GLOBAL))) {
    await giveBackGiver();
    await refundDay(env, day, toSubject);
    logLaneShare({ event: "lane_share.refused", userId: row.giver_user_id, grantId: row.id, code: "global_email_cap" });
    return { sent: false, reason: "rate_limited" };
  }
  const giveBackShared = async () => {
    await refundDay(env, day, toSubject);
    await refundDay(env, day, GLOBAL_EMAIL_SUBJECT);
  };
  // One write claims this invite's send: two re-sends at once cannot both pass the interval.
  const claimed = await env.DB.prepare(`
    update lane_shares set invite_email_count = invite_email_count + 1, last_invite_email_at = ?
    where id = ? and state = 'pending' and invite_email_count < ? and (last_invite_email_at is null or last_invite_email_at <= ?)
  `).bind(now, row.id, LANE_SHARE_MAX_EMAILS_PER_INVITE, now - LANE_SHARE_RESEND_INTERVAL_MS).run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    await giveBackGiver();
    await giveBackShared();
    return { sent: false, reason: "rate_limited" };
  }
  // No project or lane label: they are the giver's free text, and an email
  // to an address the giver typed must not carry the giver's words.
  const outcome = await sendLaneShareInviteEmail(env, {
    to: row.receiver_email,
    giverLabel: row.giver_label,
    link: laneShareInviteLink(row.id),
  });
  if (outcome === "sent") return { sent: true, reason: null };
  await giveBackShared();
  return { sent: false, reason: outcome === "not_configured" ? "not_configured" : "failed" };
}

// ---------------------------------------------------------------------------
// Handlers

export async function handleInvite(request: Request, env: LaneShareEnv, userId: string, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const receiverEmail = parseEmail(body.receiverEmail);
  if (!receiverEmail) return badRequest("That email address isn't valid.");
  const repoKey = parseRepoKey(body.repoKey);
  if (!repoKey) return badRequest("That project can't be shared: it needs a Git remote.");
  const machineKey = parseMachineKey(body.machineKey);
  const laneId = parseLaneId(body.laneId);
  if (!machineKey || !laneId) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const preset = parsePreset(body.preset);
  const risk = parseRisk(body.risk);
  if (!preset || !risk) return badRequest("That access level isn't one ADE offers.");
  const endsAt = parseEndsAt(body.endsAt, now);
  if (endsAt === false) return badRequest("The end date must be in the future and within a year.");
  const projectLabel = parseLabel(body.projectLabel);
  const laneLabel = parseLabel(body.laneLabel);
  if (projectLabel === false || laneLabel === false) return badRequest(UNREADABLE_REQUEST_MESSAGE);

  let shareBackOf: string | null = null;
  if (body.shareBackOf !== undefined) {
    const checked = await checkShareBack(env, userId, body.shareBackOf, receiverEmail, repoKey, now);
    if (checked instanceof Response) return checked;
    shareBackOf = checked;
  }

  const giver = await budgetedClerkAccount(env, userId, now);
  if (giver === "over_budget") return clerkBudgetSpent();
  if (!giver) return clerkUnavailable();
  if (giver.verifiedEmails.includes(receiverEmail)) {
    logLaneShare({ event: "lane_share.refused", userId, code: "self_invite" });
    return fail("self_invite", "That's your own email address. Invite someone else.", 400);
  }
  if (!(await ownsMachine(env, userId, machineKey))) {
    logLaneShare({ event: "lane_share.refused", userId, code: "unknown_machine" });
    return fail("unknown_machine", "That computer isn't on your ADE account.", 400);
  }
  const giverLabel = boundedDisplayText(giver.displayName, MAX_GIVER_LABEL);
  const fields = { receiverEmail, repoKey, machineKey, laneId, preset, risk, endsAt: endsAt ?? null, projectLabel, laneLabel, giverLabel };

  await settleLane(env, userId, laneId, now);
  const existing = await existingForAddress(env, userId, laneId, receiverEmail);
  if (existing?.state === "active") return alreadyShared(userId, existing.id);
  if (existing) return refreshInvite(env, userId, existing, fields, now, shareBackOf);

  const day = utcDayKey(now);
  if (!(await claimDay(env, day, giverSubject(userId), LANE_SHARE_DAILY_INVITES_PER_GIVER))) {
    logLaneShare({ event: "lane_share.refused", userId, code: "invite_limit" });
    return fail("invite_limit", `You can send ${LANE_SHARE_DAILY_INVITES_PER_GIVER} lane invites a day. Try again tomorrow.`, 429);
  }
  const id = newGrantId();
  let inserted: number;
  try {
    // The guest count and the insert are one statement, so two invites at once cannot make a sixth guest.
    const result = await env.DB.prepare(`
      insert into lane_shares (id, giver_user_id, receiver_email, repo_key, machine_key, lane_id, giver_label,
        project_label, lane_label, preset, risk, state, invite_expires_at, ends_at, version, created_at, updated_at)
      select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?, ?
      where (select count(*) from lane_shares where giver_user_id = ? and lane_id = ? and state in ${LIVE_STATES}) < ?
    `).bind(
      id, userId, receiverEmail, repoKey, machineKey, laneId, giverLabel, projectLabel, laneLabel, preset, risk,
      now + LANE_SHARE_INVITE_TTL_MS, endsAt ?? null, now, now,
      userId, laneId, LANE_SHARE_MAX_GUESTS_PER_LANE,
    ).run();
    inserted = result.meta?.changes ?? 0;
  } catch (error) {
    await refundDay(env, day, giverSubject(userId));
    if (!isUniqueViolation(error)) throw error;
    // A concurrent invite to the same address won the insert: this call refreshes it.
    const raced = await existingForAddress(env, userId, laneId, receiverEmail);
    if (raced?.state === "pending") return refreshInvite(env, userId, raced, fields, now, shareBackOf);
    return alreadyShared(userId, raced?.id ?? null);
  }
  if (inserted !== 1) {
    await refundDay(env, day, giverSubject(userId));
    logLaneShare({ event: "lane_share.refused", userId, code: "guest_limit" });
    return fail("guest_limit", `A lane can have at most ${LANE_SHARE_MAX_GUESTS_PER_LANE} guests. Remove one to invite someone else.`, 409);
  }
  const row = await reload(env, id);
  const email = await deliverInvite(env, row, now, true);
  logLaneShare({ event: "lane_share.invited", userId, grantId: id, emailSent: email.sent });
  return json(inviteResponse(await reload(env, id), now, false, email, shareBackOf), 201);
}

/**
 * A share back (`shareBackOf`): the grant must be active and between the
 * caller and the other person, for the same repository, and the address must
 * be one Clerk verified for that other person. Returns the grant id, or the
 * refusal. A grant the caller is not part of reads as not found.
 */
async function checkShareBack(
  env: LaneShareEnv,
  userId: string,
  value: unknown,
  receiverEmail: string,
  repoKey: string,
  now: number,
): Promise<string | Response> {
  if (typeof value !== "string" || !GRANT_ID.test(value)) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const row = await loadRow(env, value);
  if (!row || (row.giver_user_id !== userId && row.receiver_user_id !== userId)) return notFound();
  if (effectiveState(row, now) !== "active") return shareClosed();
  const otherUserId = row.giver_user_id === userId ? row.receiver_user_id : row.giver_user_id;
  const mismatch = () => {
    logLaneShare({ event: "lane_share.refused", userId, grantId: row.id, code: "share_back_mismatch" });
    return fail("share_back_mismatch", "A share back can go only to the other person of the lane share.", 400);
  };
  if (!otherUserId || row.repo_key !== repoKey) return mismatch();
  const other = await budgetedClerkAccount(env, userId, now, otherUserId);
  if (other === "over_budget") return clerkBudgetSpent();
  if (!other) return clerkUnavailable();
  if (!other.verifiedEmails.includes(receiverEmail)) return mismatch();
  return row.id;
}

type InviteFields = {
  receiverEmail: string;
  repoKey: string;
  machineKey: string;
  laneId: string;
  preset: LaneSharePreset;
  risk: LaneShareRisk;
  endsAt: number | null;
  projectLabel: string | null;
  laneLabel: string | null;
  giverLabel: string | null;
};

/** The live grant of one address on one lane, read after `settleLane`. */
async function existingForAddress(env: LaneShareEnv, giverUserId: string, laneId: string, email: string): Promise<ShareRow | null> {
  return env.DB.prepare(`
    select ${COLUMNS} from lane_shares
    where giver_user_id = ? and lane_id = ? and receiver_email = ? and state in ${LIVE_STATES}
    order by state = 'active' desc limit 1
  `).bind(giverUserId, laneId, email).first<ShareRow>();
}

export function alreadyShared(userId: string, grantId: string | null): Response {
  logLaneShare({ event: "lane_share.refused", userId, grantId: grantId ?? undefined, code: "already_shared" });
  return fail("already_shared", "This lane is already shared with that person.", 409);
}

/**
 * A second invite to an address with a pending invite on the same lane: the
 * 24 h window starts again, the invite takes the new access level and end
 * date, and the email goes again when the re-send limits allow.
 */
async function refreshInvite(
  env: LaneShareEnv,
  userId: string,
  row: ShareRow,
  fields: InviteFields,
  now: number,
  shareBackOf: string | null = null,
): Promise<Response> {
  const result = await env.DB.prepare(`
    update lane_shares set invite_expires_at = ?, preset = ?, risk = ?, ends_at = ?,
      project_label = coalesce(?, project_label), lane_label = coalesce(?, lane_label), giver_label = coalesce(?, giver_label),
      updated_at = ?, version = version + 1
    where id = ? and giver_user_id = ? and state = 'pending'
  `).bind(
    now + LANE_SHARE_INVITE_TTL_MS, fields.preset, fields.risk, fields.endsAt,
    fields.projectLabel, fields.laneLabel, fields.giverLabel, now, row.id, userId,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    // Accepted, revoked or declined between the read and this write.
    const current = await reload(env, row.id);
    return current.state === "active" ? alreadyShared(userId, row.id) : shareClosed();
  }
  const refreshed = await reload(env, row.id);
  const email = await deliverInvite(env, refreshed, now, false);
  logLaneShare({ event: "lane_share.refreshed", userId, grantId: row.id, emailSent: email.sent });
  return json(inviteResponse(await reload(env, row.id), now, true, email, shareBackOf), 200);
}

function inviteResponse(
  row: ShareRow,
  now: number,
  refreshed: boolean,
  email: { sent: boolean; reason: LaneShareEmailNotSentReason | null },
  shareBackOf: string | null,
): LaneShareInviteResponse {
  const grant = giverView(row, now);
  return { grant, refreshed, emailSent: email.sent, emailNotSentReason: email.reason, link: grant.link, shareBackOf };
}
