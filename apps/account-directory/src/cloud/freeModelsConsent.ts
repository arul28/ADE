import { CLOUD_FREE_MODELS_TERMS_VERSION, type CloudSponsoredConsent } from "./contract";
import type { GravityEnv } from "./gravity";
import { countryCodesOf, gpcOptsOut, type SponsoredRequester } from "./sponsoredConsent";
import { logCloud, type CloudDb } from "./store";

// ADE Free Models' consent and country rules, shared by the proxy
// (`freeModels.ts`) and the cards in these chats (`gravity.ts` `handleAd`).
// Separate from the Free plan's sponsored-card answer: a paid account agrees
// here only to cards in the chats that use these models.

/** Where Gravity serves its models (2026-11): the US and Canada. */
const DEFAULT_INFERENCE_COUNTRIES = ["US", "CA"];

function inferenceCountriesOf(env: GravityEnv): string[] {
  const list = countryCodesOf(env.GRAVITY_INFERENCE_COUNTRIES);
  return list.length ? list : DEFAULT_INFERENCE_COUNTRIES;
}

/** Whether a country is outside `GRAVITY_INFERENCE_COUNTRIES`. An unknown one (no Cloudflare data, a local run) is inside. */
export function outsideInferenceCountries(env: GravityEnv, country: string | null | undefined): boolean {
  return Boolean(country) && !inferenceCountriesOf(env).includes(country!);
}

/**
 * The account's answer to the ADE Free Models sheet. `gpc` 1: a yes given
 * from a US browser that sends Global Privacy Control (it holds there).
 */
export type FreeConsentRow = {
  consent: CloudSponsoredConsent;
  email_hash: string | null;
  decided_at: number;
  country: string | null;
  region: string | null;
  gpc: number;
  terms_version: number;
};

/** The stored answer, whatever terms it was given for. */
export async function readFreeConsent(env: CloudDb, userId: string): Promise<FreeConsentRow | null> {
  return env.DB.prepare("select consent, email_hash, decided_at, country, region, gpc, terms_version from cloud_free_model_consent where user_id = ?")
    .bind(userId).first<FreeConsentRow>();
}

/** An answer given for older terms is no answer: the person is asked again. */
const current = (row: FreeConsentRow | null): row is FreeConsentRow => row != null && row.terms_version >= CLOUD_FREE_MODELS_TERMS_VERSION;

/** Global Privacy Control from the US turns a yes into a no, unless the yes was given from such a browser. */
const gpcOverrides = (row: FreeConsentRow | null, who: SponsoredRequester): boolean =>
  gpcOptsOut(who) && row?.consent === "granted" && !row.gpc;

/** Whether the account's yes lets these models run and their cards go to Gravity now. */
export const freeYesHolds = (row: FreeConsentRow | null, who: SponsoredRequester): row is FreeConsentRow =>
  current(row) && row.consent === "granted" && !gpcOverrides(row, who);

/** The answer clients see: null when the person is to be asked (never asked, or asked for older terms). */
export function shownFreeConsent(row: FreeConsentRow | null, who: SponsoredRequester): CloudSponsoredConsent | null {
  if (!current(row)) return null;
  if (row.consent === "declined") return "declined";
  return freeYesHolds(row, who) ? "granted" : null;
}

/** Deletes where the person watched these chats from, in the same transaction as the no it follows. */
export const clearFreeViewers = (env: CloudDb, userId: string): D1PreparedStatement =>
  env.DB.prepare("delete from cloud_free_model_viewers where user_id = ?").bind(userId);

/**
 * Turns a yes into a no when this request's Global Privacy Control overrides
 * it (`gpcOverrides`), on every device at once, with the viewer rows cleared
 * in the same transaction. Saved only over the answer it read. Returns the
 * answer as it now is.
 */
export async function honorFreeGpc(env: CloudDb, userId: string, read: FreeConsentRow | null, who: SponsoredRequester, now: number): Promise<FreeConsentRow | null> {
  if (!gpcOverrides(read, who)) return read;
  const [saved] = await env.DB.batch([
    env.DB.prepare(`
      update cloud_free_model_consent set consent = 'declined', email_hash = null, decided_at = ?, country = ?, region = ?, gpc = 0
      where user_id = ? and consent = 'granted' and decided_at = ?
    `).bind(now, who.country, who.region, userId, read!.decided_at),
    env.DB.prepare(`
      delete from cloud_free_model_viewers where user_id = ?
        and exists (select 1 from cloud_free_model_consent where user_id = ? and consent = 'declined' and decided_at = ?)
    `).bind(userId, userId, now),
  ]);
  if (!saved?.meta?.changes) return readFreeConsent(env, userId);
  logCloud("cloud.free_models.consent", { consent: "declined", source: "gpc" });
  return { ...read!, consent: "declined", email_hash: null, decided_at: now, country: who.country, region: who.region, gpc: 0 };
}

/** A chat the proxy served, with the last model call's usage. */
export type FreeModelChatRow = { last_at: number; last_usage_json: string | null };

/** The chat, when the proxy served it at or after `since`. */
export async function readFreeModelChat(env: CloudDb, userId: string, chatId: string, since: number): Promise<FreeModelChatRow | null> {
  return env.DB.prepare("select last_at, last_usage_json from cloud_free_model_chats where user_id = ? and chat_id = ? and last_at >= ?")
    .bind(userId, chatId, since).first<FreeModelChatRow>();
}
