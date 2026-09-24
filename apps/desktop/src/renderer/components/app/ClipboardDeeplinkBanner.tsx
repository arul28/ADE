import React from "react";
import { Link as LinkIcon } from "@phosphor-icons/react";

import {
  buildDeeplink,
  describeTarget,
  looksLikeAdeDeeplink,
  parseDeeplink,
} from "../../../shared/deeplinks";
import { isWebClientMode } from "../../lib/webClientMode";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";

/**
 * Watches the system clipboard when the ADE window gains focus. If the
 * clipboard holds an `ade://` or `https://ade-app.dev/open` URL that we haven't
 * already prompted on, shows a quiet banner offering to open it.
 *
 * Desktop only, and not merely because the payoff is desktop-shaped (the banner
 * hands an `ade://` URL to `openExternal`, which in a browser tab means handing
 * ADE Web a link to itself). Reading the clipboard outside a paste gesture costs
 * nothing in Electron but is permission-gated in the browser: Safari answers
 * every speculative `readText()` with a "Paste" callout pinned to the pointer,
 * which swallows the click under it. Because this checked on every `focus`, and
 * because the callout itself takes focus, dismissing one callout re-fired the
 * read and produced the next — the whole app read as needing two clicks for
 * everything.
 */
export function ClipboardDeeplinkBanner(): null {
  const [candidate, setCandidate] = React.useState<{
    url: string;
    label: string;
  } | null>(null);
  const dismissedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (isWebClientMode()) return;
    const readApi = (window.ade?.app as { readClipboardText?: () => Promise<string> } | undefined)
      ?.readClipboardText;
    if (typeof readApi !== "function") return;
    const check = async () => {
      try {
        const text = await readApi();
        if (!text || !looksLikeAdeDeeplink(text)) {
          setCandidate(null);
          return;
        }
        const parsed = parseDeeplink(text);
        if (!parsed.ok) {
          setCandidate(null);
          return;
        }
        if (dismissedRef.current.has(text)) return;
        setCandidate({ url: text, label: describeTarget(parsed.target) });
      } catch {
        // ignore
      }
    };
    void check();
    const onFocus = () => {
      void check();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const onOpen = () => {
    if (!candidate) return;
    const opener = window.ade?.app?.openExternal;
    if (typeof opener === "function") {
      const parsed = parseDeeplink(candidate.url);
      const url = parsed.ok ? buildDeeplink(parsed.target, { form: "ade" }) : candidate.url;
      void opener(url).catch(() => {});
    }
    dismissedRef.current.add(candidate.url);
    setCandidate(null);
  };

  const onDismiss = () => {
    if (!candidate) return;
    dismissedRef.current.add(candidate.url);
    setCandidate(null);
  };

  useAppBanner(
    candidate
      ? {
          id: "clipboard-deeplink",
          tone: "accent",
          icon: <LinkIcon size={14} weight="bold" />,
          title: `Found ADE link in clipboard — open ${candidate.label}?`,
          actions: [{ label: "Open", variant: "solid", onClick: onOpen }],
          dismiss: { onDismiss },
        }
      : null,
    { placement: "floating", priority: APP_BANNER_PRIORITY.prompt },
  );

  return null;
}
