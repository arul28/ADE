import { useCallback, useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Key } from "@phosphor-icons/react";
import type { BuiltInBrowserSaveLoginOffer } from "../../../../shared/types/builtInBrowserLoginCapture";
import { ipcErrorMessage } from "../../../lib/format";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { passwordFillTarget } from "../../../../shared/passwordFillTarget";
import { cn } from "../../ui/cn";
import { Banner } from "../../ui/notice";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_SEPARATOR_CLASS } from "../../ui/paneMenuTokens";
import { CHROME_GHOST, CHROME_GHOST_ON, CHROME_ICON_SIZE, CHROME_STATE_DOT, TOOLBAR_FOCUS, TOOLBAR_MOTION } from "./browserChrome";

type SavedLogin = { id: string; username: string | null; sites: string[] };

/**
 * Passwords in the browser's address bar, for the person.
 *
 * The 🔑 button lights up when Passwords has logins for the open page's site
 * (asked of desktop main, which reads the tab's own URL); picking one fills it
 * into the page. After the person signs in by hand, the same button opens
 * "Save to Passwords?" for what they typed. No value ever reaches this
 * component: main keeps them and the brain stores them.
 *
 * The browser tab is always on this computer, so these calls go to this
 * desktop's main process and need no machine pin.
 */
export function BrowserPasswordsButton({ tabId, currentUrl }: { tabId: string | null; currentUrl: string }) {
  const api = window.ade?.builtInBrowser;
  const [logins, setLogins] = useState<SavedLogin[]>([]);
  const [offer, setOffer] = useState<BuiltInBrowserSaveLoginOffer | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The page's saved logins, again whenever the tab or its address changes.
  useEffect(() => {
    let cancelled = false;
    setLogins([]);
    setError(null);
    if (!tabId || !api?.savedLoginsForTab || !passwordFillTarget(currentUrl)) return;
    void api.savedLoginsForTab({ tabId })
      .then((rows) => { if (!cancelled) setLogins(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setLogins([]); });
    return () => { cancelled = true; };
  }, [api, tabId, currentUrl]);

  // "Save to Passwords?" offers for this tab, and the one already open when the pane mounts.
  useEffect(() => {
    setOffer(null);
    if (!tabId || !api) return;
    let cancelled = false;
    void api.loginOfferForTab?.({ tabId }).then((existing) => { if (!cancelled && existing) setOffer(existing); }).catch(() => undefined);
    const unsubscribe = api.onEvent?.((raw) => {
      const event = raw as { type?: unknown; tabId?: unknown; offer?: BuiltInBrowserSaveLoginOffer | null };
      if (event.type !== "login-offer" || event.tabId !== tabId) return;
      setOffer(event.offer ?? null);
      if (event.offer) {
        setError(null);
        setOpen(true);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, tabId]);

  const fill = useCallback((itemId: string) => {
    if (!tabId || !api?.fillSavedLogin) return;
    setBusy(true);
    setError(null);
    void api.fillSavedLogin({ tabId, itemId })
      .then(() => setOpen(false))
      .catch((failure: unknown) => setError(ipcErrorMessage(failure) || "ADE could not fill that login."))
      .finally(() => setBusy(false));
  }, [api, tabId]);

  const answerOffer = useCallback((save: boolean) => {
    if (!offer || !api) return;
    const offerId = offer.offerId;
    setBusy(true);
    setError(null);
    const call = save ? api.acceptLoginOffer?.({ offerId }) : api.dismissLoginOffer?.({ offerId });
    void Promise.resolve(call)
      .then(() => {
        setOffer(null);
        setOpen(false);
        if (save && tabId) void api.savedLoginsForTab?.({ tabId }).then((rows) => setLogins(Array.isArray(rows) ? rows : []));
      })
      .catch((failure: unknown) => setError(ipcErrorMessage(failure) || "ADE could not save that login."))
      .finally(() => setBusy(false));
  }, [api, offer, tabId]);

  if (!api?.savedLoginsForTab || (!logins.length && !offer)) return null;
  const lit = logins.length > 0 || Boolean(offer);
  const title = offer ? `Save your login for ${offer.site} to Passwords?` : `Saved logins for this site (${logins.length})`;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="browser-passwords-button"
          title={title}
          aria-label={title}
          className={cn("relative", CHROME_GHOST, lit ? CHROME_GHOST_ON : null, TOOLBAR_MOTION, TOOLBAR_FOCUS)}
        >
          <Key size={CHROME_ICON_SIZE} weight={lit ? "fill" : "regular"} />
          {offer ? <span aria-hidden="true" className={cn(CHROME_STATE_DOT, "bg-[var(--color-accent)]")} /> : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={8} className={MENU_CONTENT_CLASS} data-testid="browser-passwords-menu">
          {offer ? (
            <>
              <div className={MENU_LABEL_CLASS}>
                {offer.updatesItemId ? "Update the saved password" : "Save to Passwords?"} · {offer.site}
              </div>
              <div className="px-2 pb-1 text-[11px] text-muted-fg">
                {offer.username ? offer.username : "No username"} · agents can use it, never see it
              </div>
              <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={busy} onSelect={(event) => { event.preventDefault(); answerOffer(true); }} data-testid="browser-passwords-save">
                {offer.updatesItemId ? "Update password" : "Save"}
              </DropdownMenu.Item>
              <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={busy} onSelect={(event) => { event.preventDefault(); answerOffer(false); }} data-testid="browser-passwords-not-now">
                Not now
              </DropdownMenu.Item>
              {logins.length ? <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} /> : null}
            </>
          ) : null}
          {logins.length ? <div className={MENU_LABEL_CLASS}>Sign in with</div> : null}
          {logins.map((login) => (
            <DropdownMenu.Item
              key={login.id}
              className={MENU_ITEM_CLASS}
              disabled={busy}
              onSelect={(event) => { event.preventDefault(); fill(login.id); }}
              data-testid="browser-passwords-login"
            >
              <span className="truncate">{login.username || "(no username)"}</span>
              <span className="ml-auto pl-3 text-[11px] text-muted-fg">{login.sites[0] ?? ""}</span>
            </DropdownMenu.Item>
          ))}
          {error ? <Banner layout="inline" model={{ id: "browser-passwords-error", tone: "error", title: error, report: false }} /> : null}
          <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => navigateToAppTarget({ kind: "settings", entryId: "passwords.logins" })}>
            Manage passwords…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
