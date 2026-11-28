/**
 * Keeping DAEX Cloud Macs' NoMac drives: each channel's template drive (the
 * owner's setting, `POST /cloud/owner/mac-template`), and the daily upkeep
 * that wakes a kept drive, or a template, before NoMac's 30 days without use
 * delete it. A person's start never waits on an upkeep session
 * (`clearUpkeepFor`, `upkeepClaimOf` in `startMac`).
 */

import { sendOwnerAlert } from "./blocks";
import { fail, json } from "./http";
import { isLiveSession, isoMs, macCall, macLabelOf, macLabelPrefix, macSessionOf, readSession, type MacSession } from "./macNomac";
import { errorOf } from "./phoneNomac";
import { MAC_COST_MICROS_PER_MINUTE } from "./plans";
import { logCloud, readSetting, reportCloudFailure, type CloudEnv, type ComputerRow } from "./store";

const DAY_MS = 24 * 60 * 60_000;
/** NoMac deletes a drive after 30 days with no session; ADE wakes a kept drive after this many. */
export const MAC_DRIVE_UPKEEP_DAYS = 25;
/** The most kept drives one daily run wakes for upkeep: five days of slack before NoMac's 30 covers 250 drives a run. */
const MAC_UPKEEP_PER_RUN = 50;
/** An upkeep session waits in NoMac's line at most this long (NoMac's shortest). */
const MAC_UPKEEP_QUEUE_SECONDS = 300;
/** A start waits while an upkeep session began this recently: its line (5 minutes), its run (2) and a minute. */
const MAC_UPKEEP_HOLD_MS = 8 * 60_000;

/* ---- The template drives ---- */

const MAC_CHANNELS = ["stable", "beta"] as const;
/** A template drive's name: this environment's prefix, `template`, its channel (`infra/ade-cloud-mac/build-template.mjs`). */
const templateDriveName = (env: Pick<CloudEnv, "MAC_LABEL_PREFIX">, channel: string): string => `${macLabelPrefix(env)}template:${channel}`;
export const MAC_VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export const OWNER_MAC_TEMPLATE_PATH = "/cloud/owner/mac-template";

/**
 * `POST /cloud/owner/mac-template` (the owner token, checked in `safety.ts`):
 * a channel's template drive (`mac_template_drive_<channel>`) and the DAEX
 * release its Macs start on (`mac_min_version_<channel>`). `{}` reads both
 * channels. A drive is accepted only under its own name in this environment
 * (`<prefix>template:<channel>`) and only once NoMac has it, so no setting
 * names a drive every first start would fail on. `""` clears either.
 */
export async function handleOwnerMacTemplate(env: CloudEnv, body: Record<string, unknown>, now: number): Promise<Response> {
  if (body.channel !== undefined) {
    const channel = body.channel;
    if (channel !== "stable" && channel !== "beta") return fail("bad_request", "channel is stable or beta.", 400);
    const statements: D1PreparedStatement[] = [];
    const put = (key: string, value: string) => statements.push(value
      ? env.DB.prepare("insert into cloud_settings (key, value, updated_at) values (?, ?, ?) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at").bind(key, value, now)
      : env.DB.prepare("delete from cloud_settings where key = ?").bind(key));
    if (body.drive !== undefined) {
      const drive = typeof body.drive === "string" ? body.drive.trim() : null;
      const expected = templateDriveName(env, channel);
      if (drive === null || (drive && drive !== expected)) return fail("bad_request", `drive is ${expected} here (or "" to clear).`, 400);
      if (drive) {
        const drives = await macCall(env, "GET", "/mac/drives");
        const list = Array.isArray(drives.body?.drives) ? drives.body.drives as Array<{ name?: unknown; saving?: unknown }> : null;
        if (!list) return fail("try_again", "NoMac's drives couldn't be read. Try again.", 503);
        const found = list.find((entry) => entry.name === drive);
        if (!found) return fail("bad_request", `NoMac has no drive ${drive}. Build it first (infra/ade-cloud-mac/build-template.mjs).`, 400);
        if (found.saving) return fail("try_again", `${drive} is still saving. Try again when its save ends.`, 409);
      }
      put(`mac_template_drive_${channel}`, drive);
    }
    if (body.minVersion !== undefined) {
      const version = typeof body.minVersion === "string" ? body.minVersion.trim().replace(/^v/, "") : null;
      if (version === null || (version && !MAC_VERSION_SHAPE.test(version))) return fail("bad_request", "minVersion is a release such as 1.2.150 (or \"\" to clear).", 400);
      put(`mac_min_version_${channel}`, version);
    }
    if (statements.length) {
      statements.push(env.DB.prepare("insert into cloud_owner_log (at, action, user_id, detail) values (?, 'mac_template', null, ?)")
        .bind(now, JSON.stringify({ channel, drive: body.drive ?? null, minVersion: body.minVersion ?? null })));
      await env.DB.batch(statements);
      logCloud("cloud.owner_mac_template", { channel });
    }
  }
  const channels: Record<string, { drive: string | null; minVersion: string | null }> = {};
  for (const channel of MAC_CHANNELS) {
    channels[channel] = {
      drive: (await readSetting(env, `mac_template_drive_${channel}`))?.trim() || null,
      minVersion: (await readSetting(env, `mac_min_version_${channel}`))?.trim() || null,
    };
  }
  return json({ ok: true, channels });
}

