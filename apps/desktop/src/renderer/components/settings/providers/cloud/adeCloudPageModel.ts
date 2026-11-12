/**
 * One provider's page on ADE Cloud, as data: the account's sign-in cards
 * (K1–K6), the saved key row, and the line under the banner. Pure: no reads,
 * no React. Like `adeCloudSignInModel.ts`, every word the page says about a
 * sign-in lives here.
 */
import { CLOUD_SIGN_INS, cloudSignInKeyFor, type CloudSignInSpec, type CloudSignInStatus } from "../../../../../shared/cloudSignIns";
import { cloudChoiceKey } from "../../../../../shared/providerLoginsCloudSetting";
import {
  isClaudePassKey,
  type ProviderLoginProvider,
  type ProviderLoginSignIn,
} from "../../../../../shared/types/providerLogins";
import {
  adeCloudPageLine,
  ADE_CLOUD_REACH_LINE,
  signInAccountIdentity,
  type AdeCloudAccountPart,
  type AdeCloudCloudPart,
  type AdeCloudTile,
} from "./adeCloudSignInModel";
import { formatPiProviderLabel } from "../../../../../shared/modelRegistry";
import { agoText, dayText, parseTime } from "./adeCloudTime";

// ── The cards ────────────────────────────────────────────────────────────

export type SignInCardModel = {
  /**
   * The copy the card's actions name: the one ADE Cloud uses, else the
   * freshest. "Use on ADE Cloud" picks it, and the apply then takes the
   * freshest usable copy of the same account (`cloudPlacePicks`).
   */
  key: string;
  /** Every copy of this account in the account, one per computer, freshest first. The switch and Remove act on all. */
  keys: string[];
  /** How many computers it came from (one per copy). */
  computers: number;
  provider: ProviderLoginProvider;
  slot: string;
  place: string;
  /** The email, else "Sign-in from Mac Studio" (K4). */
  title: string;
  /** How the confirm and the toast name it: the email, else "the sign-in from Mac Studio". */
  name: string;
  /** The computer it came from (the freshest copy's), and whether that is this one. */
  origin: string;
  originIsThisComputer: boolean;
  /** "From Mac Studio (this computer) · today" (K5); "From 3 computers: …" for one account on several. */
  sourceLine: string;
  /** "Renewed by cloud-a 5 min ago" (K6). */
  renewedLine: string | null;
  /** "cloud-a renews it while Mac Studio is off." */
  renewsNowLine: string | null;
  on: boolean;
  /** K1. */
  inUse: boolean;
  /** For the order only (0 when unknown). */
  capturedMs: number;
};

export type SignInCardGroup = {
  place: string;
  /** "Pi · xAI" for a Pi place; null for every other provider (one group). */
  title: string | null;
  cards: SignInCardModel[];
};

/** When a copy was made or last renewed; 0 when unknown. */
function freshness(signIn: ProviderLoginSignIn): number {
  return parseTime(signIn.renewedAt) ?? parseTime(signIn.capturedAt) ?? 0;
}

function signInCard(signIn: ProviderLoginSignIn, now: number): SignInCardModel {
  const email = signIn.account?.email?.trim() || null;
  // A computer's GitHub CLI login for Copilot names its GitHub user, not an email.
  const ghUser = signIn.provider === "copilot" && signIn.slot === "gh" ? signIn.account?.id?.trim() || null : null;
  const origin = signIn.origin.label;
  const captured = parseTime(signIn.capturedAt);
  const source = `From ${origin}${signIn.origin.thisComputer ? " (this computer)" : ""}`;
  const renewedAt = parseTime(signIn.renewedAt);
  const renewedLine = signIn.class === "renewing" && renewedAt != null && signIn.renewedBy
    ? `Renewed by ${signIn.renewedBy} ${agoText(renewedAt, now)}`
    : null;
  const renewsNow = signIn.renewsNow ?? null;
  // A cloud computer took the renewal over while the computer it came from is off.
  const renewsNowLine = renewsNow?.cloudComputer && !renewsNow.thisComputer
    ? `${renewsNow.label} renews it while ${signIn.origin.thisComputer ? "this computer" : origin} is off.`
    : null;
  return {
    key: signIn.key,
    keys: [signIn.key],
    computers: 1,
    provider: signIn.provider,
    slot: signIn.slot,
    place: cloudChoiceKey(signIn.provider, signIn.slot),
    title: email ?? (ghUser ? `GitHub CLI login (${ghUser})` : `Sign-in from ${origin}`),
    name: email ?? (ghUser ? `the GitHub CLI login (${ghUser})` : `the sign-in from ${origin}`),
    origin,
    originIsThisComputer: signIn.origin.thisComputer,
    sourceLine: captured != null ? `${source} · ${dayText(captured, now)}` : source,
    renewedLine,
    renewsNowLine,
    on: signIn.onForCloud,
    inUse: signIn.inUseOnCloud,
    capturedMs: captured ?? 0,
  };
}

