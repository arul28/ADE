import { MARKETING_CTA_POSITIONS } from "../../lib/marketingAnalytics";
import { InstallBlock } from "./Hero";

/** The last screen: one line, the same download choices as the hero. */
export function DownloadSection() {
  return (
    <section className="relative overflow-hidden px-5 py-[clamp(90px,12vw,160px)] text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(ellipse 50% 60% at 50% 60%, rgba(124,58,237,0.28), transparent 70%)" }}
      />
      <div className="relative">
        <img src="/images/ade-dock-icon.webp" alt="" className="mx-auto h-16 w-16 rounded-2xl shadow-[0_20px_60px_rgba(124,58,237,0.45)]" />
        <h2
          className="mt-6 font-serif font-normal text-white"
          style={{ fontSize: "clamp(36px, 5vw, 68px)", lineHeight: 1.02, letterSpacing: "-0.02em" }}
        >
          Free. Open source.
          <br />
          <em className="italic text-[color:var(--color-violet-bright)]">On every screen.</em>
        </h2>
        <InstallBlock position={MARKETING_CTA_POSITIONS.FOOTER} />
      </div>
    </section>
  );
}
