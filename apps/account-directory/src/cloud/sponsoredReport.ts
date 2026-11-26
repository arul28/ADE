import type { CloudSponsoredFormat } from "./contract";
import { ALL, INDEX_REPORT_URL, PLACEMENTS, PLATFORM_URL, SPLIT_ARMS, TURN_TTL_MS, type GravityEnv } from "./gravity";
import { utcDay } from "./plans";
import { readCloudSettings } from "./settings";
import { gravitySwitches } from "./sponsoredSwitch";

// The owner's side of sponsored cards (`gravity.ts` serves them): the
// twice-hourly clean-up, the formats' A/B scoreboard, and the daily report's
// lines with what Gravity paid.

/* ---- The owner's report ---- */

/**
 * The clean-up, twice an hour (minutes 23 and 53, every account, whatever the
 * switch): a reply's answer older than a day, and where a person watched from
 * (IP address, user agent, device, OS) once that is a day old, a computer
 * since deleted included. Nothing outlives a day by more than 30 minutes, or
 * an hour when one run fails. Every other tick makes no query.
 */
export async function pruneSponsored(env: GravityEnv, scheduledTime: number): Promise<void> {
  const minute = new Date(scheduledTime).getUTCMinutes();
  if (minute !== 23 && minute !== 53) return;
  const now = scheduledTime;
  await env.DB.batch([
    env.DB.prepare("delete from cloud_sponsored_turns where created_at < ?").bind(now - TURN_TTL_MS),
    env.DB.prepare("delete from cloud_sponsored_viewers where seen_at < ?").bind(now - TURN_TTL_MS),
  ]);
}

/* ---- The formats' A/B test ---- */

const FORMAT_WORDS: Record<CloudSponsoredFormat, string> = { below_reply: "under the reply", inline: "inline", above_prompt: "above the prompt box" };

/** Which format one of Gravity's placement rows is, by its id (`ade-<surface>-<slug>`) or its type. */
function formatOfPlacement(entry: Record<string, unknown>): CloudSponsoredFormat | null {
  const key = String(entry.placement_id ?? entry.slug ?? entry.placement ?? "");
  for (const [format, slot] of Object.entries(PLACEMENTS) as [CloudSponsoredFormat, (typeof PLACEMENTS)[CloudSponsoredFormat]][]) {
    if (key === slot.placement || key.endsWith(`-${slot.slug}`)) return format;
  }
  return null;
}

/**
 * The A/B scoreboard for the last `days` UTC days: each format's accounts
 * (its arm of the split, and their answers), ADE's own counts (card requests,
 * cards filled, cards hidden), and Gravity's per-placement report (views,
 * clicks, revenue), which pays on its own numbers. Gravity's part is null
 * when its report can't be read.
 */
