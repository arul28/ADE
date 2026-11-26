import { ArrowRight, Clapperboard, Laptop, MousePointerClick, Smartphone } from "lucide-react";
import { PHONE_CREDITS_PER_MINUTE, PRICING_SIZES, formatCount } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";

const AMBER = "#fdba74";

/**
 * Each size once, then the iPhone: one panel, a column each (a row each on a
 * narrow screen), with the rate as the big number.
 */
export function SizesStrip({ className }: { className?: string }) {
  const tiles = [
    ...PRICING_SIZES.map((size) => ({
      id: size.id,
      name: size.machine,
      rate: size.rate > 0 ? formatCount(size.rate) : "Free",
      per: size.rate > 0 ? `${size.rate === 1 ? "credit" : "credits"} an hour` : "on paid plans, or Free with ads",
      spec: `${size.cpu} CPUs, ${size.memoryGb} GB`,
      use: size.use,
      phone: false,
    })),
    { id: "iphone", name: "iOS Simulator", rate: formatCount(PHONE_CREDITS_PER_MINUTE), per: `${PHONE_CREDITS_PER_MINUTE === 1 ? "credit" : "credits"} a minute`, spec: "An iPhone in the cloud", use: "No Mac needed", phone: true },
  ];
  return (
    <div
      className={cn(
        "grid overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#100e22] divide-y divide-white/[0.07] lg:divide-x lg:divide-y-0",
        tiles.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4",
        className,
      )}
    >
      {tiles.map((tile) => (
        <div
          key={tile.id}
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 p-5 lg:grid-cols-1 lg:p-6",
            tile.phone && "bg-[linear-gradient(160deg,rgba(253,186,116,0.12),transparent_70%)]",
          )}
        >
          <div className="col-start-1 row-start-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {tile.phone ? <Smartphone className="h-4 w-4" style={{ color: AMBER }} /> : null}
            <span className="text-[16px] font-semibold text-white">{tile.name}</span>
          </div>
          <div className="col-start-2 row-span-2 row-start-1 self-center text-right lg:col-start-1 lg:row-span-1 lg:row-start-2 lg:mt-5 lg:text-left">
            <span
              className={cn("font-display text-[34px] leading-none lg:text-[44px]", tile.rate === "Free" ? "text-[color:var(--color-lamp)]" : "text-white")}
              style={tile.phone ? { color: AMBER } : undefined}
            >
              {tile.rate}
            </span>
            <span className="mt-1 block text-[13px] text-white/50">{tile.per}</span>
          </div>
          <div className="col-start-1 row-start-2 mt-1 lg:row-start-3 lg:mt-5">
            <p className="text-[14px] text-white/80">{tile.spec}</p>
            <p className="text-[13px] text-white/45">{tile.use}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Home page: the ADE Cloud iPhone's own band, a real capture beside a short pitch. */
export function CloudIphoneBand() {
  return (
    <div className="mt-16 overflow-hidden rounded-[28px] border border-white/[0.08] bg-[linear-gradient(150deg,rgba(253,186,116,0.10),rgba(18,15,46,0.55)_45%,rgba(12,10,26,0.9))]">
      <div className="grid items-center gap-8 p-6 sm:p-10 md:grid-cols-[minmax(0,4fr)_minmax(0,6fr)] lg:gap-14">
        <div className="mx-auto w-[min(100%,300px)] rounded-[44px] bg-[#1b1b22] p-[9px] shadow-[0_40px_80px_-20px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.14)]">
          <img src="/images/home/mockup/crumb-phone.png" alt="An app running on the ADE Cloud iPhone" className="block h-auto w-full rounded-[36px]" />
        </div>
        <div>
          <p className="inline-flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: AMBER }}>
            <Smartphone className="h-3.5 w-3.5" /> ADE Cloud iPhone
          </p>
          <h3 className="mt-3 text-[clamp(24px,2.3vw,32px)] font-medium leading-[1.2] tracking-[-0.02em] text-white">
            No Mac? Ship iPhone apps anyway.
          </h3>
          <p className="mt-3 max-w-[32rem] text-[16px] leading-relaxed text-white/60">
            Agents build your app and test it on an iPhone in the cloud.
          </p>
          <ul className="mt-6 flex flex-col gap-3 text-[15px] text-white/75">
            {[
              { icon: <Laptop className="h-4 w-4" />, text: "From Windows, Linux, the web or your phone" },
              { icon: <MousePointerClick className="h-4 w-4" />, text: "Taps, types and scrolls through every screen" },
              { icon: <Clapperboard className="h-4 w-4" />, text: "A recording of each run in the chat" },
            ].map((point) => (
              <li key={point.text} className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0" style={{ color: AMBER }}>{point.icon}</span>
                {point.text}
              </li>
            ))}
          </ul>
          <a href={`${LINKS.docs}/tools/ios-simulator`} target="_blank" rel="noreferrer" className="focus-ring group mt-6 inline-flex items-center gap-1.5 rounded-md text-[15px] font-medium" style={{ color: AMBER }}>
            How the cloud iPhone works
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
