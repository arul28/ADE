import { ArrowUpRight, Smartphone } from "lucide-react";

import { Badge } from "../../components/Badge";
import { LinkButton } from "../../components/LinkButton";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { Section } from "../../components/Section";
import { LINKS } from "../../lib/links";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { MARKETING_FEATURES } from "../../lib/marketingAnalytics";

/**
 * Landing page for the desktop's phone-pairing QR code.
 *
 * The ADE desktop app encodes phone-pairing payloads as
 * `https://ade-app.dev/pair#<payload>`. Scanning with the iPhone camera opens
 * the ADE app directly to finish pairing. The only visitors who reach this HTML
 * are people who opened the same URL on a device WITHOUT the ADE app — so the
 * page's whole job is to point them at the iPhone app.
 *
 * SECURITY: the pairing payload lives ONLY in the URL fragment. This page reads
 * nothing from `window.location` — not the fragment, not the query. There is no
 * value to copy, transmit, or log, and nothing here ever forwards it anywhere.
 */
export function PairPage() {
  useDocumentTitle("Get ADE for iPhone");

  return (
    <Page>
      <Section className="pt-20 sm:pt-24">
        <div className="mx-auto max-w-xl">
          <Reveal>
            <Badge className="bg-card/50">
              <Smartphone className="h-4 w-4" />
              iPhone pairing
            </Badge>
          </Reveal>
          <Reveal delay={0.05}>
            <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-fg sm:text-5xl">
              Get ADE for iPhone.
            </h1>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-5 text-pretty text-base leading-relaxed text-muted-fg sm:text-lg">
              This code pairs an iPhone with your Mac — install ADE to connect.
            </p>
          </Reveal>

          <Reveal delay={0.12}>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <LinkButton
                to={LINKS.testflight}
                analyticsFeature={MARKETING_FEATURES.DOWNLOAD_IOS}
                size="lg"
                variant="primary"
                target="_blank"
                rel="noreferrer"
              >
                Get ADE for iPhone <ArrowUpRight className="h-4 w-4" />
              </LinkButton>
              <a
                href={LINKS.webClient}
                data-ade-analytics-feature={MARKETING_FEATURES.OPEN_WEB_CLIENT}
                target="_blank"
                rel="noreferrer"
                className="focus-ring inline-flex items-center gap-1 self-start rounded-md text-sm font-medium text-muted-fg underline-offset-4 transition-colors hover:text-fg hover:underline sm:self-auto"
              >
                Open the web client instead <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </div>
          </Reveal>
        </div>
      </Section>
    </Page>
  );
}
