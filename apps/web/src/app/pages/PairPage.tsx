import { useEffect, useState } from "react";
import { ArrowUpRight, Smartphone } from "lucide-react";

import { Page } from "../../components/Page";
import { Section } from "../../components/Section";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { MARKETING_FEATURES } from "../../lib/marketingAnalytics";

/**
 * Hash-forward for desktop pairing QR codes.
 *
 * The ADE desktop app encodes pairing payloads as
 * `https://ade-app.dev/pair#<base64url-payload>`. Scanning with the iPhone
 * camera opens the ADE app directly; opening the same URL in a normal browser
 * lands here, and we forward to the hosted web client with the fragment intact.
 *
 * SECURITY: the payload lives ONLY in the URL fragment. Fragments are never
 * sent to the server, so we must keep it there end-to-end — never copy it into
 * a query string, never transmit it, never log it. We read `window.location`
 * directly (not the router) so nothing normalizes or forwards the value, and
 * build the destination href purely client-side.
 */
export function PairPage() {
  useDocumentTitle("Pairing with ADE");

  // Snapshot the fragment once on mount. Includes the leading "#" (or "").
  const [hash] = useState(() =>
    typeof window === "undefined" ? "" : window.location.hash
  );

  const target = `${LINKS.webClient}/pair${hash}`;

  useEffect(() => {
    if (!hash) return;
    // Forward immediately, preserving the fragment verbatim. `replace` keeps
    // the payload out of history on this origin.
    window.location.replace(target);
  }, [hash, target]);

  return (
    <Page>
      <Section className="pt-24">
        <div className="mx-auto max-w-xl space-y-6 text-center">
          <div className="inline-flex items-center justify-center rounded-full bg-emerald-500/10 px-4 py-1 text-emerald-300">
            <Smartphone className="mr-2 h-4 w-4" /> ADE pairing
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Pairing with ADE in your browser…
          </h1>
          <p className="text-zinc-400">
            {hash
              ? "Taking you to the ADE web client to finish pairing with your Mac."
              : "This link is missing its pairing code. Open a fresh pairing QR from the ADE desktop app."}
          </p>

          {hash ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-6 text-left text-sm">
              <div className="text-zinc-400">
                If nothing happens, continue manually:
              </div>
              <div className="mt-4">
                <a
                  href={target}
                  data-ade-analytics-feature={MARKETING_FEATURES.PAIR_IN_WEB_CLIENT}
                  className="inline-flex items-center justify-center rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400"
                >
                  <ArrowUpRight className="mr-1 h-4 w-4" /> Continue to the web client
                </a>
              </div>
            </div>
          ) : null}

          <p className="text-sm text-zinc-500">
            Scanning this code with your iPhone camera opens the ADE app instead.
          </p>
        </div>
      </Section>
    </Page>
  );
}