/**
 * The template drive a Mac of `row`'s channel starts from: its channel's, else stable's (beta's DAEX comes
 * from `mac_min_version_beta` at boot). Null when the owner set none: no Mac may start then, because NoMac
 * copies a template only into a drive it makes, so a drive made empty never gets one.
 */
export async function templateDriveFor(env: CloudEnv, row: Pick<ComputerRow, "channel">): Promise<string | null> {
  const read = async (key: string) => (await readSetting(env, key))?.trim() || null;
  return (row.channel === "beta" ? await read("mac_template_drive_beta") : null)
    ?? await read("mac_template_drive_stable")
    ?? await read("mac_template_drive");
}

/* ---- Upkeep ---- */

/** An upkeep start in flight: its row's `session_id` until NoMac answers it (`runMacDriveUpkeep`). */
const UPKEEP_MARKER_PREFIX = "upkeep-pending:";
const isUpkeepMarker = (sessionId: string): boolean => sessionId.startsWith(UPKEEP_MARKER_PREFIX);

type OpenUpkeep = { session_id: string; instance_id: string; end_reason: string | null; created_at: number };

/** The computer's upkeep sessions DAEX hasn't seen end, from the last `MAC_UPKEEP_HOLD_MS`. */
async function openUpkeepOf(env: CloudEnv, instanceId: string, now: number): Promise<OpenUpkeep[]> {
  return (await env.DB.prepare(`select session_id, instance_id, end_reason, created_at from cloud_mac_sessions
    where instance_id = ? and upkeep = 1 and coalesce(end_reason, '') <> 'drive_save' and ended_at is null and created_at > ?`)
    .bind(instanceId, now - MAC_UPKEEP_HOLD_MS).all<OpenUpkeep>()).results ?? [];
}

/** Stops an upkeep session for a person's start; its row stays open, so its ready time still counts as use (`settleUpkeepSessions`). */
export async function stopUpkeepSession(env: CloudEnv, sessionId: string): Promise<void> {
  await macCall(env, "DELETE", `/mac/sessions/${encodeURIComponent(sessionId)}?confirm=true`);
  await env.DB.prepare("update cloud_mac_sessions set end_reason = coalesce(end_reason, 'person_start') where session_id = ?").bind(sessionId).run();
  logCloud("cloud.mac_upkeep_stopped_for_start", {});
}

/**
 * Before a person's start: every live upkeep session of the computer is
 * stopped (a start right after a stop waits for its save, at NoMac, free).
 * `hold` while an upkeep start is still in flight or NoMac can't be read.
 */
export async function clearUpkeepFor(env: CloudEnv, instanceId: string, now: number): Promise<"clear" | "hold"> {
  let hold = false;
  for (const entry of await openUpkeepOf(env, instanceId, now)) {
    if (isUpkeepMarker(entry.session_id)) {
      hold = true;
      continue;
    }
    const session = await readSession(env, entry.session_id);
    if (session === "unreadable") {
      hold = true;
    } else if (!session || !isLiveSession(session)) {
      await settleUpkeepEntry(env, entry, session, now);
    } else if (session.state !== "stopping" && entry.end_reason !== "person_start") {
      await stopUpkeepSession(env, entry.session_id);
    }
  }
  return hold ? "hold" : "clear";
}

/** Whether `sessionId` (a start's `reuse` answer) is upkeep's: `session` known, `pending` while an upkeep start is in flight, else null. */
export async function upkeepClaimOf(env: CloudEnv, instanceId: string, sessionId: string, now: number): Promise<"session" | "pending" | null> {
  const open = await openUpkeepOf(env, instanceId, now);
  if (open.some((entry) => entry.session_id === sessionId)) return "session";
  return open.some((entry) => isUpkeepMarker(entry.session_id)) ? "pending" : null;
}