/**
 * One card for one account copied from several computers (B14-5): the
 * freshest copy speaks for it, "From 3 computers: …" says where it is, and
 * it is on, or in use, when any copy is.
 */
function accountCard(copies: ProviderLoginSignIn[], now: number): SignInCardModel {
  const ordered = [...copies].sort((a, b) => freshness(b) - freshness(a));
  const lead = ordered.find((signIn) => signIn.inUseOnCloud) ?? ordered[0]!;
  const card = signInCard(lead, now);
  if (ordered.length === 1) return card;
  const names = ordered.map((signIn) => `${signIn.origin.label}${signIn.origin.thisComputer ? " (this computer)" : ""}`);
  const newest = parseTime(ordered[0]!.renewedAt) ?? parseTime(ordered[0]!.capturedAt);
  const source = `From ${ordered.length} computers: ${names.join(", ")}`;
  return {
    ...card,
    keys: ordered.map((signIn) => signIn.key),
    computers: ordered.length,
    originIsThisComputer: ordered.some((signIn) => signIn.origin.thisComputer),
    sourceLine: newest != null ? `${source} · ${dayText(newest, now)}` : source,
    on: ordered.some((signIn) => signIn.onForCloud),
    inUse: ordered.some((signIn) => signIn.inUseOnCloud),
    capturedMs: Math.max(...ordered.map((signIn) => parseTime(signIn.capturedAt) ?? 0)),
  };
}

/**
 * The account's sign-ins for one provider, as card groups: one group, or one
 * per Pi place. Pi's Claude sign-in is never carried, so it has no card.
 * One card per account (email): the same account copied from several
 * computers is one card; separate cards only for different accounts.
 * `hidden` holds the keys whose Remove waits on its toast: a card with any
 * of them hidden is hidden whole (its Remove takes every copy).
 */
export function signInCardGroups(
  provider: ProviderLoginProvider,
  account: AdeCloudAccountPart,
  hidden: ReadonlySet<string>,
  now: number,
): SignInCardGroup[] {
  if (account.state !== "ok") return [];
  const signIns = account.status.signIns.filter((signIn) =>
    signIn.provider === provider
    && !isClaudePassKey(signIn.key)
    && !(provider === "pi" && signIn.slot === "anthropic"));
  // Copies of one account in one place, in the order they first appear.
  const copies = new Map<string, ProviderLoginSignIn[]>();
  for (const signIn of signIns) {
    const place = cloudChoiceKey(signIn.provider, signIn.slot);
    const identity = signInAccountIdentity(signIn);
    const bucket = `${place}\u0000${identity ?? `key:${signIn.key}`}`;
    copies.set(bucket, [...(copies.get(bucket) ?? []), signIn]);
  }
  const groups = new Map<string, SignInCardGroup>();
  for (const list of copies.values()) {
    if (list.some((signIn) => hidden.has(signIn.key))) continue;
    const card = accountCard(list, now);
    const group = groups.get(card.place) ?? {
      place: card.place,
      title: provider === "pi" ? `Pi · ${formatPiProviderLabel(card.slot)}` : null,
      cards: [],
    };
    group.cards.push(card);
    groups.set(card.place, group);
  }
  // Newest first, and never by which one is in use: a card must not move
  // when "Use on ADE Cloud" or its switch changes, or the next press lands
  // on another card.
  for (const group of groups.values()) {
    group.cards.sort((a, b) => b.capturedMs - a.capturedMs);
  }
  return [...groups.values()];
}

