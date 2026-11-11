/**
 * The end warning for ADE Cloud's sign-ins, as data (design §4.5): which
 * sign-in ADE Cloud uses that ends soon, or ended, and the words of the one
 * app banner. Pure: no reads, no React.
 *
 * Candidates, from the account part only (`providerLogins.status`):
 * - a Claude pass that is on for ADE Cloud and ending (`ending_soon`), past
 *   its expected end (`estimate_passed`) or ended (Claude refused it);
 * - a sign-in ADE Cloud uses that cannot renew (class `fixed`) and ends
 *   within three days (or has ended).
 * A renewing sign-in renews itself, so it is never a candidate here.
 */
import type { ProviderLoginProvider, ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { readClaudePasses, shortDate, type ReadableCloudPassRow } from "./adeCloudSignInModel";

const DAY_MS = 86_400_000;
/** A sign-in that cannot renew warns this many days before it ends (as its tile, T12). */
const SIGN_IN_WARN_DAYS = 3;

const PROVIDER_LABEL: Record<ProviderLoginProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
  copilot: "GitHub Copilot",
  grok: "Grok",
  droid: "Droid",
  kimi: "Kimi",
  qwen: "Qwen Code",
  devin: "Devin",
  antigravity: "Antigravity",
  muse: "Muse Code",
};

export type AdeCloudEndNotice = {
  /** The banner's durable dismissal: a new sign-in, state or date in the set brings it back. */
  fingerprint: string;
  tone: "warning" | "error";
  title: string;
  detail: string;
  provider: ProviderLoginProvider;
  /** A pass to renew (the approve sheet), or null for a sign-in made on a computer. */
  renewKey: string | null;
};

type Candidate = {
  key: string;
  provider: ProviderLoginProvider;
  /** Sorts the soonest first; an ended one sorts before any that still runs. */
  at: number;
  ended: boolean;
  fingerprint: string;
  title: string;
  detail: string;
  renewKey: string | null;
};

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function passCandidate(pass: ReadableCloudPassRow, now: number): Candidate | null {
  if (!pass.on) return null;
  const base = {
    key: pass.key,
    provider: "claude" as const,
    fingerprint: `${pass.key}:${pass.expiresAt ?? ""}:${pass.state}`,
    renewKey: pass.key,
  };
  switch (pass.state) {
    case "ended":
      return {
        ...base,
        at: pass.endedAt ?? now,
        ended: true,
        title: "Claude ended your pass for ADE Cloud",
        detail: pass.endedAt != null
          ? `Cloud chats can't use it since ${shortDate(pass.endedAt, now)}. Renew it to keep them working.`
          : "Cloud chats can't use it. Renew it to keep them working.",
      };
    case "estimate_passed":
      return {
        ...base,
        at: pass.expiresAt ?? now,
        ended: false,
        title: "Your Claude pass for ADE Cloud may have ended",
        detail: "Its expected end date has passed. Renew it to be sure cloud chats keep working.",
      };
    case "ending_soon": {
      const days = Math.max(0, Math.round(pass.endsInDays));
      return {
        ...base,
        at: pass.expiresAt ?? now + days * DAY_MS,
        ended: false,
        title: days === 0
          ? "Your Claude pass for ADE Cloud ends today"
          : `Your Claude pass for ADE Cloud ends in ${days} day${days === 1 ? "" : "s"}`,
        detail: "Renew it so cloud chats keep working.",
      };
    }
    default:
      return null;
  }
}

/** The one notice to show now, or null. With two or more, the soonest, and the detail counts the rest. */
export function adeCloudEndNotice(status: ProviderLoginStatus | null, now: number): AdeCloudEndNotice | null {
  if (!status || !status.cloud.enabled) return null;
  const candidates: Candidate[] = [];
  for (const pass of readClaudePasses(status)) {
    if (pass.unreadable) continue;
    const candidate = passCandidate(pass, now);
    if (candidate) candidates.push(candidate);
  }
  for (const signIn of status.signIns) {
    if (!signIn.inUseOnCloud || signIn.class !== "fixed") continue;
    const ends = parseTime(signIn.expiresAt);
    if (ends == null || ends - now > SIGN_IN_WARN_DAYS * DAY_MS) continue;
    const label = PROVIDER_LABEL[signIn.provider] ?? signIn.provider;
    const ended = ends <= now;
    candidates.push({
      key: signIn.key,
      provider: signIn.provider,
      at: ends,
      ended,
      fingerprint: `${signIn.key}:${signIn.expiresAt ?? ""}:${ended ? "ended" : "ending"}`,
      title: ended
        ? `The ${label} sign-in for ADE Cloud has ended`
        : `The ${label} sign-in for ADE Cloud ends on ${shortDate(ends, now)}`,
      detail: `Sign in to ${label} again on ${signIn.origin.label} to replace it.`,
      renewKey: null,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.ended === b.ended ? a.at - b.at : a.ended ? -1 : 1));
  const first = candidates[0]!;
  const more = candidates.length - 1;
  return {
    // Every candidate: a dismiss hides this set, and a new or changed one brings the banner back.
    fingerprint: candidates.map((candidate) => candidate.fingerprint).join("|"),
    tone: first.ended ? "error" : "warning",
    title: first.title,
    detail: more > 0 ? `${first.detail} ${more === 1 ? "1 more sign-in ends soon." : `${more} more sign-ins end soon.`}` : first.detail,
    provider: first.provider,
    renewKey: first.renewKey,
  };
}
