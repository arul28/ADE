/**
 * One provider's page on ADE Cloud, as data: the account's sign-in cards
 * (K1–K6), the saved key row, and the line under the banner. Pure: no reads,
 * no React. Like `adeCloudSignInModel.ts`, every word the page says about a
 * sign-in lives here.
 */
import { CLOUD_SIGN_INS, type CloudSignInId, type CloudSignInSpec, type CloudSignInStatus } from "../../../../../shared/cloudSignIns";
import {
  isClaudePassKey,
  type ProviderLoginProvider,
  type ProviderLoginSignIn,
} from "../../../../../shared/types/providerLogins";
import { adeCloudPageLine, ADE_CLOUD_REACH_LINE, type AdeCloudAccountPart, type AdeCloudCloudPart, type AdeCloudTile } from "./adeCloudSignInModel";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now", "5 min ago", "2 h ago", "3 days ago". Computed at render; nothing ticks. */
export function agoText(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  if (delta < MINUTE_MS) return "just now";
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)} min ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)} h ago`;
  const days = Math.floor(delta / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "today", "yesterday", "Nov 3", or "Nov 3, 2025" outside this year. */
export function dayText(ms: number, now: number): string {
  const day = new Date(ms);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday) return "today";
  if (ms >= startOfToday - DAY_MS) return "yesterday";
  const sameYear = day.getFullYear() === today.getFullYear();
  return day.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The ADE Cloud place of a sign-in: the provider, or `pi:<sub>` for Pi (the sync's `cloudChoiceKey`). */
export function cloudPlaceOf(provider: ProviderLoginProvider, slot: string): string {
  return provider === "pi" ? `pi:${slot}` : provider;
}

/** The names Pi's sub-providers show as ("Pi · xAI"). An unknown sub shows its own id. */
const PI_SUB_LABEL: Record<string, string> = {
  openai: "OpenAI",
  xai: "xAI",
  openrouter: "OpenRouter",
  google: "Google",
  gemini: "Gemini",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
};

// ── The cards ────────────────────────────────────────────────────────────

export type SignInCardModel = {
  key: string;
  provider: ProviderLoginProvider;
  slot: string;
  place: string;
  /** The email, else "Sign-in from Mac Studio" (K4). */
  title: string;
  /** How the confirm and the toast name it: the email, else "the sign-in from Mac Studio". */
  name: string;
  /** The computer it came from, and whether that is this one. */
  origin: string;
  originIsThisComputer: boolean;
  /** "From Mac Studio (this computer) · today" (K5). */
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

function signInCard(signIn: ProviderLoginSignIn, now: number): SignInCardModel {
  const email = signIn.account?.email?.trim() || null;
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
    provider: signIn.provider,
    slot: signIn.slot,
    place: cloudPlaceOf(signIn.provider, signIn.slot),
    title: email ?? `Sign-in from ${origin}`,
    name: email ?? `the sign-in from ${origin}`,
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
 * The account's sign-ins for one provider, as card groups: one group, or one
 * per Pi place. Pi's Claude sign-in is never carried, so it has no card.
 * `hidden` holds the keys whose Remove waits on its toast.
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
    && !hidden.has(signIn.key)
    && !(provider === "pi" && signIn.slot === "anthropic"));
  const groups = new Map<string, SignInCardGroup>();
  for (const signIn of signIns) {
    const card = signInCard(signIn, now);
    const group = groups.get(card.place) ?? {
      place: card.place,
      title: provider === "pi" ? `Pi · ${PI_SUB_LABEL[signIn.slot] ?? signIn.slot}` : null,
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

/** The saved ADE Cloud key that stands in for a provider. Pi and OpenCode share the OpenRouter key. */
const KEY_SPEC_FOR: Partial<Record<ProviderLoginProvider, CloudSignInId>> = {
  codex: "codex",
  cursor: "cursor",
  droid: "droid",
  grok: "grok",
  copilot: "copilot",
  devin: "devin",
  muse: "muse",
  opencode: "openrouter",
  pi: "openrouter",
};

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
  const id = KEY_SPEC_FOR[provider];
  const spec = id ? CLOUD_SIGN_INS.find((entry) => entry.id === id && entry.method === "key") ?? null : null;
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
  if (tile.row === "T6" || tile.row === "F3") return "ADE Cloud uses the saved key.";
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