/** What "Use on ADE Cloud" changes back to: the pick before it, or null for "the newest switched-on". */
export function previousPick(account: AdeCloudAccountPart, place: string): string | null {
  if (account.state !== "ok") return null;
  // No pick means "the newest switched-on sign-in", which Undo restores as null.
  return account.status.cloud.inUse[place] ?? null;
}

/** The card in use for a place, for the confirm's "a turn that runs now finishes on …". */
export function inUseCard(groups: readonly SignInCardGroup[], place: string): SignInCardModel | null {
  return groups.find((group) => group.place === place)?.cards.find((card) => card.inUse) ?? null;
}

// ── The saved key row ────────────────────────────────────────────────────

export type SavedKeyRowModel = {
  spec: CloudSignInSpec;
  /** null before the read, or when the account can't be read. */
  saved: boolean | null;
  /** The account picks the key over every sign-in. */
  inUse: boolean;
  /** "Use on ADE Cloud" can pick it (Pi has no saved key of its own to pick). */
  canUse: boolean;
  /** "OpenCode and Pi read it." for the shared OpenRouter key. */
  sharedNote: string | null;
};

export function savedKeyRow(
  provider: ProviderLoginProvider,
  account: AdeCloudAccountPart,
  saved: CloudSignInStatus["saved"] | null,
): SavedKeyRowModel | null {
  // Pi and OpenCode share the OpenRouter key.
  const id = cloudSignInKeyFor(provider);
  const spec = id ? CLOUD_SIGN_INS.find((entry) => entry.id === id) ?? null : null;
  if (!spec) return null;
  const isSaved = saved ? saved.some((entry) => entry.id === spec.id && entry.saved) : null;
  const picked = account.state === "ok" ? account.status.cloud.inUse[provider] ?? null : null;
  const inUse = isSaved === true && picked === "key";
  return {
    spec,
    saved: isSaved,
    inUse,
    canUse: provider !== "pi" && isSaved === true && !inUse,
    sharedNote: spec.id === "openrouter" ? "OpenCode and Pi read it." : null,
  };
}

// ── The line under the banner ────────────────────────────────────────────

/**
 * One line: what ADE Cloud does with this provider now. "cloud-a uses the
 * sign-in from Mac Studio" when the reporting computer applied the one in
 * use; else the tile's own reason; and the page's reach line when no cloud
 * computer answered.
 */
export function providerPageLine(
  tile: AdeCloudTile,
  account: AdeCloudAccountPart,
  cloud: AdeCloudCloudPart,
): string {
  const page = adeCloudPageLine(account, cloud);
  if (tile.source === "saved-key") return "ADE Cloud uses the saved key.";
  if (cloud.state === "ok" && account.state === "ok") {
    const applied = (cloud.status.applied ?? []).find((entry) => entry.place === tile.provider && entry.state === "applied");
    const signIn = applied?.key ? account.status.signIns.find((entry) => entry.key === applied.key) : null;
    // Only when it is the one the account picks; else the tile says it is on its way.
    if (signIn?.inUseOnCloud && tile.state === "connected") return `${cloud.computerName} uses the sign-in from ${signIn.origin.label}.`;
  }
  // A working tile says where its sign-in is from first; any other tile ends on why.
  const reason = (tile.state === "connected" ? tile.facts[0] : tile.facts[tile.facts.length - 1])?.text ?? "";
  if (page.text !== ADE_CLOUD_REACH_LINE) return reason ? `${withStop(reason)} ${page.text}` : page.text;
  return withStop(reason);
}

function withStop(text: string): string {
  return !text || /[.!?]$/.test(text) ? text : `${text}.`;
}
