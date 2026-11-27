import { Link } from "react-router-dom";
import { CLOUD_SMALL_UNLIMITED_SHORT } from "../../lib/cloudPricing";
import { MARKETING_CTA_POSITIONS, MARKETING_FEATURES } from "../../lib/marketingAnalytics";
import { InstallBlock } from "./Hero";
import { BRAND } from "../../../../desktop/src/shared/brand";

/** The last screen: one line, what is free, and the same download choices as the hero. */
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
          className="mt-6 font-display text-white"
          style={{ fontSize: "clamp(36px, 5vw, 68px)", lineHeight: 1.02, letterSpacing: "-0.04em" }}
        >
          Free. Open source.
          <br />
          <span className="text-white/45">On every screen.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-[30rem] text-[15px] leading-[1.6] text-white/55">
          The app costs nothing. {BRAND.CLOUD_NAME} is optional, with{" "}
          <Link
            to="/pricing"
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_PRICING}
            className="focus-ring rounded text-white/85 underline decoration-white/25 underline-offset-4 hover:text-white"
          >
            {CLOUD_SMALL_UNLIMITED_SHORT.charAt(0).toLowerCase() + CLOUD_SMALL_UNLIMITED_SHORT.slice(1)}
          </Link>{" "}
          on the free plan.
        </p>
        <InstallBlock position={MARKETING_CTA_POSITIONS.FOOTER} />
      </div>
    </section>
  );
}