/**
 * The daily upkeep: a Mac lane kept with its drive unused for
 * `MAC_DRIVE_UPKEEP_DAYS` gets a short session so NoMac's 30-day rule never
 * deletes a drive DAEX still keeps. DAEX pays (`upkeep = 1`), the person is
 * never billed (the row's session stays its own, so the meter never opens).
 * The drive counts as used only once NoMac says a session reached ready: each
 * run first reads the upkeep sessions it started before, and a drive whose
 * upkeep never ran (NoMac's line, a failure) is tried again the next day.
 */
export async function runMacDriveUpkeep(env: CloudEnv, now: number): Promise<number> {
  if (!env.NOMAC_API_KEY?.trim()) return 0;
  await settleUpkeepSessions(env, now);
  const due = await env.DB.prepare(`
    select c.instance_id, c.user_id, c.mac_label from cloud_computers c
    where c.provider = 'nomac' and c.deleted_at is null and c.instance_id not like 'pending:%' and c.mac_session_id is null
      and coalesce(c.mac_state, 'stopped') = 'stopped' and coalesce(c.mac_last_session_at, c.created_at) < ?
      and not exists (select 1 from cloud_mac_sessions u where u.instance_id = c.instance_id and u.upkeep = 1 and u.ended_at is null
        and coalesce(u.end_reason, '') <> 'drive_save')
    order by coalesce(c.mac_last_session_at, c.created_at) limit ?
  `).bind(now - MAC_DRIVE_UPKEEP_DAYS * DAY_MS, MAC_UPKEEP_PER_RUN).all<{ instance_id: string; user_id: string; mac_label: string | null }>();
  let started = 0;
  for (const row of due.results ?? []) {
    const label = row.mac_label ?? macLabelOf(env, row.instance_id);
    const day = new Date(now).toISOString().slice(0, 10);
    // The claim comes before the POST, so a person's start meanwhile sees it (`clearUpkeepFor`) and never gets this
    // two-minute session through `reuse`.
    const marker = `${UPKEEP_MARKER_PREFIX}${row.instance_id}:${day}`;
    const claimed = await env.DB.prepare(`insert into cloud_mac_sessions (session_id, instance_id, user_id, created_at, cost_micros, upkeep)
      select ?, ?, ?, ?, 0, 1 where exists (select 1 from cloud_computers where instance_id = ? and deleted_at is null and mac_session_id is null
        and coalesce(mac_state, 'stopped') = 'stopped') on conflict (session_id) do nothing`)
      .bind(marker, row.instance_id, row.user_id, now, row.instance_id).run();
    if ((claimed.meta?.changes ?? 0) !== 1) continue;
    const answer = await macCall(env, "POST", "/mac/sessions", {
      label, reuse: true, require_drive: true, queue_seconds: MAC_UPKEEP_QUEUE_SECONDS,
      limits: { max_duration_seconds: 120, idle_timeout_seconds: 60, spend_cap_microunits: String(3 * MAC_COST_MICROS_PER_MINUTE) },
    }, `ade-mac-upkeep-${row.instance_id}-${day}`);
    const session = macSessionOf(answer.body?.session);
    if (answer.status >= 300 || !session || answer.body?.reused === true) {
      // Refused, or `reuse` answered a Mac the person started meanwhile (that one is theirs, and it uses the drive).
      await env.DB.prepare("update cloud_mac_sessions set ended_at = ?, end_reason = ? where session_id = ?")
        .bind(now, session ? "upkeep_reused" : "upkeep_never_ran", marker).run();
      if (!session) reportCloudFailure("cloud.mac_upkeep_failed", { instanceId: row.instance_id, status: answer.status, code: errorOf(answer).code }, "cloud-mac");
      continue;
    }
    // Its cost is its two-minute ceiling, for the owner's report: NoMac never reports a session that isn't a row's own.
    // The drive's clock moves only when this session is seen ready (`settleUpkeepSessions`).
    await env.DB.prepare("update cloud_mac_sessions set session_id = ?, cost_micros = ? where session_id = ?")
      .bind(session.id, 2 * MAC_COST_MICROS_PER_MINUTE, marker).run();
    started += 1;
  }
  if (started) logCloud("cloud.mac_upkeep", { started });
  await keepTemplateDrives(env, now);
  return started;
}

/**
 * The channels' template drives obey NoMac's 30-day rule too (a copy may not
 * count as their use): one unused for `MAC_DRIVE_UPKEEP_DAYS` gets a short
 * session of its own. Without it every first Mac start would fail with
 * `drive_not_found`. No label: it is the account's own Mac, which receives the
 * account's secrets and signing; the account keeps none.
 */
