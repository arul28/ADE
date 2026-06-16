import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { Page } from "../../components/Page";

import { Masthead } from "../../components/editorial/Masthead";
import { CompetitorEquation } from "../../components/editorial/CompetitorEquation";
import { Lede } from "../../components/editorial/Lede";
import { DeviceComposition } from "../../components/editorial/DeviceComposition";
import { HeroAgentBadges } from "../../components/editorial/HeroAgentBadges";
import { ShipShowcase } from "../../components/editorial/ShipShowcase";
import { FadeBand } from "../../components/editorial/FadeBand";
import { FeatureGrid } from "../../components/editorial/FeatureGrid";

export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");

  return (
    <Page>
      {/* ═══════ DARK COVER ═══════ */}
      <section className="relative overflow-x-clip bg-[color:var(--color-bg)] text-[color:var(--color-cream)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: [
              "radial-gradient(ellipse 70% 50% at 70% 45%, rgba(124,58,237,0.3) 0%, transparent 70%)",
              "radial-gradient(ellipse 45% 55% at 10% 0%, rgba(167,139,250,0.08) 0%, transparent 70%)",
              "radial-gradient(ellipse 40% 30% at 40% 90%, rgba(124,58,237,0.08) 0%, transparent 70%)",
            ].join(", "),
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />

        <Masthead />

        <div className="relative mx-auto max-w-[1760px] px-[clamp(20px,3vw,48px)]">
          <div className="mx-auto flex w-full max-w-[1760px] flex-col items-center gap-[clamp(2px,0.6vw,8px)] pb-[clamp(20px,3vw,40px)] pt-0">
            <div className="relative w-full min-w-0 overflow-visible">
              {/* Badges span the full hero height (headline + devices) so they
                  scatter through the upper empty gutters, not just beside the
                  device stack. */}
              <HeroAgentBadges />
              <div className="relative z-10 mx-auto flex w-full max-w-[1200px] flex-col items-center gap-[clamp(4px,1vw,12px)]">
                <CompetitorEquation />
                <Lede />
              </div>
              <div className="relative z-0 w-full min-w-0 overflow-visible px-[clamp(8px,2vw,32px)] pt-[clamp(12px,2vw,24px)] pb-[clamp(2px,0.5vw,8px)]">
                <DeviceComposition />
              </div>
            </div>
            <ShipShowcase />
          </div>
        </div>
      </section>

      {/* ═══════ FADE dark → cream ═══════ */}
      <FadeBand direction="to-cream" />

      {/* ═══════ CATALOG — the rest of the IDE ═══════ */}
      <FeatureGrid />
    </Page>
  );
}
