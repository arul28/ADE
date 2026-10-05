import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { Page } from "../../components/Page";

import { SiteNav } from "../../components/home/SiteNav";
import { Hero } from "../../components/home/Hero";
import { ShipShowcase } from "../../components/editorial/ShipShowcase";
import { FadeBand } from "../../components/editorial/FadeBand";
import { FeatureGrid } from "../../components/editorial/FeatureGrid";

export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");

  return (
    <Page>
      <div className="overflow-x-clip bg-[color:var(--color-bg)] text-white">
        <SiteNav />
        <Hero />
        <div className="mx-auto max-w-[1760px] px-[clamp(20px,3vw,48px)] pt-[clamp(48px,6vw,96px)] text-[color:var(--color-cream)]">
          <ShipShowcase />
        </div>
      </div>

      {/* ═══════ FADE dark → cream ═══════ */}
      <FadeBand direction="to-cream" />

      {/* ═══════ CATALOG — the rest of the IDE ═══════ */}
      <FeatureGrid />
    </Page>
  );
}