async function keepTemplateDrives(env: CloudEnv, now: number): Promise<void> {
  const names = new Set<string>();
  for (const channel of MAC_CHANNELS) {
    const name = (await readSetting(env, `mac_template_drive_${channel}`))?.trim();
    if (name) names.add(name);
  }
  if (names.size === 0) return;
  const drives = await macCall(env, "GET", "/mac/drives");
  const list = Array.isArray(drives.body?.drives) ? drives.body.drives as Array<{ name?: unknown; last_used_at?: unknown; in_use?: unknown; saving?: unknown }> : [];
  const day = new Date(now).toISOString().slice(0, 10);
  for (const name of names) {
    const drive = list.find((entry) => entry.name === name);
    if (!drive) {
      reportCloudFailure("cloud.mac_template_missing", { name }, "cloud-mac");
      await sendOwnerAlert(env, {
        key: `nomac_mac_template:${name}:${day}`,
        kind: "nomac_mac_template_missing",
        userId: null,
        subject: "DAEX Cloud: a Mac template drive is missing",
        reason: `NoMac has no drive ${name}, so every first DAEX Cloud Mac on its channel fails to start. Build it again with infra/ade-cloud-mac/build-template.mjs.`,
      }, now);
      continue;
    }
    const lastUsed = isoMs(typeof drive.last_used_at === "string" ? drive.last_used_at : null) ?? 0;
    if (drive.in_use || drive.saving || now - lastUsed < MAC_DRIVE_UPKEEP_DAYS * DAY_MS) continue;
    const answer = await macCall(env, "POST", "/mac/sessions", {
      access: { drive: name }, queue_seconds: MAC_UPKEEP_QUEUE_SECONDS,
      limits: { max_duration_seconds: 120, idle_timeout_seconds: 60, spend_cap_microunits: String(3 * MAC_COST_MICROS_PER_MINUTE) },
    }, `ade-mac-template-upkeep-${name}-${day}`);
    if (answer.status >= 300) reportCloudFailure("cloud.mac_template_upkeep_failed", { name, status: answer.status, code: errorOf(answer).code }, "cloud-mac");
    else logCloud("cloud.mac_template_upkeep", { name });
  }
}

/** The upkeep sessions not yet settled: ready ones move their drive's clock, ended ones close; nothing else counts as use. */
async function settleUpkeepSessions(env: CloudEnv, now: number): Promise<void> {
  const open = await env.DB.prepare(`
    select session_id, instance_id, created_at from cloud_mac_sessions
    where upkeep = 1 and ended_at is null and coalesce(end_reason, '') <> 'drive_save' order by created_at limit ?
  `).bind(MAC_UPKEEP_PER_RUN * 2).all<{ session_id: string; instance_id: string; created_at: number }>();
  for (const entry of open.results ?? []) {
    if (isUpkeepMarker(entry.session_id)) {
      // An upkeep start that never got NoMac's answer (the Worker stopped mid-call): it never ran. A session NoMac
      // made for it has no row, so the orphan sweep stops it.
      if (now - entry.created_at > MAC_UPKEEP_HOLD_MS) {
        await env.DB.prepare("update cloud_mac_sessions set ended_at = ?, end_reason = coalesce(end_reason, 'upkeep_never_ran') where session_id = ?").bind(now, entry.session_id).run();
      }
      continue;
    }
    const session = await readSession(env, entry.session_id);
    if (session === "unreadable") continue;
    await settleUpkeepEntry(env, entry, session, now);
  }
}

/** One upkeep session as NoMac reports it: ready moves its drive's clock, ended closes it. */
async function settleUpkeepEntry(env: CloudEnv, entry: Pick<OpenUpkeep, "session_id" | "instance_id">, session: MacSession | null, now: number): Promise<void> {
  const readyAt = session ? isoMs(session.ready_at) : null;
  const ended = !session || !isLiveSession(session);
  const statements: D1PreparedStatement[] = [];
  if (readyAt != null) {
    statements.push(env.DB.prepare("update cloud_computers set mac_last_session_at = max(coalesce(mac_last_session_at, 0), ?) where instance_id = ?").bind(readyAt, entry.instance_id));
  }
  if (ended) {
    statements.push(env.DB.prepare("update cloud_mac_sessions set ended_at = ?, ready_at = coalesce(ready_at, ?), end_reason = coalesce(end_reason, ?) where session_id = ?")
      .bind(session ? (isoMs(session.shutdown_at) ?? now) : now, readyAt, readyAt != null ? "upkeep" : "upkeep_never_ran", entry.session_id));
  }
  if (statements.length) await env.DB.batch(statements);
}
