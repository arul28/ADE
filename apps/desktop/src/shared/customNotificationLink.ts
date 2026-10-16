import { buildDeeplink, parseDeeplink } from "./deeplinks";
import { isWorkBoardColumn, WORK_BOARD_COLUMN_LABEL } from "./types/chat";

/**
 * The link a custom notification (`ade notify`, the automations "Send
 * notification to mobile app" step) opens when tapped.
 *
 * The tap happens on the phone, so a link is only worth sending if the phone
 * can open it. The iOS router (`apps/ios/ADE/App/DeepLinkRouter.swift`) opens
 * a chat, a pull request, Activity (optionally on one column), a Linear issue,
 * or just ADE; a lane, file, commit, branch or proof link shows its "Send to
 * your computer" card instead. Anything else is a dead tap, which is why a
 * link is checked here rather than by its `ade://` prefix alone: an automation
 * whose `{{trigger.pr.number}}` resolved to nothing produced `ade://pr/`, and
 * the old prefix check sent it.
 */

/** Hosts the phone opens that the desktop deeplink grammar does not model. */
const PHONE_ONLY_HOSTS = new Set(["activity", "workspace"]);

const MAX_LINK_LENGTH = 1_024;

export type CustomNotificationLinkResult =
  | { ok: true; link: string }
  | { ok: false; problem: string };

/**
 * Accepts any ADE link ADE can open — the `ade://` form or the shareable
 * `https://ade-app.dev/open?…` form, which is converted to `ade://` because the
 * relay sends only that scheme — and says what is wrong with anything else.
 */
export function normalizeCustomNotificationLink(raw: string): CustomNotificationLinkResult {
  const value = raw.trim();
  if (!value) return { ok: false, problem: "The open link is empty." };
  if (value.length > MAX_LINK_LENGTH) {
    return { ok: false, problem: `The open link is longer than ${MAX_LINK_LENGTH} characters.` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, problem: `"${value}" is not a link. Use an ADE link such as ade://pr/123.` };
  }
  if (url.protocol === "ade:" && PHONE_ONLY_HOSTS.has(url.host.toLowerCase())) {
    if (url.pathname.replace(/\//g, "")) {
      return { ok: false, problem: `ade://${url.host} takes no path.` };
    }
    const state = url.searchParams.get("state");
    if (state != null && !isWorkBoardColumn(state)) {
      return {
        ok: false,
        problem: `ade://activity?state= must be one of ${Object.keys(WORK_BOARD_COLUMN_LABEL).join(", ")}.`,
      };
    }
    return { ok: true, link: value };
  }
  // `ade://pr/<number>` names no repo. The desktop grammar wants a repo or an
  // owner for it, and the sender adds the owner (its machine and project)
  // before the push leaves; the phone opens the short form either way.
  if (url.protocol === "ade:" && url.host.toLowerCase() === "pr" && /^\/[1-9]\d{0,8}$/.test(url.pathname)) {
    return { ok: true, link: value };
  }
  const parsed = parseDeeplink(value);
  if (!parsed.ok) {
    const reason = "reason" in parsed.error ? parsed.error.reason : parsed.error.kind.replace(/_/g, " ");
    return { ok: false, problem: `ADE can't open "${value}" (${reason}).` };
  }
  return {
    ok: true,
    // Keep the caller's exact `ade://` link (it may carry parameters the
    // desktop grammar does not model); rebuild only the https form.
    link: url.protocol === "ade:" ? value : buildDeeplink(parsed.target, { form: "ade" }),
  };
}

/**
 * Stamps the sending machine and project onto a chat or pull request link that
 * does not name its machine yet. The phone opens those on the machine the link
 * names (`accountMachineKey`); without it, it guesses the machine in front, and
 * a chat that lives elsewhere never opens. Other links are returned unchanged.
 */
export function stampCustomNotificationLinkOwner(
  link: string,
  owner: { accountMachineKey?: string | null; projectId?: string | null },
): string {
  const accountMachineKey = owner.accountMachineKey?.trim();
  const projectId = owner.projectId?.trim();
  if (!accountMachineKey || !projectId) return link;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return link;
  }
  const host = url.host.toLowerCase();
  if (url.protocol !== "ade:" || (host !== "session" && host !== "pr")) return link;
  // The desktop parser takes the two only together, so a half-stamped link
  // would be refused; a link that already names either is left as written.
  if (url.searchParams.has("accountMachineKey") || url.searchParams.has("projectId")) return link;
  url.searchParams.set("accountMachineKey", accountMachineKey);
  url.searchParams.set("projectId", projectId);
  return url.toString();
}