export async function sponsoredAbReport(env: GravityEnv, now: number, days: number) {
  const settings = await readCloudSettings(env);
  const since = utcDay(now - (days - 1) * 24 * 60 * 60_000);
  const [counts, arms] = await Promise.all([
    env.DB.prepare("select kind, sum(count) as total from cloud_sponsored_days where user_id = ? and day >= ? and kind like 'ad_%:%' group by kind")
      .bind(ALL, since).all<{ kind: string; total: number }>(),
    env.DB.prepare(`
      select f.format, f.source, count(*) as accounts,
        coalesce(sum(c.consent = 'granted'), 0) as granted,
        -- A no a browser's Global Privacy Control made is no answer to the card's format.
        coalesce(sum(c.consent = 'declined' and c.source != 'gpc'), 0) as declined
      from cloud_sponsored_formats f left join cloud_sponsored_consent c on c.user_id = f.user_id
      group by f.format, f.source
    `).all<{ format: string; source: string; accounts: number; granted: number; declined: number }>(),
  ]);
  const total = new Map((counts.results ?? []).map((row) => [row.kind, row.total]));
  let gravity: Record<string, unknown>[] | null = null;
  if (env.GRAVITY_API_KEY?.trim()) {
    gravity = await fetch(`${PLATFORM_URL}/publisher-dashboard/placements?days=${days}`, {
      headers: { "x-api-key": env.GRAVITY_API_KEY.trim(), accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => {
      const body = response.ok ? await response.json() as { placements?: unknown } : null;
      return Array.isArray(body?.placements) ? body.placements as Record<string, unknown>[] : null;
    }).catch(() => null);
  }
  const weights = settings.gravity_format_split.split("-").map(Number);
  const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);
  return {
    format: settings.gravity_format,
    split: settings.gravity_format_split,
    days,
    since,
    gravityReadable: gravity != null,
    arms: SPLIT_ARMS.map((format, index) => {
      const arm = (arms.results ?? []).filter((row) => row.format === format);
      const inTest = arm.find((row) => row.source === "split");
      const requests = total.get(`ad_request:${format}`) ?? 0;
      const fills = total.get(`ad_fill:${format}`) ?? 0;
      const hides = total.get(`ad_hide:${format}`) ?? 0;
      const placements = gravity?.filter((entry) => formatOfPlacement(entry) === format) ?? null;
      const sum = (field: string) => (placements ?? []).reduce((acc, entry) => acc + (typeof entry[field] === "number" ? entry[field] as number : 0), 0);
      const impressions = sum("impressions");
      const clicks = sum("clicks");
      return {
        format,
        name: FORMAT_WORDS[format],
        weight: weights[index] ?? 0,
        accounts: inTest?.accounts ?? 0,
        granted: inTest?.granted ?? 0,
        declined: inTest?.declined ?? 0,
        ownerSet: arm.find((row) => row.source === "owner")?.accounts ?? 0,
        requests,
        fills,
        fillRate: ratio(fills, requests),
        hides,
        hidesPerCard: ratio(hides, fills),
        gravity: placements ? { impressions, clicks, ctr: ratio(clicks, impressions), revenue: Math.round(sum("revenue") * 100) / 100 } : null,
      };
    }),
  };
}

/**
 * Lines for the owner's daily report: ADE's own counts of the day, and what
 * Gravity says the day paid (ads and the Index), against `freeCostMicros`, the
 * day's cost of free-plan use. Nothing while the switch is off and the day
 * had no requests. Gravity's reports are best effort: a failed read says so.
 */
export async function sponsoredReportLines(env: GravityEnv, day: string, freeCostMicros: number | null): Promise<string[]> {
  const rows = (await env.DB.prepare("select kind, count from cloud_sponsored_days where day = ? and user_id = ?")
    .bind(day, ALL).all<{ kind: string; count: number }>()).results ?? [];
  const counts = new Map(rows.map((row) => [row.kind, row.count]));
  const { mode, live } = await gravitySwitches(env);
  if (mode === "off" && rows.length === 0) return [];
  const n = (kind: string) => counts.get(kind) ?? 0;
  const lines = [
    `Sponsored (${mode}${live ? ", live" : ", test ads"}): ${n("ad_request")} ad requests, ${n("ad_fill")} filled; ${n("index_request")} Index searches, ${n("index_pick")} picks.`,
  ];
  const byFormat = SPLIT_ARMS.filter((format) => n(`ad_request:${format}`) + n(`ad_fill:${format}`) + n(`ad_hide:${format}`) > 0)
    .map((format) => `${FORMAT_WORDS[format]} ${n(`ad_request:${format}`)} asked, ${n(`ad_fill:${format}`)} filled, ${n(`ad_hide:${format}`)} hidden`);
  if (byFormat.length) lines.push(`Formats (${(await readCloudSettings(env)).gravity_format}): ${byFormat.join("; ")}.`);
  if (!env.GRAVITY_API_KEY?.trim()) return lines;
  const key = env.GRAVITY_API_KEY.trim();
  const read = async (url: string): Promise<Record<string, unknown> | null> => {
    const response = await fetch(url, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    return response.ok ? await response.json() as Record<string, unknown> : null;
  };
  const [ads, index] = await Promise.all([
    read(`${PLATFORM_URL}/publisher-dashboard/stats?start_date=${day}&end_date=${day}`).catch(() => null),
    read(`${INDEX_REPORT_URL}?side=publisher&start_date=${day}&end_date=${day}`).catch(() => null),
  ]);
  const adUsd = typeof ads?.totalRevenue === "number" ? ads.totalRevenue : null;
  const summary = index?.summary && typeof index.summary === "object" ? index.summary as Record<string, unknown> : null;
  const indexUsd = typeof summary?.revenue_cents === "number" ? summary.revenue_cents / 100 : null;
  const freeCost = freeCostMicros == null ? "an unknown amount (couldn't be read)" : `$${(freeCostMicros / 1_000_000).toFixed(2)}`;
  lines.push(
    adUsd == null && indexUsd == null
      ? `Gravity's reports couldn't be read today. Free-plan cost: ${freeCost}.`
      : `Gravity paid ${adUsd == null ? "an unknown amount (report unreadable)" : `$${adUsd.toFixed(2)}`} for ads${typeof ads?.totalImpressions === "number" ? ` (${ads.totalImpressions} views, ${ads.totalClicks ?? 0} clicks)` : ""} and ${indexUsd == null ? "an unknown amount (report unreadable)" : `$${indexUsd.toFixed(2)}`} for the Index${typeof summary?.conversions === "number" ? ` (${summary.conversions} sign-ups)` : ""}, against ${freeCost} of free-plan cost.`,
  );
  return lines;
}
