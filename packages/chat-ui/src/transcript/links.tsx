/**
 * Every link chat-ui draws goes through `<AdeLink>`, so a host can decide what
 * opens and where.
 *
 * Without a handler a link keeps the web default: `target="_blank"` with
 * `rel="noreferrer noopener"`. In Electron that default opens a new,
 * chrome-less BrowserWindow that looks like part of the app, which makes link
 * text a model was prompted into writing a phishing surface. An Electron host
 * should pass `onLinkClick` and open allowed links with `shell.openExternal`
 * (and deny `window.open` in `setWindowOpenHandler` as a backstop).
 */

import { createContext, useContext, type MouseEvent, type ReactNode } from "react";

/** Where a link was drawn. */
export type AdeLinkSource =
  /** A link in rendered assistant markdown (model-written text). */
  | "markdown"
  /** The "Documentation" link on a provider card (`ProviderStatus.docsUrl`). */
  | "provider-docs";

export type AdeLinkClickInfo = {
  source: AdeLinkSource;
  /** The visible link text. For a bare URL it equals `href`. */
  text: string;
};

/**
 * Called instead of the browser default when the person activates a link.
 * chat-ui has already called `preventDefault()`: nothing opens unless the
 * handler opens it. `href` has passed `safeHref` (http, https, mailto, tel,
 * `#`, or a relative path) and is never `javascript:` or `data:`.
 */
export type AdeLinkClickHandler = (href: string, info: AdeLinkClickInfo) => void;

const LinkHandlerContext = createContext<AdeLinkClickHandler | null>(null);

/** Supplies `onLinkClick` to every `<AdeLink>` below it. */
export function AdeLinkHandlerProvider({
  onLinkClick,
  children,
}: {
  onLinkClick: AdeLinkClickHandler | undefined;
  children: ReactNode;
}) {
  const inherited = useContext(LinkHandlerContext);
  return (
    <LinkHandlerContext.Provider value={onLinkClick ?? inherited}>
      {children}
    </LinkHandlerContext.Provider>
  );
}

export function AdeLink({
  href,
  source,
  className,
  children,
}: {
  href: string;
  source: AdeLinkSource;
  className?: string;
  children: ReactNode;
}) {
  const onLinkClick = useContext(LinkHandlerContext);
  if (!onLinkClick) {
    return (
      <a className={className} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const text = event.currentTarget.textContent ?? href;
    onLinkClick(href, { source, text });
  };
  // No `target`: with a handler, the anchor never navigates by itself. `href`
  // stays so the link is focusable, shows its destination on hover, and
  // keyboard activation (Enter) reaches `onClick`.
  return (
    <a className={className} href={href} rel="noreferrer noopener" onClick={onClick}>
      {children}
    </a>
  );
}
