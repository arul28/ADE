import crypto from "node:crypto";
import type { BuiltInBrowserLoginSubmission, BuiltInBrowserSaveLoginOffer } from "../../../shared/types/builtInBrowserLoginCapture";

/**
 * "Save to Passwords?" after the person signs in by hand in ADE's browser.
 *
 * The tab preload sends a submitted login (`preload/browserMedia.ts`); this
 * keeps the values in desktop main, and the renderer is told only the site and
 * the username. Nothing is saved until the person says so. An offer lives five
 * minutes, and one tab has at most one.
 *
 * Offers are made only for the tab's own main-frame page on https (or
 * localhost), only when Passwords is on, and never for a login that is already
 * saved with the same password.
 */

const OFFER_TTL_MS = 5 * 60_000;
/** A two-step sign-in's username, kept until its password page is sent. */
const USERNAME_STEP_TTL_MS = 10 * 60_000;

export type LoginOfferPasswords = {
  enabled(): Promise<boolean>;
  loginsForPage(pageUrl: string): Promise<Array<{ id: string; username: string | null }>>;
  resolveForFill(input: { itemId: string; pageUrl: string }): Promise<{ username: string; password: string } | null>;
  saveLogin(input: { id?: string; origins?: string[]; username?: string; password: string }): Promise<unknown>;
};

type Pending = BuiltInBrowserSaveLoginOffer & { origin: string; password: string; expiresAt: number };

/** The page's origin and the site to show, or null when Passwords won't save for it. */
export function loginOfferTarget(pageUrl: string): { origin: string; site: string } | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return { origin: url.origin, site: url.hostname.replace(/^www\./, "") };
}

export function createBuiltInBrowserLoginOffers(deps: {
  passwords: LoginOfferPasswords | null;
  /** Tell the window showing the tab about a new offer (or that it is gone: null). */
  emit: (tabId: string, offer: BuiltInBrowserSaveLoginOffer | null) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}) {
  const now = deps.now ?? (() => Date.now());
  const offersByTab = new Map<string, Pending>();
  const usernameSteps = new Map<string, { origin: string; username: string; at: number }>();

  const drop = (tabId: string) => {
    if (offersByTab.delete(tabId)) deps.emit(tabId, null);
  };

  async function handleSubmission(input: {
    tabId: string;
    pageUrl: string;
    /** False for anything sent from a frame inside the page. */
    mainFrame: boolean;
    submission: BuiltInBrowserLoginSubmission;
  }): Promise<void> {
    const passwords = deps.passwords;
    if (!passwords || !input.mainFrame) return;
    const target = loginOfferTarget(input.pageUrl);
    if (!target) return;
    const typedUsername = input.submission.username?.trim() || null;
    if (!input.submission.password) {
      if (typedUsername) usernameSteps.set(input.tabId, { origin: target.origin, username: typedUsername, at: now() });
      return;
    }
    const step = usernameSteps.get(input.tabId);
    const username = typedUsername
      ?? (step && step.origin === target.origin && now() - step.at < USERNAME_STEP_TTL_MS ? step.username : null);
    usernameSteps.delete(input.tabId);
    const password = input.submission.password;
    try {
      if (!(await passwords.enabled())) return;
      const saved = await passwords.loginsForPage(input.pageUrl);
      const sameUser = saved.find((login) => (login.username ?? "") === (username ?? ""));
      let updatesItemId: string | null = null;
      if (sameUser) {
        const values = await passwords.resolveForFill({ itemId: sameUser.id, pageUrl: input.pageUrl });
        if (values?.password === password) return;
        updatesItemId = sameUser.id;
      }
      const offer: Pending = {
        offerId: crypto.randomUUID(),
        tabId: input.tabId,
        site: target.site,
        username,
        updatesItemId,
        origin: target.origin,
        password,
        expiresAt: now() + OFFER_TTL_MS,
      };
      offersByTab.set(input.tabId, offer);
      deps.emit(input.tabId, publicOffer(offer));
    } catch (error) {
      // Passwords off, signed out, or the brain away: no offer, and no value in the log.
      deps.warn("built_in_browser.login_offer_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }

  function find(offerId: string): Pending | null {
    for (const offer of offersByTab.values()) {
      if (offer.offerId !== offerId) continue;
      if (offer.expiresAt <= now()) {
        drop(offer.tabId);
        return null;
      }
      return offer;
    }
    return null;
  }

  return {
    handleSubmission,

    /** The tab's open offer (for a window that mounts after it was made). */
    offerForTab(tabId: string): BuiltInBrowserSaveLoginOffer | null {
      const offer = offersByTab.get(tabId);
      if (!offer || offer.expiresAt <= now()) return null;
      return publicOffer(offer);
    },

    async accept(offerId: string): Promise<{ saved: boolean }> {
      const offer = find(offerId);
      if (!offer || !deps.passwords) return { saved: false };
      // An update changes only the password; the login keeps its own sites.
      await deps.passwords.saveLogin(offer.updatesItemId
        ? { id: offer.updatesItemId, password: offer.password }
        : { origins: [offer.origin], username: offer.username ?? "", password: offer.password });
      drop(offer.tabId);
      return { saved: true };
    },

    dismiss(offerId: string): void {
      const offer = find(offerId);
      if (offer) drop(offer.tabId);
    },

    /** A closed tab takes its offer and any half-done sign-in with it. */
    forgetTab(tabId: string): void {
      usernameSteps.delete(tabId);
      drop(tabId);
    },
  };
}

function publicOffer(offer: Pending): BuiltInBrowserSaveLoginOffer {
  return {
    offerId: offer.offerId,
    tabId: offer.tabId,
    site: offer.site,
    username: offer.username,
    updatesItemId: offer.updatesItemId,
  };
}

export type BuiltInBrowserLoginOffers = ReturnType<typeof createBuiltInBrowserLoginOffers>;
